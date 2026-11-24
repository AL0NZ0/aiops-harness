export type Risk = 'read' | 'mutate'
export type TaskStatus = 'queued' | 'running' | 'awaiting_approval' | 'succeeded' | 'failed' | 'cancelled'
/** web 由平台本地 runner 执行；dsh/api 由外部 Agent 驱动，平台不跑模型循环。 */
export type TaskOrigin = 'web' | 'dsh' | 'api' | 'alert'
export type Role = 'viewer' | 'operator' | 'approver' | 'auditor' | 'admin'

export interface Actor {
  id: string
  name: string
  roles: Role[]
}

export interface Tool {
  name: string
  description: string
  risk: Risk
  parameters: Record<string, unknown>
  /** 在进入审批或执行前校验参数，避免为无效调用生成审批。 */
  validate?(args: Record<string, unknown>): void | Promise<void>
  execute(args: Record<string, unknown>, ctx: { actorId: string; signal?: AbortSignal }): Promise<unknown>
}

export interface TaskUsage {
  /** 模型调用次数（含重试）。 */
  calls: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /** 配置了 input/output 单价时的估算成本。 */
  cost?: number
  currency?: string
}

export interface Task {
  id: string
  sessionId: string
  ownerId: string
  title: string
  prompt: string
  skill: string
  status: TaskStatus
  origin?: TaskOrigin
  /** 执行本地 runner 的平台实例；多实例启动回收只处理自己的任务。 */
  runnerId?: string
  /** 告警接入来源；只有 origin=alert 的任务有，用于结果回推和审计。 */
  alertSourceId?: string
  createdAt: string
  updatedAt: string
  result?: string
  error?: string
  /** 平台模型循环的 token/成本统计；playbook 和外部任务通常没有。 */
  usage?: TaskUsage
}

export interface TaskEvent {
  id: string
  taskId: string
  type: string
  at: string
  data: unknown
}

export interface Approval {
  id: string
  taskId: string
  ownerId: string
  tool: string
  args: Record<string, unknown>
  argsHash: string
  status: 'pending' | 'approved' | 'rejected'
  requestedBy: string
  requestedAt: string
  decidedBy?: string
  decidedAt?: string
  comment?: string
  consumed: boolean
}

export type AuditDecision = 'allowed' | 'awaiting_approval' | 'approved' | 'rejected' | 'denied' | 'error'

export interface AuditRecord {
  id: string
  taskId: string
  actorId: string
  tool: string
  risk: Risk
  args: Record<string, unknown>
  decision: AuditDecision
  approvalId?: string
  at: string
}

export type ToolOutcome =
  | { status: 'ok'; result: unknown; auditId: string }
  | { status: 'awaiting_approval'; approvalId: string; auditId: string }
  | { status: 'denied'; reason: string; auditId: string }
  | { status: 'error'; error: string; auditId: string }
