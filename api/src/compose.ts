import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { HttpKnowledgeProvider, LocalKnowledgeProvider, type KnowledgeProvider } from '../../extensions/knowledge/src/index.ts'
import { AlertSourceStore } from './alert-sources.ts'
import { AssetStore } from './assets.ts'
import { createAssetTools } from './asset-tools.ts'
import { CredentialStore } from './credentials.ts'
import { McpServerStore, validateMcpServers } from './mcp-servers.ts'
import { MySqlStore, type MySqlConfig } from './mysql-store.ts'
import type { Store } from './store.ts'
import { createSshTools } from './ssh-tools.ts'
import { createUpstreamMcpTools, type McpServerConfig } from '../../extensions/ops-tools/src/index.ts'
import { AuthService } from './auth.ts'
import { isAuthStore } from './auth-store.ts'
import { createKnowledgeTools } from './knowledge-tools.ts'
import { log } from './log.ts'
import { OpenAiCompatibleModel, type ChatModel } from './model.ts'
import { ModelProviderStore, ModelRegistry } from './model-providers.ts'
import { approvalDeepLink, NotificationStore, Notifier, type NotificationEvent } from './notifications.ts'
import { Platform, type BuildToolsResult } from './platform.ts'
import { SecretBox, type SecretCodec } from './secret-box.ts'
import { loadSkills } from './skills.ts'
import { ToolPolicyStore } from './tool-policies.ts'
import type { Actor, Role } from './types.ts'

export interface RunningConfig {
  platform: Platform
  host: string
  port: number
  internalToken: string
  auth?: AuthService
  allowActorHeader: boolean
  secureCookies: boolean
  modelProviders: ModelProviderStore
  models: ModelRegistry
  notifications: NotificationStore
  notifier: Notifier
}

