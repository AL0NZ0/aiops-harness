import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { PlatformError } from './errors.ts'
import { nid } from './ids.ts'

/**
 * 告警接入源：外部监控（夜莺回调/Webhook、Alertmanager）往平台推告警，
 * 平台只建只读排查任务，不执行任何变更。token 只保存 SHA-256，明文只在创建/轮换时回显一次。
 */
export type AlertFormat = 'nightingale' | 'alertmanager' | 'generic'

export const ALERT_FORMATS: AlertFormat[] = ['nightingale', 'alertmanager', 'generic']

export interface AlertSource {
  id: string
  name: string
  format: AlertFormat
  enabled: boolean
  /** 告警任务归属账号；必须是 operator 及以上，可见性单独放开给 operator。 */
  actorId: string
  /** 默认技能；为空时按告警内容自动选择（默认 k8s-troubleshooting）。 */
  skill?: string
  /** 允许告警标签 aiops_skill 指定的技能白名单；为空表示只允许默认技能。 */
  skills: string[]
  provider?: string
  model?: string
  /** 结果推送目标；空数组表示只留在平台任务页。 */
  notifyWebhookIds: string[]
  /** 只排查 severity <= maxSeverity 的告警；1=最高。 */
  maxSeverity: number
  /** 同一 fingerprint 的重复告警在该窗口内只建一个任务。 */
  cooldownMs: number
  tokenHash: string
  tokenPrefix: string
  createdAt: string
  updatedAt: string
}

export interface AlertSourceView extends Omit<AlertSource, 'tokenHash'> {
  /** 接入路径（不含平台地址），配置里拼上 AIOPS_PUBLIC_URL。 */
  path: string
}

export interface NormalizedAlert {
  fingerprint: string
  name: string
  severity: number
  status: 'firing' | 'resolved'
  labels: Record<string, string>
  annotations: Record<string, string>
  startsAt?: string
  endsAt?: string
}

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9-_]{0,63}$/
const SOURCE_NAME_MAX = 64
const TOKEN_PREFIX = 8
const MAX_TOKEN_LENGTH = 200
const HOUR = 60 * 60 * 1000

export function newAlertToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashAlertToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function tokenMatches(storedHash: string, token: string): boolean {
  const offered = Buffer.from(hashAlertToken(token), 'hex')
  const expected = Buffer.from(storedHash, 'hex')
  return offered.length === expected.length && timingSafeEqual(offered, expected)
}

export function alertSourceView(source: AlertSource, publicUrl: string): AlertSourceView {
  const { tokenHash: _tokenHash, ...view } = source
  return {
    ...view,
    path: `${publicUrl.replace(/\/+$/, '')}/api/hooks/alerts/${encodeURIComponent(source.id)}`,
  }
}

/**
 * 告警源文件是用户运行数据：缺失视为空，解析失败必须报错，不能静默清空。
 * 文件权限 0600，写入先落盘再换内存，所有写操作串行。
 */
export class AlertSourceStore {
  private sources: AlertSource[] | undefined
  private tail: Promise<unknown> = Promise.resolve()

  constructor(private readonly file: string | null) {}

  async list(): Promise<AlertSource[]> {
    await this.tail
    await this.load()
    return this.sources!.map((source) => ({ ...source, skills: [...source.skills], notifyWebhookIds: [...source.notifyWebhookIds] }))
  }

  async get(id: string): Promise<AlertSource | undefined> {
    await this.tail
    await this.load()
    const source = this.sources!.find((item) => item.id === id)
    return source ? { ...source, skills: [...source.skills], notifyWebhookIds: [...source.notifyWebhookIds] } : undefined
  }

  async create(input: unknown): Promise<{ source: AlertSource; token: string }> {
    return this.enqueue(async () => {
      await this.load()
      const now = new Date().toISOString()
      const token = newAlertToken()
      const source = validateSource(input, undefined, now, {
        id: nid('alert'),
        tokenHash: hashAlertToken(token),
        tokenPrefix: token.slice(0, TOKEN_PREFIX),
        createdAt: now,
      })
      if (this.sources!.some((item) => item.name === source.name)) {
        throw new PlatformError(`告警接入名称重复: ${source.name}`, 400, 'bad_request')
      }
      await this.persist([...this.sources!, source])
      this.sources = [...this.sources!, source]
      return { source: cloneSource(source), token }
    })
  }

