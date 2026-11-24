import { createHash } from 'node:crypto'

/**
 * 解析 OpenSSH known_hosts。只取指纹，不导入密钥本身；
 * 哈希主机名、通配符、否定模式和 @cert-authority/@revoked 一律跳过并报告原因，
 * 避免把「匹配范围不明」的条目错误地信任到某个资产上。
 */
export interface KnownHostEntry {
  /** known_hosts 里的主机名（小写）；IP 也是原样。 */
  host: string
  port: number
  keyType: string
  fingerprint: string
  line: number
}

export interface SkippedLine {
  line: number
  reason: string
}

export interface ParsedKnownHosts {
  entries: KnownHostEntry[]
  skipped: SkippedLine[]
}

export const MAX_KNOWN_HOSTS_BYTES = 256 * 1024
const MAX_LINES = 4000

export function parseKnownHosts(content: string): ParsedKnownHosts {
  const entries: KnownHostEntry[] = []
  const skipped: SkippedLine[] = []
  const lines = content.split(/\r?\n/)
  if (lines.length > MAX_LINES) throw new Error(`known_hosts 最多 ${MAX_LINES} 行`)
  lines.forEach((raw, index) => {
    const line = index + 1
    const text = raw.trim()
    if (!text || text.startsWith('#')) return
    if (text.startsWith('@')) {
      skipped.push({ line, reason: '不支持 @cert-authority / @revoked 标记，请手工确认' })
      return
    }
    const fields = text.split(/\s+/)
    if (fields.length < 3) {
      skipped.push({ line, reason: '格式不完整' })
      return
    }
    const [hostField, keyType, keyBase64] = fields
    if (hostField.startsWith('|1|')) {
      skipped.push({ line, reason: '哈希主机名无法对应到资产，请用 ssh-keygen -F 查出后手工信任' })
      return
    }
    const hosts: Array<{ host: string; port: number }> = []
    let unsupported: string | undefined
    for (const token of hostField.split(',')) {
      const parsed = parseHostToken(token)
      if (typeof parsed === 'string') {
        unsupported = parsed
        break
      }
      hosts.push(parsed)
    }
    if (unsupported) {
      skipped.push({ line, reason: unsupported })
      return
    }
    const blob = Buffer.from(keyBase64, 'base64')
    if (blob.length < 8) {
      skipped.push({ line, reason: '公钥内容不是合法 base64' })
      return
    }
    const fingerprint = `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`
    for (const host of hosts) {
      entries.push({ ...host, keyType, fingerprint, line })
    }
  })
  return { entries, skipped }
}

function parseHostToken(token: string): { host: string; port: number } | string {
  if (!token) return '主机名为空'
  if (token.startsWith('!')) return '否定模式（!host）不支持，请手工确认'
  if (token.includes('*') || token.includes('?')) return '通配符主机名不支持，请改为明确主机后手工信任'
  if (token.startsWith('|')) return '哈希主机名无法对应到资产，请手工信任'
  if (token.startsWith('[')) {
    const end = token.lastIndexOf(']')
    if (end <= 1) return '主机名格式不合法'
    const host = token.slice(1, end).trim().toLowerCase()
    const rest = token.slice(end + 1)
    if (!host) return '主机名为空'
    if (!rest) return { host, port: 22 }
    if (!rest.startsWith(':')) return '主机名格式不合法'
    const port = Number(rest.slice(1))
    if (!Number.isInteger(port) || port < 1 || port > 65535) return '端口不合法'
    return { host, port }
  }
  if (token.includes(':')) {
    // 未加方括号的 IPv6 或 host:port 无法区分，交给人工处理。
    return '未加方括号的 IPv6/端口写法不支持'
  }
  return { host: token.toLowerCase(), port: 22 }
}

export interface KnownHostMatch {
  fingerprints: string[]
  keyTypes: string[]
}

/** 按资产的主机名/IP 和端口匹配条目。 */
export function matchAsset(
  entries: KnownHostEntry[],
  asset: { host?: string; ip?: string; sshPort?: number },
): KnownHostMatch | undefined {
  const names = new Set(
    [asset.host, asset.ip]
      .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
      .map((value) => value.trim().toLowerCase()),
  )
  if (names.size === 0) return undefined
  const port = asset.sshPort ?? 22
  const matched = entries.filter((entry) => entry.port === port && names.has(entry.host))
  if (matched.length === 0) return undefined
  return {
    fingerprints: [...new Set(matched.map((entry) => entry.fingerprint))],
    keyTypes: [...new Set(matched.map((entry) => entry.keyType))],
  }
}