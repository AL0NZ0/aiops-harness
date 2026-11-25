import { timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import { createServer as createHttpsServer } from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AuthError, AuthService, hashToken, toPublicUser, type ApiKeyView } from './auth.ts'
import type { ApiKeyRecord, ApiScope, SessionRecord, UserRecord } from './auth-store.ts'
import { PlatformError } from './errors.ts'
import { log } from './log.ts'
import { createMcpEndpoint, type McpEndpoint } from './mcp-http.ts'
import { incCounter, renderMetrics } from './metrics.ts'
import { FixedWindowLimiter, rateLimitConfig, type RateLimitConfig } from './rate-limit.ts'
import type { ModelProviderStore, ModelRegistry } from './model-providers.ts'
import { NOTIFICATION_TYPES, type NotificationStore, type Notifier } from './notifications.ts'
import type { Platform } from './platform.ts'
import type { Role, TaskEvent } from './types.ts'

interface ServerOptions {
  internalToken: string
  /** 启用后使用账号/会话/API key 认证；不传则保持 x-actor-id 本机模式。 */
  auth?: AuthService
  /** 有 auth 时默认关闭 header 认证；测试或本机开发可显式打开。 */
  allowActorHeader?: boolean
  secureCookies?: boolean
  /** 模型 provider 配置；不传时模型配置接口返回空列表。 */
  modelProviders?: ModelProviderStore
  models?: ModelRegistry
  /** 通知配置；不传时通知配置接口返回空数据。 */
  notifications?: NotificationStore
  notifier?: Notifier
  /** TLS 证书；设置后 createServer 走 HTTPS。 */
  tls?: { cert: Buffer | string; key: Buffer | string }
}

type AuthMethod = 'session' | 'api_key' | 'actor'

interface RequestAuth {
  method: AuthMethod
  actorId: string
  user?: UserRecord
  session?: SessionRecord
  apiKey?: ApiKeyRecord
}

interface Ctx {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  actorId: string
  params: Record<string, string>
  platform: Platform
  internalToken: string
  auth: RequestAuth
  authService?: AuthService
  modelProviders?: ModelProviderStore
  models?: ModelRegistry
  notifications?: NotificationStore
  notifier?: Notifier
  mcp: McpEndpoint
}

const SESSION_COOKIE = 'aiops_session'
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60
const STARTED_AT = Date.now()
const LOG_REQUESTS = process.env.AIOPS_LOG_REQUESTS === '1'

export function createHandler(
  platform: Platform,
  options: ServerOptions,
  mcp: McpEndpoint = createMcpEndpoint(platform),
): (req: IncomingMessage, res: ServerResponse) => void {
  const limit = createRateLimit()
  return (req, res) => {
    if (LOG_REQUESTS) {
      const started = Date.now()
      res.on('finish', () => {
        log.info('http.request', {
          method: req.method,
          path: (req.url ?? '/').split('?')[0],
          status: res.statusCode,
          ms: Date.now() - started,
        })
      })
    }
    void handle(req, res, platform, options, mcp, limit).catch((error) => {
      if (!(error instanceof PlatformError) && !(error instanceof AuthError)) {
        log.error('请求处理失败', { method: req.method, path: (req.url ?? '/').split('?')[0], error })
        incCounter('aiops_http_errors_total', { code: 'internal' })
      }
      if (res.headersSent) {
        res.end()
        return
      }
      if (error instanceof AuthError) {
        sendJson(res, error.status, { error: { code: error.code, message: error.message } })
        return
      }
      const mapped = error instanceof PlatformError ? error : new PlatformError('内部错误', 500, 'internal')
      sendJson(res, mapped.status, { error: { code: mapped.code, message: mapped.message } })
    })
  }
}

/** HTTPS 和 HTTP 共用同一个请求处理；TLS 由调用方读证书后传进来。 */
export function createServer(platform: Platform, options: ServerOptions): Server {
  const mcp = createMcpEndpoint(platform)
  const handler = createHandler(platform, options, mcp)
  const server = options.tls
    ? createHttpsServer({ cert: options.tls.cert, key: options.tls.key, minVersion: 'TLSv1.2' }, handler)
    : createHttpServer(handler)
  // 容器收到 SIGTERM 后 server.close() 会触发这里，回收 /mcp 会话和上游连接。
  server.on('close', () => mcp.close())
  return server
}

// 运行镜像会把 web/ 和 docs/ 放在镜像内其他路径；允许环境变量覆盖，默认兼容源码运行。
const WEB_ROOT = resolveRoot('AIOPS_WEB_ROOT', '../../web')
const OPENAPI_FILE = path.resolve(resolveRoot('AIOPS_OPENAPI_FILE', '../../docs/openapi.json'))

function resolveRoot(envName: string, fallback: string): string {
  const value = process.env[envName]?.trim()
  return value ? path.resolve(value) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), fallback)
}
const PAGES: Record<string, string> = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/login': 'login.html',
  '/login.html': 'login.html',
  '/login.js': 'login.js',
  '/app.css': 'app.css',
  '/app.js': 'app.js',
  '/logo.png': 'logo.png',
}

interface RateLimit {
  limiter: FixedWindowLimiter
  config: RateLimitConfig
}

function createRateLimit(): RateLimit | undefined {
  const config = rateLimitConfig()
  return config ? { limiter: new FixedWindowLimiter({ windowMs: config.windowMs }), config } : undefined
}

function enforceRateLimit(
  rate: RateLimit | undefined,
  res: ServerResponse,
  key: string,
  max: number,
  scope: string,
): void {
  if (!rate || max <= 0) return
  const result = rate.limiter.check(key, max)
  if (result.allowed) return
  incCounter('aiops_rate_limited_total', { scope })
  res.setHeader('retry-after', String(result.retryAfterSec))
  throw new PlatformError(`请求过于频繁，请 ${result.retryAfterSec} 秒后重试`, 429, 'rate_limited')
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  platform: Platform,
  options: ServerOptions,
  mcp: McpEndpoint,
  rate?: RateLimit,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const method = req.method ?? 'GET'
  if (method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, {
      ok: true,
      features: { finishTask: true, auth: Boolean(options.auth), tls: Boolean(options.tls) },
    })
    return
  }
  // K8s readiness：进程活着但 MySQL 连不上时不应接流量；存活探针仍用 /health。
  if (method === 'GET' && url.pathname === '/ready') {
    const ready = await platform.probeReady()
    sendJson(res, ready ? 200 : 503, { ok: ready, database: ready ? 'ok' : 'unavailable' })
    return
  }
  // Prometheus 抓取端点：不走会话认证；设置 AIOPS_METRICS_TOKEN 后要求 Bearer token。
  if (method === 'GET' && url.pathname === '/metrics') {
    const expected = process.env.AIOPS_METRICS_TOKEN?.trim()
    if (expected) {
      const header = req.headers.authorization
      const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : ''
      if (!token || !sameToken(token, expected)) throw new PlatformError('metrics token 不正确', 401, 'unauthorized')
    }
    const body = await renderMetrics(platform, options.auth, STARTED_AT)
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-cache' })
    res.end(body)
    return
  }
  // 对外 API 规范不需要认证，方便 Agent 客户端和 OpenAPI 工具直接拉取。
  if (method === 'GET' && (url.pathname === '/openapi.json' || url.pathname === '/api/v1/openapi.json')) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
    res.end(await readFile(OPENAPI_FILE))
    return
  }
  if (method === 'POST' && url.pathname === '/api/auth/login') {
    enforceRateLimit(rate, res, `login:${clientIp(req) ?? 'unknown'}`, rate?.config.loginMax ?? 0, 'login')
    await login(req, res, options)
    return
  }
  // 告警接入：外部监控用接入源 token 认证，不走会话/API key；只建只读排查任务。
  const alertHook = method === 'POST' ? url.pathname.match(/^\/api\/hooks\/alerts\/([^/]+)$/) : null
  if (alertHook) {
    enforceRateLimit(rate, res, `alert:${clientIp(req) ?? 'unknown'}`, rate?.config.max ?? 0, 'alert')
    const sourceId = decodeURIComponent(alertHook[1])
    const token = alertToken(req)
    // 先验 Token 再读 body；ingestAlert 内部还会再校验一次，防止轮换竞态。
    if (!(await platform.verifyAlertToken(sourceId, token))) {
      throw new PlatformError('告警 token 不正确', 401, 'unauthorized')
    }
    // 告警接入允许顶层数组（夜莺全局 Webhook 模板常用），其他 API 仍只接受对象。
    const payload = await readJsonValue(req)
    const result = await platform.ingestAlert(sourceId, token, payload)
    incCounter('aiops_alert_hooks_total', { result: result.accepted ? 'created' : (result.reason ?? 'ignored') })
    sendJson(res, 202, result)
    return
  }
  if (method === 'GET' && PAGES[url.pathname]) {
    const protectedPage = url.pathname === '/' || url.pathname === '/index.html'
    if (protectedPage && options.auth) {
      const auth = await authenticate(req, options)
      if (!auth) {
        res.statusCode = 302
        res.setHeader('location', '/login')
        res.end()
        return
      }
    }
    await sendPage(res, PAGES[url.pathname])
    return
  }
  // /mcp 和 API 统一按客户端 IP 限流；认证后再叠加按账号的写请求限流。
  if (url.pathname.startsWith('/api/') || url.pathname === '/mcp') {
    enforceRateLimit(rate, res, `ip:${clientIp(req) ?? 'unknown'}`, rate?.config.max ?? 0, 'general')
  }
  if (method === 'GET' && url.pathname === '/api/actors') {
    // 本机 header 模式下身份列表公开；账号模式下必须先登录，避免匿名枚举用户
    let visible = platform.listActors()
    if (options.auth) {
      const actorAuth = await authenticate(req, options)
      if (!actorAuth) throw new PlatformError('请先登录', 401, 'unauthorized')
      if (actorAuth.method === 'api_key') requireApiScope(actorAuth.apiKey!, method, url.pathname)
      assertPasswordChanged(actorAuth, method, url.pathname)
      const roles = actorAuth.user?.roles ?? []
      const canSeeAll = roles.includes('admin') || roles.includes('auditor') || roles.includes('approver')
      if (!canSeeAll) visible = visible.filter((actor) => actor.id === actorAuth.actorId)
    }
    sendJson(res, 200, { actors: visible })
    return
  }
  const auth = await authenticate(req, options)
  if (!auth) {
    throw new PlatformError(options.auth ? '请先登录' : '缺少 X-Actor-Id', 401, 'unauthorized')
  }
  assertPasswordChanged(auth, method, url.pathname)
  const unsafe = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS'
  if (auth.method === 'session' && unsafe) {
    const csrf = req.headers['x-csrf-token']
    if (typeof csrf !== 'string' || !auth.session || csrf !== auth.session.csrfToken) {
      throw new PlatformError('CSRF 令牌不正确', 403, 'csrf_failed')
    }
  }
  if (auth.method === 'api_key') requireApiScope(auth.apiKey!, method, url.pathname)
  if (unsafe) enforceRateLimit(rate, res, `actor:${auth.actorId}`, rate?.config.writeMax ?? 0, 'write')
  const ctx: Ctx = {
    req,
    res,
    url,
    actorId: auth.actorId,
    params: {},
    platform,
    internalToken: options.internalToken,
    auth,
    authService: options.auth,
    ...(options.modelProviders ? { modelProviders: options.modelProviders } : {}),
    ...(options.models ? { models: options.models } : {}),
    ...(options.notifications ? { notifications: options.notifications } : {}),
    ...(options.notifier ? { notifier: options.notifier } : {}),
    mcp,
  }
  const route = match(method, url.pathname)
  if (!route) throw new PlatformError('没有这个接口', 404, 'not_found')
  ctx.params = route.params
  await route.handle(ctx)
}

