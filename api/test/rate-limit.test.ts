import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from '../src/http.ts'
import { counterValue, resetCounters } from '../src/metrics.ts'
import type { Platform } from '../src/platform.ts'
import { FixedWindowLimiter, rateLimitConfig } from '../src/rate-limit.ts'

test('固定窗口限流：达到上限后拒绝，窗口结束后恢复', () => {
  let now = 1_000
  const limiter = new FixedWindowLimiter({ windowMs: 10_000, now: () => now })
  assert.equal(limiter.check('a', 2).allowed, true)
  assert.equal(limiter.check('a', 2).allowed, true)
  const blocked = limiter.check('a', 2)
  assert.equal(blocked.allowed, false)
  assert.equal(blocked.retryAfterSec, 10)
  assert.equal(limiter.check('b', 2).allowed, true)
  now += 10_001
  assert.equal(limiter.check('a', 2).allowed, true)
})

test('限流配置默认值、关闭开关和非法值回退', () => {
  assert.deepEqual(rateLimitConfig({}), { windowMs: 60_000, max: 1200, writeMax: 60, loginMax: 15 })
  assert.equal(rateLimitConfig({ AIOPS_RATE_LIMIT_DISABLED: '1' }), undefined)
  const parsed = rateLimitConfig({ AIOPS_RATE_LIMIT_MAX: '5', AIOPS_RATE_LIMIT_WINDOW_MS: '1000' })
  assert.equal(parsed?.max, 5)
  assert.equal(parsed?.windowMs, 1000)
  const invalid = rateLimitConfig({ AIOPS_RATE_LIMIT_MAX: 'abc', AIOPS_RATE_LIMIT_WRITE_MAX: '-1' })
  assert.equal(invalid?.max, 1200)
  assert.equal(invalid?.writeMax, 60)
})

async function listen(server: ReturnType<typeof createServer>): Promise<{ base: string; close: () => Promise<void> }> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('没有端口')
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function boot(env: Record<string, string>) {
  const previous: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key]
    process.env[key] = value
  }
  resetCounters()
  const platform = { listActors: () => [] } as unknown as Platform
  const server = createServer(platform, { internalToken: 'test-token' })
  return {
    running: await listen(server),
    restore: async () => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      resetCounters()
    },
  }
}

test('一般请求按客户端 IP 限流，返回 429 和 Retry-After', async () => {
  const ctx = await boot({ AIOPS_RATE_LIMIT_MAX: '2', AIOPS_RATE_LIMIT_LOGIN_MAX: '100' })
  try {
    assert.equal((await fetch(`${ctx.running.base}/api/actors`)).status, 200)
    assert.equal((await fetch(`${ctx.running.base}/api/actors`)).status, 200)
    const blocked = await fetch(`${ctx.running.base}/api/actors`)
    assert.equal(blocked.status, 429)
    assert.ok(Number(blocked.headers.get('retry-after')) >= 1)
    const body = (await blocked.json()) as { error: { code: string } }
    assert.equal(body.error.code, 'rate_limited')
    assert.equal(counterValue('aiops_rate_limited_total', { scope: 'general' }), 1)
    // 健康检查不受限流影响
    assert.equal((await fetch(`${ctx.running.base}/health`)).status, 200)
  } finally {
    await ctx.running.close()
    await ctx.restore()
  }
})

test('默认不信任 X-Forwarded-For，伪造头不能绕过 IP 限流', async () => {
  const ctx = await boot({ AIOPS_RATE_LIMIT_MAX: '2', AIOPS_RATE_LIMIT_LOGIN_MAX: '100', AIOPS_TRUST_PROXY: '0' })
  try {
    const request = (forwarded: string) =>
      fetch(`${ctx.running.base}/api/actors`, { headers: { 'x-forwarded-for': forwarded } })
    assert.equal((await request('1.1.1.1')).status, 200)
    assert.equal((await request('2.2.2.2')).status, 200)
    assert.equal((await request('3.3.3.3')).status, 429)
  } finally {
    await ctx.running.close()
    await ctx.restore()
  }
})

test('AIOPS_TRUST_PROXY=1 时取 XFF 最右侧地址，忽略左侧伪造值', async () => {
  const ctx = await boot({ AIOPS_RATE_LIMIT_MAX: '2', AIOPS_RATE_LIMIT_LOGIN_MAX: '100', AIOPS_TRUST_PROXY: '1' })
  try {
    const request = (forwarded: string) =>
      fetch(`${ctx.running.base}/api/actors`, { headers: { 'x-forwarded-for': forwarded } })
    assert.equal((await request('8.8.8.8, 1.1.1.1')).status, 200)
    assert.equal((await request('9.9.9.9, 1.1.1.1')).status, 200)
    // 最右侧仍是 1.1.1.1，第三次必须被限流；如果错取第一段会误放行。
    assert.equal((await request('7.7.7.7, 1.1.1.1')).status, 429)
    assert.equal((await request('8.8.8.8, 2.2.2.2')).status, 200)
  } finally {
    await ctx.running.close()
    await ctx.restore()
  }
})

test('写请求按账号单独限流，不影响同账号的读请求', async () => {
  const ctx = await boot({
    AIOPS_RATE_LIMIT_MAX: '100',
    AIOPS_RATE_LIMIT_WRITE_MAX: '1',
    AIOPS_RATE_LIMIT_LOGIN_MAX: '100',
  })
  const headers = { 'x-actor-id': 'alice' }
  try {
    const first = await fetch(`${ctx.running.base}/api/unknown`, { method: 'POST', headers })
    assert.equal(first.status, 404)
    const second = await fetch(`${ctx.running.base}/api/unknown`, { method: 'POST', headers })
    assert.equal(second.status, 429)
    assert.equal(counterValue('aiops_rate_limited_total', { scope: 'write' }), 1)
    assert.equal((await fetch(`${ctx.running.base}/api/actors`, { headers })).status, 200)
  } finally {
    await ctx.running.close()
    await ctx.restore()
  }
})

test('AIOPS_RATE_LIMIT_DISABLED=1 时不限流', async () => {
  const ctx = await boot({ AIOPS_RATE_LIMIT_DISABLED: '1', AIOPS_RATE_LIMIT_MAX: '1' })
  try {
    for (let index = 0; index < 3; index += 1) {
      assert.equal((await fetch(`${ctx.running.base}/api/actors`)).status, 200)
    }
  } finally {
    await ctx.running.close()
    await ctx.restore()
  }
})