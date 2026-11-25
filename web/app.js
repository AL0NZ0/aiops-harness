const STATUS = {
  queued: '排队',
  running: '执行中',
  awaiting_approval: '待审批',
  succeeded: '完成',
  failed: '失败',
  cancelled: '已取消',
  pending: '待处理',
  approved: '已通过',
  rejected: '已拒绝',
}

const EVENTS = {
  'task.started': '任务开始',
  'skill.selected': '选定技能',
  'model.step': '模型推理',
  'model.delta': '模型输出',
  'model.retry': '模型重试',
  'tool.called': '调用工具',
  'tool.result': '工具返回',
  'approval.required': '等待审批',
  'approval.decided': '审批决定',
  'task.completed': '任务完成',
  'task.failed': '任务失败',
  'task.cancelled': '任务取消',
  'task.retried': '任务重试',
  'alert.notify': '告警结果通知',
}

const DECISIONS = {
  allowed: '放行',
  awaiting_approval: '等待审批',
  approved: '批准后执行',
  rejected: '审批拒绝',
  denied: '拒绝',
  error: '出错',
}

const RISK = {
  read: '只读',
  mutate: '变更',
}

const WEBHOOK_FORMATS = {
  dingtalk: '钉钉',
  wecom: '企业微信',
  generic: '通用 JSON',
}

const NOTIFICATION_EVENTS = {
  'approval.pending': '新审批',
  'approval.expired': '审批超时',
  'task.failed': '任务失败',
  'mcp.unhealthy': 'MCP 不可用',
  'mcp.recovered': 'MCP 恢复',
  'mcp.tools_changed': 'MCP 工具集变化',
  'asset.host_key_changed': 'SSH 主机密钥更换',
  'api_key.expiring': 'API Key 即将过期',
}

const SECURITY_EVENTS = {
  'auth.login_succeeded': '登录成功',
  'auth.login_failed': '登录失败',
  'auth.logout': '登出',
  'auth.session_revoked': '注销会话',
  'auth.sessions_revoked': '注销其他会话',
  'auth.password_changed': '修改密码',
  'auth.password_reset': '重置密码',
  'auth.user_created': '创建用户',
  'auth.user_updated': '修改用户',
  'auth.api_key_created': '签发 API Key',
  'auth.api_key_revoked': '吊销 API Key',
  'auth.api_key_used': '使用 API Key',
  'config.mcp_saved': '保存 MCP',
  'config.mcp_reviewed': '确认 MCP 工具集',
  'config.asset_saved': '保存资产',
  'config.asset_deleted': '删除资产',
  'config.credential_saved': '保存凭证',
  'config.credential_deleted': '删除凭证',
  'config.knowledge_saved': '保存知识文档',
  'config.knowledge_deleted': '删除知识文档',
  'config.model_provider_saved': '保存模型 Provider',
  'config.model_provider_deleted': '删除模型 Provider',
  'config.notification_settings_saved': '保存通知设置',
  'config.notification_webhook_created': '新增通知 Webhook',
  'config.notification_webhook_updated': '修改通知 Webhook',
  'config.notification_webhook_deleted': '删除通知 Webhook',
  'config.notification_webhook_tested': '测试通知 Webhook',
  'config.alert_source_saved': '保存告警接入',
  'config.alert_source_removed': '删除告警接入',
  'config.alert_source_token_rotated': '轮换告警接入 Token',
  'config.alert_source_tested': '测试告警接入',
  'config.mcp_unhealthy': 'MCP 不可用',
  'config.mcp_recovered': 'MCP 恢复',
  'config.mcp_tools_changed': 'MCP 工具集变化',
  'config.asset_host_key_changed': 'SSH 主机密钥更换',
}

const SYSTEMS = {
  prometheus: 'Prometheus',
  kubernetes: 'Kubernetes',
  loki: 'Loki',
  elasticsearch: 'Elasticsearch',
}

const VIEW_LABELS = {
  overview: '总览',
  tasks: '任务',
  approvals: '审批',
  knowledge: '知识库',
  'asset-list': '资产列表',
  'asset-manage': '资产管理',
  credentials: '密码私钥管理',
  tools: '工具',
  skills: '技能',
  mcp: 'MCP',
  model: '模型',
  notifications: '通知',
  'alert-sources': '告警接入',
  settings: '安全设置',
  keys: 'API Key',
  users: '用户管理',
  security: '安全事件',
}

const ASSET_VIEWS = ['asset-list', 'asset-manage', 'credentials']
const CAP_VIEWS = ['tools', 'skills', 'mcp', 'model', 'notifications', 'alert-sources']
const ACCOUNT_VIEWS = ['settings', 'keys', 'users', 'security']

const NAV_GROUPS = [
  { selector: '.nav-group.asset', sub: '#asset-subnav', toggle: '#asset-toggle', views: ASSET_VIEWS, first: 'asset-list' },
  { selector: '.nav-group.cap', sub: '#cap-subnav', toggle: '#cap-toggle', views: CAP_VIEWS, first: 'tools' },
  { selector: '.nav-group.account-nav', sub: '#account-subnav', toggle: '#account-toggle', views: ACCOUNT_VIEWS, first: 'settings' },
]

const TASK_STATUS_ORDER = ['queued', 'running', 'awaiting_approval', 'succeeded', 'failed', 'cancelled']

const EXAMPLES = [
  '排查 checkout-api CrashLoopBackOff',
  'payments-api CPU 飙高',
  '诊断 checkout-api 故障',
  '请重启 checkout-api',
]

const state = {
  actors: [],
  actorId: localStorage.getItem('aiops-actor') || 'alice',
  authMethod: '',
  csrfToken: '',
  me: null,
  allowAdminSelfApproval: false,
  users: [],
  loginLocks: [],
  keys: [],
  keyToken: '',
  keyTokenLabel: '',
  sessions: [],
  securityEvents: [],
  securityPage: 1,
  securityPageSize: 20,
  securityTotal: 0,
  view: 'overview',
  overview: null,
  overviewAt: 0,
  status: '',
  owner: '',
  topK: 5,
  tasks: [],
  taskIndex: {},
  taskPage: 1,
  taskPageSize: 20,
  taskTotal: 0,
  selectedId: '',
  // 每次切换任务自增，用来丢弃迟到的旧详情响应，避免把上一个任务的内容盖回来。
  taskSeq: 0,
  task: null,
  events: [],
  eventTotal: 0,
  audit: [],
  auditTotal: 0,
  pollPausedUntil: 0,
  taskApprovals: [],
  approvals: [],
  approvalPage: 1,
  approvalPageSize: 20,
  approvalTotal: 0,
  pending: [],
  pendingTotal: 0,
  approvalStatus: '',
  approvalFocus: '',
  approvalScrolled: '',
  hits: [],
  searched: false,
  documentId: '',
  document: null,
  docs: [],
  kbEditing: false,
  kbCreating: false,
  assets: [],
  credentials: [],
  tools: [],
  toolPolicies: [],
  // 工具分组展开状态，key 是分组键；没记录过的分组按工具数决定默认展开。
  toolGroups: {},
  skills: [],
  mcpServers: [],
  mcpErrors: [],
  mcpHealth: [],
  mcpNotice: '',
  mcpNoticeTone: '',
  mcpEditorOpen: false,
  modelProviders: [],
  modelProvidersLoaded: false,
  modelEditing: '',
  modelFormOpen: false,
  modelNotice: '',
  modelNoticeTone: '',
  notifications: { settings: { enabled: true, minIntervalMs: 60000 }, webhooks: [], types: [] },
  notificationsLoaded: false,
  notificationEditing: '',
  notificationFormOpen: false,
  notificationNotice: '',
  notificationNoticeTone: '',
  alertSources: [],
  alertSourcesLoaded: false,
  alertSourceEditing: '',
  alertSourceFormOpen: false,
  alertSourceNotice: '',
  alertSourceNoticeTone: '',
  alertSourceToken: '',
  alertSourcePath: '',
  errorSource: '',
  features: {},
  skillOptions: null,
  inflight: false,
}

const $ = (selector) => document.querySelector(selector)

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char])
}

/**
 * 极简 Markdown 渲染，只给任务结论用。先转义再解析，不认原始 HTML，
 * 链接只放行 http/https，保证模型输出带不进脚本。
 */
function renderMarkdown(value) {
  const source = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  if (!source.trim()) return ''
  const fences = []
  const withoutFences = source.replace(/```[^\n]*\n?([\s\S]*?)(?:```|$)/g, (_match, code) => {
    fences.push(`<pre class="md-code"><code>${esc(code.replace(/\n$/, ''))}</code></pre>`)
    return `\n\u0001${fences.length - 1}\u0001\n`
  })
  const lines = withoutFences.split('\n')
  const out = []
  let paragraph = []
  let list = null
  let quote = []
  const flushParagraph = () => {
    if (!paragraph.length) return
    out.push(`<p>${paragraph.map(mdInline).join('<br>')}</p>`)
    paragraph = []
  }
  const flushList = () => {
    if (!list) return
    out.push(`<${list.tag}>${list.items.map((item) => `<li>${mdInline(item)}</li>`).join('')}</${list.tag}>`)
    list = null
  }
  const flushQuote = () => {
    if (!quote.length) return
    out.push(`<blockquote>${quote.map(mdInline).join('<br>')}</blockquote>`)
    quote = []
  }
  const flushAll = () => {
    flushParagraph()
    flushList()
    flushQuote()
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const fence = line.match(/^\u0001(\d+)\u0001$/)
    if (fence) {
      flushAll()
      out.push(fences[Number(fence[1])] || '')
      continue
    }
    if (!line.trim()) {
      flushAll()
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      flushAll()
      const level = heading[1].length
      const tag = level === 1 ? 'h3' : level === 2 ? 'h4' : 'h5'
      out.push(`<${tag}>${mdInline(heading[2].trim())}</${tag}>`)
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushAll()
      out.push('<hr>')
      continue
    }
    // 表格要求下一行是分隔行（| --- | --- |），否则按普通段落处理。
    if (line.includes('|') && isTableSeparator(lines[index + 1] || '')) {
      flushAll()
      const header = mdRow(line)
      const aligns = mdRow(lines[index + 1]).map(tableAlign)
      const rows = []
      let cursor = index + 2
      while (cursor < lines.length && lines[cursor].includes('|') && lines[cursor].trim()) {
        rows.push(mdRow(lines[cursor]))
        cursor += 1
      }
      const cell = (tag, value, column) => `<${tag}${aligns[column] ? ` style="text-align:${aligns[column]}"` : ''}>${mdInline(value)}</${tag}>`
      out.push(
        `<table><thead><tr>${header.map((value, column) => cell('th', value, column)).join('')}</tr></thead>`
        + `<tbody>${rows.map((row) => `<tr>${row.map((value, column) => cell('td', value, column)).join('')}</tr>`).join('')}</tbody></table>`,
      )
      index = cursor - 1
      continue
    }
    const bullet = line.match(/^\s*[-*+]\s+(.+)$/)
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/)
    if (bullet || ordered) {
      flushParagraph()
      flushQuote()
      const tag = bullet ? 'ul' : 'ol'
      if (!list || list.tag !== tag) {
        flushList()
        list = { tag, items: [] }
      }
      list.items.push((bullet || ordered)[1])
      continue
    }
    const quoted = line.match(/^\s*>\s?(.*)$/)
    if (quoted) {
      flushParagraph()
      flushList()
      quote.push(quoted[1])
      continue
    }
    flushList()
    flushQuote()
    paragraph.push(line)
  }
  flushAll()
  return out.join('\n')
}

function mdRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
}

function isTableSeparator(line) {
  if (!line.includes('-')) return false
  const cells = mdRow(line)
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell))
}

function tableAlign(cell) {
  if (!/^:?-+:?$/.test(cell)) return ''
  if (cell.startsWith(':') && cell.endsWith(':')) return 'center'
  if (cell.endsWith(':')) return 'right'
  return 'left'
}

function mdInline(value) {
  const codes = []
  let text = esc(value).replace(/`([^`]+)`/g, (_match, code) => {
    codes.push(`<code>${code}</code>`)
    return `\u0002${codes.length - 1}\u0002`
  })
  text = text.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_match, label, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`,
  )
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  text = text.replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  text = text.replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
  return text.replace(/\u0002(\d+)\u0002/g, (_match, index) => codes[Number(index)] || '')
}

function when(iso) {
  if (!iso) return ''
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(iso))
}

function actor() {
  return state.actors.find((item) => item.id === state.actorId) || state.actors[0]
}

function actorName(id) {
  return state.actors.find((item) => item.id === id)?.name || id || ''
}

const ROLE_INFO = {
  viewer: '只读：看自己发起的任务和相关审批、检索知识；不能执行工具或提交任务。',
  operator: '运维：提交任务、执行只读工具；变更走审批；只看自己发起的任务。通常只配 API key，不登录网页。',
  approver: '审批：运维全部能力，并能审批别人名下的变更；看自己发起的和有审批记录的任务。必须设置密码。',
  auditor: '审计：只读查看全平台任务、事件、审批和审计记录；不能执行工具、不能审批、不能管理用户。必须设置密码。',
  admin: '管理员：全部权限，含用户、API key 和 MCP 管理；默认不能审批自己名下的变更，只有平台显式开启 AIOPS_ALLOW_ADMIN_SELF_APPROVAL 后才可自批。必须设置密码。',
}

function roleLabel(roles) {
  if (roles.includes('admin')) return '管理员'
  if (roles.includes('auditor')) return '审计'
  if (roles.includes('approver')) return '审批'
  if (roles.includes('operator')) return '运维'
  return '只读'
}

function originLabel(origin) {
  if (origin === 'dsh') return 'DSH'
  if (origin === 'api') return 'API'
  if (origin === 'alert') return '告警'
  return '网页'
}

function originPill(origin) {
  if (origin === 'dsh') return '<span class="pill dsh">DSH</span> '
  if (origin === 'api') return '<span class="pill dsh">API</span> '
  if (origin === 'alert') return '<span class="pill alert">告警</span> '
  return ''
}

function updateRoleHint() {
  const select = $('#user-role')
  const hint = $('#role-hint')
  if (!select || !hint) return
  hint.textContent = ROLE_INFO[select.value] || ''
}

function canSubmit(person) {
  return Boolean(person) && (person.roles.includes('operator') || person.roles.includes('approver') || person.roles.includes('admin'))
}

function canApprove(person, approval) {
  if (!person || approval.status !== 'pending') return false
  const approver = person.roles.includes('approver') || person.roles.includes('admin')
  if (person.id !== approval.ownerId) return approver
  // 自己名下的变更默认不能批；只有平台开启开关后 admin 才放行。
  return state.allowAdminSelfApproval === true && person.roles.includes('admin')
}

function canResume(person, approval) {
  if (!person || approval.status !== 'approved' || approval.consumed) return false
  return person.id === approval.ownerId || person.roles.includes('approver') || person.roles.includes('admin')
}

function canRetry(person, task) {
  if (!person || !task || task.status !== 'failed') return false
  const origin = task.origin || 'web'
  if (origin !== 'web') return false
  const operator = person.roles.includes('operator') || person.roles.includes('approver') || person.roles.includes('admin')
  if (!operator) return false
  return task.ownerId === person.id || person.roles.includes('admin')
}

function canCancel(person, task) {
  if (!person || !task) return false
  if (['succeeded', 'failed', 'cancelled'].includes(task.status)) return false
  return person.roles.includes('approver') || person.roles.includes('admin') ||
    (task.ownerId === person.id && person.roles.includes('operator'))
}

function canFinish(person, task) {
  if (!person || !task || !state.features.finishTask) return false
  if ((task.origin !== 'dsh' && task.origin !== 'api') || !['running', 'queued'].includes(task.status)) return false
  return person.roles.includes('approver') || person.roles.includes('admin') || task.ownerId === person.id
}

function findApproval(id) {
  return state.approvals.find((item) => item.id === id) || state.taskApprovals.find((item) => item.id === id)
}

async function api(method, pathname, body) {
  const headers = {
    ...(state.authMethod ? {} : { 'x-actor-id': state.actorId }),
    ...(state.csrfToken && method !== 'GET' ? { 'x-csrf-token': state.csrfToken } : {}),
    ...(body ? { 'content-type': 'application/json' } : {}),
  }
  const response = await fetch(pathname, {
    method,
    headers,
    credentials: 'same-origin',
    body: body ? JSON.stringify(body) : undefined,
  })
  if (response.status === 401 && state.authMethod) {
    redirectToLogin()
    throw new Error('登录已过期')
  }
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(data.error?.message || `请求失败 ${response.status}`)
    error.code = data.error?.code || ''
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after'))
      error.retryAfter = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 5
    }
    if (error.code === 'password_change_required') {
      if (state.me) state.me.mustChangePassword = true
      showError('请先在「安全设置」修改初始密码，完成前其它接口会被拒绝。')
      if (state.view !== 'settings') void switchView('settings')
    }
    throw error
  }
  return data
}

function paint(selector, key, html) {
  const node = $(selector)
  if (!node || node.dataset.paint === key) return
  node.dataset.paint = key
  node.innerHTML = html
}