  async update(id: string, input: unknown): Promise<AlertSource> {
    return this.enqueue(async () => {
      await this.load()
      const existing = this.sources!.find((item) => item.id === id)
      if (!existing) throw new PlatformError('告警接入不存在', 404, 'not_found')
      const source = validateSource(input, existing, new Date().toISOString())
      if (this.sources!.some((item) => item.id !== id && item.name === source.name)) {
        throw new PlatformError(`告警接入名称重复: ${source.name}`, 400, 'bad_request')
      }
      const next = this.sources!.map((item) => (item.id === id ? source : item))
      await this.persist(next)
      this.sources = next
      return cloneSource(source)
    })
  }

  async remove(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      await this.load()
      const next = this.sources!.filter((item) => item.id !== id)
      if (next.length === this.sources!.length) return false
      await this.persist(next)
      this.sources = next
      return true
    })
  }

  rotateToken(id: string): Promise<{ source: AlertSource; token: string }> {
    return this.enqueue(async () => {
      await this.load()
      const existing = this.sources!.find((item) => item.id === id)
      if (!existing) throw new PlatformError('告警接入不存在', 404, 'not_found')
      const token = newAlertToken()
      const source: AlertSource = {
        ...existing,
        tokenHash: hashAlertToken(token),
        tokenPrefix: token.slice(0, TOKEN_PREFIX),
        updatedAt: new Date().toISOString(),
      }
      const next = this.sources!.map((item) => (item.id === id ? source : item))
      await this.persist(next)
      this.sources = next
      return { source: cloneSource(source), token }
    })
  }

  async verifyToken(id: string, token: string): Promise<AlertSource | undefined> {
    if (!token || token.length > MAX_TOKEN_LENGTH) return undefined
    await this.tail
    await this.load()
    const source = this.sources!.find((item) => item.id === id)
    if (!source || !tokenMatches(source.tokenHash, token)) return undefined
    return cloneSource(source)
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn)
    this.tail = next.catch(() => undefined)
    return next
  }

  private async load(): Promise<void> {
    if (this.sources) return
    if (!this.file) {
      this.sources = []
      return
    }
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.sources = []
        return
      }
      throw new Error(`读取告警接入配置失败：${(error as Error).message}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new Error(`告警接入配置不是合法 JSON：${(error as Error).message}`)
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.sources)) {
      throw new Error('告警接入配置格式不正确：缺少 sources 数组')
    }
    const ids = new Set<string>()
    const names = new Set<string>()
    this.sources = parsed.sources.map((item, index) => {
      if (!isRecord(item)) throw new Error(`sources[${index}] 必须是对象`)
      const source = validateSource(
        { ...item, tokenHash: undefined, tokenPrefix: undefined },
        undefined,
        textOf(item.createdAt) || new Date().toISOString(),
        {
          id: textOf(item.id) || nid('alert'),
          tokenHash: textOf(item.tokenHash),
          tokenPrefix: textOf(item.tokenPrefix),
          createdAt: textOf(item.createdAt) || new Date().toISOString(),
          updatedAt: textOf(item.updatedAt) || textOf(item.createdAt) || new Date().toISOString(),
        },
      )
      if (!/^[a-f0-9]{64}$/.test(source.tokenHash)) {
        throw new Error(`sources[${index}].tokenHash 不合法`)
      }
      if (ids.has(source.id)) throw new Error(`告警接入 id 重复: ${source.id}`)
      if (names.has(source.name)) throw new Error(`告警接入名称重复: ${source.name}`)
      ids.add(source.id)
      names.add(source.name)
      return source
    })
  }

  private async persist(next: AlertSource[]): Promise<void> {
    if (!this.file) return
    await mkdir(path.dirname(this.file), { recursive: true })
    const payload = { sources: next }
    const temp = `${this.file}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(payload, null, 2), { mode: 0o600 })
    await rename(temp, this.file)
    await chmod(this.file, 0o600)
  }
}

