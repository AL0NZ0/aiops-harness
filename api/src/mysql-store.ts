import { createHash } from 'node:crypto'
import { createPool, type Pool, type PoolConnection, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise'
import type { ApiKeyRecord, AuthStore, SecurityEventRecord, SessionRecord, UserRecord } from './auth-store.ts'
import type {
  ApprovalDecision,
  ApprovalQuery,
  QueryPage,
  Store,
  StoreTx,
  TaskQuery,
  TaskVisibility,
} from './store.ts'
import type {
  Approval,
  AuditDecision,
  AuditRecord,
  Risk,
  Role,
  Task,
  TaskEvent,
  TaskOrigin,
  TaskStatus,
  TaskUsage,
} from './types.ts'

/** 不传 limit 时用一个足够大的定值，保持 ORDER BY 稳定性。 */
const ALL_ROWS = 4_294_967_295

/**
 * 任务可见性 SQL 片段。列表和总览计数必须共用这段逻辑，
 * 否则页面上的数字会和列表对不上，甚至把别人的任务数暴露出来。
 */
function taskVisibilityClause(query: TaskVisibility): {
  where: string[]
  params: unknown[]
  deny: boolean
} {
  if (query.seeAll) return { where: [], params: [], deny: false }
  if (!query.actorId) return { where: [], params: [], deny: true }
  if (query.approver) {
    return {
      where: ['(owner_id = ? OR EXISTS (SELECT 1 FROM approvals a WHERE a.task_id = tasks.id))'],
      params: [query.actorId],
      deny: false,
    }
  }
  return { where: ['owner_id = ?'], params: [query.actorId], deny: false }
}

function statusCounts(rows: RowDataPacket[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const row of rows) counts[String(row.status)] = Number(row.total ?? 0)
  return counts
}

export interface MySqlConfig {
  host: string
  port: number
  user: string
  password: string
  database: string
}

type Executor = Pool | PoolConnection

class MySqlBase implements StoreTx {
  constructor(protected readonly db: Executor) {}

  async saveTask(task: Task): Promise<void> {
    await this.run(
      `INSERT INTO tasks
        (id, session_id, owner_id, title, prompt, skill, status, origin, runner_id, alert_source_id, created_at, updated_at, result, error, \`usage\`)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        session_id=VALUES(session_id), owner_id=VALUES(owner_id), title=VALUES(title),
        prompt=VALUES(prompt), skill=VALUES(skill), status=VALUES(status), origin=VALUES(origin),
        runner_id=VALUES(runner_id), alert_source_id=VALUES(alert_source_id),
        created_at=VALUES(created_at), updated_at=VALUES(updated_at),
        result=VALUES(result), error=VALUES(error), \`usage\`=VALUES(\`usage\`)`,
      [
        task.id,
        task.sessionId,
        task.ownerId,
        task.title,
        task.prompt,
        task.skill,
        task.status,
        task.origin ?? null,
        task.runnerId ?? null,
        task.alertSourceId ?? null,
        task.createdAt,
        task.updatedAt,
        task.result ?? null,
        task.error ?? null,
        task.usage ? JSON.stringify(task.usage) : null,
      ],
    )
  }

  async getTask(id: string): Promise<Task | undefined> {
    const rows = await this.rows('SELECT * FROM tasks WHERE id = ? LIMIT 1', [id])
    return rows[0] ? taskOf(rows[0]) : undefined
  }

  async listTasks(): Promise<Task[]> {
    const rows = await this.rows('SELECT * FROM tasks')
    return rows.map(taskOf)
  }

  async appendEvent(event: TaskEvent): Promise<void> {
    await this.run(
      'INSERT INTO task_events (id, task_id, type, at, data) VALUES (?, ?, ?, ?, ?)',
      [event.id, event.taskId, event.type, event.at, JSON.stringify(event.data ?? null)],
    )
  }

  async eventsFor(taskId: string): Promise<TaskEvent[]> {
    const rows = await this.rows('SELECT * FROM task_events WHERE task_id = ? ORDER BY seq ASC', [taskId])
    return rows.map((row) => ({
      id: String(row.id),
      taskId: String(row.task_id),
      type: String(row.type),
      at: String(row.at),
      data: parseJson(row.data),
    }))
  }

  async saveApproval(approval: Approval): Promise<void> {
    await this.run(
      `INSERT INTO approvals
        (id, task_id, owner_id, tool, args, args_hash, status, requested_by, requested_at, decided_by, decided_at, comment, consumed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        task_id=VALUES(task_id), owner_id=VALUES(owner_id), tool=VALUES(tool), args=VALUES(args),
        args_hash=VALUES(args_hash), status=VALUES(status), requested_by=VALUES(requested_by),
        requested_at=VALUES(requested_at), decided_by=VALUES(decided_by), decided_at=VALUES(decided_at),
        comment=VALUES(comment), consumed=VALUES(consumed)`,
      [
        approval.id,
        approval.taskId,
        approval.ownerId,
        approval.tool,
        JSON.stringify(approval.args ?? {}),
        approval.argsHash,
        approval.status,
        approval.requestedBy,
        approval.requestedAt,
        approval.decidedBy ?? null,
        approval.decidedAt ?? null,
        approval.comment ?? null,
        approval.consumed ? 1 : 0,
      ],
    )
  }

  async getApproval(id: string): Promise<Approval | undefined> {
    const rows = await this.rows('SELECT * FROM approvals WHERE id = ? LIMIT 1', [id])
    return rows[0] ? approvalOf(rows[0]) : undefined
  }

  async listApprovals(): Promise<Approval[]> {
    const rows = await this.rows('SELECT * FROM approvals')
    return rows.map(approvalOf)
  }

  async queryTasks(query: TaskQuery): Promise<QueryPage<Task>> {
    const visibility = taskVisibilityClause(query)
    if (visibility.deny) return { items: [], total: 0 }
    const where = [...visibility.where]
    const params = [...visibility.params]
    if (query.status) {
      where.push('status = ?')
      params.push(query.status)
    }
    if (query.ownerId) {
      where.push('owner_id = ?')
      params.push(query.ownerId)
    }
    if (query.origin) {
      where.push('origin = ?')
      params.push(query.origin)
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const countRows = await this.rows(`SELECT COUNT(*) AS total FROM tasks ${clause}`, params)
    const total = Number(countRows[0]?.total ?? 0)
    const limit = query.limit ?? ALL_ROWS
    const rows = await this.rows(
      `SELECT * FROM tasks ${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      [...params, limit, Math.max(0, query.offset ?? 0)],
    )
    return { items: rows.map(taskOf), total }
  }

  async queryApprovals(query: ApprovalQuery): Promise<QueryPage<Approval>> {
    const where: string[] = []
    const params: unknown[] = []
    if (query.status) {
      where.push('status = ?')
      params.push(query.status)
    }
    if (query.taskId) {
      where.push('task_id = ?')
      params.push(query.taskId)
    }
    if (!query.seeAll) {
      if (!query.actorId) return { items: [], total: 0 }
      where.push(
        '(requested_by = ? OR EXISTS (SELECT 1 FROM tasks t WHERE t.id = approvals.task_id AND t.owner_id = ?))',
      )
      params.push(query.actorId, query.actorId)
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const countRows = await this.rows(`SELECT COUNT(*) AS total FROM approvals ${clause}`, params)
    const total = Number(countRows[0]?.total ?? 0)
    const limit = query.limit ?? ALL_ROWS
    const rows = await this.rows(
      `SELECT * FROM approvals ${clause} ORDER BY requested_at DESC, id DESC LIMIT ? OFFSET ?`,
      [...params, limit, Math.max(0, query.offset ?? 0)],
    )
    return { items: rows.map(approvalOf), total }
  }

  async decideApproval(
    id: string,
    decision: ApprovalDecision,
    decidedBy: string,
    decidedAt: string,
    comment?: string,
  ): Promise<boolean> {
    const result = await this.run(
      `UPDATE approvals
       SET status = ?, decided_by = ?, decided_at = ?, comment = ?
       WHERE id = ? AND status = 'pending'`,
      [decision, decidedBy, decidedAt, comment?.trim() || null, id],
    )
    return result.affectedRows === 1
  }

  async consumeApproval(id: string): Promise<boolean> {
    const result = await this.run(
      `UPDATE approvals SET consumed = 1
       WHERE id = ? AND status = 'approved' AND consumed = 0`,
      [id],
    )
    return result.affectedRows === 1
  }

  async appendAudit(audit: AuditRecord): Promise<void> {
    await this.run(
      `INSERT INTO audit_records
        (id, task_id, actor_id, tool, risk, args, decision, approval_id, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        audit.id,
        audit.taskId,
        audit.actorId,
        audit.tool,
        audit.risk,
        JSON.stringify(audit.args ?? {}),
        audit.decision,
        audit.approvalId ?? null,
        audit.at,
      ],
    )
  }

  async auditsFor(taskId: string): Promise<AuditRecord[]> {
    const rows = await this.rows('SELECT * FROM audit_records WHERE task_id = ? ORDER BY seq ASC', [taskId])
    return rows.map(auditOf)
  }

  async updateAudit(id: string, decision: AuditRecord['decision']): Promise<void> {
    await this.run('UPDATE audit_records SET decision = ? WHERE id = ?', [decision, id])
  }

  protected async rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
    const [result] = await this.db.query(sql, params)
    return result as RowDataPacket[]
  }

  protected async run(sql: string, params: unknown[] = []): Promise<ResultSetHeader> {
    const [result] = await this.db.query(sql, params)
    return result as ResultSetHeader
  }
}

class MySqlTx extends MySqlBase {}

export class MySqlStore extends MySqlBase implements Store, AuthStore {
  private readonly pool: Pool

  constructor(config: MySqlConfig) {
    const pool = createPool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      charset: 'utf8mb4',
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      connectTimeout: 5_000,
      timezone: 'Z',
    })
    super(pool)
    this.pool = pool
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id VARCHAR(64) PRIMARY KEY,
        session_id VARCHAR(128) NOT NULL,
        owner_id VARCHAR(64) NOT NULL,
        title VARCHAR(255) NOT NULL,
        prompt TEXT NOT NULL,
        skill VARCHAR(128) NOT NULL,
        status VARCHAR(32) NOT NULL,
        origin VARCHAR(16) NULL,
        runner_id VARCHAR(64) NULL,
        created_at VARCHAR(32) NOT NULL,
        updated_at VARCHAR(32) NOT NULL,
        result MEDIUMTEXT NULL,
        error TEXT NULL,
        KEY idx_tasks_status_created (status, created_at),
        KEY idx_tasks_owner_created (owner_id, created_at),
        KEY idx_tasks_runner_status (runner_id, status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS task_events (
        seq BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        id VARCHAR(64) NOT NULL UNIQUE,
        task_id VARCHAR(64) NOT NULL,
        type VARCHAR(64) NOT NULL,
        at VARCHAR(32) NOT NULL,
        data JSON NULL,
        KEY idx_events_task_seq (task_id, seq)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS approvals (
        id VARCHAR(64) PRIMARY KEY,
        task_id VARCHAR(64) NOT NULL,
        owner_id VARCHAR(64) NOT NULL,
        tool VARCHAR(128) NOT NULL,
        args JSON NOT NULL,
        args_hash TEXT NOT NULL,
        status VARCHAR(16) NOT NULL,
        requested_by VARCHAR(64) NOT NULL,
        requested_at VARCHAR(32) NOT NULL,
        decided_by VARCHAR(64) NULL,
        decided_at VARCHAR(32) NULL,
        comment TEXT NULL,
        consumed TINYINT(1) NOT NULL DEFAULT 0,
        KEY idx_approvals_status_requested (status, requested_at),
        KEY idx_approvals_task (task_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS audit_records (
        seq BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        id VARCHAR(64) NOT NULL UNIQUE,
        task_id VARCHAR(64) NOT NULL,
        actor_id VARCHAR(64) NOT NULL,
        tool VARCHAR(128) NOT NULL,
        risk VARCHAR(16) NOT NULL,
        args JSON NOT NULL,
        decision VARCHAR(32) NOT NULL,
        approval_id VARCHAR(64) NULL,
        at VARCHAR(32) NOT NULL,
        KEY idx_audit_task_seq (task_id, seq)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INT PRIMARY KEY,
        applied_at VARCHAR(32) NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `)
    await this.pool.query(
      'INSERT IGNORE INTO schema_migrations (version, applied_at) VALUES (1, ?)',
      [new Date().toISOString()],
    )
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(64) PRIMARY KEY,
        username VARCHAR(64) NOT NULL UNIQUE,
        display_name VARCHAR(128) NOT NULL,
        password_hash VARCHAR(255) NULL,
        roles JSON NOT NULL,
        status VARCHAR(16) NOT NULL,
        source VARCHAR(16) NOT NULL DEFAULT 'local',
        external_id VARCHAR(255) NULL,
        email VARCHAR(255) NULL,
        must_change_password TINYINT(1) NOT NULL DEFAULT 0,
        created_at VARCHAR(32) NOT NULL,
        updated_at VARCHAR(32) NOT NULL,
        last_login_at VARCHAR(32) NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash VARCHAR(64) PRIMARY KEY,
        id VARCHAR(64) NULL,
        user_id VARCHAR(64) NOT NULL,
        csrf_token VARCHAR(128) NOT NULL,
        created_at VARCHAR(32) NOT NULL,
        expires_at VARCHAR(32) NOT NULL,
        last_seen_at VARCHAR(32) NOT NULL,
        ip VARCHAR(64) NULL,
        user_agent VARCHAR(512) NULL,
        UNIQUE KEY uk_sessions_id (id),
        KEY idx_sessions_user (user_id),
        KEY idx_sessions_expires (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS login_failures (
        seq BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        attempt_key VARCHAR(200) NOT NULL,
        at VARCHAR(32) NOT NULL,
        KEY idx_login_failures_key_at (attempt_key, at),
        KEY idx_login_failures_at (at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id VARCHAR(64) PRIMARY KEY,
        user_id VARCHAR(64) NOT NULL,
        name VARCHAR(128) NOT NULL,
        token_hash VARCHAR(64) NOT NULL UNIQUE,
        scopes JSON NOT NULL,
        created_at VARCHAR(32) NOT NULL,
        expires_at VARCHAR(32) NULL,
        last_used_at VARCHAR(32) NULL,
        revoked_at VARCHAR(32) NULL,
        KEY idx_api_keys_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS security_events (
        seq BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        id VARCHAR(64) NOT NULL UNIQUE,
        at VARCHAR(32) NOT NULL,
        type VARCHAR(64) NOT NULL,
        user_id VARCHAR(64) NULL,
        username VARCHAR(128) NULL,
        ip VARCHAR(64) NULL,
        detail JSON NULL,
        KEY idx_security_events_at (at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `)
    await this.pool.query(
      'INSERT IGNORE INTO schema_migrations (version, applied_at) VALUES (2, ?)',
      [new Date().toISOString()],
    )
    await this.migrate()
  }

  /**
   * 版本化迁移只做 additive 变更，保证回滚一个版本时旧代码仍能读写。
   * GET_LOCK 防止多副本同时启动时并发改表；拿不到锁直接失败，不静默跳过。
   */
  private async migrate(): Promise<void> {
    const [lockRows] = await this.pool.query('SELECT GET_LOCK(?, 30) AS ok', ['aiops_schema_migrate'])
    const locked = Array.isArray(lockRows) && (lockRows[0] as { ok?: number | null } | undefined)?.ok === 1
    if (!locked) throw new Error('获取数据库迁移锁超时，另一个实例可能正在迁移')
    try {
      const [appliedRows] = await this.pool.query('SELECT version FROM schema_migrations')
      const applied = new Set(
        (Array.isArray(appliedRows) ? appliedRows : []).map((row) => Number((row as { version: unknown }).version)),
      )
      const migrations: Array<{ version: number; run: () => Promise<void> }> = [
        {
          version: 3,
          run: async () => {
            await this.ensureColumn('tasks', 'origin', 'VARCHAR(16) NULL')
            await this.ensureColumn('approvals', 'consumed', 'TINYINT(1) NOT NULL DEFAULT 0')
          },
        },
        {
          version: 4,
          run: async () => {
            await this.ensureColumn('users', 'source', "VARCHAR(16) NOT NULL DEFAULT 'local'")
            await this.ensureColumn('users', 'external_id', 'VARCHAR(255) NULL')
            await this.ensureColumn('users', 'email', 'VARCHAR(255) NULL')
            await this.ensureColumn('users', 'must_change_password', 'TINYINT(1) NOT NULL DEFAULT 0')
          },
        },
        {
          version: 5,
          run: async () => {
            await this.ensureColumn('api_keys', 'expires_at', 'VARCHAR(32) NULL')
            await this.ensureColumn('api_keys', 'last_used_at', 'VARCHAR(32) NULL')
            await this.ensureColumn('api_keys', 'revoked_at', 'VARCHAR(32) NULL')
          },
        },
        {
          version: 6,
          run: async () => {
            await this.ensureColumn('tasks', 'runner_id', 'VARCHAR(64) NULL')
            await this.ensureIndex('tasks', 'idx_tasks_runner_status', '(runner_id, status)')
          },
        },
        {
          version: 7,
          run: async () => {
            await this.ensureColumn('sessions', 'id', 'VARCHAR(64) NULL')
            await this.pool.query("UPDATE sessions SET id = SHA2(token_hash, 256) WHERE id IS NULL OR id = ''")
            await this.ensureIndex('sessions', 'uk_sessions_id', '(id)', true)
          },
        },
        {
          version: 8,
          run: async () => {
            await this.ensureColumn('tasks', 'usage', 'JSON NULL')
          },
        },
        {
          version: 9,
          run: async () => {
            await this.ensureColumn('tasks', 'alert_source_id', 'VARCHAR(64) NULL')
            await this.ensureIndex('tasks', 'idx_tasks_alert_source', '(alert_source_id, created_at)')
          },
        },
      ]
      for (const migration of migrations) {
        if (applied.has(migration.version)) continue
        await migration.run()
        await this.pool.query(
          'INSERT IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)',
          [migration.version, new Date().toISOString()],
        )
      }
    } finally {
      await this.pool.query('SELECT RELEASE_LOCK(?)', ['aiops_schema_migrate']).catch(() => undefined)
    }
  }

  private async ensureColumn(table: string, column: string, definition: string): Promise<void> {
    const [rows] = await this.pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
      [table, column],
    )
    if (Array.isArray(rows) && rows.length > 0) return
    // 表名和列名来自本文件常量，不走用户输入；definition 同理。
    await this.pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`)
  }

  private async ensureIndex(table: string, index: string, columns: string, unique = false): Promise<void> {
    const [rows] = await this.pool.query(
      `SELECT 1 FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1`,
      [table, index],
    )
    if (Array.isArray(rows) && rows.length > 0) return
    // 表名、索引名和列定义来自本文件常量，不走用户输入。
    await this.pool.query(
      `ALTER TABLE \`${table}\` ADD ${unique ? 'UNIQUE ' : ''}INDEX \`${index}\` ${columns}`,
    )
  }

  async transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    const conn = await this.pool.getConnection()
    try {
      await conn.beginTransaction()
      const tx = new MySqlTx(conn)
      const result = await fn(tx)
      await conn.commit()
      return result
    } catch (error) {
      await conn.rollback()
      throw error
    } finally {
      conn.release()
    }
  }

  async createUser(user: UserRecord): Promise<void> {
    await this.run(
      `INSERT INTO users
        (id, username, display_name, password_hash, roles, status, source, external_id, email,
         must_change_password, created_at, updated_at, last_login_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        user.id,
        user.username,
        user.displayName,
        user.passwordHash ?? null,
        JSON.stringify(user.roles),
        user.status,
        user.source,
        user.externalId ?? null,
        user.email ?? null,
        user.mustChangePassword ? 1 : 0,
        user.createdAt,
        user.updatedAt,
        user.lastLoginAt ?? null,
      ],
    )
  }

  async getUser(id: string): Promise<UserRecord | undefined> {
    const rows = await this.rows('SELECT * FROM users WHERE id = ? LIMIT 1', [id])
    return rows[0] ? userOf(rows[0]) : undefined
  }

  async getUserByUsername(username: string): Promise<UserRecord | undefined> {
    const rows = await this.rows('SELECT * FROM users WHERE username = ? LIMIT 1', [username])
    return rows[0] ? userOf(rows[0]) : undefined
  }

  async listUsers(): Promise<UserRecord[]> {
    return (await this.rows('SELECT * FROM users ORDER BY username ASC')).map(userOf)
  }

  async saveUser(user: UserRecord): Promise<void> {
    await this.run(
      `UPDATE users SET
        username = ?, display_name = ?, password_hash = ?, roles = ?, status = ?, source = ?,
        external_id = ?, email = ?, must_change_password = ?, created_at = ?, updated_at = ?, last_login_at = ?
       WHERE id = ?`,
      [
        user.username,
        user.displayName,
        user.passwordHash ?? null,
        JSON.stringify(user.roles),
        user.status,
        user.source,
        user.externalId ?? null,
        user.email ?? null,
        user.mustChangePassword ? 1 : 0,
        user.createdAt,
        user.updatedAt,
        user.lastLoginAt ?? null,
        user.id,
      ],
    )
  }

  async createSession(session: SessionRecord): Promise<void> {
    await this.run(
      `INSERT INTO sessions (token_hash, id, user_id, csrf_token, created_at, expires_at, last_seen_at, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        session.tokenHash,
        session.id,
        session.userId,
        session.csrfToken,
        session.createdAt,
        session.expiresAt,
        session.lastSeenAt,
        session.ip ?? null,
        session.userAgent ?? null,
      ],
    )
  }

  async getSession(tokenHash: string): Promise<SessionRecord | undefined> {
    const rows = await this.rows('SELECT * FROM sessions WHERE token_hash = ? LIMIT 1', [tokenHash])
    return rows[0] ? sessionOf(rows[0]) : undefined
  }

  async touchSession(tokenHash: string, lastSeenAt: string): Promise<void> {
    await this.run('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?', [lastSeenAt, tokenHash])
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.run('DELETE FROM sessions WHERE token_hash = ?', [tokenHash])
  }

  async listSessionsForUser(userId: string): Promise<SessionRecord[]> {
    const rows = await this.rows('SELECT * FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC', [userId])
    return rows.map(sessionOf)
  }

  async deleteSessionsForUser(userId: string): Promise<void> {
    await this.run('DELETE FROM sessions WHERE user_id = ?', [userId])
  }

  async deleteSessionForUser(userId: string, sessionId: string): Promise<boolean> {
    const result = await this.run('DELETE FROM sessions WHERE user_id = ? AND id = ?', [userId, sessionId])
    return result.affectedRows > 0
  }

  async deleteOtherSessionsForUser(userId: string, keepTokenHash: string): Promise<number> {
    const result = await this.run('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', [
      userId,
      keepTokenHash,
    ])
    return result.affectedRows
  }

  async recordLoginFailure(attemptKey: string, at: string): Promise<void> {
    await this.run('INSERT INTO login_failures (attempt_key, at) VALUES (?, ?)', [attemptKey, at])
  }

  async listLoginFailures(attemptKey: string, since: string, limit: number): Promise<string[]> {
    const rows = await this.rows(
      'SELECT at FROM login_failures WHERE attempt_key = ? AND at >= ? ORDER BY at DESC LIMIT ?',
      [attemptKey, since, limit],
    )
    return rows.map((row) => String(row.at))
  }

  async clearLoginFailures(attemptKey: string): Promise<void> {
    await this.run('DELETE FROM login_failures WHERE attempt_key = ?', [attemptKey])
  }

  async purgeLoginFailures(before: string): Promise<number> {
    const result = await this.run('DELETE FROM login_failures WHERE at < ?', [before])
    return result.affectedRows
  }

  async purgeExpiredSessions(now: string): Promise<void> {
    await this.run('DELETE FROM sessions WHERE expires_at <= ?', [now])
  }

  async createApiKey(key: ApiKeyRecord): Promise<void> {
    await this.run(
      `INSERT INTO api_keys
        (id, user_id, name, token_hash, scopes, created_at, expires_at, last_used_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        key.id,
        key.userId,
        key.name,
        key.tokenHash,
        JSON.stringify(key.scopes),
        key.createdAt,
        key.expiresAt ?? null,
        key.lastUsedAt ?? null,
        key.revokedAt ?? null,
      ],
    )
  }

  async getApiKey(id: string): Promise<ApiKeyRecord | undefined> {
    const rows = await this.rows('SELECT * FROM api_keys WHERE id = ? LIMIT 1', [id])
    return rows[0] ? apiKeyOf(rows[0]) : undefined
  }

  async getApiKeyByHash(tokenHash: string): Promise<ApiKeyRecord | undefined> {
    const rows = await this.rows('SELECT * FROM api_keys WHERE token_hash = ? LIMIT 1', [tokenHash])
    return rows[0] ? apiKeyOf(rows[0]) : undefined
  }

  async listApiKeys(userId?: string): Promise<ApiKeyRecord[]> {
    const rows = userId
      ? await this.rows('SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC', [userId])
      : await this.rows('SELECT * FROM api_keys ORDER BY created_at DESC')
    return rows.map(apiKeyOf)
  }

  async revokeApiKey(id: string, at: string): Promise<boolean> {
    const result = await this.run(
      'UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
      [at, id],
    )
    return result.affectedRows > 0
  }

  async touchApiKey(id: string, lastUsedAt: string): Promise<void> {
    await this.run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', [lastUsedAt, id])
  }

  async purgeApiKeys(before: string): Promise<number> {
    const result = await this.run(
      `DELETE FROM api_keys
       WHERE (revoked_at IS NOT NULL AND revoked_at < ?)
          OR (expires_at IS NOT NULL AND expires_at < ?)`,
      [before, before],
    )
    return result.affectedRows
  }

  async appendSecurityEvent(event: SecurityEventRecord): Promise<void> {
    await this.run(
      `INSERT INTO security_events (id, at, type, user_id, username, ip, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        event.id,
        event.at,
        event.type,
        event.userId ?? null,
        event.username ?? null,
        event.ip ?? null,
        event.detail ? JSON.stringify(event.detail) : null,
      ],
    )
  }

  async listSecurityEvents(
    limit: number,
    offset = 0,
    filter: { since?: string; until?: string; type?: string } = {},
  ): Promise<SecurityEventRecord[]> {
    const where: string[] = []
    const params: unknown[] = []
    if (filter.since) {
      where.push('at >= ?')
      params.push(filter.since)
    }
    if (filter.until) {
      where.push('at <= ?')
      params.push(filter.until)
    }
    if (filter.type) {
      where.push('type = ?')
      params.push(filter.type)
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const rows = await this.rows(
      `SELECT * FROM security_events ${clause} ORDER BY seq DESC LIMIT ? OFFSET ?`,
      [...params, limit, Math.max(0, offset)],
    )
    return rows.map(securityEventOf)
  }

  async countSecurityEvents(): Promise<number> {
    const rows = await this.rows('SELECT COUNT(*) AS total FROM security_events')
    return Number(rows[0]?.total ?? 0)
  }

  async purgeSecurityEvents(before: string): Promise<number> {
    const result = await this.run('DELETE FROM security_events WHERE at < ?', [before])
    return result.affectedRows
  }

  async countTasksByStatus(filter?: TaskVisibility): Promise<Record<string, number>> {
    if (!filter) return this.countBy('tasks')
    const visibility = taskVisibilityClause(filter)
    if (visibility.deny) return {}
    const clause = visibility.where.length > 0 ? `WHERE ${visibility.where.join(' AND ')}` : ''
    const rows = await this.rows(
      `SELECT status, COUNT(*) AS total FROM tasks ${clause} GROUP BY status`,
      visibility.params,
    )
    return statusCounts(rows)
  }

  async countApprovalsByStatus(): Promise<Record<string, number>> {
    return this.countBy('approvals')
  }

  private async countBy(table: 'tasks' | 'approvals'): Promise<Record<string, number>> {
    const rows = await this.rows(`SELECT status, COUNT(*) AS total FROM ${table} GROUP BY status`)
    return statusCounts(rows)
  }

  /**
 * GET_LOCK 是连接级的，必须固定在一条连接上执行并在 finally 里释放；
 * 拿不到锁（另一个实例正在跑）返回 undefined，不排队等待。
 */
  async withAdvisoryLock<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
    const conn = await this.pool.getConnection()
    try {
      const [rows] = await conn.query('SELECT GET_LOCK(?, 0) AS ok', [name])
      const ok = Array.isArray(rows) && (rows[0] as { ok?: number | null } | undefined)?.ok === 1
      if (!ok) return undefined
      try {
        return await fn()
      } finally {
        await conn.query('SELECT RELEASE_LOCK(?)', [name]).catch(() => undefined)
      }
    } finally {
      conn.release()
    }
  }

  async purgeTerminalTasksBefore(cutoff: string): Promise<number> {
    const rows = await this.rows(
      `SELECT id FROM tasks
       WHERE updated_at < ? AND status IN ('succeeded', 'failed', 'cancelled')`,
      [cutoff],
    )
    const ids = rows.map((row) => String(row.id))
    if (ids.length === 0) return 0
    const marks = ids.map(() => '?').join(',')
    for (const table of ['task_events', 'audit_records', 'approvals']) {
      await this.run(`DELETE FROM ${table} WHERE task_id IN (${marks})`, ids)
    }
    const result = await this.run(`DELETE FROM tasks WHERE id IN (${marks})`, ids)
    return result.affectedRows
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}

function taskOf(row: RowDataPacket): Task {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    ownerId: String(row.owner_id),
    title: String(row.title),
    prompt: String(row.prompt),
    skill: String(row.skill),
    status: String(row.status) as TaskStatus,
    ...(row.origin ? { origin: String(row.origin) as TaskOrigin } : {}),
    ...(row.runner_id ? { runnerId: String(row.runner_id) } : {}),
    ...(row.alert_source_id ? { alertSourceId: String(row.alert_source_id) } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(row.result !== null && row.result !== undefined ? { result: String(row.result) } : {}),
    ...(row.error !== null && row.error !== undefined ? { error: String(row.error) } : {}),
    ...(usageOf(row.usage) ? { usage: usageOf(row.usage)! } : {}),
  }
}

function usageOf(value: unknown): TaskUsage | undefined {
  const parsed = parseJson(value)
  if (!isRecord(parsed)) return undefined
  const number = (key: string) => {
    const item = parsed[key]
    return typeof item === 'number' && Number.isFinite(item) && item >= 0 ? item : undefined
  }
  const calls = number('calls')
  const promptTokens = number('promptTokens')
  const completionTokens = number('completionTokens')
  const totalTokens = number('totalTokens')
  if (calls === undefined && promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) {
    return undefined
  }
  return {
    calls: calls ?? 0,
    promptTokens: promptTokens ?? 0,
    completionTokens: completionTokens ?? 0,
    totalTokens: totalTokens ?? 0,
    ...(number('cost') !== undefined ? { cost: number('cost')! } : {}),
    ...(typeof parsed.currency === 'string' ? { currency: parsed.currency } : {}),
  }
}

function approvalOf(row: RowDataPacket): Approval {
  const args = parseJson(row.args)
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    ownerId: String(row.owner_id),
    tool: String(row.tool),
    args: isRecord(args) ? args : {},
    argsHash: String(row.args_hash),
    status: String(row.status) as Approval['status'],
    requestedBy: String(row.requested_by),
    requestedAt: String(row.requested_at),
    ...(row.decided_by ? { decidedBy: String(row.decided_by) } : {}),
    ...(row.decided_at ? { decidedAt: String(row.decided_at) } : {}),
    ...(row.comment !== null && row.comment !== undefined ? { comment: String(row.comment) } : {}),
    consumed: Boolean(row.consumed),
  }
}

