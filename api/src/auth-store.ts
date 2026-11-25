import type { Role } from './types.ts'

/** 本地账号；externalId 为将来接统一身份源预留。 */
export interface UserRecord {
  id: string
  username: string
  displayName: string
  passwordHash?: string
  roles: Role[]
  status: 'active' | 'disabled'
  source: string
  externalId?: string
  email?: string
  mustChangePassword: boolean
  createdAt: string
  updatedAt: string
  lastLoginAt?: string
}

export interface SessionRecord {
  /** 对外可见的会话标识；不暴露 token 哈希。 */
  id: string
  /** 只存 token 的 SHA-256。 */
  tokenHash: string
  userId: string
  csrfToken: string
  createdAt: string
  /** 绝对过期时间。 */
  expiresAt: string
  lastSeenAt: string
  ip?: string
  userAgent?: string
}

export type ApiScope =
  | 'tasks:read'
  | 'tasks:write'
  | 'approvals:read'
  | 'approvals:write'
  | 'tools:execute'
  | 'knowledge:read'
  | 'admin'

export interface ApiKeyRecord {
  id: string
  userId: string
  name: string
  /** 只存完整 token 的 SHA-256。 */
  tokenHash: string
  scopes: ApiScope[]
  createdAt: string
  expiresAt?: string
  lastUsedAt?: string
  revokedAt?: string
}

/** 登录失败按 username|IP 聚合，用于管理员查看和解锁。 */
export interface LoginFailureSummary {
  attemptKey: string
  failures: number
  lastAt: string
}

export interface SecurityEventRecord {
  id: string
  at: string
  type: string
  userId?: string
  username?: string
  ip?: string
  detail?: Record<string, unknown>
}

export interface AuthStore {
  createUser(user: UserRecord): Promise<void>
  getUser(id: string): Promise<UserRecord | undefined>
  getUserByUsername(username: string): Promise<UserRecord | undefined>
  listUsers(): Promise<UserRecord[]>
  saveUser(user: UserRecord): Promise<void>

  createSession(session: SessionRecord): Promise<void>
  getSession(tokenHash: string): Promise<SessionRecord | undefined>
  touchSession(tokenHash: string, lastSeenAt: string): Promise<void>
  deleteSession(tokenHash: string): Promise<void>
  listSessionsForUser(userId: string): Promise<SessionRecord[]>
  deleteSessionsForUser(userId: string): Promise<void>
  deleteSessionForUser(userId: string, sessionId: string): Promise<boolean>
  /** 保留当前会话，删除该用户其它会话；返回删除条数。 */
  deleteOtherSessionsForUser(userId: string, keepTokenHash: string): Promise<number>
  purgeExpiredSessions(now: string): Promise<void>

  /** 登录限速跨实例共享：按 username+IP 记录失败时间。 */
  recordLoginFailure(attemptKey: string, at: string): Promise<void>
  /** 按时间倒序返回窗口内的失败时间。 */
  listLoginFailures(attemptKey: string, since: string, limit: number): Promise<string[]>
  /** 按 attemptKey 聚合窗口内的失败次数，供管理员查看锁定状态。 */
  listLoginFailureSummaries(since: string): Promise<LoginFailureSummary[]>
  clearLoginFailures(attemptKey: string): Promise<void>
  /** 清除某个用户名在所有来源 IP 上的失败记录；返回删除条数。 */
  clearLoginFailuresForUsername(username: string): Promise<number>
  purgeLoginFailures(before: string): Promise<number>

  createApiKey(key: ApiKeyRecord): Promise<void>
  getApiKey(id: string): Promise<ApiKeyRecord | undefined>
  getApiKeyByHash(tokenHash: string): Promise<ApiKeyRecord | undefined>
  listApiKeys(userId?: string): Promise<ApiKeyRecord[]>
  revokeApiKey(id: string, at: string): Promise<boolean>
  touchApiKey(id: string, lastUsedAt: string): Promise<void>
  /** 删除过期/吊销时间早于 cutoff 的 key 行；返回删除条数。 */
  purgeApiKeys(before: string): Promise<number>