/**
 * 初始密码/管理员重置密码后，在改密前只放行改密、登出和读取当前身份。
 * API key 不依赖密码，不受该限制影响；本机 header 模式也不受影响。
 */
function assertPasswordChanged(auth: RequestAuth, method: string, pathname: string): void {
  if (auth.method !== 'session' || !auth.user?.mustChangePassword) return
  const allowed =
    (method === 'GET' && pathname === '/api/auth/me') ||
    (method === 'POST' && (pathname === '/api/auth/password' || pathname === '/api/auth/logout'))
  if (!allowed) throw new PlatformError('请先修改初始密码', 403, 'password_change_required')
}

async function authenticate(req: IncomingMessage, options: ServerOptions): Promise<RequestAuth | undefined> {
  const authorization = req.headers.authorization
  if (options.auth && typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    const result = await options.auth.resolveApiKey(authorization.slice(7).trim())
    if (!result) return undefined
    return { method: 'api_key', actorId: result.user.id, user: result.user, apiKey: result.key }
  }
  const cookies = parseCookies(req.headers.cookie)
  const sessionToken = cookies[SESSION_COOKIE]
  if (options.auth && sessionToken) {
    const result = await options.auth.verifySession(sessionToken)
    if (!result) return undefined
    return { method: 'session', actorId: result.user.id, user: result.user, session: result.session }
  }
  const actorHeader = req.headers['x-actor-id']
  const allowActor = options.auth ? options.allowActorHeader === true : options.allowActorHeader !== false
  if (allowActor && typeof actorHeader === 'string' && actorHeader.trim()) {
    return { method: 'actor', actorId: actorHeader.trim() }
  }
  return undefined
}

async function login(req: IncomingMessage, res: ServerResponse, options: ServerOptions): Promise<void> {
  if (!options.auth) throw new PlatformError('当前是本机 header 模式，不需要登录', 409, 'conflict')
  const body = await readJson(req)
  const username = body.username
  const password = body.password
  if (typeof username !== 'string' || typeof password !== 'string') {
    throw new PlatformError('username 和 password 必须是字符串', 400, 'bad_request')
  }
  const result = await options.auth.login(username, password, {
    ip: clientIp(req),
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
  })
  res.setHeader('set-cookie', sessionCookie(result.token, options.secureCookies === true))
  sendJson(res, 200, {
    user: result.user,
    csrfToken: result.csrfToken,
    expiresAt: result.expiresAt,
  })
}

async function logout(ctx: Ctx): Promise<void> {
  const token = parseCookies(ctx.req.headers.cookie)[SESSION_COOKIE]
  if (ctx.authService && token) await ctx.authService.logout(token, { ip: clientIp(ctx.req) })
  ctx.res.setHeader('set-cookie', sessionCookie('', false, true))
  sendJson(ctx.res, 200, { ok: true })
}

async function me(ctx: Ctx): Promise<void> {
  if (ctx.auth.method === 'actor') {
    sendJson(ctx.res, 200, {
      user: { id: ctx.auth.actorId, username: ctx.auth.actorId, displayName: ctx.auth.actorId, roles: [] },
      method: 'actor',
    })
    return
  }
  if (!ctx.auth.user) throw new PlatformError('未登录', 401, 'unauthorized')
  sendJson(ctx.res, 200, {
    user: toPublicUser(ctx.auth.user),
    method: ctx.auth.method,
    allowAdminSelfApproval: ctx.platform.adminSelfApprovalAllowed,
    ...(ctx.auth.session ? { csrfToken: ctx.auth.session.csrfToken } : {}),
    ...(ctx.auth.apiKey ? { scopes: ctx.auth.apiKey.scopes } : {}),
  })
}

async function changePassword(ctx: Ctx): Promise<void> {
  if (ctx.auth.method !== 'session' || !ctx.auth.user) {
    throw new PlatformError('只有网页登录会话可以改密', 403, 'forbidden')
  }
  const body = await readJson(ctx.req)
  const current = body.currentPassword
  const next = body.newPassword
  if (typeof current !== 'string' || typeof next !== 'string') {
    throw new PlatformError('currentPassword 和 newPassword 必须是字符串', 400, 'bad_request')
  }
  const token = parseCookies(ctx.req.headers.cookie)[SESSION_COOKIE]
  if (!ctx.authService) throw new PlatformError('当前没有启用账号认证', 409, 'conflict')
  await ctx.authService.changePassword(ctx.auth.user.id, current, next, token)
  sendJson(ctx.res, 200, { ok: true })
}

function requireWebSession(ctx: Ctx): UserRecord {
  if (ctx.auth.method !== 'session' || !ctx.auth.user) {
    throw new PlatformError('会话管理只能用网页会话', 403, 'forbidden')
  }
  return ctx.auth.user
}

async function listSessions(ctx: Ctx): Promise<void> {
  const user = requireWebSession(ctx)
  const token = parseCookies(ctx.req.headers.cookie)[SESSION_COOKIE]
  const sessions = await ctx.authService!.listActiveSessions(user.id, token ? hashToken(token) : undefined)
  sendJson(ctx.res, 200, { sessions })
}

async function revokeSession(ctx: Ctx): Promise<void> {
  const user = requireWebSession(ctx)
  const id = ctx.params.id ?? ''
  if (!id) throw new PlatformError('会话 id 不能为空', 400, 'bad_request')
  const revoked = await ctx.authService!.revokeSession(user.id, id, { ip: clientIp(ctx.req) })
  if (!revoked) throw new PlatformError('会话不存在', 404, 'not_found')
  if (ctx.auth.session?.id === id) ctx.res.setHeader('set-cookie', sessionCookie('', false, true))
  sendJson(ctx.res, 200, { ok: true })
}

async function revokeOtherSessions(ctx: Ctx): Promise<void> {
  const user = requireWebSession(ctx)
  const token = parseCookies(ctx.req.headers.cookie)[SESSION_COOKIE]
  if (!token) throw new PlatformError('没有当前会话', 401, 'unauthorized')
  const count = await ctx.authService!.revokeOtherSessions(user.id, token, { ip: clientIp(ctx.req) })
  sendJson(ctx.res, 200, { ok: true, revoked: count })
}

function requireAdmin(ctx: Ctx): UserRecord {
  if (!ctx.authService) throw new PlatformError('当前没有启用账号认证', 409, 'conflict')
  if (ctx.auth.method !== 'session' || !ctx.auth.user) {
    throw new PlatformError('用户管理只能用网页会话', 403, 'forbidden')
  }
  if (!ctx.auth.user.roles.includes('admin')) {
    throw new PlatformError('需要管理员权限', 403, 'forbidden')
  }
  return ctx.auth.user
}

/** 用户或角色变更后，把 active 用户同步成平台身份，立即影响提交、审批和工具权限。 */
async function syncActors(ctx: Ctx): Promise<void> {
  if (!ctx.authService) return
  const users = await ctx.authService.listUsers()
  ctx.platform.replaceActors(
    users
      .filter((user) => user.status === 'active')
      .map((user) => ({ id: user.id, name: user.displayName || user.username, roles: user.roles })),
  )
}

async function listUsers(ctx: Ctx): Promise<void> {
  requireAdmin(ctx)
  const users = await ctx.authService!.listUsers()
  sendJson(ctx.res, 200, { users: users.map(toPublicUser) })
}

async function listSecurityEvents(ctx: Ctx): Promise<void> {
  if (!ctx.authService) {
    sendJson(ctx.res, 200, { events: [], total: 0, limit: 0, offset: 0 })
    return
  }
  const roles = ctx.auth.user?.roles ?? ctx.platform.requireActor(ctx.actorId).roles
  if (!roles.includes('admin') && !roles.includes('auditor')) {
    throw new PlatformError('需要管理员或审计权限', 403, 'forbidden')
  }
  const limit = Number(ctx.url.searchParams.get('limit') ?? 200)
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new PlatformError('limit 必须是 1-500 的整数', 400, 'bad_request')
  }
  const offset = Number(ctx.url.searchParams.get('offset') ?? 0)
  if (!Number.isInteger(offset) || offset < 0) {
    throw new PlatformError('offset 必须是非负整数', 400, 'bad_request')
  }
  const [events, total] = await Promise.all([
    ctx.authService.listSecurityEvents(limit, offset),
    ctx.authService.countSecurityEvents(),
  ])
  sendJson(ctx.res, 200, { events, total, limit, offset })
}

