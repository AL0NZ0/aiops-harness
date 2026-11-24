import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { LocalKnowledgeProvider } from '../../extensions/knowledge/src/index.ts'
import { AlertSourceStore, alertSourceView, parseAlertPayload, severityOf } from '../src/alert-sources.ts'
import { AssetStore } from '../src/assets.ts'
import { CredentialStore } from '../src/credentials.ts'
import { createServer } from '../src/http.ts'
import { McpServerStore } from '../src/mcp-servers.ts'
import type { ChatModel } from '../src/model.ts'
import { NotificationStore, type NotificationEvent } from '../src/notifications.ts'
import { Platform } from '../src/platform.ts'
import { SecretBox } from '../src/secret-box.ts'
import { loadSkills } from '../src/skills.ts'
import { MemoryStore } from '../src/store.ts'
import type { Actor } from '../src/types.ts'

const actors: Actor[] = [
  { id: 'alice', name: 'Alice', roles: ['operator'] },
  { id: 'carol', name: 'Carol', roles: ['viewer'] },
  { id: 'eve', name: 'Eve', roles: ['auditor'] },
  { id: 'root', name: 'Root', roles: ['admin'] },
]

const skillsDir = path.resolve('extensions/aiops-skills')
const knowledgeRoot = path.resolve('extensions/knowledge/fixtures')

async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'aiops-alert-'))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
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

async function boot(options: {
  store: AlertSourceStore
  model?: ChatModel
  alertMaxConcurrency?: number
  notifyTargets?: (webhookIds: string[], event: NotificationEvent) => void | Promise<Array<{ webhook: string; ok: boolean; error?: string }>>
  notifications?: NotificationStore
}) {
  const knowledge = new LocalKnowledgeProvider(knowledgeRoot)
  const skills = await loadSkills(skillsDir)
  const platform = new Platform({
    actors,
    skills,
    knowledge,
    tools: [],
    mcpStore: new McpServerStore(null, []),
    assets: new AssetStore(null),
    credentials: new CredentialStore(null),
    store: new MemoryStore(),
    alertSources: options.store,
    publicUrl: 'https://aiops.example.com',
    ...(options.model ? { model: options.model } : {}),
    ...(options.alertMaxConcurrency !== undefined ? { alertMaxConcurrency: options.alertMaxConcurrency } : {}),
    ...(options.notifyTargets ? { notifyTargets: options.notifyTargets } : {}),
  })
  const server = createServer(platform, {
    internalToken: 'test-token',
    ...(options.notifications ? { notifications: options.notifications } : {}),
  })
  const port = await listen(server)
  return { platform, base: `http://127.0.0.1:${port}`, close: () => close(server) }
}

async function api(
  base: string,
  actor: string,
  method: string,
  pathname: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
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
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, any>) : {} }
}

function hook(base: string, sourceId: string, token: string | null, payload: unknown) {
  return api(base, '', 'POST', `/api/hooks/alerts/${encodeURIComponent(sourceId)}`, payload, {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  })
}

function finalModel(content = '排查完成：证据来自 demo.list_pods'): ChatModel {
  return {
    async complete() {
      return { content, toolCalls: [] }
    },
  }
}

function slowModel(delayMs: number): ChatModel {
  return {
    async complete() {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      return { content: '排查完成', toolCalls: [] }
    },
  }
}

function nightingalePayload(overrides: Record<string, unknown> = {}) {
  return {
    rule_name: 'Pod 重启过多',
    severity: 2,
    status: 'firing',
    tags: 'cluster=prod,namespace=shop,workload=checkout-api',
    annotations: '{"summary":"checkout-api 5 分钟重启 14 次"}',
    hash: 'fp-checkout-restart',
    ...overrides,
  }
}

