import { createHash } from 'node:crypto'
import { Client, type ClientChannel } from 'ssh2'
import { toAssetView, type AssetRecord, type AssetStore } from './assets.ts'
import type { CredentialStore } from './credentials.ts'
import type { Tool } from './types.ts'

interface Target {
  asset: AssetRecord
  host: string
  port: number
  user: string
  password?: string
  privateKey?: string
  passphrase?: string
}

const MAX_OUTPUT = 200_000

export function createSshTools(assets: AssetStore, credentials: CredentialStore): Tool[] {
  return [
    {
      name: 'ssh.test',
      description: '测试资产登记里的 SSH 连接，不执行远程命令。只读。',
      risk: 'read',
      parameters: {
        type: 'object',
        properties: {
          asset: { type: 'string', description: '资产名称' },
        },
        required: ['asset'],
      },
      async validate(args) {
        await resolveChain(assets, credentials, args.asset)
      },
      async execute(args, ctx) {
        const chain = await resolveChain(assets, credentials, args.asset)
        const target = chain[chain.length - 1]
        const opened = await openChain(chain, 15_000, ctx.signal)
        opened.close()
        const jumps = chain.slice(0, -1).map((hop) => hop.asset.name)
        return {
          ok: true,
          asset: toAssetView(target.asset),
          host: target.host,
          port: target.port,
          user: target.user,
          hostKeyFingerprint: target.asset.sshHostKeyFingerprint,
          ...(jumps.length ? { jumps } : {}),
        }
      },
    },
    {
      name: 'ssh.exec',
      description: '通过 SSH 在资产上执行命令。变更操作，必须先审批；输出最多 200KB。',
      risk: 'mutate',
      parameters: {
        type: 'object',
        properties: {
          asset: { type: 'string', description: '资产名称' },
          command: { type: 'string', description: '要执行的命令' },
          timeoutMs: { type: 'integer', description: '连接和执行超时，1000-60000 毫秒，默认 15000' },
        },
        required: ['asset', 'command'],
      },
      async validate(args) {
        textArg(args, 'command')
        timeoutOf(args.timeoutMs)
        await resolveChain(assets, credentials, args.asset)
      },
      async execute(args, ctx) {
        const chain = await resolveChain(assets, credentials, args.asset)
        const command = textArg(args, 'command')
        const timeout = timeoutOf(args.timeoutMs)
        return execute(chain, command, timeout, ctx.signal)
      },
    },
  ]
}

/** 解析连接链路：跳板机按顺序排在前面，目标资产在最后。 */
async function resolveChain(
  assets: AssetStore,
  credentials: CredentialStore,
  value: unknown,
): Promise<Target[]> {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name) throw new Error('参数 asset 必填')
  const asset = await assets.get(name)
  if (!asset) throw new Error(`没有登记资产 ${name}`)
  const jumps = await resolveJumpTargets(assets, credentials, asset)
  return [...jumps, await targetOf(asset, credentials)]
}

/**
 * 解析目标资产前面的跳板机链路。跳板机本身必须是完整的可连接资产
 * （有用户名、凭证，且主机密钥已信任）。循环在此处再拦一次，防止手工改文件。
 */
export async function resolveJumpTargets(
  assets: AssetStore,
  credentials: CredentialStore,
  asset: AssetRecord,
): Promise<Target[]> {
  const chain: Target[] = []
  const seen = new Set([asset.name])
  let cursor = asset.sshJumpAsset
  while (cursor) {
    if (seen.has(cursor)) throw new Error(`SSH 跳板机链路存在循环：${cursor}`)
    if (chain.length >= 4) throw new Error('SSH 跳板机最多 4 层')
    seen.add(cursor)
    const jump = await assets.get(cursor)
    if (!jump) throw new Error(`跳板机资产 ${cursor} 不存在`)
    chain.unshift(await targetOf(jump, credentials))
    cursor = jump.sshJumpAsset
  }
  return chain
}