function showError(message, source = 'user') {
  const node = $('#error')
  const text = message || ''
  const changed = node.hidden === Boolean(text) || node.textContent !== text
  node.hidden = !text
  node.textContent = text
  state.errorSource = text ? source : ''
  // 页面滚动较深时也能看到错误：只有新错误才滚动，轮询清空不会打扰。
  if (text && changed) node.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

/** 页面内提示：error/warn 用醒目底色并自动滚动到视野内，成功和中性提示保持普通样式。 */
function renderNotice(selector, message, tone = '') {
  const node = $(selector)
  if (!node) return
  const text = message || ''
  const signature = `${tone}|${text}`
  const changed = node.dataset.noticeSignature !== signature
  node.hidden = !text
  node.className = `notice${tone ? ' ' + tone : ''}`
  node.textContent = text
  if (!text) {
    delete node.dataset.noticeSignature
    return
  }
  node.dataset.noticeSignature = signature
  if (changed && (tone === 'error' || tone === 'warn')) {
    node.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
}

function renderActors() {
  // 账号模式只能以当前登录用户操作；state.actors 里的其他人只用于任务提交人显示。
  const visible = state.authMethod ? state.actors.filter((person) => person.id === state.actorId) : state.actors
  const html = visible.map((person) => `
    <button type="button" data-actor="${esc(person.id)}" class="${person.id === state.actorId ? 'active' : ''}" title="${esc(roleLabel(person.roles))}身份">
      ${esc(person.name)}
      <small>${roleLabel(person.roles)}</small>
    </button>
  `).join('')
  paint('#who', `${state.authMethod ? 'session' : 'header'}:${state.actorId}:${visible.map((person) => person.id).join('|')}`, html)
  const person = actor()
  $('#submit').disabled = !canSubmit(person)
  $('#submit').textContent = canSubmit(person) ? '提交任务' : '当前身份不能提交'
  for (const id of ['doc-submit', 'kb-new', 'asset-submit', 'credential-submit']) {
    const node = $(`#${id}`)
    if (node) node.disabled = !canSubmit(person)
  }
  syncAccountNav()
}

function renderPager(selector, page, size, total, kind) {
  const node = $(selector)
  if (!node) return
  const pages = Math.max(1, Math.ceil(total / size))
  if (total <= size) {
    node.hidden = true
    node.dataset.paint = ''
    node.innerHTML = ''
    return
  }
  node.hidden = false
  paint(selector, `${kind}:${page}:${pages}:${total}`, `
    <button type="button" class="ghost" data-page-kind="${kind}" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>上一页</button>
    <span class="muted">第 ${page}/${pages} 页 · 共 ${total} 条</span>
    <button type="button" class="ghost" data-page-kind="${kind}" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''}>下一页</button>
  `)
}

function overviewKpi({ label, value, sub, tone = '', view = '' }) {
  const tag = view ? 'button' : 'div'
  const action = view ? ` type="button" data-overview-view="${esc(view)}"` : ''
  return `<${tag} class="kpi ${tone}"${action}>
    <span class="kpi-label">${esc(label)}</span>
    <span class="kpi-value">${value}</span>
    <span class="kpi-sub">${esc(sub)}</span>
  </${tag}>`
}

function renderOverview() {
  const data = state.overview
  if (!data) {
    paint('#overview-kpis', 'loading', '<p class="overview-empty">正在汇总平台状态…</p>')
    return
  }
  const operator = canSubmit(actor())
  const counts = data.tasks.byStatus || {}
  const active = (counts.queued || 0) + (counts.running || 0) + (counts.awaiting_approval || 0)
  const pending = data.approvals.pending || 0
  const tools = data.tools || { total: 0, read: 0, mutate: 0, mcp: 0 }
  const assets = data.assets || { total: 0, untrusted: 0 }
  const mcp = data.mcp
  const documents = data.knowledge ? data.knowledge.documents : null
  $('#overview-stamp').textContent = `更新于 ${when(data.generatedAt)}`

  let mcpValue = '—'
  let mcpSub = '当前身份不可见'
  let mcpTone = 'muted'
  let mcpView = ''
  if (mcp) {
    mcpView = 'mcp'
    if (mcp.servers === 0) {
      mcpSub = '还没有配置 MCP 连接'
    } else if (mcp.unchecked === mcp.servers) {
      mcpValue = '<span class="kpi-text">待检测</span>'
      mcpSub = '后台健康巡检尚未返回'
    } else {
      mcpValue = `${mcp.ok}<small>/${mcp.servers}</small>`
      const facts = []
      if (mcp.unhealthy) facts.push(`异常 ${mcp.unhealthy}`)
      if (mcp.reviewRequired) facts.push(`待复核 ${mcp.reviewRequired}`)
      if (mcp.unchecked) facts.push(`未检测 ${mcp.unchecked}`)
      mcpSub = facts.join(' · ') || '全部正常'
      mcpTone = mcp.unhealthy ? 'bad' : mcp.reviewRequired || mcp.unchecked ? 'warn' : 'ok'
    }
  }

  const kpis = [
    overviewKpi({
      label: '待处理审批',
      value: `${pending}<small>件</small>`,
      sub: pending ? '等待审批人处理' : '当前没有待处理审批',
      tone: pending ? 'warn' : 'ok',
      view: 'approvals-pending',
    }),
    overviewKpi({
      label: '活跃任务',
      value: `${active}<small>个</small>`,
      sub: `共 ${data.tasks.total} 个任务 · 按当前身份可见`,
      tone: active ? '' : 'ok',
      view: 'tasks',
    }),
    overviewKpi({
      label: '知识文档',
      value: documents === null ? '—' : `${documents}<small>篇</small>`,
      sub: documents === null ? (operator ? '暂时读不到文档' : '当前身份不可见') : '本地知识文档',
      tone: documents === null ? 'muted' : '',
      view: operator ? 'knowledge' : '',
    }),
    overviewKpi({
      label: 'MCP 健康',
      value: mcpValue,
      sub: mcpSub,
      tone: mcpTone,
      view: mcpView,
    }),
  ]
  paint(
    '#overview-kpis',
    JSON.stringify([pending, active, data.tasks.total, documents, mcp, tools, assets, operator]),
    kpis.join(''),
  )

  const approvals = data.approvals.recent || []
  const approvalHtml = approvals.length
    ? approvals.map((approval) => `
      <button type="button" class="overview-entry" data-overview-approval="${esc(approval.id)}">
        <span class="overview-entry-main">
          <strong>${esc(approval.tool)}</strong>
          <span class="meta">${esc(actorName(approval.ownerId))} · ${esc(when(approval.requestedAt))}</span>
        </span>
        <span class="pill pending">待处理</span>
      </button>
    `).join('')
    : '<p class="overview-empty">当前没有待处理审批。</p>'
  paint(
    '#overview-approvals',
    approvals.map((approval) => `${approval.id}:${approval.status}`).join('|') || 'empty',
    approvalHtml,
  )

  const recent = data.tasks.recent || []
  const taskHtml = recent.length
    ? recent.map((task) => `
      <button type="button" class="overview-entry" data-overview-task="${esc(task.id)}">
        <span class="overview-entry-main">
          <strong>${esc(task.title)}</strong>
          <span class="meta">${originLabel(task.origin)} · ${esc(actorName(task.ownerId))} · ${esc(when(task.updatedAt || task.createdAt))}</span>
        </span>
        <span class="pill ${esc(task.status)}">${STATUS[task.status] || esc(task.status)}</span>
      </button>
    `).join('')
    : '<p class="overview-empty">还没有任务。</p>'
  paint(
    '#overview-tasks',
    recent.map((task) => `${task.id}:${task.status}:${task.updatedAt}`).join('|') || 'empty',
    taskHtml,
  )

  const total = data.tasks.total || 0
  const segments = total > 0
    ? TASK_STATUS_ORDER
        .filter((status) => counts[status])
        .map((status) => `<span class="status-seg ${esc(status)}" style="width:${(counts[status] / total) * 100}%" title="${STATUS[status]} ${counts[status]}"></span>`)
        .join('')
    : ''
  const legend = TASK_STATUS_ORDER.map((status) => `
    <button type="button" data-overview-status="${esc(status)}">
      <span class="status-dot ${esc(status)}"></span>${STATUS[status]}
      <strong>${counts[status] || 0}</strong>
    </button>
  `).join('')
  const facts = [
    { label: '工具', value: tools.total, sub: `只读 ${tools.read} · 变更 ${tools.mutate} · MCP ${tools.mcp}` },
    { label: 'MCP 连接', value: mcp ? mcp.servers : '—', sub: mcp ? `正常 ${mcp.ok} · 异常 ${mcp.unhealthy}` : '当前身份不可见' },
    { label: '资产', value: assets.total, sub: `主机密钥未信任 ${assets.untrusted}` },
    { label: '任务', value: total, sub: `活跃 ${active}` },
  ]
  paint(
    '#overview-facts-body',
    JSON.stringify([total, counts, legend, facts]),
    `
      ${total > 0
        ? `<div class="status-track">${segments}</div><div class="status-legend">${legend}</div>`
        : '<p class="overview-empty">还没有任务，提交一次排查后会在这里显示状态分布。</p>'}
      <div class="fact-grid">
        ${facts.map((fact) => `
          <div class="fact">
            <span>${esc(fact.label)}</span>
            <strong>${esc(fact.value)}</strong>
            <small>${esc(fact.sub)}</small>
          </div>
        `).join('')}
      </div>
    `,
  )
}

function renderTasks() {
  const filtered = state.status || state.owner
  const html = state.tasks.length ? state.tasks.map((task) => `
    <button type="button" class="item ${task.id === state.selectedId ? 'active' : ''}" data-task="${esc(task.id)}">
      <strong>${esc(task.title)}</strong>
      <div class="meta">${originPill(task.origin)}<span class="pill ${esc(task.status)}">${STATUS[task.status] || esc(task.status)}</span> ${esc(task.skill)} · ${esc(actorName(task.ownerId))}</div>
    </button>
  `).join('') : `<p class="empty">${filtered ? '没有符合筛选条件的任务。' : '还没有任务。上面写一句排查说明即可。'}</p>`
  const key = state.tasks.map((task) => `${task.id}:${task.status}:${task.id === state.selectedId}`).join('|') || (filtered ? 'filtered' : 'empty')
  paint('#task-list', key, html)
  renderPager('#task-pager', state.taskPage, state.taskPageSize, state.taskTotal, 'task')
}

function briefArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return ''
  return Object.entries(args)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ')
}

function eventLine(event) {
  const data = event.data || {}
  if (event.type === 'tool.called') return `${data.tool || ''}${data.args ? ` · ${briefArgs(data.args)}` : ''}`
  if (event.type === 'tool.result') return data.error ? `${data.tool || ''} 失败：${data.error}` : `${data.tool || ''} 已返回`
  if (event.type === 'approval.required') return `${data.tool || ''} 需要审批`
  if (event.type === 'approval.decided') return `${actorName(data.decidedBy)} ${STATUS[data.status] || data.status || ''}`.trim()
  if (event.type === 'skill.selected') return data.skill || ''
  if (event.type === 'task.started') {
    const model = [data.provider, data.model].filter(Boolean).join(' / ')
    return model ? `模型 ${model}` : data.mode === 'playbook' ? '固定 playbook' : ''
  }
  if (event.type === 'model.step') {
    const tools = Array.isArray(data.tools) ? data.tools.join(', ') : ''
    const tokens = data.totalTokens ? ` · ${data.totalTokens} tokens` : ''
    const cost = data.cost !== undefined ? ` · ${data.cost} ${data.currency || ''}`.trimEnd() : ''
    return `第 ${data.step || '?'} 轮${tools ? ` · ${tools}` : ''}${tokens}${cost}`
  }
  if (event.type === 'model.retry') {
    return `第 ${data.attempt || '?'} 次重试，${data.delayMs || 0}ms 后：${data.message || ''}`
  }
  if (event.type === 'alert.notify') {
    if (data.error) return `发送失败：${data.error}`
    const deliveries = Array.isArray(data.webhooks) ? data.webhooks : []
    if (deliveries.length === 0) return '没有投递到任何渠道，检查通知全局开关、渠道启用状态和告警源选择'
    return deliveries
      .map((item) => `${item.webhook || '未知渠道'} ${item.ok ? '已发送' : `失败${item.error ? `：${item.error}` : ''}`}`)
      .join('；')
  }
  if (event.type === 'task.failed') return data.error || ''
  if (event.type === 'task.retried') {
    const from = data.fromTaskId ? `来自任务 ${data.fromTaskId}` : ''
    return data.fromRejectedApproval ? `${from}（原任务审批被拒，本次按新请求处理）` : from
  }
  return ''
}

function detailsBlock(summary, text) {
  return `<details class="event-detail"><summary>${esc(summary)}</summary><pre class="event">${esc(text)}</pre></details>`
}

function approvalInline(approvalId) {
  const approval = findApproval(approvalId)
  if (!approval) return ''
  return `
    <div class="inline-approval">
      <div class="meta"><span class="pill ${esc(approval.status)}">${STATUS[approval.status] || esc(approval.status)}</span> <strong>${esc(approval.tool)}</strong></div>
      <pre class="event">${esc(JSON.stringify(approval.args, null, 2))}</pre>
      <button type="button" class="link" data-open-approval="${esc(approvalId)}">到审批页处理</button>
    </div>
  `
}

function eventDetail(event) {
  const data = event.data || {}
  const parts = []
  if (event.type === 'tool.called' && data.args) parts.push(detailsBlock('调用参数', JSON.stringify(data.args, null, 2)))
  if (event.type === 'tool.result' && data.result !== undefined) parts.push(detailsBlock('工具返回', JSON.stringify(data.result, null, 2)))
  if (event.type === 'tool.result' && data.error) parts.push(`<pre class="event bad">${esc(data.error)}</pre>`)
  if (event.type === 'alert.notify' && data.webhooks !== undefined) {
    parts.push(detailsBlock('投递结果', JSON.stringify(data.webhooks, null, 2)))
  }
  if (event.type === 'approval.required' && data.approvalId) parts.push(approvalInline(String(data.approvalId)))
  return parts.join('')
}

function renderDetail() {
  const task = state.task
  if (!task) {
    paint('#task-detail', 'none', '<p class="empty">选择一条任务，查看证据、过程和审计。</p>')
    return
  }
  // 已经切到别的任务但详情还没回来时，别把上一个任务的内容挂在当前选中项下面。
  if (state.selectedId && task.id !== state.selectedId) {
    paint('#task-detail', `loading:${state.selectedId}`, '<p class="empty">正在加载任务详情…</p>')
    return
  }
  const person = actor()
  const streamed = state.events
    .filter((event) => event.type === 'model.delta')
    .map((event) => String(event.data?.text || ''))
    .join('')
  const streamPanel = streamed
    ? `<details class="event-detail"><summary>模型实时输出（最近片段）</summary><pre class="event">${esc(streamed)}</pre></details>`
    : ''
  const timelineEvents = state.events.filter((event) => event.type !== 'model.delta')
  const timeline = timelineEvents.length ? timelineEvents.map((event) => `
    <li>
      <span class="muted">${esc(when(event.at))}</span>
      <div class="timeline-body">
        <div>${esc(EVENTS[event.type] || event.type)} <span>${esc(eventLine(event))}</span></div>
        ${eventDetail(event)}
      </div>
    </li>
  `).join('') : '<li><span></span><span class="muted">还没有过程记录</span></li>'
  const audit = state.audit.length ? state.audit.map((item) => `
    <div class="audit-row">
      <span class="muted">${esc(when(item.at))}</span>
      <div class="timeline-body">
        <div><span class="pill ${esc(item.risk)}">${RISK[item.risk] || esc(item.risk)}</span> <strong>${esc(item.tool)}</strong> · ${esc(DECISIONS[item.decision] || item.decision)} · ${esc(actorName(item.actorId))}${item.approvalId ? ` · ${esc(item.approvalId)}` : ''}</div>
        <details class="event-detail"><summary>参数</summary><pre class="event">${esc(JSON.stringify(item.args ?? {}, null, 2))}</pre></details>
      </div>
    </div>
  `).join('') : '<p class="muted">还没有工具调用。</p>'
  const actions = [
    canFinish(person, task) ? `<button type="button" class="ghost" data-finish="${esc(task.id)}">标记完成</button>` : '',
    canRetry(person, task) ? `<button type="button" class="primary" data-retry="${esc(task.id)}">重试任务</button>` : '',
    canCancel(person, task) ? `<button type="button" class="ghost" data-cancel="${esc(task.id)}">取消任务</button>` : '',
  ].filter(Boolean).join('')
  const html = `
    <div class="detail-head">
      <div class="meta">${originPill(task.origin)}<span class="pill ${esc(task.status)}">${STATUS[task.status] || esc(task.status)}</span> ${esc(task.skill)} · ${esc(actorName(task.ownerId))} · ${esc(when(task.createdAt))}</div>
      ${actions ? `<div class="detail-actions">${actions}</div>` : ''}
    </div>
    <h2>${esc(task.title)}</h2>
    <p class="prompt">${esc(task.prompt)}</p>
    <p class="meta">任务号 ${esc(task.id)}${task.updatedAt ? ` · 更新 ${esc(when(task.updatedAt))}` : ''}${task.usage ? ` · ${task.usage.calls} 次模型调用 · ${task.usage.promptTokens} 输入 / ${task.usage.completionTokens} 输出 tokens${task.usage.cost !== undefined ? ` · 约 ${task.usage.cost} ${task.usage.currency || ''}`.trimEnd() : ''}` : ''}</p>
    ${streamPanel}
    ${task.result ? `<div class="result markdown">${renderMarkdown(task.result)}</div>` : ''}
    ${task.error ? `<p class="error">${esc(task.error)}</p>` : ''}
    <h2>过程</h2>
    <ul class="timeline">${timeline}</ul>
    ${state.eventTotal > state.events.length ? `<p class="muted">仅显示最近 ${state.events.length} 条过程，共 ${state.eventTotal} 条。</p>` : ''}
    <h2>审计</h2>
    ${audit}
    ${state.auditTotal > state.audit.length ? `<p class="muted">仅显示最近 ${state.audit.length} 条审计，共 ${state.auditTotal} 条。</p>` : ''}
  `
  const approvalKey = [...state.approvals, ...state.taskApprovals].map((item) => `${item.id}:${item.status}`).join('|')
  const key = `${task.id}:${task.status}:${task.updatedAt}:${JSON.stringify(task.usage || null)}:${state.events.at(-1)?.id || ''}:${state.events.length}:${state.audit.length}:${approvalKey}`
  paint('#task-detail', key, html)
}

function renderApprovals() {
  const person = actor()
  const rows = state.approvals.filter((item) => !state.approvalStatus || item.status === state.approvalStatus)
  const html = rows.length ? rows.map((approval) => {
    const allowed = canApprove(person, approval)
    const reason = approval.status !== 'pending'
      ? ''
      : person?.id === approval.ownerId
        ? (allowed ? '' : '不能审批自己提交的变更')
        : person?.roles.includes('approver')
          ? ''
          : '当前身份不能审批'
    const task = state.taskIndex[approval.taskId]
    return `
      <article class="card ${state.approvalFocus === approval.id ? 'focus' : ''}" data-approval="${esc(approval.id)}">
        <div class="meta"><span class="pill ${esc(approval.status)}">${STATUS[approval.status] || esc(approval.status)}</span> <span class="pill mutate">变更</span> ${esc(when(approval.requestedAt))}</div>
        <strong>${esc(approval.tool)}</strong>
        <p class="meta">${task ? `任务「${esc(task.title)}」` : `任务 ${esc(approval.taskId)}`} · 提交人 ${esc(actorName(approval.ownerId))}</p>
        <pre class="event">${esc(JSON.stringify(approval.args, null, 2))}</pre>
        ${approval.comment ? `<p>意见：${esc(approval.comment)}</p>` : ''}
        ${approval.decidedBy ? `<p class="meta">由 ${esc(actorName(approval.decidedBy))} 于 ${esc(when(approval.decidedAt))} 处理</p>` : ''}
        ${allowed ? `<label>审批意见<textarea data-comment rows="2" placeholder="写给审计记录"></textarea></label>` : ''}
        <div class="card-actions">
          ${allowed ? '<button type="button" class="primary" data-decision="approved">通过</button><button type="button" class="danger" data-decision="rejected">拒绝</button>' : ''}
          ${canResume(person, approval) ? `<button type="button" class="primary" data-resume-approval="${esc(approval.id)}">继续执行</button>` : ''}
          <button type="button" class="ghost" data-jump-task="${esc(approval.taskId)}">查看任务</button>
        </div>
        ${!allowed && reason ? `<p class="muted">${esc(reason)}</p>` : ''}
      </article>
    `
  }).join('') : `<p class="empty">${state.approvalStatus === 'pending' ? '没有待处理的审批。' : '这个列表是空的。'}</p>`
  const key = `${state.approvalStatus}:${state.actorId}:${state.approvalFocus}:${state.approvals.map((item) => `${item.id}:${item.status}`).join('|')}`
  paint('#approval-list', key, html)
  renderPager('#approval-pager', state.approvalPage, state.approvalPageSize, state.approvalTotal, 'approval')
  if (state.approvalFocus && state.approvalScrolled !== state.approvalFocus) {
    const node = $(`[data-approval="${state.approvalFocus}"]`)
    state.approvalScrolled = state.approvalFocus
    node?.scrollIntoView({ block: 'center' })
  }
}

function knowledgeItem(doc) {
  const active = doc.docId === state.documentId ? 'active' : ''
  if (state.searched) {
    return `
      <button type="button" class="item ${active}" data-doc="${esc(doc.docId)}">
        <strong>${esc(doc.title)}</strong>
        <p>${esc(doc.snippet)}</p>
        <div class="meta">${esc(doc.source)} · ${esc(doc.score)}</div>
      </button>
    `
  }
  const text = String(doc.content || '').replace(/\s+/g, ' ').trim()
  const preview = text.length > 90 ? `${text.slice(0, 90)}…` : text
  return `
    <button type="button" class="item ${active}" data-doc="${esc(doc.docId)}">
      <strong>${esc(doc.title)}</strong>
      <p>${esc(preview)}</p>
      <div class="meta">${esc(doc.source)}${doc.actors?.length ? ` · ${esc(doc.actors.join('、'))}` : ''}</div>
    </button>
  `
}

function renderKnowledge() {
  const items = state.searched ? state.hits : state.docs
  const html = items.length
    ? items.map(knowledgeItem).join('')
    : `<p class="empty">${state.searched ? '没有匹配的文档。' : '还没有文档，点「新建文档」写一篇。'}</p>`
  const key = `${state.searched ? 'hits' : 'docs'}:${items.map((item) => item.docId).join('|') || 'empty'}:${state.documentId}`
  paint('#hits', key, html)
  $('#kb-list-title').textContent = state.searched ? '搜索结果' : '全部文档'
  $('#kb-list-meta').textContent = state.searched ? `${items.length} 条` : `${items.length} 篇`
  $('#kb-clear').hidden = !state.searched
  renderKnowledgePanel()
}

function renderKnowledgePanel() {
  const form = $('#doc-form')
  const editing = state.kbEditing
  form.hidden = !editing
  $('#doc').hidden = editing
  if (editing) {
    $('#doc-form-title').textContent = state.kbCreating ? '新建文档' : '编辑文档'
    return
  }
  if (!state.document) {
    paint('#doc', 'placeholder', `
      <div class="kb-placeholder">
        <strong>选择左侧文档查看全文</strong>
        <p>搜索关键词会同时查本地和外部知识库；点「新建文档」维护本地 Markdown。</p>
      </div>
    `)
    return
  }
  const doc = state.document
  const meta = doc.meta || {}
  const local = state.docs.find((item) => item.docId === state.documentId)
  const title = local?.title || meta.title || state.documentId
  const actions = local
    ? `<div class="kb-doc-actions">
        <button type="button" class="ghost" data-edit-doc="${esc(local.docId)}">编辑</button>
        <button type="button" class="danger" data-delete-doc="${esc(local.docId)}">删除</button>
      </div>`
    : ''
  paint('#doc', `${state.documentId}:${local ? 'local' : 'external'}`, `
    <div class="meta">${esc(doc.source)}${state.documentId ? ` · ${esc(state.documentId)}` : ''}${local?.actors?.length ? ` · ${esc(local.actors.join('、'))}` : ''}</div>
    <div class="kb-doc-head">
      <h2>${esc(title)}</h2>
      ${actions}
    </div>
    <pre class="doc">${esc(doc.content)}</pre>
  `)
}

const TOOL_GROUP_META = {
  knowledge: { label: '知识库', hint: '本地 Markdown 与外部知识 provider' },
  asset: { label: '资产', hint: '主机资产与连接方式' },
  ssh: { label: 'SSH', hint: '远程执行，内置能力里风险最高' },
}
const TOOL_GROUP_ORDER = { knowledge: 0, asset: 1, ssh: 2 }

/** mcp.<server>.<tool> 里取出 server；server 名本身可能带点，优先按已注册的 server 匹配。 */
function mcpServerOf(name) {
  const rest = name.startsWith('mcp.') ? name.slice(4) : name
  const servers = (state.mcpServers || []).map((item) => item.name).sort((a, b) => b.length - a.length)
  const matched = servers.find((server) => rest.startsWith(`${server}.`))
  if (matched) return matched
  const cut = rest.lastIndexOf('.')
  return cut > 0 ? rest.slice(0, cut) : '未命名'
}

/** 工具按能力域和上游 server 分组；组内按生效风险统计（人工覆盖生效时算覆盖后的）。 */
function groupTools(tools, policies) {
  const groups = new Map()
  for (const tool of tools) {
    const builtin = !tool.name.startsWith('mcp.')
    const ns = builtin ? tool.name.split('.')[0] : mcpServerOf(tool.name)
    const meta = builtin ? TOOL_GROUP_META[ns] : undefined
    const key = builtin ? `builtin:${ns}` : `mcp:${ns}`
    let group = groups.get(key)
    if (!group) {
      group = {
        key,
        label: builtin ? (meta?.label || `内置 · ${ns}`) : `MCP · ${ns}`,
        hint: builtin ? (meta ? `平台内置 · ${meta.hint}` : '平台内置') : '上游 MCP server',
        order: builtin ? (TOOL_GROUP_ORDER[ns] ?? 50) : 100,
        tools: [],
        read: 0,
        mutate: 0,
      }
      groups.set(key, group)
    }
    const policy = policies[tool.name]
    if ((policy && policy.active ? policy.risk : tool.risk) === 'mutate') group.mutate += 1
    else group.read += 1
    group.tools.push(tool)
  }
  return [...groups.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label, 'zh-CN'))
}

