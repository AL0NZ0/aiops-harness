import { createHmac, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { incCounter } from './metrics.ts'
import { plaintextCodec, type SecretCodec } from './secret-box.ts'

/**
 * 运维通知：审批、任务失败、MCP 健康和主机密钥变化推送到钉钉/企业微信/通用 webhook。
 * webhook URL 通常自带 access_token，必须加密落盘，接口只返回 host，不回显完整 URL。
 */
export const NOTIFICATION_TYPES = [
  'approval.pending',
  'approval.expired',
  'task.failed',
  'alert.investigated',
  'mcp.unhealthy',
  'mcp.recovered',
  'mcp.tools_changed',
  'asset.host_key_changed',
  'api_key.expiring',
] as const

export type NotificationType = (typeof NOTIFICATION_TYPES)[number]
export type WebhookFormat = 'generic' | 'dingtalk' | 'wecom'

const FORMATS = new Set<WebhookFormat>(['generic', 'dingtalk', 'wecom'])
const TYPES = new Set<string>(NOTIFICATION_TYPES)
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9-_]{0,63}$/
const WEBHOOK_KEYS = new Set(['name', 'url', 'format', 'events', 'enabled', 'secret', 'clearSecret'])

export interface NotificationEvent {
  type: NotificationType
  title: string
  text: string
  /** 同一实体的重复事件在 minIntervalMs 内只发一条；用于防刷屏。 */
  dedupeKey?: string
  detail?: Record<string, string | number | boolean>
  /** 平台内的详情深链；IM 消息里可点击打开，仍需登录后操作。 */
  link?: string
  at?: string
}

/** 审批深链：打开控制台审批页并聚焦到指定审批。 */
export function approvalDeepLink(publicUrl: string, approvalId: string): string {
  return `${publicUrl.replace(/\/+$/, '')}/#/approvals/${encodeURIComponent(approvalId)}`
}

/**
 * 钉钉机器人「加签」：sign = base64(HmacSHA256(`${timestamp}\n${secret}`, secret))，
 * 以查询参数 timestamp（毫秒）和 sign 追加到 webhook。timestamp 必须用实际发送时间。
 */
export function signDingtalkUrl(url: string, secret: string, timestampMs: number): string {
  const sign = createHmac('sha256', secret).update(`${timestampMs}\n${secret}`, 'utf8').digest('base64')
  const target = new URL(url)
  target.searchParams.set('timestamp', String(timestampMs))
  target.searchParams.set('sign', sign)
  return target.toString()
}

export interface NotificationWebhookView {
  id: string
  name: string
  urlHost: string
  format: WebhookFormat
  events: NotificationType[]
  enabled: boolean
  /** 是否配置了钉钉加签密钥；密钥本身永不回显。 */
  hasSecret: boolean
  createdAt: string
  updatedAt: string
}

export interface NotificationSettings {
  enabled: boolean
  minIntervalMs: number
}

interface NotificationWebhook {
  id: string
  name: string
  url: string
  format: WebhookFormat
  events: NotificationType[]
  enabled: boolean
  /** 钉钉机器人「加签」密钥；加密落盘，仅投递时参与 HMAC。 */
  secret?: string
  createdAt: string
  updatedAt: string
}

interface NotificationFile {
  settings: NotificationSettings
  webhooks: NotificationWebhook[]
}

const DEFAULT_SETTINGS: NotificationSettings = { enabled: true, minIntervalMs: 60_000 }

export class NotificationStore {
  private state: NotificationFile | undefined

  constructor(
    private readonly file: string | null,
    private readonly codec: SecretCodec = plaintextCodec,
  ) {}

  async settings(): Promise<NotificationSettings> {
    await this.load()
    return { ...this.state!.settings }
  }

  async updateSettings(value: unknown): Promise<NotificationSettings> {
    await this.load()
    if (!isRecord(value)) throw new Error('通知设置必须是对象')
    for (const key of Object.keys(value)) {
      if (key !== 'enabled' && key !== 'minIntervalMs') throw new Error(`通知设置包含未知字段 ${key}`)
    }
    const settings: NotificationSettings = {
      enabled: booleanOf(value.enabled, this.state!.settings.enabled, 'enabled'),
      minIntervalMs: integerOf(
        value.minIntervalMs,
        this.state!.settings.minIntervalMs,
        0,
        3_600_000,
        'minIntervalMs',
      ),
    }
    this.state!.settings = settings
    await this.persist()
    return { ...settings }
  }