function validateSource(
  value: unknown,
  existing: AlertSource | undefined,
  now: string,
  extra?: {
    id?: string
    tokenHash?: string
    tokenPrefix?: string
    createdAt?: string
    updatedAt?: string
  },
): AlertSource {
  if (!isRecord(value)) throw new PlatformError('告警接入必须是对象', 400, 'bad_request')
  const name = textOf(value.name) ?? existing?.name
  // 名称只用于展示和去重，允许中文；技能标识仍走 ASCII 的 NAME 校验。
  if (!name || name.length > SOURCE_NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new PlatformError('名称必填，最长 64 位，不能包含控制字符', 400, 'bad_request')
  }
  const format = (textOf(value.format) ?? existing?.format ?? 'nightingale') as AlertFormat
  if (!ALERT_FORMATS.includes(format)) {
    throw new PlatformError('format 只能是 nightingale、alertmanager 或 generic', 400, 'bad_request')
  }
  const actorId = textOf(value.actorId) ?? existing?.actorId
  if (!actorId) throw new PlatformError('actorId 必填', 400, 'bad_request')
  const skills = arrayOfText(value.skills, existing?.skills ?? [])
  const notifyWebhookIds = arrayOfText(value.notifyWebhookIds, existing?.notifyWebhookIds ?? [])
  const maxSeverity = integerOf(value.maxSeverity, existing?.maxSeverity ?? 2, 1, 3, 'maxSeverity')
  const cooldownMs = integerOf(value.cooldownMs, existing?.cooldownMs ?? 10 * 60 * 1000, 0, 24 * HOUR, 'cooldownMs')
  const enabled = value.enabled === undefined ? (existing?.enabled ?? true) : booleanOf(value.enabled, 'enabled')
  const skill = Object.prototype.hasOwnProperty.call(value, 'skill') ? textOf(value.skill) : existing?.skill
  if (skill !== undefined && !NAME.test(skill)) {
    throw new PlatformError('skill 名称不合法', 400, 'bad_request')
  }
  for (const item of skills) {
    if (!NAME.test(item)) throw new PlatformError(`技能名称不合法: ${item}`, 400, 'bad_request')
  }
  // 字段缺省表示保持原值；显式传空字符串表示清除，前端「使用默认模型」依赖这个语义。
  const provider = Object.prototype.hasOwnProperty.call(value, 'provider')
    ? textOf(value.provider)
    : existing?.provider
  const model = Object.prototype.hasOwnProperty.call(value, 'model') ? textOf(value.model) : existing?.model
  return {
    id: extra?.id ?? existing!.id,
    name,
    format,
    enabled,
    actorId,
    ...(skill ? { skill } : {}),
    skills,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    notifyWebhookIds,
    maxSeverity,
    cooldownMs,
    tokenHash: extra?.tokenHash ?? existing!.tokenHash,
    tokenPrefix: extra?.tokenPrefix ?? existing!.tokenPrefix,
    createdAt: extra?.createdAt ?? existing!.createdAt,
    updatedAt: extra?.updatedAt ?? now,
  }
}