function auditOf(row: RowDataPacket): AuditRecord {
  const args = parseJson(row.args)
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    actorId: String(row.actor_id),
    tool: String(row.tool),
    risk: String(row.risk) as Risk,
    args: isRecord(args) ? args : {},
    decision: String(row.decision) as AuditDecision,
    ...(row.approval_id ? { approvalId: String(row.approval_id) } : {}),
    at: String(row.at),
  }
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function stringArray<T extends string>(value: unknown): T[] {
  const parsed = parseJson(value)
  return Array.isArray(parsed) ? parsed.filter((item): item is T => typeof item === 'string') : []
}

function userOf(row: RowDataPacket): UserRecord {
  return {
    id: String(row.id),
    username: String(row.username),
    displayName: String(row.display_name),
    ...(row.password_hash ? { passwordHash: String(row.password_hash) } : {}),
    roles: stringArray<Role>(row.roles),
    status: row.status === 'disabled' ? 'disabled' : 'active',
    source: row.source ? String(row.source) : 'local',
    ...(row.external_id ? { externalId: String(row.external_id) } : {}),
    ...(row.email ? { email: String(row.email) } : {}),
    mustChangePassword: Boolean(row.must_change_password),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(row.last_login_at ? { lastLoginAt: String(row.last_login_at) } : {}),
  }
}

