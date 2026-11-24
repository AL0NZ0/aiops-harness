import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { OpenAiCompatibleModel, type ChatModel } from './model.ts'
import { plaintextCodec, type SecretCodec } from './secret-box.ts'

/**
 * 平台任务执行器可选的 OpenAI 兼容 provider。apiKey 在 data/model-providers.json
 * 中必须加密落盘；列表接口只返回 hasApiKey，不回显明文。
 */
export interface ModelProviderView {
  name: string
  baseUrl: string
  apiKeyEnv?: string
  models: string[]
  defaultModel: string
  enabled: boolean
  isDefault: boolean
  hasApiKey: boolean
  timeoutMs: number
  maxTokens: number
  temperature: number
  stream: boolean
  maxRetries: number
  retryBackoffMs: number
  inputCostPer1M?: number
  outputCostPer1M?: number
  currency: string
}

interface ModelProvider extends Omit<ModelProviderView, 'hasApiKey'> {
  apiKey?: string
}

export interface ModelChoice {
  provider?: string
  model?: string
}

export interface ResolvedModel {
  model: ChatModel
  provider: string
  modelName: string
  /** 每百万 token 单价；未配置时任务只统计 token，不算钱。 */
  inputCostPer1M?: number
  outputCostPer1M?: number
  currency?: string
}

const NAME = /^[a-z0-9][a-z0-9-_]*$/
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/
const KEYS = new Set([
  'name',
  'baseUrl',
  'apiKey',
  'apiKeyEnv',
  'clearApiKey',
  'models',
  'defaultModel',
  'enabled',
  'isDefault',
  'timeoutMs',
  'maxTokens',
  'temperature',
  'stream',
  'maxRetries',
  'retryBackoffMs',
  'inputCostPer1M',
  'outputCostPer1M',
  'currency',
])

export class ModelProviderStore {
  private providers: ModelProvider[] | undefined

  constructor(
    private readonly file: string | null,
    private readonly codec: SecretCodec = plaintextCodec,
  ) {}

  async list(): Promise<ModelProviderView[]> {
    return (await this.all()).map(toView)
  }

  async get(name: string): Promise<ModelProviderView | undefined> {
    const provider = (await this.all()).find((item) => item.name === name)
    return provider ? toView(provider) : undefined
  }

  /** 内部使用：包含解密后的 apiKey，禁止直接返回给 HTTP 层。 */
  async all(): Promise<ModelProvider[]> {
    await this.load()
    return clone(this.providers!)
  }

  async upsert(value: unknown): Promise<ModelProviderView> {
    await this.load()
    if (!isRecord(value)) throw new Error('模型 provider 必须是对象')
    for (const key of Object.keys(value)) {
      if (!KEYS.has(key)) throw new Error(`模型 provider 包含未知字段 ${key}`)
    }
    const name = text(value.name, 'name')
    if (!NAME.test(name)) throw new Error('name 只能是小写字母、数字、- 和 _')
    const existing = this.providers!.find((provider) => provider.name === name)
    const provider = validateProvider(value, existing)
    if (provider.isDefault && !provider.enabled) throw new Error('默认 provider 必须启用')
    if (existing) {
      this.providers = this.providers!.map((item) => (item.name === name ? provider : item))
    } else {
      this.providers = [...this.providers!, provider]
    }
    if (provider.isDefault) {
      this.providers = this.providers!.map((item) => (item.name === name ? item : { ...item, isDefault: false }))
    }
    await this.persist()
    return toView(provider)
  }

  async remove(name: string): Promise<boolean> {
    await this.load()
    const before = this.providers!.length
    this.providers = this.providers!.filter((provider) => provider.name !== name)
    if (this.providers.length === before) return false
    await this.persist()
    return true
  }

