import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/** 落盘密文格式：enc:v1:<iv b64>:<tag b64>:<ciphertext b64>。 */
const PREFIX = 'enc:v1:'
const AAD = Buffer.from('aiops-harness/secrets/v1', 'utf8')
const KEY_BYTES = 32

export interface SecretCodec {
  /** 能否真正加密；明文 codec 在测试和只读场景使用。 */
  readonly canEncrypt: boolean
  encrypt(value: string): string
  decrypt(value: string): string
}

export const plaintextCodec: SecretCodec = {
  canEncrypt: false,
  encrypt: (value) => value,
  decrypt: (value) => value,
}

/**
 * AES-256-GCM 字段加密。密钥优先取 AIOPS_SECRET_KEY（base64 或 64 位 hex），
 * 否则读取/生成 0600 的 keyFile。密钥丢失时解密会抛错，绝不回退成明文或清空数据。
 */
export class SecretBox implements SecretCodec {
  readonly canEncrypt = true

  private constructor(private readonly key: Buffer) {}

  static fromKey(raw: string): SecretBox {
    return new SecretBox(parseKey(raw))
  }

  /** envKey 为空时从 keyFile 读取；文件不存在则生成一把新密钥。 */
  static async open(options: { envKey?: string; keyFile: string }): Promise<SecretBox> {
    const raw = options.envKey?.trim()
    if (raw) return SecretBox.fromKey(raw)
    const file = path.resolve(options.keyFile)
    let content: string
    try {
      content = await readFile(file, 'utf8')
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error
      content = await createKeyFile(file)
    }
    return SecretBox.fromKey(content.trim())
  }

  encrypt(value: string): string {
    if (!value || value.startsWith(PREFIX)) return value
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    cipher.setAAD(AAD)
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`
  }

  decrypt(value: string): string {
    if (!value || !value.startsWith(PREFIX)) return value
    const [ivText, tagText, cipherText] = value.slice(PREFIX.length).split(':')
    if (!ivText || !tagText || cipherText === undefined) throw new Error('密文格式不合法')
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivText, 'base64'))
      decipher.setAAD(AAD)
      decipher.setAuthTag(Buffer.from(tagText, 'base64'))
      return Buffer.concat([decipher.update(Buffer.from(cipherText, 'base64')), decipher.final()]).toString('utf8')
    } catch {
      throw new Error('密钥解密失败：AIOPS_SECRET_KEY 或 data/secret.key 与落盘数据不匹配')
    }
  }

  isEncrypted(value: string): boolean {
    return value.startsWith(PREFIX)
  }
}

export type SecretFields<T> = readonly (keyof T)[]

/** 返回浅拷贝，指定字段加密；非字符串和空值原样保留。 */
export function encryptFields<T extends Record<string, unknown>>(
  codec: SecretCodec,
  record: T,
  fields: SecretFields<T>,
): T {
  const copy = { ...record }
  for (const field of fields) {
    const value = copy[field]
    if (typeof value === 'string' && value) copy[field] = codec.encrypt(value) as T[keyof T]
  }
  return copy
}

/** 返回浅拷贝，指定字段解密；没有密文前缀的值原样返回。 */
export function decryptFields<T extends Record<string, unknown>>(
  codec: SecretCodec,
  record: T,
  fields: SecretFields<T>,
  label: string,
): T {
  const copy = { ...record }
  for (const field of fields) {
    const value = copy[field]
    if (typeof value !== 'string' || !value) continue
    try {
      copy[field] = codec.decrypt(value) as T[keyof T]
    } catch (error) {
      throw new Error(`${label} ${String(field)} 解密失败：${(error as Error).message}`)
    }
  }
  return copy
}

/** 记录里是否还有未加密的敏感字段；用于加载后一次性迁移旧数据。 */
export function hasPlaintextSecret<T extends Record<string, unknown>>(
  codec: SecretCodec,
  record: T,
  fields: SecretFields<T>,
): boolean {
  if (!codec.canEncrypt) return false
  return fields.some((field) => {
    const value = record[field]
    return typeof value === 'string' && value.length > 0 && !value.startsWith(PREFIX)
  })
}

function parseKey(raw: string): Buffer {
  const text = raw.trim()
  const key = /^[0-9a-fA-F]{64}$/.test(text) ? Buffer.from(text, 'hex') : Buffer.from(text, 'base64')
  if (key.length !== KEY_BYTES) {
    throw new Error('AIOPS_SECRET_KEY 必须是 32 字节的 base64 或 64 位 hex')
  }
  return key
}

async function createKeyFile(file: string): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true })
  const content = randomBytes(KEY_BYTES).toString('base64')
  try {
    await writeFile(file, content, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') throw error
    return await readFile(file, 'utf8')
  }
  await chmod(file, 0o600)
  console.warn(`已生成数据加密密钥 ${file}（0600），请随 data/ 一起备份；丢失后已加密凭证无法恢复。`)
  return content
}