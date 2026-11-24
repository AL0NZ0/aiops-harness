export interface McpToolInfo {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface McpDeps {
  listTools: () => Promise<McpToolInfo[]>
  callTool: (name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>
}

export function encodeFrame(payload: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(payload))
  return Buffer.concat([Buffer.from(`Content-Length: ${json.length}\r\n\r\n`), json])
}

export function takeFrame(buffer: Buffer): { message: unknown; rest: Buffer } | undefined {
  const headerEnd = buffer.indexOf('\r\n\r\n')
  if (headerEnd < 0) return undefined
  const header = buffer.subarray(0, headerEnd).toString('utf8')
  const match = header.match(/Content-Length:\s*(\d+)/i)
  if (!match?.[1]) return undefined
  const length = Number(match[1])
  const start = headerEnd + 4
  if (buffer.length < start + length) return undefined
  const message: unknown = JSON.parse(buffer.subarray(start, start + length).toString('utf8'))
  return { message, rest: buffer.subarray(start + length) }
}

export type StdioFraming = 'line' | 'content-length'

/**
 * MCP 官方 stdio 传输用换行分隔 JSON；早期版本和部分客户端用 Content-Length。
 * 这里两种都收，回包沿用请求的帧格式。
 */
export function takeStdioMessage(buffer: Buffer): { message: unknown; framing: StdioFraming; rest: Buffer } | undefined {
  let start = 0
  while (start < buffer.length && (buffer[start] === 0x0a || buffer[start] === 0x0d)) start += 1
  if (start > 0) {
    const parsed = takeStdioMessage(buffer.subarray(start))
    return parsed
  }
  const prefix = buffer.subarray(0, 15).toString('latin1')
  if (/^content-length:/i.test(prefix)) {
    const frame = takeFrame(buffer)
    if (!frame) return undefined
    return { message: frame.message, framing: 'content-length', rest: frame.rest }
  }
  const newline = buffer.indexOf(0x0a)
  if (newline < 0) return undefined
  const line = buffer.subarray(0, newline).toString('utf8').replace(/\r$/, '')
  const rest = buffer.subarray(newline + 1)
  if (!line.trim()) return takeStdioMessage(rest)
  const message: unknown = JSON.parse(line)
  return { message, framing: 'line', rest }
}

/** 没有 id 的通知不回复。工具调用转成平台已经把关的结果。 */
export async function handleMcpMessage(message: unknown, deps: McpDeps): Promise<Record<string, unknown> | undefined> {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return rpcError(null, -32600, 'Invalid Request')
  }
  const record = message as Record<string, unknown>
  const hasId = record.id !== undefined && record.id !== null
  if (!hasId) return undefined
  const method = typeof record.method === 'string' ? record.method : ''
  try {
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id: record.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'aiops-harness', version: '0.1.0' },
        },
      }
    }
    if (method === 'ping') return { jsonrpc: '2.0', id: record.id, result: {} }
    if (method === 'tools/list') {
      const tools = await deps.listTools()
      return {
        jsonrpc: '2.0',
        id: record.id,
        result: {
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.parameters,
          })),
        },
      }
    }
    if (method === 'tools/call') {
      const params = asRecord(record.params) ?? {}
      const name = typeof params.name === 'string' ? params.name : ''
      const args = asRecord(params.arguments) ?? {}
      const result = await deps.callTool(name, args)
      return {
        jsonrpc: '2.0',
        id: record.id,
        result: { content: [{ type: 'text', text: result.text }], isError: result.isError },
      }
    }
    return rpcError(record.id, -32601, `Method not found: ${method}`)
  } catch (error) {
    return rpcError(record.id, -32000, error instanceof Error ? error.message : 'MCP 调用失败')
  }
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}
