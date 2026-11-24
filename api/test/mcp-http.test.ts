import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import { test } from 'node:test'
import path from 'node:path'
import { LocalKnowledgeProvider } from '../../extensions/knowledge/src/index.ts'
import { AssetStore } from '../src/assets.ts'
import { CredentialStore } from '../src/credentials.ts'
import { createServer } from '../src/http.ts'
import { McpServerStore } from '../src/mcp-servers.ts'
import { Platform } from '../src/platform.ts'
import { loadSkills } from '../src/skills.ts'
import { MemoryStore } from '../src/store.ts'
import type { Actor, Tool } from '../src/types.ts'

const actors: Actor[] = [
  { id: 'alice', name: 'Alice', roles: ['operator'] },
  { id: 'bob', name: 'Bob', roles: ['approver'] },
]

async function boot() {
  const skills = await loadSkills(path.resolve('extensions/aiops-skills'))
  const tools: Tool[] = [
    {
      name: 'demo.list_pods',
      description: '测试用 Pod 列表',
      risk: 'read',
      parameters: { type: 'object' },
      async execute() {
        return { pods: [{ namespace: 'shop', name: 'checkout-api' }] }
      },
    },
    {
      name: 'demo.restart',
      description: '测试用重启工作负载',
      risk: 'mutate',
      parameters: { type: 'object' },
      async execute() {
        return { restarted: true }
      },
    },
  ]
  const platform = new Platform({
    actors,
    skills,
    knowledge: new LocalKnowledgeProvider(path.resolve('extensions/knowledge/fixtures')),
    mcpStore: new McpServerStore(null, []),
    assets: new AssetStore(null),
    credentials: new CredentialStore(null),
    store: new MemoryStore(),
    tools,
  })
  const server = createServer(platform, { internalToken: 'test-token' })
  const port = await listen(server)
  return {
    platform,
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  }
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('没有端口')
      resolve(address.port)
    })
  })
}

async function rpc(
  base: string,
  body: Record<string, unknown>,
  sessionId?: string,
): Promise<{ status: number; session?: string; body: Record<string, unknown> }> {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-actor-id': 'alice',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return {
    status: response.status,
    session: response.headers.get('mcp-session-id') ?? undefined,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  }
}

test('远程 MCP：initialize 分配会话，任务、只读和变更工具走同一套审批', async () => {
  const ctx = await boot()
  try {
    const init = await rpc(ctx.base, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'dsh', version: '0.2' } },
    })
    assert.equal(init.status, 200)
    assert.ok(init.session)
    assert.equal((init.body.result as { serverInfo: { name: string } }).serverInfo.name, 'aiops-harness')

    const list = await rpc(ctx.base, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, init.session)
    const names = (list.body.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)
    assert.ok(names.includes('task.create'))
    assert.ok(names.includes('demo.list_pods'))
    assert.ok(names.includes('demo.restart'))

    const created = await rpc(
      ctx.base,
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'task.create', arguments: { prompt: '排查 checkout-api' } },
      },
      init.session,
    )
    const taskBody = JSON.parse((created.body.result as { content: Array<{ text: string }> }).content[0]!.text) as {
      task: { id: string }
    }
    assert.ok(taskBody.task.id)

    const read = await rpc(
      ctx.base,
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'demo.list_pods', arguments: {} },
      },
      init.session,
    )
    assert.equal((read.body.result as { isError: boolean }).isError, false)
    assert.match((read.body.result as { content: Array<{ text: string }> }).content[0]!.text, /checkout-api/)

    const mutate = await rpc(
      ctx.base,
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'demo.restart', arguments: { namespace: 'shop' } },
      },
      init.session,
    )
    const mutateText = (mutate.body.result as { content: Array<{ text: string }> }).content[0]!.text
    assert.match(mutateText, /awaiting_approval/)
    assert.match(mutateText, /人工审批/)
    const approvals = await ctx.platform.listApprovals('alice')
    assert.equal(approvals.length, 1)
    assert.equal(approvals[0]?.status, 'pending')
    assert.equal(approvals[0]?.taskId, taskBody.task.id)
    // 工具没有直接执行。
    const task = await ctx.platform.getTask('alice', taskBody.task.id)
    assert.equal(task.status, 'awaiting_approval')
  } finally {
    await ctx.close()
  }
})

test('远程 MCP：无会话、过期会话、GET 和 DELETE 的行为', async () => {
  const ctx = await boot()
  try {
    const noSession = await rpc(ctx.base, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    assert.equal(noSession.status, 400)
    assert.match(String((noSession.body.error as { message: string }).message), /Mcp-Session-Id/)

    const unknown = await rpc(ctx.base, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, 'missing-session')
    assert.equal(unknown.status, 404)

    const get = await fetch(`${ctx.base}/mcp`, { headers: { 'x-actor-id': 'alice' } })
    assert.equal(get.status, 405)

    const init = await rpc(ctx.base, { jsonrpc: '2.0', id: 3, method: 'initialize', params: {} })
    const session = init.session!
    const removed = await fetch(`${ctx.base}/mcp`, {
      method: 'DELETE',
      headers: { 'x-actor-id': 'alice', 'mcp-session-id': session },
    })
    assert.equal(removed.status, 204)
    const after = await rpc(ctx.base, { jsonrpc: '2.0', id: 4, method: 'tools/list' }, session)
    assert.equal(after.status, 404)

    // 通知没有 id，返回 202。
    const init2 = await rpc(ctx.base, { jsonrpc: '2.0', id: 5, method: 'initialize', params: {} })
    const notify = await fetch(`${ctx.base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-actor-id': 'alice',
        'mcp-session-id': init2.session!,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    })
    assert.equal(notify.status, 202)
  } finally {
    await ctx.close()
  }
})

test('远程 MCP：DELETE 会话时自动任务一并收尾', async () => {
  const ctx = await boot()
  try {
    const init = await rpc(ctx.base, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    const session = init.session!
    const call = await rpc(
      ctx.base,
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'demo.list_pods', arguments: {} } },
      session,
    )
    assert.equal((call.body.result as { isError: boolean }).isError, false)
    const tasks = await ctx.platform.listTasks('alice', { origin: 'dsh' })
    assert.equal(tasks.length, 1)
    assert.equal(tasks[0]?.status, 'running')
    const removed = await fetch(`${ctx.base}/mcp`, {
      method: 'DELETE',
      headers: { 'x-actor-id': 'alice', 'mcp-session-id': session },
    })
    assert.equal(removed.status, 204)
    const finished = await ctx.platform.getTask('alice', tasks[0]!.id)
    assert.equal(finished.status, 'succeeded')
    assert.match(finished.result ?? '', /会话空闲/)
  } finally {
    await ctx.close()
  }
})