function requireAuditRole(ctx: Ctx): void {
  const roles = ctx.auth.user?.roles ?? ctx.platform.requireActor(ctx.actorId).roles
  if (!roles.includes('admin') && !roles.includes('auditor')) {
    throw new PlatformError('需要管理员或审计权限', 403, 'forbidden')
  }
}

function readExportFormat(ctx: Ctx): 'csv' | 'json' {
  const value = ctx.url.searchParams.get('format') ?? 'csv'
  if (value !== 'csv' && value !== 'json') throw new PlatformError('format 只能是 csv 或 json', 400, 'bad_request')
  return value
}

/** 导出安全事件：默认 CSV，最多 5000 条；detail 里本来就不允许有密码和 token。 */
async function exportSecurityEvents(ctx: Ctx): Promise<void> {
  if (!ctx.authService) throw new PlatformError('当前没有启用账号认证', 409, 'conflict')
  requireAuditRole(ctx)
  const format = readExportFormat(ctx)
  const type = ctx.url.searchParams.get('type')?.trim() || undefined
  const since = ctx.url.searchParams.get('since')?.trim() || undefined
  const until = ctx.url.searchParams.get('until')?.trim() || undefined
  for (const [name, value] of [['since', since], ['until', until]] as const) {
    if (value && !Number.isFinite(Date.parse(value))) {
      throw new PlatformError(`${name} 必须是 ISO 时间`, 400, 'bad_request')
    }
  }
  if (since && until && since > until) throw new PlatformError('since 不能晚于 until', 400, 'bad_request')
  const rawLimit = Number(ctx.url.searchParams.get('limit') ?? 5000)
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 5000) {
    throw new PlatformError('limit 必须是 1-5000 的整数', 400, 'bad_request')
  }
  const events = await ctx.authService.exportSecurityEvents(rawLimit, {
    ...(type ? { type } : {}),
    ...(since ? { since } : {}),
    ...(until ? { until } : {}),
  })
  const stamp = new Date().toISOString().slice(0, 10)
  if (format === 'json') {
    sendAttachment(ctx.res, `security-events-${stamp}.json`, 'application/json; charset=utf-8', JSON.stringify({
      exportedAt: new Date().toISOString(),
      count: events.length,
      events,
    }, null, 2))
    return
  }
  const rows = events.map((event) => [
    event.at,
    event.type,
    event.userId ?? '',
    event.username ?? '',
    event.ip ?? '',
    event.detail ? JSON.stringify(event.detail) : '',
  ])
  sendAttachment(
    ctx.res,
    `security-events-${stamp}.csv`,
    'text/csv; charset=utf-8',
    csv([['时间', '类型', '用户ID', '用户名', '来源IP', '详情'], ...rows]),
  )
}

/** 单个任务的审计记录导出，权限沿用任务详情可见性。 */
async function exportTaskAudit(ctx: Ctx): Promise<void> {
  const taskId = ctx.params.id ?? ''
  const task = await ctx.platform.getTask(ctx.actorId, taskId)
  const records = await ctx.platform.listAudit(ctx.actorId, taskId)
  const format = readExportFormat(ctx)
  const stamp = new Date().toISOString().slice(0, 10)
  if (format === 'json') {
    sendAttachment(ctx.res, `task-${taskId}-audit-${stamp}.json`, 'application/json; charset=utf-8', JSON.stringify({
      task,
      exportedAt: new Date().toISOString(),
      count: records.length,
      audit: records,
    }, null, 2))
    return
  }
  const rows = records.map((record) => [
    record.at,
    record.actorId,
    record.tool,
    record.risk,
    JSON.stringify(record.args ?? {}),
    record.decision,
    record.approvalId ?? '',
  ])
  sendAttachment(
    ctx.res,
    `task-${taskId}-audit-${stamp}.csv`,
    'text/csv; charset=utf-8',
    csv([['时间', '执行人', '工具', '风险', '参数', '决定', '审批ID'], ...rows]),
  )
}

function csv(rows: Array<Array<string | number>>): string {
  return `﻿${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`
}

