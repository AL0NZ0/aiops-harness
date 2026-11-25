import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AuthService } from '../src/auth.ts'
import { MemoryAuthStore } from '../src/auth-store.ts'
import { createServer } from '../src/http.ts'
import type { Platform } from '../src/platform.ts'
import type { Actor } from '../src/types.ts'

const PASSWORD = 'correct horse battery staple'

function setup() {
  const store = new MemoryAuthStore()
  const auth = new AuthService(store, { now: () => new Date('2026-11-19T00:00:00.000Z') })
  const users: Actor[] = []
  const platform = {
    listActors: () => users,
    saveAsset: async (_actorId: string, input: Record<string, unknown>) => ({ ...input, hasPassword: true }),
    createAgentTask: async (
      actorId: string,
      input: { title?: string; prompt?: string; skill?: string; sessionId?: string },
      origin: 'dsh' | 'api' = 'dsh',
    ) => ({
      id: 'task_v1',
      sessionId: input.sessionId ?? `${origin}:task_v1`,
      ownerId: actorId,
      title: input.title ?? input.prompt ?? 'test',
      prompt: input.prompt ?? '',
      skill: input.skill ?? 'monitoring-analysis',
      status: 'running',
      origin,
      createdAt: '2026-11-19T00:00:00.000Z',
      updatedAt: '2026-11-19T00:00:00.000Z',
    }),
    replaceActors: (next: Actor[]) => {
      users.splice(0, users.length, ...next)
    },
  } as unknown as Platform
  return { store, auth, users, platform }
}

async function listen(server: ReturnType<typeof createServer>): Promise<{ base: string; close: () => Promise<void> }> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('没有端口')
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  }
}

async function boot(options: { secureCookies?: boolean } = {}) {
  const ctx = setup()
  const user = await ctx.auth.createUser({ username: 'alice', password: PASSWORD, roles: ['operator', 'approver'] })
  ctx.users.push({ id: user.id, name: user.displayName, roles: user.roles })
  const server = createServer(ctx.platform, {
    internalToken: 'test-token',
    auth: ctx.auth,
    secureCookies: options.secureCookies === true,
  })
  const running = await listen(server)
  return { ...ctx, user, ...running }
}

async function login(base: string, password = PASSWORD, username = 'alice') {
  return fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
    redirect: 'manual',
  })
}

async function session(base: string, username: string): Promise<{ cookie: string; csrfToken: string }> {
  const response = await login(base, PASSWORD, username)
  assert.equal(response.status, 200)
  const body = await response.json() as { csrfToken: string }
  return { cookie: cookieOf(response).split(';')[0], csrfToken: body.csrfToken }
}

function cookieOf(response: Response): string {
  const setCookie = response.headers.getSetCookie?.() ?? []
  const raw = setCookie.find((item) => item.startsWith('aiops_session='))
  assert.ok(raw, '登录响应必须下发 aiops_session')
  return raw
}

test('账号模式下未登录访问控制台跳登录页，登录页和静态资源可访问', async () => {
  const ctx = await boot()
  try {
    const health = await fetch(`${ctx.base}/health`).then((item) => item.json() as Promise<{ features: { auth: boolean } }>)
    assert.equal(health.features.auth, true)

    const home = await fetch(`${ctx.base}/`, { redirect: 'manual' })
    assert.equal(home.status, 302)
    assert.equal(home.headers.get('location'), '/login')

    const loginPage = await fetch(`${ctx.base}/login`)
    assert.equal(loginPage.status, 200)
    const html = await loginPage.text()
    assert.match(html, /\/login\.js/)

    const actors = await fetch(`${ctx.base}/api/actors`)
    assert.equal(actors.status, 401)
  } finally {
    await ctx.close()
  }
})