  async list(): Promise<NotificationWebhookView[]> {
    await this.load()
    return this.state!.webhooks.map(toView)
  }

  /** 内部使用：包含解密后的 URL，禁止直接返回给 HTTP 层。 */
  async all(): Promise<NotificationWebhook[]> {
    await this.load()
    return this.state!.webhooks.map(clone)
  }

  async create(value: unknown): Promise<NotificationWebhookView> {
    await this.load()
    if (!isRecord(value)) throw new Error('通知 webhook 必须是对象')
    const now = new Date().toISOString()
    const webhook = validateWebhook(value, undefined, now)
    if (this.state!.webhooks.some((item) => item.name === webhook.name)) {
      throw new Error(`通知 webhook 名称重复: ${webhook.name}`)
    }
    this.state!.webhooks = [...this.state!.webhooks, webhook]
    await this.persist()
    return toView(webhook)
  }

  async update(id: string, value: unknown): Promise<NotificationWebhookView> {
    await this.load()
    const existing = this.state!.webhooks.find((item) => item.id === id)
    if (!existing) throw new Error('通知 webhook 不存在')
    if (!isRecord(value)) throw new Error('通知 webhook 必须是对象')
    const webhook = validateWebhook(value, existing, new Date().toISOString())
    if (this.state!.webhooks.some((item) => item.id !== id && item.name === webhook.name)) {
      throw new Error(`通知 webhook 名称重复: ${webhook.name}`)
    }
    this.state!.webhooks = this.state!.webhooks.map((item) => (item.id === id ? webhook : item))
    await this.persist()
    return toView(webhook)
  }

  async remove(id: string): Promise<boolean> {
    await this.load()
    const before = this.state!.webhooks.length
    this.state!.webhooks = this.state!.webhooks.filter((item) => item.id !== id)
    if (this.state!.webhooks.length === before) return false
    await this.persist()
    return true
  }

  async get(id: string): Promise<NotificationWebhookView | undefined> {
    await this.load()
    const webhook = this.state!.webhooks.find((item) => item.id === id)
    return webhook ? toView(webhook) : undefined
  }

