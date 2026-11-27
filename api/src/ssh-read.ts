/**
 * SSH 只读白名单：`ssh.read` 只允许这里列出的命令，`ssh.logs` 只允许读资产
 * 声明的路径。命令不会交给远端 shell 自由解释：先按空白切 token，每个 token
 * 限定字符集，再按「命令 + 参数模板」精确匹配，最后用固定的 argv 拼回命令。
 */
export const SSH_READ_TIMEOUT_MS = 15_000
export const SSH_READ_MAX_TIMEOUT_MS = 30_000
export const SSH_READ_MAX_OUTPUT = 64_000
export const SSH_LOGS_MAX_LINES = 500
export const SSH_READ_MAX_PATHS = 20
/** ssh.cat 单文件上限，和只读通道输出上限一致；更大的文件走 ssh.logs。 */
export const SSH_CAT_MAX_BYTES = 64_000

/** 命令 token 和日志路径共用同一套安全字符，杜绝管道、重定向、引号、通配符和命令替换。 */
const SAFE_TOKEN = /^[A-Za-z0-9@%+=:_,.\/-]+$/
/**
 * systemd unit 名：不带斜杠，不以 `-` 开头（防止把 `--help` 之类当 unit 变成选项），
 * 后缀可省略（`nginx` 和 `nginx.service` 都接受）。
 */
const UNIT = /^[A-Za-z0-9@_.][A-Za-z0-9@:_.-]{0,127}(\.(service|socket|timer|mount|target|slice|path|device))?$/

/** 精确匹配的只读命令。只收系统层诊断，不碰文件（文件走 ssh.logs / ssh.cat / ssh.ls）。 */
const EXACT = new Set([
  // 身份与系统
  'hostnamectl',
  'uname -a',
  'uname -r',
  'whoami',
  'id',
  'date',
  'uptime',
  'nproc',
  'lscpu',
  // 负载与内存
  'free -m',
  'free -h',
  'free -g',
  'vmstat 1 3',
  'vmstat -s',
  // 磁盘
  'df -h',
  'df -i',
  'df -hT',
  'df -Th',
  'df -P',
  'lsblk',
  'lsblk -f',
  // 进程
  'ps aux',
  'ps -ef',
  'ps -eo pid,ppid,pcpu,pmem,etime,comm --sort=-pcpu',
  'top -bn1',
  // 网络
  'ss -s',
  'ss -lnt',
  'ss -lntp',
  'ss -lunp',
  'ss -tan',
  'ss -tunlp',
  'ip -br addr',
  'ip -br link',
  'ip route',
  'ip neigh',
  // systemd 与内核
  'systemctl --failed --no-pager',
  'dmesg -T --level=err,warn',
  // 容器运行时：只暴露版本，不碰容器、镜像和配置
  'docker version',
  // 只读的固定系统文件
  'cat /etc/os-release',
  'cat /etc/hostname',
  'cat /etc/timezone',
  'cat /proc/loadavg',
  'cat /proc/meminfo',
  'cat /proc/uptime',
  'cat /proc/version',
])

/**
 * 解析并校验 `ssh.read` 的命令。返回可安全拼接的 argv；任何不在白名单里的
 * 命令或参数都直接报错，不会建立 SSH 连接。
 */
export function parseReadCommand(input: unknown): string[] {
  if (typeof input !== 'string') throw new Error('参数 command 必填')
  const text = input.trim()
  if (!text) throw new Error('参数 command 必填')
  if (text.length > 300) throw new Error('命令过长，只支持白名单里的短命令；需要组合命令请改用 ssh.exec（需审批）')
  const tokens = text.split(/\s+/)
  if (!tokens.every((token) => SAFE_TOKEN.test(token))) {
    throw new Error(
      '命令含有不允许的字符：只支持白名单命令和普通参数，不能使用管道、重定向、引号、通配符或命令替换；换写法重试不会通过，需要组合命令请改用 ssh.exec（需审批）',
    )
  }
  if (EXACT.has(text)) return tokens
  if (tokens.length === 4 && tokens[0] === 'systemctl' && tokens[1] === 'status' && tokens[3] === '--no-pager' && UNIT.test(tokens[2])) {
    return tokens
  }
  if (
    tokens.length === 3 &&
    tokens[0] === 'systemctl' &&
    (tokens[1] === 'is-active' || tokens[1] === 'is-enabled') &&
    UNIT.test(tokens[2])
  ) {
    return tokens
  }
  if (tokens[0] === 'journalctl') {
    const lines = journalLines(tokens)
    if (lines !== undefined) return tokens
    throw new Error(
      `journalctl 只支持固定模板：-p err|warning -n N --no-pager、-u <unit> -n N --no-pager、-k -n N --no-pager（N 为 1-500）；其它形态请改用 ssh.exec（需审批）`,
    )
  }
  if (tokens.length === 3 && tokens[0] === 'systemctl' && tokens[1] === 'status' && UNIT.test(tokens[2])) {
    throw new Error('systemctl status 只支持固定格式：systemctl status <unit> --no-pager；其它形态请改用 ssh.exec（需审批）')
  }
  throw new Error(
    `命令不在只读白名单内：${text}。ssh.read 只支持固定只读模板，换写法重试不会通过；需要执行请改用 ssh.exec（需审批）`,
  )
}