test('登录成功下发 HttpOnly Cookie，会话可访问 /api/auth/me，登出后失效', async () => {
  const ctx = await boot()
  try {
    const failed = await login(ctx.base, 'wrong password')
    assert.equal(failed.status, 401)

    const ok = await login(ctx.base)
    assert.equal(ok.status, 200)
    const body = await ok.json() as { user: { id: string }; csrfToken: string }
    assert.equal(body.user.id, ctx.user.id)
    assert.equal(body.csrfToken.length > 10, true)

    const cookie = cookieOf(ok)
    assert.match(cookie, /HttpOnly/)
    assert.match(cookie, /SameSite=Lax/)
    assert.match(cookie, /Path=\//)
    assert.doesNotMatch(cookie, /Secure/)

    const me = await fetch(`${ctx.base}/api/auth/me`, { headers: { cookie: cookie.split(';')[0] } })
    assert.equal(me.status, 200)
    const meBody = await me.json() as { method: string; csrfToken: string; user: { username: string } }
    assert.equal(meBody.method, 'session')
    assert.equal(meBody.user.username, 'alice')
    assert.equal(meBody.csrfToken, body.csrfToken)
  } finally {
    await ctx.close()
  }
})

test('会话写操作必须带 CSRF，登出后 Cookie 清除且会话不可用', async () => {
  const ctx = await boot()
  try {
    const ok = await login(ctx.base)
    const cookie = cookieOf(ok).split(';')[0]
    const { csrfToken } = await ok.json() as { csrfToken: string }

    const missing = await fetch(`${ctx.base}/api/auth/logout`, { method: 'POST', headers: { cookie } })
    assert.equal(missing.status, 403)
    const wrong = await fetch(`${ctx.base}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie, 'x-csrf-token': 'nope' },
    })
    assert.equal(wrong.status, 403)

    const success = await fetch(`${ctx.base}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie, 'x-csrf-token': csrfToken },
    })
    assert.equal(success.status, 200)
    const cleared = success.headers.getSetCookie?.().find((item) => item.startsWith('aiops_session=')) ?? ''
    assert.match(cleared, /Max-Age=0/)

    const me = await fetch(`${ctx.base}/api/auth/me`, { headers: { cookie } })
    assert.equal(me.status, 401)
  } finally {
    await ctx.close()
  }
})

test('secureCookies 开启时 Cookie 带 Secure', async () => {
  const ctx = await boot({ secureCookies: true })
  try {
    const ok = await login(ctx.base)
    assert.match(cookieOf(ok), /Secure/)
  } finally {
    await ctx.close()
  }
})

test('API key 按 scope 放行或拒绝，吊销后立即失效', async () => {
  const ctx = await boot()
  try {
    const read = await ctx.auth.createApiKey(ctx.user.id, { name: 'reader', scopes: ['tasks:read'] })
    const actors = await fetch(`${ctx.base}/api/actors`, {
      headers: { authorization: `Bearer ${read.token}` },
    })
    assert.equal(actors.status, 200)
    const actorsBody = await actors.json() as { actors: Array<{ id: string }> }
    assert.deepEqual(actorsBody.actors.map((person) => person.id), [ctx.user.id])

    const denied = await fetch(`${ctx.base}/api/tool-calls`, {
      method: 'POST',
      headers: { authorization: `Bearer ${read.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'mcp.demo.list', args: {} }),
    })
    assert.equal(denied.status, 403)

    const write = await ctx.auth.createApiKey(ctx.user.id, { name: 'writer', scopes: ['approvals:read'] })
    const noTasks = await fetch(`${ctx.base}/api/tasks`, {
      headers: { authorization: `Bearer ${write.token}` },
    })
    assert.equal(noTasks.status, 403)

    const opaque = await fetch(`${ctx.base}/api/auth/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${write.token}` },
    })
    assert.equal(opaque.status, 403)

    await ctx.auth.revokeApiKey(read.key.id)
    const revoked = await fetch(`${ctx.base}/api/actors`, {
      headers: { authorization: `Bearer ${read.token}` },
    })
    assert.equal(revoked.status, 401)
  } finally {
    await ctx.close()
  }
})
test('对外 v1 任务 API 只接受带 tasks:write 的 API key', async () => {
  const ctx = await boot()
  try {
    const noKey = await fetch(`${ctx.base}/api/v1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '排查' }),
    })
    assert.equal(noKey.status, 401)

    const reader = await ctx.auth.createApiKey(ctx.user.id, { name: 'reader', scopes: ['tasks:read'] })
    const denied = await fetch(`${ctx.base}/api/v1/tasks`, {
      method: 'POST',
      headers: { authorization: `Bearer ${reader.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '排查' }),
    })
    assert.equal(denied.status, 403)

    const writer = await ctx.auth.createApiKey(ctx.user.id, {
      name: 'workbuddy',
      scopes: ['tasks:read', 'tasks:write', 'tools:execute'],
    })
    const created = await fetch(`${ctx.base}/api/v1/tasks`, {
      method: 'POST',
      headers: { authorization: `Bearer ${writer.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '排查 checkout-api', sessionId: 'wb-1' }),
    })
    assert.equal(created.status, 201)
    const body = await created.json() as { task: { id: string; origin: string; sessionId: string } }
    assert.equal(body.task.origin, 'api')
    assert.equal(body.task.sessionId, 'wb-1')
  } finally {
    await ctx.close()
  }
})

