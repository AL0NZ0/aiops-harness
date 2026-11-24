import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { PlatformError } from './errors.ts'
import type { Tool } from './types.ts'

export type ToolRisk = 'read' | 'mutate'

/**
 * 逐工具的风险覆盖。只允许覆盖上游 MCP 工具（mcp.<server>.<tool>）；
 * 平台内置工具的风险写死在代码里，不能通过策略改。
 */
export interface ToolPolicyRecord {
  risk: ToolRisk
  /** 设置策略时的工具签名；上游工具描述或参数变化后策略自动失效。 */
  signature: string
  updatedBy: string
  updatedAt: string
}

export type ToolPolicyMap = Record<string, ToolPolicyRecord>

export interface ToolPolicyView extends ToolPolicyRecord {
  tool: string
  /** 当前工具清单里的默认风险；工具不存在时为空。 */
  baseRisk?: ToolRisk
  /** 工具仍在，但签名和设置策略时不一致。 */
  stale: boolean
  /** 工具已经不在当前清单里。 */
  missing: boolean
  /** 策略当前是否生效。 */
  active: boolean
}

const TOOL_NAME = /^mcp\.[a-z0-9][a-z0-9-]*\.[^\s]+$/
const SIGNATURE = /^[a-f0-9]{64}$/
const RISKS: ToolRisk[] = ['read', 'mutate']

export function isPolicyToolName(name: string): boolean {
  return TOOL_NAME.test(name)
}

export function toolPolicySignature(tool: Pick<Tool, 'name' | 'description' | 'parameters'>): string {
  return createHash('sha256')
    .update([tool.name, tool.description ?? '', JSON.stringify(tool.parameters ?? {})].join('\u0000'))
    .digest('hex')
}

/**
 * 策略文件是用户运行数据：缺失时从空策略开始，解析失败必须报错，
 * 不能静默清空管理员设置。文件权限 0600。
 */
export class ToolPolicyStore {
  private policies: ToolPolicyMap | undefined
  /** 串行化写操作，避免并发保存时后一请求基于旧快照覆盖前一请求。 */
  private tail: Promise<unknown> = Promise.resolve()

  constructor(private readonly file: string | null) {}

  async list(): Promise<ToolPolicyMap> {
    await this.tail
    await this.load()
    return clone(this.policies!)
  }

  async set(name: string, risk: ToolRisk, signature: string, updatedBy: string): Promise<ToolPolicyRecord> {
    return this.enqueue(async () => {
      await this.load()
      if (!isPolicyToolName(name)) {
        throw new PlatformError('只能给 mcp.* 工具设置审批策略', 400, 'bad_request')
      }
      if (!RISKS.includes(risk)) throw new PlatformError('risk 只能是 read 或 mutate', 400, 'bad_request')
      if (!SIGNATURE.test(signature)) throw new PlatformError('工具签名不合法', 400, 'bad_request')
      const record: ToolPolicyRecord = {
        risk,
        signature,
        updatedBy,
        updatedAt: new Date().toISOString(),
      }
      // 先落盘再更新内存：写失败时不能留下「内存生效、磁盘没变」的分裂状态。
      const next = { ...this.policies!, [name]: record }
      await this.persist(next)
      this.policies = next
      return { ...record }
    })
  }

  async remove(name: string): Promise<boolean> {
    return this.enqueue(async () => {
      await this.load()
      if (!this.policies![name]) return false
      const next = { ...this.policies! }
      delete next[name]
      await this.persist(next)
      this.policies = next
      return true
    })
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action, action)
    this.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async load(): Promise<void> {
    if (this.policies) return
    if (!this.file) {
      this.policies = {}
      return
    }
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error
      this.policies = {}
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(`工具审批策略文件解析失败: ${this.file}`)
    }
    this.policies = validatePolicies(parsed, this.file)
  }

  private async persist(policies: ToolPolicyMap): Promise<void> {
    if (!this.file) return
    await mkdir(path.dirname(this.file), { recursive: true })
    const temp = `${this.file}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify({ version: 1, policies }, null, 2), { mode: 0o600 })
    await rename(temp, this.file)
    await chmod(this.file, 0o600)
  }
}

function validatePolicies(value: unknown, file: string): ToolPolicyMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${file} 必须是对象`)
  }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (key !== 'version' && key !== 'policies') throw new Error(`${file} 包含未知字段 ${key}`)
  }
  if (record.version !== undefined && record.version !== 1) throw new Error(`${file} 的 version 不支持`)
  const raw = record.policies
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${file} 的 policies 必须是对象`)
  }
  const policies: ToolPolicyMap = {}
  for (const [name, item] of Object.entries(raw as Record<string, unknown>)) {
    if (!isPolicyToolName(name)) throw new Error(`${file} 包含不合法的工具名 ${name}`)
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${file} 的 ${name} 必须是对象`)
    }
    const entry = item as Record<string, unknown>
    for (const key of Object.keys(entry)) {
      if (!['risk', 'signature', 'updatedBy', 'updatedAt'].includes(key)) {
        throw new Error(`${file} 的 ${name} 包含未知字段 ${key}`)
      }
    }
    if (entry.risk !== 'read' && entry.risk !== 'mutate') {
      throw new Error(`${file} 的 ${name}.risk 不合法`)
    }
    if (typeof entry.signature !== 'string' || !SIGNATURE.test(entry.signature)) {
      throw new Error(`${file} 的 ${name}.signature 不合法`)
    }
    if (typeof entry.updatedBy !== 'string' || !entry.updatedBy.trim()) {
      throw new Error(`${file} 的 ${name}.updatedBy 不合法`)
    }
    if (typeof entry.updatedAt !== 'string' || Number.isNaN(Date.parse(entry.updatedAt))) {
      throw new Error(`${file} 的 ${name}.updatedAt 不合法`)
    }
    policies[name] = {
      risk: entry.risk,
      signature: entry.signature,
      updatedBy: entry.updatedBy,
      updatedAt: entry.updatedAt,
    }
  }
  return policies
}

function clone(value: ToolPolicyMap): ToolPolicyMap {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, { ...item }]))
}