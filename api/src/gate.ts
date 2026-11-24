import type { Approval } from './types.ts'

/**
 * 审批等待。本进程被 decideApproval 唤醒是快路径；同时按 pollMs 轮询存储，
 * 这样审批在另一个实例上通过/拒绝时，执行中的 runner 也能在有限时间内继续。
 * pollMs <= 0 时只依赖本地唤醒（单实例/测试用）。
 */
export class ApprovalGate {
  private readonly waiters = new Map<string, Set<() => void>>()

  constructor(private readonly pollMs = 2000) {}

  async wait(id: string, read: () => Promise<Approval | undefined>, signal: AbortSignal): Promise<Approval> {
    for (;;) {
      if (signal.aborted) throw abortError()
      // 先登记再读，避免读到 pending 之后、登记之前漏掉本地 notify。
      const wake = this.waitForWake(id, signal)
      let current: Approval | undefined
      try {
        current = await read()
      } catch (error) {
        wake.cancel()
        throw error
      }
      if (current && current.status !== 'pending') {
        wake.cancel()
        return current
      }
      await wake.promise
    }
  }

  /** 本地唤醒；其它实例的审批结果由 wait() 的轮询兜底。 */
  notify(approval: Approval): void {
    const waiters = this.waiters.get(approval.id)
    if (!waiters) return
    for (const wake of waiters) wake()
  }

  private waitForWake(id: string, signal: AbortSignal): { promise: Promise<void>; cancel: () => void } {
    let cancel = () => {}
    const promise = new Promise<void>((resolve, reject) => {
      let settled = false
      let timer: NodeJS.Timeout | undefined
      const cleanup = () => {
        if (timer) clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        const waiters = this.waiters.get(id)
        waiters?.delete(wake)
        if (waiters && waiters.size === 0) this.waiters.delete(id)
      }
      const finish = () => {
        if (settled) return
        settled = true
        cleanup()
        resolve()
      }
      const onAbort = () => {
        if (settled) return
        settled = true
        cleanup()
        reject(abortError())
      }
      const wake = () => finish()
      cancel = finish
      if (signal.aborted) {
        onAbort()
        return
      }
      const waiters = this.waiters.get(id) ?? new Set<() => void>()
      waiters.add(wake)
      this.waiters.set(id, waiters)
      signal.addEventListener('abort', onAbort)
      if (this.pollMs > 0) {
        timer = setTimeout(finish, this.pollMs)
        // 等待审批不应阻止进程退出；服务进程还有 server 等句柄保活。
        timer.unref?.()
      }
    })
    return { promise, cancel }
  }
}

function abortError(): Error {
  return new DOMException('任务已取消', 'AbortError')
}