function toolCard(tool, policies, policiesReady, admin) {
    const props = Object.entries(tool.parameters?.properties || {})
    const required = new Set(Array.isArray(tool.parameters?.required) ? tool.parameters.required : [])
    const params = props.length ? `
      <details class="event-detail">
        <summary>参数 ${props.length}</summary>
        <ul class="params">
          ${props.map(([name, spec]) => `<li><code>${esc(name)}</code> <span class="muted">${esc(spec?.type || '')}${required.has(name) ? ' · 必填' : ''}</span>${spec?.description ? ` <span class="muted">${esc(spec.description)}</span>` : ''}</li>`).join('')}
        </ul>
      </details>
    ` : '<p class="meta">无参数</p>'
    const policy = policies[tool.name]
    const isMcp = tool.name.startsWith('mcp.')
    const baseRisk = policy?.baseRisk || tool.risk
    const source = policy
      ? `<span class="pill">${policy.active ? '人工' : '已失效'}</span>`
      : '<span class="muted">默认</span>'
    const stale = policy && !policy.active && !policy.missing
      ? '<span class="warn-text">上游工具已变化，策略未生效，请重新设置</span>'
      : ''
    const control = isMcp && policiesReady ? (admin ? `
      <label class="muted tool-policy">审批策略
        <select data-tool-risk="${esc(tool.name)}">
          <option value="" ${policy ? '' : 'selected'}>跟随默认（${RISK[baseRisk] || esc(baseRisk)}）</option>
          <option value="read" ${policy?.risk === 'read' ? 'selected' : ''}>只读（不审批）</option>
          <option value="mutate" ${policy?.risk === 'mutate' ? 'selected' : ''}>变更（走审批）</option>
        </select>
      </label>
      ${stale}
    ` : (policy ? `<p class="meta">审批策略：人工设为${RISK[policy.risk] || esc(policy.risk)}${policy.active ? '' : '（已失效）'}</p>` : '')) : ''
    return `
      <article class="card">
        <div class="meta"><span class="pill ${esc(tool.risk)}">${RISK[tool.risk] || esc(tool.risk)}</span>${isMcp ? source : ''}</div>
        <strong>${esc(tool.name)}</strong>
        <p>${esc(tool.description)}</p>
        ${control}
        ${params}
      </article>
    `
}

function renderTools() {
  const admin = isAdmin()
  const policiesReady = Array.isArray(state.toolPolicies)
  const policies = Object.fromEntries((policiesReady ? state.toolPolicies : []).map((item) => [item.tool, item]))
  const groups = groupTools(state.tools, policies)
  const notices = []
  if (!policiesReady) {
    notices.push(`
      <article class="card">
        <strong>审批策略加载失败</strong>
        <p class="meta">暂时读不到逐工具策略，已禁用修改，避免把已有覆盖当成默认值误删。刷新页面重试。</p>
      </article>
    `)
  }
  const missing = (state.toolPolicies || []).filter((item) => item.missing)
  if (missing.length) {
    notices.push(`
      <article class="card">
        <strong>失效的工具策略</strong>
        <p class="meta">这些工具当前不在平台工具清单里，策略不会生效；重新接入后签名一致会自动恢复。</p>
        <ul class="params">
          ${missing.map((item) => `<li><code>${esc(item.tool)}</code> <span class="muted">${RISK[item.risk] || esc(item.risk)}</span>${admin ? ` <button type="button" class="link danger" data-clear-tool-policy="${esc(item.tool)}">清除</button>` : ''}</li>`).join('')}
        </ul>
      </article>
    `)
  }
  const groupsHtml = groups.map((group) => {
    // 展开状态记在 state 里，重新渲染后保持；工具多的组默认收起，避免一屏全是卡片。
    const open = state.toolGroups[group.key] ?? group.tools.length <= 12
    const stats = [
      `<span class="muted">${group.tools.length} 个工具</span>`,
      group.read ? `<span class="pill read">只读 ${group.read}</span>` : '',
      group.mutate ? `<span class="pill mutate">变更 ${group.mutate}</span>` : '',
    ].filter(Boolean).join('')
    return `
      <details class="tool-group" data-group="${esc(group.key)}" ${open ? 'open' : ''}>
        <summary>
          <span class="tool-group-title">${esc(group.label)}<small>${esc(group.hint)}</small></span>
          <span class="tool-group-stats">${stats}</span>
        </summary>
        <div class="tool-group-body">
          <div class="tool-grid">${group.tools.map((tool) => toolCard(tool, policies, policiesReady, admin)).join('')}</div>
        </div>
      </details>
    `
  }).join('')
  const summary = $('#tool-summary')
  if (summary) {
    const builtin = state.tools.filter((tool) => !tool.name.startsWith('mcp.')).length
    summary.textContent = state.tools.length
      ? `${state.tools.length} 个工具 · ${groups.length} 个分组（内置 ${builtin} · 上游 MCP ${state.tools.length - builtin}）`
      : ''
  }
  const key = `${admin}:${JSON.stringify(state.tools)}:${JSON.stringify(state.toolPolicies)}:${JSON.stringify((state.mcpServers || []).map((item) => item.name))}`
  paint('#tools', key, [...notices, groupsHtml].join('') || '<p class="empty">还没有注册工具。</p>')
}

function renderSkills() {
  paint('#skills', state.skills.map((skill) => JSON.stringify(skill)).join('|') || 'empty', state.skills.map((skill) => `
    <article class="card">
      <strong>${esc(skill.name)}</strong>
      <p>${esc(skill.description)}</p>
      <p class="meta">${esc((skill.keywords || []).join('、'))}</p>
      <details><summary>排查说明</summary><pre class="doc">${esc(skill.body)}</pre></details>
    </article>
  `).join(''))
}

function renderMcp() {
  const writable = canSubmit(actor())
  const servers = state.mcpServers || []
  const healthByName = Object.fromEntries((state.mcpHealth || []).map((item) => [item.name, item]))
  const rows = servers.length ? servers.map((server) => {
    const health = healthByName[server.name]
    const healthText = !health ? '未检测' : health.reviewRequired ? '需复核' : health.ok ? '正常' : '异常'
    const healthClass = !health ? 'muted' : health.reviewRequired ? 'warn-text' : health.ok ? 'ok-text' : 'error-text'
    const changes = health?.changedTools
    const changeParts = changes ? [
      changes.added?.length ? `新增 ${changes.added.join('、')}` : '',
      changes.removed?.length ? `移除 ${changes.removed.join('、')}` : '',
      changes.updated?.length ? `变更 ${changes.updated.join('、')}` : '',
    ].filter(Boolean) : []
    const healthDetail = health?.error
      || (health?.reviewRequired ? `上游工具集已变化，请复核风险分类后确认：${changeParts.join('；') || '工具签名变化'}` : '')
    const healthTitle = healthDetail ? ` title="${esc(healthDetail)}"` : ''
    const reviewButton = writable && health?.reviewRequired
      ? ` <button type="button" class="link" data-review-mcp="${esc(server.name)}">确认复核</button>`
      : ''
    const headerNames = server.headerNames || []
    const authText = headerNames.length ? '已配置' : '无'
    const authTitle = headerNames.length ? ` title="${esc(headerNames.join('、'))}"` : ''
    return `
      <tr>
        <td>${esc(SYSTEMS[server.system] || server.system)}</td>
        <td>${esc(server.name)}</td>
        <td>MCP</td>
        <td>${esc(server.url || '-')}</td>
        <td class="${headerNames.length ? 'ok-text' : 'muted'}"${authTitle}>${authText}</td>
        <td class="${healthClass}"${healthTitle}>${healthText}${reviewButton}</td>
      </tr>
    `
  }).join('') : '<tr><td colspan="6" class="empty">还没有 MCP 连接。</td></tr>'
  paint(
    '#mcp-connection-table',
    servers.map((item) => JSON.stringify(item)).join('|') + ':' + JSON.stringify(state.mcpHealth) || 'empty',
    rows,
  )
  renderNotice('#mcp-notice', state.mcpNotice, state.mcpNoticeTone)
  const mcpStatus = $('#mcp-status')
  if (mcpStatus) {
    const errors = state.mcpErrors || []
    mcpStatus.hidden = errors.length === 0
    mcpStatus.textContent = errors.length
      ? `以下 MCP server 初始化失败，相关工具暂时不可用：${errors.map((item) => `${item.name}（${item.message}）`).join('；')}`
      : ''
  }
  const editToggle = $('#mcp-edit-toggle')
  if (editToggle) editToggle.hidden = !writable
  if (!writable) {
    const editor = $('#mcp-editor')
    if (editor) editor.hidden = true
    state.mcpEditorOpen = false
  }
}

function renderModel() {
  const writable = isAdmin()
  const providers = state.modelProviders || []
  const rows = providers.length ? providers.map((provider) => {
    const actions = writable
      ? `<button type="button" class="link" data-edit-model="${esc(provider.name)}">编辑</button>
         <button type="button" class="link" data-test-model="${esc(provider.name)}">测试</button>
         <button type="button" class="link" data-discover-model="${esc(provider.name)}">拉取模型</button>
         <button type="button" class="link danger" data-delete-model="${esc(provider.name)}">删除</button>`
      : '—'
    const key = provider.hasApiKey
      ? '已配置'
      : provider.apiKeyEnv ? `环境变量 ${provider.apiKeyEnv}` : '未配置'
    return `
      <tr>
        <td>${provider.isDefault ? '<span class="pill ok">默认</span>' : '—'}</td>
        <td>${esc(provider.name)}</td>
        <td class="mono">${esc(provider.baseUrl)}</td>
        <td>${esc(provider.defaultModel)}<span class="muted"> · ${provider.models.length} 个</span></td>
        <td>${esc(key)}</td>
        <td>${provider.enabled ? '<span class="pill read">启用</span>' : '<span class="pill muted">停用</span>'}</td>
        <td class="actions">${actions}</td>
      </tr>
    `
  }).join('') : '<tr><td colspan="7" class="empty">还没有模型 provider。没有配置时平台任务按固定 playbook 执行。</td></tr>'
  paint(
    '#model-provider-table',
    `${JSON.stringify(providers)}:${writable}`,
    rows,
  )
  renderNotice('#model-notice', state.modelNotice, state.modelNoticeTone)
  const newButton = $('#model-new')
  if (newButton) newButton.hidden = !writable
  const form = $('#model-form')
  if (form) form.hidden = !writable || !state.modelFormOpen
  const clearRow = $('#model-clear-key-row')
  if (clearRow) clearRow.hidden = !state.modelEditing
}

function openModelEditor(provider) {
  state.modelEditing = provider?.name || ''
  state.modelFormOpen = true
  const form = $('#model-form')
  if (!form) return
  form.hidden = false
  form.elements.namedItem('editingName').value = provider?.name || ''
  form.elements.namedItem('name').value = provider?.name || ''
  form.elements.namedItem('name').disabled = Boolean(provider)
  form.elements.namedItem('baseUrl').value = provider?.baseUrl || ''
  form.elements.namedItem('apiKey').value = ''
  form.elements.namedItem('apiKey').placeholder = provider?.hasApiKey
    ? '已保存 key，留空保持不变'
    : '留空表示不使用 key'
  form.elements.namedItem('apiKeyEnv').value = provider?.apiKeyEnv || ''
  form.elements.namedItem('models').value = (provider?.models || []).join(',')
  form.elements.namedItem('defaultModel').value = provider?.defaultModel || ''
  form.elements.namedItem('timeoutMs').value = provider?.timeoutMs ?? ''
  form.elements.namedItem('maxTokens').value = provider?.maxTokens ?? ''
  form.elements.namedItem('temperature').value = provider?.temperature ?? ''
  form.elements.namedItem('maxRetries').value = provider?.maxRetries ?? ''
  form.elements.namedItem('retryBackoffMs').value = provider?.retryBackoffMs ?? ''
  form.elements.namedItem('inputCostPer1M').value = provider?.inputCostPer1M ?? ''
  form.elements.namedItem('outputCostPer1M').value = provider?.outputCostPer1M ?? ''
  form.elements.namedItem('currency').value = provider?.currency || ''
  form.elements.namedItem('stream').checked = provider?.stream ?? true
  form.elements.namedItem('enabled').checked = provider?.enabled ?? true
  form.elements.namedItem('isDefault').checked = provider?.isDefault ?? false
  form.elements.namedItem('clearApiKey').checked = false
  renderModel()
  form.elements.namedItem('baseUrl').focus()
}

function closeModelEditor() {
  state.modelFormOpen = false
  state.modelEditing = ''
  renderModel()
}

function renderTaskModelOptions() {
  const row = $('#model-row')
  const providerSelect = $('#task-provider')
  const modelSelect = $('#task-model')
  if (!row || !providerSelect || !modelSelect) return
  const enabled = (state.modelProviders || []).filter((provider) => provider.enabled)
  row.hidden = enabled.length === 0
  if (enabled.length === 0) return
  const current = providerSelect.value
  providerSelect.innerHTML = `<option value="">使用默认</option>${enabled
    .map((provider) => `<option value="${esc(provider.name)}">${esc(provider.name)}${provider.isDefault ? '（默认）' : ''}</option>`)
    .join('')}`
  providerSelect.value = enabled.some((provider) => provider.name === current) ? current : ''
  const selected = enabled.find((provider) => provider.name === providerSelect.value)
    || enabled.find((provider) => provider.isDefault)
    || enabled[0]
  const previousModel = modelSelect.value
  modelSelect.innerHTML = `<option value="">${selected ? `默认（${esc(selected.defaultModel)}）` : '使用默认模型'}</option>${(selected?.models || [])
    .filter((model) => model !== selected?.defaultModel)
    .map((model) => `<option value="${esc(model)}">${esc(model)}</option>`)
    .join('')}`
  modelSelect.value = (selected?.models || []).includes(previousModel) && previousModel !== selected?.defaultModel
    ? previousModel
    : ''
}

