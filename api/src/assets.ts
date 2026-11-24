import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  decryptFields,
  encryptFields,
  hasPlaintextSecret,
  plaintextCodec,
  type SecretCodec,
} from './secret-box.ts'

export interface AssetRecord {
  name: string
  owner?: string
  tier?: string
  host?: string
  ip?: string
  env?: string
  repo?: string
  note?: string
  sshPort?: number
  sshUser?: string
  sshCredentialId?: string
  sshPassword?: string
  sshKey?: string
  sshPassphrase?: string
  /** SHA256:<base64 无填充>；为空表示尚未信任主机密钥，SSH 拒绝连接。 */
  sshHostKeyFingerprint?: string
  /** 跳板机资产名；连接目标前先经这些主机转发。 */
  sshJumpAsset?: string
}

export interface AssetView {
  name: string
  owner?: string
  tier?: string
  host?: string
  ip?: string
  env?: string
  repo?: string
  note?: string
  sshPort?: number
  sshUser?: string
  sshCredentialId?: string
  hasPassword: boolean
  hasKey: boolean
  sshHostKeyFingerprint?: string
  sshJumpAsset?: string
}

const SECRETS = ['sshPassword', 'sshKey', 'sshPassphrase'] as const

const DEMO_ASSETS: AssetRecord[] = [
  {
    name: 'checkout-api',
    owner: 'shop-team',
    tier: 'critical',
    host: 'checkout-api-7d9c',
    env: 'demo',
    repo: 'git.example/shop/checkout',
  },
  {
    name: 'payments-api',
    owner: 'pay-team',
    tier: 'critical',
    host: 'payments-api-5b2a',
    env: 'demo',
    repo: 'git.example/pay/payments',
  },
]

const NAME = /^[a-z0-9][a-z0-9._-]*$/

/**
 * 本地资产/机器信息。CMDB 接不进来时，这就是 CMDB 的替身。
 * file 为 null 时只放在内存里，测试用。
 */
export class AssetStore {
  private records: AssetRecord[] | undefined

  constructor(
    private readonly file: string | null,
    private readonly seed: AssetRecord[] = DEMO_ASSETS,
    private readonly codec: SecretCodec = plaintextCodec,
  ) {}

  async list(): Promise<AssetRecord[]> {
    await this.load()
    return this.records!.map((item) => ({ ...item }))
  }

  async get(name: string): Promise<AssetRecord | undefined> {
    await this.load()
    return this.records!.find((item) => item.name === name)
  }

  async upsert(input: AssetRecord): Promise<AssetRecord> {
    const record = normalize(input)
    await this.load()
    if (record.sshJumpAsset) this.validateJump(record)
    const index = this.records!.findIndex((item) => item.name === record.name)
    const existing = index >= 0 ? this.records![index] : undefined
    if (existing) {
      for (const key of SECRETS) {
        if (!record[key] && existing[key]) record[key] = existing[key]
      }
      const endpointChanged =
        (record.host ?? '') !== (existing.host ?? '') ||
        (record.ip ?? '') !== (existing.ip ?? '') ||
        (record.sshPort ?? 22) !== (existing.sshPort ?? 22)
      // 主机或端口变了，旧指纹不再代表目标，必须重新探测/信任。
      if (endpointChanged) record.sshHostKeyFingerprint = undefined
      else if (!record.sshHostKeyFingerprint && existing.sshHostKeyFingerprint) {
        record.sshHostKeyFingerprint = existing.sshHostKeyFingerprint
      }
    }
    if (record.sshCredentialId) {
      record.sshPassword = undefined
      record.sshKey = undefined
      record.sshPassphrase = undefined
    }
    if (index >= 0) this.records![index] = record
    else this.records!.push(record)
    await this.persist()
    return { ...record }
  }

  async remove(name: string): Promise<boolean> {
    await this.load()
    if (this.records!.some((item) => item.sshJumpAsset === name)) {
      throw new Error('该资产正被其他资产用作跳板机，请先解除引用')
    }
    const before = this.records!.length
    this.records = this.records!.filter((item) => item.name !== name)
    if (this.records.length === before) return false
    await this.persist()
    return true
  }

  /**
   * 信任主机密钥。已有指纹且要替换时，必须带上当前指纹，防止旧页面或并发操作静默覆盖。
   */
  async trustHostKey(name: string, fingerprint: string, previousFingerprint?: string): Promise<AssetRecord> {
    const normalized = normalizeFingerprint(fingerprint)
    await this.load()
    const index = this.records!.findIndex((item) => item.name === name)
    if (index < 0) throw new Error('资产不存在')
    const current = this.records![index].sshHostKeyFingerprint
    if (current && current !== normalized && previousFingerprint !== current) {
      throw new Error('主机密钥已变化，请刷新资产后重新确认')
    }
    const record = { ...this.records![index], sshHostKeyFingerprint: normalized }
    this.records![index] = record
    await this.persist()
    return { ...record }
  }

