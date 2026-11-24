import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  approvalDeepLink,
  NotificationStore,
  Notifier,
  signDingtalkUrl,
} from '../src/notifications.ts'
import { SecretBox } from '../src/secret-box.ts'

const KEY = Buffer.alloc(32, 21).toString('base64')
const SECRET_URL = 'https://oapi.dingtalk.com/robot/send?access_token=SECRET-TOKEN'

async function tempFile(): Promise<{ file: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'aiops-notify-'))
  return {
    file: path.join(dir, 'notifications.json'),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

function recorder(response: () => Response = () => new Response(JSON.stringify({ errcode: 0 }), { status: 200 })) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) })
    return response()
  }) as typeof fetch
  return { calls, fetchImpl }
}

test('通知 webhook：URL 加密落盘、列表只返回 host，更新时留空保持原值', async () => {
  const { file, cleanup } = await tempFile()
  try {
    const box = SecretBox.fromKey(KEY)
    const store = new NotificationStore(file, box)
    const created = await store.create({
      name: 'ops-dingtalk',
      url: SECRET_URL,
      format: 'dingtalk',
      events: ['approval.pending', 'task.failed'],
      enabled: true,
    })
    assert.equal(created.urlHost, 'oapi.dingtalk.com')
    assert.equal('url' in created, false)
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    const raw = await readFile(file, 'utf8')
    assert.equal(raw.includes('SECRET-TOKEN'), false)
    assert.match(raw, /enc:v1:/)

    await store.update(created.id, { name: 'ops-dingtalk', format: 'wecom', events: ['task.failed'], enabled: false })
    const reopened = new NotificationStore(file, box)
    const [webhook] = await reopened.all()
    assert.equal(webhook?.url, SECRET_URL)
    assert.equal(webhook?.format, 'wecom')
    assert.deepEqual(webhook?.events, ['task.failed'])
    assert.equal(webhook?.enabled, false)

    assert.deepEqual(await reopened.settings(), { enabled: true, minIntervalMs: 60_000 })
    assert.deepEqual(await reopened.updateSettings({ enabled: false, minIntervalMs: 0 }), {
      enabled: false,
      minIntervalMs: 0,
    })
  } finally {
    await cleanup()
  }
})

test('通知 webhook 校验：非本机 http、未知事件和重复名称都拒绝', async () => {
  const { file, cleanup } = await tempFile()
  try {
    const store = new NotificationStore(file, SecretBox.fromKey(KEY))
    await assert.rejects(
      () => store.create({ name: 'bad-http', url: 'http://example.com/hook', format: 'generic' }),
      /必须使用 https/,
    )
    await assert.rejects(
      () => store.create({ name: 'bad-proto', url: 'ftp://example.com/hook', format: 'generic' }),
      /必须是 http\(s\)/,
    )
    await assert.rejects(
      () => store.create({ name: 'bad-user', url: 'https://user:pass@example.com/hook', format: 'generic' }),
      /不能包含用户名或密码/,
    )
    await assert.rejects(
      () => store.create({ name: 'bad-event', url: SECRET_URL, format: 'dingtalk', events: ['root'] }),
      /未知事件/,
    )
    await store.create({ name: 'ops', url: SECRET_URL, format: 'dingtalk', events: ['task.failed'] })
    await assert.rejects(
      () => store.create({ name: 'ops', url: SECRET_URL, format: 'dingtalk', events: ['task.failed'] }),
      /名称重复/,
    )
    // 本机 http 允许，方便本地 webhook 联调。
    const local = await store.create({
      name: 'local-sink',
      url: 'http://127.0.0.1:9999/hook',
      format: 'generic',
      events: ['task.failed'],
    })
    assert.equal(local.urlHost, '127.0.0.1:9999')
  } finally {
    await cleanup()
  }
})

