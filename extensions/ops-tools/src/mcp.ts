import type { Tool } from '../../../api/src/types.ts'
import type { OpsSystem } from './world.ts'

export interface McpServerConfig {
  name: string
  system: OpsSystem
  url: string
  /** 只读服务器要显式打开；不写时按变更处理，失败关闭。 */
  readOnly?: boolean
  /** 只读服务器里仍可能写数据的工具，例如 Kubernetes MCP 的 helm。 */
  mutateTools?: string[]
  /** 完全不暴露给平台的上游工具。 */
  excludeTools?: string[]
  headers?: Record<string, string>
  timeoutMs?: number
}

export interface McpToolDefinition {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

interface RpcMessage {
  id?: unknown
  result?: unknown
  error?: { code?: number; message?: string }
}

interface PostResult {
  messages: RpcMessage[]
  sessionId?: string
}

class McpHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

/**
 * Streamable HTTP 的 MCP 客户端。
 * 初始化后保留 mcp-session-id；响应可能是 JSON，也可能是 SSE。
 */
export class McpHttpClient {
  private sessionId: string | undefined
  private protocolVersion = '2024-11-05'
  private seq = 0
  private ready = false

  constructor(
    private readonly config: McpServerConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** 尽力关闭会话：不是所有上游都支持 DELETE，失败只忽略。 */
  async close(): Promise<void> {
    const sessionId = this.sessionId
    this.sessionId = undefined
    this.ready = false
    if (!sessionId) return
    try {
      await this.fetchImpl(this.config.url, {
        method: 'DELETE',
        headers: { ...resolveHeaders(this.config.headers), 'mcp-session-id': sessionId },
        signal: AbortSignal.timeout(2_000),
      })
    } catch {
      // 上游不支持会话删除时保持静默。
    }
  }

  async initialize(): Promise<void> {
    const response = await this.post({
      jsonrpc: '2.0',
      id: ++this.seq,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'aiops-harness', version: '0.1.0' },
      },
    })
    const message = findMessage(response.messages, this.seq)
    if (!message) throw new Error(`MCP ${this.config.name} 没有返回 initialize 响应`)
    if (message.error) throw new Error(message.error.message ?? 'MCP initialize 失败')
    const result = asRecord(message.result)
    if (typeof result?.protocolVersion === 'string') this.protocolVersion = result.protocolVersion
    this.sessionId = response.sessionId ?? this.sessionId
    this.ready = true
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' })
  }

  async listTools(): Promise<McpToolDefinition[]> {
    const tools: McpToolDefinition[] = []
    let cursor: string | undefined
    do {
      const result = asRecord(await this.request('tools/list', cursor ? { cursor } : {}))
      const items = Array.isArray(result?.tools) ? result.tools : []
      for (const item of items) {
        const record = asRecord(item)
        if (typeof record?.name !== 'string' || !record.name) continue
        tools.push({
          name: record.name,
          description: typeof record.description === 'string' ? record.description : '',
          inputSchema: asRecord(record.inputSchema) ?? { type: 'object' },
        })
      }
      cursor = typeof result?.nextCursor === 'string' ? result.nextCursor : undefined
    } while (cursor)
    return tools
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const result = asRecord(await this.request('tools/call', { name, arguments: args }, signal))
    if (result?.isError === true) throw new Error(textContent(result.content) || `MCP 工具 ${name} 返回错误`)
    if (result?.structuredContent !== undefined) return result.structuredContent
    return parseContent(result?.content)
  }

  private async request(method: string, params: unknown, signal?: AbortSignal, retried = false): Promise<unknown> {
    if (!this.ready) await this.initialize()
    const id = ++this.seq
    try {
      const response = await this.post({ jsonrpc: '2.0', id, method, params }, signal)
      const message = findMessage(response.messages, id)
      if (!message) throw new Error(`MCP ${this.config.name} 没有返回 ${method} 响应`)
      if (message.error) throw new Error(message.error.message ?? `MCP ${method} 失败`)
      return message.result
    } catch (error) {
      if (!retried && error instanceof McpHttpError && [400, 404, 406].includes(error.status)) {
        this.ready = false
        this.sessionId = undefined
        await this.initialize()
        return this.request(method, params, signal, true)
      }
      throw error
    }
  }

