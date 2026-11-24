import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encodeFrame, handleMcpMessage, takeFrame, takeStdioMessage } from '../../extensions/mcp/src/protocol.ts'

test('stdio 同时接受换行 JSON 和 Content-Length', () => {
  const lines = Buffer.from([
    '{"jsonrpc":"2.0","id":1,"method":"ping"}',
    '{"jsonrpc":"2.0","id":2,"method":"ping"}',
    '',
  ].join('\n'))
  const first = takeStdioMessage(lines)
  assert.equal(first?.framing, 'line')
  assert.equal((first?.message as { id: number }).id, 1)
  const second = takeStdioMessage(first!.rest)
  assert.equal(second?.framing, 'line')
  assert.equal((second?.message as { id: number }).id, 2)
  assert.equal(takeStdioMessage(second!.rest), undefined)

  const frame = encodeFrame({ jsonrpc: '2.0', id: 3, method: 'ping' })
  const parsed = takeStdioMessage(frame)
  assert.equal(parsed?.framing, 'content-length')
  assert.equal((parsed?.message as { id: number }).id, 3)
})

test('MCP 帧和工具调用', async () => {
  const frame = encodeFrame({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  const parsed = takeFrame(Buffer.concat([frame, Buffer.from('trailing')]))
  assert.equal((parsed?.message as { method: string }).method, 'tools/list')
  assert.equal(parsed?.rest.toString(), 'trailing')

  const listed = await handleMcpMessage(parsed?.message, {
    async listTools() {
      return [{ name: 'k8s.list_pods', description: '列出 Pod', parameters: { type: 'object' } }]
    },
    async callTool() {
      throw new Error('不应该调用')
    },
  })
  const tools = (listed?.result as { tools: Array<{ name: string }> }).tools
  assert.equal(tools[0]?.name, 'k8s.list_pods')

  const called = await handleMcpMessage(
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'k8s.restart_workload', arguments: { name: 'checkout-api' } } },
    {
      async listTools() { return [] },
      async callTool(name, args) {
        assert.equal(name, 'k8s.restart_workload')
        assert.equal(args.name, 'checkout-api')
        return { text: JSON.stringify({ status: 'awaiting_approval', approvalId: 'apr_1' }), isError: false }
      },
    },
  )
  const result = called?.result as { isError: boolean; content: Array<{ text: string }> }
  assert.equal(result.isError, false)
  assert.match(result.content[0]?.text ?? '', /awaiting_approval/)
  assert.equal(await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, {
    async listTools() { return [] },
    async callTool() { return { text: '', isError: false } },
  }), undefined)
})
