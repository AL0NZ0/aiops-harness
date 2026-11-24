import type { McpToolInfo } from './protocol.ts'

/**
 * DSH 侧 Agent 工具：任务上下文、审批查询和平台工具转发。
 * stdio 代理和远程 HTTP MCP 共用这一份逻辑，避免两套行为漂移。
 */
export interface AgentToolApi {
  listTools(): Promise<McpToolInfo[]>
  createTask(input: { prompt: string; title?: string; skill?: string; sessionId?: string }): Promise<unknown>
  finishTask(taskId: string, input: { status: string; result?: string; error?: string }): Promise<unknown>
  getTask(taskId: string): Promise<unknown>
  cancelTask(taskId: string, input: { force?: boolean }): Promise<unknown>
  listApprovals(status?: string): Promise<unknown>
  getApproval(approvalId: string): Promise<unknown>
  resumeApproval(approvalId: string): Promise<unknown>
  executeTool(input: { tool: string; args?: Record<string, unknown>; taskId?: string }): Promise<unknown>
}

export interface AgentSessionOptions {
  /** 空闲多久自动结束自动创建的任务；默认 120 秒。 */
  idleFinishMs?: number
  /** 自动建任务时写入的 sessionId，便于把平台任务和 DSH 会话对上。 */
  sessionId?: string
}

export interface AgentSession {
  listTools(): Promise<McpToolInfo[]>
  callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>
  /** 当前任务号，仅用于诊断。 */
  taskId(): string
  /** 关闭会话：停掉空闲计时器，并把自动任务收尾，避免永久停在 running。 */
  dispose(): Promise<void>
}

export const AGENT_TOOLS: McpToolInfo[] = [
  {
    name: 'task.create',
    description: '在 AIOps 平台创建受管任务。之后调用的运维工具都会挂到这个任务下，结束时调用 task.finish。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '用户原始问题或任务目标' },
        title: { type: 'string', description: '可选，任务标题' },
        skill: { type: 'string', description: '可选，技能名；不填按关键词自动选择' },
        session_id: { type: 'string', description: '可选，DSH 会话号，只留在平台内部' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'task.finish',
    description: '结束当前平台任务，写入最终结论或错误。还有待审批变更时会拒绝。',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['succeeded', 'failed'] },
        result: { type: 'string', description: '任务结论；status=succeeded 时使用' },
        error: { type: 'string', description: '失败原因；status=failed 时使用' },
      },
      required: ['status'],
    },
  },
  {
    name: 'task.get',
    description: '查看当前任务或指定任务的状态、事件和审计。',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '可选，默认当前任务' },
      },
    },
  },
  {
    name: 'task.cancel',
    description:
      '取消当前任务；挂起的变更审批会一并作废。审批等待期间不要取消任务，应结束当前回合，之后用 approval.get 查询结果。只有用户明确要求放弃审批或取消任务时才传 force=true。',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: '可选，取消原因' },
        force: {
          type: 'boolean',
          description: '有挂起审批时必须显式传 true 才能取消，否则平台拒绝（409）。',
        },
      },
    },
  },
  {
    name: 'approval.list',
    description: '查看平台审批队列。只读。',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'approved', 'rejected'] },
      },
    },
  },
  {
    name: 'approval.resume',
    description: '审批通过后继续执行已批准的变更。平台会校验审批与原始参数一致，并且只执行一次。一般不需要手动调用：审批通过后平台会自动执行。',
    parameters: {
      type: 'object',
      properties: {
        approval_id: { type: 'string' },
      },
      required: ['approval_id'],
    },
  },
  {
    name: 'approval.get',
    description: '查看审批状态、决定和平台自动执行的结果（含审计号）。审批通过后用这个工具获取变更结果，不要重复调用变更工具。',
    parameters: {
      type: 'object',
      properties: {
        approval_id: { type: 'string' },
      },
      required: ['approval_id'],
    },
  },
]

