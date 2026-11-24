import { canonical, nid, redact } from './ids.ts'
import type { Store, StoreTx } from './store.ts'
import type { Actor, Approval, AuditDecision, Tool, ToolOutcome } from './types.ts'

export interface ExecuteInput {
  actorId: string
  ownerId: string
  taskId: string
  tool: string
  args: Record<string, unknown>
  approvalId?: string
  signal?: AbortSignal
}

/**
 * 工具只有这一条执行口。只读在授权后直接跑；变更先记审批，未批准不会调用工具。
 */
export class ToolBroker {
  private tools: Map<string, Tool>
  private actors: Map<string, Actor>

  constructor(
    tools: Tool[],
    private readonly store: Store,
    actors: Actor[],
  ) {
    this.tools = new Map(tools.map((tool) => [tool.name, tool]))
    this.actors = new Map(actors.map((actor) => [actor.id, actor]))
  }

  replaceTools(tools: Tool[]): void {
    this.tools = new Map(tools.map((tool) => [tool.name, tool]))
  }

  /** 用户或角色变化后刷新身份快照，下一次执行立即生效。 */
  replaceActors(actors: Actor[]): void {
    this.actors = new Map(actors.map((actor) => [actor.id, actor]))
  }

  async execute(input: ExecuteInput): Promise<ToolOutcome> {
    const actor = this.actors.get(input.actorId)
    const tool = this.tools.get(input.tool)
    if (!actor) return this.deny(input, 'read', '未识别的身份')
    if (!tool) return this.deny(input, 'read', `未知工具 ${input.tool}`)
    const canRun = actor.roles.includes('operator') || actor.roles.includes('approver') || actor.roles.includes('admin')
    if (!canRun) return this.deny(input, tool.risk, '当前身份不能执行工具')
    if (input.signal?.aborted) return this.fail(input, tool.risk, '任务已取消')
    try {
      await tool.validate?.(input.args)
    } catch (error) {
      return this.fail(input, tool.risk, error instanceof Error ? error.message : '参数校验失败')
    }

    if (tool.risk === 'read') {
      const auditId = await this.audit(input, tool.risk, 'allowed')
      return this.run(tool, input, auditId)
    }

    if (!input.approvalId) {
      const approval = await this.openApproval(input)
      const auditId = await this.audit(input, 'mutate', 'awaiting_approval', approval.id)
      return { status: 'awaiting_approval', approvalId: approval.id, auditId }
    }

    const approval = await this.store.getApproval(input.approvalId)
    const mismatch = this.approvalProblem(approval, input)
    if (mismatch) return this.deny(input, 'mutate', mismatch, input.approvalId)

    let auditId = ''
    const claimed = await this.store.transaction(async (tx) => {
      if (!(await tx.consumeApproval(approval!.id))) return false
      auditId = await this.auditWith(tx, input, 'mutate', 'approved', approval!.id)
      return true
    })
    if (!claimed) return this.deny(input, 'mutate', '审批已使用', approval!.id)
    return this.run(tool, input, auditId)
  }

  private async openApproval(input: ExecuteInput): Promise<Approval> {
    const approval: Approval = {
      id: nid('apr'),
      taskId: input.taskId,
      ownerId: input.ownerId,
      tool: input.tool,
      args: redact(input.args) as Record<string, unknown>,
      argsHash: canonical(input.args),
      status: 'pending',
      requestedBy: input.actorId,
      requestedAt: new Date().toISOString(),
      consumed: false,
    }
    await this.store.saveApproval(approval)
    return approval
  }

  private approvalProblem(approval: Approval | undefined, input: ExecuteInput): string | undefined {
    if (!approval) return '审批不存在'
    if (approval.taskId !== input.taskId) return '审批不属于这个任务'
    if (approval.tool !== input.tool || approval.argsHash !== canonical(input.args)) return '审批与本次调用不一致'
    if (approval.status !== 'approved') return '审批尚未通过'
    if (!approval.decidedBy || approval.decidedBy === approval.ownerId) return '变更不能由任务所有者自己放行'
    if (approval.consumed) return '审批已使用'
    return undefined
  }

  private async run(tool: Tool, input: ExecuteInput, auditId: string): Promise<ToolOutcome> {
    try {
      const result = await tool.execute(input.args, { actorId: input.actorId, signal: input.signal })
      return { status: 'ok', result, auditId }
    } catch (error) {
      const message = error instanceof Error ? error.message : '工具执行失败'
      await this.store.updateAudit(auditId, 'error')
      return { status: 'error', error: message, auditId }
    }
  }

  private async deny(input: ExecuteInput, risk: 'read' | 'mutate', reason: string, approvalId?: string): Promise<ToolOutcome> {
    return { status: 'denied', reason, auditId: await this.audit(input, risk, 'denied', approvalId) }
  }

  private async fail(input: ExecuteInput, risk: 'read' | 'mutate', reason: string): Promise<ToolOutcome> {
    return { status: 'error', error: reason, auditId: await this.audit(input, risk, 'error') }
  }

  private async audit(
    input: ExecuteInput,
    risk: 'read' | 'mutate',
    decision: AuditDecision,
    approvalId?: string,
  ): Promise<string> {
    return this.auditWith(this.store, input, risk, decision, approvalId)
  }

  private async auditWith(
    tx: StoreTx,
    input: ExecuteInput,
    risk: 'read' | 'mutate',
    decision: AuditDecision,
    approvalId?: string,
  ): Promise<string> {
    const id = nid('aud')
    await tx.appendAudit({
      id,
      taskId: input.taskId,
      actorId: input.actorId,
      tool: input.tool,
      risk,
      args: redact(input.args) as Record<string, unknown>,
      decision,
      approvalId,
      at: new Date().toISOString(),
    })
    return id
  }
}