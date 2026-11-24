import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ApprovalGate } from '../src/gate.ts'
import type { Approval } from '../src/types.ts'

/**
 * 生产进程有 HTTP server 句柄保活，gate 的轮询定时器可以 unref；
 * 测试里没有别的句柄，需要自己拿一个避免事件循环提前退出。
 */
function keepAlive(): () => void {
  const timer = setInterval(() => {}, 1000)
  return () => clearInterval(timer)
}

function approval(status: Approval['status']): Approval {
  return {
    id: 'apr_gate',
    taskId: 'task_gate',
    ownerId: 'alice',
    tool: 'demo.restart',
    args: {},
    argsHash: '{}',
    status,
    requestedBy: 'alice',
    requestedAt: '2026-01-01T00:00:00.000Z',
    consumed: false,
  }
}

test('审批在本进程被决定时立即唤醒', async () => {
  const stop = keepAlive()
  const gate = new ApprovalGate(60_000)
  let current: Approval | undefined = approval('pending')
  const controller = new AbortController()
  const waiting = gate.wait('apr_gate', async () => current, controller.signal)
  current = approval('approved')
  gate.notify(current)
  assert.equal((await waiting).status, 'approved')
  stop()
})

test('审批在其它实例被决定时靠轮询拿到结果', async () => {
  const stop = keepAlive()
  const gate = new ApprovalGate(20)
  let current: Approval | undefined = approval('pending')
  const controller = new AbortController()
  const waiting = gate.wait('apr_gate', async () => current, controller.signal)
  // 模拟另一个实例直接写库：不调用 notify。
  setTimeout(() => {
    current = approval('rejected')
  }, 30)
  const decided = await waiting
  assert.equal(decided.status, 'rejected')
  stop()
})

test('任务取消会中断审批等待', async () => {
  const stop = keepAlive()
  const gate = new ApprovalGate(20)
  const controller = new AbortController()
  const waiting = gate.wait('apr_gate', async () => approval('pending'), controller.signal)
  setTimeout(() => controller.abort(), 10)
  await assert.rejects(waiting, (error: unknown) => error instanceof Error && error.name === 'AbortError')
  stop()
})