test('管理员可以创建和停用用户，非管理员被拒绝，最后一个管理员不能降级', async () => {
  const ctx = await boot()
  try {
    const rootUser = await ctx.auth.createUser({ username: 'root', password: PASSWORD, roles: ['admin'] })
    ctx.users.push({ id: rootUser.id, name: rootUser.displayName, roles: rootUser.roles })
    const operator = await session(ctx.base, 'alice')
    const denied = await fetch(`${ctx.base}/api/users`, { headers: { cookie: operator.cookie } })
    assert.equal(denied.status, 403)

    const root = await session(ctx.base, 'root')
    const write = (method: string, pathname: string, body: unknown) => fetch(`${ctx.base}${pathname}`, {
      method,
      headers: {
        cookie: root.cookie,
        'x-csrf-token': root.csrfToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    const created = await write('POST', '/api/users', {
      username: 'Dave',
      password: PASSWORD,
      displayName: 'Dave',
      roles: ['operator'],
    })
    assert.equal(created.status, 201)
    const dave = await created.json() as { user: { id: string; username: string } }
    assert.equal(dave.user.username, 'dave')
    assert.deepEqual(ctx.users.map((person) => person.id).sort(), [ctx.user.id, rootUser.id, dave.user.id].sort())

    const daveSession = await session(ctx.base, 'dave')
    assert.equal(daveSession.cookie.startsWith('aiops_session='), true)

    const disabled = await write('PATCH', `/api/users/${dave.user.id}`, { status: 'disabled' })
    assert.equal(disabled.status, 200)
    assert.equal((await login(ctx.base, PASSWORD, 'dave')).status, 401)
    assert.equal(ctx.users.some((person) => person.id === dave.user.id), false)

    const demote = await write('PATCH', `/api/users/${rootUser.id}`, { roles: ['operator'] })
    assert.equal(demote.status, 409)

    const reset = await write('POST', `/api/users/${dave.user.id}/password`, { newPassword: 'another long password' })
    assert.equal(reset.status, 200)
    assert.equal((await login(ctx.base, 'another long password', 'dave')).status, 401, '停用账号不能登录')
  } finally {
    await ctx.close()
  }
})

test('管理员可以创建仅 API key 的客户端账号，建号时签发 key，密码登录被拒绝', async () => {
  const ctx = await boot()
  try {
    const rootUser = await ctx.auth.createUser({ username: 'root', password: PASSWORD, roles: ['admin'] })
    ctx.users.push({ id: rootUser.id, name: rootUser.displayName, roles: rootUser.roles })
    const root = await session(ctx.base, 'root')
    const write = (method: string, pathname: string, body: unknown) => fetch(`${ctx.base}${pathname}`, {
      method,
      headers: {
        cookie: root.cookie,
        'x-csrf-token': root.csrfToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    const created = await write('POST', '/api/users', {
      username: 'agent',
      displayName: 'DSH Agent',
      roles: ['operator'],
      issueKey: true,
      keyName: 'dsh-agent',
    })
    assert.equal(created.status, 201)
    const body = await created.json() as {
      user: { id: string; hasPassword: boolean }
      key: { id: string; userId: string; name: string; scopes: string[] }
      token: string
    }
    assert.equal(body.user.hasPassword, false)
    assert.equal(body.key.userId, body.user.id)
    assert.equal(body.key.name, 'dsh-agent')
    assert.ok(body.key.scopes.includes('tools:execute'))
    assert.match(body.token, /^aiops_/)

    // 没有密码的账号不能走网页登录，只能用 key。
    assert.equal((await login(ctx.base, PASSWORD, 'agent')).status, 401)
    const viaKey = await fetch(`${ctx.base}/api/actors`, {
      headers: { authorization: `Bearer ${body.token}` },
    })
    assert.equal(viaKey.status, 200)
    const viaKeyBody = await viaKey.json() as { actors: Array<{ id: string }> }
    assert.deepEqual(viaKeyBody.actors.map((person) => person.id), [body.user.id], 'operator 只能看到自己')

    const allActors = await fetch(`${ctx.base}/api/actors`, { headers: { cookie: root.cookie } })
    const allActorsBody = await allActors.json() as { actors: Array<{ id: string }> }
    assert.ok(allActorsBody.actors.some((person) => person.id === body.user.id), 'admin 能看到全部账号')

    // 需要登录网页的角色不能用无密码账号。
    const approver = await write('POST', '/api/users', { username: 'nopass', roles: ['approver'] })
    assert.equal(approver.status, 400)
    const noPasswordBody = await approver.json() as { error: { code: string } }
    assert.equal(noPasswordBody.error.code, 'password_required')

    // 已有账号可以后补签发 key。
    const issued = await write('POST', `/api/users/${body.user.id}/keys`, {})
    assert.equal(issued.status, 201)
    const issuedBody = await issued.json() as { token: string }
    assert.match(issuedBody.token, /^aiops_/)
  } finally {
    await ctx.close()
  }
})

test('个人 API key 对本人可见，明文只返回一次，管理员可以管理他人的 key', async () => {
  const ctx = await boot()
  try {
    const rootUser = await ctx.auth.createUser({ username: 'root', password: PASSWORD, roles: ['admin'] })
    ctx.users.push({ id: rootUser.id, name: rootUser.displayName, roles: rootUser.roles })
    const alice = await session(ctx.base, 'alice')
    const created = await fetch(`${ctx.base}/api/auth/keys`, {
      method: 'POST',
      headers: {
        cookie: alice.cookie,
        'x-csrf-token': alice.csrfToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'dsh', scopes: ['tasks:read', 'tasks:write'] }),
    })
    assert.equal(created.status, 201)
    const body = await created.json() as { key: { id: string; userId: string }; token: string }
    assert.equal(body.key.userId, ctx.user.id)
    assert.match(body.token, /^aiops_/)

    const listed = await fetch(`${ctx.base}/api/auth/keys`, { headers: { cookie: alice.cookie } })
    assert.equal(listed.status, 200)
    const list = await listed.json() as { keys: Array<Record<string, unknown>> }
    assert.equal(list.keys.length, 1)
    assert.equal('token' in list.keys[0], false)
    assert.equal('tokenHash' in list.keys[0], false)

    const others = await fetch(`${ctx.base}/api/auth/keys?userId=${rootUser.id}`, { headers: { cookie: alice.cookie } })
    assert.equal(others.status, 403)

    const revoke = await fetch(`${ctx.base}/api/auth/keys/${body.key.id}`, {
      method: 'DELETE',
      headers: { cookie: alice.cookie, 'x-csrf-token': alice.csrfToken },
    })
    assert.equal(revoke.status, 200)
    const useAfter = await fetch(`${ctx.base}/api/actors`, {
      headers: { authorization: `Bearer ${body.token}` },
    })
    assert.equal(useAfter.status, 401)
  } finally {
    await ctx.close()
  }
})

test('安全事件接口只给 admin/auditor，配置变更落事件且不含 token', async () => {
  const ctx = await boot()
  try {
    await ctx.auth.createUser({ username: 'root', password: PASSWORD, roles: ['admin'] })
    await ctx.auth.createUser({ username: 'auditor1', password: PASSWORD, roles: ['auditor'] })
    const operator = await session(ctx.base, 'alice')
    const admin = await session(ctx.base, 'root')
    const auditor = await session(ctx.base, 'auditor1')

    const denied = await fetch(`${ctx.base}/api/security-events`, { headers: { cookie: operator.cookie } })
    assert.equal(denied.status, 403)

    const secret = 'super-secret-token'
    const saved = await fetch(`${ctx.base}/api/assets`, {
      method: 'POST',
      headers: {
        cookie: admin.cookie,
        'x-csrf-token': admin.csrfToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'prod-host',
        host: 'prod-host',
        sshUser: 'ops',
        sshPassword: secret,
      }),
    })
    assert.equal(saved.status, 200)

    const adminEvents = await fetch(`${ctx.base}/api/security-events`, {
      headers: { cookie: admin.cookie },
    }).then((item) => item.json() as Promise<{ events: Array<{ type: string; detail?: Record<string, unknown> }> }>)
    assert.ok(adminEvents.events.some((event) => event.type === 'auth.login_succeeded'))
    const configEvent = adminEvents.events.find((event) => event.type === 'config.asset_saved')
    assert.ok(configEvent)
    assert.equal(configEvent.detail?.name, 'prod-host')
    assert.equal(JSON.stringify(adminEvents).includes(secret), false)

    const auditorEvents = await fetch(`${ctx.base}/api/security-events?limit=10`, {
      headers: { cookie: auditor.cookie },
    }).then((item) => item.json() as Promise<{ events: unknown[] }>)
    assert.ok(auditorEvents.events.length > 0)

    type Page = { events: Array<{ id: string }>; total: number; limit: number; offset: number }
    const first = await fetch(`${ctx.base}/api/security-events?limit=2&offset=0`, {
      headers: { cookie: auditor.cookie },
    }).then((item) => item.json() as Promise<Page>)
    const second = await fetch(`${ctx.base}/api/security-events?limit=2&offset=2`, {
      headers: { cookie: auditor.cookie },
    }).then((item) => item.json() as Promise<Page>)
    assert.equal(first.limit, 2)
    assert.equal(first.offset, 0)
    assert.equal(first.events.length, 2)
    assert.equal(first.total, second.total)
    assert.ok(second.events.length > 0)
    const ids = new Set([...first.events, ...second.events].map((event) => event.id))
    assert.equal(ids.size, first.events.length + second.events.length)
    assert.ok(first.total > second.events.length)

    const badOffset = await fetch(`${ctx.base}/api/security-events?offset=-1`, {
      headers: { cookie: auditor.cookie },
    })
    assert.equal(badOffset.status, 400)

    // CSV 导出：auditor 可以，operator 不能，内容不含密码。
    const exported = await fetch(`${ctx.base}/api/security-events/export?format=csv`, {
      headers: { cookie: auditor.cookie },
    })
    assert.equal(exported.status, 200)
    assert.match(exported.headers.get('content-disposition') ?? '', /attachment; filename="security-events-/)
    const csvText = await exported.text()
    assert.match(csvText, /时间,类型,用户ID/)
    assert.equal(csvText.includes(secret), false)
    const deniedExport = await fetch(`${ctx.base}/api/security-events/export`, {
      headers: { cookie: operator.cookie },
    })
    assert.equal(deniedExport.status, 403)
    const jsonExport = await fetch(`${ctx.base}/api/security-events/export?format=json&limit=5`, {
      headers: { cookie: admin.cookie },
    })
    const jsonBody = await jsonExport.json() as { count: number; events: unknown[] }
    assert.ok(jsonBody.count > 0)
    assert.equal(jsonBody.events.length, jsonBody.count)
    const badFilter = await fetch(`${ctx.base}/api/security-events/export?since=not-a-date`, {
      headers: { cookie: admin.cookie },
    })
    assert.equal(badFilter.status, 400)
  } finally {
    await ctx.close()
  }
})

test('初始密码未修改时只放行 me/改密/登出，改密后恢复', async () => {
  const ctx = await boot()
  try {
    const user = await ctx.auth.createUser({
      username: 'newbie',
      password: PASSWORD,
      roles: ['operator'],
      mustChangePassword: true,
    })
    ctx.users.push({ id: user.id, name: user.displayName, roles: user.roles })
    const current = await session(ctx.base, 'newbie')

    const me = await fetch(`${ctx.base}/api/auth/me`, { headers: { cookie: current.cookie } })
    assert.equal(me.status, 200)
    const blocked = await fetch(`${ctx.base}/api/actors`, { headers: { cookie: current.cookie } })
    assert.equal(blocked.status, 403)
    const blockedBody = await blocked.json() as { error: { code: string } }
    assert.equal(blockedBody.error.code, 'password_change_required')

    const changed = await fetch(`${ctx.base}/api/auth/password`, {
      method: 'POST',
      headers: {
        cookie: current.cookie,
        'x-csrf-token': current.csrfToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ currentPassword: PASSWORD, newPassword: 'a brand new long password' }),
    })
    assert.equal(changed.status, 200)
    const allowed = await fetch(`${ctx.base}/api/actors`, { headers: { cookie: current.cookie } })
    assert.equal(allowed.status, 200)
  } finally {
    await ctx.close()
  }
})

test('会话列表只暴露会话标识，可注销指定会话或其他会话', async () => {
  const ctx = await boot()
  try {
    const first = await session(ctx.base, 'alice')
    const second = await session(ctx.base, 'alice')
    type Sessions = { sessions: Array<{ id: string; current: boolean; tokenHash?: string }> }
    const listed = await fetch(`${ctx.base}/api/auth/sessions`, { headers: { cookie: first.cookie } })
      .then((item) => item.json() as Promise<Sessions>)
    assert.equal(listed.sessions.length, 2)
    assert.equal(listed.sessions.filter((item) => item.current).length, 1)
    assert.equal(listed.sessions.some((item) => 'tokenHash' in item), false)
    const other = listed.sessions.find((item) => !item.current)
    assert.ok(other)

    const revoked = await fetch(`${ctx.base}/api/auth/sessions/${encodeURIComponent(other.id)}`, {
      method: 'DELETE',
      headers: { cookie: first.cookie, 'x-csrf-token': first.csrfToken },
    })
    assert.equal(revoked.status, 200)
    const after = await fetch(`${ctx.base}/api/auth/sessions`, { headers: { cookie: first.cookie } })
      .then((item) => item.json() as Promise<Sessions>)
    assert.equal(after.sessions.length, 1)
    assert.equal(after.sessions[0]?.current, true)

    // 第二个会话已被注销，不能再用它操作。
    const stale = await fetch(`${ctx.base}/api/auth/sessions`, { headers: { cookie: second.cookie } })
    assert.equal(stale.status, 401)

    const again = await session(ctx.base, 'alice')
    const bulk = await fetch(`${ctx.base}/api/auth/sessions`, {
      method: 'DELETE',
      headers: { cookie: again.cookie, 'x-csrf-token': again.csrfToken },
    })
    const bulkBody = await bulk.json() as { revoked: number }
    assert.equal(bulk.status, 200)
    assert.ok(bulkBody.revoked >= 1)
    const currentStill = await fetch(`${ctx.base}/api/auth/me`, { headers: { cookie: again.cookie } })
    assert.equal(currentStill.status, 200)
  } finally {
    await ctx.close()
  }
})

test('管理员可以查看登录失败记录并解锁，普通用户无权访问', async () => {
  const ctx = await boot()
  try {
    // 普通用户先拿到会话，再制造登录失败；锁定只影响登录，不影响已有会话。
    const alice = await session(ctx.base, 'alice')
    const admin = await ctx.auth.createUser({ username: 'root', password: PASSWORD, roles: ['admin'] })
    ctx.users.push({ id: admin.id, name: admin.displayName, roles: admin.roles })
    const root = await session(ctx.base, 'root')

    for (let index = 0; index < 5; index += 1) {
      assert.equal((await login(ctx.base, 'wrong password')).status, 401)
    }
    assert.equal((await login(ctx.base)).status, 429)

    const forbidden = await fetch(`${ctx.base}/api/login-locks`, { headers: { cookie: alice.cookie } })
    assert.equal(forbidden.status, 403)

    const listed = await fetch(`${ctx.base}/api/login-locks`, { headers: { cookie: root.cookie } })
    assert.equal(listed.status, 200)
    const body = await listed.json() as {
      locks: Array<{ username: string; failures: number; lockedUntil?: string }>
    }
    assert.equal(body.locks.length, 1)
    assert.equal(body.locks[0]?.username, 'alice')
    assert.ok(body.locks[0]?.lockedUntil)

    const missingCsrf = await fetch(`${ctx.base}/api/login-locks/alice`, {
      method: 'DELETE',
      headers: { cookie: root.cookie },
    })
    assert.equal(missingCsrf.status, 403)

    const cleared = await fetch(`${ctx.base}/api/login-locks/alice`, {
      method: 'DELETE',
      headers: { cookie: root.cookie, 'x-csrf-token': root.csrfToken },
    })
    assert.equal(cleared.status, 200)
    assert.equal((await cleared.json() as { cleared: number }).cleared, 5)
    assert.equal((await login(ctx.base)).status, 200)

    const after = await fetch(`${ctx.base}/api/login-locks`, { headers: { cookie: root.cookie } })
      .then((item) => item.json() as Promise<{ locks: unknown[] }>)
    assert.deepEqual(after.locks, [])
  } finally {
    await ctx.close()
  }
})