async function loadModelProviders(force = false) {
  if (state.modelProvidersLoaded && !force) return
  try {
    state.modelProviders = (await api('GET', '/api/model-providers')).providers || []
  } catch {
    state.modelProviders = []
  }
  state.modelProvidersLoaded = true
  renderTaskModelOptions()
}


function renderNotifications() {
  const writable = isAdmin()
  const { settings, webhooks } = state.notifications
  const settingsForm = $('#notification-settings')
  if (settingsForm) {
    const enabled = settingsForm.elements.namedItem('enabled')
    const interval = settingsForm.elements.namedItem('minIntervalMs')
    enabled.checked = Boolean(settings.enabled)
    enabled.disabled = !writable
    interval.value = settings.minIntervalMs
    interval.disabled = !writable
  }
  const settingsSave = $('#notification-settings-save')
  if (settingsSave) settingsSave.hidden = !writable
  const rows = webhooks.length ? webhooks.map((webhook) => {
    const actions = writable
      ? `<button type="button" class="link" data-edit-notification="${esc(webhook.id)}">编辑</button>
         <button type="button" class="link" data-test-notification="${esc(webhook.id)}">测试</button>
         <button type="button" class="link danger" data-delete-notification="${esc(webhook.id)}">删除</button>`
      : '—'
    const events = webhook.events.map((type) => NOTIFICATION_EVENTS[type] || type).join('、')
    return `
      <tr>
        <td>${esc(webhook.name)}</td>
        <td class="mono">${esc(webhook.urlHost)}</td>
        <td>${esc(WEBHOOK_FORMATS[webhook.format] || webhook.format)}${webhook.hasSecret ? ' · 加签' : ''}</td>
        <td class="muted">${esc(events)}</td>
        <td>${webhook.enabled ? '<span class="pill read">启用</span>' : '<span class="pill muted">停用</span>'}</td>
        <td class="actions">${actions}</td>
      </tr>
    `
  }).join('') : '<tr><td colspan="6" class="empty">还没有通知 webhook。审批、任务失败和 MCP 状态变化不会推送。</td></tr>'
  paint('#notification-webhook-table', `${JSON.stringify(webhooks)}:${writable}`, rows)
  renderNotice('#notification-notice', state.notificationNotice, state.notificationNoticeTone)
  const newButton = $('#notification-new')
  if (newButton) newButton.hidden = !writable
  const form = $('#notification-form')
  if (form) form.hidden = !writable || !state.notificationFormOpen
}

function openNotificationEditor(webhook) {
  state.notificationEditing = webhook?.id || ''
  state.notificationFormOpen = true
  const form = $('#notification-form')
  if (!form) return
  form.hidden = false
  form.elements.namedItem('editingId').value = webhook?.id || ''
  form.elements.namedItem('name').value = webhook?.name || ''
  form.elements.namedItem('url').value = ''
  form.elements.namedItem('url').placeholder = webhook
    ? `已保存 ${webhook.urlHost}，留空保持不变`
    : 'https://oapi.dingtalk.com/robot/send?access_token=...'
  form.elements.namedItem('format').value = webhook?.format || 'dingtalk'
  form.elements.namedItem('secret').value = ''
  form.elements.namedItem('secret').placeholder = webhook?.hasSecret
    ? '已保存加签密钥，留空保持不变'
    : '机器人安全设置里的 SEC 开头密钥，仅钉钉加签需要'
  form.elements.namedItem('clearSecret').checked = false
  form.elements.namedItem('enabled').checked = webhook?.enabled ?? true
  const selected = new Set(webhook?.events || Object.keys(NOTIFICATION_EVENTS))
  const container = $('#notification-events')
  if (container) {
    container.innerHTML = Object.entries(NOTIFICATION_EVENTS).map(([type, label]) =>
      `<label><input type="checkbox" data-notification-event="${esc(type)}"${selected.has(type) ? ' checked' : ''} /> ${esc(label)}</label>`,
    ).join('')
  }
  renderNotifications()
  form.elements.namedItem('name').focus()
}

function closeNotificationEditor() {
  state.notificationFormOpen = false
  state.notificationEditing = ''
  renderNotifications()
}

async function loadNotifications(force = false) {
  if (state.notificationsLoaded && !force) return
  try {
    const result = await api('GET', '/api/notifications')
    state.notifications = {
      settings: result.settings || { enabled: false, minIntervalMs: 0 },
      webhooks: result.webhooks || [],
      types: result.types || [],
    }
  } catch {
    state.notifications = { settings: { enabled: false, minIntervalMs: 0 }, webhooks: [], types: [] }
  }
  state.notificationsLoaded = true
}

const ALERT_FORMATS = {
  nightingale: '夜莺 v6',
  alertmanager: 'Alertmanager',
  generic: '通用 JSON',
}

const ALERT_REASONS = {
  resolved: '恢复通知，不排查',
  below_threshold: '低于严重级别阈值，不排查',
  duplicate: '冷却窗口内重复告警，不重复排查',
  capacity: '排查任务已满，本次忽略',
}

function alertSeverityLabel(value) {
  return value === 1 ? '仅 P1' : value === 2 ? 'P1-P2' : 'P1-P3'
}

function alertActorOptions(current) {
  const eligible = (state.actors || []).filter((person) =>
    (person.roles || []).some((role) => role === 'operator' || role === 'approver' || role === 'admin'))
  if (current && !eligible.some((person) => person.id === current)) {
    eligible.push(state.actors.find((person) => person.id === current) || { id: current, name: current, roles: [] })
  }
  return eligible
}

function syncAlertModelOptions() {
  const provider = $('#alert-provider')
  const model = $('#alert-model')
  if (!provider || !model) return
  const selected = (state.modelProviders || []).find((item) => item.enabled && item.name === provider.value)
  const previous = model.value
  model.innerHTML = `<option value="">${selected ? `默认（${esc(selected.defaultModel)}）` : '使用默认模型'}</option>${(selected?.models || [])
    .filter((name) => name !== selected?.defaultModel)
    .map((name) => `<option value="${esc(name)}">${esc(name)}</option>`)
    .join('')}`
  model.value = selected && (selected.models || []).includes(previous) ? previous : ''
}

function renderAlertSources() {
  const writable = isAdmin()
  const rows = state.alertSources.length ? state.alertSources.map((source) => {
    const webhookNames = (source.notifyWebhookIds || [])
      .map((id) => state.notifications.webhooks.find((webhook) => webhook.id === id)?.name || id)
    const actions = writable
      ? `<button type="button" class="link" data-test-alert-source="${esc(source.id)}">测试</button>
         <button type="button" class="link" data-rotate-alert-source="${esc(source.id)}">轮换 Token</button>
         <button type="button" class="link" data-edit-alert-source="${esc(source.id)}">编辑</button>
         <button type="button" class="link danger" data-delete-alert-source="${esc(source.id)}">删除</button>`
      : '—'
    const model = [source.provider, source.model].filter(Boolean).join(' / ') || '默认模型'
    return `
      <tr>
        <td>${esc(source.name)}<div class="meta mono">${esc(source.id)}</div></td>
        <td>${esc(ALERT_FORMATS[source.format] || source.format)}</td>
        <td>${esc(actorName(source.actorId))}<div class="meta">${esc(source.skill || '自动选择')} · ${esc(model)}</div></td>
        <td>${esc(alertSeverityLabel(source.maxSeverity))}</td>
        <td class="muted">${esc(webhookNames.length ? webhookNames.join('、') : '仅平台内查看')}</td>
        <td>${source.enabled ? '<span class="pill read">启用</span>' : '<span class="pill muted">停用</span>'}</td>
        <td class="actions">${actions}</td>
      </tr>
    `
  }).join('') : '<tr><td colspan="7" class="empty">还没有告警接入源。新增后把回调地址和 Token 配到夜莺或 Alertmanager。</td></tr>'
  paint('#alert-source-table', `${JSON.stringify(state.alertSources)}:${writable}`, rows)
  renderNotice('#alert-source-notice', state.alertSourceNotice, state.alertSourceNoticeTone)
  const token = $('#alert-token')
  if (token) {
    token.hidden = !state.alertSourceToken
    token.textContent = state.alertSourceToken
      ? `接入地址：${state.alertSourcePath}\nToken：${state.alertSourceToken}\n（Token 只显示这一次，请立即配置到告警系统）`
      : ''
  }
  const newButton = $('#alert-source-new')
  if (newButton) newButton.hidden = !writable
  const form = $('#alert-source-form')
  if (form) form.hidden = !writable || !state.alertSourceFormOpen
}

function openAlertSourceEditor(source) {
  const form = $('#alert-source-form')
  if (!form) return
  state.alertSourceEditing = source?.id || ''
  state.alertSourceFormOpen = true
  state.alertSourceToken = ''
  form.elements.namedItem('editingId').value = source?.id || ''
  form.elements.namedItem('name').value = source?.name || ''
  form.elements.namedItem('format').value = source?.format || 'nightingale'
  form.elements.namedItem('maxSeverity').value = String(source?.maxSeverity ?? 2)
  form.elements.namedItem('cooldownMinutes').value = String(Math.round((source?.cooldownMs ?? 600000) / 60000))
  form.elements.namedItem('enabled').checked = source?.enabled ?? true
  const actorSelect = form.elements.namedItem('actorId')
  actorSelect.innerHTML = alertActorOptions(source?.actorId)
    .map((person) => `<option value="${esc(person.id)}">${esc(person.name)}（${esc(roleLabel(person.roles || []))}）</option>`)
    .join('')
  actorSelect.value = source?.actorId || state.actorId
  const skillSelect = form.elements.namedItem('skill')
  skillSelect.innerHTML = `<option value="">按告警内容自动选择</option>${(state.skillOptions || [])
    .map((skill) => `<option value="${esc(skill.name)}">${esc(skill.name)} · ${esc(skill.description)}</option>`)
    .join('')}`
  skillSelect.value = source?.skill || ''
  const providerSelect = form.elements.namedItem('provider')
  providerSelect.innerHTML = '<option value="">使用默认模型</option>' + (state.modelProviders || [])
    .filter((provider) => provider.enabled)
    .map((provider) => `<option value="${esc(provider.name)}">${esc(provider.name)}${provider.isDefault ? '（默认）' : ''}</option>`)
    .join('')
  providerSelect.value = source?.provider || ''
  syncAlertModelOptions()
  if (source?.model) form.elements.namedItem('model').value = source.model
  const webhookContainer = $('#alert-webhooks')
  const selectedWebhooks = new Set(source?.notifyWebhookIds || [])
  if (webhookContainer) {
    webhookContainer.innerHTML = state.notifications.webhooks.length
      ? state.notifications.webhooks.map((webhook) =>
          `<label><input type="checkbox" data-alert-webhook="${esc(webhook.id)}"${selectedWebhooks.has(webhook.id) ? ' checked' : ''}${webhook.enabled ? '' : ' disabled'} /> ${esc(webhook.name)}${webhook.enabled ? '' : '（停用）'}</label>`,
        ).join('')
      : '<span class="muted">还没有配置通知 Webhook，排查结果只在平台里查看。</span>'
  }
  const skillContainer = $('#alert-skills')
  const selectedSkills = new Set(source?.skills || [])
  if (skillContainer) {
    skillContainer.innerHTML = (state.skillOptions || []).map((skill) =>
      `<label><input type="checkbox" data-alert-skill="${esc(skill.name)}"${selectedSkills.has(skill.name) ? ' checked' : ''} /> ${esc(skill.name)}</label>`,
    ).join('') || '<span class="muted">没有可用技能。</span>'
  }
  renderAlertSources()
  form.elements.namedItem('name').focus()
}

function closeAlertSourceEditor() {
  state.alertSourceFormOpen = false
  state.alertSourceEditing = ''
  renderAlertSources()
}

async function loadAlertSources(force = false) {
  if (state.alertSourcesLoaded && !force) return
  try {
    state.alertSources = (await api('GET', '/api/alert-sources')).sources || []
  } catch {
    state.alertSources = []
  }
  state.alertSourcesLoaded = true
}

function credentialById(id) {
  return state.credentials.find((item) => item.id === id)
}

function credentialLabel(asset) {
  if (asset.sshCredentialId) {
    const credential = credentialById(asset.sshCredentialId)
    if (credential) return `${credential.name}（${credential.type === 'key' ? '私钥' : '密码'}）`
    return canSubmit(actor()) ? '凭证已删除' : '凭证已配置'
  }
  if (asset.hasPassword || asset.hasKey) return '旧版内联凭证'
  return '未配置'
}

function sshSummary(asset) {
  if (!asset.sshUser) return '未配置'
  return `${asset.sshUser}@${asset.ip || asset.host || '?'}${asset.sshPort ? `:${asset.sshPort}` : ''}`
}

function renderAssetTable() {
  const rows = state.assets.length ? state.assets.map((asset) => `
    <tr>
      <td><strong>${esc(asset.name)}</strong></td>
      <td>${esc([asset.host, asset.ip].filter(Boolean).join(' / ') || '-')}</td>
      <td>${esc(sshSummary(asset))}</td>
      <td>${esc(credentialLabel(asset))}</td>
      <td>${esc(asset.owner || '-')}</td>
      <td>${esc(asset.tier || '-')}</td>
      <td>${esc(asset.env || '-')}</td>
      <td>${asset.sshHostKeyFingerprint ? `<span class="pill read" title="${esc(asset.sshHostKeyFingerprint)}">已信任</span>` : '<span class="pill">未信任</span>'}</td>
      <td class="row-actions">
        <button type="button" class="link" data-edit-asset="${esc(asset.name)}">编辑</button>
        <button type="button" class="link" data-test-ssh="${esc(asset.name)}">测试连接</button>
        <button type="button" class="link" data-check-hostkey="${esc(asset.name)}">校验主机密钥</button>
        <button type="button" class="link danger-link" data-delete-asset="${esc(asset.name)}">删除</button>
      </td>
    </tr>
  `).join('') : '<tr><td colspan="9" class="empty">还没有资产。点「新增资产」录入。</td></tr>'
  paint('#asset-table', state.assets.map((asset) => JSON.stringify(asset)).join('|') + ':' + state.credentials.map((item) => JSON.stringify(item)).join('|') || 'empty', rows)
}

function renderJumpOptions() {
  const select = $('#asset-jump')
  if (!select) return
  const current = select.value
  select.innerHTML = `<option value="">不使用跳板机</option>${state.assets
    .map((asset) => `<option value="${esc(asset.name)}">${esc(asset.name)}</option>`)
    .join('')}`
  select.value = state.assets.some((item) => item.name === current) ? current : ''
}

function renderCredentialOptions() {
  const select = $('#asset-credential')
  if (!select) return
  const current = select.value
  select.innerHTML = `<option value="">不使用凭证</option>${state.credentials
    .map((credential) => `<option value="${esc(credential.id)}">${esc(credential.name)}（${credential.type === 'key' ? '私钥' : '密码'}）</option>`)
    .join('')}`
  select.value = state.credentials.some((item) => item.id === current) ? current : ''
  renderJumpOptions()
}

function renderCredentials() {
  const html = state.credentials.length ? state.credentials.map((credential) => `
    <article class="card">
      <div class="meta"><span class="pill ${credential.type === 'key' ? 'dsh' : 'read'}">${credential.type === 'key' ? '私钥' : '密码'}</span></div>
      <strong>${esc(credential.name)}</strong>
      <p class="meta">${credential.hasSecret ? '凭证已保存' : '没有可用的凭证内容'} · ${esc(credential.id)}</p>
      <div class="card-actions">
        <button type="button" class="ghost" data-edit-credential="${esc(credential.id)}">编辑</button>
        <button type="button" class="danger" data-delete-credential="${esc(credential.id)}">删除</button>
      </div>
    </article>
  `).join('') : '<p class="empty">还没有凭证。上面创建一个密码或私钥，资产就能直接选择。</p>'
  paint('#credential-list', state.credentials.map((item) => JSON.stringify(item)).join('|') || 'empty', html)
}

function renderAssets() {
  renderJumpOptions()
  const panel = $('#known-hosts-panel')
  if (panel) panel.hidden = !isAdmin()
  const readPaths = $('#asset-read-paths')
  if (readPaths) readPaths.hidden = !isAdmin()
  const html = state.assets.length ? state.assets.map((asset) => {
    const host = [asset.host, asset.ip].filter(Boolean).join(' · ') || '未填主机'
    const ssh = asset.sshUser
      ? `${asset.sshUser}@${asset.ip || asset.host || '?'}${asset.sshPort ? `:${asset.sshPort}` : ''}`
      : ''
    const sshLine = ssh ? `SSH ${ssh}` : 'SSH 未配置'
    const hostKey = asset.sshHostKeyFingerprint
      ? `<p class="meta mono">主机密钥 ${esc(asset.sshHostKeyFingerprint)}</p>`
      : '<p class="meta">主机密钥未信任，SSH 会拒绝连接</p>'
    return `
      <article class="card">
        <div class="meta"><span class="pill read">资产</span> ${esc(asset.env || '未标环境')}</div>
        <strong>${esc(asset.name)}</strong>
        <p class="meta">${esc(host)}</p>
        <p class="meta">${esc(sshLine)} · 凭证 ${esc(credentialLabel(asset))}${asset.sshJumpAsset ? ` · 经跳板机 ${esc(asset.sshJumpAsset)}` : ''}</p>
        <p>负责人 ${esc(asset.owner || '-')} · 等级 ${esc(asset.tier || '-')}${asset.repo ? ` · ${esc(asset.repo)}` : ''}</p>
        ${hostKey}
        ${asset.note ? `<p class="muted">${esc(asset.note)}</p>` : ''}
        <div class="card-actions">
          <button type="button" class="ghost" data-edit-asset="${esc(asset.name)}">编辑</button>
          <button type="button" class="ghost" data-test-ssh="${esc(asset.name)}">测试连接</button>
          <button type="button" class="ghost" data-check-hostkey="${esc(asset.name)}">校验主机密钥</button>
          <button type="button" class="danger" data-delete-asset="${esc(asset.name)}">删除</button>
        </div>
      </article>
    `
  }).join('') : '<p class="empty">还没有资产。上面填一条保存，就会出现在资产列表里。</p>'
  paint('#asset-list', state.assets.map((asset) => JSON.stringify(asset)).join('|') + ':' + state.credentials.map((item) => JSON.stringify(item)).join('|') || 'empty', html)
}

function fillDocForm(doc) {
  const form = $('#doc-form')
  const values = {
    id: doc.docId,
    title: doc.title,
    source: doc.source,
    actors: (doc.actors || []).join(','),
    content: doc.content,
  }
  for (const [name, value] of Object.entries(values)) form.elements.namedItem(name).value = value
  form.elements.namedItem('id').focus()
}