  private async load(): Promise<void> {
    if (this.providers) return
    if (!this.file) {
      this.providers = []
      return
    }
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error
      this.providers = []
      return
    }
    const parsed: unknown = JSON.parse(raw)
    const value = Array.isArray(parsed) ? parsed : (parsed as { providers?: unknown })?.providers
    if (value !== undefined && !Array.isArray(value)) throw new Error('data/model-providers.json 的 providers 必须是数组')
    const names = new Set<string>()
    let needsMigration = false
    const providers = (value ?? []).map((item, index) => {
      if (!isRecord(item)) throw new Error(`providers[${index}] 必须是对象`)
      const provider = validateProvider(item, undefined, index)
      if (names.has(provider.name)) throw new Error(`模型 provider 重复: ${provider.name}`)
      names.add(provider.name)
      if (provider.apiKey) {
        if (!isEncrypted(provider.apiKey)) needsMigration = true
        try {
          provider.apiKey = this.codec.decrypt(provider.apiKey)
        } catch (error) {
          throw new Error(`providers[${index}].apiKey 解密失败：${(error as Error).message}`)
        }
      }
      return provider
    })
    // 保证最多一个默认 provider；旧数据里多个默认时取第一个。
    let defaultSeen = false
    this.providers = providers.map((provider) => {
      if (!provider.isDefault) return provider
      if (defaultSeen) return { ...provider, isDefault: false }
      defaultSeen = true
      return provider
    })
    if (this.codec.canEncrypt && needsMigration) await this.persist()
  }

  private async persist(): Promise<void> {
    if (!this.file) return
    await mkdir(path.dirname(this.file), { recursive: true })
    const providers = (this.providers ?? []).map((provider) => ({
      ...provider,
      ...(provider.apiKey ? { apiKey: this.codec.encrypt(provider.apiKey) } : {}),
    }))
    const temp = `${this.file}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify({ providers }, null, 2), { mode: 0o600 })
    await rename(temp, this.file)
    await chmod(this.file, 0o600)
  }
}

/** 平台任务执行器：按任务选择 provider/model，没有可用 provider 时回退到旧环境变量配置。 */
export class ModelRegistry {
  constructor(
    private readonly store: ModelProviderStore,
    private readonly fallback?: ResolvedModel,
  ) {}

  async resolve(choice: ModelChoice = {}): Promise<ResolvedModel | undefined> {
    const providers = await this.store.all()
    const providerName = choice.provider?.trim() || undefined
    const requestedModel = choice.model?.trim() || undefined
    if (providerName) {
      const provider = providers.find((item) => item.name === providerName)
      if (!provider) throw new Error(`模型 provider 不存在: ${providerName}`)
      if (!provider.enabled) throw new Error(`模型 provider 未启用: ${providerName}`)
      return buildResolved(provider, requestedModel)
    }
    const enabled = providers.filter((provider) => provider.enabled)
    if (enabled.length === 0) return this.fallback
    const provider = enabled.find((item) => item.isDefault) ?? enabled[0]
    return buildResolved(provider!, requestedModel)
  }

  async probe(name: string, model?: string): Promise<{ provider: string; model: string; latencyMs: number; reply: string }> {
    const resolved = await this.resolve({ provider: name, model })
    if (!resolved) throw new Error(`模型 provider 不可用: ${name}`)
    const started = Date.now()
    const completion = await resolved.model.complete({
      messages: [{ role: 'user', content: '只回复 OK' }],
      tools: [],
      signal: AbortSignal.timeout(15_000),
    })
    return {
      provider: resolved.provider,
      model: resolved.modelName,
      latencyMs: Date.now() - started,
      reply: completion.content.trim().slice(0, 200),
    }
  }

  /** 调 OpenAI 兼容的 /v1/models；仅作为编辑器辅助，不自动落盘。 */
  async discover(name: string): Promise<string[]> {
    const provider = (await this.store.all()).find((item) => item.name === name)
    if (!provider) throw new Error(`模型 provider 不存在: ${name}`)
    const base = provider.baseUrl.replace(/\/+$/, '').replace(/\/chat\/completions$/, '')
    const apiKey = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : provider.apiKey
    if (provider.apiKeyEnv && !apiKey) throw new Error(`环境变量 ${provider.apiKeyEnv} 未设置`)
    let response: Response
    try {
      response = await fetch(`${base}/models`, {
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(15_000),
      })
    } catch (error) {
      throw new Error(`拉取模型列表失败: ${errorText(error, apiKey)}`)
    }
    const body = await response.text()
    if (!response.ok) {
      throw new Error(`拉取模型列表失败 ${response.status}: ${clip(redact(body, apiKey), 300)}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      throw new Error('模型列表返回的不是 JSON')
    }
    const items = isRecord(parsed)
      ? (Array.isArray(parsed.data) ? parsed.data : Array.isArray(parsed.models) ? parsed.models : [])
      : []
    const models = items
      .map((item) => (typeof item === 'string' ? item : isRecord(item) && typeof item.id === 'string' ? item.id : ''))
      .filter((item) => item.length > 0)
    return [...new Set(models)].sort()
  }
}