test('钉钉加签：密钥加密落盘、只回显 hasSecret、按 timestamp 计算 HMAC', async () => {
  const { file, cleanup } = await tempFile()
  try {
    const box = SecretBox.fromKey(KEY)
    const store = new NotificationStore(file, box)
    const secret = 'SECtest-sign-secret'
    const created = await store.create({
      name: 'ding',
      url: SECRET_URL,
      format: 'dingtalk',
      events: ['approval.pending'],
      secret,
    })
    assert.equal(created.hasSecret, true)
    assert.equal('secret' in created, false)
    const raw = await readFile(file, 'utf8')
    assert.equal(raw.includes(secret), false)
    assert.match(raw, /enc:v1:/)

    // 重新加载后密钥可用，留空更新保持原值。
    const reopened = new NotificationStore(file, box)
    await reopened.update(created.id, { name: 'ding', format: 'dingtalk' })
    assert.equal((await reopened.all())[0]?.secret, secret)

    // 显式清除。
    const cleared = await reopened.update(created.id, { name: 'ding', format: 'dingtalk', clearSecret: true })
    assert.equal(cleared.hasSecret, false)
    assert.equal((await reopened.all())[0]?.secret, undefined)

    // 加签只对钉钉格式有效。
    await assert.rejects(
      () => store.create({ name: 'wecom-sign', url: 'https://qyapi.weixin.qq.com/x', format: 'wecom', secret }),
      /只在钉钉加签时使用/,
    )
  } finally {
    await cleanup()
  }
})

test('钉钉加签 URL 符合官方算法：timestamp + sign，保留原有查询参数', () => {
  const secret = 'SECtest-sign-secret'
  const timestamp = 1_700_000_000_000
  const signed = signDingtalkUrl('https://oapi.dingtalk.com/robot/send?access_token=abc', secret, timestamp)
  const parsed = new URL(signed)
  assert.equal(parsed.searchParams.get('timestamp'), String(timestamp))
  assert.equal(parsed.searchParams.get('access_token'), 'abc')
  const expected = createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64')
  assert.equal(parsed.searchParams.get('sign'), expected)
})

test('钉钉加签 webhook 发送时使用带签名的 URL，列表和审计不出现密钥', async () => {
  const { file, cleanup } = await tempFile()
  try {
    const store = new NotificationStore(file, SecretBox.fromKey(KEY))
    const secret = 'SECtest-sign-secret'
    const created = await store.create({ name: 'ding', url: SECRET_URL, format: 'dingtalk', events: ['task.failed'], secret })
    const { calls, fetchImpl } = recorder()
    let clock = new Date('2026-11-20T10:00:00.000Z')
    const notifier = new Notifier(store, { fetch: fetchImpl, now: () => clock })
    const results = await notifier.send({ type: 'task.failed', title: 'x', text: 'y', dedupeKey: 't1' })
    assert.deepEqual(results, [{ webhook: 'ding', ok: true }])
    const sent = new URL(calls[0]!.url)
    assert.equal(sent.searchParams.get('timestamp'), String(clock.getTime()))
    assert.ok(sent.searchParams.get('sign'))
    assert.equal(JSON.stringify(await store.list()).includes(secret), false)
    assert.equal((await store.get(created.id))?.hasSecret, true)
  } finally {
    await cleanup()
  }
})

test('通知投递：按格式组装、失败隔离、同一实体按间隔节流', async () => {
  const { file, cleanup } = await tempFile()
  try {
    const store = new NotificationStore(file, SecretBox.fromKey(KEY))
    await store.create({
      name: 'generic',
      url: 'http://127.0.0.1:9999/hook',
      format: 'generic',
      events: ['task.failed'],
      enabled: true,
    })
    const { calls, fetchImpl } = recorder()
    let clock = new Date('2026-11-20T10:00:00.000Z')
    const notifier = new Notifier(store, { fetch: fetchImpl, now: () => clock })

    const event = {
      type: 'task.failed' as const,
      title: '任务失败',
      text: 'checkout-api 排查失败',
      dedupeKey: 'task_1',
      detail: { taskId: 'task_1' },
    }
    const first = await notifier.send(event)
    assert.deepEqual(first, [{ webhook: 'generic', ok: true }])
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.url, 'http://127.0.0.1:9999/hook')
    assert.equal(calls[0]?.body.source, 'aiops-harness')
    assert.equal(calls[0]?.body.type, 'task.failed')
    assert.deepEqual(calls[0]?.body.detail, { taskId: 'task_1' })

    // 默认 60 秒内同一 dedupeKey 直接丢弃，不打到 webhook。
    const throttled = await notifier.send(event)
    assert.deepEqual(throttled, [])
    assert.equal(calls.length, 1)

    // 不同实体不互相影响。
    await notifier.send({ ...event, dedupeKey: 'task_2' })
    assert.equal(calls.length, 2)

    clock = new Date(clock.getTime() + 61_000)
    await notifier.send(event)
    assert.equal(calls.length, 3)
    await store.updateSettings({ enabled: false })
    assert.deepEqual(await notifier.send({ ...event, dedupeKey: 'task_3' }), [])
    assert.equal(calls.length, 3)
  } finally {
    await cleanup()
  }
})

