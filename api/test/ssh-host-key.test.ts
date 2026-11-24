import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { Server as SshServer } from 'ssh2'
import { AssetStore, normalizeFingerprint } from '../src/assets.ts'
import { CredentialStore } from '../src/credentials.ts'
import { SecretBox } from '../src/secret-box.ts'
import { createSshTools, probeHostKey, resolveJumpTargets } from '../src/ssh-tools.ts'

const { Server } = createRequire(import.meta.url)('ssh2') as { Server: typeof SshServer }
const KEY = Buffer.alloc(32, 5).toString('base64')

function randomFingerprint(): string {
  return `SHA256:${randomBytes(32).toString('base64').replace(/=+$/, '')}`
}

async function startServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  })
  const hostKey = String(privateKey)
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    // 探测连接会在认证前主动断开，服务端 KEX 失败属于预期，避免冒泡成未捕获异常。
    client.on('error', () => undefined)
    // 跳板机测试：把 direct-tcpip 转发到本地目标端口。
    client.on('tcpip', (accept, reject, info) => {
      const socket = net.connect(info.destPort, info.destIP)
      socket.on('error', () => {
        socket.destroy()
        reject()
      })
      socket.on('connect', () => {
        const stream = accept()
        stream.pipe(socket).pipe(stream)
      })
    })
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === 'tester') ctx.accept()
      else ctx.reject()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), 'aiops-ssh-'))
  const assets = new AssetStore(path.join(dir, 'assets.json'), [], SecretBox.fromKey(KEY))
  const credentials = new CredentialStore(null)
  const server = await startServer()
  const asset = await assets.upsert({
    name: 'host01',
    host: '127.0.0.1',
    sshPort: server.port,
    sshUser: 'tester',
    sshPassword: 'password',
  })
  const tools = createSshTools(assets, credentials)
  const sshTest = tools.find((tool) => tool.name === 'ssh.test')!
  return {
    assets,
    asset,
    sshTest,
    server,
    cleanup: async () => {
      await server.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

test('未信任主机密钥时 SSH 工具在参数校验阶段就拒绝', async () => {
  const ctx = await setup()
  try {
    await assert.rejects(() => Promise.resolve(ctx.sshTest.validate!({ asset: 'host01' })), /尚未信任 SSH 主机密钥/)
  } finally {
    await ctx.cleanup()
  }
})

test('探测返回 SHA256 指纹，指纹不匹配时拒绝连接', async () => {
  const ctx = await setup()
  try {
    const probed = await probeHostKey(ctx.asset)
    assert.match(probed.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/)
    assert.equal(probed.trusted, false)

    await ctx.assets.trustHostKey('host01', randomFingerprint())
    await assert.rejects(
      () => ctx.sshTest.execute({ asset: 'host01' }, { actorId: 'alice' }),
      /SSH 主机密钥不匹配/,
    )
  } finally {
    await ctx.cleanup()
  }
})

test('信任正确指纹后 SSH 连接成功；主机或端口变化会清除信任', async () => {
  const ctx = await setup()
  try {
    const probed = await probeHostKey(ctx.asset)
    await ctx.assets.trustHostKey('host01', probed.fingerprint)
    const result = (await ctx.sshTest.execute({ asset: 'host01' }, { actorId: 'alice' })) as Record<string, unknown>
    assert.equal(result.ok, true)
    assert.equal(result.hostKeyFingerprint, probed.fingerprint)

    const changed = await ctx.assets.upsert({ ...ctx.asset, sshPort: ctx.asset.sshPort! + 1 })
    assert.equal(changed.sshHostKeyFingerprint, undefined)
    await assert.rejects(() => Promise.resolve(ctx.sshTest.validate!({ asset: 'host01' })), /尚未信任/)
  } finally {
    await ctx.cleanup()
  }
})

test('替换已信任指纹必须带当前指纹；指纹格式必须规范', async () => {
  const ctx = await setup()
  try {
    const first = randomFingerprint()
    const second = randomFingerprint()
    await ctx.assets.trustHostKey('host01', first)
    await assert.rejects(() => ctx.assets.trustHostKey('host01', second), /请刷新资产/)
    const updated = await ctx.assets.trustHostKey('host01', second, first)
    assert.equal(updated.sshHostKeyFingerprint, second)
    assert.throws(() => normalizeFingerprint('SHA256:abc'), /43 个字符/)
    assert.throws(() => normalizeFingerprint(`${first}=`), /填充/)
  } finally {
    await ctx.cleanup()
  }
})
test('经跳板机连接目标：跳板和目标都必须信任主机密钥', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'aiops-ssh-jump-'))
  const assets = new AssetStore(path.join(dir, 'assets.json'), [], SecretBox.fromKey(KEY))
  const credentials = new CredentialStore(null)
  const jumpServer = await startServer()
  const targetServer = await startServer()
  try {
    const jump = await assets.upsert({
      name: 'jump01',
      host: '127.0.0.1',
      sshPort: jumpServer.port,
      sshUser: 'tester',
      sshPassword: 'password',
    })
    const target = await assets.upsert({
      name: 'target01',
      host: '127.0.0.1',
      sshPort: targetServer.port,
      sshUser: 'tester',
      sshPassword: 'password',
      sshJumpAsset: 'jump01',
    })
    // 跳板机未信任时，探测目标直接拒绝。
    await assert.rejects(
      () => resolveJumpTargets(assets, credentials, target),
      /资产 jump01 尚未信任 SSH 主机密钥/,
    )
    const jumpProbe = await probeHostKey(jump)
    await assets.trustHostKey('jump01', jumpProbe.fingerprint)

    const targetProbe = await probeHostKey(
      target,
      15_000,
      undefined,
      await resolveJumpTargets(assets, credentials, target),
    )
    assert.equal(targetProbe.trusted, false)
    assert.notEqual(targetProbe.fingerprint, jumpProbe.fingerprint)
    await assets.trustHostKey('target01', targetProbe.fingerprint)

    const tools = createSshTools(assets, credentials)
    const sshTest = tools.find((tool) => tool.name === 'ssh.test')!
    const result = (await sshTest.execute({ asset: 'target01' }, { actorId: 'alice' })) as Record<string, unknown>
    assert.equal(result.ok, true)
    assert.deepEqual(result.jumps, ['jump01'])
    assert.equal(result.hostKeyFingerprint, targetProbe.fingerprint)
  } finally {
    await jumpServer.close()
    await targetServer.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('跳板机链路不能成环，也不能删除仍被引用的跳板机', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'aiops-ssh-cycle-'))
  const assets = new AssetStore(path.join(dir, 'assets.json'), [])
  try {
    await assets.upsert({ name: 'a', host: '10.0.0.1', sshUser: 'root', sshPassword: 'x', sshHostKeyFingerprint: randomFingerprint() })
    await assets.upsert({ name: 'b', host: '10.0.0.2', sshUser: 'root', sshPassword: 'x', sshHostKeyFingerprint: randomFingerprint(), sshJumpAsset: 'a' })
    await assert.rejects(
      () => assets.upsert({ name: 'a', host: '10.0.0.1', sshUser: 'root', sshPassword: 'x', sshHostKeyFingerprint: randomFingerprint(), sshJumpAsset: 'b' }),
      /循环/,
    )
    await assert.rejects(
      () => assets.upsert({ name: 'c', host: '10.0.0.3', sshUser: 'root', sshPassword: 'x', sshJumpAsset: 'missing' }),
      /跳板机资产 missing 不存在/,
    )
    await assert.rejects(() => assets.remove('a'), /正被其他资产用作跳板机/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
