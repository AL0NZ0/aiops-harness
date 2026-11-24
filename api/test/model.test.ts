import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { test } from 'node:test'
import { OpenAiCompatibleModel } from '../src/model.ts'

async function listen(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void) {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => handler(req, res, Buffer.concat(chunks).toString('utf8')))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('没有端口')
  return {
    base: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  }
}

test('OpenAI 兼容客户端发送工具并解析 tool_calls', async () => {
  let received: { path?: string; auth?: string; body?: Record<string, unknown> } = {}
  const ctx = await listen((req, res, body) => {
    received = {
      path: req.url,
      auth: typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined,
      body: JSON.parse(body) as Record<string, unknown>,
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      choices: [{
        message: {
          content: '',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'demo_list_pods', arguments: '{"namespace":"shop"}' },
          }],
        },
      }],
    }))
  })
  try {
    const model = new OpenAiCompatibleModel({
      baseUrl: ctx.base,
      model: 'test-model',
      apiKey: 'secret-key',
      temperature: 0.1,
      maxTokens: 100,
    })
    const result = await model.complete({
      messages: [{ role: 'user', content: '排查' }],
      tools: [{
        type: 'function',
        function: {
          name: 'demo_list_pods',
          description: '列 Pod',
          parameters: { type: 'object', properties: { namespace: { type: 'string' } } },
        },
      }],
    })
    assert.equal(result.toolCalls.length, 1)
    assert.equal(result.toolCalls[0]?.function.name, 'demo_list_pods')
    assert.equal(result.toolCalls[0]?.function.arguments, '{"namespace":"shop"}')
    assert.equal(received.path, '/v1/chat/completions')
    assert.equal(received.auth, 'Bearer secret-key')
    assert.equal(received.body?.model, 'test-model')
    assert.equal(received.body?.tool_choice, 'auto')
    assert.equal(received.body?.max_tokens, 100)
  } finally {
    await ctx.close()
  }
})

test('OpenAI 兼容客户端把非 2xx 响应转成可读错误', async () => {
  const ctx = await listen((_req, res) => {
    res.writeHead(429, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'rate limited' } }))
  })
  try {
    const model = new OpenAiCompatibleModel({ baseUrl: ctx.base, model: 'test-model', maxRetries: 0 })
    await assert.rejects(
      () => model.complete({ messages: [{ role: 'user', content: 'x' }], tools: [] }),
      /模型接口返回 429/,
    )
  } finally {
    await ctx.close()
  }
})

test('OpenAI 兼容客户端兼容 content parts 数组', async () => {
  const ctx = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      choices: [{ message: { content: [{ type: 'text', text: '结论' }, { type: 'text', text: '如下' }] } }],
    }))
  })
  try {
    const model = new OpenAiCompatibleModel({ baseUrl: ctx.base, model: 'test-model' })
    const result = await model.complete({ messages: [{ role: 'user', content: 'x' }], tools: [] })
    assert.equal(result.content, '结论如下')
    assert.equal(result.toolCalls.length, 0)
  } finally {
    await ctx.close()
  }
})
test('流式响应按增量回调，并汇总 usage', async () => {
  const ctx = await listen((_req, res, body) => {
    const request = JSON.parse(body) as { stream?: boolean }
    assert.equal(request.stream, true)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"结论"}}]}\n\n')
    res.write('data: {"choices":[{"delta":{"content":"如下"}}]}\n\n')
    res.write('data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":5,"total_tokens":17}}\n\n')
    res.end('data: [DONE]\n\n')
  })
  try {
    const deltas: string[] = []
    const model = new OpenAiCompatibleModel({ baseUrl: ctx.base, model: 'test-model' })
    const result = await model.complete({
      messages: [{ role: 'user', content: 'x' }],
      tools: [],
      onDelta: (text) => deltas.push(text),
    })
    assert.equal(result.content, '结论如下')
    assert.deepEqual(deltas, ['结论', '如下'])
    assert.deepEqual(result.usage, { promptTokens: 12, completionTokens: 5, totalTokens: 17 })
  } finally {
    await ctx.close()
  }
})

test('流式响应拼接分片的 tool_calls', async () => {
  const ctx = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"demo_","arguments":"{\\"name\\":"}}]}}]}\n\n')
    res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"list_pods","arguments":"\\"x\\"}"}}]}}]}\n\n')
    res.end('data: [DONE]\n\n')
  })
  try {
    const model = new OpenAiCompatibleModel({ baseUrl: ctx.base, model: 'test-model' })
    const result = await model.complete({ messages: [{ role: 'user', content: 'x' }], tools: [] })
    assert.equal(result.toolCalls.length, 1)
    assert.equal(result.toolCalls[0]?.function.name, 'demo_list_pods')
    assert.equal(result.toolCalls[0]?.function.arguments, '{"name":"x"}')
  } finally {
    await ctx.close()
  }
})

test('provider 不支持流式时自动退回非流式', async () => {
  let calls = 0
  const ctx = await listen((_req, res, body) => {
    calls += 1
    const request = JSON.parse(body) as { stream?: boolean }
    if (request.stream) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'stream not supported' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: '非流式' } }], usage: { prompt_tokens: 1, completion_tokens: 2 } }))
  })
  try {
    const model = new OpenAiCompatibleModel({ baseUrl: ctx.base, model: 'test-model' })
    const result = await model.complete({ messages: [{ role: 'user', content: 'x' }], tools: [] })
    assert.equal(result.content, '非流式')
    assert.equal(calls, 2)
    assert.deepEqual(result.usage, { promptTokens: 1, completionTokens: 2, totalTokens: 3 })
  } finally {
    await ctx.close()
  }
})

test('可重试错误按退避重试，成功前不会重复输出增量', async () => {
  let calls = 0
  const retries: number[] = []
  const ctx = await listen((_req, res) => {
    calls += 1
    if (calls < 3) {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'unavailable' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
  })
  try {
    const model = new OpenAiCompatibleModel({
      baseUrl: ctx.base,
      model: 'test-model',
      stream: false,
      maxRetries: 2,
      retryBackoffMs: 1,
    })
    const result = await model.complete({
      messages: [{ role: 'user', content: 'x' }],
      tools: [],
      onRetry: (info) => retries.push(info.attempt),
    })
    assert.equal(result.content, 'ok')
    assert.equal(calls, 3)
    assert.deepEqual(retries, [1, 2])
  } finally {
    await ctx.close()
  }
})

test('重试次数用尽后抛出错误，非可重试状态直接失败', async () => {
  const ctx = await listen((_req, res) => {
    res.writeHead(429, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'rate limited' } }))
  })
  try {
    const model = new OpenAiCompatibleModel({ baseUrl: ctx.base, model: 'test-model', maxRetries: 1, retryBackoffMs: 1 })
    await assert.rejects(
      () => model.complete({ messages: [{ role: 'user', content: 'x' }], tools: [] }),
      /模型接口返回 429/,
    )
  } finally {
    await ctx.close()
  }
})