async function targetOf(asset: AssetRecord, credentials: CredentialStore): Promise<Target> {
  const name = asset.name
  const host = asset.ip || asset.host
  if (!host) throw new Error(`资产 ${name} 没有 IP 或主机名`)
  if (!asset.sshUser) throw new Error(`资产 ${name} 没有配置 SSH 用户名`)
  if (!asset.sshHostKeyFingerprint) {
    throw new Error(`资产 ${name} 尚未信任 SSH 主机密钥，请先在资产页校验并信任主机指纹`)
  }

  let password = asset.sshPassword
  let privateKey = asset.sshKey
  let passphrase = asset.sshPassphrase
  if (asset.sshCredentialId) {
    const credential = await credentials.get(asset.sshCredentialId)
    if (!credential) throw new Error(`资产 ${name} 引用的 SSH 凭证不存在`)
    if (credential.type === 'password') {
      if (!credential.password) throw new Error(`SSH 凭证 ${credential.name} 没有密码`)
      password = credential.password
      privateKey = undefined
      passphrase = undefined
    } else {
      if (!credential.privateKey) throw new Error(`SSH 凭证 ${credential.name} 没有私钥`)
      privateKey = credential.privateKey
      passphrase = credential.passphrase
      password = undefined
    }
  }
  if (!password && !privateKey) throw new Error(`资产 ${name} 没有配置 SSH 凭证`)
  return { asset, host, port: asset.sshPort ?? 22, user: asset.sshUser, password, privateKey, passphrase }
}

/** OpenSSH 风格的 SHA256 指纹，base64 去掉填充。 */
export function hostKeyFingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
}

/**
 * 探测主机密钥：在认证前拿到服务端 key 就主动断开，不发送任何密码或私钥。
 * 用于资产页「校验主机密钥」和信任前的二次核对。
 */
export function probeHostKey(
  asset: AssetRecord,
  timeoutMs = 15_000,
  signal?: AbortSignal,
  jumps: Target[] = [],
): Promise<{ fingerprint: string; trusted: boolean }> {
  const host = asset.ip || asset.host
  if (!host) return Promise.reject(new Error(`资产 ${asset.name} 没有 IP 或主机名`))
  const port = asset.sshPort ?? 22
  return probeWithJump(asset, host, port, jumps, timeoutMs, signal)
}

async function probeWithJump(
  asset: AssetRecord,
  host: string,
  port: number,
  jumps: Target[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ fingerprint: string; trusted: boolean }> {
  let opened: OpenedChain | undefined
  try {
    let sock: ClientChannel | undefined
    if (jumps.length) {
      opened = await openChain(jumps, timeoutMs, signal)
      sock = await forwardOut(opened.conn, host, port, timeoutMs, signal)
    }
    return await probeOverSocket(asset, host, port, sock, timeoutMs, signal)
  } finally {
    // 探测只拿指纹，跳板机连接用完立即关闭。
    opened?.close()
  }
}

function probeOverSocket(
  asset: AssetRecord,
  host: string,
  port: number,
  sock: ClientChannel | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ fingerprint: string; trusted: boolean }> {
  return new Promise((resolve, reject) => {
    const conn = new Client()
    let fingerprint: string | undefined
    let settled = false
    const finish = (error?: Error, value?: { fingerprint: string; trusted: boolean }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      conn.end()
      sock?.destroy()
      if (error) reject(error)
      else resolve(value!)
    }
    const timer = setTimeout(() => finish(new Error('SSH 主机密钥探测超时')), timeoutMs)
    const onAbort = () => finish(new Error('SSH 主机密钥探测已取消'))
    conn.on('error', (error) => {
      if (fingerprint) {
        finish(undefined, { fingerprint, trusted: fingerprint === asset.sshHostKeyFingerprint })
      } else {
        finish(new Error(`SSH 主机密钥探测失败: ${error.message}`))
      }
    })
    conn.on('ready', () => finish(new Error('SSH 主机密钥探测异常：主机未拒绝探测连接')))
    if (signal?.aborted) {
      finish(new Error('SSH 主机密钥探测已取消'))
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    conn.connect({
      host,
      port,
      ...(sock ? { sock } : {}),
      username: asset.sshUser || 'probe',
      password: 'probe',
      readyTimeout: timeoutMs,
      hostVerifier: (key: Buffer) => {
        fingerprint = hostKeyFingerprint(key)
        return false
      },
    })
  })
}

interface OpenedChain {
  /** 链路最后一段（目标或最后一跳）的连接。 */
  conn: Client
  close: () => void
}

/** 依次建立跳板机连接，返回最后一段连接和整条链的关闭方法。 */
async function openChain(
  chain: Target[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<OpenedChain> {
  const opened: Array<{ conn: Client; forward?: ClientChannel }> = []
  const close = () => {
    for (let index = opened.length - 1; index >= 0; index -= 1) {
      opened[index].forward?.destroy()
      opened[index].conn.end()
    }
  }
  try {
    let sock: ClientChannel | undefined
    for (let index = 0; index < chain.length; index += 1) {
      const conn = await connect(chain[index], timeoutMs, signal, sock)
      opened.push({ conn })
      const next = chain[index + 1]
      if (next) {
        sock = await forwardOut(conn, next.host, next.port, timeoutMs, signal)
        opened[opened.length - 1].forward = sock
      }
    }
    return { conn: opened[opened.length - 1].conn, close }
  } catch (error) {
    close()
    throw error
  }
}

function forwardOut(
  conn: Client,
  host: string,
  port: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error, channel?: ClientChannel) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(channel!)
    }
    const timer = setTimeout(() => finish(new Error('SSH 跳板机转发超时')), timeoutMs)
    const onAbort = () => finish(new Error('SSH 跳板机转发已取消'))
    if (signal?.aborted) {
      finish(new Error('SSH 跳板机转发已取消'))
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    conn.forwardOut('127.0.0.1', 0, host, port, (error, channel) => {
      if (error) finish(new Error(`SSH 跳板机转发失败: ${error.message}`))
      else finish(undefined, channel)
    })
  })
}

function connect(
  target: Target,
  timeoutMs: number,
  signal?: AbortSignal,
  sock?: ClientChannel,
): Promise<Client> {
  return new Promise((resolve, reject) => {
    const conn = new Client()
    let settled = false
    let verifyError: Error | undefined
    const trusted = target.asset.sshHostKeyFingerprint
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error) {
        conn.end()
        reject(error)
      } else {
        resolve(conn)
      }
    }
    const timer = setTimeout(() => finish(new Error('SSH 连接超时')), timeoutMs)
    const onAbort = () => finish(new Error('SSH 连接已取消'))
    conn.on('ready', () => finish())
    conn.on('error', (error) => finish(verifyError ?? new Error(`SSH 连接失败: ${error.message}`)))
    if (signal?.aborted) {
      finish(new Error('SSH 连接已取消'))
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    conn.connect({
      host: target.host,
      port: target.port,
      ...(sock ? { sock } : {}),
      username: target.user,
      password: target.password,
      privateKey: target.privateKey,
      passphrase: target.passphrase,
      readyTimeout: timeoutMs,
      hostVerifier: (key: Buffer) => {
        const presented = hostKeyFingerprint(key)
        if (!trusted) {
          verifyError = new Error(`主机密钥未信任：${presented}，已拒绝连接`)
          return false
        }
        if (presented !== trusted) {
          verifyError = new Error(
            `SSH 主机密钥不匹配：已信任 ${trusted}，实际 ${presented}；可能被中间人劫持或主机已重装，已拒绝连接`,
          )
          return false
        }
        return true
      },
    })
  })
}

