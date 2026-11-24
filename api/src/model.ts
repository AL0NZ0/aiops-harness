/**
 * OpenAI Chat Completions 兼容客户端。只做 HTTP 调用和响应归一化，
 * 不关心工具审批；平台 runner 负责把工具结果回填到 messages。
 *
 * 支持 SSE 流式输出（stream=true，失败时自动退回非流式）、
 * usage 统计和可配置的重试/退避。
 */
export interface ChatToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content?: string | null; tool_calls?: ChatToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

export interface ChatTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface ChatUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface ChatCompletion {
  content: string
  toolCalls: ChatToolCall[]
  usage?: ChatUsage
}

export interface ChatRetryInfo {
  attempt: number
  delayMs: number
  message: string
}

export interface ChatRequest {
  messages: ChatMessage[]
  tools: ChatTool[]
  signal?: AbortSignal
  /** 流式文本增量；每次只包含新增内容。 */
  onDelta?: (text: string) => void
  /** 由于可重试错误即将重试时调用；调用方可用于写事件/日志。 */
  onRetry?: (info: ChatRetryInfo) => void
}

export interface ChatModel {
  complete(input: ChatRequest): Promise<ChatCompletion>
}

export interface OpenAiCompatibleModelOptions {
  baseUrl: string
  model: string
  apiKey?: string
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
  /** 默认 true；provider 不支持 SSE 时自动退回非流式。 */
  stream?: boolean
  /** 可重试错误（429/5xx/超时/网络）的最大重试次数，默认 2。 */
  maxRetries?: number
  /** 首次重试等待毫秒数，之后指数退避，默认 500。 */
  retryBackoffMs?: number
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529])

class ModelError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'ModelError'
  }
}

export class OpenAiCompatibleModel implements ChatModel {
  private readonly endpoint: string
  private readonly timeoutMs: number
  private readonly stream: boolean
  private readonly maxRetries: number
  private readonly retryBackoffMs: number

