import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  AuthError,
  AuthService,
  hashPassword,
  toApiKeyView,
  verifyPassword,
} from '../src/auth.ts'
import { MemoryAuthStore } from '../src/auth-store.ts'
import { compose } from '../src/compose.ts'
import { MemoryStore } from '../src/store.ts'

const PASSWORD = 'correct horse battery staple'

function setup(options: { maxLoginFailures?: number; sessionTouchMs?: number; apiKeyEventMs?: number } = {}) {
  let clock = new Date('2026-11-19T00:00:00.000Z')
  const store = new MemoryAuthStore()
  const service = new AuthService(store, {
    now: () => clock,
    maxLoginFailures: options.maxLoginFailures,
    sessionTouchMs: options.sessionTouchMs,
    apiKeyEventMs: options.apiKeyEventMs,
    lockoutMs: 60_000,
    failureWindowMs: 60_000,
  })
  return {
    store,
    service,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms)
    },
    now: () => clock,
  }
}

test('scrypt 密码哈希可验证，错误密码和坏格式都返回 false', async () => {
  const hash = await hashPassword(PASSWORD)
  assert.notEqual(hash, PASSWORD)
  assert.equal(await verifyPassword(PASSWORD, hash), true)
  assert.equal(await verifyPassword('wrong password', hash), false)
  assert.equal(await verifyPassword(PASSWORD, undefined), false)
  assert.equal(await verifyPassword(PASSWORD, 'scrypt$bad'), false)
  assert.equal(await verifyPassword(PASSWORD, 'scrypt$16384$8$1$@@@$@@@'), false)
})

test('本地用户可以登录，会话可验证，公开视图不含密码哈希', async () => {
  const ctx = setup()
  const user = await ctx.service.createUser({
    username: 'Alice',
    displayName: 'Alice',
    password: PASSWORD,
    roles: ['operator'],
  })
  assert.equal(user.username, 'alice')
  assert.equal(user.passwordHash?.startsWith('scrypt$'), true)

  const login = await ctx.service.login('alice', PASSWORD, { ip: '127.0.0.1' })
  assert.equal(login.user.username, 'alice')
  assert.equal('passwordHash' in login.user, false)
  assert.equal(login.token.length > 20, true)
  assert.equal(login.csrfToken.length > 10, true)

  const verified = await ctx.service.verifySession(login.token)
  assert.equal(verified?.user.id, user.id)
  assert.equal(verified?.session.csrfToken, login.csrfToken)

  await assert.rejects(
    () => ctx.service.login('alice', 'wrong password', {}),
    (error: unknown) => error instanceof AuthError && error.code === 'invalid_credentials',
  )

  await ctx.service.updateUser(user.id, { status: 'disabled' })
  assert.equal(await ctx.service.verifySession(login.token), undefined)
  await assert.rejects(
    () => ctx.service.login('alice', PASSWORD, {}),
    (error: unknown) => error instanceof AuthError && error.code === 'invalid_credentials',
  )
})

test('会话按空闲时间和绝对时间过期，登出立即失效', async () => {
  const ctx = setup()
  await ctx.service.createUser({ username: 'alice', password: PASSWORD, roles: ['operator'] })
  const first = await ctx.service.login('alice', PASSWORD)
  ctx.advance(12 * 60 * 60 * 1000 + 1)
  assert.equal(await ctx.service.verifySession(first.token), undefined)

  const second = await ctx.service.login('alice', PASSWORD)
  ctx.advance(7 * 24 * 60 * 60 * 1000 + 1)
  assert.equal(await ctx.service.verifySession(second.token), undefined)

  const third = await ctx.service.login('alice', PASSWORD)
  await ctx.service.logout(third.token)
  assert.equal(await ctx.service.verifySession(third.token), undefined)
})