function execute(
  chain: Target[],
  command: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  return openChain(chain, timeoutMs, signal).then(
    (opened) =>
      new Promise((resolve, reject) => {
        let settled = false
        let stdout = ''
        let stderr = ''
        let total = 0
        const target = chain[chain.length - 1]
        const jumps = chain.slice(0, -1).map((hop) => hop.asset.name)
        const finish = (error?: Error, code = 0) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          opened.close()
          if (error) reject(error)
          else {
            resolve({
              asset: target.asset.name,
              host: target.host,
              port: target.port,
              user: target.user,
              command,
              code,
              stdout,
              stderr,
              ...(jumps.length ? { jumps } : {}),
            })
          }
        }
        const timer = setTimeout(() => finish(new Error('SSH 命令执行超时')), timeoutMs)
        const onAbort = () => finish(new Error('SSH 命令已取消'))
        if (signal?.aborted) {
          finish(new Error('SSH 命令已取消'))
          return
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        opened.conn.exec(command, (error, stream: ClientChannel) => {
          if (error) {
            finish(new Error(`SSH 执行失败: ${error.message}`))
            return
          }
          stream.on('data', (chunk: Buffer) => {
            if (total >= MAX_OUTPUT) return
            const text = chunk.toString('utf8')
            stdout += text.slice(0, MAX_OUTPUT - total)
            total += chunk.length
          })
          stream.stderr.on('data', (chunk: Buffer) => {
            if (total >= MAX_OUTPUT) return
            const text = chunk.toString('utf8')
            stderr += text.slice(0, MAX_OUTPUT - total)
            total += chunk.length
          })
          stream.on('close', (code: number | null) => finish(undefined, code ?? 0))
          stream.on('error', (error: Error) => finish(new Error(`SSH 通道失败: ${error.message}`)))
        })
      }),
  )
}

function textArg(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`参数 ${key} 必填`)
  return value.trim()
}

function timeoutOf(value: unknown): number {
  if (value === undefined) return 15_000
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1_000 || value > 60_000) {
    throw new Error('timeoutMs 必须是 1000 到 60000 的整数')
  }
  return value
}