function fillAssetForm(asset) {
  const form = $('#asset-form')
  const values = {
    name: asset.name,
    host: asset.host || '',
    ip: asset.ip || '',
    env: asset.env || '',
    owner: asset.owner || '',
    tier: asset.tier || '',
    repo: asset.repo || '',
    sshPort: asset.sshPort || '',
    sshUser: asset.sshUser || '',
    sshCredentialId: asset.sshCredentialId || '',
    sshJumpAsset: asset.sshJumpAsset || '',
    sshReadPaths: (asset.sshReadPaths || []).join('\n'),
    note: asset.note || '',
  }
  for (const [name, value] of Object.entries(values)) form.elements.namedItem(name).value = value
  form.elements.namedItem('name').focus()
}

function setCredentialType() {
  const type = $('#credential-type')?.value || 'password'
  const password = $('[data-credential-password]')
  const key = $('[data-credential-key]')
  if (password) password.hidden = type !== 'password'
  if (key) key.hidden = type !== 'key'
}

function fillCredentialForm(credential) {
  const form = $('#credential-form')
  form.elements.namedItem('id').value = credential.id
  form.elements.namedItem('name').value = credential.name
  form.elements.namedItem('type').value = credential.type
  form.elements.namedItem('password').value = ''
  form.elements.namedItem('privateKey').value = ''
  form.elements.namedItem('passphrase').value = ''
  setCredentialType()
  form.elements.namedItem('name').focus()
}

function clearForm(form) {
  for (const element of form.elements) {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) element.value = ''
    if (element instanceof HTMLSelectElement) element.selectedIndex = 0
  }
}

// header 模式（无认证或 actor 头）下角色来自 /api/actors；账号模式只认当前登录用户。
function actorIs(role) {
  return (state.authMethod === '' || state.authMethod === 'actor') && Boolean(actor()?.roles?.includes(role))
}

function isAdmin() {
  return Boolean(state.me?.roles?.includes('admin') || actorIs('admin'))
}

function canViewSecurity() {
  return isAdmin() || Boolean(state.me?.roles?.includes('auditor') || actorIs('auditor'))
}

function keyStatus(key) {
  if (key.revokedAt) return '已吊销'
  if (key.expiresAt && key.expiresAt <= new Date().toISOString()) return '已过期'
  if (key.expiringSoon) return '即将过期'
  return '有效'
}

function accountViews() {
  const views = ['settings', 'keys']
  if (isAdmin()) views.push('users')
  if (canViewSecurity()) views.push('security')
  return views
}

/** 账号二级菜单按角色显示；header 模式下只留安全设置（内容显示不可用提示）。 */
function syncAccountNav() {
  const enabled = Boolean(state.features.auth)
  const allowed = enabled ? accountViews() : ['settings']
  document.querySelectorAll('#account-subnav [data-view]').forEach((button) => {
    button.hidden = !allowed.includes(button.dataset.view)
  })
}

/** 「API Key」页和「用户管理」页都要显示一次性 token，谁签发的就写进所有展示位。 */
function paintKeyTokens() {
  document.querySelectorAll('.key-token-out').forEach((node) => {
    node.hidden = !state.keyToken
    const value = node.querySelector('.token-value')
    if (value) value.textContent = state.keyToken || ''
    const name = node.querySelector('.token-name')
    if (name) {
      name.textContent = state.keyTokenLabel ? `来源：${state.keyTokenLabel}` : ''
      name.hidden = !state.keyTokenLabel
    }
  })
}

/** 复制失败时（非 HTTPS 等）退回隐藏 textarea，保证内网 HTTP 也能用。 */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    let copied = false
    try {
      copied = document.execCommand('copy')
    } catch {
      copied = false
    }
    area.remove()
    return copied
  }
}

document.addEventListener('click', async (event) => {
  const copy = event.target.closest('[data-copy-token]')
  if (copy) {
    if (!state.keyToken) return
    const ok = await copyText(state.keyToken)
    const label = copy.textContent
    copy.textContent = ok ? '已复制' : '复制失败，请手动选中'
    window.setTimeout(() => { copy.textContent = label }, 1800)
    return
  }
  const dismiss = event.target.closest('[data-dismiss-token]')
  if (dismiss) {
    state.keyToken = ''
    state.keyTokenLabel = ''
    paintKeyTokens()
    settingsNotice('token 已从页面清除；如果还没保存，请吊销后重新签发。')
  }
})

function renderAccount() {
  const offline = $('#settings-offline')
  const online = $('#settings-online')
  const enabled = Boolean(state.features.auth)
  if (offline) offline.hidden = enabled
  if (online) online.hidden = !enabled
  const warning = $('#password-warning')
  if (warning) warning.hidden = !enabled || !state.me?.mustChangePassword
  syncAccountNav()
  if (!enabled) return

  const sessions = state.sessions || []
  paint('#session-table', sessions.map((session) => `${session.id}:${session.lastSeenAt}:${session.current}`).join('|'), sessions.length
    ? sessions.map((session) => `
      <tr>
        <td>${when(session.lastSeenAt)}</td>
        <td>${when(session.createdAt)}</td>
        <td class="mono">${esc(session.ip || '—')}</td>
        <td class="mono detail-cell">${esc(session.userAgent || '—')}</td>
        <td>${when(session.expiresAt)}</td>
        <td>${session.current
          ? '<span class="hint">当前会话</span>'
          : `<button type="button" class="link danger-link" data-revoke-session="${esc(session.id)}">注销</button>`}</td>
      </tr>
    `).join('')
    : '<tr><td colspan="6">没有有效会话</td></tr>')

  const keys = state.keys || []
  paint('#key-table', keys.map((key) => `${key.id}:${key.revokedAt || ''}:${key.lastUsedAt || ''}:${key.expiresAt || ''}:${key.expiringSoon || ''}`).join('|'), keys.length
    ? keys.map((key) => `
      <tr>
        <td>${esc(key.name)}</td>
        <td class="mono">${esc(key.scopes.join(', '))}</td>
        <td>${when(key.createdAt)}</td>
        <td>${key.lastUsedAt ? when(key.lastUsedAt) : '—'}</td>
        <td>${key.expiresAt ? when(key.expiresAt) : '永不过期'}</td>
        <td>${keyStatus(key)}</td>
        <td>${key.revokedAt ? '' : `<button type="button" class="link" data-rotate-key="${esc(key.id)}">轮换</button> <button type="button" class="link danger-link" data-revoke-key="${esc(key.id)}">吊销</button>`}</td>
      </tr>
    `).join('')
    : '<tr><td colspan="7">还没有 API key</td></tr>')

  const locks = state.loginLocks || []
  const lockedUsers = new Set(locks.filter((lock) => lock.lockedUntil).map((lock) => lock.username))
  const users = state.users || []
  paint('#user-table', users.map((user) => `${user.id}:${user.status}:${user.roles.join('+')}:${user.hasPassword}:${lockedUsers.has(user.username) ? 'locked' : ''}`).join('|'), users.length
    ? users.map((user) => `
      <tr>
        <td>${esc(user.username)}</td>
        <td>${esc(user.displayName)}</td>
        <td class="mono">${esc(user.roles.join(', '))}</td>
        <td>${esc(user.source)}</td>
        <td>${user.hasPassword ? '密码 + API key' : '仅 API key'}</td>
        <td>${user.status === 'disabled' ? '已停用' : lockedUsers.has(user.username) ? '正常（锁定中）' : '正常'}</td>
        <td>${user.lastLoginAt ? when(user.lastLoginAt) : '—'}</td>
        <td>
          <button type="button" class="link" data-toggle-user="${esc(user.id)}" data-status="${user.status === 'disabled' ? 'active' : 'disabled'}">${user.status === 'disabled' ? '启用' : '停用'}</button>
          <button type="button" class="link" data-reset-user="${esc(user.id)}">重置密码</button>
          <button type="button" class="link" data-issue-key="${esc(user.id)}" data-issue-name="${esc(user.username)}">签发 key</button>
        </td>
      </tr>
    `).join('')
    : '<tr><td colspan="8">还没有本地账号</td></tr>')

  paint('#login-lock-table', locks.map((lock) => `${lock.username}:${lock.ip || ''}:${lock.failures}:${lock.lockedUntil || ''}`).join('|'), locks.length
    ? locks.map((lock) => `
      <tr>
        <td>${esc(lock.username)}</td>
        <td class="mono">${esc(lock.ip || '—')}</td>
        <td>${lock.failures}</td>
        <td>${when(lock.lastFailureAt)}</td>
        <td>${lock.lockedUntil ? `<span class="lock-badge">锁定至 ${when(lock.lockedUntil)}</span>` : '未锁定'}</td>
        <td><button type="button" class="link" data-clear-locks="${esc(lock.username)}">${lock.lockedUntil ? '解锁' : '清除'}</button></td>
      </tr>
    `).join('')
    : '<tr><td colspan="6">最近没有登录失败记录</td></tr>')

  const events = state.securityEvents || []
  paint('#security-table', events.map((event) => `${event.id}:${event.type}`).join('|'), events.length
    ? events.map((event) => {
      const detail = Object.entries(event.detail || {})
        .filter(([name]) => name !== 'userId')
        .map(([name, value]) => `${name}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
        .join(' ')
      return `
        <tr>
          <td>${when(event.at)}</td>
          <td>${esc(SECURITY_EVENTS[event.type] || event.type)}</td>
          <td>${esc(event.username || actorName(event.userId) || '—')}</td>
          <td class="mono">${esc(event.ip || '—')}</td>
          <td class="mono detail-cell">${esc(detail || '—')}</td>
        </tr>
      `
    }).join('')
    : '<tr><td colspan="5">还没有事件</td></tr>')
  renderPager('#security-pager', state.securityPage, state.securityPageSize, state.securityTotal, 'security')

  paintKeyTokens()
}

function render() {
  $('#badge').textContent = state.pendingTotal ? String(state.pendingTotal) : ''
  renderActors()
  document.querySelectorAll('[data-approval-status]').forEach((button) => {
    button.classList.toggle('active', button.dataset.approvalStatus === state.approvalStatus)
  })
  if (state.view === 'overview') renderOverview()
  if (state.view === 'tasks') {
    renderTasks()
    renderDetail()
  }
  if (state.view === 'approvals') renderApprovals()
  if (state.view === 'knowledge') renderKnowledge()
  if (state.view === 'asset-list') renderAssetTable()
  if (state.view === 'asset-manage') renderAssets()
  if (state.view === 'credentials') renderCredentials()
  if (state.view === 'tools') renderTools()
  if (state.view === 'skills') renderSkills()
  if (state.view === 'mcp') renderMcp()
  if (state.view === 'model') renderModel()
  if (state.view === 'notifications') renderNotifications()
  if (state.view === 'alert-sources') renderAlertSources()
  if (ACCOUNT_VIEWS.includes(state.view)) renderAccount()
}

async function loadSkillOptions() {
  state.skillOptions = (await api('GET', '/api/skills')).skills
  const select = $('#skill')
  const current = select.value
  select.innerHTML = `<option value="">按内容自动选择</option>${state.skillOptions
    .map((skill) => `<option value="${esc(skill.name)}">${esc(skill.name)} · ${esc(skill.description)}</option>`)
    .join('')}`
  select.value = current
}

async function refresh() {
  if (state.inflight) return
  // 总览聚合查询比单页重，轮询降到约 4 秒一次；进入页面和手工操作仍会立即刷新。
  if (state.view === 'overview' && Date.now() - state.overviewAt < 4000) return
  // 初始密码未修改时后端只放行 me/改密/登出，页面停在安全设置，不再轮询其它接口。
  if (state.authMethod && state.me?.mustChangePassword) {
    render()
    return
  }
  state.inflight = true
  if (state.view === 'overview') state.overviewAt = Date.now()
  try {
    const pending = await api('GET', '/api/approvals?status=pending&limit=1')
    state.pending = pending.approvals
    state.pendingTotal = pending.total
    if (!state.skillOptions) await loadSkillOptions()
    await loadModelProviders()
    await loadNotifications()
    if (state.view === 'overview') {
      state.overview = await api('GET', '/api/overview')
    }
    if (state.view === 'tasks') {
      const query = new URLSearchParams()
      if (state.status) query.set('status', state.status)
      if (state.owner) query.set('ownerId', state.owner)
      query.set('limit', String(state.taskPageSize))
      query.set('offset', String((state.taskPage - 1) * state.taskPageSize))
      const result = await api('GET', `/api/tasks?${query}`)
      state.tasks = result.tasks
      state.taskTotal = result.total
      state.taskIndex = Object.fromEntries(result.tasks.map((task) => [task.id, task]))
    }
    if (state.view === 'approvals') {
      const query = new URLSearchParams()
      if (state.approvalStatus) query.set('status', state.approvalStatus)
      query.set('limit', String(state.approvalPageSize))
      query.set('offset', String((state.approvalPage - 1) * state.approvalPageSize))
      const result = await api('GET', `/api/approvals?${query}`)
      state.approvals = result.approvals
      state.approvalTotal = result.total
      if (state.approvalFocus && !state.approvals.some((item) => item.id === state.approvalFocus)) {
        try {
          const focused = (await api('GET', `/api/approvals/${encodeURIComponent(state.approvalFocus)}`)).approval
          state.approvals = [focused, ...state.approvals]
        } catch {
          // 审批可能已被清理或当前身份不可见，保留分页列表即可。
        }
      }
    }
    if (state.view === 'tasks' && state.selectedId) {
      const selectedId = state.selectedId
      const seq = state.taskSeq
      const [task, events, audit, approvals] = await Promise.all([
        api('GET', `/api/tasks/${encodeURIComponent(selectedId)}`),
        api('GET', `/api/tasks/${encodeURIComponent(selectedId)}/events?limit=100`),
        api('GET', `/api/tasks/${encodeURIComponent(selectedId)}/audit?limit=100`),
        api('GET', `/api/approvals?taskId=${encodeURIComponent(selectedId)}&limit=50`),
      ])
      // 详情返回前用户可能已经点了别的任务，迟到的响应不能覆盖当前选择。
      if (seq === state.taskSeq && state.selectedId === selectedId) {
        state.task = task.task
        state.events = events.events
        state.eventTotal = events.total ?? events.events.length
        state.audit = audit.audit
        state.auditTotal = audit.total ?? audit.audit.length
        state.taskApprovals = approvals.approvals
      }
    }
    if (state.view === 'knowledge') {
      state.docs = (await api('GET', '/api/knowledge/docs')).docs
    }
    if (ASSET_VIEWS.includes(state.view)) {
      state.assets = (await api('GET', '/api/assets')).assets
      try {
        state.credentials = (await api('GET', '/api/credentials')).credentials
      } catch (error) {
        state.credentials = []
        if (state.view === 'credentials') throw error
      }
      renderCredentialOptions()
    }
    if (state.view === 'tools') {
      const toolsResult = await api('GET', '/api/tools')
      state.tools = toolsResult.tools
      // 读不到策略时不要假装「没有覆盖」，否则「跟随默认」会误删已有策略。
      try {
        state.toolPolicies = (await api('GET', '/api/tool-policies')).policies || []
      } catch {
        state.toolPolicies = null
      }
    }
    if (state.view === 'skills') {
      state.skills = (await api('GET', '/api/skills')).skills
    }
    if (state.view === 'model') await loadModelProviders(true)
    if (state.view === 'alert-sources' && (isAdmin() || canViewSecurity())) {
      state.alertSources = (await api('GET', '/api/alert-sources')).sources || []
      state.alertSourcesLoaded = true
    }
    if (state.view === 'mcp') {
      try {
        const result = await api('GET', '/api/mcp-servers')
        state.mcpServers = result.servers
        state.mcpErrors = result.errors || []
        state.mcpHealth = result.health || []
      } catch {
        state.mcpServers = []
        state.mcpErrors = []
        state.mcpHealth = []
      }
    }
    if (state.authMethod) {
      // 账号子页各自取数：轮询只刷新当前子页，安全事件在进入页面/翻页/手动刷新时拉取。
      if (state.view === 'keys') {
        state.keys = (await api('GET', '/api/auth/keys')).keys
      }
      if (state.view === 'settings') {
        state.sessions = (await api('GET', '/api/auth/sessions')).sessions
      }
      if (state.view === 'users' && isAdmin()) {
        const [usersResult, locksResult] = await Promise.all([
          api('GET', '/api/users'),
          api('GET', '/api/login-locks'),
        ])
        state.users = usersResult.users
        state.loginLocks = locksResult.locks
      }
    }
    if (state.errorSource === 'refresh') showError('')
    state.pollPausedUntil = 0
    render()
  } catch (error) {
    // 后台轮询被限流时静默退避，不弹错误；手工操作仍照常提示。
    if (error.code === 'rate_limited') {
      state.pollPausedUntil = Date.now() + (error.retryAfter || 5) * 1000
    } else {
      showError(error.message, 'refresh')
    }
  } finally {
    state.inflight = false
  }
}

function syncNavGroups(view) {
  for (const group of NAV_GROUPS) {
    const node = document.querySelector(group.selector)
    const sub = $(group.sub)
    const toggle = $(group.toggle)
    const active = group.views.includes(view)
    if (sub) sub.hidden = !active
    node?.classList.toggle('open', active)
    node?.classList.toggle('active', active)
    toggle?.setAttribute('aria-expanded', String(active))
  }
}

/** 切换页面时清掉页面级临时反馈：一次性 token、测试/保存提示和全局错误，返回时不显示旧结果。 */
function clearTransientFeedback() {
  state.keyToken = ''
  state.keyTokenLabel = ''
  state.alertSourceToken = ''
  state.alertSourcePath = ''
  state.mcpNotice = ''
  state.mcpNoticeTone = ''
  state.modelNotice = ''
  state.modelNoticeTone = ''
  state.notificationNotice = ''
  state.notificationNoticeTone = ''
  state.alertSourceNotice = ''
  state.alertSourceNoticeTone = ''
  paintKeyTokens()
  for (const selector of ['#alert-token', '#asset-notice', '#asset-notice-manage', '#known-hosts-notice']) {
    const node = $(selector)
    if (!node) continue
    node.hidden = true
    node.textContent = ''
  }
  settingsNotice('')
  showError('')
}

function switchView(view) {
  const previous = state.view
  state.view = view
  if (previous !== view) clearTransientFeedback()
  if (view === 'overview') state.overviewAt = 0
  const crumb = $('#crumb-page')
  if (crumb) crumb.textContent = VIEW_LABELS[view] || view
  if (view === 'asset-manage') clearForm($('#asset-form'))
  if (view === 'credentials') {
    clearForm($('#credential-form'))
    setCredentialType()
  }
  syncNavGroups(view)
  if (view !== 'approvals') {
    state.approvalFocus = ''
    state.approvalScrolled = ''
  }
  document.querySelectorAll('.view').forEach((section) => section.classList.toggle('active', section.id === `view-${view}`))
  document.querySelectorAll('[data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === view))
  if (view === 'security') void loadSecurityEvents()
  syncViewHash(view)
  return refresh()
}

/** 保持地址栏和当前视图一致，方便分享/刷新；用 replaceState 避免污染历史记录。 */
function syncViewHash(view) {
  const target = view === 'approvals'
    ? (state.approvalFocus ? `#/approvals/${encodeURIComponent(state.approvalFocus)}` : '#/approvals')
    : ''
  if (window.location.hash === target) return
  const next = `${window.location.pathname}${window.location.search}${target}`
  window.history.replaceState(null, '', next)
}

function openTask(taskId) {
  state.selectedId = taskId
  state.taskSeq += 1
  state.status = ''
  state.owner = ''
  state.taskPage = 1
  $('#status-filter').value = ''
  $('#owner-filter').value = ''
  switchView('tasks')
}

/**
 * 点击左侧列表时立即高亮，再单独拉详情。
 * 不走整页 refresh：那一轮可能正卡在 in-flight 被直接丢掉，要等下一次 1.2 秒轮询才有反应。
 */
async function selectTask(taskId) {
  state.selectedId = taskId
  const seq = ++state.taskSeq
  renderTasks()
  try {
    const [task, events, audit, approvals] = await Promise.all([
      api('GET', `/api/tasks/${encodeURIComponent(taskId)}`),
      api('GET', `/api/tasks/${encodeURIComponent(taskId)}/events?limit=100`),
      api('GET', `/api/tasks/${encodeURIComponent(taskId)}/audit?limit=100`),
      api('GET', `/api/approvals?taskId=${encodeURIComponent(taskId)}&limit=50`),
    ])
    if (seq !== state.taskSeq || state.view !== 'tasks') return
    state.task = task.task
    state.events = events.events
    state.eventTotal = events.total ?? events.events.length
    state.audit = audit.audit
    state.auditTotal = audit.total ?? audit.audit.length
    state.taskApprovals = approvals.approvals
    if (state.errorSource === 'refresh') showError('')
    render()
  } catch (error) {
    if (seq === state.taskSeq) showError(error.message, 'refresh')
  }
}

function openApproval(approvalId) {
  state.approvalStatus = ''
  state.approvalPage = 1
  state.approvalFocus = approvalId
  state.approvalScrolled = ''
  switchView('approvals')
}

function openOverviewView(view) {
  if (view === 'approvals-pending') {
    state.approvalStatus = 'pending'
    state.approvalPage = 1
    state.approvalFocus = ''
    state.approvalScrolled = ''
    $('#approval-list').dataset.paint = ''
    void switchView('approvals')
    return
  }
  void switchView(view)
}

function openOverviewStatus(status) {
  state.status = status
  state.owner = ''
  state.taskPage = 1
  state.selectedId = ''
  state.task = null
  state.events = []
  state.audit = []
  state.taskApprovals = []
  const statusFilter = $('#status-filter')
  if (statusFilter) statusFilter.value = status
  const ownerFilter = $('#owner-filter')
  if (ownerFilter) ownerFilter.value = ''
  void switchView('tasks')
}

$('#examples').innerHTML = EXAMPLES.map((prompt) => `<button type="button" data-example="${esc(prompt)}">${esc(prompt)}</button>`).join('')

$('#composer').addEventListener('submit', async (event) => {
  event.preventDefault()
  const form = event.currentTarget
  const data = new FormData(form)
  const prompt = String(data.get('prompt') || '').trim()
  const title = String(data.get('title') || '').trim()
  const skill = String(data.get('skill') || '')
  const provider = String(data.get('provider') || '')
  const model = String(data.get('model') || '')
  if (!prompt) return
  try {
    const payload = { prompt }
    if (title) payload.title = title
    if (skill) payload.skill = skill
    if (provider) payload.provider = provider
    if (model) payload.model = model
    const created = await api('POST', '/api/tasks', payload)
    state.selectedId = created.task.id
    state.task = created.task
    state.events = []
    state.audit = []
    state.tasks = [created.task, ...state.tasks.filter((task) => task.id !== created.task.id)]
    form.elements.namedItem('prompt').value = ''
    form.elements.namedItem('title').value = ''
    showError('')
    render()
    await refresh()
  } catch (error) {
    showError(error.message)
  }
})

$('#tools').addEventListener('change', async (event) => {
  const select = event.target.closest('[data-tool-risk]')
  if (!select) return
  const name = select.dataset.toolRisk
  const value = select.value
  const tool = state.tools.find((item) => item.name === name)
  const saved = (state.toolPolicies || []).find((item) => item.tool === name)
  const savedValue = saved?.risk || ''
  if (value === 'read' && tool?.risk === 'mutate') {
    if (!window.confirm(`把 ${name} 标记为只读后，调用不再进入审批。确认？`)) {
      // refresh 的 paint 缓存可能跳过重绘，这里手动把下拉框恢复成已保存的值。
      select.value = savedValue
      return
    }
  }
  try {
    const result = value
      ? await api('PUT', `/api/tool-policies/${encodeURIComponent(name)}`, { risk: value })
      : await api('DELETE', `/api/tool-policies/${encodeURIComponent(name)}`)
    state.toolPolicies = result.policies || []
    state.tools = (await api('GET', '/api/tools')).tools
    renderTools()
  } catch (error) {
    select.value = savedValue
    showError(error.message)
    await refresh()
  }
})

// toggle 不冒泡，用捕获阶段记录用户手动展开/收起的偏好。
$('#tools').addEventListener('toggle', (event) => {
  const group = event.target.closest?.('.tool-group')
  if (!group || !group.dataset.group) return
  state.toolGroups[group.dataset.group] = event.target.open
}, true)

$('#tool-toolbar').addEventListener('click', (event) => {
  const expand = event.target.closest('[data-tool-expand]')
  if (!expand) return
  const open = expand.dataset.toolExpand === 'all'
  for (const group of $('#tools').querySelectorAll('.tool-group')) {
    group.open = open
    state.toolGroups[group.dataset.group] = open
  }
})

$('#tools').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-clear-tool-policy]')
  if (!button) return
  const name = button.dataset.clearToolPolicy
  if (!window.confirm(`清除 ${name} 的人工策略？`)) return
  try {
    const result = await api('DELETE', `/api/tool-policies/${encodeURIComponent(name)}`)
    state.toolPolicies = result.policies || []
    renderTools()
  } catch (error) {
    showError(error.message)
  }
})

$('#examples').addEventListener('click', (event) => {
  const button = event.target.closest('[data-example]')
  if (!button) return
  const prompt = $('#composer').elements.namedItem('prompt')
  prompt.value = button.dataset.example
  prompt.focus()
})

$('#status-filter').addEventListener('change', (event) => {
  state.status = event.target.value
  state.taskPage = 1
  void refresh()
})

$('#owner-filter').addEventListener('change', (event) => {
  state.owner = event.target.value
  state.taskPage = 1
  void refresh()
})

$('#task-pager').addEventListener('click', (event) => {
  const button = event.target.closest('[data-page]')
  if (!button || button.disabled) return
  state.taskPage = Number(button.dataset.page)
  void refresh()
})

$('#approval-pager').addEventListener('click', (event) => {
  const button = event.target.closest('[data-page]')
  if (!button || button.disabled) return
  state.approvalPage = Number(button.dataset.page)
  void refresh()
})

$('#task-list').addEventListener('click', (event) => {
  const button = event.target.closest('[data-task]')
  if (!button) return
  void selectTask(button.dataset.task)
})

$('#task-detail').addEventListener('click', async (event) => {
  const approvalButton = event.target.closest('[data-open-approval]')
  if (approvalButton) {
    openApproval(approvalButton.dataset.openApproval)
    return
  }
  const finishButton = event.target.closest('[data-finish]')
  if (finishButton) {
    const result = window.prompt('任务结论（可选，留空则写“手动标记完成”）', '')
    if (result === null) return
    try {
      await api('POST', `/api/tasks/${finishButton.dataset.finish}/finish`, {
        result: result.trim() || '手动标记完成',
      })
      await refresh()
    } catch (error) {
      showError(error.message)
    }
    return
  }
  const retryButton = event.target.closest('[data-retry]')
  if (retryButton) {
    if (!window.confirm('重新执行这个失败的任务？会新建一条任务并复制排查内容（按任务保留策略多保留一个周期），原任务和审计保留。')) return
    try {
      const created = await api('POST', `/api/tasks/${encodeURIComponent(retryButton.dataset.retry)}/retry`)
      state.selectedId = created.task.id
      state.task = created.task
      state.events = []
      state.audit = []
      state.tasks = [created.task, ...state.tasks.filter((task) => task.id !== created.task.id)]
      showError('')
      render()
      await refresh()
    } catch (error) {
      showError(error.message)
    }
    return
  }
  const button = event.target.closest('[data-cancel]')
  if (!button) return
  if (!window.confirm('取消这个任务？挂起的审批会一并作废，不会执行任何变更。')) return
  try {
    const result = await api('POST', `/api/tasks/${button.dataset.cancel}/cancel`, { force: true })
    state.task = result.task
    state.tasks = state.tasks.map((task) => (task.id === result.task.id ? result.task : task))
    await refresh()
  } catch (error) {
    showError(error.message)
  }
})

document.querySelectorAll('[data-view]').forEach((button) => {
  button.addEventListener('click', () => switchView(button.dataset.view))
})

document.querySelectorAll('[data-goto-view]').forEach((button) => {
  button.addEventListener('click', () => switchView(button.dataset.gotoView))
})

$('#view-overview').addEventListener('click', (event) => {
  const nav = event.target.closest('[data-overview-view]')
  if (nav) {
    openOverviewView(nav.dataset.overviewView)
    return
  }
  const approval = event.target.closest('[data-overview-approval]')
  if (approval) {
    openApproval(approval.dataset.overviewApproval)
    return
  }
  const task = event.target.closest('[data-overview-task]')
  if (task) {
    openTask(task.dataset.overviewTask)
    return
  }
  const status = event.target.closest('[data-overview-status]')
  if (status) openOverviewStatus(status.dataset.overviewStatus)
})

for (const group of NAV_GROUPS) {
  const toggle = $(group.toggle)
  if (!toggle) continue
  toggle.addEventListener('click', () => {
    const node = document.querySelector(group.selector)
    const sub = $(group.sub)
    const open = sub.hidden
    sub.hidden = !open
    node?.classList.toggle('open', open)
    toggle.setAttribute('aria-expanded', String(open))
    if (open && !group.views.includes(state.view)) void switchView(group.first)
  })
}

$('#approval-filter').addEventListener('click', (event) => {
  const button = event.target.closest('[data-approval-status]')
  if (!button) return
  state.approvalStatus = button.dataset.approvalStatus
  state.approvalPage = 1
  state.approvalFocus = ''
  state.approvalScrolled = ''
  document.querySelectorAll('[data-approval-status]').forEach((item) => item.classList.toggle('active', item === button))
  $('#approval-list').dataset.paint = ''
  syncViewHash('approvals')
  void refresh()
})

$('#approval-list').addEventListener('click', async (event) => {
  const jump = event.target.closest('[data-jump-task]')
  if (jump) {
    openTask(jump.dataset.jumpTask)
    return
  }
  const resume = event.target.closest('[data-resume-approval]')
  if (resume) {
    try {
      await api('POST', `/api/approvals/${encodeURIComponent(resume.dataset.resumeApproval)}/resume`)
      showError('')
      $('#approval-list').dataset.paint = ''
      await refresh()
    } catch (error) {
      showError(error.message)
    }
    return
  }
  const button = event.target.closest('[data-decision]')
  if (!button) return
  const card = button.closest('[data-approval]')
  const approval = findApproval(card.dataset.approval)
  if (approval?.ownerId === state.actorId && !window.confirm('这是你自己发起的变更，确认由自己批准？审计会记录同一个人。')) return
  const comment = card.querySelector('[data-comment]')?.value || ''
  try {
    const result = await api('POST', `/api/approvals/${card.dataset.approval}`, { decision: button.dataset.decision, comment })
    state.approvals = state.approvals.map((item) => (item.id === result.approval.id ? result.approval : item))
    $('#approval-list').dataset.paint = ''
    await refresh()
  } catch (error) {
    showError(error.message)
  }
})

$('#search').addEventListener('submit', async (event) => {
  event.preventDefault()
  const query = String(new FormData(event.currentTarget).get('query') || '').trim()
  const topK = Number($('#top-k').value || 5)
  if (!query) return
  try {
    state.hits = (await api('POST', '/api/knowledge/search', { query, top_k: topK })).hits
    state.topK = topK
    state.searched = true
    state.document = null
    state.documentId = ''
    $('#hits').dataset.paint = ''
    $('#doc').dataset.paint = ''
    showError('')
    renderKnowledge()
  } catch (error) {
    showError(error.message)
  }
})

$('#hits').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-doc]')
  if (!button) return
  try {
    await openKnowledgeDocument(button.dataset.doc)
  } catch (error) {
    showError(error.message)
  }
})

