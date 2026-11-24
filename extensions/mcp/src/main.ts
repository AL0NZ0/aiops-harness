import { createAgentSession, toolsSignature, type AgentToolApi } from './agent.ts'
import { handleMcpMessage, takeStdioMessage, type McpToolInfo, type StdioFraming } from './protocol.ts'

const api = (process.env.AIOPS_API ?? 'http://127.0.0.1:8787').replace(/\/$/, '')
const actor = process.env.AIOPS_ACTOR ?? 'alice'
const token = process.env.AIOPS_INTERNAL_TOKEN ?? ''
/** 账号模式优先用 API key；x-actor-id + internal token 仅用于本机 header 模式。 */
const apiToken = process.env.AIOPS_API_TOKEN ?? ''

function baseHeaders(): Record<string, string> {
  return apiToken ? { authorization: `Bearer ${apiToken}` } : { 'x-actor-id': actor }
}

let lastToolsSignature = ''

async function loadPlatformTools(): Promise<McpToolInfo[]> {
  const response = await fetch(`${api}/api/tools`, { headers: baseHeaders() })
  const body = (await response.json()) as { tools?: McpToolInfo[]; error?: { message?: string } }
  if (!response.ok) throw new Error(body.error?.message ?? `工具列表失败 ${response.status}`)
  return body.tools ?? []
}

const agentApi: AgentToolApi = {
  listTools: loadPlatformTools,
  createTask: (input) =>
    request('/api/agent/tasks', {
      method: 'POST',
      internal: true,
      body: {
        prompt: input.prompt,
        ...(input.title ? { title: input.title } : {}),
        ...(input.skill ? { skill: input.skill } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      },
    }),
  finishTask: (taskId, input) =>
    request(`/api/agent/tasks/${encodeURIComponent(taskId)}/finish`, {
      method: 'POST',
      internal: true,
      body: {
        status: input.status,
        ...(input.result ? { result: input.result } : {}),
        ...(input.error ? { error: input.error } : {}),
      },
    }),
  getTask: async (taskId) => {
    const encoded = encodeURIComponent(taskId)
    const [task, events, audit, approvals] = await Promise.all([
      request(`/api/tasks/${encoded}`),
      request(`/api/tasks/${encoded}/events?limit=100`),
      request(`/api/tasks/${encoded}/audit?limit=100`),
      request(`/api/approvals?taskId=${encoded}&limit=50`),
    ])
    return {
      task: asRecord(task)?.task,
      events: asRecord(events)?.events,
      eventsTotal: asRecord(events)?.total,
      audit: asRecord(audit)?.audit,
      auditTotal: asRecord(audit)?.total,
      approvals: asRecord(approvals)?.approvals,
    }
  },
  cancelTask: (taskId, input) =>
    request(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, {
      method: 'POST',
      body: { force: input.force === true },
    }),
  listApprovals: (status) => request(`/api/approvals${status ? `?status=${encodeURIComponent(status)}` : ''}`),
  getApproval: (approvalId) => request(`/api/approvals/${encodeURIComponent(approvalId)}`),
  resumeApproval: (approvalId) =>
    request(`/api/approvals/${encodeURIComponent(approvalId)}/resume`, { method: 'POST', internal: true }),
  executeTool: (input) =>
    request('/api/tool-calls', {
      method: 'POST',
      internal: true,
      body: {
        tool: input.tool,
        args: input.args ?? {},
        ...(input.taskId ? { taskId: input.taskId } : {}),
      },
    }),
}

const session = createAgentSession(agentApi)

async function listTools(): Promise<McpToolInfo[]> {
  const tools = await session.listTools()
  lastToolsSignature = toolsSignature(tools)
  return tools
}

async function callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  if (!apiToken && !token) return { text: '未设置 AIOPS_API_TOKEN 或 AIOPS_INTERNAL_TOKEN', isError: true }
  return session.callTool(name, args)
}

async function watchToolChanges(): Promise<void> {
  try {
    const tools = await session.listTools()
    const signature = toolsSignature(tools)
    if (signature === lastToolsSignature) return
    const wasKnown = lastToolsSignature !== ''
    lastToolsSignature = signature
    if (wasKnown) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }) + '\n')
    }
  } catch {
    // 平台暂时不可用时保持上一次工具集，下一轮再比较。
  }
}

async function request(
  pathname: string,
  options: { method?: string; body?: unknown; internal?: boolean } = {},
): Promise<unknown> {
  const headers: Record<string, string> = baseHeaders()
  if (options.internal && !apiToken) {
    if (!token) throw new Error('未设置 AIOPS_API_TOKEN 或 AIOPS_INTERNAL_TOKEN')
    headers['x-internal-token'] = token
  }
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(`${api}${pathname}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const text = await response.text()
  let body: unknown = {}
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = { raw: text }
    }
  }
  if (!response.ok) throw new Error(messageOf(body) ?? `平台请求失败 ${response.status}`)
  return body
}

function messageOf(body: unknown): string | undefined {
  const record = asRecord(body)
  const error = asRecord(record?.error)
  if (typeof error?.message === 'string') return error.message
  if (typeof record?.reason === 'string') return record.reason
  return undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

async function serve(): Promise<void> {
  console.error(`aiops mcp proxy -> ${api} actor=${actor}`)
  let buffer = Buffer.alloc(0)
  for await (const chunk of process.stdin) {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
    for (;;) {
      let parsed: ReturnType<typeof takeStdioMessage>
      try {
        parsed = takeStdioMessage(buffer)
      } catch (error) {
        process.stdout.write(encode({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: error instanceof Error ? error.message : 'Parse error' },
        }, 'line'))
        const newline = buffer.indexOf(0x0a)
        buffer = newline >= 0 ? Buffer.from(buffer.subarray(newline + 1)) : Buffer.alloc(0)
        continue
      }
      if (!parsed) break
      buffer = Buffer.from(parsed.rest)
      let response: Record<string, unknown> | undefined
      try {
        response = await handleMcpMessage(parsed.message, { listTools, callTool })
      } catch (error) {
        response = {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: error instanceof Error ? error.message : 'Parse error' },
        }
      }
      if (response) process.stdout.write(encode(response, parsed.framing))
    }
  }
}

function encode(payload: unknown, framing: StdioFraming): Buffer {
  const json = Buffer.from(JSON.stringify(payload))
  if (framing === 'line') return Buffer.concat([json, Buffer.from('\n')])
  return Buffer.concat([Buffer.from(`Content-Length: ${json.length}\r\n\r\n`), json])
}

setInterval(() => {
  void watchToolChanges()
}, 3_000).unref?.()

await serve()