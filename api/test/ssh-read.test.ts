import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { AcceptConnection, ExecInfo, RejectConnection, Server as SshServer, ServerChannel } from 'ssh2'
import { AssetStore } from '../src/assets.ts'
import { ToolBroker } from '../src/broker.ts'
import { CredentialStore } from '../src/credentials.ts'
import { McpServerStore } from '../src/mcp-servers.ts'
import { Platform } from '../src/platform.ts'
import { SecretBox } from '../src/secret-box.ts'
import {
  buildLogsArgv,
  normalizeLogLines,
  normalizeLogPattern,
  normalizeReadPath,
  normalizeReadPaths,
  parseReadCommand,
  pathAllowed,
  validateLogPath,
  validateRealPath,
} from '../src/ssh-read.ts'
import { createSshTools, probeHostKey } from '../src/ssh-tools.ts'
import { MemoryStore } from '../src/store.ts'
import type { Tool } from '../src/types.ts'

const { Server } = createRequire(import.meta.url)('ssh2') as { Server: typeof SshServer }
const KEY = Buffer.alloc(32, 6).toString('base64')

test('只读命令白名单允许系统诊断，拒绝任意命令', () => {
  assert.deepEqual(parseReadCommand('uptime'), ['uptime'])
  assert.deepEqual(parseReadCommand('df -h'), ['df', '-h'])
  assert.deepEqual(parseReadCommand('ps -eo pid,ppid,pcpu,pmem,etime,comm --sort=-pcpu'), [
    'ps', '-eo', 'pid,ppid,pcpu,pmem,etime,comm', '--sort=-pcpu',
  ])
  assert.deepEqual(parseReadCommand('systemctl status nginx.service --no-pager'), [
    'systemctl', 'status', 'nginx.service', '--no-pager',
  ])
  assert.deepEqual(parseReadCommand('systemctl is-active nginx'), ['systemctl', 'is-active', 'nginx'])
  assert.deepEqual(parseReadCommand('journalctl -p err -n 100 --no-pager'), [
    'journalctl', '-p', 'err', '-n', '100', '--no-pager',
  ])
  assert.deepEqual(parseReadCommand('journalctl -u sshd -n 50 --no-pager'), ['journalctl', '-u', 'sshd', '-n', '50', '--no-pager'])
  assert.deepEqual(parseReadCommand('cat /proc/loadavg'), ['cat', '/proc/loadavg'])

  for (const command of [
    'rm -rf /',
    'sudo systemctl restart nginx',
    'systemctl restart nginx',
    'systemctl status --help --no-pager',
    'cat /etc/shadow',
    'docker ps',
    'kubectl get pods',
    'curl http://example.com',
    'ps auxw',
    'df -h /etc',
    'journalctl -f',
    'journalctl -p err -n 501 --no-pager',
    'journalctl --vacuum-time=1s',
  ]) {
    assert.throws(() => parseReadCommand(command), /白名单|不允许/, command)
  }
})

test('命令里的 shell 元字符一律拒绝', () => {
  for (const command of [
    'uptime; id',
    'uptime && id',
    'uptime | head',
    'uptime > /tmp/x',
    'uptime `id`',
    'uptime $(id)',
    'df -h\nid',
    "df -h'",
    'df -h*',
    'cat /etc/os-release /etc/passwd',
  ]) {
    assert.throws(() => parseReadCommand(command), /不允许的字符|白名单|过长/, command)
  }
})

test('日志路径只接受绝对路径且不能越界', () => {
  assert.equal(normalizeReadPath('/var/log/nginx/error.log'), '/var/log/nginx/error.log')
  assert.equal(normalizeReadPath('/var/log/nginx/'), '/var/log/nginx')
  assert.deepEqual(normalizeReadPaths(['/b', '/a', '/b']), ['/a', '/b'])
  assert.equal(pathAllowed('/srv/logs/app.log', ['/srv/logs']), true)
  assert.equal(pathAllowed('/srv/logs', ['/srv/logs']), true)
  assert.equal(pathAllowed('/srv/logs-other/app.log', ['/srv/logs']), false)

  for (const value of [
    '/',
    'relative/log',
    '/var/log/../etc/passwd',
    '/var/log/./app.log',
    '/var/log//app.log',
    '/var/log/nginx error.log',
    '/var/log/*.log',
    '/var/log/app.log; id',
  ]) {
    assert.throws(() => normalizeReadPath(value), /绝对路径|不能包含|不能是根目录|shell/, value)
  }

  assert.throws(() => validateLogPath('/etc/passwd', ['/srv/logs']), /允许的只读范围/)
  assert.throws(() => validateLogPath('/srv/logs/app.log', []), /没有配置/)
  assert.equal(validateRealPath('/srv/logs/nginx/access.log', ['/srv/logs']), '/srv/logs/nginx/access.log')
  assert.throws(() => validateRealPath('/etc/passwd', ['/srv/logs']), /允许范围之外/)
  assert.throws(() => validateRealPath('/srv/logs/x\n id', ['/srv/logs']), /不合法/)
})