function validateProvider(value: Record<string, unknown>, existing: ModelProvider | undefined, index?: number): ModelProvider {
  const label = index === undefined ? '模型 provider' : `providers[${index}]`
  const name = text(value.name, `${label}.name`)
  if (!NAME.test(name)) throw new Error(`${label}.name 只能是小写字母、数字、- 和 _`)
  const baseUrl = normalizeBaseUrl(text(value.baseUrl, `${label}.baseUrl`), label)
  const models = stringArray(value.models, `${label}.models`) ?? existing?.models ?? []
  const defaultModel = optionalText(value.defaultModel) ?? existing?.defaultModel
  if (!defaultModel) throw new Error(`${label}.defaultModel 必填`)
  if (!models.includes(defaultModel)) models.unshift(defaultModel)

  let apiKey = existing?.apiKey
  let apiKeyEnv = existing?.apiKeyEnv
  if (value.clearApiKey === true) {
    apiKey = undefined
    apiKeyEnv = undefined
  } else {
    let incomingKey: string | undefined
    if (value.apiKey !== undefined) {
      if (typeof value.apiKey !== 'string') throw new Error(`${label}.apiKey 必须是字符串`)
      incomingKey = value.apiKey.trim() || undefined
    }
    let incomingEnv: string | undefined
    if (value.apiKeyEnv !== undefined) {
      if (typeof value.apiKeyEnv !== 'string') throw new Error(`${label}.apiKeyEnv 必须是字符串`)
      incomingEnv = value.apiKeyEnv.trim() || undefined
      if (incomingEnv && !ENV_NAME.test(incomingEnv)) throw new Error(`${label}.apiKeyEnv 必须是环境变量名`)
    }
    if (incomingKey && incomingEnv) throw new Error(`${label} 只能配置 apiKey 或 apiKeyEnv 其中一个`)
    if (incomingKey) {
      apiKey = incomingKey
      apiKeyEnv = undefined
    } else if (incomingEnv) {
      apiKeyEnv = incomingEnv
      apiKey = undefined
    } else if (value.apiKeyEnv !== undefined) {
      // 显式传空字符串表示清掉环境变量引用，保留已存 apiKey（如果有）。
      apiKeyEnv = undefined
    }
    if (apiKey && apiKeyEnv) throw new Error(`${label} 只能配置 apiKey 或 apiKeyEnv 其中一个`)
  }

  return {
    name,
    baseUrl,
    ...(apiKey ? { apiKey } : {}),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    models,
    defaultModel,
    enabled: booleanOf(value.enabled, existing?.enabled ?? true, `${label}.enabled`),
    isDefault: booleanOf(value.isDefault, existing?.isDefault ?? false, `${label}.isDefault`),
    timeoutMs: integerOf(value.timeoutMs, existing?.timeoutMs ?? 120_000, 1_000, 300_000, `${label}.timeoutMs`),
    maxTokens: integerOf(value.maxTokens, existing?.maxTokens ?? 4_096, 1, 200_000, `${label}.maxTokens`),
    temperature: numberOf(value.temperature, existing?.temperature ?? 0.2, 0, 2, `${label}.temperature`),
    stream: booleanOf(value.stream, existing?.stream ?? true, `${label}.stream`),
    maxRetries: integerOf(value.maxRetries, existing?.maxRetries ?? 2, 0, 10, `${label}.maxRetries`),
    retryBackoffMs: integerOf(value.retryBackoffMs, existing?.retryBackoffMs ?? 500, 0, 60_000, `${label}.retryBackoffMs`),
    ...optionalNumberField(value, 'inputCostPer1M', existing?.inputCostPer1M, label),
    ...optionalNumberField(value, 'outputCostPer1M', existing?.outputCostPer1M, label),
    currency: currencyOf(value.currency, existing?.currency ?? 'USD', `${label}.currency`),
  }
}

