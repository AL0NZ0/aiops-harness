import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { McpServerConfig, OpsSystem } from '../../extensions/ops-tools/src/index.ts'
import { plaintextCodec, type SecretCodec } from './secret-box.ts'

const SYSTEMS: OpsSystem[] = ['prometheus', 'kubernetes', 'loki', 'elasticsearch']
const NAME = /^[a-z0-9][a-z0-9-]*$/
const KEYS = new Set(['name', 'system', 'url', 'readOnly', 'mutateTools', 'excludeTools', 'headers', 'timeoutMs'])

export function validateMcpServers(value: unknown): McpServerConfig[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error('mcpServers 必须是数组')
  const names = new Set<string>()
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`mcpServers[${index}] 必须是对象`)
    }
    const record = item as Record<string, unknown>
    for (const key of Object.keys(record)) {
      if (!KEYS.has(key)) throw new Error(`mcpServers[${index}] 包含未知字段 ${key}`)
    }
    const name = text(record.name, `mcpServers[${index}].name`)
    if (!NAME.test(name)) throw new Error(`mcpServers[${index}].name 不合法`)
    if (names.has(name)) throw new Error(`mcpServers 的 name 重复: ${name}`)
    names.add(name)
    const system = text(record.system, `mcpServers[${index}].system`)
    if (!SYSTEMS.includes(system as OpsSystem)) throw new Error(`mcpServers[${index}].system 不合法: ${system}`)
    const url = text(record.url, `mcpServers[${index}].url`)
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error(`mcpServers[${index}].url 不合法`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`mcpServers[${index}].url 必须是 http(s)`)
    }
    let readOnly: boolean | undefined
    if (record.readOnly !== undefined) {
      if (typeof record.readOnly !== 'boolean') throw new Error(`mcpServers[${index}].readOnly 必须是布尔值`)
      readOnly = record.readOnly
    }
    let timeoutMs: number | undefined
    if (record.timeoutMs !== undefined) {
      if (
        typeof record.timeoutMs !== 'number' ||
        !Number.isInteger(record.timeoutMs) ||
        record.timeoutMs < 1_000 ||
        record.timeoutMs > 60_000
      ) {
        throw new Error(`mcpServers[${index}].timeoutMs 必须是 1000 到 60000 的整数`)
      }
      timeoutMs = record.timeoutMs
    }
    return {
      name,
      system: system as OpsSystem,
      url,
      readOnly,
      mutateTools: stringArray(record.mutateTools, `mcpServers[${index}].mutateTools`),
      excludeTools: stringArray(record.excludeTools, `mcpServers[${index}].excludeTools`),
      headers: headersOf(record.headers, index),
      timeoutMs,
    }
  })
}

/**
 * 页面和接口只能看到 header 名，值统一置空；保存时空值表示保留原值，
 * 删除要显式传 clearHeaders（数组或 true）。这样 token 不会回显到浏览器。
 */
export interface McpServerView extends Omit<McpServerConfig, 'headers'> {
  headers?: Record<string, ''>
  headerNames: string[]
}

export function mcpServerView(server: McpServerConfig): McpServerView {
  const names = Object.keys(server.headers ?? {})
  return {
    ...server,
    ...(names.length > 0
      ? { headers: Object.fromEntries(names.map((name) => [name, ''] as const)) }
      : { headers: undefined }),
    headerNames: names,
  }
}

export class McpServerStore {
  private servers: McpServerConfig[] | undefined

  constructor(
    private readonly file: string | null,
    private readonly seed: McpServerConfig[] = [],
    private readonly codec: SecretCodec = plaintextCodec,
  ) {}

  async list(): Promise<McpServerConfig[]> {
    await this.load()
    return clone(this.servers!)
  }

  /**
   * 把页面提交的配置与已保存的 headers 合并后再校验；探测和落盘都用合并后的真实值。
   * headers 里 `${ENV}` 占位符保持原样，发送时再解析。
   */
  async resolve(input: unknown): Promise<McpServerConfig[]> {
    await this.load()
    const existing = new Map(this.servers!.map((server) => [server.name, server]))
    const merged = Array.isArray(input)
      ? input.map((item) => mergeServerInput(item, existing))
      : input
    return validateMcpServers(merged)
  }

  async replace(input: unknown): Promise<McpServerConfig[]> {
    return this.replaceValidated(await this.resolve(input))
  }