export async function compose(
  configPath: string,
  options: { store?: Store; mcpServers?: McpServerConfig[] } = {},
): Promise<RunningConfig> {
  const parsed: unknown = JSON.parse(await readFile(configPath, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('配置文件必须是对象')
  const config = parsed as Record<string, unknown>
  // K8s 用 Secret 注入 AIOPS_INTERNAL_TOKEN；配置文件里的值只作为本地兜底。
  const internalToken =
    process.env.AIOPS_INTERNAL_TOKEN?.trim() || text(config.internalToken, 'internalToken')
  const actors = parseActors(config.actors)
  const knowledge = await buildKnowledge(config.knowledge)
  const skills = await loadSkills(resolvePath(text(config.skillsDir, 'skillsDir')))
  // 编码密钥只用于 data/ 下的敏感字段；环境变量优先，否则读/生成 data/secret.key。
  const secretBox = await SecretBox.open({
    ...(process.env.AIOPS_SECRET_KEY ? { envKey: process.env.AIOPS_SECRET_KEY } : {}),
    keyFile: resolvePath(process.env.AIOPS_SECRET_KEY_FILE ?? 'data/secret.key'),
  })
  const mcpStore = new McpServerStore(
    options.mcpServers ? null : resolvePath(optionalText(config.mcpServersFile) ?? 'data/mcp-servers.json'),
    options.mcpServers ?? validateMcpServers(config.mcpServers),
    secretBox,
  )
  // 逐工具审批策略是用户运行数据；文件损坏必须阻断启动，不能静默清空管理员设置。
  const toolPolicies = new ToolPolicyStore(
    resolvePath(process.env.AIOPS_TOOL_POLICIES_FILE ?? 'data/tool-policies.json'),
  )
  // 告警接入源是用户运行数据（含 token 的 SHA-256）；文件损坏必须阻断启动，不能静默清空。
  const alertSources = new AlertSourceStore(
    resolvePath(process.env.AIOPS_ALERT_SOURCES_FILE ?? 'data/alert-sources.json'),
  )
  await alertSources.list()
  const assets = new AssetStore(
    resolvePath(optionalText(config.assetsFile) ?? 'data/assets.json'),
    undefined,
    secretBox,
  )
  const credentials = new CredentialStore(
    resolvePath(optionalText(config.credentialsFile) ?? 'data/credentials.json'),
    secretBox,
  )
  // 启动时触发一次加载，把旧明文敏感字段就地迁移成密文；解密失败直接启动失败，不清空数据。
  await assets.list()
  await credentials.list()
  const baseTools = [
    ...createKnowledgeTools(knowledge),
    ...createAssetTools(assets),
    ...createSshTools(assets, credentials),
  ]
  const buildTools = async (
    mcpServers?: McpServerConfig[],
    tolerateFailures = true,
  ): Promise<BuildToolsResult> => {
    const upstream = await createUpstreamMcpTools({
      servers: mcpServers ?? (await mcpStore.list()),
      tolerateFailures,
    })
    return {
      tools: [...baseTools, ...upstream.tools],
      mcpErrors: upstream.errors,
      dispose: upstream.close,
    }
  }
  const buildServerTools = async (server: McpServerConfig) => {
    const upstream = await createUpstreamMcpTools({ servers: [server] })
    return { tools: upstream.tools, close: upstream.close }
  }
  const startup = await buildTools()
  const store = options.store ?? (await createMySqlStore(config))
  const auth = await buildAuth(store, actors)
  const approvalTtlMs = Number(process.env.AIOPS_APPROVAL_TTL_MS ?? 24 * 60 * 60 * 1000)
  const modelProviders = new ModelProviderStore(
    resolvePath(process.env.AIOPS_MODEL_PROVIDERS_FILE ?? 'data/model-providers.json'),
    secretBox,
  )
  // 启动时加载一次，校验并迁移旧明文 apiKey；解析失败直接启动失败，不清空文件。
  await modelProviders.list()
  const agent = buildAgentModel(config.model)
  // 模型 provider 模式下 buildAgentModel 提前返回空对象，步骤和输出上限要靠环境变量兜底，
  // 否则 Platform 会退回硬编码的 8 步。
  const agentLimits = resolveAgentLimits(agent)
  const models = new ModelRegistry(
    modelProviders,
    agent.model
      ? {
          model: agent.model,
          provider: 'env',
          modelName: agent.name ?? 'default',
          ...(agent.inputCostPer1M !== undefined ? { inputCostPer1M: agent.inputCostPer1M } : {}),
          ...(agent.outputCostPer1M !== undefined ? { outputCostPer1M: agent.outputCostPer1M } : {}),
          ...(agent.currency ? { currency: agent.currency } : {}),
        }
      : undefined,
  )
  const notifications = new NotificationStore(
    resolvePath(process.env.AIOPS_NOTIFICATIONS_FILE ?? 'data/notifications.json'),
    secretBox,
  )
  // 启动时加载一次，校验并迁移旧明文 webhook URL；解析失败直接启动失败，不清空文件。
  await notifications.list()
  const notifier = new Notifier(notifications)
  // 通知里的深链必须是审批人浏览器能访问的地址；反代/公网部署时用 AIOPS_PUBLIC_URL 覆盖。
  const publicUrl = (
    process.env.AIOPS_PUBLIC_URL?.trim() || `http://127.0.0.1:${Number(process.env.AIOPS_PORT || config.port || 8787)}`
  ).replace(/\/+$/, '')
  const notify = (event: NotificationEvent) => {
    const approvalId = event.detail?.approvalId
    notifier.notify(
      typeof approvalId === 'string' && approvalId
        ? { ...event, link: approvalDeepLink(publicUrl, approvalId) }
        : event,
    )
  }
  const audit = (action: string, detail: Record<string, unknown>) => {
    if (!auth.service) return
    void auth.service
      .recordConfigEvent(`config.${action}`, { source: 'mcp-health', ...detail })
      .catch((error) => log.warn('后台状态审计写入失败', { action, error }))
  }
  // 任务级特权操作（如 admin 代重试）写入 security_events；detail 只放任务号和身份，不放 prompt。
  const securityEvent = (type: string, detail: Record<string, unknown>) => {
    if (!auth.service) return
    void auth.service
      .recordConfigEvent(type, detail)
      .catch((error) => log.warn('任务安全事件写入失败', { type, error }))
  }
  // 告警结果只推回接入源显式选中的通知渠道；由 Platform 记录投递结果，失败不影响任务结果。
  const notifyTargets = (webhookIds: string[], event: NotificationEvent) =>
    notifier.sendTo(webhookIds, event)
  const alertMaxConcurrency = Number(process.env.AIOPS_ALERT_MAX_CONCURRENCY ?? 3)
  // 多实例部署时每个副本设置唯一值（K8s 可用 POD_NAME），启动回收只处理本实例的任务。
  const instanceId = process.env.AIOPS_INSTANCE_ID?.trim() || undefined
  const approvalPollMs = Number(process.env.AIOPS_APPROVAL_POLL_MS ?? 2000)
  // 默认禁止自批；只有显式设置 AIOPS_ALLOW_ADMIN_SELF_APPROVAL=1 才允许 admin 自批。
  const allowAdminSelfApproval = process.env.AIOPS_ALLOW_ADMIN_SELF_APPROVAL === '1'
  const platform = new Platform({
    actors: auth.actors,
    skills,
    tools: startup.tools,
    knowledge,
    mcpStore,
    assets,
    credentials,
    store,
    rebuildTools: buildTools,
    buildServerTools,
    mcpErrors: startup.mcpErrors,
    toolPolicies,
    alertSources,
    publicUrl,
    notifyTargets,
    ...(Number.isFinite(alertMaxConcurrency) ? { alertMaxConcurrency } : {}),
    ...(Number.isFinite(approvalTtlMs) ? { approvalTtlMs } : {}),
    ...(instanceId ? { instanceId } : {}),
    ...(Number.isFinite(approvalPollMs) ? { approvalPollMs } : {}),
    allowAdminSelfApproval,
    ...(process.env.AIOPS_MODEL_DISABLE === '1' ? {} : { modelResolver: models }),
    ...(agentLimits.maxSteps !== undefined ? { agentMaxSteps: agentLimits.maxSteps } : {}),
    ...(agentLimits.toolOutputChars !== undefined ? { agentToolOutputChars: agentLimits.toolOutputChars } : {}),
    notify,
    audit,
    securityEvent,
  })
  await platform.loadToolPolicies()
  await platform.recoverInterruptedTasks()
  // 后台任务在多实例下用 MySQL 咨询锁串行化；拿不到锁就直接跳过，不排队。
  const exclusive = async (name: string, fn: () => Promise<unknown>) => {
    await store.withAdvisoryLock(name, fn)
  }
  // 挂起审批过期：启动先跑一次，之后每分钟一次；AIOPS_APPROVAL_TTL_MS=0 关闭。
  if (Number.isFinite(approvalTtlMs) && approvalTtlMs > 0) {
    void exclusive('aiops:approval-expiry', () => platform.expireApprovals()).catch((error) =>
      log.error('审批过期检查失败', { error }),
    )
    const timer = setInterval(() => {
      void exclusive('aiops:approval-expiry', () => platform.expireApprovals()).catch((error) =>
        log.error('审批过期检查失败', { error }),
      )
    }, 60_000)
    timer.unref?.()
  }
  // 外部会话兜底收尾：客户端断开时进程内空闲计时器会丢，按最后活动时间补一次；
  // 阈值取空闲结束时间的 2 倍（默认 240 秒），每 30 秒扫一次，多实例用咨询锁串行。
  const idleFinishMs = Number(process.env.AIOPS_IDLE_FINISH_MS ?? 120_000)
  const staleIdleMs = Number.isFinite(idleFinishMs) && idleFinishMs > 0 ? Math.max(idleFinishMs * 2, 60_000) : 240_000
  const reapStale = () =>
    exclusive('aiops:stale-task-reap', () => platform.reapStaleExternalTasks(new Date(), staleIdleMs)).catch((error) =>
      log.error('外部任务兜底收尾失败', { error }),
    )
  void reapStale()
  const reapTimer = setInterval(() => {
    void reapStale()
  }, 30_000)
  reapTimer.unref?.()
  // 保留期清理：默认任务 30 天、安全事件 90 天、API key 30 天，每 6 小时一次；设 0 关闭对应清理。
  const taskRetentionDays = Number(process.env.AIOPS_TASK_RETENTION_DAYS ?? 30)
  const eventRetentionDays = Number(process.env.AIOPS_EVENT_RETENTION_DAYS ?? 90)
  const apiKeyRetentionDays = Number(process.env.AIOPS_API_KEY_RETENTION_DAYS ?? 30)
  const apiKeyRemindDays = Number(process.env.AIOPS_API_KEY_REMIND_DAYS ?? 7)
  // 提醒只在进程内去重；多实例由咨询锁保证同一轮只有一个实例发送。
  const remindedKeys = new Set<string>()
  const cleanup = async () => {
    if (Number.isFinite(taskRetentionDays) && taskRetentionDays > 0) {
      await platform.cleanupTasks(new Date(Date.now() - taskRetentionDays * 86_400_000).toISOString())
    }
    if (!auth.service) return
    if (Number.isFinite(eventRetentionDays) && eventRetentionDays > 0) {
      await auth.service.cleanupSecurityEvents(new Date(Date.now() - eventRetentionDays * 86_400_000).toISOString())
    }
    await auth.service.cleanupSessions()
    await auth.service.cleanupLoginFailures()
    if (Number.isFinite(apiKeyRetentionDays) && apiKeyRetentionDays > 0) {
      await auth.service.cleanupApiKeys(new Date(Date.now() - apiKeyRetentionDays * 86_400_000).toISOString())
    }
    if (Number.isFinite(apiKeyRemindDays) && apiKeyRemindDays > 0) {
      const usernames = new Map((await auth.service.listUsers()).map((user) => [user.id, user.username]))
      for (const key of await auth.service.expiringApiKeys(apiKeyRemindDays)) {
        if (remindedKeys.has(key.id)) continue
        remindedKeys.add(key.id)
        notify({
          type: 'api_key.expiring',
          title: 'API key 即将过期',
          text: `用户 ${usernames.get(key.userId) ?? key.userId} 的 API key「${key.name}」将在 ${key.expiresAt} 过期，请轮换或重新签发。`,
          dedupeKey: `api_key.expiring:${key.id}`,
          detail: {
            keyId: key.id,
            keyName: key.name,
            username: usernames.get(key.userId) ?? key.userId,
            expiresAt: key.expiresAt ?? '',
          },
        })
      }
    }
  }
  void exclusive('aiops:retention-cleanup', cleanup).catch((error) => log.error('保留期清理失败', { error }))
  const cleanupTimer = setInterval(() => {
    void exclusive('aiops:retention-cleanup', cleanup).catch((error) => log.error('保留期清理失败', { error }))
  }, 6 * 60 * 60 * 1000)
  cleanupTimer.unref?.()
  // 后台巡检：默认 30 秒一次；AIOPS_MCP_HEALTH_MS=0 可关闭。
  const healthIntervalMs = Number(process.env.AIOPS_MCP_HEALTH_MS ?? 30_000)
  if (Number.isFinite(healthIntervalMs) && healthIntervalMs > 0) {
    void platform.checkMcpHealth().catch(() => undefined)
    const timer = setInterval(() => {
      void platform.checkMcpHealth().catch(() => undefined)
    }, healthIntervalMs)
    timer.unref?.()
  }
  const host = process.env.AIOPS_HOST || text(config.host ?? '127.0.0.1', 'host')
  const port = Number(process.env.AIOPS_PORT || config.port || 8787)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port 不合法')
  return {
    platform,
    host,
    port,
    internalToken,
    ...(auth.service ? { auth: auth.service } : {}),
    allowActorHeader: process.env.AIOPS_ALLOW_ACTOR_HEADER === '1',
    secureCookies: process.env.AIOPS_COOKIE_SECURE === '1',
    modelProviders,
    models,
    notifications,
    notifier,
  }
}

/**
 * AIOPS_AUTH=local 时启用账号认证：用户从 MySQL 读取，空库时可用
 * AIOPS_ADMIN_USERNAME / AIOPS_ADMIN_PASSWORD 建第一个管理员。
 * 不设置时保持原来的 x-actor-id 本机模式。
 */
async function buildAuth(
  store: Store,
  fallbackActors: Actor[],
): Promise<{ actors: Actor[]; service?: AuthService }> {
  if (process.env.AIOPS_AUTH !== 'local') return { actors: fallbackActors }
  if (!isAuthStore(store)) throw new Error('AIOPS_AUTH=local 需要 MySQL 认证存储')
  const service = new AuthService(store, {
    ...(process.env.AIOPS_SESSION_IDLE_MS ? { sessionIdleMs: Number(process.env.AIOPS_SESSION_IDLE_MS) } : {}),
    ...(process.env.AIOPS_SESSION_ABSOLUTE_MS ? { sessionAbsoluteMs: Number(process.env.AIOPS_SESSION_ABSOLUTE_MS) } : {}),
    ...(process.env.AIOPS_LOGIN_MAX_FAILURES ? { maxLoginFailures: Number(process.env.AIOPS_LOGIN_MAX_FAILURES) } : {}),
  })
  let users = await service.listUsers()
  if (users.length === 0) {
    const password = process.env.AIOPS_ADMIN_PASSWORD
    if (!password) {
      log.warn('没有本地用户，无法登录账号模式；请设置 AIOPS_ADMIN_USERNAME / AIOPS_ADMIN_PASSWORD 后重启')
    } else {
      await service.createUser({
        username: process.env.AIOPS_ADMIN_USERNAME ?? 'admin',
        displayName: 'Administrator',
        password,
        roles: ['admin', 'operator', 'approver'],
        mustChangePassword: true,
      })
      users = await service.listUsers()
    }
  }
  return {
    service,
    actors: users
      .filter((user) => user.status === 'active')
      .map((user) => ({ id: user.id, name: user.displayName, roles: [...user.roles] })),
  }
}

async function createMySqlStore(config: Record<string, unknown>): Promise<Store> {
  const database = isRecord(config.database) ? config.database : {}
  const host = process.env.AIOPS_DB_HOST ?? text(database.host ?? '127.0.0.1', 'database.host')
  const port = Number(process.env.AIOPS_DB_PORT ?? database.port ?? 3306)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('database.port 不合法')
  const user = process.env.AIOPS_DB_USER ?? text(database.user, 'database.user')
  const password = process.env.AIOPS_DB_PASSWORD ?? text(database.password, 'database.password')
  const name = process.env.AIOPS_DB_NAME ?? text(database.database, 'database.database')
  const store = new MySqlStore({ host, port, user, password, database: name })
  // 容器编排里 MySQL 往往比平台晚就绪；有限重试，超时才退出，避免容器反复重启。
  const timeoutMs = Number(process.env.AIOPS_DB_CONNECT_TIMEOUT_MS ?? 60_000)
  const retryMs = Number(process.env.AIOPS_DB_RETRY_MS ?? 1_000)
  const deadline = Date.now() + (Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : 60_000)
  for (;;) {
    try {
      await store.init()
      return store
    } catch (error) {
      if (Date.now() >= deadline) {
        await store.close().catch(() => undefined)
        throw error
      }
      log.warn('MySQL 未就绪，稍后重试', {
        host,
        port,
        database: name,
        error: error instanceof Error ? error.message : String(error),
      })
      await new Promise((resolve) => setTimeout(resolve, Number.isFinite(retryMs) && retryMs > 0 ? retryMs : 1000))
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 平台任务执行器是可选的：配置了 OpenAI 兼容端点就走模型循环，否则维持 playbook。
 * API key 只从环境变量读，避免明文进 config；AIOPS_MODEL_DISABLE=1 可强制关闭。
 */
function buildAgentModel(value: unknown): {
  model?: ChatModel
  name?: string
  maxSteps?: number
  toolOutputChars?: number
  inputCostPer1M?: number
  outputCostPer1M?: number
  currency?: string
} {
  if (process.env.AIOPS_MODEL_DISABLE === '1') return {}
  const raw = isRecord(value) ? value : undefined
  if (value !== undefined && !raw) throw new Error('model 配置必须是对象')
  const baseUrl = process.env.AIOPS_MODEL_BASE_URL ?? optionalText(raw?.baseUrl)
  const name = process.env.AIOPS_MODEL_NAME ?? optionalText(raw?.name)
  if (!baseUrl && !name) return {}
  if (!baseUrl || !name) {
    throw new Error('model 配置不完整：baseUrl 和 name 必须同时设置')
  }
  const keyEnv = process.env.AIOPS_MODEL_API_KEY_ENV ?? optionalText(raw?.apiKeyEnv) ?? 'AIOPS_MODEL_API_KEY'
  const apiKey = process.env[keyEnv]
  if (!apiKey) {
    log.warn('平台任务执行器缺少模型 API key，将不带 Authorization 调用端点', { keyEnv })
  }
  const timeoutMs = Number(process.env.AIOPS_MODEL_TIMEOUT_MS ?? raw?.timeoutMs ?? 120_000)
  const maxTokens = Number(process.env.AIOPS_MODEL_MAX_TOKENS ?? raw?.maxTokens ?? 4096)
  const temperature = Number(process.env.AIOPS_MODEL_TEMPERATURE ?? raw?.temperature ?? 0.2)
  const maxSteps = Number(process.env.AIOPS_MODEL_MAX_STEPS ?? raw?.maxSteps ?? 8)
  const toolOutputChars = Number(
    process.env.AIOPS_MODEL_TOOL_OUTPUT_CHARS ?? raw?.toolOutputChars ?? 12_000,
  )
  const stream = process.env.AIOPS_MODEL_STREAM !== '0' && raw?.stream !== false
  const maxRetries = Number(process.env.AIOPS_MODEL_MAX_RETRIES ?? raw?.maxRetries ?? 2)
  const retryBackoffMs = Number(process.env.AIOPS_MODEL_RETRY_BACKOFF_MS ?? raw?.retryBackoffMs ?? 500)
  const inputCostPer1M = optionalCost(process.env.AIOPS_MODEL_INPUT_COST_PER_1M ?? raw?.inputCostPer1M)
  const outputCostPer1M = optionalCost(process.env.AIOPS_MODEL_OUTPUT_COST_PER_1M ?? raw?.outputCostPer1M)
  const currency = process.env.AIOPS_MODEL_CURRENCY ?? optionalText(raw?.currency)
  return {
    model: new OpenAiCompatibleModel({
      baseUrl,
      model: name,
      ...(apiKey ? { apiKey } : {}),
      ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {}),
      ...(Number.isFinite(maxTokens) && maxTokens > 0 ? { maxTokens } : {}),
      ...(Number.isFinite(temperature) ? { temperature } : {}),
      stream,
      ...(Number.isFinite(maxRetries) && maxRetries >= 0 ? { maxRetries } : {}),
      ...(Number.isFinite(retryBackoffMs) && retryBackoffMs >= 0 ? { retryBackoffMs } : {}),
    }),
    name,
    ...(Number.isFinite(maxSteps) ? { maxSteps } : {}),
    ...(Number.isFinite(toolOutputChars) ? { toolOutputChars } : {}),
    ...(inputCostPer1M !== undefined ? { inputCostPer1M } : {}),
    ...(outputCostPer1M !== undefined ? { outputCostPer1M } : {}),
    ...(currency ? { currency } : {}),
  }
}

/**
 * 平台任务的步骤上限和工具输出截断：优先用模型配置里的值，其次用环境变量。
 * provider 模式没有 `model` 配置，环境变量是唯一来源。
 */
export function resolveAgentLimits(
  agent: { maxSteps?: number; toolOutputChars?: number },
  env: NodeJS.ProcessEnv = process.env,
): { maxSteps?: number; toolOutputChars?: number } {
  const maxSteps = agent.maxSteps ?? optionalPositiveInt(env.AIOPS_MODEL_MAX_STEPS)
  const toolOutputChars = agent.toolOutputChars ?? optionalPositiveInt(env.AIOPS_MODEL_TOOL_OUTPUT_CHARS)
  return {
    ...(maxSteps !== undefined ? { maxSteps } : {}),
    ...(toolOutputChars !== undefined ? { toolOutputChars } : {}),
  }
}

function optionalPositiveInt(value: string | undefined): number | undefined {
  if (value === undefined || !value.trim()) return undefined
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : undefined
}

function optionalCost(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : undefined
  return number !== undefined && Number.isFinite(number) && number >= 0 ? number : undefined
}

async function buildKnowledge(value: unknown): Promise<KnowledgeProvider> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('knowledge 配置不合法')
  const knowledge = value as Record<string, unknown>
  const provider = text(knowledge.provider, 'knowledge.provider')
  if (provider === 'local') {
    const root = resolvePath(text(knowledge.root, 'knowledge.root'))
    const seed = optionalText(knowledge.seed)
    if (seed) await seedKnowledge(root, resolvePath(seed))
    return new LocalKnowledgeProvider(root)
  }
  if (provider !== 'ragflow' && provider !== 'dify' && provider !== 'generic') {
    throw new Error(`不支持的知识库 provider: ${provider}`)
  }
  return new HttpKnowledgeProvider({
    kind: provider,
    baseUrl: text(knowledge.baseUrl, 'knowledge.baseUrl'),
    apiKey: optionalText(knowledge.apiKey),
    datasetId: optionalText(knowledge.datasetId),
  })
}

async function seedKnowledge(root: string, seed: string): Promise<void> {
  await mkdir(root, { recursive: true })
  const existing = await readdir(root)
  if (existing.some((name) => name.endsWith('.md'))) return
  try {
    for (const name of await readdir(seed)) {
      if (!name.endsWith('.md')) continue
      await copyFile(path.join(seed, name), path.join(root, name))
    }
  } catch {
    // seed 目录不存在时允许从空知识库开始。
  }
}

function parseActors(value: unknown): Actor[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('actors 不能为空')
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('actor 不合法')
    const actor = item as Record<string, unknown>
    const roles = Array.isArray(actor.roles)
      ? actor.roles.filter((role): role is Role =>
          role === 'viewer' || role === 'operator' || role === 'approver' || role === 'auditor' || role === 'admin')
      : []
    if (roles.length === 0) throw new Error(`actor ${String(actor.id)} 缺少角色`)
    return { id: text(actor.id, 'actor.id'), name: text(actor.name, 'actor.name'), roles }
  })
}

function resolvePath(value: string): string {
  return path.resolve(process.cwd(), value)
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 不能为空`)
  return value.trim()
}

function optionalText(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim()) return undefined
  return value.trim()
}
