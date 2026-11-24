import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { test } from 'node:test'
import { createUpstreamMcpTools } from '../../extensions/ops-tools/src/index.ts'

interface SeenCall {
  method?: string
  session?: string
  version?: string
  authorization?: string
  apiKey?: string
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('没有端口')
      resolve(address.port)
    })
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections()
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

async function mockMcp(options: {
  jsonInit?: boolean
  isError?: boolean
  requireAuth?: string
  /** 写入响应后故意不 end，模拟 rmcp 报错/返回后不关 SSE 的情况。 */
  hangAfter?: 'result' | 'error'
  /** 直接用非 2xx 状态码加不关的 SSE 错误体返回。 */
  hangStatus?: number
} = {}) {
  const seen: SeenCall[] = []
  const server = createServer((req, res) => {
    if (options.requireAuth && req.headers.authorization !== options.requireAuth) {
      res.statusCode = 401
      res.end('unauthorized')
      return
    }
    if (req.method === 'DELETE') {
      seen.push({ method: 'DELETE', session: req.headers['mcp-session-id'] as string | undefined })
      res.statusCode = 204
      res.end()
      return
    }
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const message = JSON.parse(raw || '{}') as {
        id?: number
        method?: string
        params?: { arguments?: Record<string, unknown> }
      }
      seen.push({
        method: message.method,
        session: req.headers['mcp-session-id'] as string | undefined,
        version: req.headers['mcp-protocol-version'] as string | undefined,
        authorization: req.headers.authorization,
        apiKey: req.headers['x-api-key'] as string | undefined,
      })
      if (message.method === 'initialize') {
        res.setHeader('mcp-session-id', 'sess-1')
        const payload = {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'mock', version: '1.0.0' },
          },
        }
        if (options.jsonInit) {
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify(payload))
        } else {
          res.setHeader('content-type', 'text/event-stream')
          res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`)
        }
        return
      }
      if (message.method === 'notifications/initialized') {
        res.statusCode = 202
        res.end()
        return
      }
      if (message.method === 'tools/list') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            tools: [{
              name: 'echo',
              description: '回显文本',
              inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
            }],
          },
        }))
        return
      }
      if (message.method === 'tools/call') {
        const text = String(message.params?.arguments?.text ?? '')
        if (options.hangStatus) {
          res.statusCode = options.hangStatus
          res.setHeader('content-type', 'text/event-stream')
          res.write(`data: ${JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32000, message: 'unknown field [host.ip]' },
          })}\n\n`)
          return
        }
        if (options.hangAfter) {
          res.setHeader('content-type', 'text/event-stream')
          // 真正的响应前面先插一条通知，确认客户端会跳过非响应消息。
          res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } })}\n\n`)
          const payload = options.hangAfter === 'error'
            ? { jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'fielddata is disabled on text fields by default' } }
            : { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify({ echo: text }) }] } }
          res.write(`data: ${JSON.stringify(payload)}\n\n`)
          // 故意不 end：旧实现会一直等满 timeoutMs。
          return
        }
        const payload = options.isError
          ? { jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: 'boom' }] } }
          : { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify({ echo: text }) }] } }
        res.setHeader('content-type', 'text/event-stream')
        res.end(`data: ${JSON.stringify(payload)}\n\n`)
        return
      }
      res.statusCode = 404
      res.end('{}')
    })
  })
  const port = await listen(server)
  return { url: `http://127.0.0.1:${port}/mcp`, seen, close: () => close(server) }
}

test('平台能通过 HTTP MCP 注册工具，并保留会话和风险标注', async () => {
  const mock = await mockMcp()
  try {
    const upstream = await createUpstreamMcpTools({
      servers: [{ name: 'probe', system: 'elasticsearch', url: mock.url, readOnly: true }],
    })
    assert.equal(upstream.tools.length, 1)
    assert.equal(upstream.tools[0]?.name, 'mcp.probe.echo')
    assert.equal(upstream.tools[0]?.risk, 'read')
    const result = await upstream.tools[0]!.execute({ text: 'hi' }, { actorId: 'alice' })
    assert.deepEqual(result, { echo: 'hi' })
    assert.equal(mock.seen.some((call) => call.method === 'initialize'), true)
    assert.equal(mock.seen.some((call) => call.method === 'notifications/initialized'), true)
    assert.ok(mock.seen.filter((call) => call.method === 'tools/list').every((call) => call.session === 'sess-1'))
    assert.ok(mock.seen.filter((call) => call.method === 'tools/call').every((call) => call.session === 'sess-1'))
    assert.ok(mock.seen.filter((call) => call.method === 'tools/list').every((call) => call.version === '2024-11-05'))
  } finally {
    await mock.close()
  }
})

test('上游 MCP 支持 Bearer/Basic/自定义 header，也支持 ${ENV} 占位符', async () => {
  process.env.AIOPS_TEST_MCP_TOKEN = 'secret-token'
  const mock = await mockMcp({ requireAuth: 'Bearer secret-token' })
  try {
    const upstream = await createUpstreamMcpTools({
      servers: [{
        name: 'probe',
        system: 'prometheus',
        url: mock.url,
        readOnly: true,
        headers: {
          Authorization: 'Bearer ${AIOPS_TEST_MCP_TOKEN}',
          'X-Api-Key': 'plain-key',
        },
      }],
    })
    assert.equal(upstream.tools.length, 1)
    await upstream.tools[0]!.execute({ text: 'hi' }, { actorId: 'alice' })
    assert.ok(mock.seen.every((call) => call.authorization === 'Bearer secret-token'))
    assert.ok(mock.seen.every((call) => call.apiKey === 'plain-key'))
  } finally {
    delete process.env.AIOPS_TEST_MCP_TOKEN
    await mock.close()
  }
})