test('告警接入 Token 只落 SHA-256，轮换后旧 Token 失效', async () => {
  const { dir, cleanup } = await tempDir()
  const file = path.join(dir, 'alert-sources.json')
  try {
    const store = new AlertSourceStore(file)
    const created = await store.create({
      name: 'prod-k8s',
      format: 'nightingale',
      actorId: 'alice',
      maxSeverity: 2,
      cooldownMs: 60_000,
      notifyWebhookIds: ['wh-1'],
    })
    assert.ok(created.token.length >= 32)
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    const raw = await readFile(file, 'utf8')
    assert.equal(raw.includes(created.token), false)
    assert.match(raw, /"tokenHash": "[a-f0-9]{64}"/)
    assert.equal((await store.verifyToken(created.source.id, created.token))?.id, created.source.id)
    assert.equal(await store.verifyToken(created.source.id, `${created.token}x`), undefined)
    const view = alertSourceView(created.source, 'https://aiops.example.com/')
    assert.equal('tokenHash' in view, false)
    assert.equal(view.path, `https://aiops.example.com/api/hooks/alerts/${encodeURIComponent(created.source.id)}`)

    await store.update(created.source.id, { name: 'prod-k8s', enabled: false, maxSeverity: 1 })
    const updated = await store.get(created.source.id)
    assert.equal(updated?.enabled, false)
    assert.equal(updated?.maxSeverity, 1)
    assert.equal(updated?.tokenHash, created.source.tokenHash)

    // 字段缺省保持原值，显式空字符串清除 provider/model。
    await store.update(created.source.id, {
      provider: 'ali-tokenplan',
      model: 'deepseek-v4',
      skill: 'k8s-troubleshooting',
    })
    const bound = await store.get(created.source.id)
    assert.equal(bound?.provider, 'ali-tokenplan')
    assert.equal(bound?.model, 'deepseek-v4')
    assert.equal(bound?.skill, 'k8s-troubleshooting')
    await store.update(created.source.id, { provider: '', model: '', skill: '' })
    const cleared = await store.get(created.source.id)
    assert.equal(cleared?.provider, undefined)
    assert.equal(cleared?.model, undefined)
    assert.equal(cleared?.skill, undefined)

    const rotated = await store.rotateToken(created.source.id)
    assert.notEqual(rotated.token, created.token)
    assert.equal(await store.verifyToken(created.source.id, created.token), undefined)
    const reopened = new AlertSourceStore(file)
    assert.equal((await reopened.verifyToken(created.source.id, rotated.token))?.id, created.source.id)
    assert.equal(await reopened.remove(created.source.id), true)
    await assert.rejects(
      () => reopened.create({ name: 'bad\nname', format: 'nightingale', actorId: 'alice' }),
      /名称必填/,
    )
    assert.equal((await reopened.list()).length, 0)
  } finally {
    await cleanup()
  }
})

test('告警接入配置文件损坏必须报错，不能静默清空', async () => {
  const { dir, cleanup } = await tempDir()
  const file = path.join(dir, 'alert-sources.json')
  try {
    await writeFile(file, '{not json', 'utf8')
    await assert.rejects(() => new AlertSourceStore(file).list(), /不是合法 JSON/)
    await writeFile(file, JSON.stringify({ wrong: [] }), 'utf8')
    await assert.rejects(() => new AlertSourceStore(file).list(), /缺少 sources 数组/)
  } finally {
    await cleanup()
  }
})

