import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer as createNodeServer, type Server } from 'node:http'
import { test } from 'node:test'
import os from 'node:os'
import path from 'node:path'
import { LocalKnowledgeProvider } from '../../extensions/knowledge/src/index.ts'
import { createUpstreamMcpTools, type McpServerConfig } from '../../extensions/ops-tools/src/index.ts'
import { AssetStore } from '../src/assets.ts'
import { createAssetTools } from '../src/asset-tools.ts'
import { CredentialStore } from '../src/credentials.ts'
import { McpServerStore } from '../src/mcp-servers.ts'
import { createSshTools } from '../src/ssh-tools.ts'
import { createServer } from '../src/http.ts'
import { createKnowledgeTools } from '../src/knowledge-tools.ts'
import { Platform, type ModelResolver } from '../src/platform.ts'
import type { ChatModel } from '../src/model.ts'
import { ModelProviderStore, ModelRegistry } from '../src/model-providers.ts'
import { SecretBox } from '../src/secret-box.ts'
import { ToolBroker } from '../src/broker.ts'
import { MemoryStore } from '../src/store.ts'
import { loadSkills } from '../src/skills.ts'
import type { Actor, Approval, Task, Tool } from '../src/types.ts'
import { compose } from '../src/compose.ts'

const actors: Actor[] = [
  { id: 'alice', name: 'Alice', roles: ['operator'] },
  { id: 'bob', name: 'Bob', roles: ['approver'] },
  { id: 'dana', name: 'Dana', roles: ['approver'] },
  { id: 'carol', name: 'Carol', roles: ['viewer'] },
  { id: 'eve', name: 'Eve', roles: ['auditor'] },
  { id: 'root', name: 'Root', roles: ['admin'] },
]

const skillsDir = path.resolve('extensions/aiops-skills')
const knowledgeRoot = path.resolve('extensions/knowledge/fixtures')