test('登录失败达到阈值后锁定，过期后可以恢复', async () => {
  const ctx = setup({ maxLoginFailures: 3 })
  await ctx.service.createUser({ username: 'alice', password: PASSWORD, roles: ['operator'] })
  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(
      () => ctx.service.login('alice', 'wrong password', { ip: '10.0.0.1' }),
      (error: unknown) => error instanceof AuthError && error.code === 'invalid_credentials',
    )
  }
  await assert.rejects(
    () => ctx.service.login('alice', PASSWORD, { ip: '10.0.0.1' }),
    (error: unknown) => error instanceof AuthError && error.code === 'locked' && error.status === 429,
  )
  ctx.advance(60_001)
  const login = await ctx.service.login('alice', PASSWORD, { ip: '10.0.0.1' })
  assert.equal(login.user.username, 'alice')
})

test('登录失败计数在共享存储里，多个实例共用同一把锁', async () => {
  const store = new MemoryAuthStore()
  let clock = new Date('2026-11-19T00:00:00.000Z')
  const options = {
    now: () => clock,
    maxLoginFailures: 2,
    failureWindowMs: 60_000,
    lockoutMs: 60_000,
  }
  const first = new AuthService(store, options)
  const second = new AuthService(store, options)
  await first.createUser({ username: 'alice', password: PASSWORD, roles: ['operator'] })
  for (let index = 0; index < 2; index += 1) {
    await assert.rejects(
      () => first.login('alice', 'wrong password', { ip: '10.0.0.1' }),
      (error: unknown) => error instanceof AuthError && error.code === 'invalid_credentials',
    )
  }
  // 另一个实例看到同样的失败记录，直接拒绝。
  await assert.rejects(
    () => second.login('alice', PASSWORD, { ip: '10.0.0.1' }),
    (error: unknown) => error instanceof AuthError && error.code === 'locked',
  )
  clock = new Date(clock.getTime() + 60_001)
  assert.equal((await second.login('alice', PASSWORD, { ip: '10.0.0.1' })).user.username, 'alice')
})

test('会话可以列出、按会话注销，也可以保留当前会话注销其它会话', async () => {
  const ctx = setup()
  const user = await ctx.service.createUser({ username: 'alice', password: PASSWORD, roles: ['operator'] })
  const first = await ctx.service.login('alice', PASSWORD)
  const second = await ctx.service.login('alice', PASSWORD)

  const sessions = await ctx.service.listActiveSessions(user.id)
  assert.equal(sessions.length, 2)
  assert.equal(new Set(sessions.map((session) => session.id)).size, 2)
  assert.equal('tokenHash' in sessions[0]!, false)

  const currentId = (await ctx.service.verifySession(first.token))?.session.id
  const secondSession = (await ctx.service.listActiveSessions(user.id)).find(
    (session) => session.id !== currentId,
  )
  assert.ok(secondSession)
  assert.equal(await ctx.service.revokeSession(user.id, secondSession.id), true)
  assert.equal(await ctx.service.verifySession(second.token), undefined)
  assert.ok(await ctx.service.verifySession(first.token))

  const third = await ctx.service.login('alice', PASSWORD)
  assert.equal(await ctx.service.revokeOtherSessions(user.id, third.token), 1)
  assert.equal(await ctx.service.verifySession(first.token), undefined)
  assert.ok(await ctx.service.verifySession(third.token))
  assert.equal((await ctx.service.listActiveSessions(user.id)).length, 1)
})

