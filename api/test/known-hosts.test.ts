import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { AssetStore } from '../src/assets.ts'
import { CredentialStore } from '../src/credentials.ts'
import { matchAsset, parseKnownHosts } from '../src/known-hosts.ts'
import type { KnowledgeProvider } from '../../extensions/knowledge/src/types.ts'
import { McpServerStore } from '../src/mcp-servers.ts'
import { Platform } from '../src/platform.ts'
import { MemoryStore } from '../src/store.ts'
import type { Actor } from '../src/types.ts'

function keyLine(host: string, keyType = 'ssh-ed25519'): { line: string; fingerprint: string } {
  const blob = randomBytes(64)
  return {
    line: `${host} ${keyType} ${blob.toString('base64')}`,
    fingerprint: `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`,
  }
}

function fingerprintOf(base64: string): string {
  return `SHA256:${createHash('sha256').update(Buffer.from(base64, 'base64')).digest('base64').replace(/=+$/, '')}`
}

test('known_hosts 解析主机名、[host]:port 和指纹；跳过哈希、通配符和 @ 条目', () => {
  const plain = randomBytes(64).toString('base64')
  const ported = randomBytes(64).toString('base64')
  const content = [
    `# comment`,
    `web01.example.com ssh-ed25519 ${plain}`,
    `[db01.example.com]:2222 ssh-rsa ${ported}`,
    `web01.example.com,web02.example.com ssh-ed25519 ${plain}`,
    `|1|abc|def ssh-ed25519 ${plain}`,
    `*.example.com ssh-ed25519 ${plain}`,
    `!bad.example.com ssh-ed25519 ${plain}`,
    `@cert-authority *.example.com ssh-ed25519 ${plain}`,
    `broken line`,
  ].join('\n')
  const parsed = parseKnownHosts(content)
  assert.equal(parsed.entries.length, 4)
  assert.deepEqual(
    parsed.entries.map((entry) => [entry.host, entry.port]),
    [['web01.example.com', 22], ['db01.example.com', 2222], ['web01.example.com', 22], ['web02.example.com', 22]],
  )
  assert.equal(parsed.entries[0]?.fingerprint, fingerprintOf(plain))
  assert.equal(parsed.entries[1]?.fingerprint, fingerprintOf(ported))
  assert.equal(parsed.skipped.length, 5)
  assert.match(parsed.skipped.map((item) => item.reason).join(' '), /哈希主机名/)
  assert.match(parsed.skipped.map((item) => item.reason).join(' '), /通配符/)
})

test('按资产主机名/IP 和端口匹配 known_hosts 条目', () => {
  const { line, fingerprint } = keyLine('10.0.0.8')
  const parsed = parseKnownHosts(line)
  assert.deepEqual(matchAsset(parsed.entries, { ip: '10.0.0.8' }), {
    fingerprints: [fingerprint],
    keyTypes: ['ssh-ed25519'],
  })
  assert.equal(matchAsset(parsed.entries, { ip: '10.0.0.8', sshPort: 2222 }), undefined)
})

async function boot() {
  const assets = new AssetStore(null, [])
  const actors: Actor[] = [
    { id: 'root', name: 'Root', roles: ['admin'] },
    { id: 'alice', name: 'Alice', roles: ['operator'] },
  ]
  const platform = new Platform({
    actors,
    skills: [],
    tools: [],
    knowledge: {} as KnowledgeProvider,
    mcpStore: new McpServerStore(null, []),
    assets,
    credentials: new CredentialStore(null),
    store: new MemoryStore(),
  })
  return { assets, platform }
}

test('known_hosts 导入默认只预检；应用时只写未信任资产，不覆盖冲突指纹', async () => {
  const { assets, platform } = await boot()
  const free = keyLine('10.0.1.1')
  const trusted = keyLine('10.0.1.2')
  const conflicting = keyLine('10.0.1.2')
  const ambiguousA = keyLine('10.0.1.3')
  const ambiguousB = keyLine('10.0.1.3')
  await assets.upsert({ name: 'free', ip: '10.0.1.1', sshUser: 'root', sshPassword: 'x' })
  const trustedAsset = await assets.upsert({ name: 'trusted', ip: '10.0.1.2', sshUser: 'root', sshPassword: 'x' })
  await assets.trustHostKey('trusted', trusted.fingerprint)
  await assets.upsert({ name: 'ambiguous', ip: '10.0.1.3', sshUser: 'root', sshPassword: 'x' })
  await assets.upsert({ name: 'nomatch', ip: '10.0.1.4', sshUser: 'root', sshPassword: 'x' })

  const content = [
    free.line,
    trusted.line,
    ambiguousA.line,
    ambiguousB.line,
  ].join('\n')

  const dry = await platform.importKnownHosts('root', content, false)
  assert.deepEqual(dry.pending, ['free'])
  assert.deepEqual(dry.unchanged, ['trusted'])
  assert.deepEqual(dry.ambiguous.map((item) => item.asset), ['ambiguous'])
  assert.deepEqual(dry.unmatched, ['nomatch'])
  assert.deepEqual(dry.conflicts, [])
  assert.equal((await assets.get('free'))?.sshHostKeyFingerprint, undefined)
  // 已信任资产遇到不同的唯一指纹：报告冲突，不覆盖。
  const conflict = await platform.importKnownHosts('root', conflicting.line, false)
  assert.deepEqual(conflict.conflicts, [{ asset: 'trusted', current: trusted.fingerprint, offered: conflicting.fingerprint }])
  assert.deepEqual(conflict.pending, [])

  const applied = await platform.importKnownHosts('root', content, true)
  assert.deepEqual(applied.applied, ['free'])
  assert.equal((await assets.get('free'))?.sshHostKeyFingerprint, free.fingerprint)
  assert.equal((await assets.get('trusted'))?.sshHostKeyFingerprint, trusted.fingerprint)
  assert.equal((await assets.get('ambiguous'))?.sshHostKeyFingerprint, undefined)
  assert.ok(trustedAsset)

  await assert.rejects(() => platform.importKnownHosts('alice', content, false), /只有管理员/)
  await assert.rejects(() => platform.importKnownHosts('root', '  ', false), /content 不能为空/)
})