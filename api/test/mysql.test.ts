import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createConnection } from 'mysql2/promise'
import { MySqlStore, type MySqlConfig } from '../src/mysql-store.ts'
import { nid } from '../src/ids.ts'
import type { Task } from '../src/types.ts'

const config: MySqlConfig | undefined = process.env.AIOPS_DB_HOST
  ? {
      host: process.env.AIOPS_DB_HOST,
      port: Number(process.env.AIOPS_DB_PORT ?? 3306),
      user: process.env.AIOPS_DB_USER ?? '',
      password: process.env.AIOPS_DB_PASSWORD ?? '',
      database: process.env.AIOPS_DB_NAME ?? '',
    }
  : undefined

test(
  'MySQL 持久化任务/事件/审批，并保证审批只消费一次',
  { skip: config ? false : '未设置 AIOPS_DB_*，跳过 MySQL 集成测试' },
  async () => {
    assert.ok(config)
    const store = new MySqlStore(config)
    const taskId = nid('task')
    const approvalId = nid('apr')
    let closed = false
    try {
      await store.init()
      const now = new Date().toISOString()
      const task: Task = {
        id: taskId,
        sessionId: `test:${taskId}`,
        ownerId: 'alice',
        title: 'MySQL 持久化测试',
        prompt: 'test',
        skill: 'k8s-troubleshooting',
        status: 'awaiting_approval',
        origin: 'web',
        createdAt: now,
        updatedAt: now,
      }
      await store.saveTask(task)
      await store.appendEvent({ id: nid('evt'), taskId, type: 'task.started', at: now, data: { ok: true } })
      await store.saveApproval({
        id: approvalId,
        taskId,
        ownerId: 'alice',
        tool: 'k8s.restart_workload',
        args: { namespace: 'shop', name: 'checkout-api' },
        argsHash: '{}',
        status: 'pending',
        requestedBy: 'alice',
        requestedAt: now,
        consumed: false,
      })
      assert.equal(await store.decideApproval(approvalId, 'approved', 'bob', now, '窗口内'), true)
      assert.equal(await store.decideApproval(approvalId, 'approved', 'bob', now), false)
      assert.equal(await store.consumeApproval(approvalId), true)
      assert.equal(await store.consumeApproval(approvalId), false)
      await store.appendAudit({
        id: nid('aud'),
        taskId,
        actorId: 'bob',
        tool: 'k8s.restart_workload',
        risk: 'mutate',
        args: { namespace: 'shop', name: 'checkout-api' },
        decision: 'approved',
        approvalId,
        at: now,
      })

      const rollbackId = nid('task')
      await assert.rejects(
        () =>
          store.transaction(async (tx) => {
            await tx.saveTask({ ...task, id: rollbackId, title: 'rollback' })
            throw new Error('rollback')
          }),
        /rollback/,
      )
      assert.equal(await store.getTask(rollbackId), undefined)
      await store.close()
      closed = true

      const reopened = new MySqlStore(config)
      await reopened.init()
      assert.equal((await reopened.getTask(taskId))?.status, 'awaiting_approval')
      assert.equal((await reopened.getApproval(approvalId))?.consumed, true)
      assert.equal((await reopened.eventsFor(taskId)).length, 1)
      assert.equal((await reopened.auditsFor(taskId)).length, 1)
      await reopened.close()
    } finally {
      // 断言失败时也要释放连接池，否则测试进程会一直挂着。
      if (!closed) await store.close().catch(() => undefined)
      const conn = await createConnection(config)
      try {
        await conn.query('DELETE FROM task_events WHERE task_id = ?', [taskId])
        await conn.query('DELETE FROM audit_records WHERE task_id = ?', [taskId])
        await conn.query('DELETE FROM approvals WHERE task_id = ?', [taskId])
        await conn.query('DELETE FROM tasks WHERE id = ?', [taskId])
      } finally {
        await conn.end()
      }
    }
  },
)