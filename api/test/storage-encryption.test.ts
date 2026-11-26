import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { AssetStore } from '../src/assets.ts'
import { CredentialStore } from '../src/credentials.ts'
import { McpServerStore } from '../src/mcp-servers.ts'
import { SecretBox } from '../src/secret-box.ts'

const KEY = Buffer.alloc(32, 7).toString('base64')

async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'aiops-secret-'))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test('SecretBox：AES-256-GCM 往返，密文带前缀，错误密钥必须报错', () => {
  const box = SecretBox.fromKey(KEY)
  const cipher = box.encrypt('super-secret')
  assert.match(cipher, /^enc:v1:/)
  assert.notEqual(cipher, 'super-secret')
  assert.equal(box.decrypt(cipher), 'super-secret')
  assert.equal(box.encrypt(cipher), cipher, '重复加密应保持原样')
  assert.equal(box.decrypt('plain-value'), 'plain-value', '明文原样返回，便于旧数据迁移')
  assert.throws(() => SecretBox.fromKey(Buffer.alloc(16).toString('base64')), /32 字节/)
  const other = SecretBox.fromKey(Buffer.alloc(32, 9).toString('base64'))
  assert.throws(() => other.decrypt(cipher), /解密失败/)
})

test('SecretBox：密钥文件自动生成 0600，重复打开复用同一把密钥', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const keyFile = path.join(dir, 'nested', 'secret.key')
    const first = await SecretBox.open({ keyFile })
    const mode = (await stat(keyFile)).mode & 0o777
    assert.equal(mode, 0o600)
    const second = await SecretBox.open({ keyFile })
    const cipher = first.encrypt('value')
    assert.equal(second.decrypt(cipher), 'value')
  } finally {
    await cleanup()
  }
})

test('凭证保存后文件里没有明文，重新加载可解密', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const file = path.join(dir, 'credentials.json')
    const box = SecretBox.fromKey(KEY)
    const store = new CredentialStore(file, box)
    const record = await store.upsert({ name: 'prod-key', type: 'key', privateKey: 'PRIVATE-KEY-BODY', passphrase: 'PASSPHRASE' })

    const raw = await readFile(file, 'utf8')
    assert.equal(raw.includes('PRIVATE-KEY-BODY'), false)
    assert.equal(raw.includes('PASSPHRASE'), false)
    assert.match(raw, /enc:v1:/)

    const reloaded = new CredentialStore(file, box)
    const loaded = await reloaded.get(record.id)
    assert.equal(loaded?.privateKey, 'PRIVATE-KEY-BODY')
    assert.equal(loaded?.passphrase, 'PASSPHRASE')

    const wrongKey = new CredentialStore(file, SecretBox.fromKey(Buffer.alloc(32, 3).toString('base64')))
    await assert.rejects(() => wrongKey.list(), /解密失败/)
  } finally {
    await cleanup()
  }
})

test('旧明文凭证在加载时自动加密迁移', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const file = path.join(dir, 'credentials.json')
    await writeFile(
      file,
      JSON.stringify({ credentials: [{ id: 'cred1', name: 'legacy', type: 'password', password: 'OLD-PLAIN' }] }),
    )
    const store = new CredentialStore(file, SecretBox.fromKey(KEY))
    const [record] = await store.list()
    assert.equal(record.password, 'OLD-PLAIN')
    const raw = await readFile(file, 'utf8')
    assert.equal(raw.includes('OLD-PLAIN'), false)
    assert.match(raw, /enc:v1:/)
  } finally {
    await cleanup()
  }
})

test('资产内联 SSH 密码/私钥保存后加密，重新加载可用', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const file = path.join(dir, 'assets.json')
    const box = SecretBox.fromKey(KEY)
    const store = new AssetStore(file, [], box)
    await store.upsert({ name: 'host01', host: '127.0.0.1', sshUser: 'root', sshPassword: 'INLINE-PASSWORD' })
    const raw = await readFile(file, 'utf8')
    assert.equal(raw.includes('INLINE-PASSWORD'), false)
    assert.match(raw, /enc:v1:/)

    const loaded = await new AssetStore(file, [], box).get('host01')
    assert.equal(loaded?.sshPassword, 'INLINE-PASSWORD')
  } finally {
    await cleanup()
  }
})

test('MCP headers 保存后加密，重新加载可解密', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const file = path.join(dir, 'mcp-servers.json')
    const box = SecretBox.fromKey(KEY)
    const store = new McpServerStore(file, [], box)
    await store.replace([
      { name: 'k8s', system: 'kubernetes', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer HEADER-SECRET' } },
    ])
    const raw = await readFile(file, 'utf8')
    assert.equal(raw.includes('HEADER-SECRET'), false)
    assert.match(raw, /enc:v1:/)

    const [server] = await new McpServerStore(file, [], box).list()
    assert.equal(server.headers?.Authorization, 'Bearer HEADER-SECRET')
  } finally {
    await cleanup()
  }
})


test('加密模式下 JSON 损坏或密钥不匹配时不得清空数据', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const file = path.join(dir, 'mcp-servers.json')
    await writeFile(file, '{not json')
    await assert.rejects(() => new McpServerStore(file, [], SecretBox.fromKey(KEY)).list(), SyntaxError)
    assert.equal(await readFile(file, 'utf8'), '{not json')
  } finally {
    await cleanup()
  }
})
test('资产并发写入串行落盘，临时文件不会互相覆盖', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const file = path.join(dir, 'assets.json')
    const store = new AssetStore(file, [])
    const names = Array.from({ length: 24 }, (_, index) => `host-${index}`)
    await Promise.all(names.map((name) => store.upsert({ name, host: '127.0.0.1' })))
    await Promise.all(names.map((name) => store.trustHostKey(
      name,
      `SHA256:${randomBytes(32).toString('base64').replace(/=+$/, '')}`,
    )))
    const list = await new AssetStore(file, []).list()
    assert.equal(list.length, 24)
    assert.equal(list.filter((item) => item.sshHostKeyFingerprint).length, 24)
  } finally {
    await cleanup()
  }
})