test('日志行数、grep 和 argv 有边界', () => {
  assert.equal(normalizeLogLines(undefined), 200)
  assert.equal(normalizeLogLines(500), 500)
  assert.throws(() => normalizeLogLines(0), /1 到 500/)
  assert.throws(() => normalizeLogLines(501), /1 到 500/)
  assert.equal(normalizeLogPattern('OutOfMemory'), 'OutOfMemory')
  assert.equal(normalizeLogPattern(''), undefined)
  for (const pattern of ['two words', 'a|b', 'a*', '$(id)', 'a`id`', "it's"]) {
    assert.throws(() => normalizeLogPattern(pattern), /固定字符串/, pattern)
  }
  assert.deepEqual(buildLogsArgv('/srv/logs/app.log', 50), ['tail', '-n', '50', '--', '/srv/logs/app.log'])
  assert.deepEqual(buildLogsArgv('/srv/logs/app.log', 20, 'error'), [
    'grep', '-F', '-m', '20', '--', 'error', '/srv/logs/app.log',
  ])
})

function respond(command: string): { code: number; out: string; err?: string } {
  if (command === 'uptime') return { code: 0, out: ' 10:00:00 up 10 days, 1 user\n' }
  if (command === 'readlink -f -- /srv/logs/app.log') return { code: 0, out: '/srv/logs/app.log\n' }
  if (command === 'stat -L -c %F -- /srv/logs/app.log') return { code: 0, out: 'regular file\n' }
  if (command === 'tail -n 5 -- /srv/logs/app.log') return { code: 0, out: 'line-1\nline-2\n' }
  if (command === 'grep -F -m 2 -- error /srv/logs/app.log') return { code: 0, out: 'error one\nerror two\n' }
  if (command === 'readlink -f -- /srv/logs/escape.log') return { code: 0, out: '/etc/passwd\n' }
  if (command === 'readlink -f -- /srv/logs/dir') return { code: 0, out: '/srv/logs/dir\n' }
  if (command === 'stat -L -c %F -- /srv/logs/dir') return { code: 0, out: 'directory\n' }
  return { code: 127, out: '', err: `unexpected command: ${command}` }
}