  private async post(payload: Record<string, unknown>, signal?: AbortSignal): Promise<PostResult> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...resolveHeaders(this.config.headers),
    }
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId
    if (this.ready) headers['mcp-protocol-version'] = this.protocolVersion
    const method = typeof payload.method === 'string' ? payload.method : 'request'
    const timeout = this.config.timeoutMs ?? 15_000
    const timeoutSignal = signal ? undefined : AbortSignal.timeout(timeout)
    let response: Response
    try {
      response = await this.fetchImpl(this.config.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: signal ?? timeoutSignal,
      })
    } catch (error) {
      throw this.transportError(error, method, timeout, signal, timeoutSignal)
    }
    const sessionId = response.headers.get('mcp-session-id') ?? undefined
    if (response.status === 202) return { messages: [], sessionId }
    const contentType = response.headers.get('content-type') ?? ''
    try {
      if (!response.ok) {
        // 上游报错时只读一小段错误体，不等到流关闭：有些实现（rmcp）报错后一直挂着 SSE，
        // 读满 timeoutMs 只会把真实原因变成 terminated。
        const text = await readBodyText(response, 4_000, (partial) => partial.includes('\n\n'))
        let detail = text
        try {
          detail = firstErrorMessage(parseMessages(contentType, text)) ?? text
        } catch {
          // 错误体不是 JSON（例如 nginx 的 401 文本），直接用原文。
        }
        throw new McpHttpError(`MCP ${this.config.name} ${method} 失败 ${response.status}: ${detail.slice(0, 300)}`, response.status)
      }
      if (contentType.includes('text/event-stream')) {
        const expectedId = typeof payload.id === 'number' ? payload.id : undefined
        const messages = expectedId === undefined
          ? parseMessages(contentType, await readBodyText(response, 1_000_000))
          : await readEventStream(response, expectedId)
        return { messages, sessionId }
      }
      return {
        messages: parseMessages(contentType, await response.text()),
        sessionId,
      }
    } catch (error) {
      if (error instanceof McpHttpError) throw error
      throw this.transportError(error, method, timeout, signal, timeoutSignal)
    }
  }

  private transportError(
    error: unknown,
    method: string,
    timeout: number,
    signal?: AbortSignal,
    timeoutSignal?: AbortSignal,
  ): Error {
    if (signal?.aborted) return new Error(`MCP ${this.config.name} ${method} 被取消`)
    if (timeoutSignal?.aborted || isAbortError(error)) {
      return new Error(`MCP ${this.config.name} ${method} 等待响应超过 ${timeout}ms，上游没有返回匹配的响应`)
    }
    if (error instanceof Error && error.message === 'terminated') {
      return new Error(`MCP ${this.config.name} ${method} 连接被上游提前断开，没有返回匹配的响应`)
    }
    return error instanceof Error ? error : new Error(String(error))
  }
}

export interface McpServerError {
  name: string
  message: string
}

/**
 * 初始化上游 MCP 并注册工具。
 * 默认失败关闭：任何一个 server 初始化失败都抛错（保存配置前的探测用这个）。
 * tolerateFailures=true 时只记录失败、返回其余工具（平台启动用，避免外部服务挂了导致平台起不来）。
 */
export async function createUpstreamMcpTools(options: {
  servers: McpServerConfig[]
  fetchImpl?: typeof fetch
  tolerateFailures?: boolean
}): Promise<{
  tools: Tool[]
  errors: McpServerError[]
  close: () => Promise<void>
}> {
  const tools: Tool[] = []
  const errors: McpServerError[] = []
  const clients: McpHttpClient[] = []
  for (const server of options.servers) {
    const client = new McpHttpClient(server, options.fetchImpl)
    clients.push(client)
    try {
      await client.initialize()
      const definitions = await client.listTools()
      const mutateTools = new Set(server.mutateTools ?? [])
      const excludeTools = new Set(server.excludeTools ?? [])
      for (const definition of definitions) {
        if (excludeTools.has(definition.name)) continue
        tools.push({
          name: `mcp.${server.name}.${definition.name}`,
          description: `[MCP ${server.name}] ${definition.description ?? ''}`.trim(),
          risk: server.readOnly === true && !mutateTools.has(definition.name) ? 'read' : 'mutate',
          parameters: definition.inputSchema ?? { type: 'object' },
          execute: (args, ctx) => client.callTool(definition.name, args, ctx.signal),
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误'
      if (!options.tolerateFailures) throw new Error(`MCP server ${server.name} 初始化失败: ${message}`)
      errors.push({ name: server.name, message })
    }
  }
  return {
    tools,
    errors,
    close: async () => {
      await Promise.allSettled(clients.map((client) => client.close()))
    },
  }
}

/**
 * headers 里的 `${ENV_NAME}` 在发送时解析，便于 Docker/K8s 用环境变量注入 token，
 * 配置文件和 data/mcp-servers.json 里只留占位符。缺失的环境变量直接报错，不带出其他值。
 */
export function resolveHeaders(
  headers: Record<string, string> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (!headers) return {}
  const resolved: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    resolved[key] = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
      const replacement = env[name]
      if (replacement === undefined) {
        throw new Error(`MCP headers.${key} 引用的环境变量 ${name} 未设置`)
      }
      return replacement
    })
  }
  return resolved
}

