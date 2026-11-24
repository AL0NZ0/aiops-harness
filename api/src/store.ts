import { MemoryAuthStore } from './auth-store.ts'
import type { Approval, AuditRecord, Task, TaskEvent } from './types.ts'

export type ApprovalDecision = 'approved' | 'rejected'

/**
 * 任务分页查询。可见性在这里下推：seeAll=false 时只返回 actorId 自己的任务；
 * approver=true 时额外包含存在审批记录的任务（与页面可见性规则一致）。
 */
export interface TaskQuery {
  status?: string
  ownerId?: string
  origin?: string
  actorId?: string
  seeAll?: boolean
  approver?: boolean
  limit?: number
  offset?: number
}

/** 任务可见性过滤；概览和列表必须使用同一套规则，不能把别人的任务数漏出去。 */
export type TaskVisibility = Pick<TaskQuery, 'actorId' | 'seeAll' | 'approver'>

export interface ApprovalQuery {
  status?: string
  taskId?: string
  /** admin/auditor/approver 看全部；其他人只看自己发起或自己任务下的审批。 */
  actorId?: string
  seeAll?: boolean
  limit?: number
  offset?: number
}

export interface QueryPage<T> {
  items: T[]
  total: number
}

/** 一个事务或连接内的存储操作。 */
export interface StoreTx {
  saveTask(task: Task): Promise<void>
  getTask(id: string): Promise<Task | undefined>
  listTasks(): Promise<Task[]>
  appendEvent(event: TaskEvent): Promise<void>
  eventsFor(taskId: string): Promise<TaskEvent[]>
  saveApproval(approval: Approval): Promise<void>
  getApproval(id: string): Promise<Approval | undefined>
  listApprovals(): Promise<Approval[]>
  decideApproval(
    id: string,
    decision: ApprovalDecision,
    decidedBy: string,
    decidedAt: string,
    comment?: string,
  ): Promise<boolean>
  consumeApproval(id: string): Promise<boolean>
  appendAudit(audit: AuditRecord): Promise<void>
  auditsFor(taskId: string): Promise<AuditRecord[]>
  updateAudit(id: string, decision: AuditRecord['decision']): Promise<void>
}

export interface Store extends StoreTx {
  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T>
  /** 服务端分页：过滤、可见性、排序、COUNT 都在存储层完成。 */
  queryTasks(query: TaskQuery): Promise<QueryPage<Task>>
  queryApprovals(query: ApprovalQuery): Promise<QueryPage<Approval>>
  /**
   * 跨实例互斥：拿到锁才执行 fn，拿不到返回 undefined。
   * MySQL 用 GET_LOCK；内存实现只保证单进程内互斥。
   */
  withAdvisoryLock<T>(name: string, fn: () => Promise<T>): Promise<T | undefined>
  /** 删除终态且 updatedAt 早于 cutoff 的任务及其事件、审批、审计。 */
  purgeTerminalTasksBefore(cutoff: string): Promise<number>
  /** /metrics 和总览用：按状态聚合，不把整表任务拉进内存。传 filter 时按可见性收口。 */
  countTasksByStatus(filter?: TaskVisibility): Promise<Record<string, number>>
  countApprovalsByStatus(): Promise<Record<string, number>>
  close(): Promise<void>
}

/** 测试和本地无数据库时的内存实现。 */
export class MemoryStore extends MemoryAuthStore implements Store {
  private tasks = new Map<string, Task>()
  private events: TaskEvent[] = []
  private approvals = new Map<string, Approval>()
  private audits: AuditRecord[] = []
  private locks = new Set<string>()

  async saveTask(task: Task): Promise<void> {
    this.tasks.set(task.id, structuredClone(task))
  }

  async getTask(id: string): Promise<Task | undefined> {
    const task = this.tasks.get(id)
    return task ? structuredClone(task) : undefined
  }

  async listTasks(): Promise<Task[]> {
    return [...this.tasks.values()].map((task) => structuredClone(task))
  }

  async appendEvent(event: TaskEvent): Promise<void> {
    this.events.push(structuredClone(event))
  }

  async eventsFor(taskId: string): Promise<TaskEvent[]> {
    return this.events.filter((event) => event.taskId === taskId).map((event) => structuredClone(event))
  }

  async saveApproval(approval: Approval): Promise<void> {
    this.approvals.set(approval.id, structuredClone(approval))
  }

  async getApproval(id: string): Promise<Approval | undefined> {
    const approval = this.approvals.get(id)
    return approval ? structuredClone(approval) : undefined
  }

  async listApprovals(): Promise<Approval[]> {
    return [...this.approvals.values()].map((approval) => structuredClone(approval))
  }

  async decideApproval(
    id: string,
    decision: ApprovalDecision,
    decidedBy: string,
    decidedAt: string,
    comment?: string,
  ): Promise<boolean> {
    const approval = this.approvals.get(id)
    if (!approval || approval.status !== 'pending') return false
    approval.status = decision
    approval.decidedBy = decidedBy
    approval.decidedAt = decidedAt
    if (comment?.trim()) approval.comment = comment.trim()
    return true
  }