test('API key 到期会标记 expiringSoon，过期/吊销后按保留期清理', async () => {
  const ctx = setup()
  const user = await ctx.service.createUser({ username: 'alice', password: PASSWORD, roles: ['operator'] })
  const soon = await ctx.service.createApiKey(user.id, {
    name: 'soon',
    scopes: ['tasks:read'],
    expiresAt: new Date(ctx.now().getTime() + 3 * 86_400_000).toISOString(),
  })
  const later = await ctx.service.createApiKey(user.id, {
    name: 'later',
    scopes: ['tasks:read'],
    expiresAt: new Date(ctx.now().getTime() + 30 * 86_400_000).toISOString(),
  })
  const listed = await ctx.service.listApiKeys(user.id)
  assert.equal(listed.find((key) => key.id === soon.key.id)?.expiringSoon, true)
  assert.equal(listed.find((key) => key.id === later.key.id)?.expiringSoon, undefined)
  assert.deepEqual((await ctx.service.expiringApiKeys(7)).map((key) => key.id), [soon.key.id])
  // 已过期的 key 不再提醒，只等保留期清理。
  ctx.advance(4 * 86_400_000)
  assert.deepEqual(await ctx.service.expiringApiKeys(7), [])

  await ctx.service.revokeApiKey(later.key.id)
  ctx.advance(40 * 86_400_000)
  assert.equal(await ctx.service.cleanupApiKeys(new Date(ctx.now().getTime() - 30 * 86_400_000).toISOString()), 2)
  assert.deepEqual(await ctx.service.listApiKeys(user.id), [])
})

test('改密会校验旧密码、吊销其他会话并保留当前会话', async () => {
  const ctx = setup()
  const user = await ctx.service.createUser({ username: 'alice', password: PASSWORD, roles: ['operator'] })
  const keep = await ctx.service.login('alice', PASSWORD)
  const other = await ctx.service.login('alice', PASSWORD)

  await assert.rejects(
    () => ctx.service.changePassword(user.id, 'wrong password', 'a new long password'),
    (error: unknown) => error instanceof AuthError && error.code === 'invalid_credentials',
  )
  await ctx.service.changePassword(user.id, PASSWORD, 'a new long password', keep.token)

  assert.ok(await ctx.service.verifySession(keep.token))
  assert.equal(await ctx.service.verifySession(other.token), undefined)
  await assert.rejects(
    () => ctx.service.login('alice', PASSWORD, {}),
    (error: unknown) => error instanceof AuthError && error.code === 'invalid_credentials',
  )
  assert.ok(await ctx.service.login('alice', 'a new long password', {}))
})

test('API key 只返回一次明文，可解析、吊销和过期', async () => {
  const ctx = setup()
  const user = await ctx.service.createUser({ username: 'alice', password: PASSWORD, roles: ['operator'] })
  const created = await ctx.service.createApiKey(user.id, {
    name: 'dsh-local',
    scopes: ['tasks:write', 'tools:execute'],
  })
  assert.match(created.token, /^aiops_key[0-9a-f]+_/)
  assert.equal('tokenHash' in created.key, false)
  assert.equal('token' in toApiKeyView((await ctx.store.getApiKey(created.key.id))!), false)

  const resolved = await ctx.service.resolveApiKey(created.token, { ip: '127.0.0.1' })
  assert.equal(resolved?.user.id, user.id)
  assert.deepEqual(resolved?.key.scopes, ['tasks:write', 'tools:execute'])
  assert.equal(await ctx.service.resolveApiKey(`${created.token}x`), undefined)

  assert.equal(await ctx.service.revokeApiKey(created.key.id), true)
  assert.equal(await ctx.service.resolveApiKey(created.token), undefined)

  const expiring = await ctx.service.createApiKey(user.id, {
    name: 'temporary',
    scopes: ['tasks:read'],
    expiresAt: new Date(ctx.now().getTime() + 1000).toISOString(),
  })
  ctx.advance(1001)
  assert.equal(await ctx.service.resolveApiKey(expiring.token), undefined)
})