async function openKnowledgeDocument(docId) {
  // 管理页的列表接口本来就带全文（operator 可见），优先用它渲染。
  // 详情接口会按 actors 做可见性校验，受限文档会被报成「文档不存在」，
  // 但列表里已经能看到同样内容，没必要再走那个校验。
  const listed = state.docs.find((doc) => doc.docId === docId && typeof doc.content === 'string')
  state.document = listed
    ? { content: listed.content, source: listed.source, meta: { docId: listed.docId, title: listed.title } }
    : (await api('POST', '/api/knowledge/documents', { doc_id: docId })).document
  state.documentId = docId
  state.kbEditing = false
  state.kbCreating = false
  renderKnowledge()
}

function openDocEditor(doc) {
  state.kbEditing = true
  state.kbCreating = !doc
  const form = $('#doc-form')
  clearForm(form)
  if (doc) fillDocForm(doc)
  renderKnowledge()
  if (!doc) form.elements.namedItem('id').focus()
}

$('#kb-new').addEventListener('click', () => openDocEditor(null))

$('#kb-clear').addEventListener('click', () => {
  state.searched = false
  state.hits = []
  $('#search').elements.namedItem('query').value = ''
  renderKnowledge()
})

$('#doc-cancel').addEventListener('click', () => {
  state.kbEditing = false
  state.kbCreating = false
  clearForm($('#doc-form'))
  renderKnowledge()
})

$('#doc-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const form = event.currentTarget
  const data = new FormData(form)
  const actors = String(data.get('actors') || '').split(',').map((item) => item.trim()).filter(Boolean)
  const docId = String(data.get('id') || '').trim()
  const title = String(data.get('title') || '').trim()
  const source = String(data.get('source') || '').trim()
  const content = String(data.get('content') || '').trim()
  try {
    await api('POST', '/api/knowledge/docs', {
      id: docId,
      title,
      source,
      content,
      ...(actors.length ? { actors } : {}),
    })
    clearForm(form)
    state.kbEditing = false
    state.kbCreating = false
    state.document = { content, source, meta: { docId, title } }
    state.documentId = docId
    showError('')
    await refresh()
  } catch (error) {
    showError(error.message)
  }
})

$('#doc').addEventListener('click', async (event) => {
  const edit = event.target.closest('[data-edit-doc]')
  if (edit) {
    const doc = state.docs.find((item) => item.docId === edit.dataset.editDoc)
    if (doc) openDocEditor(doc)
    return
  }
  const remove = event.target.closest('[data-delete-doc]')
  if (!remove) return
  if (!window.confirm(`删除文档 ${remove.dataset.deleteDoc}？`)) return
  try {
    const docId = remove.dataset.deleteDoc
    await api('DELETE', `/api/knowledge/docs/${encodeURIComponent(docId)}`)
    state.hits = state.hits.filter((hit) => hit.docId !== docId)
    if (state.documentId === docId) {
      state.document = null
      state.documentId = ''
    }
    await refresh()
  } catch (error) {
    showError(error.message)
  }
})

$('#asset-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const form = event.currentTarget
  const data = new FormData(form)
  const port = String(data.get('sshPort') || '').trim()
  const readPaths = String(data.get('sshReadPaths') || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  try {
    await api('POST', '/api/assets', {
      name: String(data.get('name') || '').trim(),
      host: String(data.get('host') || '').trim(),
      ip: String(data.get('ip') || '').trim(),
      env: String(data.get('env') || '').trim(),
      owner: String(data.get('owner') || '').trim(),
      tier: String(data.get('tier') || '').trim(),
      repo: String(data.get('repo') || '').trim(),
      sshPort: port ? Number(port) : undefined,
      sshUser: String(data.get('sshUser') || '').trim(),
      sshCredentialId: String(data.get('sshCredentialId') || '').trim(),
      sshJumpAsset: String(data.get('sshJumpAsset') || '').trim(),
      ...(isAdmin() ? { sshReadPaths: readPaths } : {}),
      note: String(data.get('note') || '').trim(),
    })
    clearForm(form)
    showError('')
    await refresh()
  } catch (error) {
    showError(error.message)
  }
})

$('#asset-reset').addEventListener('click', () => {
  clearForm($('#asset-form'))
})

async function runKnownHostsImport(apply) {
  const input = $('#known-hosts-input')
  const notice = $('#known-hosts-notice')
  const text = input ? input.value : ''
  const show = (message) => {
    if (!notice) return
    notice.hidden = !message
    notice.textContent = message || ''
  }
  if (!text.trim()) {
    show('先粘贴 known_hosts 内容。')
    return
  }
  try {
    const result = await api('POST', '/api/assets/known-hosts/import', { content: text, apply })
    const lines = [
      result.apply ? '已应用' : '预检结果',
      `条目 ${result.entries}`,
      result.applied.length ? `已导入 ${result.applied.join('、')}` : '',
      result.pending.length ? `可导入 ${result.pending.join('、')}` : '',
      result.unchanged.length ? `已一致 ${result.unchanged.length}` : '',
      result.conflicts.length ? `冲突 ${result.conflicts.map((item) => item.asset).join('、')}（不覆盖）` : '',
      result.ambiguous.length ? `多指纹歧义 ${result.ambiguous.map((item) => item.asset).join('、')}` : '',
      result.unmatched.length ? `未匹配 ${result.unmatched.length} 个资产` : '',
      result.skipped.length ? `跳过 ${result.skipped.length} 行` : '',
    ].filter(Boolean)
    show(lines.join(' · '))
    if (apply && result.applied.length) await refresh()
  } catch (error) {
    show(error.message)
    showError(error.message)
  }
}

$('#known-hosts-dry-run')?.addEventListener('click', () => void runKnownHostsImport(false))
$('#known-hosts-apply')?.addEventListener('click', () => {
  if (!window.confirm('把唯一匹配的指纹写入尚未信任的资产？已信任的指纹不会被覆盖。')) return
  void runKnownHostsImport(true)
})

function assetNotice(message, tone = '') {
  const node = state.view === 'asset-manage' ? $('#asset-notice-manage') : $('#asset-notice')
  if (!node) return
  node.hidden = !message
  node.textContent = message || ''
  node.className = `notice${tone ? ` ${tone}` : ''}`
  if (message && tone) node.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
}