async function boot(options: {
  model?: ChatModel
  modelResolver?: ModelResolver
  modelProviders?: ModelProviderStore
  models?: ModelRegistry
  instanceId?: string
  approvalPollMs?: number
} = {}) {
  const world = {
    pods: [
      { namespace: 'shop', name: 'checkout-api-7d9c', workload: 'checkout-api', ready: false, restarts: 14 },
      { namespace: 'shop', name: 'payments-api-5b2a', workload: 'payments-api', ready: true, restarts: 0 },
    ],
  }
  const knowledge = new LocalKnowledgeProvider(knowledgeRoot)
  const assets = new AssetStore(null)
  const credentials = new CredentialStore(null)
  const mcpStore = new McpServerStore(null, [])
  const baseSkills = await loadSkills(skillsDir)
  const skills = [
    {
      name: 'restart-demo',
      description: '测试用重启技能，仅用于验证审批链',
      body: '',
      priority: -1,
      keywords: ['重启', 'restart'],
      steps: [{ tool: 'demo.restart', args: { namespace: 'shop', name: 'checkout-api' } }],
    },
    ...baseSkills,
  ]
  const demoTools: Tool[] = [
    {
      name: 'demo.list_pods',
      description: '测试用 Pod 列表',
      risk: 'read',
      parameters: { type: 'object' },
      async execute() {
        return { pods: world.pods.map((pod) => ({ ...pod })) }
      },
    },
    {
      name: 'demo.restart',
      description: '测试用重启工作负载',
      risk: 'mutate',
      parameters: { type: 'object' },
      async validate(args) {
        if (typeof args.name !== 'string' || !args.name) throw new Error('name 必填')
      },
      async execute(args) {
        const pod = world.pods.find((item) => item.workload === args.name)
        if (!pod) throw new Error(`没有工作负载 ${String(args.name)}`)
        pod.ready = true
        pod.restarts += 1
        return { restarted: true, namespace: pod.namespace, name: pod.workload }
      },
    },
  ]
  const baseTools = [
    ...createKnowledgeTools(knowledge),
    ...createAssetTools(assets),
    ...createSshTools(assets, credentials),
    ...demoTools,
  ]
  const buildTools = async (mcpServers?: McpServerConfig[], tolerateFailures = true) => {
    const upstream = await createUpstreamMcpTools({
      servers: mcpServers ?? (await mcpStore.list()),
      tolerateFailures,
    })
    return {
      tools: [...baseTools, ...upstream.tools],
      mcpErrors: upstream.errors,
    }
  }
  const buildServerTools = async (server: McpServerConfig) => {
    const upstream = await createUpstreamMcpTools({ servers: [server] })
    return { tools: upstream.tools, close: upstream.close }
  }
  const startup = await buildTools()
  const store = new MemoryStore()
  const platform = new Platform({
    actors,
    skills,
    knowledge,
    mcpStore,
    assets,
    credentials,
    store,
    tools: startup.tools,
    mcpErrors: startup.mcpErrors,
    rebuildTools: buildTools,
    buildServerTools,
    ...(options.model ? { model: options.model } : {}),
    ...(options.modelResolver ? { modelResolver: options.modelResolver } : {}),
    ...(options.instanceId ? { instanceId: options.instanceId } : {}),
    ...(options.approvalPollMs !== undefined ? { approvalPollMs: options.approvalPollMs } : {}),
  })
  const server = createServer(platform, {
    internalToken: 'test-token',
    ...(options.modelProviders ? { modelProviders: options.modelProviders } : {}),
    ...(options.models ? { models: options.models } : {}),
  })
  const port = await listen(server)
  return {
    platform,
    world,
    store,
    base: `http://127.0.0.1:${port}`,
    close: () => close(server),
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

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

async function api(base: string, actor: string, method: string, pathname: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      'x-actor-id': actor,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, any> : {} }
}

/** 按顺序返回预设响应，用来验证平台模型循环而不访问真实模型。 */
function scriptedModel(...steps: Array<{ content: string; calls?: Array<{ name: string; args: string }> }>): ChatModel {
  let index = 0
  return {
    async complete() {
      const step = steps[index]
      index += 1
      if (!step) throw new Error('测试模型脚本已用尽')
      return {
        content: step.content,
        toolCalls: (step.calls ?? []).map((call, callIndex) => ({
          id: `call_${index}_${callIndex}`,
          type: 'function' as const,
          function: { name: call.name, arguments: call.args },
        })),
      }
    },
  }
}

test('只读排查会带回知识来源、集群证据和负责人', async () => {
  const ctx = await boot()
  try {
    const created = await api(ctx.base, 'alice', 'POST', '/api/tasks', { prompt: '排查 checkout-api CrashLoopBackOff' })
    assert.equal(created.status, 201)
    assert.equal(created.body.task.skill, 'k8s-troubleshooting')
    const task = await ctx.platform.waitUntil(created.body.task.id, (item) => item.status === 'succeeded')
    assert.match(task.result ?? '', /checkout-api CrashLoopBackOff 来源 wiki\/runbooks\/checkout\.md/)
    assert.doesNotMatch(task.result ?? '', /已重启/)
    const events = await api(ctx.base, 'alice', 'GET', `/api/tasks/${task.id}/events`)
    assert.equal(events.body.events.at(-1).type, 'task.completed')
  } finally {
    await ctx.close()
  }
})

test('本地知识文档可以保存、列出、删除并检索', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aiops-knowledge-'))
  try {
    const provider = new LocalKnowledgeProvider(dir)
    await provider.saveDocument({
      id: 'runbook-1',
      title: 'CPU 限流',
      source: 'wiki/cpu.md',
      content: 'CPU throttling 处理办法',
      actors: ['alice'],
    })
    const docs = await provider.listDocuments()
    assert.equal(docs.length, 1)
    assert.equal(docs[0]?.docId, 'runbook-1')
    assert.equal((await provider.search('throttling', 5, 'alice'))[0]?.docId, 'runbook-1')
    assert.equal((await provider.search('throttling', 5, 'bob')).length, 0)
    assert.equal(await provider.deleteDocument('runbook-1'), true)
    assert.equal((await provider.listDocuments()).length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('本地资产可以页面管理并被资产工具读取', async () => {
  const ctx = await boot()
  try {
    const saved = await api(ctx.base, 'alice', 'POST', '/api/assets', {
      name: 'web-01',
      owner: 'ops-team',
      tier: 'prod',
      host: 'web-01',
      ip: '10.0.0.5',
      env: 'prod',
    })
    assert.equal(saved.status, 200)
    assert.equal(saved.body.asset.name, 'web-01')
    const list = await api(ctx.base, 'carol', 'GET', '/api/assets')
    assert.ok(list.body.assets.some((item: { name: string; host: string }) => item.name === 'web-01' && item.host === 'web-01'))
    const got = await api(ctx.base, 'alice', 'POST', '/api/tool-calls', {
      tool: 'asset.get',
      args: { name: 'web-01' },
    }, { 'x-internal-token': 'test-token' })
    assert.equal(got.body.status, 'ok')
    assert.equal(got.body.result.asset.ip, '10.0.0.5')
    assert.equal((await api(ctx.base, 'carol', 'POST', '/api/assets', { name: 'nope' })).status, 403)
    assert.equal((await api(ctx.base, 'alice', 'DELETE', '/api/assets/web-01')).body.deleted, true)
  } finally {
    await ctx.close()
  }
})

test('MCP 配置可以在线校验和保存', async () => {
  const ctx = await boot()
  try {
    assert.equal((await api(ctx.base, 'carol', 'GET', '/api/mcp-servers')).status, 403)
    const server = {
      name: 'probe',
      system: 'prometheus',
      url: 'http://127.0.0.1:1/mcp',
      readOnly: true,
    }
    // 不可达的 server 不能落盘。
    assert.equal((await api(ctx.base, 'root', 'POST', '/api/mcp-servers', { servers: [server] })).status, 502)
    assert.equal((await api(ctx.base, 'alice', 'GET', '/api/mcp-servers')).body.servers.length, 0)
    assert.equal((await api(ctx.base, 'alice', 'POST', '/api/mcp-servers', {
      servers: [server, server],
    })).status, 400)
    assert.equal((await api(ctx.base, 'alice', 'POST', '/api/mcp-servers', {
      servers: [{ ...server, url: 'ftp://127.0.0.1/mcp' }],
    })).status, 400)
    assert.equal((await api(ctx.base, 'alice', 'POST', '/api/mcp-servers', {
      servers: [{ ...server, extra: true }],
    })).status, 400)
    assert.equal((await api(ctx.base, 'alice', 'POST', '/api/mcp-servers', {
      servers: 'not-an-array',
    })).status, 400)
  } finally {
    await ctx.close()
  }
})

test('MCP 配置先探测后落盘，失败时保留旧配置和旧工具', async () => {
  const mock = await startMcpMock()
  const ctx = await boot()
  try {
    const good = { name: 'probe', system: 'prometheus', url: mock.url, readOnly: true }
    const saved = await api(ctx.base, 'root', 'POST', '/api/mcp-servers', { servers: [good] })
    assert.equal(saved.status, 200)
    const toolsAfterSave = (await api(ctx.base, 'alice', 'GET', '/api/tools')).body.tools.map((item: { name: string }) => item.name)
    assert.ok(toolsAfterSave.includes('mcp.probe.echo'))

    const dead = { ...good, url: 'http://127.0.0.1:1/mcp' }
    const failed = await api(ctx.base, 'alice', 'POST', '/api/mcp-servers', { servers: [dead] })
    assert.equal(failed.status, 502)
    assert.match(failed.body.error.message, /未保存/)

    const list = await api(ctx.base, 'alice', 'GET', '/api/mcp-servers')
    assert.equal(list.body.servers.length, 1)
    assert.equal(list.body.servers[0].url, mock.url)
    const toolsAfterFail = (await api(ctx.base, 'alice', 'GET', '/api/tools')).body.tools.map((item: { name: string }) => item.name)
    assert.ok(toolsAfterFail.includes('mcp.probe.echo'))
  } finally {
    await ctx.close()
    await mock.close()
  }
})

test('MCP headers 不回显，空值保留原值，clearHeaders 显式删除', async () => {
  process.env.AIOPS_TEST_MCP_TOKEN = 'test-token'
  const mock = await startMcpMock({ requireAuth: 'Bearer test-token' })
  const ctx = await boot()
  try {
    const server = {
      name: 'probe',
      system: 'prometheus',
      url: mock.url,
      readOnly: true,
      headers: { Authorization: 'Bearer ${AIOPS_TEST_MCP_TOKEN}', 'X-Trace': 'trace-123' },
    }
    const saved = await api(ctx.base, 'root', 'POST', '/api/mcp-servers', { servers: [server] })
    assert.equal(saved.status, 200)
    assert.deepEqual(saved.body.servers[0].headerNames.sort(), ['Authorization', 'X-Trace'])
    assert.deepEqual(saved.body.servers[0].headers, { Authorization: '', 'X-Trace': '' })
    assert.equal(JSON.stringify(saved.body).includes('test-token'), false)
    assert.equal(JSON.stringify(saved.body).includes('trace-123'), false)
    assert.ok(mock.seenAuth.every((value) => value === 'Bearer test-token'))

    // 页面原样提交掩码值：空值表示保留，探测仍能通过。
    const list = await api(ctx.base, 'alice', 'GET', '/api/mcp-servers')
    assert.deepEqual(list.body.servers[0].headers, { Authorization: '', 'X-Trace': '' })
    assert.equal((await api(ctx.base, 'alice', 'POST', '/api/mcp-servers', { servers: list.body.servers })).status, 200)

    // 显式删除一个 header；Authorization 保留，探测继续通过。
    const cleared = await api(ctx.base, 'alice', 'POST', '/api/mcp-servers', {
      servers: [{ ...list.body.servers[0], clearHeaders: ['X-Trace'] }],
    })
    assert.equal(cleared.status, 200)
    assert.deepEqual(cleared.body.servers[0].headerNames, ['Authorization'])

    // clearHeaders=true 会删掉认证，探测失败返回 502，旧配置和旧 header 保持不动。
    const denied = await api(ctx.base, 'alice', 'POST', '/api/mcp-servers', {
      servers: [{ ...list.body.servers[0], clearHeaders: true }],
    })
    assert.equal(denied.status, 502)
    const kept = await api(ctx.base, 'alice', 'GET', '/api/mcp-servers')
    assert.deepEqual(kept.body.servers[0].headerNames, ['Authorization'])
  } finally {
    delete process.env.AIOPS_TEST_MCP_TOKEN
    await ctx.close()
    await mock.close()
  }
})

test('后台健康巡检：连续失败三次摘除工具，恢复后自动注册', async () => {
  const mock = await startMcpMock()
  const ctx = await boot()
  try {
    const server = { name: 'probe', system: 'prometheus', url: mock.url, readOnly: true }
    assert.equal((await api(ctx.base, 'root', 'POST', '/api/mcp-servers', { servers: [server] })).status, 200)
    const toolNames = async () => (await api(ctx.base, 'alice', 'GET', '/api/tools')).body.tools.map((item: { name: string }) => item.name)

    const first = await api(ctx.base, 'alice', 'POST', '/api/mcp-servers/health')
    assert.equal(first.status, 200)
    assert.deepEqual(first.body.health.map((item: { name: string; ok: boolean }) => [item.name, item.ok]), [['probe', true]])
    assert.ok((await toolNames()).includes('mcp.probe.echo'))

    mock.setFail(true)
    for (let i = 0; i < 2; i += 1) {
      const result = await api(ctx.base, 'alice', 'POST', '/api/mcp-servers/health')
      assert.equal(result.body.health[0].ok, true)
      assert.equal(result.body.health[0].failures, i + 1)
    }
    // 未到阈值：工具保留，避免一次抖动就下线。
    assert.ok((await toolNames()).includes('mcp.probe.echo'))

    const dropped = await api(ctx.base, 'alice', 'POST', '/api/mcp-servers/health')
    assert.equal(dropped.body.health[0].ok, false)
    assert.equal(dropped.body.health[0].failures, 3)
    assert.match(dropped.body.health[0].error, /503|upstream down/)
    assert.equal((await toolNames()).includes('mcp.probe.echo'), false)
    const errors = (await api(ctx.base, 'alice', 'GET', '/api/mcp-servers')).body.errors
    assert.equal(errors.length, 1)
    assert.equal(errors[0].name, 'probe')

    mock.setFail(false)
    const recovered = await api(ctx.base, 'alice', 'POST', '/api/mcp-servers/health')
    assert.equal(recovered.body.health[0].ok, true)
    assert.equal(recovered.body.health[0].failures, 0)
    assert.ok((await toolNames()).includes('mcp.probe.echo'))
    assert.equal((await api(ctx.base, 'alice', 'GET', '/api/mcp-servers')).body.errors.length, 0)
  } finally {
    await ctx.close()
    await mock.close()
  }
})

test('上游工具集变化会标记待复核，确认后清除', async () => {
  const mock = await startMcpMock()
  const ctx = await boot()
  try {
    const server = { name: 'probe', system: 'prometheus', url: mock.url, readOnly: true }
    assert.equal((await api(ctx.base, 'root', 'POST', '/api/mcp-servers', { servers: [server] })).status, 200)

    // 首次巡检只建立基线，不把已有工具当成变化。
    const first = await api(ctx.base, 'alice', 'POST', '/api/mcp-servers/health')
    assert.equal(first.body.health[0].reviewRequired, undefined)
    assert.equal(first.body.health[0].changedTools, undefined)

    mock.setTools([{ name: 'echo' }, { name: 'drain', description: 'drain node' }])
    const changed = await api(ctx.base, 'alice', 'POST', '/api/mcp-servers/health')
    assert.equal(changed.body.health[0].ok, true)
    assert.equal(changed.body.health[0].reviewRequired, true)
    assert.deepEqual(changed.body.health[0].changedTools.added, ['mcp.probe.drain'])
    assert.deepEqual(changed.body.health[0].changedTools.removed, [])
    assert.ok((await api(ctx.base, 'alice', 'GET', '/api/tools')).body.tools.some((tool: { name: string }) => tool.name === 'mcp.probe.drain'))

    // 未确认前重复巡检仍保持待复核；查看者不能复核。
    const again = await api(ctx.base, 'alice', 'POST', '/api/mcp-servers/health')
    assert.equal(again.body.health[0].reviewRequired, true)
    assert.deepEqual(again.body.health[0].changedTools.added, ['mcp.probe.drain'])
    // MCP 配置重存会整体重建工具，不能冲掉待复核状态。
    assert.equal((await api(ctx.base, 'alice', 'POST', '/api/mcp-servers', { servers: [server] })).status, 200)
    const afterReload = await api(ctx.base, 'alice', 'GET', '/api/mcp-servers')
    assert.equal(afterReload.body.health[0].reviewRequired, true)
    assert.deepEqual(afterReload.body.health[0].changedTools.added, ['mcp.probe.drain'])
    assert.equal((await api(ctx.base, 'carol', 'POST', '/api/mcp-servers/probe/review')).status, 403)
    assert.equal((await api(ctx.base, 'alice', 'POST', '/api/mcp-servers/nope/review')).status, 404)

    const reviewed = await api(ctx.base, 'alice', 'POST', '/api/mcp-servers/probe/review')
    assert.equal(reviewed.status, 200)
    assert.equal(reviewed.body.health[0].reviewRequired, undefined)
    const stable = await api(ctx.base, 'alice', 'POST', '/api/mcp-servers/health')
    assert.equal(stable.body.health[0].reviewRequired, undefined)

    // 描述变化算 updated；确认后再次变化会重新标记。
    mock.setTools([{ name: 'echo', description: 'echo v2' }, { name: 'drain', description: 'drain node' }])
    const updated = await api(ctx.base, 'alice', 'POST', '/api/mcp-servers/health')
    assert.equal(updated.body.health[0].reviewRequired, true)
    assert.deepEqual(updated.body.health[0].changedTools.updated, ['mcp.probe.echo'])
    assert.deepEqual(updated.body.health[0].changedTools.added, [])

    // 上游改回基线后没有可复核项，标记自动清除。
    mock.setTools([{ name: 'echo', description: 'echo' }, { name: 'drain', description: 'drain node' }])
    const reverted = await api(ctx.base, 'alice', 'POST', '/api/mcp-servers/health')
    assert.equal(reverted.body.health[0].reviewRequired, undefined)
  } finally {
    await ctx.close()
    await mock.close()
  }
})

test('上游 MCP 不可达时平台仍能启动并暴露错误', async () => {
  const store = new MemoryStore()
  const running = await compose('config/platform.json', {
    store,
    mcpServers: [{ name: 'down', system: 'prometheus', url: 'http://127.0.0.1:1/mcp', readOnly: true }],
  })
  try {
    const errors = running.platform.listMcpErrors('alice')
    assert.equal(errors.length, 1)
    assert.equal(errors[0]?.name, 'down')
  } finally {
    await store.close()
  }
})

test('密码私钥凭证独立管理，资产只引用一个凭证', async () => {
  const ctx = await boot()
  try {
    const created = await api(ctx.base, 'alice', 'POST', '/api/credentials', {
      name: 'prod-password',
      type: 'password',
      password: 'secret-pass',
    })
    assert.equal(created.status, 200)
    assert.equal(created.body.credential.hasSecret, true)
    assert.equal('password' in created.body.credential, false)
    const id = created.body.credential.id as string
    const list = await api(ctx.base, 'alice', 'GET', '/api/credentials')
    assert.equal('password' in list.body.credentials[0], false)
    const asset = await api(ctx.base, 'alice', 'POST', '/api/assets', {
      name: 'web-cred',
      ip: '10.0.0.9',
      sshUser: 'ops',
      sshCredentialId: id,
    })
    assert.equal(asset.status, 200)
    assert.equal(asset.body.asset.sshCredentialId, id)
    const both = await api(ctx.base, 'alice', 'POST', '/api/assets', {
      name: 'web-cred',
      ip: '10.0.0.9',
      sshUser: 'ops',
      sshCredentialId: id,
      sshPassword: 'also-a-password',
    })
    assert.equal(both.status, 400)
    assert.equal((await api(ctx.base, 'alice', 'DELETE', `/api/credentials/${id}`)).status, 409)
    await api(ctx.base, 'alice', 'DELETE', '/api/assets/web-cred')
    assert.equal((await api(ctx.base, 'alice', 'DELETE', `/api/credentials/${id}`)).body.deleted, true)
  } finally {
    await ctx.close()
  }
})

test('SSH 工具注册为变更审批，资产凭证不回显', async () => {
  const ctx = await boot()
  try {
    const saved = await api(ctx.base, 'alice', 'POST', '/api/assets', {
      name: 'ssh-01',
      ip: '127.0.0.1',
      sshUser: 'ops',
      sshPort: 2222,
      sshPassword: 'secret-pass',
    })
    assert.equal(saved.status, 200)
    assert.equal(saved.body.asset.hasPassword, true)
    assert.equal('sshPassword' in saved.body.asset, false)
    const list = await api(ctx.base, 'carol', 'GET', '/api/assets')
    assert.equal('sshPassword' in list.body.assets[0], false)
    const got = await api(ctx.base, 'alice', 'POST', '/api/tool-calls', {
      tool: 'asset.get',
      args: { name: 'ssh-01' },
    }, { 'x-internal-token': 'test-token' })
    assert.equal(got.body.result.asset.hasPassword, true)
    assert.equal('sshPassword' in got.body.result.asset, false)
    const tools = await api(ctx.base, 'alice', 'GET', '/api/tools')
    assert.equal(tools.body.tools.find((item: { name: string }) => item.name === 'ssh.exec').risk, 'mutate')
    assert.equal(tools.body.tools.find((item: { name: string }) => item.name === 'ssh.test').risk, 'read')
    const missing = await api(ctx.base, 'alice', 'POST', '/api/tool-calls', {
      tool: 'ssh.exec',
      args: { asset: 'ssh-01' },
    }, { 'x-internal-token': 'test-token' })
    assert.equal(missing.body.status, 'error')
    assert.match(missing.body.error, /command/)
  } finally {
    await ctx.close()
  }
})

test('CPU 技能只报告超阈值的序列', async () => {
  const ctx = await boot()
  try {
    const created = await api(ctx.base, 'alice', 'POST', '/api/tasks', { prompt: 'payments-api CPU 飙高' })
    const task = await ctx.platform.waitUntil(created.body.task.id, (item) => item.status === 'succeeded')
    assert.equal(task.skill, 'monitoring-analysis')
    assert.match(task.result ?? '', /payments-api CPU 升高 来源 wiki\/runbooks\/cpu\.md/)
    assert.doesNotMatch(task.result ?? '', /checkout-api/)
    const stream = await fetch(`${ctx.base}/api/tasks/${task.id}/events?stream=1`, { headers: { 'x-actor-id': 'alice' } })
    const text = await stream.text()
    assert.match(text, /event: task\.completed/)
  } finally {
    await ctx.close()
  }
})

test('诊断故障不会自动重启', async () => {
  const ctx = await boot()
  try {
    const created = await api(ctx.base, 'alice', 'POST', '/api/tasks', { prompt: '诊断 checkout-api 故障' })
    const task = await ctx.platform.waitUntil(created.body.task.id, (item) => item.status === 'succeeded')
    assert.equal(task.skill, 'k8s-troubleshooting')
    const approvals = await api(ctx.base, 'bob', 'GET', '/api/approvals')
    assert.equal(approvals.body.approvals.length, 0)
    assert.equal(ctx.world.pods.find((pod) => pod.workload === 'checkout-api')?.restarts, 14)
  } finally {
    await ctx.close()
  }
})

test('配置模型后平台任务走模型循环，工具结果回填给模型', async () => {
  const model = scriptedModel(
    {
      content: '',
      calls: [{ name: 'demo_list_pods', args: '{"namespace":"shop"}' }],
    },
    {
      content: 'checkout-api 未就绪，证据来自 demo.list_pods。',
    },
  )
  const ctx = await boot({ model })
  try {
    const created = await api(ctx.base, 'alice', 'POST', '/api/tasks', {
      prompt: '诊断 checkout-api 为什么没起来',
    })
    const task = await ctx.platform.waitUntil(created.body.task.id, (item) => item.status === 'succeeded')
    assert.match(task.result ?? '', /checkout-api 未就绪/)
    const events = (await api(ctx.base, 'alice', 'GET', `/api/tasks/${task.id}/events`)).body.events
    const types = events.map((event: { type: string }) => event.type)
    assert.ok(types.includes('model.step'))
    assert.ok(types.includes('tool.called'))
    assert.equal(events.find((event: { type: string }) => event.type === 'task.started')?.data.mode, 'agent')
  } finally {
    await ctx.close()
  }
})

test('模型任务的变更也等审批，通过后继续同一条循环', async () => {
  const model = scriptedModel(
    {
      content: '',
      calls: [{ name: 'demo_restart', args: '{"namespace":"shop","name":"checkout-api"}' }],
    },
    {
      content: '已按审批结果重启 checkout-api。',
    },
  )
  const ctx = await boot({ model })
  try {
    const created = await api(ctx.base, 'alice', 'POST', '/api/tasks', {
      prompt: '请重启 checkout-api',
    })
    const taskId = created.body.task.id as string
    await ctx.platform.waitUntil(taskId, (item) => item.status === 'awaiting_approval')
    assert.equal(ctx.world.pods.find((pod) => pod.workload === 'checkout-api')?.restarts, 14)
    const pending = (await api(ctx.base, 'alice', 'GET', '/api/approvals?status=pending')).body.approvals
    const approvalId = pending.find((item: { taskId: string }) => item.taskId === taskId).id as string
    assert.equal((await api(ctx.base, 'bob', 'POST', `/api/approvals/${approvalId}`, {
      decision: 'approved',
      comment: '窗口内',
    })).status, 200)
    const task = await ctx.platform.waitUntil(taskId, (item) => item.status === 'succeeded')
    assert.match(task.result ?? '', /已按审批结果重启/)
    assert.equal(ctx.world.pods.find((pod) => pod.workload === 'checkout-api')?.restarts, 15)
    const events = (await api(ctx.base, 'alice', 'GET', `/api/tasks/${taskId}/events`)).body.events
    const types = events.map((event: { type: string }) => event.type)
    assert.ok(types.filter((type: string) => type === 'model.step').length >= 2)
  } finally {
    await ctx.close()
  }
})

test('模型 provider 选择会传给解析器，并在任务事件里留快照', async () => {
  const seen: Array<{ provider?: string; model?: string }> = []
  const ctx = await boot({
    modelResolver: {
      async resolve(selection) {
        seen.push(selection)
        return {
          model: scriptedModel({ content: 'provider 模型返回的结论' }),
          provider: selection.provider ?? 'default',
          modelName: selection.model ?? 'default-model',
        }
      },
    },
  })
  try {
    const created = await api(ctx.base, 'alice', 'POST', '/api/tasks', {
      prompt: '排查 checkout-api',
      provider: 'deepseek',
      model: 'deepseek-reasoner',
    })
    const task = await ctx.platform.waitUntil(created.body.task.id, (item) => item.status === 'succeeded')
    assert.match(task.result ?? '', /provider 模型返回的结论/)
    assert.deepEqual(seen[0], { provider: 'deepseek', model: 'deepseek-reasoner' })
    const events = (await api(ctx.base, 'alice', 'GET', `/api/tasks/${task.id}/events`)).body.events
    const started = events.find((event: { type: string }) => event.type === 'task.started')
    assert.equal(started?.data.mode, 'agent')
    assert.equal(started?.data.provider, 'deepseek')
    assert.equal(started?.data.model, 'deepseek-reasoner')
  } finally {
    await ctx.close()
  }
})

test('模型 provider 配置接口：列表可读、只有 admin 能写、key 不回显', async () => {
  const { dir, cleanup } = await mkdtemp(path.join(os.tmpdir(), 'aiops-model-http-')).then((value) => ({
    dir: value,
    cleanup: () => rm(value, { recursive: true, force: true }),
  }))
  try {
    const store = new ModelProviderStore(path.join(dir, 'model-providers.json'), SecretBox.fromKey(Buffer.alloc(32, 5).toString('base64')))
    const ctx = await boot({ modelProviders: store, models: new ModelRegistry(store) })
    try {
      assert.deepEqual((await api(ctx.base, 'alice', 'GET', '/api/model-providers')).body.providers, [])
      assert.equal((await api(ctx.base, 'alice', 'POST', '/api/model-providers', {
        name: 'deepseek',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-NEVER-ECHO',
        defaultModel: 'deepseek-chat',
      })).status, 403)

      const saved = await api(ctx.base, 'root', 'POST', '/api/model-providers', {
        name: 'deepseek',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-NEVER-ECHO',
        models: ['deepseek-chat'],
        defaultModel: 'deepseek-chat',
        isDefault: true,
      })
      assert.equal(saved.status, 200)
      assert.equal(saved.body.provider.hasApiKey, true)
      assert.equal(JSON.stringify(saved.body).includes('sk-NEVER-ECHO'), false)

      const listed = await api(ctx.base, 'alice', 'GET', '/api/model-providers')
      assert.equal(listed.body.providers.length, 1)
      assert.equal(listed.body.providers[0].name, 'deepseek')
      assert.equal('apiKey' in listed.body.providers[0], false)
      assert.equal(JSON.stringify(listed.body).includes('sk-NEVER-ECHO'), false)

      const updated = await api(ctx.base, 'root', 'PUT', '/api/model-providers/deepseek', {
        baseUrl: 'https://api.deepseek.com/v1',
        apiKeyEnv: 'AIOPS_DEEPSEEK_KEY',
        defaultModel: 'deepseek-chat',
      })
      assert.equal(updated.status, 200)
      assert.equal(updated.body.provider.hasApiKey, false)
      assert.equal(updated.body.provider.apiKeyEnv, 'AIOPS_DEEPSEEK_KEY')

      assert.equal((await api(ctx.base, 'root', 'DELETE', '/api/model-providers/deepseek')).status, 200)
      assert.deepEqual((await api(ctx.base, 'alice', 'GET', '/api/model-providers')).body.providers, [])
    } finally {
      await ctx.close()
    }
  } finally {
    await cleanup()
  }
})

test('对外 v1 任务 API 支持创建、工具调用、事件和结束', async () => {
  const ctx = await boot()
  try {
    const created = await api(ctx.base, 'alice', 'POST', '/api/v1/tasks', {
      prompt: '排查 checkout-api',
      sessionId: 'workbuddy-session-1',
    })
    assert.equal(created.status, 201)
    assert.equal(created.body.task.origin, 'api')
    assert.equal(created.body.task.status, 'running')
    const taskId = created.body.task.id as string

    const read = await api(ctx.base, 'alice', 'POST', `/api/v1/tasks/${taskId}/tool-calls`, {
      tool: 'demo.list_pods',
      args: { namespace: 'shop' },
    })
    assert.equal(read.body.outcome.status, 'ok')

    const events = await api(ctx.base, 'alice', 'GET', `/api/v1/tasks/${taskId}/events`)
    assert.ok(events.body.events.some((event: { type: string }) => event.type === 'tool.result'))

    const finished = await api(ctx.base, 'alice', 'POST', `/api/v1/tasks/${taskId}/finish`, {
      status: 'succeeded',
      result: 'checkout-api 未就绪',
    })
    assert.equal(finished.status, 200)
    assert.equal(finished.body.task.result, 'checkout-api 未就绪')

    const list = await api(ctx.base, 'alice', 'GET', '/api/v1/tasks')
    assert.equal(list.body.total, 1)
    assert.equal(list.body.tasks[0].origin, 'api')
    assert.equal((await api(ctx.base, 'alice', 'GET', '/api/v1/tools')).body.tools.length > 0, true)
    const spec = await fetch(`${ctx.base}/openapi.json`)
    assert.equal(spec.status, 200)
    assert.equal((await spec.json() as { openapi: string }).openapi, '3.1.0')
  } finally {
    await ctx.close()
  }
})

test('重启必须等另一位审批人，通过后只执行一次', async () => {
  const ctx = await boot()
  try {
    const created = await api(ctx.base, 'alice', 'POST', '/api/tasks', { prompt: '请重启 checkout-api' })
    const taskId = created.body.task.id as string
    await ctx.platform.waitUntil(taskId, (item) => item.status === 'awaiting_approval')
    const pod = ctx.world.pods.find((item) => item.workload === 'checkout-api')
    assert.equal(pod?.ready, false)
    assert.equal(pod?.restarts, 14)
    const pending = await api(ctx.base, 'alice', 'GET', '/api/approvals?status=pending')
    const approvalId = pending.body.approvals[0].id as string
    const self = await api(ctx.base, 'alice', 'POST', `/api/approvals/${approvalId}`, { decision: 'approved' })
    assert.equal(self.status, 403)
    const approved = await api(ctx.base, 'bob', 'POST', `/api/approvals/${approvalId}`, { decision: 'approved', comment: '变更窗口内' })
    assert.equal(approved.status, 200)
    const task = await ctx.platform.waitUntil(taskId, (item) => item.status === 'succeeded')
    assert.equal(pod?.ready, true)
    assert.equal(pod?.restarts, 15)
    const audit = await api(ctx.base, 'alice', 'GET', `/api/tasks/${taskId}/audit`)
    assert.ok(audit.body.audit.some((item: { approvalId?: string; decision: string }) => item.approvalId === approvalId && item.decision === 'approved'))
    const events = await api(ctx.base, 'alice', 'GET', `/api/tasks/${taskId}/events`)
    const types = events.body.events.map((event: { type: string }) => event.type)
    assert.ok(types.indexOf('approval.required') < types.indexOf('approval.decided'))
    assert.ok(types.indexOf('approval.decided') < types.indexOf('task.completed'))
    const again = await api(ctx.base, 'alice', 'POST', '/api/tool-calls', {
      tool: 'demo.restart',
      args: { namespace: 'shop', name: 'checkout-api' },
      taskId,
      approvalId,
    }, { 'x-internal-token': 'test-token' })
    assert.equal(again.status, 409)
    assert.equal(pod?.restarts, 15)
  } finally {
    await ctx.close()
  }
})

test('DSH 任务从创建到审批续跑走同一条链', async () => {
  const ctx = await boot()
  try {
    const created = await api(ctx.base, 'alice', 'POST', '/api/agent/tasks', {
      prompt: '请重启 checkout-api',
      title: 'DSH 重启',
      sessionId: 'dsh-session-1',
    }, { 'x-internal-token': 'test-token' })
    assert.equal(created.status, 201)
    const taskId = created.body.task.id as string
    assert.equal(created.body.task.origin, 'dsh')
    assert.equal(created.body.task.status, 'running')

    const read = await api(ctx.base, 'alice', 'POST', '/api/tool-calls', {
      tool: 'demo.list_pods',
      args: { namespace: 'shop' },
      taskId,
    }, { 'x-internal-token': 'test-token' })
    assert.equal(read.body.status, 'ok')

    const mutate = await api(ctx.base, 'alice', 'POST', '/api/tool-calls', {
      tool: 'demo.restart',
      args: { namespace: 'shop', name: 'checkout-api' },
      taskId,
    }, { 'x-internal-token': 'test-token' })
    assert.equal(mutate.body.status, 'awaiting_approval')
    const approvalId = mutate.body.approvalId as string
    assert.equal((await api(ctx.base, 'alice', 'GET', `/api/tasks/${taskId}`)).body.task.status, 'awaiting_approval')
    assert.equal((await api(ctx.base, 'alice', 'POST', `/api/agent/tasks/${taskId}/finish`, {
      status: 'succeeded',
      result: '太早结束',
    }, { 'x-internal-token': 'test-token' })).status, 409)

    assert.equal((await api(ctx.base, 'alice', 'POST', `/api/approvals/${approvalId}`, { decision: 'approved' })).status, 403)
    assert.equal((await api(ctx.base, 'bob', 'POST', `/api/approvals/${approvalId}`, {
      decision: 'approved',
      comment: '窗口内',
    })).status, 200)

    // DSH 没有本地 runner；审批通过后平台自动执行，任务不再是待审批。
    assert.equal(ctx.world.pods.find((pod) => pod.workload === 'checkout-api')?.restarts, 15)
    assert.equal((await api(ctx.base, 'alice', 'GET', `/api/tasks/${taskId}`)).body.task.status, 'running')
    const approval = (await api(ctx.base, 'bob', 'GET', '/api/approvals?status=approved')).body.approvals
      .find((item: { id: string }) => item.id === approvalId)
    assert.equal(approval.consumed, true)
    const eventsAfter = (await api(ctx.base, 'alice', 'GET', `/api/tasks/${taskId}/events`)).body.events
    assert.ok(eventsAfter.some((event: { type: string }) => event.type === 'tool.result'))
    const detail = await api(ctx.base, 'bob', 'GET', `/api/approvals/${approvalId}`)
    assert.equal(detail.body.execution.status, 'succeeded')
    assert.ok(detail.body.execution.result)
    assert.equal(typeof detail.body.execution.auditId, 'string')

    const resumed = await api(ctx.base, 'alice', 'POST', `/api/approvals/${approvalId}/resume`, undefined, {
      'x-internal-token': 'test-token',
    })
    assert.equal(resumed.status, 409, '自动执行后审批不能再消费一次')

    const finished = await api(ctx.base, 'alice', 'POST', `/api/agent/tasks/${taskId}/finish`, {
      status: 'succeeded',
      result: '已重启 checkout-api',
    }, { 'x-internal-token': 'test-token' })
    assert.equal(finished.status, 200)
    assert.equal(finished.body.task.status, 'succeeded')
    assert.equal(finished.body.task.result, '已重启 checkout-api')

    const types = (await api(ctx.base, 'alice', 'GET', `/api/tasks/${taskId}/events`)).body.events.map(
      (event: { type: string }) => event.type,
    )
    assert.ok(types.includes('tool.called'))
    assert.ok(types.includes('approval.required'))
    assert.ok(types.includes('approval.decided'))
    assert.ok(types.includes('task.completed'))
    const audit = await api(ctx.base, 'alice', 'GET', `/api/tasks/${taskId}/audit`)
    assert.ok(audit.body.audit.some((item: { approvalId?: string; decision: string }) => item.approvalId === approvalId && item.decision === 'approved'))

    const again = await api(ctx.base, 'alice', 'POST', `/api/approvals/${approvalId}/resume`, undefined, {
      'x-internal-token': 'test-token',
    })
    assert.equal(again.status, 409)
  } finally {
    await ctx.close()
  }
})

test('DSH 审批被拒绝后任务标失败且不改集群', async () => {
  const ctx = await boot()
  try {
    const created = await api(ctx.base, 'alice', 'POST', '/api/agent/tasks', {
      prompt: '请重启 checkout-api',
      sessionId: 'dsh-session-reject',
    }, { 'x-internal-token': 'test-token' })
    const taskId = created.body.task.id as string
    const mutate = await api(ctx.base, 'alice', 'POST', '/api/tool-calls', {
      tool: 'demo.restart',
      args: { namespace: 'shop', name: 'checkout-api' },
      taskId,
    }, { 'x-internal-token': 'test-token' })
    assert.equal(mutate.body.status, 'awaiting_approval')
    const approvalId = mutate.body.approvalId as string

    assert.equal((await api(ctx.base, 'dana', 'POST', `/api/approvals/${approvalId}`, {
      decision: 'rejected',
      comment: '不在窗口内',
    })).status, 200)

    const task = (await api(ctx.base, 'alice', 'GET', `/api/tasks/${taskId}`)).body.task
    assert.equal(task.status, 'failed')
    assert.equal(task.error, '审批被拒绝')
    assert.equal(ctx.world.pods.find((pod) => pod.workload === 'checkout-api')?.restarts, 14)
    const types = (await api(ctx.base, 'alice', 'GET', `/api/tasks/${taskId}/events`)).body.events.map(
      (event: { type: string }) => event.type,
    )
    assert.ok(types.includes('approval.decided'))
    assert.ok(types.includes('task.failed'))
    const detail = await api(ctx.base, 'alice', 'GET', `/api/approvals/${approvalId}`)
    assert.equal(detail.body.execution.status, 'rejected')
    assert.equal(detail.body.execution.error, '不在窗口内')
  } finally {
    await ctx.close()
  }
})

test('拒绝和取消都不会改集群', async () => {
  const rejected = await boot()
  try {
    const created = await api(rejected.base, 'alice', 'POST', '/api/tasks', { prompt: 'restart checkout-api' })
    const taskId = created.body.task.id as string
    await rejected.platform.waitUntil(taskId, (item) => item.status === 'awaiting_approval')
    const approvalId = (await api(rejected.base, 'dana', 'GET', '/api/approvals?status=pending')).body.approvals[0].id as string
    assert.equal((await api(rejected.base, 'dana', 'POST', `/api/approvals/${approvalId}`, { decision: 'rejected' })).status, 200)
    const task = await rejected.platform.waitUntil(taskId, (item) => item.status === 'failed')
    assert.equal(task.error, '审批被拒绝')
    assert.equal(rejected.world.pods.find((pod) => pod.workload === 'checkout-api')?.restarts, 14)
  } finally {
    await rejected.close()
  }

  const cancelled = await boot()
  try {
    const created = await api(cancelled.base, 'alice', 'POST', '/api/tasks', { prompt: '请重启 checkout-api' })
    const taskId = created.body.task.id as string
    await cancelled.platform.waitUntil(taskId, (item) => item.status === 'awaiting_approval')
    const pendingBefore = await api(cancelled.base, 'bob', 'GET', '/api/approvals?status=pending')
    assert.equal(pendingBefore.body.approvals.length, 1)
    assert.equal((await api(cancelled.base, 'carol', 'POST', `/api/tasks/${taskId}/cancel`, { force: true })).status, 403)
    // 有挂起审批时必须显式 force，避免 Agent 在等审批时误取消。
    const refused = await api(cancelled.base, 'bob', 'POST', `/api/tasks/${taskId}/cancel`)
    assert.equal(refused.status, 409)
    assert.match(refused.body.error.message, /待审批/)
    assert.equal((await api(cancelled.base, 'bob', 'GET', '/api/approvals?status=pending')).body.approvals.length, 1)
    assert.equal(
      (await api(cancelled.base, 'bob', 'POST', `/api/tasks/${taskId}/cancel`, { force: true })).body.task.status,
      'cancelled',
    )
    const task = await cancelled.platform.waitUntil(taskId, (item: Task) => item.status === 'cancelled')
    assert.equal(task.status, 'cancelled')
    assert.equal(cancelled.world.pods.find((pod) => pod.workload === 'checkout-api')?.restarts, 14)
    assert.equal((await api(cancelled.base, 'bob', 'GET', '/api/approvals?status=pending')).body.approvals.length, 0)
    const voided = await api(cancelled.base, 'bob', 'GET', '/api/approvals?status=rejected')
    assert.equal(voided.body.approvals[0]?.comment, '任务已取消，审批作废')
  } finally {
    await cancelled.close()
  }
})

test('身份、知识和工具权限', async () => {
  const ctx = await boot()
  try {
    assert.equal((await api(ctx.base, 'carol', 'POST', '/api/tasks', { prompt: '排查 pod' })).status, 403)
    assert.equal((await api(ctx.base, 'nobody', 'GET', '/api/tasks')).status, 401)
    const aliceHits = await api(ctx.base, 'alice', 'POST', '/api/knowledge/search', { query: 'CHG-88', top_k: 5 })
    assert.equal(aliceHits.body.hits.length, 0)
    const bobHits = await api(ctx.base, 'bob', 'POST', '/api/knowledge/search', { query: 'CHG-88', top_k: 5 })
    assert.equal(bobHits.body.hits[0].source, 'wiki/changes/CHG-88.md')
    assert.equal((await api(ctx.base, 'alice', 'POST', '/api/knowledge/documents', { doc_id: 'secret-change' })).status, 404)
    const doc = await api(ctx.base, 'bob', 'POST', '/api/knowledge/documents', { doc_id: 'secret-change' })
    assert.match(doc.body.document.content, /CHG-88/)
    const missing = await api(ctx.base, 'alice', 'POST', '/api/tool-calls', { tool: 'demo.list_pods', args: { namespace: 'shop' } })
    assert.equal(missing.status, 401)
    const denied = await api(ctx.base, 'carol', 'POST', '/api/tool-calls', { tool: 'demo.list_pods', args: { namespace: 'shop' } }, { 'x-internal-token': 'test-token' })
    assert.equal(denied.body.status, 'denied')
  } finally {
    await ctx.close()
  }
})

test('控制台页面提供任务、审批和知识入口', async () => {
  const ctx = await boot()
  try {
    const page = await fetch(`${ctx.base}/`)
    assert.equal(page.status, 200)
    const html = await page.text()
    assert.match(html, /提交任务/)
    assert.match(html, /审批/)
    assert.match(html, /检索知识库/)
    assert.match(html, /标题（可选）/)
    assert.match(html, /提交人/)
    assert.match(html, /条数/)
    assert.match(html, /资产/)
    assert.match(html, /文档/)
    const actors = await fetch(`${ctx.base}/api/actors`)
    const body = await actors.json() as { actors: Array<{ id: string }> }
    assert.ok(body.actors.some((person) => person.id === 'bob'))
    const script = await fetch(`${ctx.base}/app.js`)
    assert.equal(script.status, 200)
    const js = await script.text()
    assert.match(js, /ownerId/)
    assert.match(js, /top_k/)
    assert.match(js, /data-open-approval/)
    assert.match(js, /\/api\/assets/)
    assert.match(js, /\/api\/knowledge\/docs/)
    // 通知里的审批深链和未登录回跳。
    assert.ok(js.includes('#/approvals'))
    assert.match(js, /login\?next=/)
    const loginScript = await fetch(`${ctx.base}/login.js`)
    assert.equal(loginScript.status, 200)
    assert.match(await loginScript.text(), /nextTarget/)
  } finally {
    await ctx.close()
  }
})

test('工具集可以热替换，旧工具立即失效', async () => {
  const store = new MemoryStore()
  const actors: Actor[] = [{ id: 'alice', name: 'Alice', roles: ['operator'] }]
  const makeTool = (name: string) => ({
    name,
    description: name,
    risk: 'read' as const,
    parameters: { type: 'object' },
    async execute() {
      return name
    },
  })
  const broker = new ToolBroker([makeTool('old.tool')], store, actors)
  try {
    assert.equal((await broker.execute({
      actorId: 'alice',
      ownerId: 'alice',
      taskId: 'adhoc:alice',
      tool: 'old.tool',
      args: {},
    })).status, 'ok')
    broker.replaceTools([makeTool('new.tool')])
    assert.equal((await broker.execute({
      actorId: 'alice',
      ownerId: 'alice',
      taskId: 'adhoc:alice',
      tool: 'old.tool',
      args: {},
    })).status, 'denied')
    assert.equal((await broker.execute({
      actorId: 'alice',
      ownerId: 'alice',
      taskId: 'adhoc:alice',
      tool: 'new.tool',
      args: {},
    })).status, 'ok')
  } finally {
    await store.close()
  }
})

test('启动时回收中断的网页任务，外部 Agent 任务不动', async () => {
  const ctx = await boot()
  try {
    const now = new Date().toISOString()
    const makeTask = (id: string, origin: 'web' | 'dsh' | 'api', status: Task['status']): Task => ({
      id,
      sessionId: `local:${id}`,
      ownerId: 'alice',
      title: id,
      prompt: id,
      skill: 'monitoring-analysis',
      status,
      origin,
      createdAt: now,
      updatedAt: now,
    })
    await ctx.store.saveTask(makeTask('task_web', 'web', 'running'))
    await ctx.store.saveTask(makeTask('task_dsh', 'dsh', 'running'))
    await ctx.store.saveTask(makeTask('task_api', 'api', 'running'))
    await ctx.store.saveTask(makeTask('task_done', 'web', 'succeeded'))
    const approval: Approval = {
      id: 'apr_web',
      taskId: 'task_web',
      ownerId: 'alice',
      tool: 'demo.restart',
      args: {},
      argsHash: '{}',
      status: 'pending',
      requestedBy: 'alice',
      requestedAt: now,
      consumed: false,
    }
    await ctx.store.saveApproval(approval)
    assert.equal(await ctx.platform.recoverInterruptedTasks(), 1)
    const web = await ctx.store.getTask('task_web')
    assert.equal(web?.status, 'failed')
    assert.match(web?.error ?? '', /平台重启/)
    assert.equal((await ctx.store.getTask('task_dsh'))?.status, 'running')
    assert.equal((await ctx.store.getTask('task_api'))?.status, 'running')
    assert.equal((await ctx.store.getTask('task_done'))?.status, 'succeeded')
    const decided = await ctx.store.getApproval('apr_web')
    assert.equal(decided?.status, 'rejected')
    assert.equal(decided?.decidedBy, 'system')
    assert.ok((await ctx.store.eventsFor('task_web')).some((event) => event.type === 'task.failed'))
  } finally {
    await ctx.close()
  }
})

test('多实例启动回收只处理本实例执行的 web 任务', async () => {
  const ctx = await boot({ instanceId: 'pod-a' })
  try {
    const now = new Date().toISOString()
    const makeTask = (id: string, runnerId?: string): Task => ({
      id,
      sessionId: `local:${id}`,
      ownerId: 'alice',
      title: id,
      prompt: id,
      skill: 'monitoring-analysis',
      status: 'running',
      origin: 'web',
      ...(runnerId ? { runnerId } : {}),
      createdAt: now,
      updatedAt: now,
    })
    await ctx.store.saveTask(makeTask('task_own', 'pod-a'))
    await ctx.store.saveTask(makeTask('task_other', 'pod-b'))
    await ctx.store.saveTask(makeTask('task_legacy'))
    assert.equal(await ctx.platform.recoverInterruptedTasks(), 1)
    assert.equal((await ctx.store.getTask('task_own'))?.status, 'failed')
    assert.equal((await ctx.store.getTask('task_other'))?.status, 'running')
    // 未标记 runnerId 的历史任务属于单实例模式，多实例启动不能猜归属。
    assert.equal((await ctx.store.getTask('task_legacy'))?.status, 'running')
  } finally {
    await ctx.close()
  }
})

test('外部任务长时间没有活动时兜底收尾，挂起审批和网页任务不动', async () => {
  const ctx = await boot()
  try {
    const now = new Date('2026-11-24T03:00:00.000Z')
    const staleAt = new Date(now.getTime() - 10 * 60_000).toISOString()
    const makeTask = (id: string, origin: 'web' | 'dsh' | 'api', status: Task['status'], updatedAt: string): Task => ({
      id,
      sessionId: `local:${id}`,
      ownerId: 'alice',
      title: id,
      prompt: id,
      skill: 'monitoring-analysis',
      status,
      origin,
      createdAt: updatedAt,
      updatedAt,
    })
    await ctx.store.saveTask(makeTask('task_dsh_stale', 'dsh', 'running', staleAt))
    await ctx.store.saveTask(makeTask('task_api_stale', 'api', 'running', staleAt))
    await ctx.store.saveTask(makeTask('task_dsh_fresh', 'dsh', 'running', now.toISOString()))
    await ctx.store.saveTask(makeTask('task_web_stale', 'web', 'running', staleAt))
    await ctx.store.saveTask(makeTask('task_dsh_waiting', 'dsh', 'awaiting_approval', staleAt))
    await ctx.store.saveTask(makeTask('task_dsh_approved', 'dsh', 'running', staleAt))
    const approval: Approval = {
      id: 'apr_pending',
      taskId: 'task_dsh_approved',
      ownerId: 'alice',
      tool: 'demo.restart',
      args: {},
      argsHash: '{}',
      status: 'pending',
      requestedBy: 'alice',
      requestedAt: staleAt,
      consumed: false,
    }
    await ctx.store.saveApproval(approval)
    assert.equal(await ctx.platform.reapStaleExternalTasks(now, 240_000), 2)
    const dsh = await ctx.store.getTask('task_dsh_stale')
    assert.equal(dsh?.status, 'succeeded')
    assert.match(dsh?.result ?? '', /平台自动结束/)
    assert.ok((await ctx.store.eventsFor('task_dsh_stale')).some((event) => event.type === 'task.completed'))
    assert.equal((await ctx.store.getTask('task_api_stale'))?.status, 'succeeded')
    assert.equal((await ctx.store.getTask('task_dsh_fresh'))?.status, 'running')
    assert.equal((await ctx.store.getTask('task_web_stale'))?.status, 'running')
    assert.equal((await ctx.store.getTask('task_dsh_waiting'))?.status, 'awaiting_approval')
    assert.equal((await ctx.store.getTask('task_dsh_approved'))?.status, 'running')
    // 已收尾的任务是终态，下一轮不会重复计数。
    assert.equal(await ctx.platform.reapStaleExternalTasks(now, 240_000), 0)
  } finally {
    await ctx.close()
  }
})

test('任务分页 total 在可见性过滤后统计，offset 越界返回空页', async () => {
  const ctx = await boot()
  try {
    for (let index = 0; index < 3; index += 1) {
      await ctx.store.saveTask({
        id: `task_page_${index}`,
        sessionId: `local:${index}`,
        ownerId: 'alice',
        title: `page-${index}`,
        prompt: '排查',
        skill: 'monitoring-analysis',
        status: 'succeeded',
        origin: 'web',
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      })
    }
    const page = await api(ctx.base, 'alice', 'GET', '/api/tasks?limit=2&offset=2')
    assert.equal(page.body.total, 3)
    assert.equal(page.body.tasks.length, 1)
    const beyond = await api(ctx.base, 'alice', 'GET', '/api/tasks?limit=2&offset=10')
    assert.equal(beyond.body.total, 3)
    assert.deepEqual(beyond.body.tasks, [])
    const carol = await api(ctx.base, 'carol', 'GET', '/api/tasks?limit=2')
    assert.equal(carol.body.total, 0)
  } finally {
    await ctx.close()
  }
})

test('compose 启动时自动回收中断任务', async () => {
  const store = new MemoryStore()
  const now = new Date().toISOString()
  await store.saveTask({
    id: 'task_stale',
    sessionId: 'local:task_stale',
    ownerId: 'alice',
    title: 'stale',
    prompt: 'stale',
    skill: 'monitoring-analysis',
    status: 'running',
    origin: 'web',
    createdAt: now,
    updatedAt: now,
  })
  try {
    await compose('config/platform.json', { store, mcpServers: [] })
    const task = await store.getTask('task_stale')
    assert.equal(task?.status, 'failed')
    assert.match(task?.error ?? '', /平台重启/)
  } finally {
    await store.close()
  }
})

test('demo 配置能检索本地知识库', async () => {
  const running = await compose('config/platform.json', { store: new MemoryStore(), mcpServers: [] })
  const hits = await running.platform.searchKnowledge('alice', 'CrashLoop', 3)
  assert.ok(hits.some((hit) => hit.source === 'wiki/runbooks/checkout.md'))
  const task = await running.platform.createTask('alice', { prompt: 'CPU 故障，payments 限流' })
  assert.equal(task.skill, 'monitoring-analysis')
  await running.platform.waitUntil(task.id, (item) => item.status === 'succeeded')
})

/** 最小可用的 Streamable HTTP MCP mock，只实现 initialize / tools/list / tools/call。 */
async function startMcpMock(options: { requireAuth?: string } = {}): Promise<{
  url: string
  setFail: (value: boolean) => void
  setTools: (tools: Array<{ name: string; description?: string }>) => void
  seenAuth: Array<string | undefined>
  close: () => Promise<void>
}> {
  let failing = false
  let listedTools = [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' } }]
  const seenAuth: Array<string | undefined> = []
  const server = createNodeServer((req, res) => {
    seenAuth.push(req.headers.authorization)
    if (options.requireAuth && req.headers.authorization !== options.requireAuth) {
      res.statusCode = 401
      res.end('unauthorized')
      return
    }
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      if (failing) {
        res.statusCode = 503
        res.end('upstream down')
        return
      }
      let message: { method?: string; id?: unknown } = {}
      try {
        message = JSON.parse(raw || '{}') as { method?: string; id?: unknown }
      } catch {
        // 空请求体按通知处理。
      }
      if (message.method === 'notifications/initialized') {
        res.statusCode = 202
        res.end()
        return
      }
      let result: unknown = {}
      if (message.method === 'initialize') {
        result = { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'mock', version: '0' } }
      } else if (message.method === 'tools/list') {
        result = { tools: listedTools }
      } else if (message.method === 'tools/call') {
        result = { content: [{ type: 'text', text: 'ok' }] }
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('mock 没有端口')
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    setFail: (value: boolean) => {
      failing = value
    },
    setTools: (tools) => {
      listedTools = tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? tool.name,
        inputSchema: { type: 'object' },
      }))
    },
    seenAuth,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

test('任务可见性按角色收口：owner、审批相关、admin', async () => {
  const ctx = await boot()
  try {
    const created = await api(ctx.base, 'alice', 'POST', '/api/tasks', { prompt: '排查 checkout-api CrashLoopBackOff' })
    const taskId = created.body.task.id as string
    await ctx.platform.waitUntil(taskId, (item) => item.status === 'succeeded')

    const alice = await api(ctx.base, 'alice', 'GET', '/api/tasks')
    assert.ok(alice.body.tasks.some((task: Task) => task.id === taskId))
    assert.equal((await api(ctx.base, 'alice', 'GET', `/api/tasks/${taskId}`)).status, 200)

    const carol = await api(ctx.base, 'carol', 'GET', '/api/tasks')
    assert.equal(carol.body.tasks.length, 0)
    assert.equal((await api(ctx.base, 'carol', 'GET', `/api/tasks/${taskId}`)).status, 404)

    const bob = await api(ctx.base, 'bob', 'GET', '/api/tasks')
    assert.equal(bob.body.tasks.some((task: Task) => task.id === taskId), false)

    const root = await api(ctx.base, 'root', 'GET', '/api/tasks')
    assert.ok(root.body.tasks.some((task: Task) => task.id === taskId))
    assert.equal((await api(ctx.base, 'root', 'GET', `/api/tasks/${taskId}`)).status, 200)

    // 审计员全局只读：能看所有任务和审计，不能提交、执行或审批。
    const eve = await api(ctx.base, 'eve', 'GET', '/api/tasks')
    assert.ok(eve.body.tasks.some((task: Task) => task.id === taskId))
    assert.equal((await api(ctx.base, 'eve', 'GET', `/api/tasks/${taskId}`)).status, 200)
    assert.equal((await api(ctx.base, 'eve', 'GET', `/api/tasks/${taskId}/audit`)).status, 200)
    assert.equal((await api(ctx.base, 'eve', 'POST', '/api/tasks', { prompt: '审计员不能提交' })).status, 403)
    const eveTool = await api(ctx.base, 'eve', 'POST', '/api/tool-calls', { tool: 'demo.list_pods', args: {} }, { 'x-internal-token': 'test-token' })
    assert.equal(eveTool.body.status, 'denied')

    const adminTask = await api(ctx.base, 'root', 'POST', '/api/tasks', { prompt: '排查 checkout-api CrashLoopBackOff' })
    assert.equal(adminTask.status, 201)
  } finally {
    await ctx.close()
  }
})

test('总览按当前身份汇总任务、审批和能力状态', async () => {
  const ctx = await boot()
  try {
    const created = await api(ctx.base, 'alice', 'POST', '/api/tasks', { prompt: '请重启 checkout-api' })
    const taskId = created.body.task.id as string
    await ctx.platform.waitUntil(taskId, (item) => item.status === 'awaiting_approval')

    const alice = await api(ctx.base, 'alice', 'GET', '/api/overview')
    assert.equal(alice.status, 200)
    assert.ok(alice.body.tasks.total >= 1)
    assert.ok((alice.body.tasks.byStatus.awaiting_approval ?? 0) >= 1)
    assert.ok(alice.body.tasks.recent.some((task: Task) => task.id === taskId))
    assert.ok(alice.body.approvals.pending >= 1)
    assert.ok(alice.body.approvals.recent.some((approval: Approval) => approval.taskId === taskId))
    assert.equal(typeof alice.body.knowledge.documents, 'number')
    assert.equal(alice.body.mcp.servers, 0)
    assert.ok(alice.body.tools.mutate >= 1)
    assert.equal(typeof alice.body.assets.total, 'number')

    const bob = await api(ctx.base, 'bob', 'GET', '/api/overview')
    assert.ok(bob.body.tasks.total >= 1)
    assert.ok(bob.body.approvals.pending >= 1)

    // viewer 只看自己的：既看不到 Alice 的任务数，也看不到知识管理和 MCP 统计。
    const carol = await api(ctx.base, 'carol', 'GET', '/api/overview')
    assert.equal(carol.body.tasks.total, 0)
    assert.equal(carol.body.approvals.pending, 0)
    assert.equal(carol.body.knowledge, null)
    assert.equal(carol.body.mcp, null)
  } finally {
    await ctx.close()
  }
})

test('审批人能看到有审批记录的任务，admin 也不能自批', async () => {
  const ctx = await boot()
  try {
    const created = await api(ctx.base, 'alice', 'POST', '/api/tasks', { prompt: '请重启 checkout-api' })
    const taskId = created.body.task.id as string
    await ctx.platform.waitUntil(taskId, (item) => item.status === 'awaiting_approval')

    const bob = await api(ctx.base, 'bob', 'GET', '/api/tasks')
    assert.ok(bob.body.tasks.some((task: Task) => task.id === taskId))
    const carol = await api(ctx.base, 'carol', 'GET', '/api/tasks')
    assert.equal(carol.body.tasks.some((task: Task) => task.id === taskId), false)

    const pending = await api(ctx.base, 'bob', 'GET', '/api/approvals?status=pending')
    const approval = pending.body.approvals.find((item: Approval) => item.taskId === taskId)
    assert.ok(approval)
    const evePending = await api(ctx.base, 'eve', 'GET', '/api/approvals?status=pending')
    assert.ok(evePending.body.approvals.some((item: Approval) => item.id === approval.id))
    const eveApprove = await api(ctx.base, 'eve', 'POST', `/api/approvals/${approval.id}`, { decision: 'approved' })
    assert.equal(eveApprove.status, 403)
    const rootApprove = await api(ctx.base, 'root', 'POST', `/api/approvals/${approval.id}`, { decision: 'approved' })
    assert.equal(rootApprove.status, 200)
  } finally {
    await ctx.close()
  }

  const second = await boot()
  try {
    const own = await api(second.base, 'root', 'POST', '/api/tasks', { prompt: '请重启 checkout-api' })
    const ownTaskId = own.body.task.id as string
    await second.platform.waitUntil(ownTaskId, (item) => item.status === 'awaiting_approval')
    const ownPending = await api(second.base, 'root', 'GET', '/api/approvals?status=pending')
    const ownApproval = ownPending.body.approvals.find((item: Approval) => item.taskId === ownTaskId)
    assert.ok(ownApproval)
    const self = await api(second.base, 'root', 'POST', `/api/approvals/${ownApproval.id}`, { decision: 'approved' })
    assert.equal(self.status, 403)
  } finally {
    await second.close()
  }
})

test('任务、审批、事件和审计支持分页，单条审批有可见性校验', async () => {
  const ctx = await boot()
  try {
    const created: Task[] = []
    for (let index = 0; index < 5; index += 1) {
      created.push(await ctx.platform.createTask('alice', { title: `paging-${index}`, prompt: '排查', skill: 'monitoring-analysis' }))
    }
    const first = await api(ctx.base, 'alice', 'GET', '/api/tasks?limit=2&offset=0')
    const second = await api(ctx.base, 'alice', 'GET', '/api/tasks?limit=2&offset=2')
    assert.equal(first.body.total, 5)
    assert.equal(first.body.tasks.length, 2)
    assert.equal(second.body.tasks.length, 2)
    assert.equal(first.body.tasks.some((task: Task) => second.body.tasks.some((other: Task) => other.id === task.id)), false)

    const task = created[0]
    const now = new Date().toISOString()
    await ctx.store.appendEvent({ id: 'evt_page_1', taskId: task.id, type: 'x.one', at: now, data: {} })
    await ctx.store.appendEvent({ id: 'evt_page_2', taskId: task.id, type: 'x.two', at: now, data: {} })
    const events = await api(ctx.base, 'alice', 'GET', `/api/tasks/${task.id}/events?limit=1`)
    assert.equal(events.body.events.length, 1)
    assert.ok(events.body.total >= 2)
    assert.equal(events.body.events[0].id, 'evt_page_2')

    const approval: Approval = {
      id: 'apr_page',
      taskId: task.id,
      ownerId: 'alice',
      tool: 'demo.restart',
      args: {},
      argsHash: '{}',
      status: 'pending',
      requestedBy: 'alice',
      requestedAt: now,
      consumed: false,
    }
    await ctx.store.saveApproval(approval)
    const page = await api(ctx.base, 'bob', 'GET', `/api/approvals?taskId=${task.id}&limit=1`)
    assert.equal(page.body.total, 1)
    assert.equal(page.body.approvals[0].id, approval.id)
    assert.equal((await api(ctx.base, 'bob', 'GET', '/api/approvals/apr_page')).body.approval.id, approval.id)
    assert.equal((await api(ctx.base, 'carol', 'GET', '/api/approvals/apr_page')).status, 403)
    assert.equal((await api(ctx.base, 'bob', 'GET', '/api/approvals?limit=500')).status, 400)
  } finally {
    await ctx.close()
  }
})

test('挂起审批超时自动拒绝，DSH 任务标失败并写审计和事件', async () => {
  const ctx = await boot()
  try {
    const now = new Date()
    const old = new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString()
    const task: Task = {
      id: 'task_expire',
      sessionId: 'dsh:task_expire',
      ownerId: 'alice',
      title: 'expire',
      prompt: 'expire',
      skill: 'monitoring-analysis',
      status: 'awaiting_approval',
      origin: 'dsh',
      createdAt: old,
      updatedAt: old,
    }
    await ctx.store.saveTask(task)
    await ctx.store.saveApproval({
      id: 'apr_expire',
      taskId: task.id,
      ownerId: 'alice',
      tool: 'demo.restart',
      args: { namespace: 'shop' },
      argsHash: '{}',
      status: 'pending',
      requestedBy: 'alice',
      requestedAt: old,
      consumed: false,
    })

    assert.equal(await ctx.platform.expireApprovals(now), 1)
    const approval = await ctx.store.getApproval('apr_expire')
    assert.equal(approval?.status, 'rejected')
    assert.equal(approval?.decidedBy, 'system')
    assert.match(approval?.comment ?? '', /超时/)
    const updated = await ctx.store.getTask(task.id)
    assert.equal(updated?.status, 'failed')
    assert.match(updated?.error ?? '', /审批超时/)
    const audit = await ctx.store.auditsFor(task.id)
    assert.equal(audit.at(-1)?.actorId, 'system')
    assert.equal(audit.at(-1)?.decision, 'rejected')
    const events = await ctx.store.eventsFor(task.id)
    assert.ok(events.some((event) =>
      event.type === 'approval.decided' &&
      (event.data as { decidedBy?: string } | undefined)?.decidedBy === 'system',
    ))
    assert.ok(events.some((event) => event.type === 'task.failed'))
  } finally {
    await ctx.close()
  }
})

test('清理只删除过期终态任务及其事件、审批、审计和安全事件', async () => {
  const ctx = await boot()
  try {
    const old = '2026-01-01T00:00:00.000Z'
    const now = new Date().toISOString()
    await ctx.store.saveTask({
      id: 'task_old_done', sessionId: 'web:old', ownerId: 'alice', title: 'old', prompt: 'old',
      skill: 'monitoring-analysis', status: 'succeeded', origin: 'web', createdAt: old, updatedAt: old,
    })
    await ctx.store.saveTask({
      id: 'task_old_running', sessionId: 'web:old', ownerId: 'alice', title: 'running', prompt: 'running',
      skill: 'monitoring-analysis', status: 'running', origin: 'web', createdAt: old, updatedAt: old,
    })
    await ctx.store.appendEvent({ id: 'evt_old', taskId: 'task_old_done', type: 'x', at: old, data: {} })
    await ctx.store.appendAudit({
      id: 'aud_old', taskId: 'task_old_done', actorId: 'alice', tool: 'x', risk: 'read',
      args: {}, decision: 'allowed', at: old,
    })
    await ctx.store.saveApproval({
      id: 'apr_old', taskId: 'task_old_done', ownerId: 'alice', tool: 'x', args: {}, argsHash: '{}',
      status: 'approved', requestedBy: 'alice', requestedAt: old, consumed: true,
    })
    await ctx.store.appendSecurityEvent({ id: 'sec_old', at: old, type: 'auth.login_failed' })
    await ctx.store.appendSecurityEvent({ id: 'sec_new', at: now, type: 'auth.login_succeeded' })

    assert.equal(await ctx.platform.cleanupTasks(now), 1)
    assert.equal(await ctx.store.getTask('task_old_done'), undefined)
    assert.equal((await ctx.store.getTask('task_old_running'))?.status, 'running')
    assert.equal((await ctx.store.eventsFor('task_old_done')).length, 0)
    assert.equal((await ctx.store.auditsFor('task_old_done')).length, 0)
    assert.equal(await ctx.store.getApproval('apr_old'), undefined)
    assert.equal(await ctx.store.purgeSecurityEvents(now), 1)
    const securityEvents = await ctx.store.listSecurityEvents(10)
    assert.deepEqual(securityEvents.map((event) => event.id), ['sec_new'])
  } finally {
    await ctx.close()
  }
})