test('审批通知带平台深链，通用 JSON 和 markdown 都能点开', async () => {
  const { file, cleanup } = await tempFile()
  try {
    assert.equal(approvalDeepLink('https://aiops.example.com//', 'ap_123'), 'https://aiops.example.com/#/approvals/ap_123')
    const store = new NotificationStore(file, SecretBox.fromKey(KEY))
    await store.create({ name: 'generic', url: 'http://127.0.0.1:9999/hook', format: 'generic', events: ['approval.pending'] })
    await store.create({ name: 'ding', url: SECRET_URL, format: 'dingtalk', events: ['approval.pending'] })
    const { calls, fetchImpl } = recorder()
    const notifier = new Notifier(store, { fetch: fetchImpl })
    const link = approvalDeepLink('https://aiops.example.com', 'ap_123')
    await notifier.send({
      type: 'approval.pending',
      title: '有新的变更待审批',
      text: '工具 k8s.delete_pod 正在等待人工审批。',
      dedupeKey: 'ap_123',
      detail: { approvalId: 'ap_123' },
      link,
    })
    const generic = calls.find((call) => call.body.source === 'aiops-harness')
    assert.equal(generic?.body.link, link)
    const ding = calls.find((call) => call.body.msgtype === 'markdown')
    assert.ok(String((ding?.body.markdown as { text?: string })?.text).includes(`[打开审批详情](${link})`))
  } finally {
    await cleanup()
  }
})

test('钉钉/企业微信推送：errcode 非 0 记为失败，成功格式带 markdown', async () => {
  const { file, cleanup } = await tempFile()
  try {
    const store = new NotificationStore(file, SecretBox.fromKey(KEY))
    await store.create({ name: 'ding', url: SECRET_URL, format: 'dingtalk', events: ['task.failed'] })
    await store.create({
      name: 'wecom',
      url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=SECRET',
      format: 'wecom',
      events: ['task.failed'],
    })
    const { calls, fetchImpl } = recorder(
      () => new Response(JSON.stringify({ errcode: 93000, errmsg: 'invalid webhook url' }), { status: 200 }),
    )
    const notifier = new Notifier(store, { fetch: fetchImpl })
    const results = await notifier.send({ type: 'task.failed', title: '任务失败', text: 'x', dedupeKey: 't1' })
    assert.equal(results.length, 2)
    assert.equal(results.every((item) => item.ok === false), true)
    assert.match(results[0]?.error ?? '', /errcode=93000/)
    const ding = calls.find((call) => call.body.msgtype === 'markdown')
    assert.ok(ding)
    assert.equal((ding.body.markdown as { title: string }).title.includes('任务失败'), true)
    const wecom = calls.find((call) => call.url.includes('qyapi.weixin.qq.com'))
    assert.equal(typeof (wecom?.body.markdown as { content?: string })?.content, 'string')
    // 错误信息不能带完整 URL 或 token。
    assert.equal(results.some((item) => item.error?.includes('SECRET')), false)
  } finally {
    await cleanup()
  }
})

test('通知数据解密失败时直接报错，不清空原文件', async () => {
  const { file, cleanup } = await tempFile()
  try {
    const first = new NotificationStore(file, SecretBox.fromKey(KEY))
    await first.create({ name: 'ops', url: SECRET_URL, format: 'dingtalk', events: ['task.failed'] })
    const before = await readFile(file, 'utf8')

    const otherKey = Buffer.alloc(32, 22).toString('base64')
    const broken = new NotificationStore(file, SecretBox.fromKey(otherKey))
    await assert.rejects(() => broken.list(), /解密失败/)
    assert.equal(await readFile(file, 'utf8'), before)
  } finally {
    await cleanup()
  }
})