function parseMessages(contentType: string, text: string): RpcMessage[] {
  const messages: RpcMessage[] = []
  if (contentType.includes('text/event-stream')) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data) continue
      try {
        pushMessage(JSON.parse(data), messages)
      } catch {
        // SSE 里可能夹着非 JSON 的注释或心跳，忽略。
      }
    }
    return messages
  }
  if (!text.trim()) return []
  const parsed: unknown = JSON.parse(text)
  pushMessage(parsed, messages)
  return messages
}

function pushMessage(parsed: unknown, messages: RpcMessage[]): void {
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const record = asRecord(item)
      if (record) messages.push(record)
    }
    return
  }
  const record = asRecord(parsed)
  if (record) messages.push(record)
}

/**
 * 增量读取 SSE，拿到匹配 id 的响应就停止并断开。
 * 上游（例如 rmcp）返回错误或结果后经常不关流，等 response.text() 只会等到 timeoutMs。
 */
async function readEventStream(response: Response, expectedId: number): Promise<RpcMessage[]> {
  const body = response.body
  if (!body) return []
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const messages: RpcMessage[] = []
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (value) buffer += decoder.decode(value, { stream: true })
      buffer = drainSse(buffer, messages, done)
      if (messages.some((message) => message.id === expectedId)) break
      if (done) break
    }
    return messages
  } finally {
    try {
      await reader.cancel()
    } catch {
      // 流已经结束时忽略。
    }
  }
}

/** 只消费完整的行，残留半行留到下一次；flush 时把剩余内容一起解析。 */
function drainSse(buffer: string, messages: RpcMessage[], flush: boolean): string {
  const boundary = buffer.lastIndexOf('\n')
  if (boundary === -1 && !flush) return buffer
  const complete = flush ? buffer : buffer.slice(0, boundary)
  const rest = flush ? '' : buffer.slice(boundary + 1)
  for (const line of complete.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (!data) continue
    try {
      pushMessage(JSON.parse(data), messages)
    } catch {
      // 心跳或注释，忽略。
    }
  }
  return rest
}

/**
 * 读取响应体文本，达到 limit 或 stopWhen 命中就主动断开；用于错误体和没有 id 的通知响应。
 * 读中断时保留已经拿到的内容，不把真实错误换成 transport 错误。
 */
async function readBodyText(
  response: Response,
  limit: number,
  stopWhen?: (partial: string) => boolean,
): Promise<string> {
  const body = response.body
  if (!body) return ''
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  try {
    while (text.length < limit) {
      const { done, value } = await reader.read()
      if (value) text += decoder.decode(value, { stream: true })
      if (done) {
        text += decoder.decode()
        break
      }
      if (stopWhen?.(text)) break
    }
  } catch {
    // 上游不关流或超时中断时返回已有内容。
  } finally {
    try {
      await reader.cancel()
    } catch {
      // 流已经结束时忽略。
    }
  }
  return text
}

function firstErrorMessage(messages: RpcMessage[]): string | undefined {
  for (const message of messages) {
    if (typeof message.error?.message === 'string' && message.error.message) return message.error.message
  }
  return undefined
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const { name, code } = error as { name?: unknown; code?: unknown }
  return name === 'AbortError' || name === 'TimeoutError' || code === 23 || code === 'ABORT_ERR'
}

function findMessage(messages: RpcMessage[], id: number): RpcMessage | undefined {
  return messages.find((message) => message.id === id)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function textContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((item) => {
      const record = asRecord(item)
      return typeof record?.text === 'string' ? record.text : ''
    })
    .filter(Boolean)
    .join('\n')
}

function parseContent(content: unknown): unknown {
  const text = textContent(content)
  if (!text) return content ?? null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}