/**
 * 结构化 JSON 日志：一行一个对象，方便 filebeat / Loki 直接采集。
 * info/warn 走 stdout，error 走 stderr；字段里禁止放密码、token、私钥和完整 webhook URL。
 */
export type LogLevel = 'info' | 'warn' | 'error'

export interface LogFields {
  [key: string]: unknown
}

export interface Logger {
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
}

export function createLogger(options: {
  stdout?: (line: string) => void
  stderr?: (line: string) => void
  now?: () => Date
} = {}): Logger {
  const stdout = options.stdout ?? ((line: string) => process.stdout.write(`${line}\n`))
  const stderr = options.stderr ?? ((line: string) => process.stderr.write(`${line}\n`))
  const now = options.now ?? (() => new Date())
  const write = (level: LogLevel, message: string, fields: LogFields = {}) => {
    const line = JSON.stringify({ ts: now().toISOString(), level, msg: message, ...sanitize(fields) })
    ;(level === 'error' ? stderr : stdout)(line)
  }
  return {
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
  }
}

export const log = createLogger()

/** Error 只保留 name/message/code，避免把堆栈和请求体里的敏感内容带进日志。 */
function sanitize(fields: LogFields): LogFields {
  const out: LogFields = {}
  for (const [key, value] of Object.entries(fields)) {
    if (value instanceof Error) {
      out[key] = {
        name: value.name,
        message: value.message,
        ...((value as { code?: unknown }).code !== undefined ? { code: (value as { code?: unknown }).code } : {}),
      }
    } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
      out[key] = value
    } else if (value === undefined) {
      continue
    } else {
      out[key] = value
    }
  }
  return out
}