  private async load(): Promise<void> {
    if (this.state) return
    if (!this.file) {
      this.state = { settings: { ...DEFAULT_SETTINGS }, webhooks: [] }
      return
    }
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error
      this.state = { settings: { ...DEFAULT_SETTINGS }, webhooks: [] }
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new Error(`data/notifications.json 解析失败：${(error as Error).message}`)
    }
    if (!isRecord(parsed)) throw new Error('data/notifications.json 必须是对象')
    const settings = isRecord(parsed.settings)
      ? validateSettings(parsed.settings)
      : { ...DEFAULT_SETTINGS }
    if (parsed.webhooks !== undefined && !Array.isArray(parsed.webhooks)) {
      throw new Error('data/notifications.json 的 webhooks 必须是数组')
    }
    const ids = new Set<string>()
    const names = new Set<string>()
    let needsMigration = false
    const webhooks = (parsed.webhooks ?? []).map((item, index) => {
      if (!isRecord(item)) throw new Error(`webhooks[${index}] 必须是对象`)
      const storedUrl = text(item.url, `webhooks[${index}].url`)
      if (!isEncrypted(storedUrl)) needsMigration = true
      let url: string
      try {
        url = this.codec.decrypt(storedUrl)
      } catch (error) {
        throw new Error(`webhooks[${index}].url 解密失败：${(error as Error).message}`)
      }
      let secret: string | undefined
      if (item.secret !== undefined) {
        const storedSecret = text(item.secret, `webhooks[${index}].secret`)
        if (!isEncrypted(storedSecret)) needsMigration = true
        try {
          secret = this.codec.decrypt(storedSecret)
        } catch (error) {
          throw new Error(`webhooks[${index}].secret 解密失败：${(error as Error).message}`)
        }
      }
      const webhook = validateWebhook(
        { ...item, url, ...(secret ? { secret } : {}) },
        undefined,
        undefined,
        index,
        {
          id: text(item.id, `webhooks[${index}].id`),
          createdAt: text(item.createdAt, `webhooks[${index}].createdAt`),
          updatedAt: text(item.updatedAt, `webhooks[${index}].updatedAt`),
        },
      )
      if (ids.has(webhook.id)) throw new Error(`通知 webhook id 重复: ${webhook.id}`)
      if (names.has(webhook.name)) throw new Error(`通知 webhook 名称重复: ${webhook.name}`)
      ids.add(webhook.id)
      names.add(webhook.name)
      return webhook
    })
    this.state = { settings, webhooks }
    if (this.codec.canEncrypt && needsMigration) await this.persist()
  }

  private async persist(): Promise<void> {
    if (!this.file) return
    await mkdir(path.dirname(this.file), { recursive: true })
    const payload = {
      settings: this.state!.settings,
      webhooks: this.state!.webhooks.map((webhook) => ({
        ...webhook,
        url: this.codec.encrypt(webhook.url),
        ...(webhook.secret ? { secret: this.codec.encrypt(webhook.secret) } : {}),
      })),
    }
    const temp = `${this.file}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(payload, null, 2), { mode: 0o600 })
    await rename(temp, this.file)
    await chmod(this.file, 0o600)
  }
}

export interface DeliveredNotification {
  webhook: string
  ok: boolean
  error?: string
}

/**
 * 通知投递器：按 webhook 格式组装消息，5 秒超时，失败只记日志和指标，绝不抛回业务流程。
 * notify() 是 fire-and-forget；send() 供测试和「发送测试消息」接口等待结果。
 */
export class Notifier {
  private readonly lastSent = new Map<string, number>()

  constructor(
    private readonly store: NotificationStore,
    private readonly options: {
      fetch?: typeof fetch
      now?: () => Date
      timeoutMs?: number
    } = {},
  ) {}

  notify(event: NotificationEvent): void {
    void this.send(event).catch(() => undefined)
  }

  async send(event: NotificationEvent): Promise<DeliveredNotification[]> {
    const settings = await this.store.settings()
    if (!settings.enabled) return []
    const webhooks = (await this.store.all()).filter(
      (webhook) => webhook.enabled && webhook.events.includes(event.type),
    )
    return this.deliverAll(webhooks, event, settings.minIntervalMs)
  }

  /**
   * 定向投递：告警接入源直接指定通知渠道，不受渠道的事件订阅影响，
   * 但仍然遵守全局开关、渠道启用状态和最小间隔。
   */
  async sendTo(ids: string[], event: NotificationEvent): Promise<DeliveredNotification[]> {
    if (ids.length === 0) return []
    const settings = await this.store.settings()
    if (!settings.enabled) return []
    const wanted = new Set(ids)
    const webhooks = (await this.store.all()).filter(
      (webhook) => webhook.enabled && wanted.has(webhook.id),
    )
    return this.deliverAll(webhooks, event, settings.minIntervalMs)
  }

  private async deliverAll(
    webhooks: NotificationWebhook[],
    event: NotificationEvent,
    minIntervalMs: number,
  ): Promise<DeliveredNotification[]> {
    const now = this.now().getTime()
    const at = event.at ?? this.now().toISOString()
    const results: DeliveredNotification[] = []
    for (const webhook of webhooks) {
      const throttleKey = `${webhook.id}|${event.type}|${event.dedupeKey ?? ''}`
      const previous = this.lastSent.get(throttleKey)
      if (previous !== undefined && now - previous < minIntervalMs) {
        incCounter('aiops_notifications_total', { result: 'throttled', type: event.type })
        continue
      }
      this.lastSent.set(throttleKey, now)
      try {
        await this.deliver(webhook, event, at)
        incCounter('aiops_notifications_total', { result: 'sent', type: event.type })
        results.push({ webhook: webhook.name, ok: true })
      } catch (error) {
        const message = redactUrl(error instanceof Error ? error.message : String(error), webhook.url)
        incCounter('aiops_notifications_total', { result: 'failed', type: event.type })
        results.push({ webhook: webhook.name, ok: false, error: message })
      }
    }
    return results
  }

  /** 测试按钮：绕过事件订阅和节流，直接发一条到指定 webhook。 */
  async sendTest(id: string): Promise<DeliveredNotification> {
    const webhook = (await this.store.all()).find((item) => item.id === id)
    if (!webhook) throw new Error('通知 webhook 不存在')
    const event: NotificationEvent = {
      type: 'task.failed',
      title: '通知测试',
      text: '这是一条来自 AIOps Harness 平台的测试消息，收到即表示 webhook 配置可用。',
      dedupeKey: `test:${Date.now()}`,
    }
    try {
      await this.deliver(webhook, event, this.now().toISOString())
      incCounter('aiops_notifications_total', { result: 'sent', type: 'test' })
      return { webhook: webhook.name, ok: true }
    } catch (error) {
      incCounter('aiops_notifications_total', { result: 'failed', type: 'test' })
      return {
        webhook: webhook.name,
        ok: false,
        error: redactUrl(error instanceof Error ? error.message : String(error), webhook.url),
      }
    }
  }

  private async deliver(webhook: NotificationWebhook, event: NotificationEvent, at: string): Promise<void> {
    const body = renderBody(webhook.format, event, at)
    const fetchImpl = this.options.fetch ?? fetch
    // 加签只在发送时算，URL 里的 timestamp/sign 不出现在列表、审计和日志里。
    const target =
      webhook.format === 'dingtalk' && webhook.secret
        ? signDingtalkUrl(webhook.url, webhook.secret, this.now().getTime())
        : webhook.url
    const redact = (value: string) => redactUrl(redactUrl(value, webhook.url), target)
    let response: Response
    try {
      response = await fetchImpl(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 5_000),
      })
    } catch (error) {
      throw new Error(`请求失败: ${redact(error instanceof Error ? error.message : String(error))}`)
    }
    const text = await response.text().catch(() => '')
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${clip(redact(text), 200)}`)
    }
    if (webhook.format === 'dingtalk' || webhook.format === 'wecom') {
      try {
        const parsed: unknown = JSON.parse(text)
        const code = isRecord(parsed) ? parsed.errcode : undefined
        if (typeof code === 'number' && code !== 0) {
          throw new Error(`errcode=${code}: ${clip(String(isRecord(parsed) ? parsed.errmsg ?? '' : ''), 200)}`)
        }
      } catch (error) {
        if (error instanceof SyntaxError) return
        throw error
      }
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date()
  }
}