function buildResolved(provider: ModelProvider, requestedModel: string | undefined): ResolvedModel {
  const apiKey = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : provider.apiKey
  if (provider.apiKeyEnv && !apiKey) {
    throw new Error(`模型 provider ${provider.name} 需要环境变量 ${provider.apiKeyEnv}，但当前未设置`)
  }
  const modelName = requestedModel || provider.defaultModel
  return {
    model: new OpenAiCompatibleModel({
      baseUrl: provider.baseUrl,
      model: modelName,
      ...(apiKey ? { apiKey } : {}),
      timeoutMs: provider.timeoutMs,
      maxTokens: provider.maxTokens,
      temperature: provider.temperature,
      stream: provider.stream,
      maxRetries: provider.maxRetries,
      retryBackoffMs: provider.retryBackoffMs,
    }),
    provider: provider.name,
    modelName,
    ...(provider.inputCostPer1M !== undefined ? { inputCostPer1M: provider.inputCostPer1M } : {}),
    ...(provider.outputCostPer1M !== undefined ? { outputCostPer1M: provider.outputCostPer1M } : {}),
    currency: provider.currency,
  }
}

function toView(provider: ModelProvider): ModelProviderView {
  const { apiKey, ...view } = provider
  return { ...view, hasApiKey: Boolean(apiKey) }
}

function normalizeBaseUrl(value: string, label: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${label}.baseUrl 不合法`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${label}.baseUrl 必须是 http(s)`)
  if (url.username || url.password) throw new Error(`${label}.baseUrl 不能包含用户名或密码`)
  if (url.search || url.hash) throw new Error(`${label}.baseUrl 不能带查询参数或锚点`)
  return value.replace(/\/+$/, '')
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 必填`)
  return value.trim()
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function stringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${label} 必须是字符串数组`)
  }
  return [...new Set(value.map((item) => (item as string).trim()).filter(Boolean))]
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

function currencyOf(value: unknown, fallback: string, label: string): string {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value.trim())) {
    throw new Error(`${label} 必须是 3 位大写货币代码，例如 USD 或 CNY`)
  }
  return value.trim()
}

function optionalNumberField(
  value: Record<string, unknown>,
  key: 'inputCostPer1M' | 'outputCostPer1M',
  fallback: number | undefined,
  label: string,
): Partial<Record<typeof key, number>> {
  if (value[key] === undefined) return fallback === undefined ? {} : { [key]: fallback }
  if (value[key] === null) return {}
  return { [key]: numberOf(value[key], fallback ?? 0, 0, 1_000_000, `${label}.${key}`) }
}

function numberOf(value: unknown, fallback: number, min: number, max: number, label: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} 必须是 ${min} 到 ${max} 的数字`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isEncrypted(value: string): boolean {
  return value.startsWith('enc:v1:')
}

function clone(providers: ModelProvider[]): ModelProvider[] {
  return providers.map((provider) => ({ ...provider, models: [...provider.models] }))
}

function redact(value: string, secret: string | undefined): string {
  return secret ? value.replaceAll(secret, '***') : value
}

function errorText(error: unknown, secret: string | undefined): string {
  const message = error instanceof Error ? error.message : String(error)
  return clip(redact(message, secret), 300)
}

function clip(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length)}…`
}