test('告警解析兼容夜莺原始回调和全局模板、Alertmanager 及严重级别映射', () => {
  const [snake] = parseAlertPayload('nightingale', nightingalePayload())
  assert.equal(snake?.name, 'Pod 重启过多')
  assert.equal(snake?.severity, 2)
  assert.equal(snake?.status, 'firing')
  assert.equal(snake?.fingerprint, 'fp-checkout-restart')
  assert.deepEqual(snake?.labels, { cluster: 'prod', namespace: 'shop', workload: 'checkout-api' })
  assert.equal(snake?.annotations.summary, 'checkout-api 5 分钟重启 14 次')

  const [camel] = parseAlertPayload('nightingale', {
    ruleName: '节点磁盘满',
    severity: 'P1',
    isRecovered: true,
    tags: { instance: '10.0.0.8:9100' },
  })
  assert.equal(camel?.severity, 1)
  assert.equal(camel?.status, 'resolved')

  // 全局 Webhook 模板把级别放进 tags 时回退识别；顶层值优先。
  const [tagSeverity] = parseAlertPayload('nightingale', {
    rule_name: '标签里的级别',
    tags: 'cluster=prod,severity=P1',
  })
  assert.equal(tagSeverity?.severity, 1)
  const [topWins] = parseAlertPayload('nightingale', {
    rule_name: '顶层优先',
    severity: 3,
    tags: 'severity=P1',
  })
  assert.equal(topWins?.severity, 3)

  const wrapped = parseAlertPayload('nightingale', {
    events: [nightingalePayload(), nightingalePayload({ rule_name: 'CPU 高', severity: 3 })],
  })
  assert.equal(wrapped.length, 2)
  assert.equal(wrapped[1]?.name, 'CPU 高')
  const single = parseAlertPayload('nightingale', { event: nightingalePayload() })
  assert.equal(single.length, 1)

  const am = parseAlertPayload('alertmanager', {
    alerts: [
      {
        status: 'firing',
        labels: { alertname: 'KubePodCrashLooping', namespace: 'shop', severity: 'critical' },
        annotations: { summary: 'pod crash looping' },
        fingerprint: 'am-1',
        startsAt: '2026-11-23T00:00:00Z',
      },
      {
        status: 'resolved',
        labels: { alertname: 'KubePodCrashLooping', namespace: 'shop', severity: 'critical' },
        fingerprint: 'am-1',
      },
    ],
  })
  assert.equal(am.length, 2)
  assert.equal(am[0]?.severity, 1)
  assert.equal(am[1]?.status, 'resolved')
  assert.equal(am[0]?.labels.alertname, 'KubePodCrashLooping')

  assert.equal(severityOf(1), 1)
  assert.equal(severityOf('P3'), 3)
  assert.equal(severityOf('critical'), 1)
  assert.equal(severityOf('warning'), 2)
  assert.equal(severityOf('info'), 3)
  assert.equal(severityOf('unknown'), 2)
  assert.throws(() => parseAlertPayload('nightingale', {}), /没有可识别/)
  assert.throws(() => parseAlertPayload('nightingale', []), /告警内容为空/)
})

