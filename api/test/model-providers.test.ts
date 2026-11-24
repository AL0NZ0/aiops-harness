import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { ChatModel } from '../src/model.ts'
import { ModelProviderStore, ModelRegistry } from '../src/model-providers.ts'
import { SecretBox } from '../src/secret-box.ts'

const KEY = Buffer.alloc(32, 11).toString('base64')

async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'aiops-models-'))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => handler(req, res))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('没有端口')
  return {
    base: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  }
}

test('模型 provider：apiKey 加密落盘，列表不回显，默认项唯一', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const file = path.join(dir, 'model-providers.json')
    const box = SecretBox.fromKey(KEY)
    const store = new ModelProviderStore(file, box)
    const first = await store.upsert({
      name: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1/',
      apiKey: 'sk-SECRET',
      models: ['deepseek-chat'],
      defaultModel: 'deepseek-chat',
      isDefault: true,
    })
    assert.equal(first.hasApiKey, true)
    assert.equal('apiKey' in first, false)
    assert.equal(first.baseUrl, 'https://api.deepseek.com/v1')
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    const raw = await readFile(file, 'utf8')
    assert.equal(raw.includes('sk-SECRET'), false)
    assert.match(raw, /enc:v1:/)

    await store.upsert({
      name: 'qwen',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: 'qwen-SECRET',
      models: ['qwen-max'],
      defaultModel: 'qwen-max',
      isDefault: true,
    })
    const providers = await store.list()
    assert.deepEqual(providers.map((item) => item.name), ['deepseek', 'qwen'])
    assert.deepEqual(providers.filter((item) => item.isDefault).map((item) => item.name), ['qwen'])

    const reloaded = new ModelProviderStore(file, box)
    const models = new ModelRegistry(reloaded)
    const resolved = await models.resolve()
    assert.equal(resolved?.provider, 'qwen')
    assert.equal(resolved?.modelName, 'qwen-max')

    // 空 apiKey 表示保持原值；clearApiKey 才删除。
    await store.upsert({ name: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: '', defaultModel: 'deepseek-chat' })
    assert.equal((await store.list()).find((item) => item.name === 'deepseek')?.hasApiKey, true)
    await store.upsert({ name: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', clearApiKey: true, defaultModel: 'deepseek-chat' })
    assert.equal((await store.list()).find((item) => item.name === 'deepseek')?.hasApiKey, false)
  } finally {
    await cleanup()
  }
})

test('模型 provider：apiKeyEnv 与 apiKey 互斥，环境变量缺失时明确报错', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const store = new ModelProviderStore(path.join(dir, 'model-providers.json'), SecretBox.fromKey(KEY))
    await store.upsert({
      name: 'env-model',
      baseUrl: 'https://api.example.com/v1',
      apiKeyEnv: 'AIOPS_TEST_MODEL_KEY',
      models: ['test-model'],
      defaultModel: 'test-model',
      isDefault: true,
    })
    await assert.rejects(
      () => store.upsert({ name: 'bad', baseUrl: 'https://api.example.com/v1', apiKey: 'x', apiKeyEnv: 'Y', defaultModel: 'm' }),
      /只能配置 apiKey 或 apiKeyEnv/,
    )
    await assert.rejects(
      () => store.upsert({ name: 'bad', baseUrl: 'ftp://example.com', defaultModel: 'm' }),
      /必须是 http\(s\)/,
    )
    await assert.rejects(
      () => store.upsert({ name: 'bad', baseUrl: 'https://example.com', defaultModel: 'm', unknown: 1 }),
      /未知字段/,
    )

    delete process.env.AIOPS_TEST_MODEL_KEY
    const registry = new ModelRegistry(store)
    await assert.rejects(() => registry.resolve(), /AIOPS_TEST_MODEL_KEY/)
    process.env.AIOPS_TEST_MODEL_KEY = 'env-secret'
    try {
      const resolved = await registry.resolve()
      assert.equal(resolved?.provider, 'env-model')
      assert.equal(resolved?.modelName, 'test-model')
      // 显式选择不存在的 provider 必须报错，不能静默回退。
      await assert.rejects(() => registry.resolve({ provider: 'missing' }), /不存在/)
    } finally {
      delete process.env.AIOPS_TEST_MODEL_KEY
    }
  } finally {
    await cleanup()
  }
})

test('模型 provider：拉取 /models 和测试连接使用保存的 key', async () => {
  let authorization = ''
  let listStatus = 200
  let listBody: unknown = { data: [{ id: 'model-b' }, { id: 'model-a' }, { id: 'model-a' }] }
  let reply = 'OK'
  const ctx = await listen((req, res) => {
    authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : ''
    if (req.url === '/v1/models') {
      res.writeHead(listStatus, { 'content-type': 'application/json' })
      res.end(typeof listBody === 'string' ? listBody : JSON.stringify(listBody))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }))
  })
  const { dir, cleanup } = await tempDir()
  try {
    const store = new ModelProviderStore(path.join(dir, 'model-providers.json'), SecretBox.fromKey(KEY))
    await store.upsert({
      name: 'local',
      baseUrl: ctx.base,
      apiKey: 'sk-LOCAL',
      models: ['model-a'],
      defaultModel: 'model-a',
    })
    const registry = new ModelRegistry(store)
    assert.deepEqual(await registry.discover('local'), ['model-a', 'model-b'])
    assert.equal(authorization, 'Bearer sk-LOCAL')

    const result = await registry.probe('local', 'model-b')
    assert.equal(result.provider, 'local')
    assert.equal(result.model, 'model-b')
    assert.equal(result.reply, 'OK')
    assert.equal(typeof result.latencyMs, 'number')

    listStatus = 401
    listBody = { error: 'bad key sk-LOCAL' }
    await assert.rejects(
      () => registry.discover('local'),
      (error: Error) => !error.message.includes('sk-LOCAL') && error.message.includes('401'),
    )
  } finally {
    await cleanup()
    await ctx.close()
  }
})

test('模型解析器：没有 provider 时回退旧模型，也没有时返回 undefined', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const store = new ModelProviderStore(path.join(dir, 'model-providers.json'), SecretBox.fromKey(KEY))
    const fallbackModel: ChatModel = { complete: async () => ({ content: 'x', toolCalls: [] }) }
    const withFallback = new ModelRegistry(store, { model: fallbackModel, provider: 'env', modelName: 'fallback' })
    assert.equal((await withFallback.resolve())?.provider, 'env')
    assert.equal(await new ModelRegistry(store).resolve(), undefined)

    await store.upsert({
      name: 'disabled',
      baseUrl: 'https://api.example.com/v1',
      defaultModel: 'm',
      enabled: false,
    })
    // 有配置但全部停用时仍回退旧配置；显式指定停用 provider 则报错。
    assert.equal((await withFallback.resolve())?.provider, 'env')
    await assert.rejects(() => withFallback.resolve({ provider: 'disabled' }), /未启用/)
  } finally {
    await cleanup()
  }
})