  appendSecurityEvent(event: SecurityEventRecord): Promise<void>
  /** 按 seq 倒序（最新在前）分页读取；时间过滤用 ISO 字符串。 */
  listSecurityEvents(
    limit: number,
    offset?: number,
    filter?: { since?: string; until?: string; type?: string },
  ): Promise<SecurityEventRecord[]>
  countSecurityEvents(): Promise<number>
  purgeSecurityEvents(before: string): Promise<number>
}

/** MySQL Store 同时实现任务和认证接口；用它判断能否启用账号认证。 */
export function isAuthStore(value: unknown): value is AuthStore {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as Partial<AuthStore>).getUser === 'function' &&
    typeof (value as Partial<AuthStore>).createSession === 'function'
  )
}

/** 测试和无数据库环境的内存实现。 */
export class MemoryAuthStore implements AuthStore {
  private readonly users = new Map<string, UserRecord>()
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly keys = new Map<string, ApiKeyRecord>()
  private readonly securityEvents: SecurityEventRecord[] = []
  private readonly loginFailures = new Map<string, string[]>()

  async createUser(user: UserRecord): Promise<void> {
    const username = user.username.toLowerCase()
    if ([...this.users.values()].some((item) => item.username === username)) {
      throw new Error('用户名已存在')
    }
    this.users.set(user.id, structuredClone(user))
  }

  async getUser(id: string): Promise<UserRecord | undefined> {
    const user = this.users.get(id)
    return user ? structuredClone(user) : undefined
  }

  async getUserByUsername(username: string): Promise<UserRecord | undefined> {
    const key = username.toLowerCase()
    const user = [...this.users.values()].find((item) => item.username === key)
    return user ? structuredClone(user) : undefined
  }

  async listUsers(): Promise<UserRecord[]> {
    return [...this.users.values()].map((user) => structuredClone(user))
  }

  async saveUser(user: UserRecord): Promise<void> {
    const username = user.username.toLowerCase()
    if ([...this.users.values()].some((item) => item.id !== user.id && item.username === username)) {
      throw new Error('用户名已存在')
    }
    this.users.set(user.id, structuredClone(user))
  }

  async createSession(session: SessionRecord): Promise<void> {
    this.sessions.set(session.tokenHash, structuredClone(session))
  }

  async getSession(tokenHash: string): Promise<SessionRecord | undefined> {
    const session = this.sessions.get(tokenHash)
    return session ? structuredClone(session) : undefined
  }

  async touchSession(tokenHash: string, lastSeenAt: string): Promise<void> {
    const session = this.sessions.get(tokenHash)
    if (session) session.lastSeenAt = lastSeenAt
  }

  async deleteSession(tokenHash: string): Promise<void> {
    this.sessions.delete(tokenHash)
  }

  async listSessionsForUser(userId: string): Promise<SessionRecord[]> {
    return [...this.sessions.values()]
      .filter((session) => session.userId === userId)
      .map((session) => structuredClone(session))
  }

  async deleteSessionsForUser(userId: string): Promise<void> {
    for (const [hash, session] of this.sessions) {
      if (session.userId === userId) this.sessions.delete(hash)
    }
  }

  async deleteSessionForUser(userId: string, sessionId: string): Promise<boolean> {
    for (const [hash, session] of this.sessions) {
      if (session.userId === userId && session.id === sessionId) {
        this.sessions.delete(hash)
        return true
      }
    }
    return false
  }

  async deleteOtherSessionsForUser(userId: string, keepTokenHash: string): Promise<number> {
    let removed = 0
    for (const [hash, session] of this.sessions) {
      if (session.userId === userId && hash !== keepTokenHash) {
        this.sessions.delete(hash)
        removed += 1
      }
    }
    return removed
  }

  async recordLoginFailure(attemptKey: string, at: string): Promise<void> {
    const list = this.loginFailures.get(attemptKey) ?? []
    list.push(at)
    this.loginFailures.set(attemptKey, list)
  }

  async listLoginFailures(attemptKey: string, since: string, limit: number): Promise<string[]> {
    return (this.loginFailures.get(attemptKey) ?? [])
      .filter((at) => at >= since)
      .sort((a, b) => b.localeCompare(a))
      .slice(0, limit)
  }