test('无认证的 MCP 保持匿名调用', async () => {
  const mock = await mockMcp()
  try {
    const upstream = await createUpstreamMcpTools({
      servers: [{ name: 'probe', system: 'prometheus', url: mock.url, readOnly: true }],
    })
    assert.equal(upstream.tools.length, 1)
    assert.ok(mock.seen.every((call) => call.authorization === undefined))
  } finally {
    await mock.close()
  }
})

test('${ENV} 缺失时初始化报错，不泄露其他 header', async () => {
  delete process.env.AIOPS_MISSING_TOKEN
  const mock = await mockMcp()
  try {
    await assert.rejects(
      () => createUpstreamMcpTools({
        servers: [{
          name: 'probe',
          system: 'prometheus',
          url: mock.url,
          readOnly: true,
          headers: { Authorization: 'Bearer ${AIOPS_MISSING_TOKEN}', 'X-Api-Key': 'plain-key' },
        }],
      }),
      /AIOPS_MISSING_TOKEN/,
    )
  } finally {
    await mock.close()
  }
})

test('MCP 只读服务器里的指定工具仍按变更处理', async () => {
  const mock = await mockMcp({ jsonInit: true })
  try {
    const upstream = await createUpstreamMcpTools({
      servers: [{ name: 'probe', system: 'kubernetes', url: mock.url, readOnly: true, mutateTools: ['echo'] }],
    })
    assert.equal(upstream.tools[0]?.risk, 'mutate')
  } finally {
    await mock.close()
  }
})

test('MCP 上游工具可以按名字排除', async () => {
  const mock = await mockMcp()
  try {
    const upstream = await createUpstreamMcpTools({
      servers: [{
        name: 'probe',
        system: 'kubernetes',
        url: mock.url,
        readOnly: true,
        excludeTools: ['echo'],
      }],
    })
    assert.equal(upstream.tools.length, 0)
  } finally {
    await mock.close()
  }
})

test('关闭工具集时会删除上游会话', async () => {
  const mock = await mockMcp()
  try {
    const upstream = await createUpstreamMcpTools({
      servers: [{ name: 'probe', system: 'prometheus', url: mock.url, readOnly: true }],
    })
    await upstream.close()
    const deleted = mock.seen.find((call) => call.method === 'DELETE')
    assert.ok(deleted, '应该发送 DELETE')
    assert.equal(deleted.session, 'sess-1')
  } finally {
    await mock.close()
  }
})

test('MCP 工具错误会变成平台侧错误', async () => {
  const mock = await mockMcp({ isError: true })
  try {
    const upstream = await createUpstreamMcpTools({
      servers: [{ name: 'probe', system: 'prometheus', url: mock.url, readOnly: true }],
    })
    await assert.rejects(() => upstream.tools[0]!.execute({ text: 'x' }, { actorId: 'alice' }), /boom/)
  } finally {
    await mock.close()
  }
})

test('上游 SSE 返回结果后不关流，调用立即返回', async () => {
  const mock = await mockMcp({ hangAfter: 'result' })
  try {
    const upstream = await createUpstreamMcpTools({
      servers: [{ name: 'probe', system: 'elasticsearch', url: mock.url, readOnly: true, timeoutMs: 10_000 }],
    })
    const started = Date.now()
    const result = await upstream.tools[0]!.execute({ text: 'hi' }, { actorId: 'alice' })
    assert.deepEqual(result, { echo: 'hi' })
    assert.ok(Date.now() - started < 2_000, '应该在 2 秒内返回，而不是等满 timeoutMs')
  } finally {
    await mock.close()
  }
})

test('上游 SSE 报错后不关流，错误原因立即抛出', async () => {
  const mock = await mockMcp({ hangAfter: 'error' })
  try {
    const upstream = await createUpstreamMcpTools({
      servers: [{ name: 'probe', system: 'elasticsearch', url: mock.url, readOnly: true, timeoutMs: 10_000 }],
    })
    const started = Date.now()
    await assert.rejects(
      () => upstream.tools[0]!.execute({ text: 'x' }, { actorId: 'alice' }),
      /fielddata is disabled/,
    )
    assert.ok(Date.now() - started < 2_000, '错误应该在 2 秒内返回')
  } finally {
    await mock.close()
  }
})

test('上游用非 2xx 加不关的 SSE 返回错误时，保留状态码和原因', async () => {
  const mock = await mockMcp({ hangStatus: 400 })
  try {
    const upstream = await createUpstreamMcpTools({
      servers: [{ name: 'probe', system: 'elasticsearch', url: mock.url, readOnly: true, timeoutMs: 10_000 }],
    })
    const started = Date.now()
    await assert.rejects(
      () => upstream.tools[0]!.execute({ text: 'x' }, { actorId: 'alice' }),
      /失败 400: unknown field \[host\.ip\]/,
    )
    assert.ok(Date.now() - started < 2_000, '错误应该在 2 秒内返回')
  } finally {
    await mock.close()
  }
})