function sessionOf(row: RowDataPacket): SessionRecord {
  return {
    // 兼容滚动升级期间旧实例写入的、尚未回填 id 的会话行。与迁移里的 SHA2(token_hash) 一致。
    id: row.id ? String(row.id) : createHash('sha256').update(String(row.token_hash)).digest('hex'),
    tokenHash: String(row.token_hash),
    userId: String(row.user_id),
    csrfToken: String(row.csrf_token),
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    lastSeenAt: String(row.last_seen_at),
    ...(row.ip ? { ip: String(row.ip) } : {}),
    ...(row.user_agent ? { userAgent: String(row.user_agent) } : {}),
  }
}

function apiKeyOf(row: RowDataPacket): ApiKeyRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    name: String(row.name),
    tokenHash: String(row.token_hash),
    scopes: stringArray<ApiKeyRecord['scopes'][number]>(row.scopes),
    createdAt: String(row.created_at),
    ...(row.expires_at ? { expiresAt: String(row.expires_at) } : {}),
    ...(row.last_used_at ? { lastUsedAt: String(row.last_used_at) } : {}),
    ...(row.revoked_at ? { revokedAt: String(row.revoked_at) } : {}),
  }
}

function securityEventOf(row: RowDataPacket): SecurityEventRecord {
  const detail = parseJson(row.detail)
  return {
    id: String(row.id),
    at: String(row.at),
    type: String(row.type),
    ...(row.user_id ? { userId: String(row.user_id) } : {}),
    ...(row.username ? { username: String(row.username) } : {}),
    ...(row.ip ? { ip: String(row.ip) } : {}),
    ...(isRecord(detail) ? { detail } : {}),
  }
}