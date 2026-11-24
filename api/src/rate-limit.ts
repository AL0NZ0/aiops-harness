/**
 * 进程内固定窗口限流。多实例部署时每个副本各自计数，
 * 真正的全局配额要靠前置网关或 Redis；这里只防单副本上的滥用和误操作。
 */
export interface RateLimitOptions {
  windowMs: number
  now?: () => number
}

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  retryAfterSec: number
}

export class FixedWindowLimiter {
  private readonly buckets = new Map<string, { resetAt: number; count: number }>()
  private checks = 0
  private readonly now: () => number

  constructor(private readonly options: RateLimitOptions) {
    this.now = options.now ?? Date.now
  }

  check(key: string, max: number): RateLimitResult {
    const now = this.now()
    const bucket = this.buckets.get(key)
    if (!bucket || bucket.resetAt <= now) {
      const resetAt = now + this.options.windowMs
      this.buckets.set(key, { resetAt, count: 1 })
      this.maybePrune(now)
      return { allowed: true, remaining: Math.max(0, max - 1), retryAfterSec: 0 }
    }
    if (bucket.count >= max) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      }
    }
    bucket.count += 1
    return { allowed: true, remaining: Math.max(0, max - bucket.count), retryAfterSec: 0 }
  }

  /** 测试和运维用：当前活跃桶数量。 */
  get size(): number {
    return this.buckets.size
  }

  private maybePrune(now: number): void {
    this.checks += 1
    if (this.checks % 256 !== 0 && this.buckets.size < 10_000) return
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key)
    }
  }
}

/**
 * 从环境变量读限流配置。AIOPS_RATE_LIMIT_DISABLED=1 时返回 undefined。
 * 默认：窗口 60 秒；一般请求 1200；写请求 60；登录 15。
 */
export interface RateLimitConfig {
  windowMs: number
  max: number
  writeMax: number
  loginMax: number
}

export function rateLimitConfig(env: NodeJS.ProcessEnv = process.env): RateLimitConfig | undefined {
  if (env.AIOPS_RATE_LIMIT_DISABLED === '1') return undefined
  return {
    windowMs: positiveInt(env.AIOPS_RATE_LIMIT_WINDOW_MS, 60_000),
    max: positiveInt(env.AIOPS_RATE_LIMIT_MAX, 1200),
    writeMax: positiveInt(env.AIOPS_RATE_LIMIT_WRITE_MAX, 60),
    loginMax: positiveInt(env.AIOPS_RATE_LIMIT_LOGIN_MAX, 15),
  }
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) return fallback
  // 0 表示关闭该类限流，交给调用方判断。
  return parsed
}