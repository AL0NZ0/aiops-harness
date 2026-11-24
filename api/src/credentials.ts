import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { nid } from './ids.ts'
import {
  decryptFields,
  encryptFields,
  hasPlaintextSecret,
  plaintextCodec,
  type SecretCodec,
} from './secret-box.ts'

export type CredentialType = 'password' | 'key'

export interface CredentialRecord {
  id: string
  name: string
  type: CredentialType
  password?: string
  privateKey?: string
  passphrase?: string
}

export interface CredentialView {
  id: string
  name: string
  type: CredentialType
  hasSecret: boolean
}

export interface CredentialInput {
  id?: string
  name: string
  type: CredentialType
  password?: string
  privateKey?: string
  passphrase?: string
}

const ID = /^[a-z0-9][a-z0-9_-]*$/
const SECRET_FIELDS = ['password', 'privateKey', 'passphrase'] as const

/** 密码/私钥独立存储；资产只保存 credential id。落盘时敏感字段加密。 */
export class CredentialStore {
  private records: CredentialRecord[] | undefined

  constructor(
    private readonly file: string | null,
    private readonly codec: SecretCodec = plaintextCodec,
  ) {}

  async list(): Promise<CredentialRecord[]> {
    await this.load()
    return this.records!.map((item) => ({ ...item }))
  }

  async get(id: string): Promise<CredentialRecord | undefined> {
    await this.load()
    return this.records!.find((item) => item.id === id)
  }

  async upsert(input: CredentialInput): Promise<CredentialRecord> {
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (!name) throw new Error('凭证名称必填')
    if (input.type !== 'password' && input.type !== 'key') throw new Error('凭证类型只能是 password 或 key')
    await this.load()
    const index = input.id ? this.records!.findIndex((item) => item.id === input.id) : -1
    if (input.id && index < 0) throw new Error('凭证不存在')
    if (this.records!.some((item, i) => i !== index && item.name === name)) {
      throw new Error('凭证名称已存在')
    }
    const existing = index >= 0 ? this.records![index] : undefined
    const password = typeof input.password === 'string' ? input.password : ''
    const privateKey = typeof input.privateKey === 'string' ? input.privateKey : ''
    const passphrase = typeof input.passphrase === 'string' ? input.passphrase : ''
    const record: CredentialRecord = {
      id: existing?.id ?? (input.id && ID.test(input.id) ? input.id : nid('cred')),
      name,
      type: input.type,
    }
    if (input.type === 'password') {
      const value = password || (existing?.type === 'password' ? existing.password : '')
      if (!value) throw new Error('密码凭证必须填写密码')
      record.password = value
    } else {
      const value = privateKey || (existing?.type === 'key' ? existing.privateKey : '')
      if (!value) throw new Error('私钥凭证必须填写私钥')
      record.privateKey = value
      const phrase = passphrase || (existing?.type === 'key' ? existing.passphrase : '')
      if (phrase) record.passphrase = phrase
    }
    if (index >= 0) this.records![index] = record
    else this.records!.push(record)
    await this.persist()
    return { ...record }
  }

  async remove(id: string): Promise<boolean> {
    await this.load()
    const before = this.records!.length
    this.records = this.records!.filter((item) => item.id !== id)
    if (this.records.length === before) return false
    await this.persist()
    return true
  }

  private async load(): Promise<void> {
    if (this.records) return
    if (!this.file) {
      this.records = []
      return
    }
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') {
        this.records = []
        return
      }
      throw error
    }
    const parsed: unknown = JSON.parse(raw)
    const list = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { credentials?: unknown })?.credentials) ? (parsed as { credentials: unknown[] }).credentials : []
    this.records = list
      .map((item) => (item && typeof item === 'object' && !Array.isArray(item) ? normalizeRecord(item as CredentialRecord) : undefined))
      .filter((item): item is CredentialRecord => item !== undefined)
      .map((item, index) => decryptFields(this.codec, item as unknown as Record<string, unknown>, SECRET_FIELDS, `凭证[${index}]`) as unknown as CredentialRecord)
    if (this.records.some((item) => hasPlaintextSecret(this.codec, item as unknown as Record<string, unknown>, SECRET_FIELDS))) {
      await this.persist()
    }
  }

  private async persist(): Promise<void> {
    if (!this.file) return
    await mkdir(path.dirname(this.file), { recursive: true })
    const records = (this.records ?? []).map((item) =>
      encryptFields(this.codec, item as unknown as Record<string, unknown>, SECRET_FIELDS),
    )
    const temp = `${this.file}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify({ credentials: records }, null, 2), { mode: 0o600 })
    await rename(temp, this.file)
    await chmod(this.file, 0o600)
  }
}

export function toCredentialView(record: CredentialRecord): CredentialView {
  return {
    id: record.id,
    name: record.name,
    type: record.type,
    hasSecret: Boolean(record.password || record.privateKey),
  }
}

function normalizeRecord(input: CredentialRecord): CredentialRecord | undefined {
  if (!input || typeof input.id !== 'string' || !ID.test(input.id)) return undefined
  if (input.type !== 'password' && input.type !== 'key') return undefined
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name) return undefined
  const record: CredentialRecord = { id: input.id, name, type: input.type }
  if (input.type === 'password') {
    if (typeof input.password === 'string' && input.password) record.password = input.password
  } else {
    if (typeof input.privateKey === 'string' && input.privateKey) record.privateKey = input.privateKey
    if (typeof input.passphrase === 'string' && input.passphrase) record.passphrase = input.passphrase
  }
  return record.password || record.privateKey ? record : undefined
}