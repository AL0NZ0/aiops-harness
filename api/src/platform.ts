import type {
  KnowledgeDocument,
  KnowledgeDocumentInput,
  KnowledgeDocumentRecord,
  KnowledgeHit,
  KnowledgeManager,
  KnowledgeProvider,
} from '../../extensions/knowledge/src/types.ts'
import {
  alertSourceView,
  parseAlertPayload,
  type AlertSource,
  type AlertSourceStore,
  type AlertSourceView,
  type NormalizedAlert,
} from './alert-sources.ts'
import { buildAssetWorkbook, type AssetImportResult, type AssetImportRow } from './asset-io.ts'
import { assetSshBlockedReason, type AssetProbeResult } from './asset-probe.ts'
import { normalizeFingerprint, toAssetView, type AssetRecord, type AssetStore, type AssetView } from './assets.ts'
import {
  toCredentialView,
  type CredentialInput,
  type CredentialStore,
  type CredentialView,
} from './credentials.ts'
import { mcpServerView, type McpServerStore, type McpServerView } from './mcp-servers.ts'
import type { McpServerConfig, McpServerError } from '../../extensions/ops-tools/src/index.ts'
import { ToolBroker } from './broker.ts'
import { PlatformError } from './errors.ts'
import { describeResult } from './findings.ts'
import { ApprovalGate } from './gate.ts'
import { nid, redact } from './ids.ts'
import type { ChatMessage, ChatModel, ChatTool, ChatToolCall } from './model.ts'
import type { DeliveredNotification, NotificationEvent, NotificationType } from './notifications.ts'
import { MAX_KNOWN_HOSTS_BYTES, matchAsset, parseKnownHosts } from './known-hosts.ts'
import { normalizeReadPaths } from './ssh-read.ts'
import { probeHostKey, resolveJumpTargets, testAssetConnection } from './ssh-tools.ts'
import { renderArgs, selectSkill, stepMatches, type Skill } from './skills.ts'
import { MemoryStore, type Store, type StoreTx, type TaskQuery } from './store.ts'
import {
  isPolicyToolName,
  toolPolicySignature,
  type ToolPolicyMap,
  type ToolPolicyStore,
  type ToolPolicyView,
  type ToolRisk,
} from './tool-policies.ts'
import type { Actor, Approval, AuditRecord, Task, TaskEvent, TaskStatus, TaskUsage, Tool, ToolOutcome } from './types.ts'

const TERMINAL = new Set<TaskStatus>(['succeeded', 'failed', 'cancelled'])

export interface AssetBatchFailure {
  name: string
  error: string
}

export interface AssetBatchResult<T> {
  name: string
  ok: boolean
  result?: T
  error?: string
}

/** 批量资产操作的入参：去重、去空、限制数量，避免一次请求打满。 */
function normalizeAssetNames(value: unknown, limit = 200): string[] {
  if (!Array.isArray(value)) throw new PlatformError('names 必须是资产名数组', 400, 'bad_request')
  const names: string[] = []
  for (const item of value) {
    const name = typeof item === 'string' ? item.trim() : ''
    if (name && !names.includes(name)) names.push(name)
  }
  if (!names.length) throw new PlatformError('names 不能为空', 400, 'bad_request')
  if (names.length > limit) throw new PlatformError(`单次最多处理 ${limit} 个资产`, 400, 'bad_request')
  return names
}

/** 有限并发地跑一批异步任务，顺序与输入一致。 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await fn(items[index]!)
    }
  })
  await Promise.all(workers)
  return results
}

/** admin 在权限判断上等价于 operator + approver；自批红线仍然单独校验。 */
function isOperator(actor: Actor): boolean {
  return actor.roles.includes('operator') || actor.roles.includes('approver') || actor.roles.includes('admin')
}

function isApprover(actor: Actor): boolean {
  return actor.roles.includes('approver') || actor.roles.includes('admin')
}

function isAdmin(actor: Actor): boolean {
  return actor.roles.includes('admin')
}

/** 把 ssh2 的英文底层错误翻译成运维能直接行动的提示。 */
function describeSshConnectError(error: unknown): string {
  const text = error instanceof Error ? error.message : 'SSH 连接测试失败'
  if (/All configured authentication methods failed/i.test(text)) {
    return 'SSH 认证失败：用户名、密码或私钥没有被目标主机接受'
  }
  if (/Host key verification failed|主机密钥/i.test(text)) return text
  if (/Timed out while waiting|Timed out|timeout/i.test(text)) return 'SSH 连接超时：检查 IP、端口、网络和防火墙'
  if (/ECONNREFUSED/i.test(text)) return 'SSH 连接被拒绝：目标端口没有服务监听'
  if (/EHOSTUNREACH|ENETUNREACH/i.test(text)) return 'SSH 网络不可达：检查路由和网络策略'
  if (/ENOTFOUND|EAI_AGAIN/i.test(text)) return 'SSH 主机名解析失败：检查资产的主机名或 IP'
  return text
}

/** 只读路径列表比较：两边都已规范化排序。 */
function sameReadPaths(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index])
}

/** readOnly/mutateTools 决定工具默认风险，属于风险配置，非 admin 不能改。 */
function mcpRiskConfig(server: McpServerConfig): string {
  return JSON.stringify([server.readOnly === true, [...new Set(server.mutateTools ?? [])].sort()])
}

function mcpRiskConfigChanged(before: McpServerConfig[], after: McpServerConfig[]): boolean {
  const previous = new Map(before.map((server) => [server.name, server]))
  return after.some((server) => {
    const old = previous.get(server.name)
    if (!old) return server.readOnly === true || (server.mutateTools?.length ?? 0) > 0
    return mcpRiskConfig(old) !== mcpRiskConfig(server)
  })
}

function halted(task: Task, signal: AbortSignal): boolean {
  return signal.aborted || task.status === 'cancelled'
}

/** 外部 Agent 自己跑模型循环，平台只记任务、执行工具和处理审批。 */
function isExternalTask(task: Task): boolean {
  return task.origin === 'dsh' || task.origin === 'api'
}

/** 审批还没结论，或者已通过但执行结果还没回写时，approval.get 的等待继续轮询。 */
function approvalExecutionPending(detail: ApprovalDetail): boolean {
  if (detail.approval.status === 'pending') return true
  if (detail.approval.status !== 'approved') return false
  return detail.execution.status === 'pending' || detail.execution.status === 'approved'
}

function outcomeText(outcome: ToolOutcome): string {
  if (outcome.status === 'error') return outcome.error
  if (outcome.status === 'denied') return outcome.reason
  if (outcome.status === 'awaiting_approval') return '变更仍在等待审批'
  return '工具没有返回结果'
}

function toolSignature(tools: Tool[]): string {
  return tools
    .map((tool) => `${tool.name}\u0000${tool.description}\u0000${JSON.stringify(tool.parameters)}`)
    .sort()
    .join('\n')
}

function scheduleClose(close?: () => Promise<void>): void {
  if (!close) return
  const timer = setTimeout(() => {
    void close().catch(() => undefined)
  }, 30_000)
  timer.unref?.()
}

/** OpenAI 工具名只允许字母、数字、下划线和短横线，这里做稳定映射。 */
function modelToolName(name: string, used: Set<string>): string {
  const base = name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'tool'
  let candidate = base
  let index = 1
  while (used.has(candidate)) {
    index += 1
    const tail = `_${index}`
    candidate = `${base.slice(0, 64 - tail.length)}${tail}`
  }
  used.add(candidate)
  return candidate
}

function parseToolArgs(raw: string): Record<string, unknown> {
  const text = raw.trim()
  if (!text) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('工具参数不是合法 JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('工具参数必须是 JSON 对象')
  }
  return parsed as Record<string, unknown>
}

const METRICS_QL_ESCAPE_HINT =
  'MetricsQL 语法提示：双引号字符串按 Go 转义解析，正则里的点号要写成 \\\\.（例如 instance=~".*17\\\\.(10|11|12)"），或者改用字符类 [.]、反引号原始字符串；不要写成 \\.。修正查询后重新调用同一工具。'

/** VictoriaMetrics 报字符串字面量非法时，把正确的正则转义写法带回给模型，避免反复试探。 */
function metricsQlEscapeHint(outcome: ToolOutcome): string {
  let message = ''
  if (outcome.status === 'error') message = outcome.error
  else if (outcome.status === 'denied') message = outcome.reason
  return /cannot parse string literal/i.test(message) ? METRICS_QL_ESCAPE_HINT : ''
}

function formatOutcomeForModel(outcome: ToolOutcome, limit: number): string {
  let payload: Record<string, unknown>
  if (outcome.status === 'ok') {
    payload = { status: outcome.status, result: outcome.result }
  } else if (outcome.status === 'awaiting_approval') {
    payload = {
      status: outcome.status,
      approvalId: outcome.approvalId,
      message: '变更等待审批，平台会继续处理',
    }
  } else if (outcome.status === 'denied') {
    payload = { status: outcome.status, error: outcome.reason }
  } else {
    payload = { status: outcome.status, error: outcome.error }
  }
  let text: string
  try {
    text = JSON.stringify(payload)
  } catch {
    text = JSON.stringify({ status: outcome.status })
  }
  const formatted = text.length <= limit
    ? text
    : `${text.slice(0, limit)}…[结果已截断] 只基于已返回内容作答；需要更多数据时缩小查询范围（namespace/name/label selector），不要改用 kubectl、helm 等变更工具。`
  const hint = metricsQlEscapeHint(outcome)
  return hint ? `${formatted} ${hint}` : formatted
}

function agentSystemPrompt(skill: Skill): string {
  return [
    '你是 AIOps Harness 平台的临时运维任务执行器。',
    '通过提供的工具查证事实并给出可执行的结论；不要编造资源名、IP、指标或事件。',
    '只读工具可以直接调用。变更工具会进入人工审批：工具返回 status=awaiting_approval 时说明平台已暂停等待审批，不要重复调用同一个变更，等待下一轮工具结果。',
    '查询优先用专用只读工具（如 k8s_get、k8s_describe、k8s_logs、k8s_events、vm 查询、es 检索）；不要为了过滤或格式化结果改用 kubectl、helm 等通用工具，这些是变更工具，会被要求审批。',
    '审批被拒绝或工具失败时如实说明，不要绕过审批或假装执行成功。',
    '工具名里的点号在 API 中可能显示为下划线，以实际工具清单为准。不要调用 task.*、approval.* 或 approval.resume，这些由平台管理。',
    '最终用中文给出：结论、关键证据来源、建议的下一步。证据不足时直说还需要什么。',
    '',
    `当前技能：${skill.name} — ${skill.description}`,
    skill.body.trim().slice(0, 8000),
  ].join('\n')
}