  /** 跳板机必须存在，最多 4 层，且不能成环。 */
  private validateJump(record: AssetRecord): void {
    const seen = new Set([record.name])
    let cursor = record.sshJumpAsset
    let depth = 0
    while (cursor) {
      if (seen.has(cursor)) throw new Error('SSH 跳板机链路存在循环')
      seen.add(cursor)
      const jump = this.records!.find((item) => item.name === cursor)
      if (!jump) throw new Error(`跳板机资产 ${cursor} 不存在`)
      depth += 1
      if (depth > 4) throw new Error('SSH 跳板机最多 4 层')
      cursor = jump.sshJumpAsset
    }
  }

  private async load(): Promise<void> {
    if (this.records) return
    if (!this.file) {
      this.records = this.seed.map((item) => ({ ...item }))
      return
    }
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error
      this.records = this.seed.map((item) => ({ ...item }))
      return
    }
    const parsed: unknown = JSON.parse(raw)
    const list = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { assets?: unknown })?.assets) ? (parsed as { assets: unknown[] }).assets : []
    this.records = list
      .map((item) => (item && typeof item === 'object' && !Array.isArray(item) ? normalize(item as AssetRecord) : undefined))
      .filter((item): item is AssetRecord => item !== undefined)
      .map((item, index) => decryptFields(this.codec, item as unknown as Record<string, unknown>, SECRETS, `资产[${index}]`) as unknown as AssetRecord)
    if (this.records.some((item) => hasPlaintextSecret(this.codec, item as unknown as Record<string, unknown>, SECRETS))) {
      await this.persist()
    }
  }

  private async persist(): Promise<void> {
    if (!this.file) return
    await mkdir(path.dirname(this.file), { recursive: true })
    const records = (this.records ?? []).map((item) =>
      encryptFields(this.codec, item as unknown as Record<string, unknown>, SECRETS),
    )
    const temp = `${this.file}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify({ assets: records }, null, 2), { mode: 0o600 })
    await rename(temp, this.file)
    await chmod(this.file, 0o600)
  }
}

export function toAssetView(asset: AssetRecord): AssetView {
  const view: AssetView = {
    name: asset.name,
    hasPassword: Boolean(asset.sshPassword),
    hasKey: Boolean(asset.sshKey),
  }
  for (const key of ['owner', 'tier', 'host', 'ip', 'env', 'repo', 'note', 'sshUser', 'sshCredentialId'] as const) {
    if (asset[key]) view[key] = asset[key]!
  }
  if (asset.sshPort) view.sshPort = asset.sshPort
  if (asset.sshHostKeyFingerprint) view.sshHostKeyFingerprint = asset.sshHostKeyFingerprint
  if (asset.sshJumpAsset) view.sshJumpAsset = asset.sshJumpAsset
  return view
}

function normalize(input: AssetRecord): AssetRecord {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!NAME.test(name)) throw new Error('资产名只能包含小写字母、数字、点、下划线和连字符')
  const record: AssetRecord = { name }
  for (const key of ['owner', 'tier', 'host', 'ip', 'env', 'repo', 'note', 'sshUser'] as const) {
    const value = typeof input[key] === 'string' ? input[key]!.trim() : ''
    if (value) record[key] = value
  }
  const port = input.sshPort
  if (port !== undefined) {
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('SSH 端口必须是 1 到 65535 的整数')
    }
    record.sshPort = port
  }
  const credentialId = typeof input.sshCredentialId === 'string' ? input.sshCredentialId.trim() : ''
  if (credentialId) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(credentialId)) throw new Error('sshCredentialId 不合法')
    record.sshCredentialId = credentialId
  }
  for (const key of SECRETS) {
    const value = typeof input[key] === 'string' ? input[key]! : ''
    if (value.trim()) record[key] = value
  }
  if (input.sshHostKeyFingerprint) record.sshHostKeyFingerprint = normalizeFingerprint(input.sshHostKeyFingerprint)
  const jump = typeof input.sshJumpAsset === 'string' ? input.sshJumpAsset.trim() : ''
  if (jump) {
    if (!NAME.test(jump)) throw new Error('sshJumpAsset 不合法')
    if (jump === name) throw new Error('资产不能把自己作为跳板机')
    record.sshJumpAsset = jump
  }
  return record
}

/** 统一成 OpenSSH 的 SHA256:<base64 无填充> 形式。 */
export function normalizeFingerprint(value: string): string {
  const text = value.trim()
  if (!text) throw new Error('主机密钥指纹不能为空')
  let body = text.startsWith('SHA256:') ? text.slice('SHA256:'.length) : text
  if (body.includes('=')) throw new Error('SHA256 指纹不能带 base64 填充')
  const decoded = Buffer.from(body, 'base64')
  if (body.length !== 43 || decoded.length !== 32) throw new Error('主机密钥指纹必须是 SHA256 base64（43 个字符）')
  const canonical = decoded.toString('base64').replace(/=+$/, '')
  if (canonical !== body) throw new Error('主机密钥指纹不是合法的 base64')
  return `SHA256:${canonical}`
}