async function onAssetAction(event) {
  const check = event.target.closest('[data-check-hostkey]')
  if (check) {
    const name = check.dataset.checkHostkey
    showError('')
    assetNotice(`正在探测 ${name} 的主机密钥…`, 'progress')
    try {
      const probe = await api('POST', `/api/assets/${encodeURIComponent(name)}/ssh-host-key/probe`)
      const asset = state.assets.find((item) => item.name === name)
      const expected = asset?.sshHostKeyFingerprint || probe.expected
      if (probe.trusted) {
        assetNotice(`主机密钥一致：${probe.fingerprint}`, 'ok')
        return
      }
      const message = expected
        ? `主机密钥与已信任的不一致！\n已信任：${expected}\n当前返回：${probe.fingerprint}\n\n可能是主机重装，也可能是中间人攻击。确认替换并信任新指纹？`
        : `主机返回密钥指纹：\n${probe.fingerprint}\n\n确认信任？信任后 SSH 才会连接该资产。`
      if (!window.confirm(message)) {
        assetNotice(`未信任，当前主机指纹：${probe.fingerprint}`, 'error')
        return
      }
      await api('POST', `/api/assets/${encodeURIComponent(name)}/ssh-host-key/trust`, {
        fingerprint: probe.fingerprint,
        ...(expected ? { previousFingerprint: expected } : {}),
      })
      assetNotice(`已信任主机密钥：${probe.fingerprint}`, 'ok')
      await refresh()
    } catch (error) {
      assetNotice(error.message, 'error')
    }
    return
  }
  const test = event.target.closest('[data-test-ssh]')
  if (test) {
    const name = test.dataset.testSsh
    test.disabled = true
    // 连接结果只留在资产页的提示条里；顶部全局错误条会跨页面残留，这里主动清掉且不再写入。
    showError('')
    assetNotice(`正在连接 ${name}，最多等待 15 秒…`, 'progress')
    try {
      const result = await api('POST', `/api/assets/${encodeURIComponent(name)}/ssh-test`)
      const via = result.jumps && result.jumps.length ? `经跳板机 ${result.jumps.join(' → ')}，` : ''
      assetNotice(`连接成功：${result.user}@${result.host}:${result.port}，${via}耗时 ${result.latencyMs} ms；主机密钥 ${result.hostKeyFingerprint}`, 'ok')
    } catch (error) {
      assetNotice(`连接失败：${error.message}`, 'error')
    } finally {
      test.disabled = false
    }
    return
  }
  const edit = event.target.closest('[data-edit-asset]')
  if (edit) {
    const asset = state.assets.find((item) => item.name === edit.dataset.editAsset)
    if (asset) {
      if (state.view !== 'asset-manage') await switchView('asset-manage')
      fillAssetForm(asset)
    }
    return
  }
  const remove = event.target.closest('[data-delete-asset]')
  if (!remove) return
  if (!window.confirm(`删除资产 ${remove.dataset.deleteAsset}？`)) return
  try {
    await api('DELETE', `/api/assets/${encodeURIComponent(remove.dataset.deleteAsset)}`)
    await refresh()
  } catch (error) {
    showError(error.message)
  }
}

$('#asset-list').addEventListener('click', onAssetAction)
$('#asset-table').addEventListener('click', onAssetAction)

$('#credential-type').addEventListener('change', setCredentialType)

$('#credential-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const form = event.currentTarget
  const data = new FormData(form)
  const type = String(data.get('type') || 'password')
  const id = String(data.get('id') || '').trim()
  const payload = {
    ...(id ? { id } : {}),
    name: String(data.get('name') || '').trim(),
    type,
    ...(type === 'password'
      ? { password: String(data.get('password') || '') }
      : {
          privateKey: String(data.get('privateKey') || ''),
          passphrase: String(data.get('passphrase') || ''),
        }),
  }
  try {
    await api('POST', '/api/credentials', payload)
    clearForm(form)
    setCredentialType()
    showError('')
    await refresh()
  } catch (error) {
    showError(error.message)
  }
})

$('#credential-reset').addEventListener('click', () => {
  clearForm($('#credential-form'))
  setCredentialType()
})

$('#credential-list').addEventListener('click', async (event) => {
  const edit = event.target.closest('[data-edit-credential]')
  if (edit) {
    const credential = state.credentials.find((item) => item.id === edit.dataset.editCredential)
    if (credential) fillCredentialForm(credential)
    return
  }
  const remove = event.target.closest('[data-delete-credential]')
  if (!remove) return
  if (!window.confirm(`删除凭证 ${remove.dataset.deleteCredential}？`)) return
  try {
    await api('DELETE', `/api/credentials/${encodeURIComponent(remove.dataset.deleteCredential)}`)
    await refresh()
  } catch (error) {
    showError(error.message)
  }
})

$('#mcp-edit-toggle').addEventListener('click', () => {
  const editor = $('#mcp-editor')
  const open = editor.hidden
  editor.hidden = !open
  state.mcpEditorOpen = open
  if (open) {
    $('#mcp-json').value = JSON.stringify(state.mcpServers, null, 2)
    editor.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
})

$('#mcp-close').addEventListener('click', () => {
  $('#mcp-editor').hidden = true
  state.mcpEditorOpen = false
})

$('#mcp-connection-table').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-review-mcp]')
  if (!button) return
  const name = button.dataset.reviewMcp
  try {
    const result = await api('POST', `/api/mcp-servers/${encodeURIComponent(name)}/review`)
    state.mcpHealth = result.health || []
    state.mcpNotice = `${name} 工具集复核已确认。`
    state.mcpNoticeTone = 'ok'
    showError('')
    await refresh()
  } catch (error) {
    showError(error.message)
  }
})

$('#mcp-health-check').addEventListener('click', async () => {
  const button = $('#mcp-health-check')
  button.disabled = true
  try {
    const result = await api('POST', '/api/mcp-servers/health')
    const health = result.health || []
    const allHealthy = health.every((item) => item.ok)
    state.mcpNotice = allHealthy
      ? 'MCP 健康检测完成：全部正常。'
      : 'MCP 健康检测完成：有 server 异常，详见健康列和错误提示。'
    state.mcpNoticeTone = allHealthy ? 'ok' : 'warn'
    showError('')
    await refresh()
  } catch (error) {
    showError(error.message)
  } finally {
    button.disabled = false
  }
})

$('#mcp-reload').addEventListener('click', async () => {
  try {
    const result = await api('GET', '/api/mcp-servers')
    state.mcpServers = result.servers
    state.mcpErrors = result.errors || []
    state.mcpHealth = result.health || []
    $('#mcp-json').value = JSON.stringify(state.mcpServers, null, 2)
    showError('')
  } catch (error) {
    showError(error.message)
  }
})

$('#mcp-save').addEventListener('click', async () => {
  let parsed
  try {
    parsed = JSON.parse($('#mcp-json').value)
  } catch (error) {
    showError(`JSON 解析失败：${error.message}`)
    return
  }
  if (!Array.isArray(parsed)) {
    showError('MCP 配置必须是数组')
    return
  }
  try {
    const result = await api('POST', '/api/mcp-servers', { servers: parsed })
    state.mcpServers = result.servers
    state.mcpHealth = result.health || []
    state.mcpNotice = 'MCP 配置已保存并已热加载。'
    state.mcpNoticeTone = 'ok'
    $('#mcp-json').value = JSON.stringify(result.servers, null, 2)
    showError('')
    await refresh()
  } catch (error) {
    showError(error.message)
  }
})

$('#model-new').addEventListener('click', () => openModelEditor(null))

$('#model-cancel').addEventListener('click', closeModelEditor)

$('#model-reload').addEventListener('click', async () => {
  try {
    await loadModelProviders(true)
    state.modelNotice = '模型 provider 列表已刷新。'
    state.modelNoticeTone = 'ok'
    renderModel()
  } catch (error) {
    state.modelNotice = error.message
    state.modelNoticeTone = 'error'
    renderModel()
  }
})

$('#task-provider').addEventListener('change', renderTaskModelOptions)

$('#model-save').addEventListener('click', async () => {
  const form = $('#model-form')
  const data = new FormData(form)
  const editing = String(data.get('editingName') || '')
  const name = (editing || String(data.get('name') || '')).trim()
  const baseUrl = String(data.get('baseUrl') || '').trim()
  const defaultModel = String(data.get('defaultModel') || '').trim()
  if (!name || !baseUrl || !defaultModel) {
    state.modelNotice = '名称、Base URL 和默认模型必填。'
    state.modelNoticeTone = 'error'
    renderModel()
    return
  }
  const models = String(data.get('models') || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  const payload = {
    name,
    baseUrl,
    models,
    defaultModel,
    enabled: form.elements.namedItem('enabled').checked,
    isDefault: form.elements.namedItem('isDefault').checked,
    stream: form.elements.namedItem('stream').checked,
  }
  const apiKey = String(data.get('apiKey') || '').trim()
  if (apiKey) payload.apiKey = apiKey
  if (editing) payload.apiKeyEnv = String(data.get('apiKeyEnv') || '').trim()
  else if (String(data.get('apiKeyEnv') || '').trim()) payload.apiKeyEnv = String(data.get('apiKeyEnv')).trim()
  if (form.elements.namedItem('clearApiKey').checked) payload.clearApiKey = true
  for (const key of ['timeoutMs', 'maxTokens', 'temperature', 'maxRetries', 'retryBackoffMs']) {
    const raw = String(data.get(key) || '').trim()
    if (raw !== '') payload[key] = Number(raw)
    if (raw !== '' && !Number.isFinite(payload[key])) {
      state.modelNotice = `${key} 必须是数字。`
      state.modelNoticeTone = 'error'
      renderModel()
      return
    }
  }
  for (const key of ['inputCostPer1M', 'outputCostPer1M']) {
    const raw = String(data.get(key) || '').trim()
    if (raw !== '') payload[key] = Number(raw)
    else if (editing) payload[key] = null
    if (raw !== '' && !Number.isFinite(payload[key])) {
      state.modelNotice = `${key} 必须是数字。`
      state.modelNoticeTone = 'error'
      renderModel()
      return
    }
  }
  const currency = String(data.get('currency') || '').trim().toUpperCase()
  if (currency) payload.currency = currency
  try {
    const result = await api('POST', '/api/model-providers', payload)
    state.modelFormOpen = false
    state.modelEditing = ''
    await loadModelProviders(true)
    state.modelNotice = `已保存 ${result.provider.name}。`
    state.modelNoticeTone = 'ok'
    renderModel()
  } catch (error) {
    state.modelNotice = error.message
    state.modelNoticeTone = 'error'
    renderModel()
  }
})

$('#model-provider-table').addEventListener('click', async (event) => {
  const edit = event.target.closest('[data-edit-model]')
  if (edit) {
    const provider = state.modelProviders.find((item) => item.name === edit.dataset.editModel)
    if (provider) openModelEditor(provider)
    return
  }
  const test = event.target.closest('[data-test-model]')
  if (test) {
    const name = test.dataset.testModel
    const provider = state.modelProviders.find((item) => item.name === name)
    test.disabled = true
    try {
      const result = await api('POST', `/api/model-providers/${encodeURIComponent(name)}/test`, {
        ...(provider ? { model: provider.defaultModel } : {}),
      })
      state.modelNotice = `${name} 连接成功：模型 ${result.result.model}，耗时 ${result.result.latencyMs}ms，回复「${result.result.reply || '空'}」。`
      state.modelNoticeTone = 'ok'
    } catch (error) {
      state.modelNotice = `${name} 连接失败：${error.message}`
      state.modelNoticeTone = 'error'
    } finally {
      test.disabled = false
      renderModel()
    }
    return
  }
  const discover = event.target.closest('[data-discover-model]')
  if (discover) {
    const name = discover.dataset.discoverModel
    discover.disabled = true
    try {
      const result = await api('POST', `/api/model-providers/${encodeURIComponent(name)}/models/refresh`)
      const provider = state.modelProviders.find((item) => item.name === name)
      if (provider) openModelEditor(provider)
      const models = result.models || []
      const form = $('#model-form')
      form.elements.namedItem('models').value = models.join(',')
      if (models.length > 0 && !models.includes(form.elements.namedItem('defaultModel').value)) {
        form.elements.namedItem('defaultModel').value = models[0]
      }
      state.modelNotice = `拉取到 ${models.length} 个模型，确认后点保存生效。`
      state.modelNoticeTone = 'ok'
    } catch (error) {
      state.modelNotice = `${name} 拉取模型失败：${error.message}`
      state.modelNoticeTone = 'error'
    } finally {
      discover.disabled = false
      renderModel()
    }
    return
  }
  const remove = event.target.closest('[data-delete-model]')
  if (!remove) return
  const name = remove.dataset.deleteModel
  if (!window.confirm(`删除模型 provider ${name}？`)) return
  try {
    await api('DELETE', `/api/model-providers/${encodeURIComponent(name)}`)
    state.modelNotice = `已删除 ${name}。`
    state.modelNoticeTone = 'ok'
    await loadModelProviders(true)
    if (state.modelEditing === name) closeModelEditor()
  } catch (error) {
    state.modelNotice = error.message
    state.modelNoticeTone = 'error'
  }
  renderModel()
})

$('#notification-new').addEventListener('click', () => openNotificationEditor(null))

$('#notification-cancel').addEventListener('click', closeNotificationEditor)

$('#notification-reload').addEventListener('click', async () => {
  await loadNotifications(true)
  state.notificationNotice = '通知配置已刷新。'
  state.notificationNoticeTone = 'ok'
  renderNotifications()
})

$('#notification-settings-save').addEventListener('click', async () => {
  const form = $('#notification-settings')
  const minIntervalMs = Number(form.elements.namedItem('minIntervalMs').value)
  if (!Number.isInteger(minIntervalMs) || minIntervalMs < 0) {
    state.notificationNotice = '最小间隔必须是非负整数。'
    state.notificationNoticeTone = 'error'
    renderNotifications()
    return
  }
  try {
    const result = await api('PUT', '/api/notifications', {
      enabled: form.elements.namedItem('enabled').checked,
      minIntervalMs,
    })
    state.notifications.settings = result.settings
    state.notificationNotice = '通知设置已保存。'
    state.notificationNoticeTone = 'ok'
    showError('')
  } catch (error) {
    state.notificationNotice = error.message
    state.notificationNoticeTone = 'error'
  }
  renderNotifications()
})

$('#notification-save').addEventListener('click', async () => {
  const form = $('#notification-form')
  const data = new FormData(form)
  const editingId = String(data.get('editingId') || '')
  const name = String(data.get('name') || '').trim()
  const url = String(data.get('url') || '').trim()
  const secret = String(data.get('secret') || '').trim()
  const clearSecret = form.elements.namedItem('clearSecret').checked
  const events = [...form.querySelectorAll('[data-notification-event]:checked')]
    .map((input) => input.dataset.notificationEvent)
  if (!name) {
    state.notificationNotice = '名称必填。'
    state.notificationNoticeTone = 'error'
    renderNotifications()
    return
  }
  if (!editingId && !url) {
    state.notificationNotice = '新增 webhook 必须填写 URL。'
    state.notificationNoticeTone = 'error'
    renderNotifications()
    return
  }
  if (events.length === 0) {
    state.notificationNotice = '至少选择一个事件。'
    state.notificationNoticeTone = 'error'
    renderNotifications()
    return
  }
  const payload = {
    name,
    format: String(data.get('format') || 'generic'),
    events,
    enabled: form.elements.namedItem('enabled').checked,
    ...(url ? { url } : {}),
    ...(secret ? { secret } : {}),
    ...(clearSecret ? { clearSecret: true } : {}),
  }
  try {
    if (editingId) await api('PUT', `/api/notifications/webhooks/${encodeURIComponent(editingId)}`, payload)
    else await api('POST', '/api/notifications/webhooks', payload)
    state.notificationFormOpen = false
    state.notificationEditing = ''
    await loadNotifications(true)
    state.notificationNotice = editingId ? `已更新 ${name}。` : `已新增 ${name}。`
    state.notificationNoticeTone = 'ok'
    showError('')
  } catch (error) {
    state.notificationNotice = error.message
    state.notificationNoticeTone = 'error'
  }
  renderNotifications()
})

$('#notification-webhook-table').addEventListener('click', async (event) => {
  const edit = event.target.closest('[data-edit-notification]')
  if (edit) {
    const webhook = state.notifications.webhooks.find((item) => item.id === edit.dataset.editNotification)
    if (webhook) openNotificationEditor(webhook)
    return
  }
  const test = event.target.closest('[data-test-notification]')
  if (test) {
    const id = test.dataset.testNotification
    test.disabled = true
    try {
      const result = await api('POST', `/api/notifications/webhooks/${encodeURIComponent(id)}/test`)
      state.notificationNotice = result.result?.ok
        ? `${result.result.webhook} 测试消息已发送。`
        : `${result.result?.webhook || id} 测试失败：${result.result?.error || '未知错误'}`
      state.notificationNoticeTone = result.result?.ok ? 'ok' : 'error'
    } catch (error) {
      state.notificationNotice = `测试失败：${error.message}`
      state.notificationNoticeTone = 'error'
    } finally {
      test.disabled = false
      renderNotifications()
    }
    return
  }
  const remove = event.target.closest('[data-delete-notification]')
  if (!remove) return
  const id = remove.dataset.deleteNotification
  const webhook = state.notifications.webhooks.find((item) => item.id === id)
  if (!window.confirm(`删除通知 webhook ${webhook?.name || id}？`)) return
  try {
    await api('DELETE', `/api/notifications/webhooks/${encodeURIComponent(id)}`)
    await loadNotifications(true)
    state.notificationNotice = `已删除 ${webhook?.name || id}。`
    state.notificationNoticeTone = 'ok'
    if (state.notificationEditing === id) closeNotificationEditor()
  } catch (error) {
    state.notificationNotice = error.message
    state.notificationNoticeTone = 'error'
  }
  renderNotifications()
})

$('#alert-source-new').addEventListener('click', () => openAlertSourceEditor(null))

$('#alert-source-cancel').addEventListener('click', closeAlertSourceEditor)

$('#alert-source-reload').addEventListener('click', async () => {
  await loadAlertSources(true)
  state.alertSourceNotice = '告警接入配置已刷新。'
  state.alertSourceNoticeTone = 'ok'
  renderAlertSources()
})

$('#alert-provider').addEventListener('change', syncAlertModelOptions)

$('#alert-source-save').addEventListener('click', async () => {
  const form = $('#alert-source-form')
  const editingId = form.elements.namedItem('editingId').value
  const name = form.elements.namedItem('name').value.trim()
  const actorId = form.elements.namedItem('actorId').value
  const cooldownMinutes = Number(form.elements.namedItem('cooldownMinutes').value)
  if (!name) {
    state.alertSourceNotice = '名称必填。'
    state.alertSourceNoticeTone = 'error'
    renderAlertSources()
    return
  }
  if (!actorId) {
    state.alertSourceNotice = '请选择归属账号。'
    state.alertSourceNoticeTone = 'error'
    renderAlertSources()
    return
  }
  if (!Number.isInteger(cooldownMinutes) || cooldownMinutes < 0 || cooldownMinutes > 1440) {
    state.alertSourceNotice = '冷却窗口必须是 0-1440 的整数分钟。'
    state.alertSourceNoticeTone = 'error'
    renderAlertSources()
    return
  }
  const provider = form.elements.namedItem('provider').value
  const model = form.elements.namedItem('model').value
  const payload = {
    name,
    format: form.elements.namedItem('format').value,
    actorId,
    maxSeverity: Number(form.elements.namedItem('maxSeverity').value),
    cooldownMs: cooldownMinutes * 60000,
    enabled: form.elements.namedItem('enabled').checked,
    skill: form.elements.namedItem('skill').value,
    skills: [...form.querySelectorAll('[data-alert-skill]:checked')].map((input) => input.dataset.alertSkill),
    notifyWebhookIds: [...form.querySelectorAll('[data-alert-webhook]:checked')].map((input) => input.dataset.alertWebhook),
    // 显式传空字符串表示清除；后端字段缺省才是保持原值。
    provider: provider || '',
    model: provider ? model : '',
  }
  try {
    const result = editingId
      ? await api('PUT', `/api/alert-sources/${encodeURIComponent(editingId)}`, payload)
      : await api('POST', '/api/alert-sources', payload)
    state.alertSourceFormOpen = false
    state.alertSourceEditing = ''
    await loadAlertSources(true)
    if (result.token) {
      state.alertSourceToken = result.token
      state.alertSourcePath = result.source.path
      state.alertSourceNotice = `已创建 ${name}，请把接入地址和 Token 配置到告警系统。`
      state.alertSourceNoticeTone = 'ok'
    } else {
      state.alertSourceNotice = `已更新 ${name}。`
      state.alertSourceNoticeTone = 'ok'
    }
    showError('')
  } catch (error) {
    state.alertSourceNotice = error.message
    state.alertSourceNoticeTone = 'error'
  }
  renderAlertSources()
})

$('#alert-source-table').addEventListener('click', async (event) => {
  const edit = event.target.closest('[data-edit-alert-source]')
  if (edit) {
    const source = state.alertSources.find((item) => item.id === edit.dataset.editAlertSource)
    if (source) openAlertSourceEditor(source)
    return
  }
  const test = event.target.closest('[data-test-alert-source]')
  if (test) {
    const id = test.dataset.testAlertSource
    test.disabled = true
    try {
      const result = await api('POST', `/api/alert-sources/${encodeURIComponent(id)}/test`, {})
      state.alertSourceNotice = result.accepted
        ? `已用模拟告警发起排查任务 ${result.taskId}，可在任务页查看。`
        : `未发起排查：${ALERT_REASONS[result.reason] || result.reason || '被忽略'}。`
      state.alertSourceNoticeTone = result.accepted ? 'ok' : 'warn'
    } catch (error) {
      state.alertSourceNotice = `测试失败：${error.message}`
      state.alertSourceNoticeTone = 'error'
    } finally {
      test.disabled = false
      renderAlertSources()
    }
    return
  }
  const rotate = event.target.closest('[data-rotate-alert-source]')
  if (rotate) {
    const id = rotate.dataset.rotateAlertSource
    const source = state.alertSources.find((item) => item.id === id)
    if (!window.confirm(`轮换 ${source?.name || id} 的 Token？旧 Token 立即失效，告警会收不到。`)) return
    try {
      const result = await api('POST', `/api/alert-sources/${encodeURIComponent(id)}/rotate`, {})
      state.alertSourceToken = result.token
      state.alertSourcePath = result.source.path
      state.alertSourceNotice = `已轮换 ${source?.name || id} 的 Token，请更新告警系统配置。`
      state.alertSourceNoticeTone = 'ok'
      await loadAlertSources(true)
    } catch (error) {
      state.alertSourceNotice = error.message
      state.alertSourceNoticeTone = 'error'
    }
    renderAlertSources()
    return
  }
  const remove = event.target.closest('[data-delete-alert-source]')
  if (!remove) return
  const id = remove.dataset.deleteAlertSource
  const source = state.alertSources.find((item) => item.id === id)
  if (!window.confirm(`删除告警接入 ${source?.name || id}？对应回调地址会立即失效。`)) return
  try {
    await api('DELETE', `/api/alert-sources/${encodeURIComponent(id)}`)
    await loadAlertSources(true)
    state.alertSourceNotice = `已删除 ${source?.name || id}。`
    state.alertSourceNoticeTone = 'ok'
    if (state.alertSourceEditing === id) closeAlertSourceEditor()
  } catch (error) {
    state.alertSourceNotice = error.message
    state.alertSourceNoticeTone = 'error'
  }
  renderAlertSources()
})

$('#logout')?.addEventListener('click', async () => {
  try {
    await api('POST', '/api/auth/logout')
  } catch (error) {
    // 会话可能已失效，直接回登录页
  }
  window.location.replace('/login')
})

function settingsNotice(message) {
  const node = $('#settings-notice')
  if (!node) return
  node.hidden = !message
  node.textContent = message || ''
}

async function loadSecurityEvents() {
  const query = new URLSearchParams()
  query.set('limit', String(state.securityPageSize))
  query.set('offset', String((state.securityPage - 1) * state.securityPageSize))
  try {
    const result = await api('GET', `/api/security-events?${query}`)
    const total = result.total ?? result.events.length
    const pages = Math.max(1, Math.ceil(total / state.securityPageSize))
    if (state.securityPage > pages) {
      state.securityPage = pages
      await loadSecurityEvents()
      return
    }
    state.securityEvents = result.events
    state.securityTotal = total
    renderAccount()
  } catch (error) {
    showError(error.message)
  }
}

$('#security-pager')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-page]')
  if (!button || button.disabled) return
  state.securityPage = Number(button.dataset.page)
  void loadSecurityEvents()
})

