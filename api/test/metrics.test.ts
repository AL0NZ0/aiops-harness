import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from '../src/http.ts'
import { incCounter, renderMetrics, resetCounters } from '../src/metrics.ts'
import type { Platform } from '../src/platform.ts'
import { MemoryStore } from '../src/store.ts'
import type { Approval, Task } from '../src/types.ts'

function fakePlatform(): Platform {
  return {
    metricsSnapshot: async () => ({
      tasks: { running: 2, failed: 1 },
      approvals: { pending: 3 },
      tools: { read: 5, mutate: 2 },
      mcp: [
        { name: 'k8s', ok: true, failures: 0, reviewRequired: true },
        { name: 'prom', ok: false, failures: 3 },
      ],
    }),
  } as unknown as Platform
}

test('Prometheus 文本包含任务、审批、工具、MCP 和计数器', async () => {
  resetCounters()
  incCounter('aiops_notifications_total', { result: 'sent', type: 'task.failed' }, 2)
  const text = await renderMetrics(fakePlatform(), undefined, Date.now() - 5_000)
  assert.match(text, /aiops_up 1/)
  assert.match(text, /aiops_uptime_seconds [5-9]/)
  assert.match(text, /aiops_tasks\{status="running"\} 2/)
  assert.match(text, /aiops_tasks\{status="succeeded"\} 0/)
  assert.match(text, /aiops_approvals\{status="pending"\} 3/)
  assert.match(text, /aiops_pending_approvals 3/)
  assert.match(text, /aiops_tools\{risk="read"\} 5/)
  assert.match(text, /aiops_tools\{risk="mutate"\} 2/)
  assert.match(text, /aiops_mcp_server_up\{server="k8s"\} 1/)
  assert.match(text, /aiops_mcp_server_up\{server="prom"\} 0/)
  assert.match(text, /aiops_mcp_server_failures\{server="prom"\} 3/)
  assert.match(text, /aiops_mcp_review_required\{server="k8s"\} 1/)
  assert.match(text, /aiops_notifications_total\{result="sent",type="task.failed"\} 2/)
  assert.match(text, /# TYPE aiops_up gauge/)
})

test('存储层按状态聚合任务和审批', async () => {
  const store = new MemoryStore()
  const task = (id: string, status: Task['status']): Task => ({
    id,
    sessionId: `s:${id}`,
    ownerId: 'alice',
    title: id,
    prompt: '',
    skill: 'monitoring-analysis',
    status,
    createdAt: '2026-11-20T00:00:00.000Z',
    updatedAt: '2026-11-20T00:00:00.000Z',
  })
  await store.saveTask(task('t1', 'running'))
  await store.saveTask(task('t2', 'running'))
  await store.saveTask(task('t3', 'failed'))
  const approval = (id: string, status: Approval['status']): Approval => ({
    id,
    taskId: 't1',
    ownerId: 'alice',
    tool: 'k8s.delete_pod',
    args: {},
    argsHash: 'hash',
    status,
    requestedBy: 'alice',
    requestedAt: '2026-11-20T00:00:00.000Z',
    consumed: false,
  })
  await store.saveApproval(approval('a1', 'pending'))
  await store.saveApproval(approval('a2', 'approved'))
  assert.deepEqual(await store.countTasksByStatus(), { running: 2, failed: 1 })
  assert.deepEqual(await store.countApprovalsByStatus(), { pending: 1, approved: 1 })
})

test('/metrics 可匿名抓取，设置 AIOPS_METRICS_TOKEN 后要求 Bearer token', async () => {
  const previous = process.env.AIOPS_METRICS_TOKEN
  delete process.env.AIOPS_METRICS_TOKEN
  const server = createServer(fakePlatform(), { internalToken: 'test-token' })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  try {
    const open = await fetch(`${base}/metrics`)
    assert.equal(open.status, 200)
    assert.match(open.headers.get('content-type') ?? '', /text\/plain/)
    assert.match(await open.text(), /aiops_up 1/)

    process.env.AIOPS_METRICS_TOKEN = 'metrics-secret'
    const denied = await fetch(`${base}/metrics`)
    assert.equal(denied.status, 401)
    const wrong = await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer nope' } })
    assert.equal(wrong.status, 401)
    const allowed = await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer metrics-secret' } })
    assert.equal(allowed.status, 200)
    assert.match(await allowed.text(), /aiops_mcp_server_up\{server="k8s"\} 1/)
  } finally {
    if (previous === undefined) delete process.env.AIOPS_METRICS_TOKEN
    else process.env.AIOPS_METRICS_TOKEN = previous
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})