  async listLoginFailureSummaries(since: string): Promise<LoginFailureSummary[]> {
    const summaries: LoginFailureSummary[] = []
    for (const [attemptKey, times] of this.loginFailures) {
      const recent = times.filter((at) => at >= since)
      if (recent.length === 0) continue
      summaries.push({
        attemptKey,
        failures: recent.length,
        lastAt: recent.reduce((latest, at) => (at > latest ? at : latest), ''),
      })
    }
    return summaries.sort((a, b) => b.lastAt.localeCompare(a.lastAt)).slice(0, 500)
  }

  async clearLoginFailures(attemptKey: string): Promise<void> {
    this.loginFailures.delete(attemptKey)
  }

  async clearLoginFailuresForUsername(username: string): Promise<number> {
    let removed = 0
    const prefix = `${username}|`
    for (const [attemptKey, times] of this.loginFailures) {
      if (!attemptKey.startsWith(prefix)) continue
      removed += times.length
      this.loginFailures.delete(attemptKey)
    }
    return removed
  }

  async purgeLoginFailures(before: string): Promise<number> {
    let removed = 0
    for (const [key, times] of this.loginFailures) {
      const kept = times.filter((at) => at >= before)
      removed += times.length - kept.length
      if (kept.length === 0) this.loginFailures.delete(key)
      else this.loginFailures.set(key, kept)
    }
    return removed
  }

  async purgeApiKeys(before: string): Promise<number> {
    let removed = 0
    for (const [id, key] of this.keys) {
      if ((key.revokedAt && key.revokedAt < before) || (key.expiresAt && key.expiresAt < before)) {
        this.keys.delete(id)
        removed += 1
      }
    }
    return removed
  }

  async purgeExpiredSessions(now: string): Promise<void> {
    for (const [hash, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(hash)
    }
  }

  async createApiKey(key: ApiKeyRecord): Promise<void> {
    this.keys.set(key.id, structuredClone(key))
  }

  async getApiKey(id: string): Promise<ApiKeyRecord | undefined> {
    const key = this.keys.get(id)
    return key ? structuredClone(key) : undefined
  }

  async getApiKeyByHash(tokenHash: string): Promise<ApiKeyRecord | undefined> {
    const key = [...this.keys.values()].find((item) => item.tokenHash === tokenHash)
    return key ? structuredClone(key) : undefined
  }

  async listApiKeys(userId?: string): Promise<ApiKeyRecord[]> {
    return [...this.keys.values()]
      .filter((key) => !userId || key.userId === userId)
      .map((key) => structuredClone(key))
  }

  async revokeApiKey(id: string, at: string): Promise<boolean> {
    const key = this.keys.get(id)
    if (!key || key.revokedAt) return false
    key.revokedAt = at
    return true
  }

  async touchApiKey(id: string, lastUsedAt: string): Promise<void> {
    const key = this.keys.get(id)
    if (key) key.lastUsedAt = lastUsedAt
  }

  async appendSecurityEvent(event: SecurityEventRecord): Promise<void> {
    this.securityEvents.push(structuredClone(event))
  }

  async listSecurityEvents(
    limit: number,
    offset = 0,
    filter: { since?: string; until?: string; type?: string } = {},
  ): Promise<SecurityEventRecord[]> {
    const matches = this.securityEvents.filter(
      (event) =>
        (!filter.since || event.at >= filter.since) &&
        (!filter.until || event.at <= filter.until) &&
        (!filter.type || event.type === filter.type),
    )
    const end = matches.length - Math.max(0, offset)
    const start = Math.max(0, end - Math.max(1, limit))
    return matches.slice(start, Math.max(0, end)).reverse().map((event) => structuredClone(event))
  }

  async countSecurityEvents(): Promise<number> {
    return this.securityEvents.length
  }

  async purgeSecurityEvents(before: string): Promise<number> {
    const kept = this.securityEvents.filter((event) => event.at >= before)
    const removed = this.securityEvents.length - kept.length
    this.securityEvents.length = 0
    this.securityEvents.push(...kept)
    return removed
  }
}