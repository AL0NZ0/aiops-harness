import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { test } from 'node:test'
import os from 'node:os'
import path from 'node:path'
import { LocalKnowledgeProvider } from '../../extensions/knowledge/src/index.ts'
import { AssetStore } from '../src/assets.ts'
import { CredentialStore } from '../src/credentials.ts'
import { McpServerStore } from '../src/mcp-servers.ts'
import { Platform } from '../src/platform.ts'
import type { BuildToolsResult } from '../src/platform.ts'
import { MemoryStore } from '../src/store.ts'
import { ToolPolicyStore, toolPolicySignature } from '../src/tool-policies.ts'
import type { Actor, Tool } from '../src/types.ts'

const actors: Actor[] = [
  { id: 'root', name: 'Root', roles: ['admin'] },
  { id: 'alice', name: 'Alice', roles: ['operator'] },
  { id: 'bob', name: 'Bob', roles: ['approver'] },
]

function demoTool(name: string, risk: 'read' | 'mutate', description = '演示工具'): Tool {
  return {
    name,
    description,
    risk,
    parameters: { type: 'object' },
    async execute() {
      return { ok: true }
    },
  }
}

function boot(
  tools: Tool[],
  options: { toolPolicies?: ToolPolicyStore; mcpStore?: McpServerStore; rebuildTools?: () => Promise<BuildToolsResult> } = {},
) {
  return new Platform({
    actors,
    skills: [],
    tools,
    knowledge: new LocalKnowledgeProvider(path.resolve('extensions/knowledge/fixtures')),
    mcpStore: options.mcpStore ?? new McpServerStore(null, []),
    assets: new AssetStore(null),
    credentials: new CredentialStore(null),
    store: new MemoryStore(),
    ...(options.toolPolicies ? { toolPolicies: options.toolPolicies } : {}),
    ...(options.rebuildTools ? { rebuildTools: options.rebuildTools } : {}),
  })
}

