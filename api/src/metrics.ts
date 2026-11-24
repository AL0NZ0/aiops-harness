import type { AuthService } from './auth.ts'
import type { Platform, MetricsSnapshot } from './platform.ts'

/**
 * 进程内计数器注册表。只保留进程生命周期内的累计值，重启清零；
 * 需要跨重启的趋势由 Prometheus 自己按 scrape 计算。
 */
const counters = new Map<string, { name: string; labels: Record<string, string>; value: number }>()

export function incCounter(name: string, labels: Record<string, string> = {}, by = 1): void {
  const key = `${name}|${Object.entries(labels).sort().map(([k, v]) => `${k}=${v}`).join(',')}`
  const found = counters.get(key)
  if (found) {
    found.value += by
    return
  }
  counters.set(key, { name, labels, value: by })
}

export function counterValue(name: string, labels: Record<string, string> = {}): number {
  const key = `${name}|${Object.entries(labels).sort().map(([k, v]) => `${k}=${v}`).join(',')}`
  return counters.get(key)?.value ?? 0
}

/** 测试用：隔离用例之间的计数。 */
export function resetCounters(): void {
  counters.clear()
}

interface MetricLine {
  help: string
  type: 'counter' | 'gauge'
  name: string
  samples: Array<{ labels?: Record<string, string | number>; value: number }>
}

export async function renderMetrics(
  platform: Platform,
  auth: AuthService | undefined,
  startedAt: number,
  now = Date.now(),
): Promise<string> {
  const snapshot = await platform.metricsSnapshot()
  const lines: MetricLine[] = [
    { help: '平台进程存活', type: 'gauge', name: 'aiops_up', samples: [{ value: 1 }] },
    {
      help: '平台进程运行秒数',
      type: 'gauge',
      name: 'aiops_uptime_seconds',
      samples: [{ value: Math.max(0, Math.round((now - startedAt) / 1000)) }],
    },
    taskLines(snapshot),
    {
      help: '审批按状态计数',
      type: 'gauge',
      name: 'aiops_approvals',
      samples: APPROVAL_STATUSES.map((status) => ({
        labels: { status },
        value: snapshot.approvals[status] ?? 0,
      })),
    },
    {
      help: '挂起中的审批数',
      type: 'gauge',
      name: 'aiops_pending_approvals',
      samples: [{ value: snapshot.approvals.pending ?? 0 }],
    },
    {
      help: '已注册工具数',
      type: 'gauge',
      name: 'aiops_tools',
      samples: Object.entries(snapshot.tools).map(([risk, value]) => ({ labels: { risk }, value })),
    },
    {
      help: '上游 MCP server 是否可用（1 可用，0 摘除中）',
      type: 'gauge',
      name: 'aiops_mcp_server_up',
      samples: snapshot.mcp.map((server) => ({ labels: { server: server.name }, value: server.ok ? 1 : 0 })),
    },
    {
      help: '上游 MCP server 连续失败次数',
      type: 'gauge',
      name: 'aiops_mcp_server_failures',
      samples: snapshot.mcp.map((server) => ({ labels: { server: server.name }, value: server.failures })),
    },
    {
      help: '上游 MCP 工具集变化是否待人工复核',
      type: 'gauge',
      name: 'aiops_mcp_review_required',
      samples: snapshot.mcp.map((server) => ({ labels: { server: server.name }, value: server.reviewRequired ? 1 : 0 })),
    },
    {
      help: '进程常驻内存字节数',
      type: 'gauge',
      name: 'process_resident_memory_bytes',
      samples: [{ value: process.memoryUsage().rss }],
    },
    {
      help: 'Node 堆内存使用字节数',
      type: 'gauge',
      name: 'process_heap_bytes',
      samples: [{ value: process.memoryUsage().heapUsed }],
    },
  ]
  if (auth) {
    lines.push({
      help: '安全事件表累计条数',
      type: 'gauge',
      name: 'aiops_security_events_total',
      samples: [{ value: await auth.countSecurityEvents() }],
    })
  }
  for (const counter of counters.values()) {
    lines.push({
      help: COUNTER_HELP[counter.name] ?? '进程内计数器',
      type: 'counter',
      name: counter.name,
      samples: [{ labels: counter.labels, value: counter.value }],
    })
  }
  return lines.map(renderLine).join('\n') + '\n'
}

const TASK_STATUSES = ['queued', 'running', 'awaiting_approval', 'succeeded', 'failed', 'cancelled'] as const
const APPROVAL_STATUSES = ['pending', 'approved', 'rejected'] as const

function taskLines(snapshot: MetricsSnapshot): MetricLine {
  return {
    help: '任务按状态计数',
    type: 'gauge',
    name: 'aiops_tasks',
    samples: TASK_STATUSES.map((status) => ({ labels: { status }, value: snapshot.tasks[status] ?? 0 })),
  }
}

const COUNTER_HELP: Record<string, string> = {
  aiops_notifications_total: '通知投递结果计数',
  aiops_http_errors_total: 'HTTP 请求错误计数',
  aiops_rate_limited_total: '被限流拒绝的请求计数',
}

function renderLine(metric: MetricLine): string {
  if (metric.samples.length === 0) return ''
  const body = metric.samples
    .map((sample) => {
      const labels = sample.labels && Object.keys(sample.labels).length > 0 ? renderLabels(sample.labels) : ''
      return `${metric.name}${labels} ${sample.value}`
    })
    .join('\n')
  return `# HELP ${metric.name} ${metric.help}\n# TYPE ${metric.name} ${metric.type}\n${body}`
}

function renderLabels(labels: Record<string, string | number>): string {
  const parts = Object.entries(labels).map(([key, value]) => `${key}="${escapeLabel(String(value))}"`)
  return `{${parts.join(',')}}`
}

function escapeLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')
}