/** 平台工具带 risk；给变更工具的描述加提示，避免模型拿 kubectl/helm 做只读查询。 */
export function annotateTools(tools: McpToolInfo[]): McpToolInfo[] {
  return tools.map((tool) => {
    const risk = (tool as { risk?: string }).risk
    return risk === 'mutate'
      ? { ...tool, description: `${tool.description ?? ''}（变更工具：调用会进入人工审批；只读查询优先用专用只读工具）` }
      : tool
  })
}

export function toolsSignature(tools: McpToolInfo[]): string {
  return tools
    .map((tool) => `${tool.name}:${tool.description ?? ''}:${JSON.stringify(tool.parameters ?? {})}`)
    .sort()
    .join('\n')
}

/** 一个会话对应一个 DSH 终端/远程连接，同时只承载一个平台任务。 */
export function createAgentSession(api: AgentToolApi, options: AgentSessionOptions = {}): AgentSession {
  let currentTaskId = ''
  let autoTask = false
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  const idleEnv = Number(options.idleFinishMs ?? process.env.AIOPS_IDLE_FINISH_MS ?? 120_000)
  const IDLE_FINISH_MS = Number.isFinite(idleEnv) && idleEnv >= 1_000 ? idleEnv : 120_000
  const sessionId = options.sessionId ?? `mcp:${process.pid}`

  async function listTools(): Promise<McpToolInfo[]> {
    return [...AGENT_TOOLS, ...annotateTools(await api.listTools())]
  }

  function scheduleIdleFinish(): void {
    if (idleTimer) clearTimeout(idleTimer)
    if (!currentTaskId) return
    idleTimer = setTimeout(() => {
      void finishIdleTask()
    }, IDLE_FINISH_MS)
    idleTimer.unref?.()
  }

  async function finishIdleTask(): Promise<void> {
    const taskId = currentTaskId
    if (!taskId) return
    try {
      const current = asRecord(await api.getTask(taskId))
      const status = asRecord(current?.task)?.status
      if (status !== 'running' && status !== 'queued') return
      await api.finishTask(taskId, { status: 'succeeded', result: 'DSH 会话空闲结束' })
      autoTask = false
    } catch {
      // 平台暂时不可用时保持任务，下一轮再看。
    }
  }

  async function callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    try {
      if (name === 'task.create') return await createTask(args)
      if (name === 'task.finish') return await finishTask(args)
      if (name === 'task.get') return await getTask(args)
      if (name === 'task.cancel') return await cancelTask(args)
      if (name === 'approval.list') return await listApprovals(args)
      if (name === 'approval.get') return await getApproval(args)
      if (name === 'approval.resume') return await resumeApproval(args)
      return await callPlatformTool(name, args)
    } catch (error) {
      return { text: error instanceof Error ? error.message : '工具调用失败', isError: true }
    } finally {
      scheduleIdleFinish()
    }
  }

  async function createTask(args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    if (currentTaskId && autoTask) {
      try {
        await api.finishTask(currentTaskId, { status: 'succeeded', result: '切换到显式任务' })
      } catch {
        // 自动任务已经结束或平台暂时不可用，直接换新任务。
      }
      currentTaskId = ''
      autoTask = false
    }
    if (currentTaskId) {
      try {
        const current = asRecord(await api.getTask(currentTaskId))
        const status = asRecord(current?.task)?.status
        if (status !== 'succeeded' && status !== 'failed' && status !== 'cancelled') {
          return { text: `已有进行中的任务 ${currentTaskId}，先 finish 或 cancel`, isError: true }
        }
      } catch {
        // 上一个任务已经不存在，直接换新任务。
      }
      currentTaskId = ''
    }
    const body = await api.createTask({
      prompt: stringArg(args, 'prompt'),
      ...(optionalStringArg(args, 'title') ? { title: optionalStringArg(args, 'title') } : {}),
      ...(optionalStringArg(args, 'skill') ? { skill: optionalStringArg(args, 'skill') } : {}),
      ...(optionalStringArg(args, 'session_id') ? { sessionId: optionalStringArg(args, 'session_id') } : {}),
    })
    const task = asRecord(asRecord(body)?.task)
    const id = typeof task?.id === 'string' ? task.id : ''
    if (!id) return { text: '创建任务失败：平台没有返回 taskId', isError: true }
    currentTaskId = id
    autoTask = false
    return { text: JSON.stringify({ task }), isError: false }
  }

  async function finishTask(args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    if (!currentTaskId) return { text: '当前没有进行中的任务，先调用 task.create', isError: true }
    const status = args.status === 'failed' ? 'failed' : args.status === 'succeeded' ? 'succeeded' : ''
    if (!status) return { text: 'status 只能是 succeeded 或 failed', isError: true }
    const body = await api.finishTask(currentTaskId, {
      status,
      ...(optionalStringArg(args, 'result') ? { result: optionalStringArg(args, 'result') } : {}),
      ...(optionalStringArg(args, 'error') ? { error: optionalStringArg(args, 'error') } : {}),
    })
    autoTask = false
    return { text: JSON.stringify(body), isError: false }
  }

  async function getTask(args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const taskId = optionalStringArg(args, 'task_id') ?? currentTaskId
    if (!taskId) return { text: '没有任务号，先调用 task.create', isError: true }
    const body = await api.getTask(taskId)
    return { text: JSON.stringify(body), isError: false }
  }

  async function cancelTask(args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    if (!currentTaskId) return { text: '当前没有进行中的任务', isError: true }
    if (args.force !== undefined && typeof args.force !== 'boolean') {
      return { text: 'force 必须是布尔值', isError: true }
    }
    const body = await api.cancelTask(currentTaskId, { force: args.force === true })
    autoTask = false
    return { text: JSON.stringify(body), isError: false }
  }

  async function listApprovals(args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const status = optionalStringArg(args, 'status')
    const body = await api.listApprovals(status)
    return { text: JSON.stringify(body), isError: false }
  }

  async function getApproval(args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const body = await api.getApproval(stringArg(args, 'approval_id'))
    return { text: JSON.stringify(body), isError: false }
  }

  async function resumeApproval(args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const body = await api.resumeApproval(stringArg(args, 'approval_id'))
    const status = asRecord(body)?.status
    return { text: JSON.stringify(body), isError: status === 'error' || status === 'denied' }
  }

  async function ensureTask(tool: string): Promise<void> {
    if (currentTaskId) return
    try {
      const body = await api.createTask({
        prompt: `DSH 工具调用: ${tool}`,
        title: `DSH: ${tool}`,
        sessionId,
      })
      const task = asRecord(asRecord(body)?.task)
      if (typeof task?.id === 'string') {
        currentTaskId = task.id
        autoTask = true
      }
    } catch {
      // 建任务失败不阻断工具调用，退化成 adhoc 审计。
    }
  }

  async function callPlatformTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    await ensureTask(name)
    const body = await api.executeTool({
      tool: name,
      args,
      ...(currentTaskId ? { taskId: currentTaskId } : {}),
    })
    const status = asRecord(body)?.status
    const text = status === 'awaiting_approval'
      ? JSON.stringify({
          ...asRecord(body),
          message:
            '变更已提交人工审批，任务保持等待。不要重复调用该变更，也不要调用 task.cancel；结束当前回合，用户审批后用 approval.get 查询结果，再 task.finish。',
        })
      : JSON.stringify(body)
    return { text, isError: status === 'error' || status === 'denied' }
  }

  return {
    listTools,
    callTool,
    taskId: () => currentTaskId,
    async dispose() {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = undefined
      // 客户端主动关闭会话、会话过期或被淘汰时，不会再有 task.finish，这里直接收尾。
      await finishIdleTask()
    },
  }
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`参数 ${key} 必填`)
  return value.trim()
}

function optionalStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`参数 ${key} 必须是字符串`)
  const text = value.trim()
  return text || undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}