  constructor(private readonly options: OpenAiCompatibleModelOptions) {
    const base = options.baseUrl.replace(/\/+$/, '')
    this.endpoint = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`
    this.timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 120_000
    this.stream = options.stream !== false
    this.maxRetries = Math.max(0, options.maxRetries ?? 2)
    this.retryBackoffMs = Math.max(0, options.retryBackoffMs ?? 500)
  }

  async complete(input: ChatRequest): Promise<ChatCompletion> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.callOnce(input)
      } catch (error) {
        if (!(error instanceof ModelError) || !error.retryable || attempt >= this.maxRetries) throw error
        if (input.signal?.aborted) throw new Error('模型请求已取消')
        const delayMs = this.backoff(attempt)
        input.onRetry?.({ attempt: attempt + 1, delayMs, message: error.message })
        await sleep(delayMs, input.signal)
      }
    }
  }

  private async callOnce(input: ChatRequest): Promise<ChatCompletion> {
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    if (input.signal?.aborted) throw new Error('模型请求已取消')
    input.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    timer.unref?.()
    let emitted = false
    const onDelta = (text: string) => {
      if (!text) return
      emitted = true
      input.onDelta?.(text)
    }
    try {
      if (this.stream) {
        try {
          return await this.request(input, controller.signal, onDelta, true)
        } catch (error) {
          // 只对「还没输出任何增量」的配置/协议错误退回非流式；
          // 网络中断、超时和 429/5xx 交给外层重试，避免重复输出。
          if (
            emitted ||
            !(error instanceof ModelError) ||
            error.status === undefined ||
            ![400, 404, 405, 415, 422, 501].includes(error.status)
          ) {
            throw error
          }
          return await this.request(input, controller.signal, onDelta, false)
        }
      }
      return await this.request(input, controller.signal, onDelta, false)
    } catch (error) {
      if (controller.signal.aborted) {
        if (input.signal?.aborted) throw new Error('模型请求已取消')
        throw new ModelError(`模型请求超时（${this.timeoutMs}ms）`, true)
      }
      if (!emitted && isNetworkError(error)) {
        throw new ModelError(`模型接口网络错误：${error.message}`, true)
      }
      throw error
    } finally {
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', onAbort)
    }
  }

  private async request(
    input: ChatRequest,
    signal: AbortSignal,
    onDelta: (text: string) => void,
    stream: boolean,
  ): Promise<ChatCompletion> {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.options.model,
        messages: input.messages,
        ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
        ...(input.tools.length > 0 ? { tools: input.tools, tool_choice: 'auto' } : {}),
        ...(this.options.temperature !== undefined ? { temperature: this.options.temperature } : {}),
        ...(this.options.maxTokens !== undefined ? { max_tokens: this.options.maxTokens } : {}),
      }),
      signal,
    })
    if (!response.ok) {
      const text = await response.text()
      throw new ModelError(
        `模型接口返回 ${response.status}: ${clip(this.redact(text), 500)}`,
        RETRYABLE_STATUS.has(response.status) || response.status >= 500,
        response.status,
      )
    }
    const contentType = response.headers.get('content-type') ?? ''
    if (!stream || !contentType.includes('text/event-stream') || !response.body) {
      const text = await response.text()
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        if (stream) throw new ModelError('模型接口没有返回 SSE 或 JSON', false)
        throw new ModelError('模型接口返回的不是 JSON', false)
      }
      return parseCompletion(body)
    }
    return parseStream(response.body, onDelta)
  }

  private redact(value: string): string {
    return this.options.apiKey ? value.replaceAll(this.options.apiKey, '***') : value
  }

  private backoff(attempt: number): number {
    const base = this.retryBackoffMs * 2 ** attempt
    return Math.min(10_000, base + Math.floor(Math.random() * Math.min(250, base / 2 + 1)))
  }
}

async function parseStream(
  body: ReadableStream<Uint8Array>,
  onDelta: (text: string) => void,
): Promise<ChatCompletion> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let usage: ChatUsage | undefined
  const toolCalls = new Map<number, { id?: string; name: string; arguments: string }>()
  let done = false
  try {
    while (!done) {
      const { value, done: finished } = await reader.read()
      if (finished) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload) continue
        if (payload === '[DONE]') {
          done = true
          break
        }
        let chunk: unknown
        try {
          chunk = JSON.parse(payload)
        } catch {
          continue
        }
        const parsed = parseStreamChunk(chunk, toolCalls)
        if (parsed.content) {
          content += parsed.content
          onDelta(parsed.content)
        }
        if (parsed.usage) usage = parsed.usage
      }
    }
  } finally {
    reader.releaseLock()
  }
  if (!content && toolCalls.size === 0) throw new ModelError('模型流式响应为空', false)
  return {
    content,
    toolCalls: finishToolCalls(toolCalls),
    ...(usage ? { usage } : {}),
  }
}

function parseStreamChunk(
  value: unknown,
  toolCalls: Map<number, { id?: string; name: string; arguments: string }>,
): { content: string; usage?: ChatUsage } {
  if (!isRecord(value)) return { content: '' }
  const usage = parseUsage(value.usage)
  const choices = Array.isArray(value.choices) ? value.choices : []
  const first = choices[0]
  if (!isRecord(first)) return { content: '', ...(usage ? { usage } : {}) }
  const delta = isRecord(first.delta)
    ? first.delta
    : isRecord(first.message)
      ? first.message
      : undefined
  if (!delta) return { content: '', ...(usage ? { usage } : {}) }
  const content = contentText(delta.content)
  if (Array.isArray(delta.tool_calls)) {
    delta.tool_calls.forEach((raw, index) => {
      if (!isRecord(raw)) return
      const position = typeof raw.index === 'number' && Number.isInteger(raw.index) ? raw.index : index
      const current = toolCalls.get(position) ?? { name: '', arguments: '' }
      if (typeof raw.id === 'string' && raw.id) current.id = raw.id
      if (isRecord(raw.function)) {
        if (typeof raw.function.name === 'string') current.name += raw.function.name
        if (typeof raw.function.arguments === 'string') current.arguments += raw.function.arguments
      }
      toolCalls.set(position, current)
    })
  }
  return { content, ...(usage ? { usage } : {}) }
}

function finishToolCalls(
  calls: Map<number, { id?: string; name: string; arguments: string }>,
): ChatToolCall[] {
  return [...calls.entries()]
    .filter(([, call]) => call.name.trim())
    .sort(([a], [b]) => a - b)
    .map(([index, call]) => ({
      id: call.id || `call_${index}`,
      type: 'function' as const,
      function: {
        name: call.name.trim(),
        arguments: call.arguments.trim() || '{}',
      },
    }))
}

function parseCompletion(value: unknown): ChatCompletion {
  if (!isRecord(value) || !Array.isArray(value.choices) || value.choices.length === 0) {
    throw new ModelError('模型返回格式不正确：缺少 choices', false)
  }
  const first = value.choices[0]
  if (!isRecord(first) || !isRecord(first.message)) {
    throw new ModelError('模型返回格式不正确：缺少 message', false)
  }
  const message = first.message
  const toolCalls: ChatToolCall[] = []
  if (Array.isArray(message.tool_calls)) {
    message.tool_calls.forEach((raw, index) => {
      if (!isRecord(raw) || !isRecord(raw.function)) return
      const name = typeof raw.function.name === 'string' ? raw.function.name.trim() : ''
      if (!name) return
      toolCalls.push({
        id: typeof raw.id === 'string' && raw.id ? raw.id : `call_${index}`,
        type: 'function',
        function: {
          name,
          arguments: typeof raw.function.arguments === 'string' ? raw.function.arguments : '{}',
        },
      })
    })
  }
  const usage = parseUsage(value.usage)
  return {
    content: contentText(message.content),
    toolCalls,
    ...(usage ? { usage } : {}),
  }
}

function parseUsage(value: unknown): ChatUsage | undefined {
  if (!isRecord(value)) return undefined
  const prompt = tokenCount(value.prompt_tokens ?? value.input_tokens)
  const completion = tokenCount(value.completion_tokens ?? value.output_tokens)
  const total = tokenCount(value.total_tokens) ?? (prompt !== undefined || completion !== undefined
    ? (prompt ?? 0) + (completion ?? 0)
    : undefined)
  if (prompt === undefined && completion === undefined && total === undefined) return undefined
  return {
    promptTokens: prompt ?? 0,
    completionTokens: completion ?? 0,
    totalTokens: total ?? (prompt ?? 0) + (completion ?? 0),
  }
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined
}

/** 兼容字符串内容和部分供应商返回的 content parts 数组。 */
function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
    .join('')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isNetworkError(error: unknown): error is Error {
  return error instanceof TypeError && /fetch failed|network|socket|ECONN|ENOTFOUND|EAI_AGAIN/i.test(error.message)
}

function clip(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length)}…`
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('模型请求已取消'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    timer.unref?.()
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('模型请求已取消'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}