function renderBody(format: WebhookFormat, event: NotificationEvent, at: string): Record<string, unknown> {
  const title = `[AIOps Harness] ${event.title}`
  if (format === 'dingtalk') {
    return {
      msgtype: 'markdown',
      markdown: { title, text: markdownText(event, at) },
    }
  }
  if (format === 'wecom') {
    return {
      msgtype: 'markdown',
      markdown: { content: markdownText(event, at) },
    }
  }
  return {
    source: 'aiops-harness',
    type: event.type,
    title,
    text: event.text,
    at,
    ...(event.link ? { link: event.link } : {}),
    ...(event.detail ? { detail: event.detail } : {}),
  }
}

function markdownText(event: NotificationEvent, at: string): string {
  const lines = [`### ${event.title}`, '', event.text, '']
  if (event.link) lines.push(`[打开审批详情](${event.link})`, '')
  lines.push(`时间：${at}`)
  if (event.detail) {
    for (const [key, value] of Object.entries(event.detail)) lines.push(`- ${key}: ${String(value)}`)
  }
  return lines.join('\n')
}

function validateSettings(value: Record<string, unknown>): NotificationSettings {
  return {
    enabled: booleanOf(value.enabled, DEFAULT_SETTINGS.enabled, 'settings.enabled'),
    minIntervalMs: integerOf(
      value.minIntervalMs,
      DEFAULT_SETTINGS.minIntervalMs,
      0,
      3_600_000,
      'settings.minIntervalMs',
    ),
  }
}