  async consumeApproval(id: string): Promise<boolean> {
    const approval = this.approvals.get(id)
    if (!approval || approval.status !== 'approved' || approval.consumed) return false
    approval.consumed = true
    return true
  }

  async appendAudit(audit: AuditRecord): Promise<void> {
    this.audits.push(structuredClone(audit))
  }

  async auditsFor(taskId: string): Promise<AuditRecord[]> {
    return this.audits.filter((audit) => audit.taskId === taskId).map((audit) => structuredClone(audit))
  }

  async updateAudit(id: string, decision: AuditRecord['decision']): Promise<void> {
    const audit = this.audits.find((item) => item.id === id)
    if (audit) audit.decision = decision
  }

  async queryTasks(query: TaskQuery): Promise<QueryPage<Task>> {
    const approvalTaskIds = new Set([...this.approvals.values()].map((approval) => approval.taskId))
    const filtered = [...this.tasks.values()].filter((task) => {
      if (query.status && task.status !== query.status) return false
      if (query.ownerId && task.ownerId !== query.ownerId) return false
      if (query.origin && task.origin !== query.origin) return false
      if (query.seeAll) return true
      if (!query.actorId) return false
      if (task.ownerId === query.actorId) return true
      return query.approver === true && approvalTaskIds.has(task.id)
    })
    filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    const offset = Math.max(0, query.offset ?? 0)
    const items = query.limit === undefined ? filtered.slice(offset) : filtered.slice(offset, offset + query.limit)
    return { items: items.map((task) => structuredClone(task)), total: filtered.length }
  }

  async queryApprovals(query: ApprovalQuery): Promise<QueryPage<Approval>> {
    const ownedTaskIds = new Set(
      [...this.tasks.values()]
        .filter((task) => query.actorId !== undefined && task.ownerId === query.actorId)
        .map((task) => task.id),
    )
    const filtered = [...this.approvals.values()].filter((approval) => {
      if (query.status && approval.status !== query.status) return false
      if (query.taskId && approval.taskId !== query.taskId) return false
      if (query.seeAll) return true
      if (!query.actorId) return false
      return approval.requestedBy === query.actorId || ownedTaskIds.has(approval.taskId)
    })
    filtered.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt) || b.id.localeCompare(a.id))
    const offset = Math.max(0, query.offset ?? 0)
    const items = query.limit === undefined ? filtered.slice(offset) : filtered.slice(offset, offset + query.limit)
    return { items: items.map((approval) => structuredClone(approval)), total: filtered.length }
  }

  async withAdvisoryLock<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
    // 单进程内存实现没有其它实例，但同一进程的后台任务仍可能重叠；
    // 语义与 MySQL GET_LOCK(..., 0) 一致：拿不到锁直接返回 undefined。
    if (this.locks.has(name)) return undefined
    this.locks.add(name)
    try {
      return await fn()
    } finally {
      this.locks.delete(name)
    }
  }

  async countTasksByStatus(filter?: TaskVisibility): Promise<Record<string, number>> {
    const approvalTaskIds = filter && !filter.seeAll && filter.approver
      ? new Set([...this.approvals.values()].map((approval) => approval.taskId))
      : undefined
    const counts: Record<string, number> = {}
    for (const task of this.tasks.values()) {
      if (filter && !filter.seeAll) {
        if (!filter.actorId) continue
        if (task.ownerId !== filter.actorId && !approvalTaskIds?.has(task.id)) continue
      }
      counts[task.status] = (counts[task.status] ?? 0) + 1
    }
    return counts
  }

  async countApprovalsByStatus(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {}
    for (const approval of this.approvals.values()) {
      counts[approval.status] = (counts[approval.status] ?? 0) + 1
    }
    return counts
  }

  async purgeTerminalTasksBefore(cutoff: string): Promise<number> {
    const terminal = new Set<Task['status']>(['succeeded', 'failed', 'cancelled'])
    const ids = new Set(
      [...this.tasks.values()]
        .filter((task) => terminal.has(task.status) && task.updatedAt < cutoff)
        .map((task) => task.id),
    )
    if (ids.size === 0) return 0
    for (const id of ids) this.tasks.delete(id)
    this.events = this.events.filter((event) => !ids.has(event.taskId))
    this.audits = this.audits.filter((audit) => !ids.has(audit.taskId))
    for (const [id, approval] of this.approvals) {
      if (ids.has(approval.taskId)) this.approvals.delete(id)
    }
    return ids.size
  }

  async transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    const tasks = new Map([...this.tasks].map(([key, value]) => [key, structuredClone(value)]))
    const events = structuredClone(this.events)
    const approvals = new Map([...this.approvals].map(([key, value]) => [key, structuredClone(value)]))
    const audits = structuredClone(this.audits)
    try {
      return await fn(this)
    } catch (error) {
      this.tasks = tasks
      this.events = events
      this.approvals = approvals
      this.audits = audits
      throw error
    }
  }

  async close(): Promise<void> {
    // 内存实现没有需要释放的资源。
  }
}