test('告警 webhook：管理员创建后按严重级别、去重和归属发起只读任务，支持顶层数组', async () => {
  const { dir, cleanup } = await tempDir()
  const notified: Array<{ ids: string[]; event: NotificationEvent }> = []
  let exposedTools: string[] = []
  const model: ChatModel = {
    async complete(input) {
      exposedTools = input.tools.map((tool) => tool.function.name)
      return { content: '排查完成：checkout-api 反复重启，建议查看最近变更', toolCalls: [] }
    },
  }
  const ctx = await boot({
    store: new AlertSourceStore(path.join(dir, 'alert-sources.json')),
    model,
    notifyTargets: (ids, event) => {
      notified.push({ ids, event })
      return Promise.resolve([{ webhook: 'ops-test', ok: true }])
    },
  })
  try {
    const forbidden = await api(ctx.base, 'alice', 'POST', '/api/alert-sources', {
      name: 'prod-k8s',
      format: 'nightingale',
      actorId: 'alice',
    })
    assert.equal(forbidden.status, 403)
    const created = await api(ctx.base, 'root', 'POST', '/api/alert-sources', {
      name: '生产告警',
      format: 'nightingale',
      actorId: 'alice',
      maxSeverity: 2,
      cooldownMs: 60_000,
      notifyWebhookIds: ['wh-1'],
    })
    assert.equal(created.status, 201)
    const source = created.body.source as { id: string; name: string; path: string }
    const token = created.body.token as string
    assert.equal(source.name, '生产告警')
    assert.ok(token)
    assert.equal(source.path, `https://aiops.example.com/api/hooks/alerts/${encodeURIComponent(source.id)}`)

    const listed = await api(ctx.base, 'eve', 'GET', '/api/alert-sources')
    assert.equal(listed.status, 200)
    assert.equal(listed.body.sources[0].tokenHash, undefined)
    assert.equal((await api(ctx.base, 'carol', 'GET', '/api/alert-sources')).status, 403)

    assert.equal((await hook(ctx.base, source.id, null, nightingalePayload())).status, 401)
    assert.equal((await hook(ctx.base, source.id, 'wrong-token', nightingalePayload())).status, 401)

    const resolved = await hook(ctx.base, source.id, token, nightingalePayload({ status: 'resolved' }))
    assert.equal(resolved.status, 202)
    assert.deepEqual(
      { accepted: resolved.body.accepted, reason: resolved.body.reason },
      { accepted: false, reason: 'resolved' },
    )

    const below = await hook(ctx.base, source.id, token, nightingalePayload({ severity: 3, hash: 'low' }))
    assert.equal(below.body.reason, 'below_threshold')

    const accepted = await hook(ctx.base, source.id, token, nightingalePayload())
    assert.equal(accepted.status, 202)
    assert.equal(accepted.body.accepted, true)
    const taskId = accepted.body.taskId as string
    const task = await ctx.platform.waitUntil(taskId, (item) => item.status === 'succeeded')
    assert.equal(task.origin, 'alert')
    assert.equal(task.alertSourceId, source.id)
    assert.equal(task.ownerId, 'alice')
    assert.equal(task.skill, 'k8s-troubleshooting')
    assert.match(task.result ?? '', /建议查看最近变更/)
    // 告警任务不向模型暴露任何变更工具；本测试没有工具，至少要证明过滤逻辑可执行。
    assert.equal(exposedTools.some((name) => /restart|delete|scale/.test(name)), false)

    const duplicate = await hook(ctx.base, source.id, token, nightingalePayload())
    assert.equal(duplicate.body.reason, 'duplicate')

    // 顶层数组是夜莺全局 Webhook 模板的常见形态；只对告警 hook 放行。
    const batch = await hook(ctx.base, source.id, token, [
      nightingalePayload({ rule_name: '批量数组告警', hash: 'array-1' }),
    ])
    assert.equal(batch.status, 202)
    assert.equal(batch.body.accepted, true)
    const batchTask = await ctx.platform.waitUntil(batch.body.taskId as string, (item) => item.status === 'succeeded')
    assert.equal(batchTask.origin, 'alert')
    const objectOnly = await api(ctx.base, 'alice', 'POST', '/api/tasks', [])
    assert.equal(objectOnly.status, 400)
    assert.equal(objectOnly.body.error?.code, 'bad_json')

    const detail = await api(ctx.base, 'alice', 'GET', `/api/tasks/${taskId}`)
    assert.equal(detail.status, 200)
    assert.equal((await api(ctx.base, 'carol', 'GET', `/api/tasks/${taskId}`)).status, 404)

    // 结果只推给接入源勾选的渠道。
    for (let i = 0; i < 50 && notified.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(notified[0]?.ids[0], 'wh-1')
    assert.equal(notified[0]?.event.type, 'alert.investigated')
    assert.match(notified[0]?.event.title ?? '', /告警排查完成/)

    // 投递结果异步写回任务事件，调用方不用盯着通知服务日志。
    let delivery: { data?: { webhooks?: unknown } } | undefined
    for (let i = 0; i < 50 && !delivery; i += 1) {
      const events = await api(ctx.base, 'alice', 'GET', `/api/tasks/${encodeURIComponent(taskId)}/events`)
      delivery = (events.body.events as Array<{ type: string; data?: { webhooks?: unknown } }> | undefined)
        ?.find((item) => item.type === 'alert.notify')
      if (!delivery) await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.deepEqual(delivery?.data?.webhooks, [{ webhook: 'ops-test', ok: true }])

    const rotated = await api(ctx.base, 'root', 'POST', `/api/alert-sources/${encodeURIComponent(source.id)}/rotate`, {})
    assert.equal(rotated.status, 200)
    const newToken = rotated.body.token as string
    assert.equal((await hook(ctx.base, source.id, token, nightingalePayload({ hash: 'after-rotate' }))).status, 401)
    assert.equal((await hook(ctx.base, source.id, newToken, nightingalePayload({ hash: 'after-rotate' }))).status, 202)
  } finally {
    await ctx.close()
    await cleanup()
  }
})

test('告警接入保存校验通知渠道存在，引用中的 webhook 不能删除', async () => {
  const { dir, cleanup } = await tempDir()
  const notifications = new NotificationStore(
    path.join(dir, 'notifications.json'),
    SecretBox.fromKey(Buffer.alloc(32, 7).toString('base64')),
  )
  const webhook = await notifications.create({
    name: 'ops-generic',
    url: 'https://example.com/hook',
    format: 'generic',
    events: ['task.failed'],
    enabled: true,
  })
  const ctx = await boot({
    store: new AlertSourceStore(path.join(dir, 'alert-sources.json')),
    notifications,
  })
  try {
    const missing = await api(ctx.base, 'root', 'POST', '/api/alert-sources', {
      name: 'missing-hook',
      format: 'nightingale',
      actorId: 'alice',
      notifyWebhookIds: ['wh-not-exist'],
    })
    assert.equal(missing.status, 400)

    const created = await api(ctx.base, 'root', 'POST', '/api/alert-sources', {
      name: 'with-hook',
      format: 'nightingale',
      actorId: 'alice',
      notifyWebhookIds: [webhook.id],
    })
    assert.equal(created.status, 201)
    const sourceId = created.body.source.id as string

    const blocked = await api(ctx.base, 'root', 'DELETE', `/api/notifications/webhooks/${encodeURIComponent(webhook.id)}`)
    assert.equal(blocked.status, 409)

    const cleared = await api(ctx.base, 'root', 'PUT', `/api/alert-sources/${encodeURIComponent(sourceId)}`, {
      notifyWebhookIds: [],
    })
    assert.equal(cleared.status, 200)
    const removed = await api(ctx.base, 'root', 'DELETE', `/api/notifications/webhooks/${encodeURIComponent(webhook.id)}`)
    assert.equal(removed.status, 200)
  } finally {
    await ctx.close()
    await cleanup()
  }
})

test('告警并发超限直接忽略，恢复后会继续接收', async () => {
  const { dir, cleanup } = await tempDir()
  const store = new AlertSourceStore(path.join(dir, 'alert-sources.json'))
  const one = await store.create({ name: 'prod-a', format: 'nightingale', actorId: 'alice' })
  const two = await store.create({ name: 'prod-b', format: 'nightingale', actorId: 'alice' })
  const ctx = await boot({ store, model: slowModel(120), alertMaxConcurrency: 1 })
  try {
    const first = await hook(ctx.base, one.source.id, one.token, nightingalePayload({ hash: 'a' }))
    assert.equal(first.body.accepted, true)
    const second = await hook(ctx.base, two.source.id, two.token, nightingalePayload({ hash: 'b' }))
    assert.equal(second.body.accepted, false)
    assert.equal(second.body.reason, 'capacity')
    await ctx.platform.waitUntil(first.body.taskId as string, (item) => item.status === 'succeeded')
    // waitUntil 只看任务状态，并发计数在 finally 里递减；等一拍避免读到旧计数。
    await new Promise((resolve) => setTimeout(resolve, 50))
    const third = await hook(ctx.base, two.source.id, two.token, nightingalePayload({ hash: 'b' }))
    assert.equal(third.body.accepted, true)
    await ctx.platform.waitUntil(third.body.taskId as string, (item) => item.status === 'succeeded')
  } finally {
    await ctx.close()
    await cleanup()
  }
})

test('告警测试按钮用模拟告警跳过冷却，停用源也能测', async () => {
  const { dir, cleanup } = await tempDir()
  const ctx = await boot({
    store: new AlertSourceStore(path.join(dir, 'alert-sources.json')),
    model: finalModel(),
  })
  try {
    const created = await api(ctx.base, 'root', 'POST', '/api/alert-sources', {
      name: 'staging',
      format: 'alertmanager',
      actorId: 'alice',
      enabled: false,
    })
    const id = created.body.source.id as string
    const first = await api(ctx.base, 'root', 'POST', `/api/alert-sources/${encodeURIComponent(id)}/test`, {})
    assert.equal(first.status, 202)
    assert.equal(first.body.accepted, true)
    await ctx.platform.waitUntil(first.body.taskId as string, (item) => item.status === 'succeeded')
    const second = await api(ctx.base, 'root', 'POST', `/api/alert-sources/${encodeURIComponent(id)}/test`, {})
    assert.equal(second.body.accepted, true)
    await ctx.platform.waitUntil(second.body.taskId as string, (item) => item.status === 'succeeded')
    assert.equal((await api(ctx.base, 'alice', 'POST', `/api/alert-sources/${encodeURIComponent(id)}/test`, {})).status, 403)
  } finally {
    await ctx.close()
    await cleanup()
  }
})