test('策略存储：持久化 0600、校验名称和损坏文件', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aiops-tool-policies-'))
  const file = path.join(dir, 'tool-policies.json')
  try {
    const store = new ToolPolicyStore(file)
    await store.set('mcp.demo.delete_pod', 'mutate', 'a'.repeat(64), 'root')
    const reopened = new ToolPolicyStore(file)
    const list = await reopened.list()
    assert.equal(list['mcp.demo.delete_pod']?.risk, 'mutate')
    assert.equal(list['mcp.demo.delete_pod']?.updatedBy, 'root')
    assert.equal((await stat(file)).mode & 0o777, 0o600)

    await assert.rejects(() => store.set('ssh.exec', 'read', 'a'.repeat(64), 'root'), /mcp/)
    await assert.rejects(() => store.set('mcp.demo.delete_pod', 'read', 'bad', 'root'), /签名/)

    await writeFile(file, '{broken', { mode: 0o600 })
    await assert.rejects(() => new ToolPolicyStore(file).list(), /解析失败/)
    assert.equal(await readFile(file, 'utf8'), '{broken')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('admin 才能逐工具覆盖风险，清除后恢复 server 默认', async () => {
  const policies = new ToolPolicyStore(null)
  const tool = demoTool('mcp.demo.delete_pod', 'mutate')
  const platform = boot([tool], { toolPolicies: policies })
  await platform.loadToolPolicies()

  await assert.rejects(
    () => platform.setToolPolicy('alice', tool.name, 'read'),
    (error: unknown) => (error as { status?: number }).status === 403,
  )
  const views = await platform.setToolPolicy('root', tool.name, 'read')
  assert.equal(views.length, 1)
  assert.equal(views[0]?.active, true)
  assert.equal(views[0]?.baseRisk, 'mutate')
  assert.equal(platform.listTools('root').find((item) => item.name === tool.name)?.risk, 'read')

  const cleared = await platform.clearToolPolicy('root', tool.name)
  assert.equal(cleared.length, 0)
  assert.equal(platform.listTools('root').find((item) => item.name === tool.name)?.risk, 'mutate')

  await assert.rejects(() => platform.setToolPolicy('root', 'ssh.exec', 'read'), /mcp/)
  await assert.rejects(
    () => platform.setToolPolicy('root', 'mcp.demo.not_exists', 'read'),
    (error: unknown) => (error as { status?: number }).status === 404,
  )
})

test('策略覆盖直接决定 ToolBroker 是否走审批', async () => {
  const policies = new ToolPolicyStore(null)
  const writeTool = demoTool('mcp.demo.flush', 'mutate')
  const readTool = demoTool('mcp.demo.inspect', 'read')
  const platform = boot([writeTool, readTool], { toolPolicies: policies })
  await platform.loadToolPolicies()

  const guarded = await platform.executeTool({ actorId: 'alice', tool: writeTool.name, args: {} })
  assert.equal(guarded.status, 'awaiting_approval')

  await platform.setToolPolicy('root', writeTool.name, 'read')
  const direct = await platform.executeTool({ actorId: 'alice', tool: writeTool.name, args: {} })
  assert.equal(direct.status, 'ok')

  await platform.setToolPolicy('root', readTool.name, 'mutate')
  const needsApproval = await platform.executeTool({ actorId: 'alice', tool: readTool.name, args: {} })
  assert.equal(needsApproval.status, 'awaiting_approval')
})

test('上游工具签名变化后策略自动失效，继续用默认风险', async () => {
  const policies = new ToolPolicyStore(null)
  const name = 'mcp.demo.delete_pod'
  await policies.set(name, 'read', toolPolicySignature(demoTool(name, 'mutate', '旧描述')), 'root')
  const platform = boot([demoTool(name, 'mutate', '新描述')], { toolPolicies: policies })
  await platform.loadToolPolicies()

  assert.equal(platform.listTools('root').find((item) => item.name === name)?.risk, 'mutate')
  const views = await platform.listToolPolicies('root')
  assert.equal(views[0]?.active, false)
  assert.equal(views[0]?.stale, true)
})

test('MCP 连接配置和风险配置分开授权', async () => {
  const mcpStore = new McpServerStore(null, [
    { name: 'demo', system: 'kubernetes', url: 'http://127.0.0.1:1/mcp' },
  ])
  const rebuildTools = async () => ({ tools: [], mcpErrors: [] })
  const platform = boot([], { mcpStore, rebuildTools })

  // 改连接可以，动 readOnly 必须 admin。
  const changed = await platform.saveMcpServers('alice', [
    { name: 'demo', system: 'kubernetes', url: 'http://127.0.0.1:2/mcp' },
  ])
  assert.equal(changed[0]?.url, 'http://127.0.0.1:2/mcp')

  await assert.rejects(
    () =>
      platform.saveMcpServers('alice', [
        { name: 'demo', system: 'kubernetes', url: 'http://127.0.0.1:2/mcp', readOnly: true },
      ]),
    (error: unknown) => (error as { status?: number }).status === 403,
  )
  await assert.rejects(
    () =>
      platform.saveMcpServers('alice', [
        { name: 'demo', system: 'kubernetes', url: 'http://127.0.0.1:2/mcp' },
        { name: 'extra', system: 'kubernetes', url: 'http://127.0.0.1:3/mcp', readOnly: true },
      ]),
    (error: unknown) => (error as { status?: number }).status === 403,
  )

  const saved = await platform.saveMcpServers('root', [
    { name: 'demo', system: 'kubernetes', url: 'http://127.0.0.1:2/mcp', readOnly: true },
  ])
  assert.equal(saved[0]?.readOnly, true)
  // 被拒绝的提交没有落盘。
  const servers = await mcpStore.list()
  assert.equal(servers[0]?.url, 'http://127.0.0.1:2/mcp')
})