/** journalctl 只接受三种固定形态，且 -n 必须在 1..500。 */
function journalLines(tokens: string[]): number | undefined {
  const lineCount = (value: string | undefined): number | undefined => {
    if (!value || !/^[1-9][0-9]{0,2}$/.test(value)) return undefined
    const n = Number(value)
    return n >= 1 && n <= SSH_LOGS_MAX_LINES ? n : undefined
  }
  if (
    tokens.length === 6 &&
    tokens[1] === '-p' &&
    (tokens[2] === 'err' || tokens[2] === 'warning') &&
    tokens[3] === '-n' &&
    tokens[5] === '--no-pager'
  ) {
    return lineCount(tokens[4])
  }
  if (tokens.length === 6 && tokens[1] === '-u' && UNIT.test(tokens[2]) && tokens[3] === '-n' && tokens[5] === '--no-pager') {
    return lineCount(tokens[4])
  }
  if (tokens.length === 5 && tokens[1] === '-k' && tokens[2] === '-n' && tokens[4] === '--no-pager') {
    return lineCount(tokens[3])
  }
  return undefined
}

/** 资产上配置的单条只读路径：必须是绝对路径，且只有安全字符。 */
export function normalizeReadPath(value: unknown): string {
  if (typeof value !== 'string') throw new Error('SSH 只读路径必须是字符串')
  const text = value.trim()
  if (!text) throw new Error('SSH 只读路径不能为空')
  if (text.length > 512) throw new Error('SSH 只读路径过长')
  if (!SAFE_TOKEN.test(text) || !text.startsWith('/')) {
    throw new Error(`SSH 只读路径必须是绝对路径，且不能包含空格、通配符或 shell 字符：${text}`)
  }
  const trimmed = text.replace(/\/+$/, '')
  if (!trimmed) throw new Error('SSH 只读路径不能是根目录 /')
  if (trimmed.includes('//')) throw new Error(`SSH 只读路径不能包含连续斜杠：${text}`)
  const parts = trimmed.split('/').slice(1)
  if (parts.some((part) => part === '.' || part === '..')) {
    throw new Error(`SSH 只读路径不能包含 . 或 ..：${text}`)
  }
  return trimmed
}

/** 资产配置的路径列表：去重、排序，最多 20 条。 */
export function normalizeReadPaths(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('sshReadPaths 必须是字符串数组')
  const unique = new Set<string>()
  for (const item of value) unique.add(normalizeReadPath(item))
  if (unique.size > SSH_READ_MAX_PATHS) throw new Error(`SSH 只读路径最多 ${SSH_READ_MAX_PATHS} 条`)
  return [...unique].sort()
}

/** 路径是否落在某个允许的根（文件精确匹配，目录按前缀匹配）。 */
export function pathAllowed(value: string, roots: string[]): boolean {
  return roots.some((root) => value === root || value.startsWith(`${root}/`))
}

/** `ssh.logs` 的请求路径：先按资产允许列表校验，再返回规范化路径。 */
export function validateLogPath(value: unknown, roots: string[]): string {
  const requested = normalizeReadPath(value)
  if (!roots.length) throw new Error('该资产没有配置 SSH 只读路径，读取文件或列目录请使用 ssh.exec 走审批')
  if (!pathAllowed(requested, roots)) {
    throw new Error(`路径不在资产允许的只读范围内：${requested}`)
  }
  return requested
}

/** 远端 `readlink -f` 的结果也要落在允许范围内，防止软链逃逸。 */
export function validateRealPath(value: string, roots: string[]): string {
  const text = value.trim()
  if (!SAFE_TOKEN.test(text) || !text.startsWith('/')) {
    throw new Error('远端路径解析结果不合法，已拒绝读取')
  }
  if (!pathAllowed(text, roots)) {
    throw new Error(`软链指向允许范围之外，已拒绝读取：${text}`)
  }
  return text
}

/** grep 只做固定字符串匹配，拒绝空白和 shell 特殊字符，保证单 token 安全。 */
export function normalizeLogPattern(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new Error('参数 grep 必须是字符串')
  const text = value.trim()
  if (!text) return undefined
  if (text.length > 200) throw new Error('grep 字符串过长')
  if (/[\s'"`$;&|<>()*?[\]{}\\!#~]/.test(text) || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new Error('grep 只支持不含空白和 shell 特殊字符的固定字符串')
  }
  return text
}

/** lines 必须是 1..500 的整数。 */
export function normalizeLogLines(value: unknown): number {
  if (value === undefined) return 200
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > SSH_LOGS_MAX_LINES) {
    throw new Error(`lines 必须是 1 到 ${SSH_LOGS_MAX_LINES} 的整数`)
  }
  return value
}

/** 日志读取的 argv：grep 固定串匹配或 tail 最近 N 行，都不经过 shell 拼接。 */
export function buildLogsArgv(pathValue: string, lines: number, pattern?: string): string[] {
  return pattern
    ? ['grep', '-F', '-m', String(lines), '--', pattern, pathValue]
    : ['tail', '-n', String(lines), '--', pathValue]
}

/** `ssh.ls` 只列一层（含隐藏项，不含 . 和 ..），路径已在远端解析并校验。 */
export function buildListArgv(pathValue: string): string[] {
  return ['ls', '-lA', '--', pathValue]
}

/** `ssh.cat` 整文件读取；调用前必须确认是普通文件且不超过 SSH_CAT_MAX_BYTES。 */
export function buildCatArgv(pathValue: string): string[] {
  return ['cat', '--', pathValue]
}

/** `ssh.cat` / `ssh.ls` 用 stat 同时拿类型和字节数。 */
export function buildStatArgv(pathValue: string): string[] {
  return ['stat', '-L', '-c', '%F %s', '--', pathValue]
}