test('API key 使用事件按间隔降噪，lastUsedAt 仍按 touch 间隔更新', async () => {
  const ctx = setup({ sessionTouchMs: 60_000, apiKeyEventMs: 3_600_000 })
  const user = await ctx.service.createUser({ username: 'alice', password: PASSWORD, roles: ['operator'] })
  const created = await ctx.service.createApiKey(user.id, { name: 'noisy', scopes: ['tasks:read'] })
  const usageEvents = async () =>
    (await ctx.store.listSecurityEvents(100)).filter((event) => event.type === 'auth.api_key_used').length

  await ctx.service.resolveApiKey(created.token)
  assert.equal(await usageEvents(), 1)
  const firstTouch = (await ctx.store.getApiKey(created.key.id))?.lastUsedAt
  assert.ok(firstTouch)

  // 60 秒后再次使用：刷新 lastUsedAt，但不记事件。
  ctx.advance(61_000)
  await ctx.service.resolveApiKey(created.token)
  assert.equal(await usageEvents(), 1)
  assert.notEqual((await ctx.store.getApiKey(created.key.id))?.lastUsedAt, firstTouch)

  // 闲置超过事件间隔后的首次使用：补一条事件。
  ctx.advance(3_600_000)
  await ctx.service.resolveApiKey(created.token)
  assert.equal(await usageEvents(), 2)
})

test('API key 轮换：新 token 生效，旧 token 立即失效，scope 和剩余寿命保留', async () => {
  const ctx = setup()
  const user = await ctx.service.createUser({ username: 'alice', password: PASSWORD, roles: ['operator'] })
  const old = await ctx.service.createApiKey(user.id, {
    name: 'dsh-local',
    scopes: ['tasks:write', 'tools:execute'],
    expiresAt: new Date(ctx.now().getTime() + 10_000).toISOString(),
  })
  const rotated = await ctx.service.rotateApiKey(old.key.id, user.id)
  assert.notEqual(rotated.key.id, old.key.id)
  assert.deepEqual(rotated.key.scopes, old.key.scopes)
  assert.equal(rotated.key.name, old.key.name)
  assert.equal(rotated.key.expiresAt, new Date(ctx.now().getTime() + 10_000).toISOString())
  assert.equal(await ctx.service.resolveApiKey(old.token), undefined)
  assert.equal((await ctx.service.resolveApiKey(rotated.token))?.key.id, rotated.key.id)
  assert.ok((await ctx.store.getApiKey(old.key.id))?.revokedAt)
  assert.ok((await ctx.store.listSecurityEvents(20)).some((event) => event.type === 'auth.api_key_rotated'))
  await assert.rejects(
    () => ctx.service.rotateApiKey(old.key.id),
    (error: unknown) => error instanceof AuthError && error.code === 'bad_request',
  )
})

test('AIOPS_API_KEY_TTL_DAYS 给未指定过期时间的 key 一个默认有效期', async (t) => {
  const previous = process.env.AIOPS_API_KEY_TTL_DAYS
  process.env.AIOPS_API_KEY_TTL_DAYS = '1'
  t.after(() => {
    if (previous === undefined) delete process.env.AIOPS_API_KEY_TTL_DAYS
    else process.env.AIOPS_API_KEY_TTL_DAYS = previous
  })
  const ctx = setup()
  const user = await ctx.service.createUser({ username: 'alice', password: PASSWORD, roles: ['operator'] })
  const created = await ctx.service.createApiKey(user.id, { name: 'default-ttl', scopes: ['tasks:read'] })
  assert.equal(created.key.expiresAt, new Date(ctx.now().getTime() + 86_400_000).toISOString())
  ctx.advance(86_400_001)
  assert.equal(await ctx.service.resolveApiKey(created.token), undefined)
})

test('用户至少有一个角色，API key scope 必须合法', async () => {
  const ctx = setup()
  await assert.rejects(
    () => ctx.service.createUser({ username: 'alice', password: PASSWORD, roles: [] }),
    (error: unknown) => error instanceof AuthError && error.code === 'invalid_roles',
  )
  await assert.rejects(
    () => ctx.service.createUser({ username: 'alice', password: 'short', roles: ['viewer'] }),
    (error: unknown) => error instanceof AuthError && error.code === 'weak_password',
  )
  const user = await ctx.service.createUser({ username: 'alice', password: PASSWORD, roles: ['viewer'] })
  await assert.rejects(
    () => ctx.service.createApiKey(user.id, { name: 'bad', scopes: ['root' as never] }),
    (error: unknown) => error instanceof AuthError && error.code === 'invalid_scopes',
  )
})