/** 解析入口：按接入源声明的格式把请求体变成统一的告警列表。 */
export function parseAlertPayload(format: AlertFormat, body: unknown): NormalizedAlert[] {
  const nodes = Array.isArray(body) ? body : [body]
  if (nodes.length === 0) throw badAlert('告警内容为空')
  const alerts: NormalizedAlert[] = []
  for (const node of nodes) {
    if (!isRecord(node)) throw badAlert('告警必须是对象或对象数组')
    // 夜莺全局 Webhook 常用模板把事件包成 {events:[...]} 或 {event:{...}}，一起兼容。
    if (format !== 'alertmanager' && Array.isArray(node.events)) {
      for (const item of node.events) {
        if (!isRecord(item)) throw badAlert('events 里必须是对象')
        alerts.push(fromEvent(item))
      }
      continue
    }
    if (format !== 'alertmanager' && isRecord(node.event)) {
      alerts.push(fromEvent(node.event))
      continue
    }
    if (format === 'alertmanager' || Array.isArray(node.alerts)) {
      const list = Array.isArray(node.alerts) ? node.alerts : [node]
      for (const item of list) {
        if (!isRecord(item)) throw badAlert('alerts 里必须是对象')
        alerts.push(fromAlertmanager(item))
      }
      continue
    }
    if (!looksLikeEvent(node)) throw badAlert('没有可识别的规则或指纹')
    alerts.push(fromEvent(node))
  }
  const filtered = alerts.filter((alert) => alert.name || alert.fingerprint)
  if (filtered.length === 0) throw badAlert('告警里没有可识别的规则或指纹')
  return filtered
}

function fromAlertmanager(item: Record<string, unknown>): NormalizedAlert {
  const labels = recordOf(item.labels)
  const annotations = recordOf(item.annotations)
  const name = labels.alertname ?? textOf(item.name) ?? '未命名告警'
  const fingerprint =
    textOf(item.fingerprint) ??
    textOf(item.hash) ??
    stableFingerprint(name, labels)
  return {
    fingerprint,
    name,
    severity: severityOf(labels.severity ?? item.severity),
    status: statusOf(item.status) ?? 'firing',
    labels,
    annotations,
    ...(textOf(item.startsAt) ? { startsAt: textOf(item.startsAt) } : {}),
    ...(textOf(item.endsAt) ? { endsAt: textOf(item.endsAt) } : {}),
  }
}

/** 空对象或不认识的包装如果硬解析会生成匿名告警，直接 400 更安全。 */
function looksLikeEvent(item: Record<string, unknown>): boolean {
  const keys = [
    'rule_name',
    'ruleName',
    'RuleName',
    'name',
    'Name',
    'alertname',
    'hash',
    'Hash',
    'fingerprint',
    'Fingerprint',
    'event_hash',
    'eventHash',
    'prom_fp',
    'promFp',
    'tags',
    'Tags',
    'labels',
    'Labels',
    'annotations',
    'Annotations',
    'severity',
    'Severity',
    'status',
    'Status',
  ]
  return keys.some((key) => item[key] !== undefined && item[key] !== null)
}

function fromEvent(item: Record<string, unknown>): NormalizedAlert {
  const labels = normalizeMap(fieldOf(item, 'tags', 'Tags', 'labels', 'Labels', 'tags_map', 'tagsMap'))
  const annotations = normalizeMap(fieldOf(item, 'annotations', 'Annotations', 'annotations_map', 'annotationsMap'))
  const name = fieldOf(item, 'rule_name', 'ruleName', 'RuleName', 'name', 'Name', 'alertname') ?? labels.alertname
  const textName = typeof name === 'string' ? name : name === undefined ? '' : String(name)
  const fingerprint =
    textOf(
      fieldOf(
        item,
        'hash',
        'Hash',
        'fingerprint',
        'Fingerprint',
        'event_hash',
        'eventHash',
        'prom_fp',
        'promFp',
        'event_id',
        'eventId',
      ),
    ) ??
    stableFingerprint(textName, labels)
  const recovered = fieldOf(item, 'is_recovered', 'isRecovered', 'IsRecovered', 'recovered')
  const status =
    statusOf(fieldOf(item, 'status', 'Status', 'state', 'State')) ??
    (recovered === true || recovered === 'true' || recovered === 1 ? 'resolved' : 'firing')
  return {
    fingerprint,
    name: textName || '未命名告警',
    // 顶层 severity 优先；全局 Webhook 模板常把级别写进 tags，按 severity/level/priority 回退。
    severity: severityOf(
      fieldOf(item, 'severity', 'Severity', 'level', 'Level', 'priority', 'Priority') ||
        labels.severity ||
        labels.level ||
        labels.priority,
    ),
    status,
    labels,
    annotations,
    ...(textOf(fieldOf(item, 'starts_at', 'startsAt', 'StartsAt', 'trigger_time', 'triggerTime'))
      ? {
          startsAt: textOf(fieldOf(item, 'starts_at', 'startsAt', 'StartsAt', 'trigger_time', 'triggerTime')),
        }
      : {}),
    ...(textOf(fieldOf(item, 'ends_at', 'endsAt', 'EndsAt', 'recover_time', 'recoverTime'))
      ? {
          endsAt: textOf(fieldOf(item, 'ends_at', 'endsAt', 'EndsAt', 'recover_time', 'recoverTime')),
        }
      : {}),
  }
}