$('#security-refresh')?.addEventListener('click', () => {
  void loadSecurityEvents()
})

$('#security-export')?.addEventListener('click', () => {
  // 走浏览器下载，复用当前 Cookie；服务端按 auditor/admin 校验权限。
  window.location.href = '/api/security-events/export?format=csv'
})

$('#password-form')?.addEventListener('submit', async (event) => {
  event.preventDefault()
  const form = event.currentTarget
  try {
    await api('POST', '/api/auth/password', {
      currentPassword: form.elements.namedItem('currentPassword').value,
      newPassword: form.elements.namedItem('newPassword').value,
    })
    clearForm(form)
    if (state.me) state.me.mustChangePassword = false
    showError('')
    settingsNotice('密码已修改，其他设备上的会话已失效。')
    await refresh()
  } catch (error) {
    showError(error.message)
  }
})

$('#session-table')?.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-revoke-session]')
  if (!button) return
  if (!window.confirm('注销后该浏览器需要重新登录，确定吗？')) return
  try {
    await api('DELETE', `/api/auth/sessions/${encodeURIComponent(button.dataset.revokeSession)}`)
    settingsNotice('会话已注销。')
    await refresh()
  } catch (error) {
    showError(error.message)
  }
})

$('#revoke-other-sessions')?.addEventListener('click', async () => {
  if (!window.confirm('注销其他所有网页会话？当前会话会保留。')) return
  try {
    const result = await api('DELETE', '/api/auth/sessions')
    settingsNotice(`已注销 ${result.revoked || 0} 个其他会话。`)
    await refresh()
  } catch (error) {
    showError(error.message)
  }
})

$('#key-form')?.addEventListener('submit', async (event) => {
  event.preventDefault()
  const form = event.currentTarget
  const scopes = [...form.querySelectorAll('input[type="checkbox"]:checked')].map((item) => item.value)
  if (scopes.length === 0) {
    showError('至少选择一个 scope')
    return
  }
  const expires = form.elements.namedItem('expiresAt').value
  try {
    const result = await api('POST', '/api/auth/keys', {
      name: form.elements.namedItem('name').value,
      scopes,
      ...(expires ? { expiresAt: new Date(expires).toISOString() } : {}),
    })
    state.keyToken = result.token
    state.keyTokenLabel = result.key?.name || ''
    paintKeyTokens()
    form.elements.namedItem('name').value = ''
    form.elements.namedItem('expiresAt').value = ''
    settingsNotice('')
    await refresh()
  } catch (error) {
    showError(error.message)
  }
})

$('#key-table')?.addEventListener('click', async (event) => {
  const rotate = event.target.closest('[data-rotate-key]')
  if (rotate) {
    if (!window.confirm('轮换会立即签发新 token 并吊销旧 key，旧 token 马上失效。确定吗？')) return
    try {
      const result = await api('POST', `/api/auth/keys/${encodeURIComponent(rotate.dataset.rotateKey)}/rotate`)
      state.keyToken = result.token
      state.keyTokenLabel = result.key?.name || ''
      paintKeyTokens()
      settingsNotice('旧 token 已立即失效。')
      await refresh()
    } catch (error) {
      showError(error.message)
    }
    return
  }
  const button = event.target.closest('[data-revoke-key]')
  if (!button) return
  if (!window.confirm('吊销后该 token 立即失效，确定吗？')) return
  try {
    await api('DELETE', `/api/auth/keys/${encodeURIComponent(button.dataset.revokeKey)}`)
    settingsNotice('API key 已吊销。')
    await refresh()
  } catch (error) {
    showError(error.message)
  }
})

$('#user-role')?.addEventListener('change', updateRoleHint)
updateRoleHint()

$('#user-form')?.addEventListener('submit', async (event) => {
  event.preventDefault()
  const form = event.currentTarget
  const password = form.elements.namedItem('password').value
  const issueKey = form.elements.namedItem('issueKey').checked
  const keyName = form.elements.namedItem('keyName').value.trim()
  try {
    const result = await api('POST', '/api/users', {
      username: form.elements.namedItem('username').value,
      displayName: form.elements.namedItem('displayName').value,
      ...(password ? { password } : {}),
      roles: [form.elements.namedItem('role').value],
      ...(issueKey ? { issueKey: true, ...(keyName ? { keyName } : {}) } : {}),
    })
    state.keyToken = result.token || ''
    state.keyTokenLabel = result.token ? (result.key?.name || keyName || '') : ''
    paintKeyTokens()
    clearForm(form)
    settingsNotice('用户已创建。')
    await refresh()
  } catch (error) {
    showError(error.message)
  }
})


$('#user-table')?.addEventListener('click', async (event) => {
  const toggle = event.target.closest('[data-toggle-user]')
  if (toggle) {
    try {
      await api('PATCH', `/api/users/${encodeURIComponent(toggle.dataset.toggleUser)}`, {
        status: toggle.dataset.status,
      })
      settingsNotice(toggle.dataset.status === 'disabled' ? '用户已停用，现有会话已失效。' : '用户已启用。')
      await refresh()
    } catch (error) {
      showError(error.message)
    }
    return
  }
  const issue = event.target.closest('[data-issue-key]')
  if (issue) {
    try {
      const result = await api('POST', `/api/users/${encodeURIComponent(issue.dataset.issueKey)}/keys`, {})
      state.keyToken = result.token
      state.keyTokenLabel = result.key?.name || issue.dataset.issueName || ''
      paintKeyTokens()
      settingsNotice(`已为 ${issue.dataset.issueName} 签发 API key。`)
      await refresh()
    } catch (error) {
      showError(error.message)
    }
    return
  }
  const reset = event.target.closest('[data-reset-user]')
  if (!reset) return
  const user = (state.users || []).find((item) => item.id === reset.dataset.resetUser)
  if (user) openResetPassword(user)
})

const resetModal = $('#reset-password-modal')
const resetForm = $('#reset-password-form')

function setResetPasswordError(message) {
  const node = $('#reset-password-error')
  if (!node) return
  node.hidden = !message
  node.textContent = message || ''
}

function toggleResetPasswordVisibility(visible) {
  if (!resetForm) return
  for (const name of ['newPassword', 'confirmPassword']) {
    const input = resetForm.elements.namedItem(name)
    if (input) input.type = visible ? 'text' : 'password'
  }
}

function openResetPassword(user) {
  if (!resetModal || !resetForm) return
  resetForm.reset()
  setResetPasswordError('')
  toggleResetPasswordVisibility(false)
  resetModal.dataset.userId = user.id
  $('#reset-password-target').textContent = `为 ${user.displayName || user.username}（${user.username}）设置新的初始密码`
  resetModal.hidden = false
  window.setTimeout(() => resetForm.elements.namedItem('newPassword')?.focus(), 0)
}

function closeResetPassword() {
  if (!resetModal || resetModal.hidden) return
  resetModal.hidden = true
  resetForm?.reset()
  setResetPasswordError('')
  toggleResetPasswordVisibility(false)
}

resetForm?.addEventListener('change', (event) => {
  if (event.target.matches('[name="showPassword"]')) toggleResetPasswordVisibility(event.target.checked)
})

resetForm?.addEventListener('submit', async (event) => {
  event.preventDefault()
  const password = resetForm.elements.namedItem('newPassword').value
  const confirm = resetForm.elements.namedItem('confirmPassword').value
  if (password.length < 12) {
    setResetPasswordError('新密码至少 12 个字符')
    return
  }
  if (password !== confirm) {
    setResetPasswordError('两次输入的密码不一致')
    return
  }
  const userId = resetModal?.dataset.userId
  if (!userId) return
  setResetPasswordError('')
  const submit = $('#reset-password-submit')
  if (submit) submit.disabled = true
  try {
    await api('POST', `/api/users/${encodeURIComponent(userId)}/password`, { newPassword: password })
    closeResetPassword()
    settingsNotice('密码已重置，该用户现有会话已失效，下次登录需要修改密码。')
    await refresh()
  } catch (error) {
    setResetPasswordError(error.message)
  } finally {
    if (submit) submit.disabled = false
  }
})

resetModal?.addEventListener('click', (event) => {
  if (event.target === resetModal || event.target.closest('[data-close-reset]')) closeResetPassword()
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && resetModal && !resetModal.hidden) closeResetPassword()
})

$('#login-lock-table')?.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-clear-locks]')
  if (!button) return
  const username = button.dataset.clearLocks
  if (!window.confirm(`清除 ${username} 的登录失败记录并解锁？`)) return
  try {
    const result = await api('DELETE', `/api/login-locks/${encodeURIComponent(username)}`)
    settingsNotice(`已清除 ${username} 的 ${result.cleared || 0} 条登录失败记录。`)
    await refresh()
  } catch (error) {
    showError(error.message)
  }
})

$('#who').addEventListener('click', (event) => {
  if (state.authMethod) return
  const button = event.target.closest('[data-actor]')
  if (!button) return
  state.actorId = button.dataset.actor
  localStorage.setItem('aiops-actor', state.actorId)
  state.overview = null
  state.overviewAt = 0
  state.tools = []
  state.skills = []
  state.mcpNotice = ''
  state.mcpNoticeTone = ''
  state.mcpServers = []
  state.mcpHealth = []
  state.mcpEditorOpen = false
  const mcpEditor = $('#mcp-editor')
  if (mcpEditor) mcpEditor.hidden = true
  state.document = null
  state.documentId = ''
  state.hits = []
  state.searched = false
  state.kbEditing = false
  state.kbCreating = false
  clearForm($('#doc-form'))
  $('#tools').dataset.paint = ''
  $('#skills').dataset.paint = ''
  $('#mcp-connection-table').dataset.paint = ''
  $('#approval-list').dataset.paint = ''
  $('#hits').dataset.paint = ''
  $('#doc').dataset.paint = ''
  renderActors()
  void refresh()
})

/** 登录后要回到当前页和 hash，通知里的审批深链不能登录完掉到首页。 */
function redirectToLogin() {
  const next = `${window.location.pathname}${window.location.search}${window.location.hash}`
  window.location.replace(next && next !== '/' ? `/login?next=${encodeURIComponent(next)}` : '/login')
}

function approvalHashMatch() {
  return window.location.hash.match(/^#\/approvals(?:\/([^/?#]+))?$/)
}

/** IM 审批深链 #/approvals/<id>、告警结果深链 #/tasks/<id>；不匹配的 hash 忽略。 */
async function applyHashRoute() {
  const taskMatch = window.location.hash.match(/^#\/tasks\/([^/?#]+)$/)
  if (taskMatch) {
    state.selectedId = decodeURIComponent(taskMatch[1])
    state.status = ''
    state.owner = ''
    state.taskPage = 1
    await switchView('tasks')
    return true
  }
  const match = approvalHashMatch()
  if (!match) return false
  state.approvalStatus = ''
  state.approvalPage = 1
  state.approvalFocus = match[1] ? decodeURIComponent(match[1]) : ''
  state.approvalScrolled = ''
  $('#approval-list').dataset.paint = ''
  await switchView('approvals')
  return true
}

async function loadSession() {
  const response = await fetch('/api/auth/me', { credentials: 'same-origin' })
  if (response.status === 401) {
    redirectToLogin()
    throw new Error('未登录')
  }
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error?.message || `认证失败 ${response.status}`)
  state.authMethod = data.method || 'session'
  state.csrfToken = data.csrfToken || ''
  state.me = data.user
  state.allowAdminSelfApproval = data.allowAdminSelfApproval === true
  state.actorId = data.user.id
  const self = {
    id: data.user.id,
    name: data.user.displayName || data.user.username,
    roles: data.user.roles || [],
  }
  state.actors = [self]
  // 账号模式也要拿到可见身份列表，否则任务列表只能显示 ownerId。
  const actorsResponse = await fetch('/api/actors', { credentials: 'same-origin' }).catch(() => undefined)
  if (actorsResponse?.ok) {
    const actorsBody = await actorsResponse.json().catch(() => ({}))
    if (Array.isArray(actorsBody.actors) && actorsBody.actors.length > 0) state.actors = actorsBody.actors
  }
  if (!state.actors.some((person) => person.id === self.id)) state.actors.unshift(self)
  const label = $('#who-label')
  if (label) label.textContent = '当前用户'
  $('#who')?.classList.add('single')
  const logoutButton = $('#logout')
  if (logoutButton) logoutButton.hidden = false
}

async function boot() {
  const health = await fetch('/health').then((item) => item.json()).catch(() => ({}))
  state.features = health.features || {}
  if (state.features.auth) {
    await loadSession()
  } else {
    const response = await fetch('/api/actors')
    const data = await response.json()
    state.actors = data.actors
    if (!state.actors.some((person) => person.id === state.actorId)) state.actorId = state.actors[0]?.id || 'alice'
  }
  const ownerFilter = $('#owner-filter')
  ownerFilter.innerHTML = `<option value="">全部</option>${state.actors
    .map((person) => `<option value="${esc(person.id)}">${esc(person.name)}</option>`)
    .join('')}`
  ownerFilter.value = state.owner
  renderActors()
  if (state.features.auth && state.me?.mustChangePassword) {
    await switchView('settings')
  } else if (!(await applyHashRoute())) {
    await refresh()
  }
  window.addEventListener('hashchange', () => { void applyHashRoute() })
  window.setInterval(() => {
    if (Date.now() < (state.pollPausedUntil || 0)) return
    void refresh()
  }, 1200)
}

void boot()