test('安全事件记录登录和 key 操作，且不含密码或 token 明文', async () => {
  const ctx = setup()
  const user = await ctx.service.createUser({ username: 'alice', password: PASSWORD, roles: ['operator'] })
  await ctx.service.login('alice', PASSWORD, { ip: '127.0.0.1' })
  const created = await ctx.service.createApiKey(user.id, { name: 'dsh', scopes: ['tools:execute'] })
  await ctx.service.revokeApiKey(created.key.id)

  const events = await ctx.service.listSecurityEvents()
  const types = events.map((event) => event.type)
  assert.ok(types.includes('auth.user_created'))
  assert.ok(types.includes('auth.login_succeeded'))
  assert.ok(types.includes('auth.api_key_created'))
  assert.ok(types.includes('auth.api_key_revoked'))
  const serialized = JSON.stringify(events)
  assert.equal(serialized.includes(PASSWORD), false)
  assert.equal(serialized.includes(created.token), false)
})
test('AIOPS_AUTH=local 时空库 bootstrap 管理员，actors 来自账号而不是种子', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'aiops-auth-compose-'))
  const previous = {
    AIOPS_AUTH: process.env.AIOPS_AUTH,
    AIOPS_ADMIN_USERNAME: process.env.AIOPS_ADMIN_USERNAME,
    AIOPS_ADMIN_PASSWORD: process.env.AIOPS_ADMIN_PASSWORD,
    AIOPS_INTERNAL_TOKEN: process.env.AIOPS_INTERNAL_TOKEN,
    AIOPS_MCP_HEALTH_MS: process.env.AIOPS_MCP_HEALTH_MS,
  }
  const store = new MemoryStore()
  try {
    const config = {
      // K8s ConfigMap 里留空，由 AIOPS_INTERNAL_TOKEN 注入；这里验证覆盖生效。
      internalToken: '',
      actors: [{ id: 'seed', name: 'Seed', roles: ['viewer'] }],
      knowledge: { provider: 'local', root: path.join(dir, 'knowledge') },
      assetsFile: path.join(dir, 'assets.json'),
      credentialsFile: path.join(dir, 'credentials.json'),
      mcpServersFile: path.join(dir, 'mcp-servers.json'),
      skillsDir: path.resolve('extensions/aiops-skills'),
    }
    const configPath = path.join(dir, 'platform.json')
    await writeFile(configPath, JSON.stringify(config))

    process.env.AIOPS_AUTH = 'local'
    process.env.AIOPS_ADMIN_USERNAME = 'root'
    process.env.AIOPS_ADMIN_PASSWORD = PASSWORD
    process.env.AIOPS_INTERNAL_TOKEN = 'env-internal-token'
    process.env.AIOPS_MCP_HEALTH_MS = '0'

    const running = await compose(configPath, { store })
    assert.ok(running.auth, 'AIOPS_AUTH=local 应当启用 AuthService')
    assert.equal(running.internalToken, 'env-internal-token')
    const login = await running.auth.login('root', PASSWORD)
    assert.equal(login.user.username, 'root')
    assert.deepEqual(login.user.roles, ['admin', 'operator', 'approver'])
    assert.equal(login.user.mustChangePassword, true)

    const actors = running.platform.listActors()
    assert.deepEqual(actors.map((person) => person.id), [login.user.id])
    assert.deepEqual(actors[0].roles, ['admin', 'operator', 'approver'])

    // 再次启动不会重复创建管理员
    const again = await compose(configPath, { store })
    assert.equal((await again.auth!.listUsers()).length, 1)
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