function csvCell(value: string | number): string {
  // 防 Excel 公式注入：用户可控字段以 = + - @ 开头时加前导单引号。
  const text = String(value).replace(/^[=+\-@\t\r]/, (char) => `'${char}`)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function sendAttachment(res: ServerResponse, filename: string, contentType: string, body: string): void {
  res.writeHead(200, {
    'content-type': contentType,
    'content-disposition': `attachment; filename="${filename}"`,
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * 配置变更和登录/账号事件统一落 security_events。
 * detail 只放标识和动作，禁止放密码、token、私钥；写失败不回滚已成功的配置变更，只记日志。
 */
async function auditConfig(ctx: Ctx, action: string, detail: Record<string, unknown>): Promise<void> {
  if (!ctx.authService) return
  const userAgent = ctx.req.headers['user-agent']
  try {
    await ctx.authService.recordConfigEvent(
      `config.${action}`,
      {
        userId: ctx.actorId,
        ...(ctx.auth.user ? { username: ctx.auth.user.username } : {}),
        ...detail,
      },
      {
        ...(clientIp(ctx.req) ? { ip: clientIp(ctx.req) } : {}),
        ...(typeof userAgent === 'string' ? { userAgent } : {}),
      },
    )
  } catch (error) {
    log.warn('配置审计写入失败', { action, error })
  }
}

async function createUser(ctx: Ctx): Promise<void> {
  requireAdmin(ctx)
  const body = await readJson(ctx.req)
  const username = stringField(body, 'username')
  if (!username) throw new PlatformError('username 不能为空', 400, 'bad_request')
  const roles = body.roles
  if (!Array.isArray(roles) || roles.length === 0) {
    throw new PlatformError('roles 必须是非空数组', 400, 'bad_request')
  }
  const typedRoles = roles as Role[]
  const password = stringField(body, 'password') || undefined
  // 审批、审计和管理员必须能登录网页；纯 API key 账号只适用于 viewer/operator。
  if (!password && typedRoles.some((role) => role === 'approver' || role === 'auditor' || role === 'admin')) {
    throw new PlatformError('approver / auditor / admin 必须设置登录密码', 400, 'password_required')
  }
  const user = await ctx.authService!.createUser({
    username,
    roles: typedRoles,
    displayName: stringField(body, 'displayName'),
    ...(password ? { password } : {}),
    email: stringField(body, 'email'),
  })
  let issued: { key: ApiKeyView; token: string } | undefined
  if (body.issueKey === true) {
    const keyName = stringField(body, 'keyName')?.trim() || `${user.username}-default`
    issued = await ctx.authService!.createApiKey(user.id, {
      name: keyName,
      scopes: defaultKeyScopes(user.roles),
      issuedBy: ctx.actorId,
    })
  }
  await syncActors(ctx)
  sendJson(ctx.res, 201, {
    user: toPublicUser(user),
    ...(issued ? { key: issued.key, token: issued.token } : {}),
  })
}

async function issueUserKey(ctx: Ctx): Promise<void> {
  requireAdmin(ctx)
  const user = (await ctx.authService!.listUsers()).find((item) => item.id === ctx.params.id)
  if (!user) throw new PlatformError('用户不存在', 404, 'not_found')
  const body = await readJson(ctx.req)
  const name = stringField(body, 'name')?.trim() || `${user.username}-default`
  const created = await ctx.authService!.createApiKey(user.id, {
    name,
    scopes: defaultKeyScopes(user.roles),
    issuedBy: ctx.actorId,
  })
  sendJson(ctx.res, 201, { key: created.key, token: created.token })
}

/** 管理员建号时按角色给默认 scope；个人可以在「账号」页自行增减。 */
function defaultKeyScopes(roles: Role[]): ApiScope[] {
  if (roles.includes('auditor')) return ['tasks:read', 'approvals:read', 'knowledge:read']
  if (roles.includes('operator') || roles.includes('approver') || roles.includes('admin')) {
    return ['tasks:read', 'tasks:write', 'approvals:read', 'approvals:write', 'tools:execute', 'knowledge:read']
  }
  return ['tasks:read', 'approvals:read', 'knowledge:read']
}

async function updateUser(ctx: Ctx): Promise<void> {
  const admin = requireAdmin(ctx)
  const body = await readJson(ctx.req)
  const roles = body.roles
  if (roles !== undefined && (!Array.isArray(roles) || roles.length === 0)) {
    throw new PlatformError('roles 必须是非空数组', 400, 'bad_request')
  }
  const status = stringField(body, 'status')
  if (status !== undefined && status !== 'active' && status !== 'disabled') {
    throw new PlatformError('status 只能是 active 或 disabled', 400, 'bad_request')
  }
  if (ctx.params.id === admin.id && status === 'disabled') {
    throw new PlatformError('不能停用当前登录的管理员', 409, 'conflict')
  }
  const user = await ctx.authService!.updateUser(ctx.params.id ?? '', {
    displayName: stringField(body, 'displayName'),
    roles: roles as UserRecord['roles'] | undefined,
    status: status as 'active' | 'disabled' | undefined,
  })
  await syncActors(ctx)
  sendJson(ctx.res, 200, { user: toPublicUser(user) })
}

async function resetUserPassword(ctx: Ctx): Promise<void> {
  requireAdmin(ctx)
  const body = await readJson(ctx.req)
  const password = body.newPassword
  if (typeof password !== 'string') throw new PlatformError('newPassword 必须是字符串', 400, 'bad_request')
  await ctx.authService!.resetPassword(ctx.params.id ?? '', password)
  sendJson(ctx.res, 200, { ok: true })
}

async function listLoginLocks(ctx: Ctx): Promise<void> {
  requireAdmin(ctx)
  sendJson(ctx.res, 200, { locks: await ctx.authService!.listLoginLocks() })
}

async function clearLoginLocks(ctx: Ctx): Promise<void> {
  requireAdmin(ctx)
  const cleared = await ctx.authService!.clearLoginLocks(ctx.params.id ?? '', { ip: clientIp(ctx.req) })
  sendJson(ctx.res, 200, { ok: true, cleared })
}

async function listApiKeys(ctx: Ctx): Promise<void> {
  if (ctx.auth.method !== 'session' || !ctx.auth.user) {
    throw new PlatformError('API key 管理只能用网页会话', 403, 'forbidden')
  }
  const requested = ctx.url.searchParams.get('userId') ?? undefined
  const own = ctx.auth.user
  if (requested && requested !== own.id && !own.roles.includes('admin')) {
    throw new PlatformError('只能查看自己的 API key', 403, 'forbidden')
  }
  const keys = await ctx.authService!.listApiKeys(own.roles.includes('admin') ? requested : own.id)
  sendJson(ctx.res, 200, { keys })
}

async function createApiKey(ctx: Ctx): Promise<void> {
  if (ctx.auth.method !== 'session' || !ctx.auth.user) {
    throw new PlatformError('API key 管理只能用网页会话', 403, 'forbidden')
  }
  const body = await readJson(ctx.req)
  const name = stringField(body, 'name')
  if (!name) throw new PlatformError('name 不能为空', 400, 'bad_request')
  const scopes = body.scopes
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new PlatformError('scopes 必须是非空数组', 400, 'bad_request')
  }
  const userId = stringField(body, 'userId') ?? ctx.auth.user.id
  if (userId !== ctx.auth.user.id && !ctx.auth.user.roles.includes('admin')) {
    throw new PlatformError('只能给自己创建 API key', 403, 'forbidden')
  }
  const created = await ctx.authService!.createApiKey(userId, {
    name,
    scopes: scopes as ApiKeyRecord['scopes'],
    expiresAt: stringField(body, 'expiresAt'),
    issuedBy: ctx.actorId,
  })
  sendJson(ctx.res, 201, { key: created.key, token: created.token })
}

async function revokeApiKey(ctx: Ctx): Promise<void> {
  if (ctx.auth.method !== 'session' || !ctx.auth.user) {
    throw new PlatformError('API key 管理只能用网页会话', 403, 'forbidden')
  }
  const keys = await ctx.authService!.listApiKeys()
  const key = keys.find((item) => item.id === ctx.params.id)
  if (!key) throw new PlatformError('API key 不存在', 404, 'not_found')
  if (key.userId !== ctx.auth.user.id && !ctx.auth.user.roles.includes('admin')) {
    throw new PlatformError('不能吊销别人的 API key', 403, 'forbidden')
  }
  await ctx.authService!.revokeApiKey(key.id)
  sendJson(ctx.res, 200, { ok: true })
}

async function rotateApiKey(ctx: Ctx): Promise<void> {
  if (ctx.auth.method !== 'session' || !ctx.auth.user) {
    throw new PlatformError('API key 管理只能用网页会话', 403, 'forbidden')
  }
  const keys = await ctx.authService!.listApiKeys()
  const key = keys.find((item) => item.id === ctx.params.id)
  if (!key) throw new PlatformError('API key 不存在', 404, 'not_found')
  if (key.userId !== ctx.auth.user.id && !ctx.auth.user.roles.includes('admin')) {
    throw new PlatformError('不能轮换别人的 API key', 403, 'forbidden')
  }
  const created = await ctx.authService!.rotateApiKey(key.id, ctx.actorId)
  sendJson(ctx.res, 201, { key: created.key, token: created.token })
}

function requireApiScope(key: ApiKeyRecord, method: string, pathname: string): void {
  const scope = requiredScope(method, pathname)
  if (!scope) throw new PlatformError('这个接口不允许 API key 访问', 403, 'forbidden')
  if (!key.scopes.includes(scope)) throw new PlatformError(`API key 缺少 scope: ${scope}`, 403, 'forbidden')
}

function requiredScope(method: string, pathname: string): ApiKeyRecord['scopes'][number] | undefined {
  if (pathname === '/api/auth/me') return 'tasks:read'
  if (pathname.startsWith('/api/auth/')) return undefined
  if (pathname === '/mcp') return 'tools:execute'
  if (pathname === '/api/tool-calls') return 'tools:execute'
  if (pathname.startsWith('/api/v1/tasks')) {
    if (pathname.endsWith('/tool-calls')) return 'tools:execute'
    return method === 'GET' ? 'tasks:read' : 'tasks:write'
  }
  if (pathname.startsWith('/api/v1/approvals')) {
    return method === 'GET' ? 'approvals:read' : 'approvals:write'
  }
  if (pathname === '/api/v1/tools' || pathname === '/api/v1/skills') return 'tasks:read'
  if (pathname.startsWith('/api/tasks') || pathname.startsWith('/api/agent/tasks')) {
    return method === 'GET' ? 'tasks:read' : 'tasks:write'
  }
  if (pathname.startsWith('/api/approvals')) {
    return method === 'GET' ? 'approvals:read' : 'approvals:write'
  }
  if (pathname.startsWith('/api/knowledge')) {
    return method === 'GET' || pathname.includes('/search') || pathname.includes('/documents')
      ? 'knowledge:read'
      : undefined
  }
  if (pathname === '/api/tools' || pathname === '/api/skills' || pathname === '/api/actors') return 'tasks:read'
  return undefined
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {}
  if (!header) return cookies
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    const name = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (name) cookies[name] = decodeURIComponent(value)
  }
  return cookies
}

function sessionCookie(value: string, secure: boolean, clear = false): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    clear ? 'Max-Age=0' : `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

function clientIp(req: IncomingMessage): string | undefined {
  const socketIp = req.socket.remoteAddress?.trim() || undefined
  // 默认只信 TCP 对端。平台直接在公网/局域网暴露时，X-Forwarded-For 可以随便伪造。
  if (process.env.AIOPS_TRUST_PROXY !== '1') return socketIp
  const header = req.headers['x-forwarded-for']
  const forwarded = Array.isArray(header) ? header.join(',') : header
  if (!forwarded?.trim()) return socketIp
  // 反向代理会把真实对端追加到最右侧；从右往左取第一个合法地址，
  // 忽略客户端自己塞进来的左侧伪造值。只适用于单层可信代理。
  const hops = forwarded.split(',').map((item) => item.trim()).filter(Boolean)
  for (let index = hops.length - 1; index >= 0; index -= 1) {
    const hop = hops[index]!
    if (isIP(hop)) return hop
  }
  return socketIp
}

function match(method: string, pathname: string): { params: Record<string, string>; handle: (ctx: Ctx) => Promise<void> } | undefined {
  const routes: Array<{ method: string; pattern: RegExp; handle: (ctx: Ctx) => Promise<void> }> = [
    { method: 'GET', pattern: /^\/api\/auth\/me$/, handle: me },
    { method: 'POST', pattern: /^\/api\/auth\/logout$/, handle: logout },
    { method: 'POST', pattern: /^\/api\/auth\/password$/, handle: changePassword },
    { method: 'GET', pattern: /^\/api\/auth\/keys$/, handle: listApiKeys },
    { method: 'POST', pattern: /^\/api\/auth\/keys$/, handle: createApiKey },
    { method: 'DELETE', pattern: /^\/api\/auth\/keys\/([^/]+)$/, handle: revokeApiKey },
    { method: 'POST', pattern: /^\/api\/auth\/keys\/([^/]+)\/rotate$/, handle: rotateApiKey },
    { method: 'GET', pattern: /^\/api\/auth\/sessions$/, handle: listSessions },
    { method: 'DELETE', pattern: /^\/api\/auth\/sessions$/, handle: revokeOtherSessions },
    { method: 'DELETE', pattern: /^\/api\/auth\/sessions\/([^/]+)$/, handle: revokeSession },
    { method: 'GET', pattern: /^\/api\/security-events$/, handle: listSecurityEvents },
    { method: 'GET', pattern: /^\/api\/security-events\/export$/, handle: exportSecurityEvents },
    { method: 'GET', pattern: /^\/api\/users$/, handle: listUsers },
    { method: 'POST', pattern: /^\/api\/users$/, handle: createUser },
    { method: 'GET', pattern: /^\/api\/login-locks$/, handle: listLoginLocks },
    { method: 'DELETE', pattern: /^\/api\/login-locks\/([^/]+)$/, handle: clearLoginLocks },
    { method: 'POST', pattern: /^\/api\/users\/([^/]+)\/password$/, handle: resetUserPassword },
    { method: 'POST', pattern: /^\/api\/users\/([^/]+)\/keys$/, handle: issueUserKey },
    { method: 'PATCH', pattern: /^\/api\/users\/([^/]+)$/, handle: updateUser },
    { method: 'POST', pattern: /^\/api\/tasks$/, handle: createTask },
    { method: 'POST', pattern: /^\/api\/agent\/tasks$/, handle: createAgentTask },
    { method: 'POST', pattern: /^\/api\/v1\/tasks$/, handle: createV1Task },
    { method: 'GET', pattern: /^\/api\/v1\/tasks$/, handle: listV1Tasks },
    { method: 'POST', pattern: /^\/api\/v1\/tasks\/([^/]+)\/tool-calls$/, handle: toolCallV1 },
    { method: 'POST', pattern: /^\/api\/v1\/tasks\/([^/]+)\/finish$/, handle: finishV1Task },
    { method: 'POST', pattern: /^\/api\/v1\/tasks\/([^/]+)\/cancel$/, handle: cancel },
    { method: 'GET', pattern: /^\/api\/v1\/tasks\/([^/]+)\/events$/, handle: events },
    { method: 'GET', pattern: /^\/api\/v1\/tasks\/([^/]+)\/audit$/, handle: audit },
    { method: 'GET', pattern: /^\/api\/v1\/tasks\/([^/]+)\/audit\/export$/, handle: exportTaskAudit },
    { method: 'GET', pattern: /^\/api\/v1\/tasks\/([^/]+)$/, handle: getTask },
    { method: 'GET', pattern: /^\/api\/v1\/approvals$/, handle: listApprovals },
    { method: 'GET', pattern: /^\/api\/v1\/approvals\/([^/]+)$/, handle: getApproval },
    { method: 'GET', pattern: /^\/api\/v1\/tools$/, handle: listTools },
    { method: 'GET', pattern: /^\/api\/v1\/skills$/, handle: listSkills },
    { method: 'GET', pattern: /^\/api\/overview$/, handle: overview },
    { method: 'GET', pattern: /^\/api\/tasks$/, handle: listTasks },
    { method: 'GET', pattern: /^\/api\/tasks\/([^/]+)\/events$/, handle: events },
    { method: 'GET', pattern: /^\/api\/tasks\/([^/]+)\/audit$/, handle: audit },
    { method: 'GET', pattern: /^\/api\/tasks\/([^/]+)\/audit\/export$/, handle: exportTaskAudit },
    { method: 'POST', pattern: /^\/api\/tasks\/([^/]+)\/retry$/, handle: retryTask },
    { method: 'POST', pattern: /^\/api\/tasks\/([^/]+)\/cancel$/, handle: cancel },
    { method: 'POST', pattern: /^\/api\/tasks\/([^/]+)\/finish$/, handle: finishTask },
    { method: 'POST', pattern: /^\/api\/agent\/tasks\/([^/]+)\/finish$/, handle: finishAgentTask },
    { method: 'GET', pattern: /^\/api\/tasks\/([^/]+)$/, handle: getTask },
    { method: 'GET', pattern: /^\/api\/approvals$/, handle: listApprovals },
    { method: 'GET', pattern: /^\/api\/approvals\/([^/]+)$/, handle: getApproval },
    { method: 'POST', pattern: /^\/api\/approvals\/([^/]+)\/resume$/, handle: resumeApproval },
    { method: 'POST', pattern: /^\/api\/approvals\/([^/]+)$/, handle: decide },
    { method: 'GET', pattern: /^\/api\/tools$/, handle: listTools },
    { method: 'GET', pattern: /^\/api\/skills$/, handle: listSkills },
    { method: 'GET', pattern: /^\/api\/tool-policies$/, handle: listToolPolicies },
    { method: 'PUT', pattern: /^\/api\/tool-policies\/([^/]+)$/, handle: saveToolPolicy },
    { method: 'DELETE', pattern: /^\/api\/tool-policies\/([^/]+)$/, handle: clearToolPolicy },
    { method: 'GET', pattern: /^\/api\/alert-sources$/, handle: listAlertSources },
    { method: 'POST', pattern: /^\/api\/alert-sources$/, handle: saveAlertSource },
    { method: 'PUT', pattern: /^\/api\/alert-sources\/([^/]+)$/, handle: saveAlertSource },
    { method: 'DELETE', pattern: /^\/api\/alert-sources\/([^/]+)$/, handle: removeAlertSource },
    { method: 'POST', pattern: /^\/api\/alert-sources\/([^/]+)\/rotate$/, handle: rotateAlertSourceToken },
    { method: 'POST', pattern: /^\/api\/alert-sources\/([^/]+)\/test$/, handle: testAlertSource },
    { method: 'GET', pattern: /^\/api\/model-providers$/, handle: listModelProviders },
    { method: 'POST', pattern: /^\/api\/model-providers$/, handle: saveModelProvider },
    { method: 'PUT', pattern: /^\/api\/model-providers\/([^/]+)$/, handle: saveModelProvider },
    { method: 'DELETE', pattern: /^\/api\/model-providers\/([^/]+)$/, handle: deleteModelProvider },
    { method: 'POST', pattern: /^\/api\/model-providers\/([^/]+)\/test$/, handle: probeModelProvider },
    { method: 'POST', pattern: /^\/api\/model-providers\/([^/]+)\/models\/refresh$/, handle: discoverModelProvider },
    { method: 'GET', pattern: /^\/api\/notifications$/, handle: listNotifications },
    { method: 'PUT', pattern: /^\/api\/notifications$/, handle: saveNotificationSettings },
    { method: 'POST', pattern: /^\/api\/notifications\/webhooks$/, handle: saveNotificationWebhook },
    { method: 'PUT', pattern: /^\/api\/notifications\/webhooks\/([^/]+)$/, handle: saveNotificationWebhook },
    { method: 'DELETE', pattern: /^\/api\/notifications\/webhooks\/([^/]+)$/, handle: deleteNotificationWebhook },
    { method: 'POST', pattern: /^\/api\/notifications\/webhooks\/([^/]+)\/test$/, handle: testNotificationWebhook },
    { method: 'GET', pattern: /^\/api\/mcp-servers$/, handle: listMcpServers },
    { method: 'POST', pattern: /^\/api\/mcp-servers$/, handle: saveMcpServers },
    { method: 'POST', pattern: /^\/api\/mcp-servers\/health$/, handle: checkMcpHealth },
    { method: 'POST', pattern: /^\/api\/mcp-servers\/([^/]+)\/review$/, handle: reviewMcpServer },
    { method: 'POST', pattern: /^\/api\/knowledge\/search$/, handle: search },
    { method: 'POST', pattern: /^\/api\/knowledge\/documents$/, handle: document },
    { method: 'GET', pattern: /^\/api\/knowledge\/docs$/, handle: listKnowledgeDocuments },
    { method: 'POST', pattern: /^\/api\/knowledge\/docs$/, handle: saveKnowledgeDocument },
    { method: 'DELETE', pattern: /^\/api\/knowledge\/docs\/([^/]+)$/, handle: deleteKnowledgeDocument },
    { method: 'GET', pattern: /^\/api\/assets$/, handle: listAssets },
    { method: 'POST', pattern: /^\/api\/assets$/, handle: saveAsset },
    { method: 'POST', pattern: /^\/api\/assets\/known-hosts\/import$/, handle: importKnownHosts },
    { method: 'POST', pattern: /^\/api\/assets\/([^/]+)\/ssh-test$/, handle: testAssetSsh },
    { method: 'POST', pattern: /^\/api\/assets\/([^/]+)\/ssh-host-key\/probe$/, handle: probeAssetHostKey },
    { method: 'POST', pattern: /^\/api\/assets\/([^/]+)\/ssh-host-key\/trust$/, handle: trustAssetHostKey },
    { method: 'DELETE', pattern: /^\/api\/assets\/([^/]+)$/, handle: deleteAsset },
    { method: 'GET', pattern: /^\/api\/credentials$/, handle: listCredentials },
    { method: 'POST', pattern: /^\/api\/credentials$/, handle: saveCredential },
    { method: 'DELETE', pattern: /^\/api\/credentials\/([^/]+)$/, handle: deleteCredential },
    { method: 'POST', pattern: /^\/api\/tool-calls$/, handle: toolCall },
    { method: 'POST', pattern: /^\/mcp$/, handle: mcpRequest },
    { method: 'GET', pattern: /^\/mcp$/, handle: mcpRequest },
    { method: 'DELETE', pattern: /^\/mcp$/, handle: mcpRequest },
  ]
  for (const route of routes) {
    if (route.method !== method) continue
    const found = pathname.match(route.pattern)
    if (!found) continue
    return { params: { id: found[1] ? decodeURIComponent(found[1]) : '' }, handle: route.handle }
  }
  return undefined
}

async function createTask(ctx: Ctx): Promise<void> {
  const body = await readJson(ctx.req)
  const task = await ctx.platform.createTask(ctx.actorId, {
    title: stringField(body, 'title'),
    prompt: stringField(body, 'prompt'),
    skill: stringField(body, 'skill'),
    provider: stringField(body, 'provider'),
    model: stringField(body, 'model'),
  })
  sendJson(ctx.res, 201, { task })
}

async function retryTask(ctx: Ctx): Promise<void> {
  const task = await ctx.platform.retryTask(ctx.actorId, ctx.params.id ?? '')
  sendJson(ctx.res, 201, { task })
}

async function createAgentTask(ctx: Ctx): Promise<void> {
  requireInternal(ctx)
  const body = await readJson(ctx.req)
  const task = await ctx.platform.createAgentTask(ctx.actorId, {
    title: stringField(body, 'title'),
    prompt: stringField(body, 'prompt'),
    skill: stringField(body, 'skill'),
    sessionId: stringField(body, 'sessionId') ?? stringField(body, 'session_id'),
  })
  sendJson(ctx.res, 201, { task })
}

async function finishAgentTask(ctx: Ctx): Promise<void> {
  requireInternal(ctx)
  const body = await readJson(ctx.req)
  const task = await ctx.platform.finishAgentTask(ctx.actorId, ctx.params.id ?? '', {
    status: stringField(body, 'status'),
    result: stringField(body, 'result'),
    error: stringField(body, 'error'),
  })
  sendJson(ctx.res, 200, { task })
}

/** 对外 Agent API：任务由外部 Agent 自己驱动，平台只记过程、执行工具和卡审批。 */
async function createV1Task(ctx: Ctx): Promise<void> {
  const body = await readJson(ctx.req)
  const task = await ctx.platform.createAgentTask(
    ctx.actorId,
    {
      title: stringField(body, 'title'),
      prompt: stringField(body, 'prompt'),
      skill: stringField(body, 'skill'),
      sessionId: stringField(body, 'sessionId') ?? stringField(body, 'session_id'),
    },
    'api',
  )
  sendJson(ctx.res, 201, { task })
}

async function listV1Tasks(ctx: Ctx): Promise<void> {
  const page = readPage(ctx)
  const requested = ctx.url.searchParams.get('origin') ?? 'api'
  if (!['api', 'dsh', 'web', 'all'].includes(requested)) {
    throw new PlatformError('origin 只能是 api、dsh、web 或 all', 400, 'bad_request')
  }
  const result = await ctx.platform.listTasksPage(
    ctx.actorId,
    {
      status: ctx.url.searchParams.get('status') ?? undefined,
      ownerId: ctx.url.searchParams.get('ownerId') ?? undefined,
      ...(requested === 'all' ? {} : { origin: requested }),
    },
    page,
  )
  sendJson(ctx.res, 200, {
    tasks: result.tasks,
    total: result.total,
    limit: page.limit ?? null,
    offset: page.offset,
  })
}

async function toolCallV1(ctx: Ctx): Promise<void> {
  const body = await readJson(ctx.req)
  const tool = stringField(body, 'tool')
  if (!tool) throw new PlatformError('tool 不能为空', 400, 'bad_request')
  const args = body.args === undefined ? {} : body.args
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new PlatformError('args 必须是对象', 400, 'bad_request')
  }
  const outcome = await ctx.platform.executeTool({
    actorId: ctx.actorId,
    tool,
    args: args as Record<string, unknown>,
    taskId: ctx.params.id ?? '',
    approvalId: stringField(body, 'approvalId') ?? stringField(body, 'approval_id'),
  })
  sendJson(ctx.res, 200, { outcome })
}

async function finishV1Task(ctx: Ctx): Promise<void> {
  const body = await readJson(ctx.req)
  const task = await ctx.platform.finishAgentTask(ctx.actorId, ctx.params.id ?? '', {
    status: stringField(body, 'status'),
    result: stringField(body, 'result'),
    error: stringField(body, 'error'),
  })
  sendJson(ctx.res, 200, { task })
}

/** 列表分页参数：limit 不传返回全部，offset 默认 0。 */
function readPage(ctx: Ctx): { limit?: number; offset: number } {
  const rawLimit = ctx.url.searchParams.get('limit')
  let limit: number | undefined
  if (rawLimit !== null && rawLimit !== '') {
    limit = Number(rawLimit)
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new PlatformError('limit 必须是 1 到 200 的整数', 400, 'bad_request')
    }
  }
  const rawOffset = ctx.url.searchParams.get('offset') ?? '0'
  const offset = Number(rawOffset)
  if (!Number.isInteger(offset) || offset < 0) {
    throw new PlatformError('offset 必须是非负整数', 400, 'bad_request')
  }
  return { ...(limit !== undefined ? { limit } : {}), offset }
}

async function overview(ctx: Ctx): Promise<void> {
  sendJson(ctx.res, 200, await ctx.platform.overview(ctx.actorId))
}

async function listTasks(ctx: Ctx): Promise<void> {
  const page = readPage(ctx)
  const result = await ctx.platform.listTasksPage(
    ctx.actorId,
    {
      status: ctx.url.searchParams.get('status') ?? undefined,
      ownerId: ctx.url.searchParams.get('ownerId') ?? undefined,
    },
    page,
  )
  sendJson(ctx.res, 200, {
    tasks: result.tasks,
    total: result.total,
    limit: page.limit ?? null,
    offset: page.offset,
  })
}

async function getTask(ctx: Ctx): Promise<void> {
  sendJson(ctx.res, 200, { task: await ctx.platform.getTask(ctx.actorId, ctx.params.id ?? '') })
}

async function events(ctx: Ctx): Promise<void> {
  const taskId = ctx.params.id ?? ''
  if (ctx.url.searchParams.get('stream') === '1') {
    await streamEvents(ctx, taskId)
    return
  }
  const after = ctx.url.searchParams.get('after') ?? undefined
  const events = await ctx.platform.listEvents(ctx.actorId, taskId, after)
  // 过程记录按时间正序，limit 取最近 N 条；total 用于页面提示。
  const limit = readPage(ctx).limit
  sendJson(ctx.res, 200, {
    events: limit ? events.slice(-limit) : events,
    total: events.length,
    limit: limit ?? null,
  })
}

async function audit(ctx: Ctx): Promise<void> {
  const records = await ctx.platform.listAudit(ctx.actorId, ctx.params.id ?? '')
  const limit = readPage(ctx).limit
  sendJson(ctx.res, 200, {
    audit: limit ? records.slice(-limit) : records,
    total: records.length,
    limit: limit ?? null,
  })
}

async function cancel(ctx: Ctx): Promise<void> {
  const body = await readJson(ctx.req)
  if (body.force !== undefined && typeof body.force !== 'boolean') {
    throw new PlatformError('force 必须是布尔值', 400, 'bad_request')
  }
  sendJson(ctx.res, 200, {
    task: await ctx.platform.cancel(ctx.actorId, ctx.params.id ?? '', { force: body.force === true }),
  })
}

async function finishTask(ctx: Ctx): Promise<void> {
  const body = await readJson(ctx.req)
  const task = await ctx.platform.finishAgentTask(ctx.actorId, ctx.params.id ?? '', {
    status: 'succeeded',
    result: stringField(body, 'result'),
  })
  sendJson(ctx.res, 200, { task })
}

async function listApprovals(ctx: Ctx): Promise<void> {
  const status = ctx.url.searchParams.get('status') ?? undefined
  const taskId = ctx.url.searchParams.get('taskId') ?? undefined
  const page = readPage(ctx)
  const result = await ctx.platform.listApprovalsPage(ctx.actorId, status, taskId, page)
  sendJson(ctx.res, 200, {
    approvals: result.approvals,
    total: result.total,
    limit: page.limit ?? null,
    offset: page.offset,
  })
}

async function getApproval(ctx: Ctx): Promise<void> {
  const detail = await ctx.platform.getApprovalDetail(ctx.actorId, ctx.params.id ?? '')
  sendJson(ctx.res, 200, { approval: detail.approval, execution: detail.execution })
}

async function decide(ctx: Ctx): Promise<void> {
  const body = await readJson(ctx.req)
  const decision = stringField(body, 'decision')
  const comment = stringField(body, 'comment')
  const approval = await ctx.platform.decideApproval(ctx.actorId, ctx.params.id ?? '', decision ?? '', comment)
  sendJson(ctx.res, 200, { approval })
}

async function resumeApproval(ctx: Ctx): Promise<void> {
  requireInternal(ctx)
  const outcome = await ctx.platform.resumeApproval(ctx.actorId, ctx.params.id ?? '')
  sendJson(ctx.res, 200, outcome)
}

async function listTools(ctx: Ctx): Promise<void> {
  sendJson(ctx.res, 200, { tools: ctx.platform.listTools(ctx.actorId) })
}

async function listSkills(ctx: Ctx): Promise<void> {
  sendJson(ctx.res, 200, { skills: ctx.platform.listSkills(ctx.actorId) })
}

async function listToolPolicies(ctx: Ctx): Promise<void> {
  sendJson(ctx.res, 200, { policies: await ctx.platform.listToolPolicies(ctx.actorId) })
}

async function saveToolPolicy(ctx: Ctx): Promise<void> {
  const body = await readJson(ctx.req)
  const risk = stringField(body, 'risk')
  if (risk !== 'read' && risk !== 'mutate') {
    throw new PlatformError('risk 只能是 read 或 mutate', 400, 'bad_request')
  }
  const tool = ctx.params.id ?? ''
  const policies = await ctx.platform.setToolPolicy(ctx.actorId, tool, risk)
  await auditConfig(ctx, 'tool_policy_saved', { tool, risk })
  sendJson(ctx.res, 200, { policies })
}

async function clearToolPolicy(ctx: Ctx): Promise<void> {
  const tool = ctx.params.id ?? ''
  const policies = await ctx.platform.clearToolPolicy(ctx.actorId, tool)
  await auditConfig(ctx, 'tool_policy_cleared', { tool })
  sendJson(ctx.res, 200, { policies })
}

async function listAlertSources(ctx: Ctx): Promise<void> {
  sendJson(ctx.res, 200, { sources: await ctx.platform.listAlertSources(ctx.actorId) })
}

async function saveAlertSource(ctx: Ctx): Promise<void> {
  const body = await readJson(ctx.req)
  await assertKnownNotificationWebhooks(ctx, body.notifyWebhookIds)
  const id = ctx.params.id
  const result = await ctx.platform.saveAlertSource(ctx.actorId, id, body)
  await auditConfig(ctx, 'alert_source_saved', {
    id: result.source.id,
    name: result.source.name,
    format: result.source.format,
  })
  sendJson(ctx.res, id ? 200 : 201, result)
}

/**
 * 告警源勾选的通知渠道必须真实存在；否则删除 webhook 或手写错 id 后会静默不推送。
 * 编辑时字段缺省表示保持原值，不在这里重复校验。
 */
async function assertKnownNotificationWebhooks(ctx: Ctx, value: unknown): Promise<void> {
  if (value === undefined) return
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new PlatformError('notifyWebhookIds 必须是字符串数组', 400, 'bad_request')
  }
  const ids = [...new Set(value.map((item) => item.trim()))]
  if (ids.length === 0 || !ctx.notifications) return
  const known = new Set((await ctx.notifications.list()).map((webhook) => webhook.id))
  const missing = ids.filter((id) => !known.has(id))
  if (missing.length > 0) {
    throw new PlatformError(`通知 webhook 不存在: ${missing.join(', ')}`, 400, 'bad_request')
  }
}

async function removeAlertSource(ctx: Ctx): Promise<void> {
  const id = ctx.params.id ?? ''
  const removed = await ctx.platform.removeAlertSource(ctx.actorId, id)
  await auditConfig(ctx, 'alert_source_removed', { id })
  sendJson(ctx.res, 200, { removed })
}

async function rotateAlertSourceToken(ctx: Ctx): Promise<void> {
  const id = ctx.params.id ?? ''
  const result = await ctx.platform.rotateAlertSourceToken(ctx.actorId, id)
  await auditConfig(ctx, 'alert_source_token_rotated', { id })
  sendJson(ctx.res, 200, result)
}

async function testAlertSource(ctx: Ctx): Promise<void> {
  const id = ctx.params.id ?? ''
  // body 可选：不传时用平台生成的模拟告警；也可以直接传 {"payload": {...}} 模拟真实报文。
  const body = await readJson(ctx.req)
  const payload = body.payload !== undefined ? body.payload : undefined
  const result = await ctx.platform.testAlertSource(ctx.actorId, id, payload)
  await auditConfig(ctx, 'alert_source_tested', {
    id,
    accepted: result.accepted,
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.taskId ? { taskId: result.taskId } : {}),
  })
  sendJson(ctx.res, 202, result)
}

async function listMcpServers(ctx: Ctx): Promise<void> {
  sendJson(ctx.res, 200, {
    servers: await ctx.platform.listMcpServers(ctx.actorId),
    errors: ctx.platform.listMcpErrors(ctx.actorId),
    health: await ctx.platform.listMcpHealth(ctx.actorId),
  })
}

async function saveMcpServers(ctx: Ctx): Promise<void> {
  const body = await readJson(ctx.req)
  if (!Array.isArray(body.servers)) throw new PlatformError('servers 必须是数组', 400, 'bad_request')
  const servers = await ctx.platform.saveMcpServers(ctx.actorId, body.servers)
  await auditConfig(ctx, 'mcp_saved', {
    count: servers.length,
    servers: servers.map((server) => server.name),
  })
  sendJson(ctx.res, 200, { servers, health: await ctx.platform.listMcpHealth(ctx.actorId) })
}

async function checkMcpHealth(ctx: Ctx): Promise<void> {
  sendJson(ctx.res, 200, { health: await ctx.platform.runMcpHealthCheck(ctx.actorId) })
}

async function reviewMcpServer(ctx: Ctx): Promise<void> {
  const name = ctx.params.id ?? ''
  const health = await ctx.platform.reviewMcpServer(ctx.actorId, name)
  await auditConfig(ctx, 'mcp_reviewed', { server: name })
  sendJson(ctx.res, 200, { health })
}

/**
 * 模型 provider 只服务平台自己的任务执行器，配置和测试连接都限管理员。
 * 列表对所有登录身份可见，供任务表单选择 provider/model，但永远不返回 apiKey。
 */
function requireConfigAdmin(ctx: Ctx): void {
  const roles = ctx.auth.user?.roles ?? ctx.platform.requireActor(ctx.actorId).roles
  if (!roles.includes('admin')) throw new PlatformError('需要管理员权限', 403, 'forbidden')
}

async function listModelProviders(ctx: Ctx): Promise<void> {
  sendJson(ctx.res, 200, { providers: ctx.modelProviders ? await ctx.modelProviders.list() : [] })
}

async function saveModelProvider(ctx: Ctx): Promise<void> {
  requireConfigAdmin(ctx)
  if (!ctx.modelProviders) throw new PlatformError('当前没有模型 provider 存储', 409, 'conflict')
  const body = await readJson(ctx.req)
  if (ctx.params.id && body.name === undefined) body.name = ctx.params.id
  let provider
  try {
    provider = await ctx.modelProviders.upsert(body)
  } catch (error) {
    throw new PlatformError(error instanceof Error ? error.message : '模型 provider 不合法', 400, 'bad_request')
  }
  await auditConfig(ctx, 'model_provider_saved', {
    provider: provider.name,
    baseUrl: provider.baseUrl,
    ...(provider.apiKeyEnv ? { apiKeyEnv: provider.apiKeyEnv } : {}),
    models: provider.models,
    defaultModel: provider.defaultModel,
    enabled: provider.enabled,
    isDefault: provider.isDefault,
    hasApiKey: provider.hasApiKey,
  })
  sendJson(ctx.res, 200, { provider })
}

async function deleteModelProvider(ctx: Ctx): Promise<void> {
  requireConfigAdmin(ctx)
  if (!ctx.modelProviders) throw new PlatformError('当前没有模型 provider 存储', 409, 'conflict')
  const name = ctx.params.id ?? ''
  if (!(await ctx.modelProviders.remove(name))) {
    throw new PlatformError('模型 provider 不存在', 404, 'not_found')
  }
  await auditConfig(ctx, 'model_provider_deleted', { provider: name })
  sendJson(ctx.res, 200, { ok: true })
}

async function probeModelProvider(ctx: Ctx): Promise<void> {
  requireConfigAdmin(ctx)
  if (!ctx.models) throw new PlatformError('当前没有模型解析器', 409, 'conflict')
  const body = await readJson(ctx.req)
  try {
    const result = await ctx.models.probe(ctx.params.id ?? '', stringField(body, 'model'))
    sendJson(ctx.res, 200, { result })
  } catch (error) {
    throw new PlatformError(error instanceof Error ? error.message : '模型连接测试失败', 502, 'bad_gateway')
  }
}

async function discoverModelProvider(ctx: Ctx): Promise<void> {
  requireConfigAdmin(ctx)
  if (!ctx.models) throw new PlatformError('当前没有模型解析器', 409, 'conflict')
  try {
    const models = await ctx.models.discover(ctx.params.id ?? '')
    sendJson(ctx.res, 200, { models })
  } catch (error) {
    throw new PlatformError(error instanceof Error ? error.message : '拉取模型列表失败', 502, 'bad_gateway')
  }
}

/**
 * 通知配置：列表对登录用户可见（只返回 webhook host），写操作限管理员。
 * url 自带 token，任何响应、审计和日志都不能回显完整地址。
 */
async function listNotifications(ctx: Ctx): Promise<void> {
  if (!ctx.notifications) {
    sendJson(ctx.res, 200, {
      settings: { enabled: false, minIntervalMs: 0 },
      webhooks: [],
      types: NOTIFICATION_TYPES,
    })
    return
  }
  sendJson(ctx.res, 200, {
    settings: await ctx.notifications.settings(),
    webhooks: await ctx.notifications.list(),
    types: NOTIFICATION_TYPES,
  })
}

async function saveNotificationSettings(ctx: Ctx): Promise<void> {
  requireConfigAdmin(ctx)
  if (!ctx.notifications) throw new PlatformError('当前没有通知配置存储', 409, 'conflict')
  const body = await readJson(ctx.req)
  let settings
  try {
    settings = await ctx.notifications.updateSettings(body)
  } catch (error) {
    throw new PlatformError(error instanceof Error ? error.message : '通知设置不合法', 400, 'bad_request')
  }
  await auditConfig(ctx, 'notification_settings_saved', { ...settings })
  sendJson(ctx.res, 200, { settings })
}

async function saveNotificationWebhook(ctx: Ctx): Promise<void> {
  requireConfigAdmin(ctx)
  if (!ctx.notifications) throw new PlatformError('当前没有通知配置存储', 409, 'conflict')
  const body = await readJson(ctx.req)
  try {
    const webhook = ctx.params.id
      ? await ctx.notifications.update(ctx.params.id, body)
      : await ctx.notifications.create(body)
    await auditConfig(ctx, ctx.params.id ? 'notification_webhook_updated' : 'notification_webhook_created', {
      webhook: webhook.name,
      urlHost: webhook.urlHost,
      format: webhook.format,
      events: webhook.events,
      enabled: webhook.enabled,
    })
    sendJson(ctx.res, ctx.params.id ? 200 : 201, { webhook })
  } catch (error) {
    const message = error instanceof Error ? error.message : '通知 webhook 不合法'
    const missing = message === '通知 webhook 不存在'
    throw new PlatformError(message, missing ? 404 : 400, missing ? 'not_found' : 'bad_request')
  }
}

async function deleteNotificationWebhook(ctx: Ctx): Promise<void> {
  requireConfigAdmin(ctx)
  if (!ctx.notifications) throw new PlatformError('当前没有通知配置存储', 409, 'conflict')
  const id = ctx.params.id ?? ''
  // 告警源仍引用时拒绝删除，避免接入源保留一个永远发不出去的 id。
  const usedBy = (await ctx.platform.listAlertSources(ctx.actorId)).filter((source) =>
    source.notifyWebhookIds.includes(id),
  )
  if (usedBy.length > 0) {
    throw new PlatformError(
      `通知 webhook 正在被告警接入使用: ${usedBy.map((source) => source.name).join('、')}`,
      409,
      'conflict',
    )
  }
  if (!(await ctx.notifications.remove(id))) throw new PlatformError('通知 webhook 不存在', 404, 'not_found')
  await auditConfig(ctx, 'notification_webhook_deleted', { webhookId: id })
  sendJson(ctx.res, 200, { ok: true })
}

async function testNotificationWebhook(ctx: Ctx): Promise<void> {
  requireConfigAdmin(ctx)
  if (!ctx.notifier) throw new PlatformError('当前没有通知投递器', 409, 'conflict')
  const id = ctx.params.id ?? ''
  if (!(await ctx.notifications?.get(id))) throw new PlatformError('通知 webhook 不存在', 404, 'not_found')
  const result = await ctx.notifier.sendTest(id)
  await auditConfig(ctx, 'notification_webhook_tested', { webhook: result.webhook, ok: result.ok })
  sendJson(ctx.res, 200, { result })
}

async function search(ctx: Ctx): Promise<void> {
  const body = await readJson(ctx.req)
  const query = stringField(body, 'query') ?? ''
  const topK = body.top_k === undefined ? 5 : body.top_k
  if (typeof topK !== 'number') throw new PlatformError('top_k 必须是整数', 400, 'bad_request')
  sendJson(ctx.res, 200, { hits: await ctx.platform.searchKnowledge(ctx.actorId, query, topK) })
}

async function document(ctx: Ctx): Promise<void> {
  const body = await readJson(ctx.req)
  const doc = await ctx.platform.getDocument(ctx.actorId, stringField(body, 'doc_id') ?? '')
  sendJson(ctx.res, 200, { document: doc })
}

async function listAssets(ctx: Ctx): Promise<void> {
  sendJson(ctx.res, 200, { assets: await ctx.platform.listAssets(ctx.actorId) })
}

async function saveAsset(ctx: Ctx): Promise<void> {
  const body = await readJson(ctx.req)
  let sshPort: number | undefined
  if (body.sshPort !== undefined && body.sshPort !== null && body.sshPort !== '') {
    const value = typeof body.sshPort === 'number' ? body.sshPort : Number(body.sshPort)
    if (!Number.isInteger(value)) throw new PlatformError('sshPort 必须是整数', 400, 'bad_request')
    sshPort = value
  }
  const asset = await ctx.platform.saveAsset(ctx.actorId, {
    name: stringField(body, 'name') ?? '',
    owner: stringField(body, 'owner'),
    tier: stringField(body, 'tier'),
    host: stringField(body, 'host'),
    ip: stringField(body, 'ip'),
    env: stringField(body, 'env'),
    repo: stringField(body, 'repo'),
    note: stringField(body, 'note'),
    sshPort,
    sshUser: stringField(body, 'sshUser'),
    sshCredentialId: stringField(body, 'sshCredentialId'),
    sshPassword: stringField(body, 'sshPassword'),
    sshKey: stringField(body, 'sshKey'),
    sshPassphrase: stringField(body, 'sshPassphrase'),
    ...(body.sshReadPaths !== undefined ? { sshReadPaths: body.sshReadPaths as string[] } : {}),
  })
  await auditConfig(ctx, 'asset_saved', {
    name: asset.name,
    env: asset.env,
    tier: asset.tier,
    sshReadPaths: asset.sshReadPaths ?? [],
  })
  sendJson(ctx.res, 200, { asset })
}

async function importKnownHosts(ctx: Ctx): Promise<void> {
  const body = await readJson(ctx.req)
  if (typeof body.content !== 'string') {
    throw new PlatformError('content 必须是 known_hosts 文本', 400, 'bad_request')
  }
  const apply = body.apply === true
  const result = await ctx.platform.importKnownHosts(ctx.actorId, body.content, apply)
  await auditConfig(ctx, 'asset_known_hosts_imported', {
    apply,
    entries: result.entries,
    applied: result.applied.length,
    pending: result.pending.length,
    conflicts: result.conflicts.length,
    ambiguous: result.ambiguous.length,
  })
  sendJson(ctx.res, 200, result)
}

async function deleteAsset(ctx: Ctx): Promise<void> {
  const name = ctx.params.id ?? ''
  const deleted = await ctx.platform.deleteAsset(ctx.actorId, name)
  await auditConfig(ctx, 'asset_deleted', { name, deleted })
  sendJson(ctx.res, 200, { deleted })
}

/** 真实登录一次资产，验证凭证、主机密钥和跳板机链路；不执行命令。 */
async function testAssetSsh(ctx: Ctx): Promise<void> {
  const name = ctx.params.id ?? ''
  try {
    const result = await ctx.platform.testAssetSsh(ctx.actorId, name)
    await auditConfig(ctx, 'asset_ssh_tested', {
      name,
      ok: true,
      host: result.host,
      port: result.port,
      user: result.user,
      ...(result.jumps ? { jumps: result.jumps } : {}),
      latencyMs: result.latencyMs,
    })
    sendJson(ctx.res, 200, result)
  } catch (error) {
    await auditConfig(ctx, 'asset_ssh_tested', {
      name,
      ok: false,
      error: error instanceof Error ? error.message : '未知错误',
    })
    throw error
  }
}

async function probeAssetHostKey(ctx: Ctx): Promise<void> {
  const name = ctx.params.id ?? ''
  const result = await ctx.platform.probeAssetHostKey(ctx.actorId, name)
  sendJson(ctx.res, 200, result)
}

async function trustAssetHostKey(ctx: Ctx): Promise<void> {
  const name = ctx.params.id ?? ''
  const body = await readJson(ctx.req)
  const fingerprint = stringField(body, 'fingerprint')
  if (!fingerprint) throw new PlatformError('fingerprint 不能为空', 400, 'bad_request')
  const previousFingerprint = stringField(body, 'previousFingerprint')
  const asset = await ctx.platform.trustAssetHostKey(ctx.actorId, name, fingerprint, previousFingerprint)
  await auditConfig(ctx, 'asset_host_key_trusted', {
    name,
    fingerprint: asset.sshHostKeyFingerprint,
    ...(previousFingerprint ? { previousFingerprint } : {}),
  })
  sendJson(ctx.res, 200, { asset })
}

async function listCredentials(ctx: Ctx): Promise<void> {
  sendJson(ctx.res, 200, { credentials: await ctx.platform.listCredentials(ctx.actorId) })
}

async function saveCredential(ctx: Ctx): Promise<void> {
  const body = await readJson(ctx.req)
  const type = stringField(body, 'type') ?? ''
  if (type !== 'password' && type !== 'key') {
    throw new PlatformError('type 只能是 password 或 key', 400, 'bad_request')
  }
  const credential = await ctx.platform.saveCredential(ctx.actorId, {
    id: stringField(body, 'id'),
    name: stringField(body, 'name') ?? '',
    type,
    password: stringField(body, 'password'),
    privateKey: stringField(body, 'privateKey'),
    passphrase: stringField(body, 'passphrase'),
  })
  await auditConfig(ctx, 'credential_saved', {
    credentialId: credential.id,
    name: credential.name,
    type: credential.type,
  })
  sendJson(ctx.res, 200, { credential })
}

async function deleteCredential(ctx: Ctx): Promise<void> {
  const id = ctx.params.id ?? ''
  const deleted = await ctx.platform.deleteCredential(ctx.actorId, id)
  await auditConfig(ctx, 'credential_deleted', { credentialId: id, deleted })
  sendJson(ctx.res, 200, { deleted })
}

async function listKnowledgeDocuments(ctx: Ctx): Promise<void> {
  sendJson(ctx.res, 200, { docs: await ctx.platform.listKnowledgeDocuments(ctx.actorId) })
}

async function saveKnowledgeDocument(ctx: Ctx): Promise<void> {
  const body = await readJson(ctx.req)
  const rawActors = body.actors
  let actors: string[] | undefined
  if (typeof rawActors === 'string') {
    actors = rawActors.split(',').map((item) => item.trim()).filter(Boolean)
  } else if (Array.isArray(rawActors)) {
    actors = rawActors.filter((item): item is string => typeof item === 'string')
  } else if (rawActors !== undefined) {
    throw new PlatformError('actors 必须是字符串数组', 400, 'bad_request')
  }
  const input = {
    id: stringField(body, 'id') ?? '',
    title: stringField(body, 'title') ?? '',
    source: stringField(body, 'source') ?? '',
    content: stringField(body, 'content') ?? '',
    actors,
  }
  await ctx.platform.saveKnowledgeDocument(ctx.actorId, input)
  await auditConfig(ctx, 'knowledge_saved', { docId: input.id, title: input.title })
  sendJson(ctx.res, 200, { ok: true })
}

async function deleteKnowledgeDocument(ctx: Ctx): Promise<void> {
  const docId = ctx.params.id ?? ''
  const deleted = await ctx.platform.deleteKnowledgeDocument(ctx.actorId, docId)
  await auditConfig(ctx, 'knowledge_deleted', { docId, deleted })
  sendJson(ctx.res, 200, { deleted })
}

function requireInternal(ctx: Ctx): void {
  if (ctx.auth.method === 'api_key') return
  if (ctx.auth.method === 'session') throw new PlatformError('网页会话不能调用内部接口', 403, 'forbidden')
  const header = ctx.req.headers['x-internal-token']
  const token = typeof header === 'string' ? header : ''
  if (!sameToken(token, ctx.internalToken)) throw new PlatformError('内部令牌不正确', 401, 'unauthorized')
}

/** 远程 DSH：MCP Streamable HTTP。认证和 scope 由通用入口统一校验。 */
async function mcpRequest(ctx: Ctx): Promise<void> {
  await ctx.mcp.handle({ req: ctx.req, res: ctx.res, actorId: ctx.actorId })
}

async function toolCall(ctx: Ctx): Promise<void> {
  requireInternal(ctx)
  const body = await readJson(ctx.req)
  const tool = stringField(body, 'tool')
  if (!tool) throw new PlatformError('tool 不能为空', 400, 'bad_request')
  const args = body.args === undefined ? {} : body.args
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new PlatformError('args 必须是对象', 400, 'bad_request')
  const outcome = await ctx.platform.executeTool({
    actorId: ctx.actorId,
    tool,
    args: args as Record<string, unknown>,
    taskId: stringField(body, 'taskId'),
    approvalId: stringField(body, 'approvalId'),
  })
  sendJson(ctx.res, 200, outcome)
}

async function streamEvents(ctx: Ctx, taskId: string): Promise<void> {
  const existing = await ctx.platform.listEvents(ctx.actorId, taskId)
  ctx.res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  const sent = new Set<string>()
  const write = (event: TaskEvent) => {
    if (sent.has(event.id) || ctx.res.writableEnded) return
    sent.add(event.id)
    ctx.res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  }
  for (const event of existing) write(event)
  await new Promise<void>((resolve) => {
    let done = false
    let poll: ReturnType<typeof setTimeout> | undefined
    let limit: ReturnType<typeof setTimeout>
    const finish = () => {
      if (done) return
      done = true
      if (poll) clearTimeout(poll)
      clearTimeout(limit)
      if (!ctx.res.writableEnded) ctx.res.end()
      resolve()
    }
    const pump = async () => {
      if (done) return
      try {
        const [task, events] = await Promise.all([
          ctx.platform.getTask(ctx.actorId, taskId),
          ctx.platform.listEvents(ctx.actorId, taskId),
        ])
        for (const event of events) write(event)
        if (task.status === 'succeeded' || task.status === 'failed' || task.status === 'cancelled') finish()
        else poll = setTimeout(() => { void pump() }, 30)
      } catch {
        finish()
      }
    }
    limit = setTimeout(finish, 60_000)
    ctx.req.on('close', finish)
    void pump()
  })
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const parsed = await readJsonValue(req)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PlatformError('JSON 必须是对象', 400, 'bad_json')
  }
  return parsed as Record<string, unknown>
}

async function readJsonValue(req: IncomingMessage): Promise<unknown> {
  const text = await readBody(req)
  if (!text.trim()) return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new PlatformError('JSON 无法解析', 400, 'bad_json')
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 1_000_000) {
        reject(new PlatformError('请求体过大', 413, 'payload_too_large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new PlatformError(`${key} 必须是字符串`, 400, 'bad_request')
  return value
}

async function sendPage(res: ServerResponse, filename: string): Promise<void> {
  const file = path.resolve(WEB_ROOT, filename)
  if (!file.startsWith(`${WEB_ROOT}${path.sep}`)) throw new PlatformError('没有这个页面', 404, 'not_found')
  const body = await readFile(file)
  const type = filename.endsWith('.css')
    ? 'text/css; charset=utf-8'
    : filename.endsWith('.js')
      ? 'text/javascript; charset=utf-8'
      : filename.endsWith('.png')
        ? 'image/png'
        : 'text/html; charset=utf-8'
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' })
  res.end(body)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function alertToken(req: IncomingMessage): string {
  const header = req.headers.authorization
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7).trim()
  const direct = req.headers['x-aiops-token']
  return typeof direct === 'string' ? direct.trim() : ''
}

function sameToken(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  if (a.length === 0 || a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