function validateWebhook(
  value: Record<string, unknown>,
  existing: NotificationWebhook | undefined,
  now: string | undefined,
  index?: number,
  persisted?: { id: string; createdAt: string; updatedAt: string },
): NotificationWebhook {
  const label = index === undefined ? 'webhook' : `webhooks[${index}]`
  if (!existing) {
    for (const key of Object.keys(value)) {
      if (WEBHOOK_KEYS.has(key)) continue
      if (persisted && (key === 'id' || key === 'createdAt' || key === 'updatedAt')) continue
      throw new Error(`${label} 包含未知字段 ${key}`)
    }
  }
  const name = text(value.name ?? existing?.name, `${label}.name`)
  if (!NAME.test(name)) throw new Error(`${label}.name 只能包含字母、数字、- 和 _，最长 64`)
  const url = normalizeWebhookUrl(text(value.url ?? existing?.url, `${label}.url`), label)
  const formatText = value.format ?? existing?.format
  if (typeof formatText !== 'string' || !FORMATS.has(formatText as WebhookFormat)) {
    throw new Error(`${label}.format 只能是 generic / dingtalk / wecom`)
  }
  if (value.clearSecret !== undefined && typeof value.clearSecret !== 'boolean') {
    throw new Error(`${label}.clearSecret 必须是布尔值`)
  }
  let secret = value.clearSecret === true ? undefined : existing?.secret
  if (value.secret !== undefined) {
    if (typeof value.secret !== 'string') throw new Error(`${label}.secret 必须是字符串`)
    const trimmed = value.secret.trim()
    if (trimmed) {
      if (/\s/.test(trimmed)) throw new Error(`${label}.secret 不能包含空白字符`)
      if (trimmed.length > 256) throw new Error(`${label}.secret 最长 256 个字符`)
      secret = trimmed
    }
  }
  if (secret && formatText !== 'dingtalk') throw new Error(`${label}.secret 只在钉钉加签时使用`)
  const eventsValue = value.events ?? existing?.events ?? NOTIFICATION_TYPES
  if (!Array.isArray(eventsValue) || eventsValue.length === 0) {
    throw new Error(`${label}.events 必须是非空数组`)
  }
  const events: NotificationType[] = []
  for (const item of eventsValue) {
    if (typeof item !== 'string' || !TYPES.has(item)) throw new Error(`${label}.events 包含未知事件 ${String(item)}`)
    if (!events.includes(item as NotificationType)) events.push(item as NotificationType)
  }
  return {
    id: existing?.id ?? persisted?.id ?? `wh_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    name,
    url,
    format: formatText as WebhookFormat,
    events,
    enabled: booleanOf(value.enabled, existing?.enabled ?? true, `${label}.enabled`),
    ...(secret ? { secret } : {}),
    createdAt: existing?.createdAt ?? persisted?.createdAt ?? now ?? new Date().toISOString(),
    updatedAt: now ?? persisted?.updatedAt ?? new Date().toISOString(),
  }
}

function normalizeWebhookUrl(value: string, label: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${label}.url 不合法`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${label}.url 必须是 http(s)`)
  if (url.username || url.password) throw new Error(`${label}.url 不能包含用户名或密码`)
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
  if (url.protocol === 'http:' && !loopback) {
    throw new Error(`${label}.url 含 token，非本机地址必须使用 https`)
  }
  return url.toString()
}

function toView(webhook: NotificationWebhook): NotificationWebhookView {
  return {
    id: webhook.id,
    name: webhook.name,
    urlHost: hostOf(webhook.url),
    format: webhook.format,
    events: [...webhook.events],
    enabled: webhook.enabled,
    hasSecret: Boolean(webhook.secret),
    createdAt: webhook.createdAt,
    updatedAt: webhook.updatedAt,
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'invalid'
  }
}

function clone(webhook: NotificationWebhook): NotificationWebhook {
  return { ...webhook, events: [...webhook.events] }
}

function redactUrl(value: string, url: string): string {
  return value.replaceAll(url, hostOf(url))
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 必填`)
  return value.trim()
}

function booleanOf(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new Error(`${label} 必须是布尔值`)
  return value
}

function integerOf(value: unknown, fallback: number, min: number, max: number, label: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} 必须是 ${min} 到 ${max} 的整数`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isEncrypted(value: string): boolean {
  return value.startsWith('enc:v1:')
}

function clip(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length)}…`
}