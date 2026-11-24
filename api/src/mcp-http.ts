import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createAgentSession, type AgentSession, type AgentToolApi } from '../../extensions/mcp/src/agent.ts'
import { handleMcpMessage } from '../../extensions/mcp/src/protocol.ts'
import type { Platform } from './platform.ts'

/**
 * 远程 DSH 接入：把 stdio 代理同一套 Agent 工具包成 MCP Streamable HTTP。
 * 认证由 http.ts 统一完成（API key 或网页会话），这里只按会话隔离任务上下文。
 */
const SESSION_TTL_MS = 30 * 60_000
const MAX_SESSIONS = 100
const MAX_BODY_BYTES = 1_000_000

interface SessionEntry {
  actorId: string
  session: AgentSession
  lastSeen: number
}

export interface McpEndpoint {
  handle(input: { req: IncomingMessage; res: ServerResponse; actorId: string }): Promise<void>
  close(): void
}

export function createMcpEndpoint(platform: Platform): McpEndpoint {
  const sessions = new Map<string, SessionEntry>()
  const cleanup = () => {
    const cutoff = Date.now() - SESSION_TTL_MS
    for (const [id, entry] of sessions) {
      if (entry.lastSeen < cutoff) {
        void entry.session.dispose()
        sessions.delete(id)
      }
    }
  }
  const timer = setInterval(cleanup, 60_000)
  timer.unref?.()

  function prune(): void {
    if (sessions.size <= MAX_SESSIONS) return
    const oldest = [...sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)
    while (sessions.size > MAX_SESSIONS && oldest.length > 0) {
      const entry = oldest.shift()
      if (!entry) break
      void entry[1].session.dispose()
      sessions.delete(entry[0])
    }
  }

  async function handle(input: { req: IncomingMessage; res: ServerResponse; actorId: string }): Promise<void> {
    const { req, res, actorId } = input
    const method = req.method ?? 'POST'
    if (method === 'DELETE') {
      const id = header(req, 'mcp-session-id')
      const entry = id ? sessions.get(id) : undefined
      if (entry && entry.actorId === actorId) {
        await entry.session.dispose()
        sessions.delete(id!)
      }
      res.writeHead(204)
      res.end()
      return
    }
    if (method !== 'POST') {
      res.writeHead(405, { allow: 'POST, DELETE' })
      res.end()
      return
    }

    let message: unknown
    try {
      message = JSON.parse(await readBody(req))
    } catch (error) {
      sendRpcError(res, 400, null, -32700, error instanceof Error ? error.message : 'Parse error')
      return
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      sendRpcError(res, 400, null, -32600, 'MCP 只接受单个 JSON-RPC 对象')
      return
    }
    const record = message as Record<string, unknown>
    const sessionId = header(req, 'mcp-session-id')

    if (record.method === 'initialize') {
      const id = randomUUID()
      const entry: SessionEntry = {
        actorId,
        session: createAgentSession(platformApi(platform, actorId), { sessionId: `mcp:${id}` }),
        lastSeen: Date.now(),
      }
      sessions.set(id, entry)
      prune()
      res.setHeader('mcp-session-id', id)
      const response = await handleMcpMessage(message, entry.session)
      sendRpc(
        res,
        response ?? { jsonrpc: '2.0', id: record.id ?? null, error: { code: -32600, message: 'initialize 没有响应' } },
      )
      return
    }

    if (!sessionId) {
      sendRpcError(res, 400, record.id ?? null, -32000, '缺少 Mcp-Session-Id，先发 initialize')
      return
    }
    const entry = sessions.get(sessionId)
    if (!entry) {
      sendRpcError(res, 404, record.id ?? null, -32000, 'MCP 会话不存在或已过期，请重新 initialize')
      return
    }
    if (entry.actorId !== actorId) {
      sendRpcError(res, 403, record.id ?? null, -32000, 'MCP 会话身份不一致')
      return
    }
    entry.lastSeen = Date.now()
    const response = await handleMcpMessage(message, entry.session)
    if (!response) {
      // 客户端通知没有响应体。
      res.writeHead(202)
      res.end()
      return
    }
    sendRpc(res, response)
  }

  return {
    handle,
    close() {
      clearInterval(timer)
      for (const entry of sessions.values()) void entry.session.dispose()
      sessions.clear()
    },
  }
}

function platformApi(platform: Platform, actorId: string): AgentToolApi {
  return {
    listTools: async () => platform.listTools(actorId),
    createTask: async (input) => ({
      task: await platform.createAgentTask(actorId, {
        prompt: input.prompt,
        title: input.title,
        skill: input.skill,
        sessionId: input.sessionId,
      }),
    }),
    finishTask: async (taskId, input) => ({
      task: await platform.finishAgentTask(actorId, taskId, {
        status: input.status,
        result: input.result,
        error: input.error,
      }),
    }),
    getTask: async (taskId) => {
      const [task, events, audit, approvals] = await Promise.all([
        platform.getTask(actorId, taskId),
        platform.listEvents(actorId, taskId),
        platform.listAudit(actorId, taskId),
        platform.listApprovals(actorId, undefined, taskId),
      ])
      return {
        task,
        events: events.slice(-100),
        eventsTotal: events.length,
        audit: audit.slice(-100),
        auditTotal: audit.length,
        approvals,
      }
    },
    cancelTask: async (taskId, input) => ({
      task: await platform.cancel(actorId, taskId, { force: input.force === true }),
    }),
    listApprovals: async (status) => {
      const approvals = await platform.listApprovals(actorId, status)
      return { approvals, total: approvals.length }
    },
    getApproval: async (approvalId) => ({ approval: await platform.getApproval(actorId, approvalId) }),
    resumeApproval: (approvalId) => platform.resumeApproval(actorId, approvalId),
    executeTool: (input) =>
      platform.executeTool({
        actorId,
        tool: input.tool,
        args: input.args ?? {},
        ...(input.taskId ? { taskId: input.taskId } : {}),
      }),
  }
}

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name]
  return typeof value === 'string' ? value.trim() : ''
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体超过 1MB'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendRpc(res: ServerResponse, payload: Record<string, unknown>): void {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
  res.end(JSON.stringify(payload))
}

function sendRpcError(res: ServerResponse, status: number, id: unknown, code: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
  res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }))
}