  async replaceValidated(servers: McpServerConfig[]): Promise<McpServerConfig[]> {
    await this.load()
    this.servers = servers
    await this.persist()
    return clone(servers)
  }

  private async load(): Promise<void> {
    if (this.servers) return
    if (!this.file) {
      this.servers = clone(this.seed)
      return
    }
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error
      this.servers = clone(this.seed)
      return
    }
    const parsed: unknown = JSON.parse(raw)
    const value = Array.isArray(parsed) ? parsed : (parsed as { servers?: unknown })?.servers
    this.servers = validateMcpServers(value).map((server, index) => decryptHeaders(this.codec, server, index))
    if (this.codec.canEncrypt && this.servers.some(hasPlaintextHeaders)) await this.persist()
  }

  private async persist(): Promise<void> {
    if (!this.file) return
    await mkdir(path.dirname(this.file), { recursive: true })
    const servers = (this.servers ?? []).map((server) =>
      server.headers
        ? { ...server, headers: Object.fromEntries(Object.entries(server.headers).map(([key, value]) => [key, this.codec.encrypt(value)])) }
        : server,
    )
    const temp = `${this.file}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify({ servers }, null, 2), { mode: 0o600 })
    await rename(temp, this.file)
    await chmod(this.file, 0o600)
  }
}

function mergeServerInput(item: unknown, existing: Map<string, McpServerConfig>): unknown {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item
  const record = item as Record<string, unknown>
  const current = typeof record.name === 'string' ? existing.get(record.name) : undefined
  const clear = record.clearHeaders
  if (
    clear !== undefined &&
    clear !== true &&
    (!Array.isArray(clear) || clear.some((name) => typeof name !== 'string' || !name.trim()))
  ) {
    throw new Error('mcpServers.clearHeaders 必须是 true 或字符串数组')
  }
  const merged: Record<string, unknown> = { ...record }
  delete merged.clearHeaders
  delete merged.headerNames
  const headers = record.headers
  if (headers === undefined) {
    if (current?.headers && Object.keys(current.headers).length > 0) merged.headers = { ...current.headers }
    return merged
  }
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    merged.headers = headers
    return merged
  }
  const entries = Object.entries(headers as Record<string, unknown>)
  if (entries.some(([, value]) => typeof value !== 'string')) {
    merged.headers = headers
    return merged
  }
  const next: Record<string, string> = { ...(current?.headers ?? {}) }
  if (clear === true) {
    for (const name of Object.keys(next)) delete next[name]
  } else if (Array.isArray(clear)) {
    for (const name of clear) delete next[(name as string).trim()]
  }
  for (const [name, value] of entries) {
    const key = name.trim()
    if (!key) continue
    // 空值表示保持原值；新 header 不能用空值创建。
    if (value === '') continue
    next[key] = value as string
  }
  if (Object.keys(next).length > 0) merged.headers = next
  else delete merged.headers
  return merged
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 必填`)
  return value.trim()
}

function stringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${label} 必须是字符串数组`)
  }
  return value.map((item) => (item as string).trim())
}

function headersOf(value: unknown, index: number): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`mcpServers[${index}].headers 必须是对象`)
  }
  const headers: Record<string, string> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== 'string') throw new Error(`mcpServers[${index}].headers.${key} 必须是字符串`)
    headers[key] = item
  }
  return headers
}

function decryptHeaders(codec: SecretCodec, server: McpServerConfig, index: number): McpServerConfig {
  if (!server.headers) return server
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(server.headers)) {
    try {
      headers[key] = codec.decrypt(value)
    } catch (error) {
      throw new Error(`mcpServers[${index}].headers.${key} 解密失败：${(error as Error).message}`)
    }
  }
  return { ...server, headers }
}

function hasPlaintextHeaders(server: McpServerConfig): boolean {
  return Object.values(server.headers ?? {}).some((value) => value.length > 0 && !value.startsWith('enc:v1:'))
}

function clone(servers: McpServerConfig[]): McpServerConfig[] {
  return servers.map((server) => ({
    ...server,
    ...(server.mutateTools ? { mutateTools: [...server.mutateTools] } : {}),
    ...(server.excludeTools ? { excludeTools: [...server.excludeTools] } : {}),
    ...(server.headers ? { headers: { ...server.headers } } : {}),
  }))
}