async function startServer(commands: string[]): Promise<{ port: number; close: () => Promise<void> }> {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  })
  const server = new Server({ hostKeys: [String(privateKey)] }, (client) => {
    client.on('error', () => undefined)
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === 'tester') ctx.accept()
      else ctx.reject()
    })
    client.on('session', (accept: AcceptConnection) => {
      const session = accept()
      session.on('exec', (acceptExec: AcceptConnection<ServerChannel>, _reject: RejectConnection, info: ExecInfo) => {
        commands.push(info.command)
        const stream = acceptExec() as ServerChannel
        const { code, out, err } = respond(info.command)
        if (err) stream.stderr.write(err)
        stream.exit(code)
        stream.end(out)
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function setup(): Promise<{
  tools: Tool[]
  assets: AssetStore
  credentials: CredentialStore
  port: number
  commands: string[]
  close: () => Promise<void>
  cleanup: () => Promise<void>
}> {
  const dir = await mkdtemp(path.join(tmpdir(), 'aiops-ssh-read-'))
  const commands: string[] = []
  const server = await startServer(commands)
  const assets = new AssetStore(path.join(dir, 'assets.json'), [], SecretBox.fromKey(KEY))
  const credentials = new CredentialStore(null)
  let asset = await assets.upsert({
    name: 'host01',
    host: '127.0.0.1',
    sshPort: server.port,
    sshUser: 'tester',
    sshPassword: 'password',
    sshReadPaths: ['/srv/logs'],
  })
  const probe = await probeHostKey(asset, 5_000)
  await assets.trustHostKey('host01', probe.fingerprint)
  asset = (await assets.get('host01'))!
  assert.ok(asset.sshHostKeyFingerprint)
  return {
    tools: createSshTools(assets, credentials),
    assets,
    credentials,
    port: server.port,
    commands,
    close: server.close,
    cleanup: async () => {
      await server.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

test('ssh.read 走只读通道，不产生审批；非法命令在连接前被拒绝', async () => {
  const ctx = await setup()
  try {
    const tool = ctx.tools.find((item) => item.name === 'ssh.read')!
    assert.equal(tool.risk, 'read')
    const broker = new ToolBroker(ctx.tools, new MemoryStore(), [
      { id: 'alice', name: 'Alice', roles: ['operator'] },
    ])
    const outcome = await broker.execute({
      actorId: 'alice',
      ownerId: 'alice',
      taskId: 'task-ssh-read',
      tool: 'ssh.read',
      args: { asset: 'host01', command: 'uptime' },
    })
    assert.equal(outcome.status, 'ok')
    if (outcome.status === 'ok') {
      assert.match(String((outcome.result as { stdout?: unknown }).stdout), /up 10 days/)
    }

    const before = ctx.commands.length
    const denied = await broker.execute({
      actorId: 'alice',
      ownerId: 'alice',
      taskId: 'task-ssh-read',
      tool: 'ssh.read',
      args: { asset: 'host01', command: 'uptime; id' },
    })
    assert.equal(denied.status, 'error')
    assert.equal(ctx.commands.length, before, '非法命令不应建立 SSH 执行')
  } finally {
    await ctx.cleanup()
  }
})

test('ssh.logs 读取已授权文件，支持 grep，拒绝软链逃逸和非普通文件', async () => {
  const ctx = await setup()
  try {
    const tool = ctx.tools.find((item) => item.name === 'ssh.logs')!
    assert.equal(tool.risk, 'read')

    const tailed = (await tool.execute({ asset: 'host01', path: '/srv/logs/app.log', lines: 5 }, { actorId: 'alice' })) as {
      stdout: string
      path: string
      command: string
    }
    assert.equal(tailed.stdout, 'line-1\nline-2\n')
    assert.equal(tailed.path, '/srv/logs/app.log')
    assert.equal(tailed.command, 'tail -n 5 -- /srv/logs/app.log')

    const grepped = (await tool.execute({ asset: 'host01', path: '/srv/logs/app.log', lines: 2, grep: 'error' }, { actorId: 'alice' })) as {
      stdout: string
      command: string
    }
    assert.equal(grepped.stdout, 'error one\nerror two\n')
    assert.equal(grepped.command, 'grep -F -m 2 -- error /srv/logs/app.log')

    await assert.rejects(
      () => Promise.resolve(tool.validate!({ asset: 'host01', path: '/etc/passwd' })),
      /允许的只读范围/,
    )
    const before = ctx.commands.length
    await assert.rejects(
      () => tool.execute({ asset: 'host01', path: '/srv/logs/escape.log' }, { actorId: 'alice' }),
      /允许范围之外/,
    )
    assert.ok(!ctx.commands.slice(before).some((command) => command.startsWith('tail ')), '软链逃逸不应继续读文件')

    await assert.rejects(
      () => tool.execute({ asset: 'host01', path: '/srv/logs/dir' }, { actorId: 'alice' }),
      /普通文件/,
    )
  } finally {
    await ctx.cleanup()
  }
})
test('资产连接测试真实登录并鉴权，未信任指纹和权限不足时拒绝', async () => {
  const ctx = await setup()
  try {
    const platform = new Platform({
      actors: [
        { id: 'alice', name: 'Alice', roles: ['operator'] },
        { id: 'carol', name: 'Carol', roles: ['viewer'] },
      ],
      skills: [],
      tools: ctx.tools,
      knowledge: {
        async search() {
          return []
        },
        async getDocument() {
          throw new Error('not used')
        },
      },
      mcpStore: new McpServerStore(null, []),
      assets: ctx.assets,
      credentials: ctx.credentials,
    })

    await assert.rejects(() => platform.testAssetSsh('carol', 'host01'), /不能测试资产连接/)
    const result = await platform.testAssetSsh('alice', 'host01')
    assert.equal(result.ok, true)
    assert.equal(result.host, '127.0.0.1')
    assert.equal(result.user, 'tester')
    assert.ok(result.hostKeyFingerprint)
    assert.ok(result.latencyMs >= 0)

    await ctx.assets.upsert({
      name: 'host02',
      host: '127.0.0.1',
      sshPort: 22,
      sshUser: 'tester',
      sshPassword: 'password',
    })
    await assert.rejects(() => platform.testAssetSsh('alice', 'host02'), /尚未信任 SSH 主机密钥/)

    // 认证失败要翻译成中文提示，页面不再显示 ssh2 的英文原文。
    const wrongUser = await ctx.assets.upsert({
      name: 'host03',
      host: '127.0.0.1',
      sshPort: ctx.port,
      sshUser: 'wrong-user',
      sshPassword: 'password',
    })
    const wrongProbe = await probeHostKey(wrongUser)
    await ctx.assets.trustHostKey('host03', wrongProbe.fingerprint)
    await assert.rejects(() => platform.testAssetSsh('alice', 'host03'), /SSH 认证失败/)

    await assert.rejects(() => platform.testAssetSsh('alice', 'missing'), /资产不存在/)
  } finally {
    await ctx.cleanup()
  }
})