function roundCost(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function alertSummary(alert: NormalizedAlert): AlertIngestResult['alert'] {
  return { fingerprint: alert.fingerprint, name: alert.name, severity: alert.severity, status: alert.status }
}

/** 告警转成任务 prompt：只读约束写在最前面，避免模型把告警里的文字当成变更指令。 */
function alertPrompt(alerts: NormalizedAlert[]): string {
  const lines = ['【自动告警排查】这是监控告警触发的只读排查任务，不要执行任何变更、不要调用变更工具。']
  lines.push(`共 ${alerts.length} 条告警：`)
  for (const alert of alerts.slice(0, 10)) {
    lines.push('', `规则：${alert.name}`, `级别：P${alert.severity}`, `状态：${alert.status}`)
    if (alert.startsAt) lines.push(`开始时间：${alert.startsAt}`)
    const labels = Object.entries(alert.labels).filter(([key]) => key !== 'aiops_skill')
    if (labels.length > 0) lines.push(`标签：${labels.map(([key, value]) => `${key}=${value}`).join(' ')}`)
    const annotations = Object.entries(alert.annotations)
    if (annotations.length > 0) {
      lines.push(`注解：${annotations.map(([key, value]) => `${key}=${value}`).join('；')}`)
    }
  }
  if (alerts.length > 10) lines.push('', `其余 ${alerts.length - 10} 条告警略。`)
  lines.push(
    '',
    '请按技能流程只读排查：定位对象、确认现象和影响范围，给出证据、可能原因和建议动作；不要直接修复，也不要创建审批。',
    '请在有限轮次内收敛：优先确认告警对象是否存在、是否已恢复；证据不足就明确说明「未找到证据」并结束，不要反复扩大查询范围或重复查询同一对象。',
  )
  return lines.join('\n').slice(0, 8_000)
}

/** 测试按钮用：按接入源格式生成一条最小可解析告警。 */
function sampleAlert(source: AlertSource): unknown {
  const now = new Date().toISOString()
  const severity = Math.min(source.maxSeverity, 2)
  if (source.format === 'alertmanager') {
    return {
      version: '4',
      status: 'firing',
      alerts: [
        {
          status: 'firing',
          labels: { alertname: '平台告警接入测试', severity: severity === 1 ? 'critical' : 'warning', namespace: 'default' },
          annotations: { summary: '这是一条来自 AIOps Harness 平台的测试告警' },
          startsAt: now,
          fingerprint: `test-${Date.now()}`,
        },
      ],
    }
  }
  return {
    rule_name: '平台告警接入测试',
    severity,
    status: 'firing',
    tags: { namespace: 'default', pod: 'demo-pod' },
    annotations: { summary: '这是一条来自 AIOps Harness 平台的测试告警' },
    starts_at: now,
    hash: `test-${Date.now()}`,
  }
}

/** 重建工具集的结果；mcpErrors 是初始化失败、被跳过的上游 MCP server。 */
export interface BuildToolsResult {
  tools: Tool[]
  mcpErrors?: McpServerError[]
  /** 关闭这一轮上游 MCP session；工具集被替换后由 Platform 延迟调用。 */
  dispose?: () => Promise<void>
}

/** 上游工具集相对上次复核基线的变化；工具名是平台暴露的 `mcp.<server>.<tool>`。 */
export interface McpToolChanges {
  added: string[]
  removed: string[]
  updated: string[]
}

/** 后台 MCP 健康巡检的对外状态。 */
export interface McpServerHealth {
  name: string
  ok: boolean
  error?: string
  checkedAt?: string
  /** 连续失败次数；成功一次即清零。 */
  failures: number
  /** 上游工具集变化过、还没有人确认风险分类。 */
  reviewRequired?: boolean
  /** 相对上次复核基线的变化明细。 */
  changedTools?: McpToolChanges
}

interface HealthState extends McpServerHealth {
  /** 工具名 + 描述 + 参数签名，用来判断上游工具是否变化。 */
  signature?: string
  /** 上次确认复核时的工具集；新增/移除/改签名都相对它计算。 */
  baselineTools?: Tool[]
  /** 巡检期间建立的 session；被替换或摘除时延迟关闭。 */
  close?: () => Promise<void>
}

function toolEntrySignature(tool: Tool): string {
  return `${tool.name}\u0000${tool.description}\u0000${JSON.stringify(tool.parameters)}`
}

/** 按工具名比较两版工具集，描述或参数变化算 updated。 */
function hasToolChanges(changes: McpToolChanges | undefined): boolean {
  return Boolean(changes && (changes.added.length || changes.removed.length || changes.updated.length))
}

function diffServerTools(previous: Tool[], next: Tool[]): McpToolChanges {
  const before = new Map(previous.map((tool) => [tool.name, toolEntrySignature(tool)]))
  const after = new Map(next.map((tool) => [tool.name, toolEntrySignature(tool)]))
  return {
    added: [...after.keys()].filter((name) => !before.has(name)).sort(),
    removed: [...before.keys()].filter((name) => !after.has(name)).sort(),
    updated: [...after.entries()]
      .filter(([name, signature]) => before.has(name) && before.get(name) !== signature)
      .map(([name]) => name)
      .sort(),
  }
}

/** 连续失败达到该次数才摘除工具，避免一次网络抖动就下线整个 server。 */
const MCP_HEALTH_FAILURE_THRESHOLD = 3

export interface ModelSelection {
  provider?: string
  model?: string
}

export interface ResolvedModel {
  model: ChatModel
  provider: string
  modelName: string
  inputCostPer1M?: number
  outputCostPer1M?: number
  currency?: string
}

export interface ModelResolver {
  resolve(selection: ModelSelection): Promise<ResolvedModel | undefined>
}

export interface PlatformOptions {
  actors: Actor[]
  skills: Skill[]
  tools: Tool[]
  knowledge: KnowledgeProvider
  mcpStore: McpServerStore
  assets: AssetStore
  credentials: CredentialStore
  store?: Store
  /**
   * 重建工具集。传 mcpServers 时按给定配置构建（用于保存前探测，不落盘）；
   * tolerateFailures=false 时任一上游 MCP 初始化失败就抛错。
   */
  rebuildTools?: (mcpServers?: McpServerConfig[], tolerateFailures?: boolean) => Promise<BuildToolsResult>
  /** 单独探测一个上游 MCP server；健康巡检用它按 server 替换或恢复工具。 */
  buildServerTools?: (server: McpServerConfig) => Promise<{ tools: Tool[]; close?: () => Promise<void> }>
  mcpErrors?: McpServerError[]
  /** 挂起审批的存活时间；<=0 关闭过期。默认 24 小时。 */
  approvalTtlMs?: number
  /** 本实例标识；多实例部署时设置，启动回收只处理本实例执行的 web 任务。 */
  instanceId?: string
  /** 审批等待的跨实例轮询间隔，默认 2000ms；<=0 关闭轮询。 */
  approvalPollMs?: number
  /**
   * 允许 admin 审批自己发起的变更，默认关闭。
   * 只对 admin 生效，approver/operator 永远不能自批；开启后页面二次确认，审计仍记录同一 actor。
   */
  allowAdminSelfApproval?: boolean
  /** 兼容旧的单一模型配置；配置后网页/平台任务改为模型驱动。 */
  model?: ChatModel
  /** 多 provider 解析器；优先于 model。没有可用 provider 时返回 undefined，退回 playbook。 */
  modelResolver?: ModelResolver
  /** 模型循环最多调用几轮，默认 8，范围 1-50。 */
  agentMaxSteps?: number
  /** 回填给模型的单个工具结果上限，避免上下文爆炸；默认 12000 字符。 */
  agentToolOutputChars?: number
  /** 运维通知回调；实现必须是 fire-and-forget，不能阻塞任务和审批。 */
  notify?: (event: NotificationEvent) => void
  /** 后台状态变化写入安全事件；实现失败只记日志，不影响巡检。 */
  audit?: (action: string, detail: Record<string, unknown>) => void
  /** 任务级特权操作写入安全事件（如 admin 代重试）；失败不影响主流程。 */
  securityEvent?: (type: string, detail: Record<string, unknown>) => void
  /** 逐工具审批策略；只有 admin 能写，策略签名和上游工具不一致时自动失效。 */
  toolPolicies?: ToolPolicyStore
  /** 告警接入源；外部监控通过 /api/hooks/alerts/<sourceId> 触发只读排查任务。 */
  alertSources?: AlertSourceStore
  /** 定向通知：告警结果只推给接入源勾选的渠道，不走全局事件订阅。 */
  notifyTargets?: (webhookIds: string[], event: NotificationEvent) => void | Promise<DeliveredNotification[]>
  /**
   * SSH 连接测试缓存。与 `createAssetTools` 共用同一个 Map，
   * 模型读 asset.list 时能看到后台最近一次的连接结果。
   */
  assetProbes?: Map<string, AssetProbeResult>
  /** 平台对外地址，用于告警任务深链；默认不带链接。 */
  publicUrl?: string
  /** 同时运行的告警任务上限，默认 3；超出直接忽略并计数，避免告警风暴。 */
  alertMaxConcurrency?: number
}

export interface AlertIngestResult {
  accepted: boolean
  reason?: 'resolved' | 'below_threshold' | 'duplicate' | 'capacity'
  taskId?: string
  alert?: { fingerprint: string; name: string; severity: number; status: string }
}

export interface MetricsSnapshot {
  tasks: Record<string, number>
  approvals: Record<string, number>
  tools: Record<string, number>
  mcp: Array<{ name: string; ok: boolean; failures: number; reviewRequired?: boolean }>
}

/** 首页总览；所有计数都按当前身份的可见范围计算。 */
export interface PlatformOverview {
  generatedAt: string
  tasks: {
    total: number
    byStatus: Record<string, number>
    recent: Task[]
  }
  approvals: {
    pending: number
    recent: Approval[]
  }
  /** viewer 看不到知识文档管理，返回 null；本地知识库读取失败也返回 null。 */
  knowledge: { documents: number } | null
  /** viewer 看不到 MCP 管理，返回 null。 */
  mcp: {
    servers: number
    ok: number
    unhealthy: number
    reviewRequired: number
    unchecked: number
  } | null
  tools: {
    total: number
    read: number
    mutate: number
    mcp: number
  }
  assets: {
    total: number
    untrusted: number
  }
}

export interface ApprovalExecution {
  status: 'pending' | 'approved' | 'rejected' | 'succeeded' | 'failed' | 'unknown'
  at?: string
  result?: unknown
  error?: string
  auditId?: string
}

export interface ApprovalDetail {
  approval: Approval
  execution: ApprovalExecution
  /** 带 waitMs 等待时，超时仍未拿到执行结果会置 true；审批状态本身不变。 */
  timedOut?: boolean
}

export interface CreateTaskInput {
  title?: string
  prompt?: string
  skill?: string
  /** 仅 origin=web 的平台任务使用；不传时用默认 provider 和默认模型。 */
  provider?: string
  model?: string
}

export interface CreateAgentTaskInput extends CreateTaskInput {
  sessionId?: string
}

export interface FinishAgentTaskInput {
  status?: string
  result?: string
  error?: string
}

export class Platform {
  private actors: Map<string, Actor>
  private readonly store: Store
  private readonly broker: ToolBroker
  private readonly gate: ApprovalGate
  private readonly controllers = new Map<string, AbortController>()
  private mcpErrors: McpServerError[]
  private disposeTools?: () => Promise<void>
  private readonly health = new Map<string, HealthState>()
  private healthRunning = false
  /** 工具集被整体重建时递增，避免巡检把手上的旧探测结果写回去。 */
  private toolsGeneration = 0
  /** 工具构建时的原始风险；逐工具策略只覆盖展示和执行风险，不回写这里。 */
  private readonly toolBaseRisk = new Map<string, ToolRisk>()
  private policies: ToolPolicyMap = {}
  private policiesLoaded = false
  /** 同一接入源同一 fingerprint 的冷却窗口。进程内即可，重启后最多重复排查一次。 */
  private readonly alertSeen = new Map<string, number>()
  /** 每个接入源的请求频率，防止误配置或告警风暴把平台打满。 */
  private readonly alertRate = new Map<string, { count: number; resetAt: number }>()
  /** 当前运行中的告警任务数，配合 alertMaxConcurrency 限流。 */
  private alertActive = 0
  /** SSH 连接测试缓存，按资产名索引；仅进程内，不落盘、不写审计参数里的主机明细。 */
  private readonly assetProbes: Map<string, AssetProbeResult>
  /** 一轮探测没跑完时不再叠加，避免 SSH 会话越堆越多。 */
  private assetProbeRunning = false

  constructor(private readonly options: PlatformOptions) {
    this.actors = new Map(options.actors.map((actor) => [actor.id, actor]))
    this.store = options.store ?? new MemoryStore()
    this.assetProbes = options.assetProbes ?? new Map()
    this.gate = new ApprovalGate(options.approvalPollMs)
    for (const tool of options.tools) this.toolBaseRisk.set(tool.name, tool.risk)
    this.broker = new ToolBroker(
      options.tools,
      this.store,
      options.actors,
      options.allowAdminSelfApproval === true,
    )
    this.mcpErrors = options.mcpErrors ?? []
    for (const error of this.mcpErrors) {
      this.health.set(error.name, {
        name: error.name,
        ok: false,
        error: error.message,
        failures: MCP_HEALTH_FAILURE_THRESHOLD,
      })
    }
  }

  requireActor(actorId: string): Actor {
    const actor = this.actors.get(actorId)
    if (!actor) throw new PlatformError('未识别的身份', 401, 'unauthorized')
    return actor
  }

  /**
   * 任务可见性：admin/auditor 全看；approver 看自己发起和存在审批记录的任务；
   * operator/viewer 只看自己发起的任务。
   */
  private async canViewTask(actor: Actor, task: Task, approvals?: Approval[]): Promise<boolean> {
    if (actor.roles.includes('admin') || actor.roles.includes('auditor')) return true
    if (task.ownerId === actor.id) return true
    // 告警任务是平台自动发起的，归属账号只是配置项；值班 operator 也要能看到。
    if (task.origin === 'alert' && isOperator(actor)) return true
    if (!actor.roles.includes('approver')) return false
    const items = approvals ?? (await this.store.listApprovals())
    return items.some((approval) => approval.taskId === task.id)
  }

  private async assertCanViewTask(actor: Actor, task: Task): Promise<void> {
    if (!(await this.canViewTask(actor, task))) {
      throw new PlatformError('任务不存在', 404, 'not_found')
    }
  }

  /** 账号或角色变更后同步身份快照；已禁用用户不会出现在这里。 */
  replaceActors(actors: Actor[]): void {
    this.actors = new Map(actors.map((actor) => [actor.id, actor]))
    this.options.actors = actors
    this.broker.replaceActors(actors)
  }

  async createTask(actorId: string, input: CreateTaskInput): Promise<Task> {
    return this.enqueueTask(actorId, input, 'web')
  }

  /**
   * 重试失败的网页任务：复制 prompt/技能和当时的 provider/model，新建一条任务，原任务保留。
   * 只允许 origin=web 且状态 failed；告警任务和外部 Agent 任务不提供重试。
   */
  async retryTask(actorId: string, taskId: string): Promise<Task> {
    const actor = this.requireActor(actorId)
    if (!isOperator(actor)) throw new PlatformError('当前身份不能重试任务', 403, 'forbidden')
    const original = await this.getTask(actorId, taskId)
    if ((original.origin ?? 'web') !== 'web') {
      throw new PlatformError('只有平台网页任务可以重试', 409, 'conflict')
    }
    if (original.status !== 'failed') {
      throw new PlatformError('只有失败的任务可以重试', 409, 'conflict')
    }
    if (original.ownerId !== actor.id && !isAdmin(actor)) {
      throw new PlatformError('只能重试自己发起的任务', 403, 'forbidden')
    }
    const events = await this.store.eventsFor(original.id)
    // 复现当时的模型选择；任务失败在 task.started 之前时按默认 provider/model 重试。
    const started = events.find((event) => event.type === 'task.started')
    const data = (started?.data ?? {}) as { provider?: unknown; model?: unknown }
    const task = await this.enqueueTask(actor.id, {
      title: original.title,
      prompt: original.prompt,
      skill: original.skill,
      ...(typeof data.provider === 'string' && data.provider ? { provider: data.provider } : {}),
      ...(typeof data.model === 'string' && data.model ? { model: data.model } : {}),
    }, 'web')
    // 原任务曾被拒绝过审批时，这次重试是新请求，标记出来方便审计区分。
    const fromRejectedApproval = events.some(
      (event) => event.type === 'approval.decided' && (event.data as { status?: unknown } | undefined)?.status === 'rejected',
    )
    const trace = {
      fromTaskId: original.id,
      actorId: actor.id,
      fromOwnerId: original.ownerId,
      ...(fromRejectedApproval ? { fromRejectedApproval: true } : {}),
    }
    // 不改原任务状态，只在新任务留一条来源事件，便于追溯重试链。
    await this.store.appendEvent({
      id: nid('evt'),
      taskId: task.id,
      type: 'task.retried',
      at: new Date().toISOString(),
      data: trace,
    })
    // 安全事件只记标识，不写 prompt、模型输出或错误详情。
    this.securityEvent('task.retried', {
      ...trace,
      userId: actor.id,
      username: actor.name,
    })
    return task
  }

  private async enqueueTask(
    actorId: string,
    input: CreateTaskInput,
    origin: 'web' | 'alert',
    alertSourceId?: string,
  ): Promise<Task> {
    const actor = this.requireActor(actorId)
    if (!isOperator(actor)) {
      throw new PlatformError('当前身份不能提交任务', 403, 'forbidden')
    }
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
    if (!prompt) throw new PlatformError('prompt 不能为空', 400, 'bad_request')
    const requested = typeof input.skill === 'string' && input.skill.trim() ? input.skill.trim() : undefined
    const skill = selectSkill(this.options.skills, prompt, requested)
    const selection: ModelSelection = {
      ...(typeof input.provider === 'string' && input.provider.trim() ? { provider: input.provider.trim() } : {}),
      ...(typeof input.model === 'string' && input.model.trim() ? { model: input.model.trim() } : {}),
    }
    const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : prompt.slice(0, 40)
    const now = new Date().toISOString()
    const id = nid('task')
    const task: Task = {
      id,
      sessionId: `local:${id}`,
      ownerId: actor.id,
      title,
      prompt,
      skill: skill.name,
      status: 'queued',
      origin,
      ...(alertSourceId ? { alertSourceId } : {}),
      ...(this.options.instanceId ? { runnerId: this.options.instanceId } : {}),
      createdAt: now,
      updatedAt: now,
    }
    await this.store.saveTask(task)
    const controller = new AbortController()
    this.controllers.set(task.id, controller)
    setImmediate(() => {
      void this.run(task, skill, controller, selection)
    })
    return structuredClone(task)
  }

  /**
   * 告警接入：外部监控用 Bearer token 推告警，平台只建只读排查任务。
   * 请求体格式由接入源的 format 决定；同一 fingerprint 在冷却窗口内不重复排查。
   */
  async ingestAlert(sourceId: string, token: string, payload: unknown): Promise<AlertIngestResult> {
    const store = this.options.alertSources
    if (!store) throw new PlatformError('告警接入未启用', 409, 'conflict')
    const source = await store.verifyToken(sourceId, token)
    if (!source) throw new PlatformError('告警 token 不正确', 401, 'unauthorized')
    return this.ingestAlertSource(source, payload, {})
  }

  /** HTTP 层先验 Token 再读请求体，避免匿名请求用大 body 消耗解析资源。 */
  async verifyAlertToken(sourceId: string, token: string): Promise<boolean> {
    const store = this.options.alertSources
    if (!store) return false
    return Boolean(await store.verifyToken(sourceId, token))
  }

  async listAlertSources(actorId: string): Promise<AlertSourceView[]> {
    const actor = this.requireActor(actorId)
    if (!isAdmin(actor) && !actor.roles.includes('auditor')) {
      throw new PlatformError('需要管理员或审计员权限', 403, 'forbidden')
    }
    const store = this.options.alertSources
    if (!store) return []
    const publicUrl = this.options.publicUrl ?? ''
    return (await store.list()).map((source) => alertSourceView(source, publicUrl))
  }

  /** 创建返回明文 token（只此一次）；更新不允许改 token，需要轮换走 rotateAlertSourceToken。 */
  async saveAlertSource(
    actorId: string,
    id: string | undefined,
    input: unknown,
  ): Promise<{ source: AlertSourceView; token?: string }> {
    const actor = this.requireActor(actorId)
    if (!isAdmin(actor)) throw new PlatformError('只有管理员能修改告警接入', 403, 'forbidden')
    const store = this.options.alertSources
    if (!store) throw new PlatformError('告警接入未启用', 409, 'conflict')
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new PlatformError('告警接入必须是对象', 400, 'bad_request')
    }
    const record = input as Record<string, unknown>
    if (record.actorId !== undefined) this.assertAlertActor(record.actorId)
    // 空字符串表示改回「按告警内容自动选择」，不是非法技能。
    if (record.skill !== undefined && record.skill !== '') this.assertAlertSkill(record.skill)
    if (record.skills !== undefined) {
      if (!Array.isArray(record.skills)) throw new PlatformError('skills 必须是数组', 400, 'bad_request')
      for (const skill of record.skills) this.assertAlertSkill(skill)
    }
    const publicUrl = this.options.publicUrl ?? ''
    if (id) {
      const source = await store.update(id, record)
      return { source: alertSourceView(source, publicUrl) }
    }
    if (record.actorId === undefined) throw new PlatformError('actorId 必填', 400, 'bad_request')
    this.assertAlertActor(record.actorId)
    const created = await store.create(record)
    return { source: alertSourceView(created.source, publicUrl), token: created.token }
  }

  async removeAlertSource(actorId: string, id: string): Promise<boolean> {
    const actor = this.requireActor(actorId)
    if (!isAdmin(actor)) throw new PlatformError('只有管理员能修改告警接入', 403, 'forbidden')
    const store = this.options.alertSources
    if (!store) return false
    const removed = await store.remove(id)
    if (removed) {
      this.alertRate.delete(id)
      for (const key of this.alertSeen.keys()) {
        if (key.startsWith(`${id}|`)) this.alertSeen.delete(key)
      }
    }
    return removed
  }

  async rotateAlertSourceToken(
    actorId: string,
    id: string,
  ): Promise<{ source: AlertSourceView; token: string }> {
    const actor = this.requireActor(actorId)
    if (!isAdmin(actor)) throw new PlatformError('只有管理员能修改告警接入', 403, 'forbidden')
    const store = this.options.alertSources
    if (!store) throw new PlatformError('告警接入未启用', 409, 'conflict')
    const rotated = await store.rotateToken(id)
    return { source: alertSourceView(rotated.source, this.options.publicUrl ?? ''), token: rotated.token }
  }

  /** 管理员测试：用一条模拟告警走完整链路，跳过冷却但受并发上限约束。 */
  async testAlertSource(actorId: string, id: string, payload?: unknown): Promise<AlertIngestResult> {
    const actor = this.requireActor(actorId)
    if (!isAdmin(actor)) throw new PlatformError('只有管理员能测试告警接入', 403, 'forbidden')
    const store = this.options.alertSources
    if (!store) throw new PlatformError('告警接入未启用', 409, 'conflict')
    const source = await store.get(id)
    if (!source) throw new PlatformError('告警接入不存在', 404, 'not_found')
    return this.ingestAlertSource(source, payload ?? sampleAlert(source), {
      skipDedupe: true,
      allowDisabled: true,
    })
  }

  private async ingestAlertSource(
    source: AlertSource,
    payload: unknown,
    options: { skipDedupe?: boolean; allowDisabled?: boolean },
  ): Promise<AlertIngestResult> {
    if (!source.enabled && !options.allowDisabled) {
      throw new PlatformError('告警接入已停用', 403, 'forbidden')
    }
    this.assertAlertRate(source.id)
    const alerts = parseAlertPayload(source.format, payload)
    const firing = alerts.filter((alert) => alert.status === 'firing')
    if (firing.length === 0) {
      return { accepted: false, reason: 'resolved', alert: alertSummary(alerts[0]) }
    }
    const actionable = firing.filter((alert) => alert.severity <= source.maxSeverity)
    if (actionable.length === 0) {
      return { accepted: false, reason: 'below_threshold', alert: alertSummary(firing[0]) }
    }
    const key = `${source.id}|${actionable.map((alert) => alert.fingerprint).sort().join(',')}`
    const now = Date.now()
    if (!options.skipDedupe) {
      const previous = this.alertSeen.get(key)
      if (previous !== undefined && now - previous < source.cooldownMs) {
        return { accepted: false, reason: 'duplicate', alert: alertSummary(actionable[0]) }
      }
    }
    const capacity = clampInteger(this.options.alertMaxConcurrency ?? 3, 1, 50)
    if (this.alertActive >= capacity) {
      return { accepted: false, reason: 'capacity', alert: alertSummary(actionable[0]) }
    }
    const actor = this.actors.get(source.actorId)
    if (!actor || !isOperator(actor)) {
      throw new PlatformError('告警接入的归属账号不可用，请管理员重新选择', 409, 'conflict')
    }
    const requested = this.alertSkill(source, actionable)
    const prompt = alertPrompt(actionable)
    const title = `告警排查：${actionable[0].name}`.slice(0, 80)
    this.alertSeen.set(key, now)
    if (this.alertSeen.size > 1000) {
      for (const [seenKey, at] of this.alertSeen) {
        if (now - at > 60 * 60 * 1000) this.alertSeen.delete(seenKey)
      }
    }
    this.alertActive += 1
    try {
      const task = await this.enqueueTask(
        actor.id,
        {
          title,
          prompt,
          ...(requested ? { skill: requested } : {}),
          ...(source.provider ? { provider: source.provider } : {}),
          ...(source.model ? { model: source.model } : {}),
        },
        'alert',
        source.id,
      )
      return { accepted: true, taskId: task.id, alert: alertSummary(actionable[0]) }
    } catch (error) {
      this.alertActive -= 1
      this.alertSeen.delete(key)
      throw error
    }
  }

  private assertAlertRate(sourceId: string): void {
    const now = Date.now()
    const bucket = this.alertRate.get(sourceId)
    if (!bucket || now >= bucket.resetAt) {
      this.alertRate.set(sourceId, { count: 1, resetAt: now + 60_000 })
      return
    }
    if (bucket.count >= 60) {
      throw new PlatformError('告警请求过于频繁', 429, 'too_many_requests')
    }
    bucket.count += 1
  }

  private assertAlertActor(value: unknown): void {
    if (typeof value !== 'string' || !value.trim()) {
      throw new PlatformError('actorId 必填', 400, 'bad_request')
    }
    const actor = this.actors.get(value.trim())
    if (!actor || !isOperator(actor)) {
      throw new PlatformError('归属账号不存在或没有提交任务的权限', 400, 'bad_request')
    }
  }

  private assertAlertSkill(value: unknown): void {
    if (typeof value !== 'string' || !value.trim()) {
      throw new PlatformError('技能名称不合法', 400, 'bad_request')
    }
    if (!this.options.skills.some((skill) => skill.name === value.trim())) {
      throw new PlatformError(`未知技能 ${value.trim()}`, 400, 'unknown_skill')
    }
  }

  /** 告警标签 aiops_skill 只有在接入源白名单里才生效，避免外部告警指定任意技能。 */
  private alertSkill(source: AlertSource, alerts: NormalizedAlert[]): string | undefined {
    for (const alert of alerts) {
      const wanted = alert.labels.aiops_skill
      if (wanted && source.skills.includes(wanted) && this.options.skills.some((skill) => skill.name === wanted)) {
        return wanted
      }
    }
    if (source.skill && this.options.skills.some((skill) => skill.name === source.skill)) return source.skill
    return undefined
  }

  /**
   * DSH 驱动的任务：平台只建任务和记事件，推理和工具选择由 DSH 完成。
   * 不启动本地 playbook，避免把平台做成第二个 Agent 循环。
   */
  async createAgentTask(
    actorId: string,
    input: CreateAgentTaskInput,
    origin: 'dsh' | 'api' = 'dsh',
  ): Promise<Task> {
    const actor = this.requireActor(actorId)
    if (!isOperator(actor)) {
      throw new PlatformError('当前身份不能提交任务', 403, 'forbidden')
    }
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
    if (!prompt) throw new PlatformError('prompt 不能为空', 400, 'bad_request')
    const requested = typeof input.skill === 'string' && input.skill.trim() ? input.skill.trim() : undefined
    const skill = selectSkill(this.options.skills, prompt, requested)
    const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : prompt.slice(0, 40)
    const now = new Date().toISOString()
    const id = nid('task')
    const sessionId =
      typeof input.sessionId === 'string' && input.sessionId.trim() ? input.sessionId.trim() : `${origin}:${id}`
    const task: Task = {
      id,
      sessionId,
      ownerId: actor.id,
      title,
      prompt,
      skill: skill.name,
      status: 'running',
      origin,
      createdAt: now,
      updatedAt: now,
    }
    await this.store.saveTask(task)
    await this.emit(task, 'task.started', { sessionId, skill: skill.name, origin })
    await this.emit(task, 'skill.selected', { skill: skill.name, description: skill.description })
    return structuredClone(task)
  }

  async finishAgentTask(actorId: string, taskId: string, input: FinishAgentTaskInput): Promise<Task> {
    const actor = this.requireActor(actorId)
    const task = await this.store.getTask(taskId)
    if (!task) throw new PlatformError('任务不存在', 404, 'not_found')
    if (task.origin === 'web' || !task.origin) {
      throw new PlatformError('只有外部 Agent 任务可以这样结束', 409, 'conflict')
    }
    if (task.ownerId !== actor.id && !isApprover(actor)) {
      throw new PlatformError('不能操作别人的任务', 403, 'forbidden')
    }
    const status = input.status ?? 'succeeded'
    if (status !== 'succeeded' && status !== 'failed') {
      throw new PlatformError('status 只能是 succeeded 或 failed', 400, 'bad_request')
    }
    if (TERMINAL.has(task.status)) return structuredClone(task)
    if (task.status === 'awaiting_approval') {
      throw new PlatformError('还有待审批的变更，先处理审批再结束任务', 409, 'conflict')
    }
    task.status = status
    if (status === 'succeeded') {
      task.result = typeof input.result === 'string' && input.result.trim() ? input.result.trim() : '任务完成'
      task.error = undefined
      await this.emit(task, 'task.completed', { result: task.result })
    } else {
      task.error = typeof input.error === 'string' && input.error.trim() ? input.error.trim() : '任务失败'
      await this.emit(task, 'task.failed', { error: task.error })
      this.notifyTaskFailed(task)
    }
    return structuredClone(task)
  }

  async getTask(actorId: string, taskId: string): Promise<Task> {
    const actor = this.requireActor(actorId)
    const task = await this.store.getTask(taskId)
    if (!task) throw new PlatformError('任务不存在', 404, 'not_found')
    await this.assertCanViewTask(actor, task)
    return structuredClone(task)
  }

  /** 任务可见性：admin/auditor 全看；approver 看自己的和存在审批记录的；其余只看自己的。 */
  private taskVisibility(actor: Actor): Pick<TaskQuery, 'actorId' | 'seeAll' | 'approver'> {
    const seeAll = actor.roles.includes('admin') || actor.roles.includes('auditor')
    return {
      actorId: actor.id,
      seeAll,
      approver: !seeAll && actor.roles.includes('approver'),
    }
  }

  async listTasks(
    actorId: string,
    filter: { status?: string; ownerId?: string; origin?: string },
    page: { limit?: number; offset?: number } = {},
  ): Promise<Task[]> {
    return (await this.listTasksPage(actorId, filter, page)).tasks
  }

  async listTasksPage(
    actorId: string,
    filter: { status?: string; ownerId?: string; origin?: string },
    page: { limit?: number; offset?: number } = {},
  ): Promise<{ tasks: Task[]; total: number }> {
    const actor = this.requireActor(actorId)
    const result = await this.store.queryTasks({
      ...this.taskVisibility(actor),
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.ownerId ? { ownerId: filter.ownerId } : {}),
      ...(filter.origin ? { origin: filter.origin } : {}),
      ...(page.limit !== undefined ? { limit: page.limit } : {}),
      ...(page.offset !== undefined ? { offset: page.offset } : {}),
    })
    return { tasks: result.items.map((task) => structuredClone(task)), total: result.total }
  }

  /**
   * 平台启动时调用：网页 playbook 和告警任务的执行循环在进程内，重启后不会恢复。
   * 把仍停在非终态的本地任务标记失败，并拒绝挂起的审批；dsh 任务留给 DSH 收尾。
   */
  async recoverInterruptedTasks(): Promise<number> {
    const now = new Date().toISOString()
    // 多实例（配置了 instanceId）时只回收本实例执行的本地任务，不能误杀其它副本上的任务。
    const instanceId = this.options.instanceId
    const stale = (await this.store.listTasks()).filter(
      (task) =>
        (task.origin === 'web' || task.origin === 'alert') &&
        (!instanceId || task.runnerId === instanceId) &&
        (task.status === 'queued' || task.status === 'running' || task.status === 'awaiting_approval'),
    )
    if (stale.length === 0) return 0
    const staleIds = new Set(stale.map((task) => task.id))
    for (const task of stale) {
      task.status = 'failed'
      task.error = '平台重启，任务中断'
      task.updatedAt = now
      await this.store.saveTask(task)
      await this.store.appendEvent({
        id: nid('evt'),
        taskId: task.id,
        type: 'task.failed',
        at: now,
        data: { error: task.error },
      })
      if (task.origin === 'alert') void this.notifyAlertResult(task)
    }
    for (const approval of await this.store.listApprovals()) {
      if (approval.status !== 'pending' || !staleIds.has(approval.taskId)) continue
      await this.store.decideApproval(approval.id, 'rejected', 'system', now, '平台重启，任务中断')
    }
    return stale.length
  }

  /**
   * 外部 Agent（DSH / WorkBuddy / /api/v1）的自动任务靠客户端结束；客户端直接断开、
   * 进程退出或平台重启时，进程里的空闲计时器会跟着丢，任务就永久停在 running。
   * 这里按最后活动时间兜底：超过 maxIdleMs 没有新事件、且没有挂起审批的外部任务标记完成。
   * 挂起审批的任务不在这里动，交给 expireApprovals。
   */
  async reapStaleExternalTasks(now = new Date(), maxIdleMs = 240_000): Promise<number> {
    const idle = Number.isFinite(maxIdleMs) && maxIdleMs >= 1_000 ? maxIdleMs : 240_000
    const cutoff = new Date(now.getTime() - idle).toISOString()
    const waiting = new Set(
      (await this.store.listApprovals())
        .filter((approval) => approval.status === 'pending')
        .map((approval) => approval.taskId),
    )
    const stale = (await this.store.listTasks()).filter(
      (task) => isExternalTask(task) && task.status === 'running' && task.updatedAt < cutoff && !waiting.has(task.id),
    )
    for (const task of stale) {
      task.status = 'succeeded'
      task.result = '外部 Agent 会话空闲，平台自动结束（没有收到结束事件）'
      await this.emit(task, 'task.completed', { result: task.result })
    }
    return stale.length
  }

  /**
   * 挂起审批超时自动拒绝。和人工拒绝一样写审计、发事件；DSH 任务没有本地 runner，
   * 最后一个挂起审批过期后直接标失败，避免永久停在 awaiting_approval。
   */
  async expireApprovals(now = new Date()): Promise<number> {
    const ttl = this.options.approvalTtlMs ?? 24 * 60 * 60 * 1000
    if (ttl <= 0) return 0
    const cutoff = new Date(now.getTime() - ttl).toISOString()
    const expired = (await this.store.listApprovals()).filter(
      (approval) => approval.status === 'pending' && approval.requestedAt < cutoff,
    )
    let count = 0
    for (const approval of expired) {
      const decidedAt = now.toISOString()
      let failedTask: Task | undefined
      const updated = await this.store.transaction(async (tx) => {
        if (!(await tx.decideApproval(approval.id, 'rejected', 'system', decidedAt, '审批超时，自动拒绝'))) {
          return undefined
        }
        await tx.appendAudit({
          id: nid('aud'),
          taskId: approval.taskId,
          actorId: 'system',
          tool: approval.tool,
          risk: 'mutate',
          args: approval.args,
          decision: 'rejected',
          approvalId: approval.id,
          at: decidedAt,
        })
        const task = await tx.getTask(approval.taskId)
        if (task) {
          let failedNow = false
          if (isExternalTask(task) && task.status === 'awaiting_approval') {
            const stillPending = (await tx.listApprovals()).some(
              (item) => item.taskId === task.id && item.status === 'pending',
            )
            if (!stillPending) {
              task.status = 'failed'
              task.error = '审批超时，任务失败'
              failedNow = true
            }
          }
          await this.emitWith(tx, task, 'approval.decided', {
            approvalId: approval.id,
            status: 'rejected',
            decidedBy: 'system',
            reason: '审批超时',
          })
          if (failedNow) {
            await this.emitWith(tx, task, 'task.failed', { error: task.error ?? '审批超时' })
            failedTask = structuredClone(task)
          }
        }
        return tx.getApproval(approval.id)
      })
      if (updated) {
        this.gate.notify(updated)
        this.notify('approval.expired', '变更审批已超时', `工具 ${approval.tool} 的审批超过有效期，已自动拒绝。`, approval.id, {
          tool: approval.tool,
          approvalId: approval.id,
          taskId: approval.taskId,
        })
        if (failedTask) this.notifyTaskFailed(failedTask)
        count += 1
      }
    }
    return count
  }

  /** 清理终态旧任务及其事件、审批、审计；返回删除的任务数。 */
  async cleanupTasks(cutoff: string): Promise<number> {
    return this.store.purgeTerminalTasksBefore(cutoff)
  }

  async listEvents(actorId: string, taskId: string, after?: string): Promise<TaskEvent[]> {
    await this.getTask(actorId, taskId)
    const events = await this.store.eventsFor(taskId)
    if (!after) return events.map((event) => structuredClone(event))
    const index = events.findIndex((event) => event.id === after)
    if (index < 0) throw new PlatformError('after 对应的事件不存在', 400, 'bad_request')
    return events.slice(index + 1).map((event) => structuredClone(event))
  }

  async listAudit(actorId: string, taskId: string): Promise<AuditRecord[]> {
    await this.getTask(actorId, taskId)
    return (await this.store.auditsFor(taskId)).map((audit) => structuredClone(audit))
  }

  async cancel(actorId: string, taskId: string, options: { force?: boolean } = {}): Promise<Task> {
    const actor = this.requireActor(actorId)
    const task = await this.store.getTask(taskId)
    if (!task) throw new PlatformError('任务不存在', 404, 'not_found')
    const owns = task.ownerId === actor.id && isOperator(actor)
    const approver = isApprover(actor)
    if (!owns && !approver) throw new PlatformError('当前身份不能取消这个任务', 403, 'forbidden')
    if (TERMINAL.has(task.status)) return structuredClone(task)
    // 取消会把挂起审批一并作废。Agent 容易在等审批时误取消，必须显式确认。
    const pending = (await this.store.listApprovals()).filter(
      (approval) => approval.taskId === task.id && approval.status === 'pending',
    )
    if (pending.length > 0 && options.force !== true) {
      throw new PlatformError(
        `任务还有 ${pending.length} 个待审批变更，取消会作废审批；确认取消请传 force=true`,
        409,
        'conflict',
      )
    }
    task.status = 'cancelled'
    await this.emit(task, 'task.cancelled', {})
    this.controllers.get(task.id)?.abort()
    await this.voidPendingApprovals(task.id, actor.id)
    return structuredClone(task)
  }

  /** 任务取消后，挂起的变更审批必须一起作废，避免审批箱里留下永远执行不了的变更。 */
  private async voidPendingApprovals(taskId: string, actorId: string): Promise<void> {
    const now = new Date().toISOString()
    const voided = await this.store.transaction(async (tx) => {
      const task = await tx.getTask(taskId)
      const approvals = await tx.listApprovals()
      const result: Approval[] = []
      for (const approval of approvals) {
        if (approval.taskId !== taskId || approval.status !== 'pending') continue
        if (!(await tx.decideApproval(approval.id, 'rejected', actorId, now, '任务已取消，审批作废'))) continue
        approval.status = 'rejected'
        approval.decidedBy = actorId
        approval.decidedAt = now
        approval.comment = '任务已取消，审批作废'
        await tx.appendAudit({
          id: nid('aud'),
          taskId,
          actorId,
          tool: approval.tool,
          risk: 'mutate',
          args: approval.args,
          decision: 'rejected',
          approvalId: approval.id,
          at: now,
        })
        if (task) await this.emitWith(tx, task, 'approval.decided', { approvalId: approval.id, status: 'rejected', decidedBy: actorId })
        result.push(structuredClone(approval))
      }
      return result
    })
    for (const approval of voided) this.gate.notify(approval)
  }

  /** 单条审批，用于从任务详情跳转时不受分页影响；可见性规则与列表一致。 */
  async getApproval(actorId: string, approvalId: string): Promise<Approval> {
    const actor = this.requireActor(actorId)
    const approval = await this.store.getApproval(approvalId)
    if (!approval) throw new PlatformError('审批不存在', 404, 'not_found')
    if (!isApprover(actor) && !actor.roles.includes('auditor')) {
      const task = await this.store.getTask(approval.taskId)
      if (approval.requestedBy !== actor.id && task?.ownerId !== actor.id) {
        throw new PlatformError('当前身份不能查看这个审批', 403, 'forbidden')
      }
    }
    return structuredClone(approval)
  }

  /**
   * 审批结果回传：DSH 模型在审批通过后用它获取自动执行的结果，
   * 不需要也不应该重新调用变更工具。执行结果来自任务里的 tool.result 事件。
   */
  async getApprovalDetail(actorId: string, approvalId: string, waitMs = 0): Promise<ApprovalDetail> {
    const wait = Number.isFinite(waitMs) ? Math.min(120_000, Math.max(0, Math.floor(waitMs))) : 0
    if (wait === 0) return this.readApprovalDetail(actorId, approvalId)
    const deadline = Date.now() + wait
    for (;;) {
      const detail = await this.readApprovalDetail(actorId, approvalId)
      if (!approvalExecutionPending(detail)) return detail
      if (Date.now() >= deadline) return { ...detail, timedOut: true }
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, deadline - Date.now())))
    }
  }

  private async readApprovalDetail(actorId: string, approvalId: string): Promise<ApprovalDetail> {
    const approval = await this.getApproval(actorId, approvalId)
    if (approval.status === 'pending') {
      return { approval, execution: { status: 'pending' } }
    }
    if (approval.status === 'rejected') {
      return {
        approval,
        execution: {
          status: 'rejected',
          ...(approval.decidedAt ? { at: approval.decidedAt } : {}),
          ...(approval.comment ? { error: approval.comment } : {}),
        },
      }
    }
    let execution: ApprovalExecution = { status: 'approved' }
    if (!approval.taskId.startsWith('adhoc:')) {
      const events = await this.store.eventsFor(approval.taskId)
      const result = [...events].reverse().find((event) => {
        if (event.type !== 'tool.result') return false
        const data = event.data as Record<string, unknown> | undefined
        return data?.approvalId === approval.id
      })
      if (result) {
        const data = (result.data ?? {}) as Record<string, unknown>
        const failed = data.status === 'error' || data.status === 'denied'
        execution = {
          status: failed ? 'failed' : 'succeeded',
          at: result.at,
          ...(data.result !== undefined ? { result: data.result } : {}),
          ...(typeof data.error === 'string' ? { error: data.error } : {}),
          ...(typeof data.auditId === 'string' ? { auditId: data.auditId } : {}),
        }
      } else if (approval.consumed) {
        // 审批已被消费但任务里没有结果事件，通常是历史数据或 adhoc 调用。
        execution = { status: 'unknown', ...(approval.decidedAt ? { at: approval.decidedAt } : {}) }
      }
    } else if (approval.consumed) {
      execution = { status: 'unknown', ...(approval.decidedAt ? { at: approval.decidedAt } : {}) }
    }
    return { approval, execution }
  }

  async listApprovals(
    actorId: string,
    status?: string,
    taskId?: string,
    page: { limit?: number; offset?: number } = {},
  ): Promise<Approval[]> {
    return (await this.listApprovalsPage(actorId, status, taskId, page)).approvals
  }

  async listApprovalsPage(
    actorId: string,
    status?: string,
    taskId?: string,
    page: { limit?: number; offset?: number } = {},
  ): Promise<{ approvals: Approval[]; total: number }> {
    const actor = this.requireActor(actorId)
    if (status && status !== 'pending' && status !== 'approved' && status !== 'rejected') {
      throw new PlatformError('status 不合法', 400, 'bad_request')
    }
    const seeAll =
      isApprover(actor) || actor.roles.includes('auditor') || actor.roles.includes('admin')
    const result = await this.store.queryApprovals({
      actorId: actor.id,
      seeAll,
      ...(status ? { status } : {}),
      ...(taskId ? { taskId } : {}),
      ...(page.limit !== undefined ? { limit: page.limit } : {}),
      ...(page.offset !== undefined ? { offset: page.offset } : {}),
    })
    return { approvals: result.items.map((approval) => structuredClone(approval)), total: result.total }
  }

  /** 是否允许 admin 自批；网页用它决定要不要显示自己名下审批的操作按钮。 */
  get adminSelfApprovalAllowed(): boolean {
    return this.options.allowAdminSelfApproval === true
  }

  async decideApproval(actorId: string, approvalId: string, decision: string, comment?: string): Promise<Approval> {
    const actor = this.requireActor(actorId)
    if (!isApprover(actor)) throw new PlatformError('当前身份不能审批', 403, 'forbidden')
    if (decision !== 'approved' && decision !== 'rejected') {
      throw new PlatformError('decision 只能是 approved 或 rejected', 400, 'bad_request')
    }
    if (comment !== undefined && typeof comment !== 'string') {
      throw new PlatformError('comment 必须是字符串', 400, 'bad_request')
    }
    const approval = await this.store.getApproval(approvalId)
    if (!approval) throw new PlatformError('审批不存在', 404, 'not_found')
    if (approval.status !== 'pending') throw new PlatformError('审批已经处理过', 409, 'conflict')
    const selfApproval = actor.id === approval.ownerId
    // 默认禁止自批；只有显式开启开关时 admin 可以，approver/operator 永远不行。
    if (selfApproval && !(isAdmin(actor) && this.options.allowAdminSelfApproval === true)) {
      throw new PlatformError('不能审批自己名下的变更', 403, 'forbidden')
    }
    const decidedAt = new Date().toISOString()
    const note = comment?.trim()
    let failedTask: Task | undefined
    const updated = await this.store.transaction(async (tx) => {
      if (!(await tx.decideApproval(approval.id, decision, actor.id, decidedAt, note))) {
        throw new PlatformError('审批已经处理过', 409, 'conflict')
      }
      await tx.appendAudit({
        id: nid('aud'),
        taskId: approval.taskId,
        actorId: actor.id,
        tool: approval.tool,
        risk: 'mutate',
        args: approval.args,
        decision: decision === 'approved' ? 'approved' : 'rejected',
        approvalId: approval.id,
        at: decidedAt,
      })
      const task = await tx.getTask(approval.taskId)
      if (task) {
        let failedNow = false
        // DSH 任务没有本地 runner 等审批结果，决定后必须离开 awaiting_approval，否则永远卡住。
        if (task.origin === 'dsh' && task.status === 'awaiting_approval') {
          const stillPending = (await tx.listApprovals()).some(
            (item) => item.taskId === task.id && item.status === 'pending',
          )
          if (!stillPending) {
            if (decision === 'approved') {
              task.status = 'running'
            } else {
              task.status = 'failed'
              task.error = '审批被拒绝'
              failedNow = true
            }
          }
        }
        await this.emitWith(tx, task, 'approval.decided', {
          approvalId: approval.id,
          status: decision,
          decidedBy: actor.id,
          ...(selfApproval ? { selfApproved: true } : {}),
        })
        if (failedNow) {
          await this.emitWith(tx, task, 'task.failed', { error: task.error ?? '审批被拒绝' })
          failedTask = structuredClone(task)
        }
      }
      const result = await tx.getApproval(approval.id)
      if (!result) throw new PlatformError('审批不存在', 404, 'not_found')
      return result
    })
    this.gate.notify(updated)
    if (failedTask) this.notifyTaskFailed(failedTask)
    // DSH 和 adhoc 审批没有本地 runner 续跑；批准后由平台自动执行，审批仍只消费一次。
    const approvedTask = await this.store.getTask(updated.taskId)
    if (decision === 'approved' && (!approvedTask || isExternalTask(approvedTask))) {
      try {
        await this.resumeApproval(actor.id, updated.id)
      } catch {
        // 任务可能已被取消或工具已被替换；审批决定本身仍然有效，人工可在审批页重试。
      }
    }
    return structuredClone(updated)
  }

  listTools(actorId: string): Array<Pick<Tool, 'name' | 'description' | 'risk' | 'parameters'>> {
    this.requireActor(actorId)
    return this.options.tools.map(({ name, description, risk, parameters }) => ({ name, description, risk, parameters }))
  }

  /** 启动时加载策略；失败要阻断启动，不能静默把管理员的设置当成空。 */
  async loadToolPolicies(): Promise<void> {
    if (this.policiesLoaded || !this.options.toolPolicies) return
    this.policies = await this.options.toolPolicies.list()
    this.policiesLoaded = true
    this.refreshToolRisks()
  }

  async listToolPolicies(actorId: string): Promise<ToolPolicyView[]> {
    this.requireActor(actorId)
    await this.ensurePolicies()
    return this.toolPolicyViews()
  }

  /** 设置单个 mcp.* 工具的审批策略；只允许 admin。 */
  async setToolPolicy(actorId: string, toolName: string, risk: ToolRisk): Promise<ToolPolicyView[]> {
    const actor = this.requireActor(actorId)
    if (!isAdmin(actor)) throw new PlatformError('只有 admin 能修改工具审批策略', 403, 'forbidden')
    if (!this.options.toolPolicies) {
      throw new PlatformError('当前平台没有启用工具审批策略', 503, 'unavailable')
    }
    if (!isPolicyToolName(toolName)) {
      throw new PlatformError('只能给 mcp.* 工具设置审批策略', 400, 'bad_request')
    }
    if (risk !== 'read' && risk !== 'mutate') {
      throw new PlatformError('risk 只能是 read 或 mutate', 400, 'bad_request')
    }
    const tool = this.options.tools.find((item) => item.name === toolName)
    if (!tool) throw new PlatformError(`工具不存在: ${toolName}`, 404, 'not_found')
    await this.options.toolPolicies.set(toolName, risk, toolPolicySignature(tool), actor.id)
    this.policies = await this.options.toolPolicies.list()
    this.policiesLoaded = true
    this.refreshToolRisks()
    return this.toolPolicyViews()
  }

  /** 删除覆盖，恢复 server 配置决定的默认风险。 */
  async clearToolPolicy(actorId: string, toolName: string): Promise<ToolPolicyView[]> {
    const actor = this.requireActor(actorId)
    if (!isAdmin(actor)) throw new PlatformError('只有 admin 能修改工具审批策略', 403, 'forbidden')
    if (!this.options.toolPolicies) {
      throw new PlatformError('当前平台没有启用工具审批策略', 503, 'unavailable')
    }
    if (!isPolicyToolName(toolName)) {
      throw new PlatformError('只能修改 mcp.* 工具的审批策略', 400, 'bad_request')
    }
    await this.options.toolPolicies.remove(toolName)
    this.policies = await this.options.toolPolicies.list()
    this.policiesLoaded = true
    this.refreshToolRisks()
    return this.toolPolicyViews()
  }

  listActors(): Array<Pick<Actor, 'id' | 'name' | 'roles'>> {
    return this.options.actors.map(({ id, name, roles }) => ({ id, name, roles: [...roles] }))
  }

  listSkills(actorId: string): Array<Pick<Skill, 'name' | 'description' | 'keywords' | 'body'>> {
    this.requireActor(actorId)
    return this.options.skills.map(({ name, description, keywords, body }) => ({ name, description, keywords, body }))
  }

  async listAssets(actorId: string): Promise<AssetView[]> {
    this.requireActor(actorId)
    return (await this.options.assets.list()).map(toAssetView)
  }

  async saveAsset(actorId: string, input: AssetRecord): Promise<AssetView> {
    const actor = this.requireActor(actorId)
    if (!isOperator(actor)) {
      throw new PlatformError('当前身份不能修改资产', 403, 'forbidden')
    }
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    const existing = name ? await this.options.assets.get(name) : undefined
    const previousPaths = existing?.sshReadPaths ?? []
    if (input.sshReadPaths !== undefined) {
      let requested: string[]
      try {
        requested = normalizeReadPaths(input.sshReadPaths)
      } catch (error) {
        throw new PlatformError(error instanceof Error ? error.message : 'sshReadPaths 不合法', 400, 'bad_request')
      }
      if (!sameReadPaths(requested, previousPaths) && !isAdmin(actor)) {
        throw new PlatformError('只有管理员可以修改 SSH 只读路径', 403, 'forbidden')
      }
      input = { ...input, sshReadPaths: requested }
    } else if (previousPaths.length) {
      input = { ...input, sshReadPaths: [...previousPaths] }
    }
    if (input.sshCredentialId) {
      const credential = await this.options.credentials.get(input.sshCredentialId)
      if (!credential) throw new PlatformError('SSH 凭证不存在', 400, 'bad_request')
      if (input.sshPassword || input.sshKey) {
        throw new PlatformError('资产只能选择一个凭证，不能同时填写密码或私钥', 400, 'bad_request')
      }
    }
    try {
      const saved = await this.options.assets.upsert(input)
      // 主机、凭证或端口可能变了，旧连接状态不再可信。
      this.dropAssetProbe(saved.name)
      return toAssetView(saved)
    } catch (error) {
      throw new PlatformError(error instanceof Error ? error.message : '资产保存失败', 400, 'bad_request')
    }
  }

  /** 最近一次 SSH 连接测试结果，按资产名索引；进程内缓存，重启即清空。 */
  listAssetProbes(actorId: string): Record<string, AssetProbeResult> {
    this.requireActor(actorId)
    return Object.fromEntries(this.assetProbes)
  }

  /** 资产或凭证变化后清掉对应缓存，避免页面和模型拿旧的「可连接」状态。 */
  private dropAssetProbe(name: string): void {
    this.assetProbes.delete(name)
  }

  /**
   * 后台连接测试：对配置齐全的资产（有主机、SSH 用户、凭证和已信任主机密钥）
   * 真实建立一次 SSH 连接（含认证、跳板机和主机密钥校验），不执行命令。
   * 缺配置的资产不发起连接，只记 blockedReason；没有手动入口，由 compose 定时调用。
   */
  async probeAssets(timeoutMs = 15_000): Promise<{
    checkedAt: string
    results: AssetProbeResult[]
    skipped?: boolean
  }> {
    const checkedAt = new Date().toISOString()
    if (this.assetProbeRunning) {
      // 上一轮还没跑完（资产多、超时长），直接复用当前缓存，不再叠加登录。
      return { checkedAt, results: [...this.assetProbes.values()].map((item) => ({ ...item })), skipped: true }
    }
    this.assetProbeRunning = true
    try {
      const timeout = clampInteger(timeoutMs, 1_000, 30_000)
      const all = await this.options.assets.list()
      const keep = new Set(all.map((asset) => asset.name))
      for (const name of [...this.assetProbes.keys()]) {
        if (!keep.has(name)) this.assetProbes.delete(name)
      }
      const results = await mapLimit(all, 4, async (asset): Promise<AssetProbeResult> => {
        const host = asset.ip || asset.host
        const target = host ? `${host}:${asset.sshPort ?? 22}` : undefined
        const blocked = await assetSshBlockedReason(asset, this.options.credentials)
        if (blocked) {
          const result: AssetProbeResult = {
            name: asset.name,
            status: 'unknown',
            checkedAt,
            ...(target ? { target } : {}),
            error: blocked,
            blockedReason: blocked,
          }
          this.assetProbes.set(asset.name, result)
          return result
        }
        const startedAt = Date.now()
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeout)
        timer.unref?.()
        try {
          await testAssetConnection(
            this.options.assets,
            this.options.credentials,
            asset.name,
            controller.signal,
          )
          const result: AssetProbeResult = {
            name: asset.name,
            status: 'up',
            checkedAt,
            ...(target ? { target } : {}),
            latencyMs: Date.now() - startedAt,
          }
          this.assetProbes.set(asset.name, result)
          return result
        } catch (error) {
          const message = controller.signal.aborted
            ? 'SSH 连接超时：检查 IP、端口、网络和防火墙'
            : describeSshConnectError(error)
          const result: AssetProbeResult = {
            name: asset.name,
            status: 'down',
            checkedAt,
            ...(target ? { target } : {}),
            error: message,
          }
          this.assetProbes.set(asset.name, result)
          return result
        } finally {
          clearTimeout(timer)
        }
      })
      return { checkedAt, results }
    } finally {
      this.assetProbeRunning = false
    }
  }

  async deleteAssets(actorId: string, input: unknown): Promise<{ deleted: string[]; failed: AssetBatchFailure[] }> {
    const actor = this.requireActor(actorId)
    if (!isOperator(actor)) throw new PlatformError('当前身份不能修改资产', 403, 'forbidden')
    const names = normalizeAssetNames(input)
    const deleted: string[] = []
    const failed: AssetBatchFailure[] = []
    for (const name of names) {
      try {
        if (await this.options.assets.remove(name)) {
          deleted.push(name)
          this.assetProbes.delete(name)
        } else {
          failed.push({ name, error: '资产不存在' })
        }
      } catch (error) {
        failed.push({ name, error: error instanceof Error ? error.message : '删除失败' })
      }
    }
    return { deleted, failed }
  }

  /**
   * 批量设置凭证：只改引用，不动主机和其他字段；写凭证会清掉资产上的内联密码/私钥。
   * credentialId 为空表示解除引用，已有内联密钥不会被删除。
   */
  async assignAssetCredential(
    actorId: string,
    input: unknown,
    credentialId: string,
  ): Promise<{ updated: AssetView[]; failed: AssetBatchFailure[] }> {
    const actor = this.requireActor(actorId)
    if (!isOperator(actor)) throw new PlatformError('当前身份不能修改资产', 403, 'forbidden')
    const names = normalizeAssetNames(input)
    const id = credentialId.trim()
    if (id) {
      const credential = await this.options.credentials.get(id)
      if (!credential) throw new PlatformError('SSH 凭证不存在', 400, 'bad_request')
    }
    const updated: AssetView[] = []
    const failed: AssetBatchFailure[] = []
    for (const name of names) {
      const asset = await this.options.assets.get(name)
      if (!asset) {
        failed.push({ name, error: '资产不存在' })
        continue
      }
      try {
        const record: AssetRecord = { ...asset, sshCredentialId: id || undefined }
        if (id) {
          record.sshPassword = undefined
          record.sshKey = undefined
          record.sshPassphrase = undefined
        }
        updated.push(toAssetView(await this.options.assets.upsert(record)))
        this.dropAssetProbe(name)
      } catch (error) {
        failed.push({ name, error: error instanceof Error ? error.message : '设置凭证失败' })
      }
    }
    return { updated, failed }
  }

  /**
   * 批量设置跳板机：只改 sshJumpAsset 引用，逐条校验存在性、自引用和环路。
   * jumpAsset 为空表示解除跳板机。
   */
  async assignAssetJump(
    actorId: string,
    input: unknown,
    jumpAsset: string,
  ): Promise<{ updated: AssetView[]; failed: AssetBatchFailure[] }> {
    const actor = this.requireActor(actorId)
    if (!isOperator(actor)) throw new PlatformError('当前身份不能修改资产', 403, 'forbidden')
    const names = normalizeAssetNames(input)
    const jump = jumpAsset.trim()
    if (jump && !(await this.options.assets.get(jump))) {
      throw new PlatformError(`跳板机资产不存在：${jump}`, 400, 'bad_request')
    }
    const updated: AssetView[] = []
    const failed: AssetBatchFailure[] = []
    for (const name of names) {
      const asset = await this.options.assets.get(name)
      if (!asset) {
        failed.push({ name, error: '资产不存在' })
        continue
      }
      try {
        const record: AssetRecord = { ...asset, sshJumpAsset: jump || undefined }
        updated.push(toAssetView(await this.options.assets.upsert(record)))
        this.dropAssetProbe(name)
      } catch (error) {
        failed.push({ name, error: error instanceof Error ? error.message : '设置跳板机失败' })
      }
    }
    return { updated, failed }
  }

  /** 导出资产表；没有资产时导出的就是可直接填写的模板（xlsx Buffer）。 */
  async exportAssetsWorkbook(actorId: string): Promise<Buffer> {
    const actor = this.requireActor(actorId)
    if (!isOperator(actor)) throw new PlatformError('当前身份不能导出资产', 403, 'forbidden')
    const assets = await this.options.assets.list()
    const credentials = await this.options.credentials.list()
    const names = new Map(credentials.map((credential) => [credential.id, credential.name]))
    return buildAssetWorkbook(assets.map(toAssetView), names)
  }

  /**
   * 逐行导入资产：失败行记录原因后继续，绝不中断整批。
   * skip 跳过同名；overwrite 按行更新（保留主机密钥指纹和 SSH 只读路径）。
   */
  async importAssets(
    actorId: string,
    rows: AssetImportRow[],
    mode: 'skip' | 'overwrite',
  ): Promise<AssetImportResult> {
    const actor = this.requireActor(actorId)
    if (!isOperator(actor)) throw new PlatformError('当前身份不能导入资产', 403, 'forbidden')
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new PlatformError('表格里没有可导入的资产行', 400, 'bad_request')
    }
    if (rows.length > 2000) throw new PlatformError('单次最多导入 2000 行资产', 413, 'too_large')
    const overwrite = mode === 'overwrite'
    const credentials = await this.options.credentials.list()
    const credentialIdByName = new Map<string, string>()
    for (const credential of credentials) {
      if (!credentialIdByName.has(credential.name)) credentialIdByName.set(credential.name, credential.id)
    }
    const firstRowByName = new Map<string, number>()
    const entries: AssetImportResult['entries'] = []
    let imported = 0
    const fail = (row: AssetImportRow, error: string): void => {
      entries.push({ row: row.row, name: row.name, status: 'failed', error })
    }

    for (const row of rows) {
      const name = typeof row.name === 'string' ? row.name.trim() : ''
      if (row.error) {
        fail(row, row.error)
        continue
      }
      if (!name) {
        fail(row, '名称不能为空')
        continue
      }
      const seen = firstRowByName.get(name)
      if (seen !== undefined) {
        fail(row, `名称在文件中重复，第 ${seen} 行已出现`)
        continue
      }
      firstRowByName.set(name, row.row)

      const existing = await this.options.assets.get(name)
      if (existing && !overwrite) {
        fail(row, '同名资产已存在（当前为跳过模式，可勾选覆盖同名资产）')
        continue
      }

      const credentialName = row.credentialName?.trim() ?? ''
      let credentialId: string | undefined
      if (credentialName) {
        credentialId = credentialIdByName.get(credentialName)
        if (!credentialId) {
          fail(row, `凭证不存在：${credentialName}`)
          continue
        }
      }

      const jumpAsset = row.jumpAsset?.trim() ?? ''
      if (jumpAsset) {
        if (jumpAsset === name) {
          fail(row, '资产不能把自己作为跳板机')
          continue
        }
        if (!(await this.options.assets.get(jumpAsset))) {
          fail(row, `跳板机资产不存在：${jumpAsset}`)
          continue
        }
      }

      const record: AssetRecord = {
        name,
        host: row.host?.trim() || undefined,
        ip: row.ip?.trim() || undefined,
        env: row.env?.trim() || undefined,
        owner: row.owner?.trim() || undefined,
        tier: row.tier?.trim() || undefined,
        repo: row.repo?.trim() || undefined,
        note: row.note?.trim() || undefined,
        sshPort: row.sshPort,
        sshUser: row.sshUser?.trim() || undefined,
        sshCredentialId: credentialId,
        sshJumpAsset: jumpAsset || undefined,
        ...(existing?.sshHostKeyFingerprint ? { sshHostKeyFingerprint: existing.sshHostKeyFingerprint } : {}),
        ...(existing?.sshReadPaths?.length ? { sshReadPaths: [...existing.sshReadPaths] } : {}),
      }
      try {
        await this.options.assets.upsert(record)
        this.dropAssetProbe(name)
        imported += 1
        entries.push({ row: row.row, name, status: 'imported' })
      } catch (error) {
        fail(row, error instanceof Error ? error.message : '写入失败')
      }
    }

    return {
      total: rows.length,
      imported,
      failed: rows.length - imported,
      mode: overwrite ? 'overwrite' : 'skip',
      entries,
    }
  }

  /** 批量完整 SSH 测试（认证 + 跳板机 + 主机密钥），并发 4，避免一次压满网络。 */
  async testAssetsSsh(
    actorId: string,
    input: unknown,
  ): Promise<AssetBatchResult<Awaited<ReturnType<Platform['testAssetSsh']>>>[]> {
    const actor = this.requireActor(actorId)
    if (!isOperator(actor)) throw new PlatformError('当前身份不能测试资产连接', 403, 'forbidden')
    const names = normalizeAssetNames(input, 100)
    return mapLimit(names, 4, async (name) => {
      try {
        return { name, ok: true, result: await this.testAssetSsh(actorId, name) }
      } catch (error) {
        return { name, ok: false, error: error instanceof Error ? error.message : '连接失败' }
      }
    })
  }

  /** 批量主机密钥探测：只握手，不信任、不写数据。 */
  async probeAssetsHostKey(
    actorId: string,
    input: unknown,
  ): Promise<AssetBatchResult<Awaited<ReturnType<Platform['probeAssetHostKey']>>>[]> {
    const actor = this.requireActor(actorId)
    if (!isOperator(actor)) throw new PlatformError('当前身份不能探测资产', 403, 'forbidden')
    const names = normalizeAssetNames(input, 100)
    return mapLimit(names, 4, async (name) => {
      try {
        return { name, ok: true, result: await this.probeAssetHostKey(actorId, name) }
      } catch (error) {
        return { name, ok: false, error: error instanceof Error ? error.message : '主机密钥探测失败' }
      }
    })
  }

  /**
   * 批量信任主机密钥：admin 专用，只补没有指纹的资产，绝不覆盖已有指纹。
   * 每个资产都按当前配置重新探测，客户端不能提供指纹；已有指纹的资产一律跳过，
   * 指纹不一致的必须回到单资产接口带旧指纹确认。跳板机链路同样要求已信任。
   */
  async trustAssetHostKeysBatch(
    actorId: string,
    input: unknown,
  ): Promise<{ trusted: string[]; skipped: AssetBatchFailure[]; failed: AssetBatchFailure[] }> {
    const actor = this.requireActor(actorId)
    if (!actor.roles.includes('admin')) {
      throw new PlatformError('只有管理员可以信任 SSH 主机密钥', 403, 'forbidden')
    }
    const names = normalizeAssetNames(input, 100)
    const outcomes = await mapLimit(names, 4, async (name) => {
      const asset = await this.options.assets.get(name)
      if (!asset) return { name, kind: 'failed' as const, error: '资产不存在' }
      if (asset.sshHostKeyFingerprint) {
        return { name, kind: 'skipped' as const, error: '已有信任指纹，替换需要逐台确认' }
      }
      try {
        const jumps = await resolveJumpTargets(this.options.assets, this.options.credentials, asset)
        const probed = await probeHostKey(asset, 15_000, undefined, jumps)
        await this.options.assets.trustHostKey(name, probed.fingerprint)
        this.dropAssetProbe(name)
        return { name, kind: 'trusted' as const }
      } catch (error) {
        return { name, kind: 'failed' as const, error: error instanceof Error ? error.message : '主机密钥探测失败' }
      }
    })
    const trusted: string[] = []
    const skipped: AssetBatchFailure[] = []
    const failed: AssetBatchFailure[] = []
    for (const item of outcomes) {
      if (item.kind === 'trusted') trusted.push(item.name)
      else if (item.kind === 'skipped') skipped.push({ name: item.name, error: item.error })
      else failed.push({ name: item.name, error: item.error })
    }
    return { trusted, skipped, failed }
  }

  /**
   * 导入 known_hosts：只采用唯一匹配的指纹，绝不覆盖已信任的指纹。
   * 默认 dry-run（apply=false），只返回计划，不落盘。
   */
  async importKnownHosts(
    actorId: string,
    content: string,
    apply: boolean,
  ): Promise<{
    apply: boolean
    entries: number
    applied: string[]
    pending: string[]
    unchanged: string[]
    conflicts: Array<{ asset: string; current: string; offered: string }>
    ambiguous: Array<{ asset: string; fingerprints: string[] }>
    unmatched: string[]
    skipped: Array<{ line: number; reason: string }>
  }> {
    const actor = this.requireActor(actorId)
    if (!actor.roles.includes('admin')) {
      throw new PlatformError('只有管理员可以导入 known_hosts', 403, 'forbidden')
    }
    if (typeof content !== 'string' || !content.trim()) {
      throw new PlatformError('content 不能为空', 400, 'bad_request')
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_KNOWN_HOSTS_BYTES) {
      throw new PlatformError(`known_hosts 内容不能超过 ${MAX_KNOWN_HOSTS_BYTES / 1024}KB`, 413, 'too_large')
    }
    let parsed
    try {
      parsed = parseKnownHosts(content)
    } catch (error) {
      throw new PlatformError(error instanceof Error ? error.message : 'known_hosts 解析失败', 400, 'bad_request')
    }
    const result = {
      apply,
      entries: parsed.entries.length,
      applied: [] as string[],
      pending: [] as string[],
      unchanged: [] as string[],
      conflicts: [] as Array<{ asset: string; current: string; offered: string }>,
      ambiguous: [] as Array<{ asset: string; fingerprints: string[] }>,
      unmatched: [] as string[],
      skipped: parsed.skipped,
    }
    for (const asset of await this.options.assets.list()) {
      const match = matchAsset(parsed.entries, asset)
      if (!match) {
        result.unmatched.push(asset.name)
        continue
      }
      if (match.fingerprints.length > 1) {
        result.ambiguous.push({ asset: asset.name, fingerprints: match.fingerprints })
        continue
      }
      const offered = match.fingerprints[0]
      if (asset.sshHostKeyFingerprint) {
        if (asset.sshHostKeyFingerprint === offered) result.unchanged.push(asset.name)
        else result.conflicts.push({ asset: asset.name, current: asset.sshHostKeyFingerprint, offered })
        continue
      }
      if (!apply) {
        result.pending.push(asset.name)
        continue
      }
      await this.options.assets.trustHostKey(asset.name, offered)
      this.dropAssetProbe(asset.name)
      result.applied.push(asset.name)
    }
    return result
  }

  async deleteAsset(actorId: string, name: string): Promise<boolean> {
    const actor = this.requireActor(actorId)
    if (!isOperator(actor)) {
      throw new PlatformError('当前身份不能修改资产', 403, 'forbidden')
    }
    try {
      const removed = await this.options.assets.remove(name)
      if (removed) this.dropAssetProbe(name)
      return removed
    } catch (error) {
      throw new PlatformError(error instanceof Error ? error.message : '资产删除失败', 409, 'conflict')
    }
  }

  /** 只探测主机密钥，不认证、不执行命令；operator 及以上可用。 */
  async probeAssetHostKey(
    actorId: string,
    name: string,
  ): Promise<{ fingerprint: string; trusted: boolean; expected?: string }> {
    const actor = this.requireActor(actorId)
    if (!isOperator(actor)) throw new PlatformError('当前身份不能探测资产', 403, 'forbidden')
    const asset = await this.options.assets.get(name)
    if (!asset) throw new PlatformError('资产不存在', 404, 'not_found')
    try {
      const jumps = await resolveJumpTargets(this.options.assets, this.options.credentials, asset)
      const result = await probeHostKey(asset, 15_000, undefined, jumps)
      return { ...result, ...(asset.sshHostKeyFingerprint ? { expected: asset.sshHostKeyFingerprint } : {}) }
    } catch (error) {
      throw new PlatformError(error instanceof Error ? error.message : '主机密钥探测失败', 502, 'ssh_unreachable')
    }
  }

  /**
   * 实际登录一次资产（含认证和跳板机），不执行命令，只验证凭据和连通性。
   * operator 及以上可用；主机密钥未信任或没有可用凭证时会报错。
   */
  async testAssetSsh(
    actorId: string,
    name: string,
  ): Promise<{ ok: true; host: string; port: number; user: string; hostKeyFingerprint?: string; jumps?: string[]; latencyMs: number }> {
    const actor = this.requireActor(actorId)
    if (!isOperator(actor)) throw new PlatformError('当前身份不能测试资产连接', 403, 'forbidden')
    const asset = await this.options.assets.get(name)
    if (!asset) throw new PlatformError('资产不存在', 404, 'not_found')
    const started = Date.now()
    try {
      const result = await testAssetConnection(this.options.assets, this.options.credentials, name)
      const latencyMs = Date.now() - started
      const probe = result as { host: string; port: number }
      // 手动测试也刷新状态列，页面上「测试连接」成功后不必等下一轮后台探测。
      this.assetProbes.set(name, {
        name,
        status: 'up',
        checkedAt: new Date().toISOString(),
        target: `${probe.host}:${probe.port}`,
        latencyMs,
      })
      return { ...(result as { ok: true; host: string; port: number; user: string; hostKeyFingerprint?: string; jumps?: string[] }), latencyMs }
    } catch (error) {
      const message = describeSshConnectError(error)
      const blocked = await assetSshBlockedReason(asset, this.options.credentials)
      this.assetProbes.set(name, {
        name,
        status: blocked ? 'unknown' : 'down',
        checkedAt: new Date().toISOString(),
        ...(blocked ? { error: blocked, blockedReason: blocked } : { error: message }),
      })
      throw new PlatformError(message, 502, 'ssh_unreachable')
    }
  }

  /**
   * 信任主机密钥：admin 才能操作；会再探测一次，提供的指纹必须与当前主机一致。
   * 替换已有指纹时必须带 previousFingerprint，避免旧页面静默覆盖。
   */
  async trustAssetHostKey(
    actorId: string,
    name: string,
    fingerprint: string,
    previousFingerprint?: string,
  ): Promise<AssetView> {
    const actor = this.requireActor(actorId)
    if (!actor.roles.includes('admin')) {
      throw new PlatformError('只有管理员可以信任 SSH 主机密钥', 403, 'forbidden')
    }
    const asset = await this.options.assets.get(name)
    if (!asset) throw new PlatformError('资产不存在', 404, 'not_found')
    let normalized: string
    try {
      normalized = normalizeFingerprint(fingerprint)
    } catch (error) {
      throw new PlatformError((error as Error).message, 400, 'bad_request')
    }
    let probed: { fingerprint: string }
    try {
      const jumps = await resolveJumpTargets(this.options.assets, this.options.credentials, asset)
      probed = await probeHostKey(asset, 15_000, undefined, jumps)
    } catch (error) {
      throw new PlatformError(error instanceof Error ? error.message : '主机密钥探测失败', 502, 'ssh_unreachable')
    }
    if (probed.fingerprint !== normalized) {
      throw new PlatformError(
        `主机当前返回的指纹是 ${probed.fingerprint}，与提交的 ${normalized} 不一致，请重新校验`,
        409,
        'conflict',
      )
    }
    try {
      const trusted = toAssetView(await this.options.assets.trustHostKey(name, normalized, previousFingerprint))
      this.dropAssetProbe(name)
      if (asset.sshHostKeyFingerprint && asset.sshHostKeyFingerprint !== normalized) {
        this.notify(
          'asset.host_key_changed',
          'SSH 主机密钥已更换',
          `资产 ${name} 的 SSH 主机密钥指纹发生变化，已由管理员重新信任。`,
          `${name}:${normalized}`,
          {
            asset: name,
            ...(asset.host ? { host: asset.host } : {}),
            fingerprint: normalized,
            previousFingerprint: asset.sshHostKeyFingerprint,
          },
        )
        this.audit('asset_host_key_changed', {
          asset: name,
          fingerprint: normalized,
          previousFingerprint: asset.sshHostKeyFingerprint,
        })
      }
      return trusted
    } catch (error) {
      throw new PlatformError((error as Error).message, 409, 'conflict')
    }
  }

  async listMcpServers(actorId: string): Promise<McpServerView[]> {
    const actor = this.requireActor(actorId)
    if (!isOperator(actor)) {
      throw new PlatformError('当前身份不能管理 MCP 连接', 403, 'forbidden')
    }
    return (await this.options.mcpStore.list()).map(mcpServerView)
  }

  async saveMcpServers(actorId: string, input: unknown): Promise<McpServerView[]> {
    const actor = this.requireActor(actorId)
    if (!isOperator(actor)) {
      throw new PlatformError('当前身份不能管理 MCP 连接', 403, 'forbidden')
    }
    let normalized: McpServerConfig[]
    try {
      normalized = await this.options.mcpStore.resolve(input)
    } catch (error) {
      throw new PlatformError(error instanceof Error ? error.message : 'MCP 配置不合法', 400, 'bad_request')
    }
    // 连接配置和风险配置拆开授权：operator 能加/改连接，但 readOnly/mutateTools 只有 admin 能改，
    // 否则可以把写权限 server 标成只读，绕过变更审批。
    if (!isAdmin(actor)) {
      const before = await this.options.mcpStore.list()
      if (mcpRiskConfigChanged(before, normalized)) {
        throw new PlatformError('只有 admin 能修改 MCP 风险配置（readOnly/mutateTools）', 403, 'forbidden')
      }
    }
    // 先按新配置探测上游：探测失败就不落盘，保持旧配置和旧工具可用。
    let built: BuildToolsResult | undefined
    if (this.options.rebuildTools) {
      try {
        built = await this.options.rebuildTools(normalized, false)
      } catch (error) {
        throw new PlatformError(
          `MCP 配置未保存：${error instanceof Error ? error.message : '上游初始化失败'}`,
          502,
          'mcp_unreachable',
        )
      }
    }
    try {
      const saved = await this.options.mcpStore.replaceValidated(normalized)
      if (built) this.applyTools(built)
      return saved.map(mcpServerView)
    } catch (error) {
      throw new PlatformError(error instanceof Error ? error.message : 'MCP 配置保存失败', 400, 'bad_request')
    }
  }

  listMcpErrors(actorId: string): McpServerError[] {
    this.requireActor(actorId)
    return this.mcpErrors
  }

  /** K8s readiness：能查库就算就绪；失败不抛错，由 /ready 返回 503。 */
  async probeReady(): Promise<boolean> {
    try {
      await this.store.countTasksByStatus()
      return true
    } catch {
      return false
    }
  }

  /** 优雅退出：关闭上游 MCP session 和数据库连接池；出错只记录，不阻塞退出。 */
  async close(): Promise<void> {
    const closers = [
      this.disposeTools,
      ...[...this.health.values()].map((state) => state.close),
    ].filter((close): close is () => Promise<void> => typeof close === 'function')
    await Promise.allSettled(closers.map((close) => close()))
    this.disposeTools = undefined
    this.health.clear()
    await this.store.close()
  }

  /** /metrics 的只读快照：聚合查询在存储层完成，不按用户可见性过滤。 */
  async metricsSnapshot(): Promise<MetricsSnapshot> {
    const [tasks, approvals] = await Promise.all([
      this.store.countTasksByStatus(),
      this.store.countApprovalsByStatus(),
    ])
    const tools: Record<string, number> = { read: 0, mutate: 0 }
    for (const tool of this.options.tools) {
      const risk = tool.risk === 'mutate' ? 'mutate' : 'read'
      tools[risk] = (tools[risk] ?? 0) + 1
    }
    return {
      tasks,
      approvals,
      tools,
      mcp: this.healthList().map((server) => ({
        name: server.name,
        ok: server.ok,
        failures: server.failures,
        ...(server.reviewRequired ? { reviewRequired: true } : {}),
      })),
    }
  }

  /**
   * 首页总览。任务计数走和列表相同的可见性过滤；知识和 MCP 只有 operator 及以上可见。
   * 知识文档读取失败只影响这一块，不能让整个首页 500。
   */
  async overview(actorId: string): Promise<PlatformOverview> {
    const actor = this.requireActor(actorId)
    const operator = isOperator(actor)
    const visibility = this.taskVisibility(actor)
    const [byStatus, recentTasks, pendingApprovals, assets, knowledgeDocuments, mcpServers] = await Promise.all([
      this.store.countTasksByStatus(visibility),
      this.store.queryTasks({ ...visibility, limit: 5 }),
      this.listApprovalsPage(actor.id, 'pending', undefined, { limit: 3 }),
      this.options.assets.list(),
      operator
        ? (async () => {
            try {
              return (await this.knowledgeManager().listDocuments()).length
            } catch {
              return null
            }
          })()
        : Promise.resolve(null),
      operator ? this.options.mcpStore.list().catch(() => null) : Promise.resolve(null),
    ])
    const tools = { total: this.options.tools.length, read: 0, mutate: 0, mcp: 0 }
    for (const tool of this.options.tools) {
      if (tool.risk === 'mutate') tools.mutate += 1
      else tools.read += 1
      if (tool.name.startsWith('mcp.')) tools.mcp += 1
    }
    const health = new Map(this.healthList().map((server) => [server.name, server]))
    const mcp = mcpServers
      ? mcpServers.reduce(
          (summary, server) => {
            const state = health.get(server.name)
            summary.servers += 1
            if (!state) summary.unchecked += 1
            else if (state.ok) summary.ok += 1
            else summary.unhealthy += 1
            if (state?.reviewRequired) summary.reviewRequired += 1
            return summary
          },
          { servers: 0, ok: 0, unhealthy: 0, reviewRequired: 0, unchecked: 0 },
        )
      : null
    return {
      generatedAt: new Date().toISOString(),
      tasks: {
        total: Object.values(byStatus).reduce((sum, count) => sum + count, 0),
        byStatus,
        recent: recentTasks.items.map((task) => structuredClone(task)),
      },
      approvals: {
        pending: pendingApprovals.total,
        recent: pendingApprovals.approvals.map((approval) => structuredClone(approval)),
      },
      knowledge: knowledgeDocuments === null ? null : { documents: knowledgeDocuments },
      mcp,
      tools,
      assets: {
        total: assets.length,
        untrusted: assets.filter((asset) => !asset.sshHostKeyFingerprint).length,
      },
    }
  }

  async listMcpHealth(actorId: string): Promise<McpServerHealth[]> {
    const actor = this.requireActor(actorId)
    if (!isOperator(actor)) {
      throw new PlatformError('当前身份不能查看 MCP 健康状态', 403, 'forbidden')
    }
    return this.healthList()
  }

  /** 网页手动触发一次巡检；后台定时器不经过身份校验。 */
  async runMcpHealthCheck(actorId: string): Promise<McpServerHealth[]> {
    const actor = this.requireActor(actorId)
    if (!isOperator(actor)) {
      throw new PlatformError('当前身份不能执行 MCP 健康检测', 403, 'forbidden')
    }
    return this.checkMcpHealth()
  }

  /**
   * 巡检每个已配置的 MCP server：成功则对比工具签名，有变化或此前失败时热替换该 server 的工具；
   * 连续失败达到阈值时摘除该 server 的工具并记入 mcpErrors。恢复后下一次巡检自动注册回来。
   */
  async checkMcpHealth(): Promise<McpServerHealth[]> {
    if (!this.options.buildServerTools || this.healthRunning) return this.healthList()
    this.healthRunning = true
    const generation = this.toolsGeneration
    try {
      const servers = await this.options.mcpStore.list()
      const configured = new Set(servers.map((server) => server.name))
      for (const [name, state] of [...this.health]) {
        if (configured.has(name)) continue
        scheduleClose(state.close)
        this.health.delete(name)
      }
      for (const server of servers) {
        if (generation !== this.toolsGeneration) break
        const checkedAt = new Date().toISOString()
        const previous = this.health.get(server.name)
        try {
          const built = await this.options.buildServerTools(server)
          const signature = toolSignature(built.tools)
          const registered = this.options.tools.filter((tool) => tool.name.startsWith(`mcp.${server.name}.`))
          // 启动时没有巡检状态，但工具已由整轮 build 注册；签名一致就不必替换。
          const current = toolSignature(registered)
          const unchanged = previous?.ok ? previous.signature === signature : current === signature
          // 首次探测只建立基线；之后上游工具集变化就标记为待复核，直到有人确认。
          const baselineTools = previous?.baselineTools ?? registered
          let reviewRequired = previous?.reviewRequired ?? false
          let changedTools = previous?.changedTools
          if (previous?.signature !== undefined && previous.signature !== signature) {
            reviewRequired = true
            changedTools = diffServerTools(baselineTools, built.tools)
          }
          // 上游改回基线（比如临时加的工具又撤了）时没有可复核项，自动清标记。
          if (reviewRequired && !hasToolChanges(changedTools)) {
            reviewRequired = false
            changedTools = undefined
          }
          const baseState = {
            name: server.name,
            ok: true,
            failures: 0,
            checkedAt,
            signature,
            baselineTools,
            ...(reviewRequired ? { reviewRequired, changedTools } : {}),
          }
          if (!unchanged) {
            this.replaceServerTools(server.name, built.tools)
            scheduleClose(previous?.close)
            this.health.set(server.name, { ...baseState, close: built.close })
          } else {
            // 工具没变化：探测建立的 session 立即关掉，继续用现有工具。
            void built.close?.().catch(() => undefined)
            this.health.set(server.name, { ...baseState, close: previous?.close })
          }
          if (previous && !previous.ok) {
            this.notify('mcp.recovered', '上游 MCP 已恢复', `server ${server.name} 恢复可用，工具已重新注册。`, server.name, {
              server: server.name,
            })
            this.audit('mcp_recovered', { server: server.name })
          }
          if (reviewRequired && !previous?.reviewRequired) {
            const changes = changedTools ?? { added: [], removed: [], updated: [] }
            this.notify(
              'mcp.tools_changed',
              '上游 MCP 工具集发生变化',
              `server ${server.name} 的工具集已变化，需要人工复核后再信任。`,
              server.name,
              {
                server: server.name,
                added: changes.added.length,
                removed: changes.removed.length,
                updated: changes.updated.length,
              },
            )
            this.audit('mcp_tools_changed', {
              server: server.name,
              added: changes.added,
              removed: changes.removed,
              updated: changes.updated,
            })
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : '探测失败'
          const failures = (previous?.failures ?? 0) + 1
          const ok = failures < MCP_HEALTH_FAILURE_THRESHOLD
          if (!ok) this.replaceServerTools(server.name, [])
          this.health.set(server.name, {
            name: server.name,
            ok,
            failures,
            error: message,
            checkedAt,
            signature: previous?.signature,
            baselineTools: previous?.baselineTools,
            ...(previous?.reviewRequired ? { reviewRequired: true, changedTools: previous.changedTools } : {}),
            close: previous?.close,
          })
          if (!ok && previous?.ok) {
            this.notify(
              'mcp.unhealthy',
              '上游 MCP 不可用',
              `server ${server.name} 连续探测失败，工具已摘除：${message}`,
              server.name,
              { server: server.name, failures },
            )
            this.audit('mcp_unhealthy', { server: server.name, failures, error: message })
          }
        }
      }
      if (generation === this.toolsGeneration) this.syncMcpErrors()
      return this.healthList()
    } finally {
      this.healthRunning = false
    }
  }

  /**
   * 人工确认「上游工具集变化已复核」：把当前工具集设为新基线并清掉待复核标记。
   * 只清状态，不改风险分类；确认人应该已经看过 changedTools 并调整 readOnly/mutateTools。
   */
  async reviewMcpServer(actorId: string, name: string): Promise<McpServerHealth[]> {
    const actor = this.requireActor(actorId)
    if (!isOperator(actor)) {
      throw new PlatformError('当前身份不能复核 MCP 工具集', 403, 'forbidden')
    }
    const state = this.health.get(name)
    if (!state) throw new PlatformError('未知 MCP server', 404, 'not_found')
    if (!state.ok) throw new PlatformError('MCP server 当前异常，恢复后再复核', 409, 'mcp_unhealthy')
    const tools = this.options.tools.filter((tool) => tool.name.startsWith(`mcp.${name}.`))
    state.baselineTools = tools
    state.reviewRequired = false
    delete state.changedTools
    return this.healthList()
  }

  private healthList(): McpServerHealth[] {
    return [...this.health.values()].map((state) => ({
      name: state.name,
      ok: state.ok,
      failures: state.failures,
      ...(state.error ? { error: state.error } : {}),
      ...(state.checkedAt ? { checkedAt: state.checkedAt } : {}),
      ...(state.reviewRequired ? { reviewRequired: true, changedTools: state.changedTools } : {}),
    }))
  }

  /** 按 `mcp.<server>.` 前缀替换某个上游 server 的工具，保留直连工具和其他 server 的工具。 */
  private replaceServerTools(name: string, tools: Tool[]): void {
    const prefix = `mcp.${name}.`
    const incoming = new Set(tools.map((tool) => tool.name))
    for (const key of [...this.toolBaseRisk.keys()]) {
      if (key.startsWith(prefix) && !incoming.has(key)) this.toolBaseRisk.delete(key)
    }
    for (const tool of tools) this.toolBaseRisk.set(tool.name, tool.risk)
    const adjusted = this.applyPolicies(tools)
    const next = [...this.options.tools.filter((tool) => !tool.name.startsWith(prefix)), ...adjusted]
    this.options.tools = next
    this.broker.replaceTools(next)
  }

  private async ensurePolicies(): Promise<void> {
    if (this.policiesLoaded || !this.options.toolPolicies) return
    this.policies = await this.options.toolPolicies.list()
    this.policiesLoaded = true
  }

  /** 原始风险 + 当前生效的人工策略；签名不匹配视为策略失效。 */
  private riskOf(tool: Tool): ToolRisk {
    const base = this.toolBaseRisk.get(tool.name) ?? tool.risk
    const policy = this.policies[tool.name]
    if (!policy || policy.signature !== toolPolicySignature(tool)) return base
    return policy.risk
  }

  private applyPolicies(tools: Tool[]): Tool[] {
    return tools.map((tool) => {
      const risk = this.riskOf(tool)
      return risk === tool.risk ? tool : { ...tool, risk }
    })
  }

  private refreshToolRisks(): void {
    const next = this.applyPolicies(this.options.tools)
    this.options.tools = next
    this.broker.replaceTools(next)
  }

  private toolPolicyViews(): ToolPolicyView[] {
    return Object.entries(this.policies)
      .map(([tool, policy]) => {
        const current = this.options.tools.find((item) => item.name === tool)
        const active = Boolean(current && policy.signature === toolPolicySignature(current))
        return {
          tool,
          ...policy,
          ...(current ? { baseRisk: this.toolBaseRisk.get(tool) ?? current.risk } : {}),
          stale: Boolean(current) && !active,
          missing: !current,
          active,
        }
      })
      .sort((a, b) => a.tool.localeCompare(b.tool))
  }

  private syncMcpErrors(): void {
    this.mcpErrors = [...this.health.values()]
      .filter((state) => !state.ok)
      .map((state) => ({ name: state.name, message: state.error ?? '探测失败' }))
  }

  async listCredentials(actorId: string): Promise<CredentialView[]> {
    const actor = this.requireActor(actorId)
    if (!isOperator(actor)) {
      throw new PlatformError('当前身份不能管理凭证', 403, 'forbidden')
    }
    return (await this.options.credentials.list()).map(toCredentialView)
  }

  async saveCredential(actorId: string, input: CredentialInput): Promise<CredentialView> {
    const actor = this.requireActor(actorId)
    if (!isOperator(actor)) {
      throw new PlatformError('当前身份不能管理凭证', 403, 'forbidden')
    }
    try {
      return toCredentialView(await this.options.credentials.upsert(input))
    } catch (error) {
      throw new PlatformError(error instanceof Error ? error.message : '凭证保存失败', 400, 'bad_request')
    }
  }

  async deleteCredential(actorId: string, id: string): Promise<boolean> {
    const actor = this.requireActor(actorId)
    if (!isOperator(actor)) {
      throw new PlatformError('当前身份不能管理凭证', 403, 'forbidden')
    }
    const used = (await this.options.assets.list()).some((asset) => asset.sshCredentialId === id)
    if (used) throw new PlatformError('凭证正在被资产使用，先改掉资产再删除', 409, 'conflict')
    return this.options.credentials.remove(id)
  }

  async searchKnowledge(actorId: string, query: string, topK: number): Promise<KnowledgeHit[]> {
    this.requireActor(actorId)
    if (!query.trim()) throw new PlatformError('query 不能为空', 400, 'bad_request')
    if (!Number.isInteger(topK) || topK < 1 || topK > 20) {
      throw new PlatformError('top_k 必须是 1 到 20 的整数', 400, 'bad_request')
    }
    try {
      return await this.options.knowledge.search(query.trim(), topK, actorId)
    } catch (error) {
      throw new PlatformError(error instanceof Error ? error.message : '知识库失败', 502, 'knowledge_error')
    }
  }

  async getDocument(actorId: string, docId: string): Promise<KnowledgeDocument> {
    this.requireActor(actorId)
    if (!docId.trim()) throw new PlatformError('doc_id 不能为空', 400, 'bad_request')
    try {
      return await this.options.knowledge.getDocument(docId.trim(), actorId)
    } catch (error) {
      const message = error instanceof Error ? error.message : '知识库失败'
      if (message === '文档不存在') throw new PlatformError(message, 404, 'not_found')
      throw new PlatformError(message, 502, 'knowledge_error')
    }
  }

  async listKnowledgeDocuments(actorId: string): Promise<KnowledgeDocumentRecord[]> {
    const actor = this.requireActor(actorId)
    if (!isOperator(actor)) {
      throw new PlatformError('当前身份不能管理知识文档', 403, 'forbidden')
    }
    return this.knowledgeManager().listDocuments()
  }

  async saveKnowledgeDocument(actorId: string, input: KnowledgeDocumentInput): Promise<void> {
    const actor = this.requireActor(actorId)
    if (!isOperator(actor)) {
      throw new PlatformError('当前身份不能修改知识文档', 403, 'forbidden')
    }
    try {
      await this.knowledgeManager().saveDocument(input)
    } catch (error) {
      throw new PlatformError(error instanceof Error ? error.message : '文档保存失败', 400, 'bad_request')
    }
  }

  async deleteKnowledgeDocument(actorId: string, id: string): Promise<boolean> {
    const actor = this.requireActor(actorId)
    if (!isOperator(actor)) {
      throw new PlatformError('当前身份不能修改知识文档', 403, 'forbidden')
    }
    try {
      return await this.knowledgeManager().deleteDocument(id)
    } catch (error) {
      throw new PlatformError(error instanceof Error ? error.message : '文档删除失败', 400, 'bad_request')
    }
  }

  /** 连接变更后的重建：上游 MCP 暂时不可达不阻断连接保存，只记录错误。 */
  private async reloadTools(): Promise<void> {
    if (!this.options.rebuildTools) return
    try {
      const built = await this.options.rebuildTools(undefined, true)
      this.applyTools(built)
    } catch (error) {
      throw new PlatformError(
        `配置已保存，但工具重建失败: ${error instanceof Error ? error.message : '未知错误'}`,
        502,
        'reload_failed',
      )
    }
  }

  private applyTools(built: BuildToolsResult): void {
    const previous = this.disposeTools
    const previousHealth = new Map(this.health)
    const previousTools = new Map<string, Tool[]>()
    for (const name of previousHealth.keys()) {
      previousTools.set(name, this.options.tools.filter((tool) => tool.name.startsWith(`mcp.${name}.`)))
    }
    this.toolsGeneration += 1
    const currentNames = new Set(built.tools.map((tool) => tool.name))
    for (const key of [...this.toolBaseRisk.keys()]) {
      if (!currentNames.has(key)) this.toolBaseRisk.delete(key)
    }
    for (const tool of built.tools) this.toolBaseRisk.set(tool.name, tool.risk)
    const tools = this.applyPolicies(built.tools)
    this.options.tools = tools
    this.broker.replaceTools(tools)
    this.mcpErrors = built.mcpErrors ?? []
    this.disposeTools = built.dispose
    // 整体重建后，巡检期间建立的 per-server session 也不再被引用。
    for (const state of this.health.values()) scheduleClose(state.close)
    this.health.clear()
    for (const error of this.mcpErrors) {
      const before = previousHealth.get(error.name)
      this.health.set(error.name, {
        name: error.name,
        ok: false,
        error: error.message,
        failures: MCP_HEALTH_FAILURE_THRESHOLD,
        ...(before?.baselineTools ? { baselineTools: before.baselineTools } : {}),
        ...(before?.reviewRequired ? { reviewRequired: true, changedTools: before.changedTools } : {}),
      })
    }
    // 连接变更也会整体重建工具；不要把还没确认的「工具集变化」复核状态冲掉。
    for (const [name, before] of previousHealth) {
      if (this.health.has(name)) continue
      const tools = built.tools.filter((tool) => tool.name.startsWith(`mcp.${name}.`))
      if (tools.length === 0) continue
      const signature = toolSignature(tools)
      const baselineTools = before.baselineTools ?? previousTools.get(name) ?? tools
      let changedTools = before.reviewRequired ? before.changedTools : undefined
      if (before.signature !== undefined && before.signature !== signature) {
        changedTools = diffServerTools(baselineTools, tools)
      }
      const reviewRequired = hasToolChanges(changedTools)
      this.health.set(name, {
        name,
        ok: true,
        failures: 0,
        checkedAt: new Date().toISOString(),
        signature,
        baselineTools,
        ...(reviewRequired ? { reviewRequired: true, changedTools } : {}),
      })
    }
    // 等正在执行的上游调用结束后再关旧 session。
    scheduleClose(previous)
  }

  private knowledgeManager(): KnowledgeManager {
    const provider = this.options.knowledge
    if (typeof (provider as Partial<KnowledgeManager>).listDocuments !== 'function') {
      throw new PlatformError('当前知识库不支持页面管理', 409, 'conflict')
    }
    return provider as KnowledgeProvider & KnowledgeManager
  }

  async executeTool(input: {
    actorId: string
    tool: string
    args: Record<string, unknown>
    taskId?: string
    approvalId?: string
    signal?: AbortSignal
  }): Promise<ToolOutcome> {
    const actor = this.requireActor(input.actorId)
    let taskId = input.taskId
    let ownerId = actor.id
    let task: Task | undefined
    if (taskId) {
      task = await this.store.getTask(taskId)
      if (!task) throw new PlatformError('任务不存在', 404, 'not_found')
      if (TERMINAL.has(task.status)) throw new PlatformError('任务已经结束', 409, 'conflict')
      if (task.status === 'awaiting_approval' && !input.approvalId) {
        throw new PlatformError('任务在等待审批，先处理审批', 409, 'conflict')
      }
      ownerId = task.ownerId
      if (actor.id !== task.ownerId && !isApprover(actor)) {
        throw new PlatformError('不能操作别人的任务', 403, 'forbidden')
      }
      await this.emit(task, 'tool.called', {
        tool: input.tool,
        args: redact(input.args),
        ...(input.approvalId ? { approvalId: input.approvalId } : {}),
      })
    } else {
      taskId = `adhoc:${actor.id}`
    }
    const outcome = await this.broker.execute({
      actorId: actor.id,
      ownerId,
      taskId,
      tool: input.tool,
      args: input.args,
      approvalId: input.approvalId,
      signal: input.signal,
    })
    if (outcome.status === 'awaiting_approval' && outcome.approvalId) {
      this.notifyApprovalPending(outcome.approvalId, input.tool, taskId, ownerId)
    }
    if (task) {
      if (outcome.status === 'awaiting_approval') {
        task.status = 'awaiting_approval'
        await this.emit(task, 'approval.required', {
          approvalId: outcome.approvalId,
          tool: input.tool,
          auditId: outcome.auditId,
        })
      } else {
        // 审批已经有结果（批准后执行失败或拒绝重试），任务不再停在等待审批。
        if (task.status === 'awaiting_approval') task.status = 'running'
        if (outcome.status === 'ok') {
          await this.emit(task, 'tool.result', {
            tool: input.tool,
            ...(input.approvalId ? { approvalId: input.approvalId } : {}),
            auditId: outcome.auditId,
            result: outcome.result,
          })
        } else if (outcome.status === 'denied') {
          await this.emit(task, 'tool.result', {
            tool: input.tool,
            ...(input.approvalId ? { approvalId: input.approvalId } : {}),
            status: outcome.status,
            error: outcome.reason,
            auditId: outcome.auditId,
          })
        } else {
          await this.emit(task, 'tool.result', {
            tool: input.tool,
            ...(input.approvalId ? { approvalId: input.approvalId } : {}),
            status: outcome.status,
            error: outcome.error,
            auditId: outcome.auditId,
          })
        }
      }
    }
    return outcome
  }

  /** 审批通过后由 DSH 触发继续执行；审批本身不直接碰集群。 */
  async resumeApproval(actorId: string, approvalId: string): Promise<ToolOutcome> {
    const actor = this.requireActor(actorId)
    const approval = await this.store.getApproval(approvalId)
    if (!approval) throw new PlatformError('审批不存在', 404, 'not_found')
    if (approval.status !== 'approved') throw new PlatformError('审批尚未通过', 409, 'conflict')
    if (approval.consumed) throw new PlatformError('审批已使用', 409, 'conflict')
    if (actor.id !== approval.ownerId && !isApprover(actor)) {
      throw new PlatformError('当前身份不能继续执行这个审批', 403, 'forbidden')
    }
    const taskId = approval.taskId.startsWith('adhoc:') ? undefined : approval.taskId
    return this.executeTool({
      actorId: approval.requestedBy,
      tool: approval.tool,
      args: approval.args,
      taskId,
      approvalId: approval.id,
    })
  }

  async waitUntil(taskId: string, predicate: (task: Task) => boolean, timeoutMs = 3000): Promise<Task> {
    const start = Date.now()
    for (;;) {
      const task = await this.store.getTask(taskId)
      if (task && predicate(task)) return structuredClone(task)
      if (Date.now() - start > timeoutMs) throw new Error(`等待任务超时: ${taskId}`)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  private async resolveModel(selection: ModelSelection): Promise<ResolvedModel | undefined> {
    if (this.options.modelResolver) return this.options.modelResolver.resolve(selection)
    if (this.options.model) {
      return {
        model: this.options.model,
        provider: selection.provider ?? 'env',
        modelName: selection.model ?? 'default',
      }
    }
    return undefined
  }

  private async run(
    task: Task,
    skill: Skill,
    controller: AbortController,
    selection: ModelSelection = {},
  ): Promise<void> {
    const signal = controller.signal
    try {
      if (halted(task, signal)) return
      task.status = 'running'
      const resolved = await this.resolveModel(selection)
      // 告警是任意内容的自动排查，固定 playbook 不适用；没有模型就别占用队列。
      if (task.origin === 'alert' && !resolved) {
        throw new Error('告警排查需要先配置可用的模型 provider')
      }
      const mode = resolved ? 'agent' : 'playbook'
      await this.emit(task, 'task.started', {
        sessionId: task.sessionId,
        skill: skill.name,
        mode,
        ...(resolved ? { provider: resolved.provider, model: resolved.modelName } : {}),
      })
      await this.emit(task, 'skill.selected', { skill: skill.name, description: skill.description })
      const result = resolved
        ? await this.runAgent(task, skill, resolved, signal)
        : await this.runPlaybook(task, skill, signal)
      if (halted(task, signal)) return
      task.result = result
      task.status = 'succeeded'
      await this.emit(task, 'task.completed', { result: task.result })
      if (task.origin === 'alert') void this.notifyAlertResult(task)
    } catch (error) {
      if (halted(task, signal)) {
        if (task.status !== 'cancelled') {
          task.status = 'cancelled'
          await this.emit(task, 'task.cancelled', {})
        }
        return
      }
      task.status = 'failed'
      task.error = error instanceof Error ? error.message : '任务失败'
      await this.emit(task, 'task.failed', { error: task.error })
      this.notifyTaskFailed(task)
      if (task.origin === 'alert') void this.notifyAlertResult(task)
    } finally {
      this.controllers.delete(task.id)
      if (task.origin === 'alert') this.alertActive = Math.max(0, this.alertActive - 1)
    }
  }

  /** 原有固定 playbook：按 step 调工具，失败即终止。 */
  private async runPlaybook(task: Task, skill: Skill, signal: AbortSignal): Promise<string> {
    const findings: string[] = []
    for (const step of skill.steps) {
      if (halted(task, signal)) return ''
      if (!stepMatches(step, task.prompt)) continue
      const args = renderArgs(step.args, task.prompt)
      const outcome = await this.executeTaskTool(task, step.tool, args, signal)
      if (halted(task, signal)) return ''
      if (outcome.status !== 'ok') throw new Error(outcomeText(outcome))
      findings.push(...describeResult(step.tool, outcome.result))
    }
    return findings.join('\n') || '没有新的发现'
  }

  /**
   * 模型驱动的临时任务：最多 N 轮工具调用，变更工具同样走 ToolBroker 和审批。
   * 审批通过后本地 runner 自己续跑，不依赖 decideApproval 的自动执行分支。
   */
  private async runAgent(
    task: Task,
    skill: Skill,
    resolved: ResolvedModel,
    signal: AbortSignal,
  ): Promise<string> {
    const model = resolved.model
    const definitions: ChatTool[] = []
    const byModelName = new Map<string, Tool>()
    const used = new Set<string>()
    for (const tool of this.options.tools) {
      // 告警任务永远只读：变更工具连模型定义都不暴露，执行层还会再拦一次。
      if (task.origin === 'alert' && this.riskOf(tool) !== 'read') continue
      const name = modelToolName(tool.name, used)
      byModelName.set(name, tool)
      definitions.push({
        type: 'function',
        function: {
          name,
          description: `${tool.description}${tool.risk === 'mutate' ? '（变更工具：调用会进入人工审批；只读查询优先用专用只读工具）' : ''}`.slice(0, 1500),
          parameters: tool.parameters,
        },
      })
    }
    const maxSteps = clampInteger(this.options.agentMaxSteps ?? 8, 1, 50)
    const outputLimit = clampInteger(this.options.agentToolOutputChars ?? 12_000, 500, 100_000)
    const messages: ChatMessage[] = [
      { role: 'system', content: agentSystemPrompt(skill) },
      { role: 'user', content: task.prompt },
    ]
    const usage: TaskUsage = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 }
    const priced = resolved.inputCostPer1M !== undefined && resolved.outputCostPer1M !== undefined
    let cost = 0
    let deltaBuffer = ''
    let deltaChain: Promise<void> = Promise.resolve()
    let lastDeltaAt = Date.now()
    const flushDelta = () => {
      if (!deltaBuffer) return
      const text = deltaBuffer
      deltaBuffer = ''
      deltaChain = deltaChain
        .then(() => this.emitEventOnly(task, 'model.delta', { text }))
        .catch(() => undefined)
    }
    const onDelta = (text: string) => {
      deltaBuffer += text
      if (Date.now() - lastDeltaAt >= 500) {
        lastDeltaAt = Date.now()
        flushDelta()
      }
    }
    const onRetry = (info: { attempt: number; delayMs: number; message: string }) => {
      deltaChain = deltaChain
        .then(() => this.emitEventOnly(task, 'model.retry', info))
        .catch(() => undefined)
    }
    let lastContent = ''
    for (let step = 1; step <= maxSteps; step += 1) {
      if (halted(task, signal)) return ''
      const completion = await model.complete({ messages, tools: definitions, signal, onDelta, onRetry })
      if (halted(task, signal)) return ''
      flushDelta()
      await deltaChain
      const toolCalls = completion.toolCalls
      lastContent = completion.content.trim()
      usage.calls += 1
      if (completion.usage) {
        usage.promptTokens += completion.usage.promptTokens
        usage.completionTokens += completion.usage.completionTokens
        usage.totalTokens += completion.usage.totalTokens
        if (priced) {
          cost +=
            (completion.usage.promptTokens / 1_000_000) * resolved.inputCostPer1M! +
            (completion.usage.completionTokens / 1_000_000) * resolved.outputCostPer1M!
        }
      }
      task.usage = {
        ...usage,
        ...(priced ? { cost: roundCost(cost), currency: resolved.currency ?? 'USD' } : {}),
      }
      messages.push({
        role: 'assistant',
        content: completion.content,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      })
      await this.emit(task, 'model.step', {
        step,
        tools: toolCalls.map((call) => byModelName.get(call.function.name)?.name ?? call.function.name),
        ...(completion.usage
          ? {
              promptTokens: completion.usage.promptTokens,
              completionTokens: completion.usage.completionTokens,
              totalTokens: completion.usage.totalTokens,
              ...(priced ? { cost: roundCost(cost), currency: resolved.currency ?? 'USD' } : {}),
            }
          : {}),
      })
      if (toolCalls.length === 0) {
        if (!lastContent) throw new Error('模型没有返回结论')
        return lastContent
      }
      for (const call of toolCalls) {
        if (halted(task, signal)) return ''
        const tool = byModelName.get(call.function.name)
        if (!tool) {
          messages.push({ role: 'tool', tool_call_id: call.id, content: `错误：未知工具 ${call.function.name}` })
          continue
        }
        let args: Record<string, unknown>
        try {
          args = parseToolArgs(call.function.arguments)
        } catch (error) {
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: `错误：${error instanceof Error ? error.message : '工具参数不合法'}`,
          })
          continue
        }
        const outcome = await this.executeTaskTool(task, tool.name, args, signal)
        if (halted(task, signal)) return ''
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: formatOutcomeForModel(outcome, outputLimit),
        })
      }
    }
    throw new Error(
      `模型达到最大步骤 ${maxSteps}，任务未完成${lastContent ? `：${lastContent.slice(0, 200)}` : ''}`,
    )
  }

  /**
   * playbook 和模型 runner 共用：执行一次工具，处理审批等待、审批后重试和事件。
   * 返回最终结果；审批被拒绝时返回 denied，由调用方决定终止还是交给模型继续。
   */
  private async executeTaskTool(
    task: Task,
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ToolOutcome> {
    if (task.origin === 'alert') {
      const definition = this.options.tools.find((item) => item.name === tool)
      if (!definition || this.riskOf(definition) !== 'read') {
        throw new PlatformError('告警任务只允许调用只读工具', 403, 'forbidden')
      }
    }
    await this.emit(task, 'tool.called', { tool, args: redact(args) })
    let outcome = await this.broker.execute({
      actorId: task.ownerId,
      ownerId: task.ownerId,
      taskId: task.id,
      tool,
      args,
      signal,
    })
    if (outcome.status === 'awaiting_approval') {
      const approvalId = outcome.approvalId
      task.status = 'awaiting_approval'
      await this.emit(task, 'approval.required', {
        approvalId,
        tool,
        auditId: outcome.auditId,
      })
      this.notifyApprovalPending(approvalId, tool, task.id, task.ownerId)
      const decision = await this.gate.wait(
        approvalId,
        () => this.store.getApproval(approvalId),
        signal,
      )
      if (halted(task, signal)) {
        return { status: 'denied', reason: '任务已取消', auditId: outcome.auditId }
      }
      if (decision.status !== 'approved') {
        task.status = 'running'
        const reason = decision.comment?.trim() || '审批被拒绝'
        await this.emit(task, 'tool.result', {
          tool,
          approvalId: decision.id,
          status: 'denied',
          error: reason,
          auditId: outcome.auditId,
        })
        return { status: 'denied', reason, auditId: outcome.auditId }
      }
      outcome = await this.broker.execute({
        actorId: task.ownerId,
        ownerId: task.ownerId,
        taskId: task.id,
        tool,
        args,
        approvalId: decision.id,
        signal,
      })
      task.status = 'running'
    } else if (task.status === 'awaiting_approval') {
      task.status = 'running'
    }
    if (outcome.status === 'ok') {
      await this.emit(task, 'tool.result', { tool, auditId: outcome.auditId, result: outcome.result })
    } else if (outcome.status === 'denied') {
      await this.emit(task, 'tool.result', {
        tool,
        status: outcome.status,
        error: outcome.reason,
        auditId: outcome.auditId,
      })
    } else if (outcome.status === 'error') {
      await this.emit(task, 'tool.result', {
        tool,
        status: outcome.status,
        error: outcome.error,
        auditId: outcome.auditId,
      })
    }
    return outcome
  }

  /** 通知和审计回调可能来自外部实现，任何异常都不能影响任务/审批主流程。 */
  private notify(
    type: NotificationType,
    title: string,
    text: string,
    dedupeKey: string,
    detail?: Record<string, string | number | boolean>,
  ): void {
    if (!this.options.notify) return
    try {
      this.options.notify({ type, title, text, dedupeKey, ...(detail ? { detail } : {}), at: new Date().toISOString() })
    } catch {
      // 通知是旁路，失败不影响主流程。
    }
  }

  private securityEvent(type: string, detail: Record<string, unknown>): void {
    if (!this.options.securityEvent) return
    try {
      this.options.securityEvent(type, detail)
    } catch {
      // 安全事件是旁路，失败不影响任务。
    }
  }

  private audit(action: string, detail: Record<string, unknown>): void {
    if (!this.options.audit) return
    try {
      this.options.audit(action, detail)
    } catch {
      // 审计旁路失败不影响巡检。
    }
  }

  private notifyApprovalPending(approvalId: string, tool: string, taskId: string, ownerId: string): void {
    this.notify('approval.pending', '有新的变更待审批', `工具 ${tool} 正在等待人工审批。`, approvalId, {
      approvalId,
      tool,
      taskId,
      ownerId,
    })
  }

  private notifyTaskFailed(task: Task): void {
    const error = task.error ?? '未知错误'
    this.notify('task.failed', `任务失败：${task.title}`, `任务 ${task.id} 执行失败：${error.slice(0, 300)}`, task.id, {
      taskId: task.id,
      skill: task.skill,
      error: error.slice(0, 300),
    })
  }

  /** 告警结果定向推送到接入源勾选的渠道；没有勾选就只留在任务页。 */
  private async notifyAlertResult(task: Task): Promise<void> {
    if (!this.options.notifyTargets || !this.options.alertSources || !task.alertSourceId) return
    let source: AlertSource | undefined
    try {
      source = await this.options.alertSources.get(task.alertSourceId)
    } catch {
      return
    }
    if (!source || source.notifyWebhookIds.length === 0) return
    const ok = task.status === 'succeeded'
    const name = task.title.replace(/^告警排查：/, '')
    const text = ok
      ? `只读排查，未执行任何变更。\n\n${(task.result ?? '').slice(0, 3_500)}`
      : `告警排查失败：${(task.error ?? '未知错误').slice(0, 500)}`
    const publicUrl = (this.options.publicUrl ?? '').replace(/\/+$/, '')
    let pending: void | Promise<DeliveredNotification[]>
    try {
      pending = this.options.notifyTargets(source.notifyWebhookIds, {
        type: 'alert.investigated',
        title: `${ok ? '告警排查完成' : '告警排查失败'}：${name}`,
        text,
        dedupeKey: task.id,
        detail: { taskId: task.id, skill: task.skill, source: source.name },
        ...(publicUrl ? { link: `${publicUrl}/#/tasks/${encodeURIComponent(task.id)}` } : {}),
        at: new Date().toISOString(),
      })
    } catch (error) {
      void this.emitEventOnly(task, 'alert.notify', {
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined)
      return
    }
    // 通知是旁路：只在任务里补一条投递结果事件，不阻塞任务状态，也不把失败抛回 runner。
    if (pending && typeof pending.then === 'function') {
      void pending
        .then((deliveries) =>
          this.emitEventOnly(task, 'alert.notify', {
            webhooks: deliveries.map(({ webhook, ok: delivered, error }) => ({
              webhook,
              ok: delivered,
              ...(error ? { error } : {}),
            })),
          }),
        )
        .catch((error) =>
          this.emitEventOnly(task, 'alert.notify', {
            error: error instanceof Error ? error.message : String(error),
          }),
        )
        .catch(() => undefined)
    }
  }

  private async emit(task: Task, type: string, data: unknown): Promise<void> {
    await this.emitWith(this.store, task, type, data)
  }

  /** 高频事件（流式增量）只写事件，不反复保存任务。 */
  private async emitEventOnly(task: Task, type: string, data: unknown): Promise<void> {
    task.updatedAt = new Date().toISOString()
    await this.store.appendEvent({ id: nid('evt'), taskId: task.id, type, at: task.updatedAt, data })
  }

  private async emitWith(store: StoreTx, task: Task, type: string, data: unknown): Promise<void> {
    task.updatedAt = new Date().toISOString()
    await store.appendEvent({ id: nid('evt'), taskId: task.id, type, at: task.updatedAt, data })
    await store.saveTask(task)
  }
}