function statusOf(value: unknown): NormalizedAlert['status'] | undefined {
  if (typeof value !== 'string') return undefined
  const lower = value.trim().toLowerCase()
  if (lower === 'firing' || lower === 'alerting' || lower === 'triggered') return 'firing'
  if (lower === 'resolved' || lower === 'recovered' || lower === 'ok') return 'resolved'
  return undefined
}

/**
 * 夜莺 severity 是 1/2/3；Alertmanager 常见 critical/warning/info。
 * 认不出的按 2 处理（默认排查），是否排查最终由接入源的 maxSeverity 决定。
 */
export function severityOf(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const rounded = Math.round(value)
    return rounded >= 1 && rounded <= 3 ? rounded : 2
  }
  if (typeof value !== 'string') return 2
  const lower = value.trim().toLowerCase()
  const numeric = Number(lower.replace(/^p/, ''))
  if (Number.isFinite(numeric) && numeric >= 1 && numeric <= 3) return Math.round(numeric)
  if (['critical', 'fatal', 'emergency', '严重', '紧急'].includes(lower)) return 1
  if (['warning', 'major', 'serious', '警告', '重要'].includes(lower)) return 2
  if (['info', 'notice', 'minor', '提示', '次要'].includes(lower)) return 3
  return 2
}

function stableFingerprint(name: string, labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort()
  const canonical = keys.map((key) => `${key}=${labels[key]}`).join('\u0000')
  return createHash('sha256').update(`${name}\u0000${canonical}`).digest('hex').slice(0, 32)
}

function fieldOf(item: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = item[key]
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

function normalizeMap(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {}
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return {}
    try {
      return normalizeMap(JSON.parse(trimmed))
    } catch {
      return normalizeMap(trimmed.split(','))
    }
  }
  if (Array.isArray(value)) {
    const out: Record<string, string> = {}
    for (const item of value) {
      const text = textOf(item)
      if (!text) continue
      const index = text.indexOf('=')
      if (index > 0) out[text.slice(0, index).trim()] = text.slice(index + 1).trim()
    }
    return out
  }
  return recordOf(value)
}

function recordOf(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === null) continue
    out[key] = typeof item === 'string' ? item : typeof item === 'number' || typeof item === 'boolean' ? String(item) : JSON.stringify(item)
  }
  return out
}

function badAlert(message: string): PlatformError {
  return new PlatformError(message, 400, 'bad_alert')
}

function cloneSource(source: AlertSource): AlertSource {
  return { ...source, skills: [...source.skills], notifyWebhookIds: [...source.notifyWebhookIds] }
}

function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed || undefined
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

function arrayOfText(value: unknown, fallback: string[]): string[] {
  if (value === undefined) return [...fallback]
  if (!Array.isArray(value)) throw new PlatformError('必须是字符串数组', 400, 'bad_request')
  const out: string[] = []
  for (const item of value) {
    const text = textOf(item)
    if (text && !out.includes(text)) out.push(text)
  }
  return out
}

function integerOf(value: unknown, fallback: number, min: number, max: number, key: string): number {
  if (value === undefined) return fallback
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new PlatformError(`${key} 必须是 ${min}-${max} 的整数`, 400, 'bad_request')
  }
  return number
}

function booleanOf(value: unknown, key: string): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === 1) return true
  if (value === 'false' || value === 0) return false
  throw new PlatformError(`${key} 必须是布尔值`, 400, 'bad_request')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}