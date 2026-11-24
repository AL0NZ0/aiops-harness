import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'node:crypto'
import type {
  ApiKeyRecord,
  ApiScope,
  AuthStore,
  SecurityEventRecord,
  SessionRecord,
  UserRecord,
} from './auth-store.ts'
import type { Role } from './types.ts'

const SCRYPT_N = 16_384
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_KEYLEN = 64
const SCRYPT_OPTIONS: ScryptOptions = {
  N: SCRYPT_N,
  r: SCRYPT_R,
  p: SCRYPT_P,
  // N=2^15, r=8 需要约 16MB；留出余量，避免 Node 默认 32MB 上限。
  maxmem: 64 * 1024 * 1024,
}

const ROLES: Role[] = ['viewer', 'operator', 'approver', 'auditor', 'admin']
const SCOPES: ApiScope[] = [
  'tasks:read',
  'tasks:write',
  'approvals:read',
  'approvals:write',
  'tools:execute',
  'knowledge:read',
  'admin',
]

export class AuthError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

export interface PublicUser {
  id: string
  username: string
  displayName: string
  roles: Role[]
  status: 'active' | 'disabled'
  source: string
  email?: string
  mustChangePassword: boolean
  /** 是否设置了网页登录密码；false 表示只能走 API key。 */
  hasPassword: boolean
  createdAt: string
  updatedAt: string
  lastLoginAt?: string
}

export interface ApiKeyView {
  id: string
  userId: string
  name: string
  scopes: ApiScope[]
  createdAt: string
  expiresAt?: string
  lastUsedAt?: string
  revokedAt?: string
  /** 未吊销且在提醒窗口内过期；只用于页面/接口提示，不代表 key 已失效。 */
  expiringSoon?: boolean
}

/** 会话列表视图；不包含 token 哈希和 CSRF token。 */
export interface SessionView {
  id: string
  createdAt: string
  lastSeenAt: string
  expiresAt: string
  ip?: string
  userAgent?: string
}

export interface LoginResult {
  user: PublicUser
  token: string
  csrfToken: string
  expiresAt: string
}

export interface AuthContext {
  ip?: string
  userAgent?: string
}

export interface ApiKeyAuthResult {
  user: UserRecord
  key: ApiKeyRecord
}

export interface AuthServiceOptions {
  sessionIdleMs?: number
  sessionAbsoluteMs?: number
  sessionTouchMs?: number
  /** 同一 API key 两次使用事件的最小间隔；持续调用只会在闲置超过该间隔后的首次使用时记一条。 */
  apiKeyEventMs?: number
  maxLoginFailures?: number
  failureWindowMs?: number
  lockoutMs?: number
  now?: () => Date
}


export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

function scrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS, (error, key) => {
      if (error) reject(error)
      else resolve(key)
    })
  })
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scrypt(password, salt)
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${key.toString('base64url')}`
}

export async function verifyPassword(password: string, encoded: string | undefined): Promise<boolean> {
  if (!encoded) return false
  const parts = encoded.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, rawN, rawR, rawP, rawSalt, rawHash] = parts
  const n = Number(rawN)
  const r = Number(rawR)
  const p = Number(rawP)
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false
  if (n < 1024 || n > 1_048_576 || r < 1 || r > 32 || p < 1 || p > 16) return false
  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(rawSalt ?? '', 'base64url')
    expected = Buffer.from(rawHash ?? '', 'base64url')
  } catch {
    return false
  }
  if (salt.length === 0 || expected.length === 0) return false
  let actual: Buffer
  try {
    actual = await new Promise<Buffer>((resolve, reject) => {
      scryptCallback(password, salt, expected.length, { N: n, r, p, maxmem: 128 * 1024 * 1024 }, (error, key) => {
        if (error) reject(error)
        else resolve(key)
      })
    })
  } catch {
    return false
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function validatePassword(password: unknown): asserts password is string {
  if (typeof password !== 'string' || password.length < 12) {
    throw new AuthError('密码至少 12 个字符', 'weak_password')
  }
  if (password.length > 256) throw new AuthError('密码不能超过 256 个字符', 'weak_password')
}

export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase()
}

function validateUsername(username: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(username)) {
    throw new AuthError('用户名只能是小写字母、数字、点、下划线或短横线，长度 3-64', 'invalid_username')
  }
}

function validateRoles(roles: Role[]): void {
  if (roles.length === 0) throw new AuthError('至少需要一个角色', 'invalid_roles')
  if (roles.some((role) => !ROLES.includes(role))) throw new AuthError('角色不合法', 'invalid_roles')
}

function validateScopes(scopes: ApiScope[]): void {
  if (scopes.length === 0) throw new AuthError('至少需要一个 scope', 'invalid_scopes')
  if (scopes.some((scope) => !SCOPES.includes(scope))) throw new AuthError('scope 不合法', 'invalid_scopes')
}

export function toPublicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    roles: [...user.roles],
    status: user.status,
    source: user.source,
    ...(user.email ? { email: user.email } : {}),
    mustChangePassword: user.mustChangePassword,
    hasPassword: Boolean(user.passwordHash),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    ...(user.lastLoginAt ? { lastLoginAt: user.lastLoginAt } : {}),
  }
}

export function toApiKeyView(key: ApiKeyRecord): ApiKeyView {
  return {
    id: key.id,
    userId: key.userId,
    name: key.name,
    scopes: [...key.scopes],
    createdAt: key.createdAt,
    ...(key.expiresAt ? { expiresAt: key.expiresAt } : {}),
    ...(key.lastUsedAt ? { lastUsedAt: key.lastUsedAt } : {}),
    ...(key.revokedAt ? { revokedAt: key.revokedAt } : {}),
  }
}

export class AuthService {
  private readonly sessionIdleMs: number
  private readonly sessionAbsoluteMs: number
  private readonly sessionTouchMs: number
  private readonly apiKeyEventMs: number
  private readonly maxLoginFailures: number
  private readonly failureWindowMs: number
  private readonly lockoutMs: number
  private readonly now: () => Date

  constructor(
    private readonly store: AuthStore,
    options: AuthServiceOptions = {},
  ) {
    this.sessionIdleMs = options.sessionIdleMs ?? 12 * 60 * 60 * 1000
    this.sessionAbsoluteMs = options.sessionAbsoluteMs ?? 7 * 24 * 60 * 60 * 1000
    this.sessionTouchMs = options.sessionTouchMs ?? 60 * 1000
    this.apiKeyEventMs = options.apiKeyEventMs ?? 60 * 60 * 1000
    this.maxLoginFailures = options.maxLoginFailures ?? 5
    this.failureWindowMs = options.failureWindowMs ?? 15 * 60 * 1000
    this.lockoutMs = options.lockoutMs ?? 15 * 60 * 1000
    this.now = options.now ?? (() => new Date())
  }

  async login(username: string, password: string, context: AuthContext = {}): Promise<LoginResult> {
    const normalized = normalizeUsername(username)
    const key = this.failureKey(normalized, context.ip)
    await this.assertNotLocked(key)
    const user = await this.store.getUserByUsername(normalized)
    const ok = await verifyPassword(password, user?.passwordHash)
    if (!user || !ok || user.status !== 'active') {
      await this.recordFailure(key)
      await this.recordEvent('auth.login_failed', context, {
        username: normalized,
        ...(user?.id ? { userId: user.id } : {}),
      })
      throw new AuthError('用户名或密码错误', 'invalid_credentials', 401)
    }
    await this.store.clearLoginFailures(key)
    const now = this.now()
    const token = randomToken()
    const csrfToken = randomToken(24)
    const createdAt = now.toISOString()
    const expiresAt = new Date(now.getTime() + this.sessionAbsoluteMs).toISOString()
    await this.store.createSession({
      id: `sess_${randomBytes(12).toString('hex')}`,
      tokenHash: hashToken(token),
      userId: user.id,
      csrfToken,
      createdAt,
      expiresAt,
      lastSeenAt: createdAt,
      ...(context.ip ? { ip: context.ip } : {}),
      ...(context.userAgent ? { userAgent: context.userAgent.slice(0, 512) } : {}),
    })
    user.lastLoginAt = createdAt
    user.updatedAt = createdAt
    await this.store.saveUser(user)
    await this.recordEvent('auth.login_succeeded', context, { userId: user.id, username: user.username })
    return { user: toPublicUser(user), token, csrfToken, expiresAt }
  }

  async verifySession(token: string): Promise<{ user: UserRecord; session: SessionRecord } | undefined> {
    if (!token) return undefined
    const tokenHash = hashToken(token)
    const session = await this.store.getSession(tokenHash)
    if (!session) return undefined
    const now = this.now()
    if (session.expiresAt <= now.toISOString() || Date.parse(session.lastSeenAt) + this.sessionIdleMs <= now.getTime()) {
      await this.store.deleteSession(tokenHash)
      return undefined
    }
    const user = await this.store.getUser(session.userId)
    if (!user || user.status !== 'active') {
      await this.store.deleteSession(tokenHash)
      return undefined
    }
    if (now.getTime() - Date.parse(session.lastSeenAt) >= this.sessionTouchMs) {
      const lastSeenAt = now.toISOString()
      await this.store.touchSession(tokenHash, lastSeenAt)
      session.lastSeenAt = lastSeenAt
    }
    return { user, session }
  }

  async logout(token: string, context: AuthContext = {}): Promise<void> {
    if (!token) return
    const tokenHash = hashToken(token)
    const session = await this.store.getSession(tokenHash)
    await this.store.deleteSession(tokenHash)
    if (session) await this.recordEvent('auth.logout', context, { userId: session.userId })
  }

  /** 列出仍有效的网页会话；currentTokenHash 对应的会话标记 current。 */
  async listActiveSessions(
    userId: string,
    currentTokenHash?: string,
  ): Promise<Array<SessionView & { current: boolean }>> {
    const now = this.now()
    const nowIso = now.toISOString()
    const sessions = await this.store.listSessionsForUser(userId)
    return sessions
      .filter(
        (session) =>
          session.expiresAt > nowIso && Date.parse(session.lastSeenAt) + this.sessionIdleMs > now.getTime(),
      )
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
      .map((session) => ({
        id: session.id,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        expiresAt: session.expiresAt,
        ...(session.ip ? { ip: session.ip } : {}),
        ...(session.userAgent ? { userAgent: session.userAgent } : {}),
        current: session.tokenHash === currentTokenHash,
      }))
  }

  /** 注销指定会话；只能注销自己的会话。返回 false 表示不存在或不属于该用户。 */
  async revokeSession(userId: string, sessionId: string, context: AuthContext = {}): Promise<boolean> {
    const removed = await this.store.deleteSessionForUser(userId, sessionId)
    if (removed) await this.recordEvent('auth.session_revoked', context, { userId, sessionId })
    return removed
  }

  /** 保留当前会话，注销该用户其它所有会话。 */
  async revokeOtherSessions(
    userId: string,
    currentToken: string,
    context: AuthContext = {},
  ): Promise<number> {
    const removed = await this.store.deleteOtherSessionsForUser(userId, hashToken(currentToken))
    if (removed > 0) await this.recordEvent('auth.sessions_revoked', context, { userId, count: removed })
    return removed
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    nextPassword: string,
    keepToken?: string,
  ): Promise<void> {
    const user = await this.store.getUser(userId)
    if (!user) throw new AuthError('用户不存在', 'not_found', 404)
    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      throw new AuthError('当前密码不正确', 'invalid_credentials', 401)
    }
    validatePassword(nextPassword)
    if (nextPassword === currentPassword) throw new AuthError('新密码不能和旧密码相同', 'weak_password')
    const current = keepToken ? await this.store.getSession(hashToken(keepToken)) : undefined
    user.passwordHash = await hashPassword(nextPassword)
    user.mustChangePassword = false
    user.updatedAt = this.now().toISOString()
    await this.store.saveUser(user)
    await this.store.deleteSessionsForUser(user.id)
    if (current && current.userId === user.id) await this.store.createSession(current)
    await this.recordEvent('auth.password_changed', {}, { userId: user.id })
  }

  async resetPassword(userId: string, nextPassword: string): Promise<void> {
    const user = await this.store.getUser(userId)
    if (!user) throw new AuthError('用户不存在', 'not_found', 404)
    validatePassword(nextPassword)
    user.passwordHash = await hashPassword(nextPassword)
    user.mustChangePassword = true
    user.updatedAt = this.now().toISOString()
    await this.store.saveUser(user)
    await this.store.deleteSessionsForUser(user.id)
    await this.recordEvent('auth.password_reset', {}, { userId: user.id })
  }

  async createUser(input: {
    username: string
    displayName?: string
    password?: string
    roles: Role[]
    email?: string
    mustChangePassword?: boolean
  }): Promise<UserRecord> {
    const username = normalizeUsername(input.username)
    validateUsername(username)
    validateRoles(input.roles)
    // 不传密码表示只能通过 API key 使用的账号（DSH/WorkBuddy 这类客户端）。
    const hasPassword = input.password !== undefined
    if (hasPassword) validatePassword(input.password)
    const now = this.now().toISOString()
    const user: UserRecord = {
      id: `usr_${randomBytes(8).toString('hex')}`,
      username,
      displayName: input.displayName?.trim() || username,
      ...(hasPassword ? { passwordHash: await hashPassword(input.password!) } : {}),
      roles: [...new Set(input.roles)],
      status: 'active',
      source: 'local',
      ...(input.email ? { email: input.email } : {}),
      mustChangePassword: hasPassword ? (input.mustChangePassword ?? false) : false,
      createdAt: now,
      updatedAt: now,
    }
    await this.store.createUser(user)
    await this.recordEvent('auth.user_created', {}, { userId: user.id, username: user.username })
    return user
  }

  async updateUser(
    userId: string,
    patch: { displayName?: string; roles?: Role[]; status?: 'active' | 'disabled' },
  ): Promise<UserRecord> {
    const user = await this.store.getUser(userId)
    if (!user) throw new AuthError('用户不存在', 'not_found', 404)
    const losingAdmin =
      user.roles.includes('admin') &&
      user.status === 'active' &&
      (patch.status === 'disabled' || (patch.roles !== undefined && !patch.roles.includes('admin')))
    if (losingAdmin) {
      const others = (await this.store.listUsers()).filter(
        (item) => item.id !== user.id && item.status === 'active' && item.roles.includes('admin'),
      )
      if (others.length === 0) throw new AuthError('不能停用或降级最后一个管理员', 'last_admin', 409)
    }
    if (patch.displayName !== undefined) user.displayName = patch.displayName.trim() || user.username
    if (patch.roles !== undefined) {
      validateRoles(patch.roles)
      user.roles = [...new Set(patch.roles)]
    }
    if (patch.status !== undefined) user.status = patch.status
    user.updatedAt = this.now().toISOString()
    await this.store.saveUser(user)
    if (user.status === 'disabled') await this.store.deleteSessionsForUser(user.id)
    await this.recordEvent('auth.user_updated', {}, { userId: user.id, username: user.username })
    return user
  }

  async listUsers(): Promise<UserRecord[]> {
    return (await this.store.listUsers()).sort((a, b) => a.username.localeCompare(b.username))
  }

  async createApiKey(
    userId: string,
    input: { name: string; scopes: ApiScope[]; expiresAt?: string; issuedBy?: string },
  ): Promise<{ key: ApiKeyView; token: string }> {
    const user = await this.store.getUser(userId)
    if (!user) throw new AuthError('用户不存在', 'not_found', 404)
    const name = input.name.trim()
    if (!name) throw new AuthError('key 名称不能为空', 'bad_request')
    validateScopes(input.scopes)
    // 未显式指定时按 AIOPS_API_KEY_TTL_DAYS 给默认有效期；0/未设置表示不自动过期。
    const ttlDays = Number(process.env.AIOPS_API_KEY_TTL_DAYS ?? 0)
    const defaultExpiresAt =
      Number.isFinite(ttlDays) && ttlDays > 0
        ? new Date(this.now().getTime() + ttlDays * 86_400_000).toISOString()
        : undefined
    const expiresAt = input.expiresAt ?? defaultExpiresAt
    if (expiresAt && Date.parse(expiresAt) <= this.now().getTime()) {
      throw new AuthError('过期时间必须晚于现在', 'bad_request')
    }
    const id = `key${randomBytes(8).toString('hex')}`
    const token = `aiops_${id}_${randomToken()}`
    const record: ApiKeyRecord = {
      id,
      userId,
      name,
      tokenHash: hashToken(token),
      scopes: [...new Set(input.scopes)],
      createdAt: this.now().toISOString(),
      ...(expiresAt ? { expiresAt } : {}),
    }
    await this.store.createApiKey(record)
    await this.recordEvent('auth.api_key_created', {}, {
      userId,
      keyId: id,
      keyName: name,
      ...(input.issuedBy ? { issuedBy: input.issuedBy } : {}),
    })
    return { key: toApiKeyView(record), token }
  }

  async listApiKeys(userId?: string): Promise<ApiKeyView[]> {
    const soon = this.now().getTime() + 7 * 86_400_000
    return (await this.store.listApiKeys(userId)).map((key) => ({
      ...toApiKeyView(key),
      ...(key.expiresAt && !key.revokedAt && Date.parse(key.expiresAt) <= soon ? { expiringSoon: true } : {}),
    }))
  }

  /** 到期提醒：未吊销且将在 withinDays 天内过期的 key。 */
  async expiringApiKeys(withinDays: number): Promise<Array<ApiKeyView & { userId: string }>> {
    const now = this.now().getTime()
    const deadline = now + withinDays * 86_400_000
    return (await this.store.listApiKeys())
      .filter((key) => {
        if (!key.expiresAt || key.revokedAt) return false
        const expiresAt = Date.parse(key.expiresAt)
        // 已经过期的 key 不再提醒，等保留期清理。
        return expiresAt > now && expiresAt <= deadline
      })
      .map((key) => ({ ...toApiKeyView(key), expiringSoon: true }))
  }

  /** 清理过期/吊销的 key 行；保留期内仍可在页面看到历史。 */
  async cleanupApiKeys(before: string): Promise<number> {
    return this.store.purgeApiKeys(before)
  }

  /**
   * 轮换：按旧 key 的名称、scope 和原始有效期签发新 key，再吊销旧 key。
   * 旧 key 已吊销或不存在时报错；新 token 只在这里返回一次。
   */
  async rotateApiKey(id: string, issuedBy?: string): Promise<{ key: ApiKeyView; token: string }> {
    const old = await this.store.getApiKey(id)
    if (!old) throw new AuthError('API key 不存在', 'not_found', 404)
    if (old.revokedAt) throw new AuthError('已吊销的 key 不能轮换', 'bad_request')
    const lifetime = old.expiresAt ? Date.parse(old.expiresAt) - Date.parse(old.createdAt) : undefined
    const expiresAt =
      lifetime && Number.isFinite(lifetime) && lifetime > 0
        ? new Date(this.now().getTime() + lifetime).toISOString()
        : undefined
    const created = await this.createApiKey(old.userId, {
      name: old.name,
      scopes: old.scopes,
      ...(expiresAt ? { expiresAt } : {}),
      ...(issuedBy ? { issuedBy } : {}),
    })
    await this.revokeApiKey(old.id)
    await this.recordEvent('auth.api_key_rotated', {}, {
      userId: old.userId,
      keyId: created.key.id,
      replacedKeyId: old.id,
      ...(issuedBy ? { issuedBy } : {}),
    })
    return created
  }

  async revokeApiKey(id: string): Promise<boolean> {
    const key = await this.store.getApiKey(id)
    if (!key) return false
    const revoked = await this.store.revokeApiKey(id, this.now().toISOString())
    if (revoked) await this.recordEvent('auth.api_key_revoked', {}, { userId: key.userId, keyId: id })
    return revoked
  }

  async resolveApiKey(token: string, context: AuthContext = {}): Promise<ApiKeyAuthResult | undefined> {
    const match = /^aiops_(key[0-9a-f]+)_(.+)$/.exec(token)
    if (!match) return undefined
    const [, id, secret] = match
    if (!secret) return undefined
    const key = await this.store.getApiKey(id)
    if (!key) return undefined
    const digest = Buffer.from(hashToken(token), 'hex')
    const expected = Buffer.from(key.tokenHash, 'hex')
    if (digest.length !== expected.length || !timingSafeEqual(digest, expected)) return undefined
    if (key.revokedAt) return undefined
    if (key.expiresAt && key.expiresAt <= this.now().toISOString()) return undefined
    const user = await this.store.getUser(key.userId)
    if (!user || user.status !== 'active') return undefined
    const now = this.now()
    const previousMs = key.lastUsedAt ? Date.parse(key.lastUsedAt) : Number.NaN
    const gap = Number.isFinite(previousMs) ? now.getTime() - previousMs : Number.POSITIVE_INFINITY
    if (gap >= this.sessionTouchMs) {
      const lastUsedAt = now.toISOString()
      await this.store.touchApiKey(key.id, lastUsedAt)
      key.lastUsedAt = lastUsedAt
    }
    // 使用事件降噪：同一 key 闲置超过 apiKeyEventMs 后的首次使用才记一条，持续调用不刷屏。
    if (gap >= this.apiKeyEventMs) {
      await this.recordEvent('auth.api_key_used', context, { userId: user.id, keyId: key.id })
    }
    return { user, key }
  }

  async listSecurityEvents(
    limit = 100,
    offset = 0,
    filter: { since?: string; until?: string; type?: string } = {},
  ): Promise<SecurityEventRecord[]> {
    return this.store.listSecurityEvents(Math.min(Math.max(limit, 1), 500), Math.max(0, offset), filter)
  }

  /** 导出专用：允许大于页面分页上限，但仍限制单次条数，避免一次拉爆内存。 */
  async exportSecurityEvents(
    limit: number,
    filter: { since?: string; until?: string; type?: string } = {},
  ): Promise<SecurityEventRecord[]> {
    return this.store.listSecurityEvents(Math.min(Math.max(limit, 1), 5000), 0, filter)
  }

  async countSecurityEvents(): Promise<number> {
    return this.store.countSecurityEvents()
  }

  /** 保留期清理；返回删除条数。 */
  async cleanupSecurityEvents(before: string): Promise<number> {
    return this.store.purgeSecurityEvents(before)
  }

  /** 配置类变更和登录/账号事件共用同一张事件表；detail 禁止放密码、token、私钥。 */
  async recordConfigEvent(
    type: string,
    detail: Record<string, unknown>,
    context: AuthContext = {},
  ): Promise<void> {
    await this.recordEvent(type, context, detail)
  }

  async cleanupSessions(): Promise<void> {
    await this.store.purgeExpiredSessions(this.now().toISOString())
  }

  /** 登录失败记录只保留一个失败窗口，过期行定期清掉。 */
  async cleanupLoginFailures(): Promise<number> {
    return this.store.purgeLoginFailures(new Date(this.now().getTime() - this.failureWindowMs).toISOString())
  }

  private failureKey(username: string, ip?: string): string {
    return `${username}|${ip ?? '-'}`
  }

  /**
   * 失败计数落在共享存储里，多实例共用同一把锁。
   * 窗口内失败达到阈值后，从最近一次失败起锁定 lockoutMs；锁定期间再尝试会继续顺延。
   */
  private async assertNotLocked(key: string): Promise<void> {
    if (this.maxLoginFailures <= 0) return
    const now = this.now().getTime()
    const since = new Date(now - this.failureWindowMs).toISOString()
    const recent = await this.store.listLoginFailures(key, since, this.maxLoginFailures)
    if (recent.length < this.maxLoginFailures) return
    const newest = Date.parse(recent[0] ?? '')
    if (Number.isFinite(newest) && now < newest + this.lockoutMs) {
      throw new AuthError('登录失败次数过多，请稍后再试', 'locked', 429)
    }
  }

  private async recordFailure(key: string): Promise<void> {
    await this.store.recordLoginFailure(key, this.now().toISOString())
  }

  private async recordEvent(type: string, context: AuthContext, detail: Record<string, unknown>): Promise<void> {
    await this.store.appendSecurityEvent({
      id: `sec_${randomBytes(8).toString('hex')}`,
      at: this.now().toISOString(),
      type,
      ...(typeof detail.userId === 'string' ? { userId: detail.userId } : {}),
      ...(typeof detail.username === 'string' ? { username: detail.username } : {}),
      ...(context.ip ? { ip: context.ip } : {}),
      detail,
    })
  }
}