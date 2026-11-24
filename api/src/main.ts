import { readFile } from 'node:fs/promises'
import { compose } from './compose.ts'
import { createServer } from './http.ts'
import { log } from './log.ts'

const configPath = process.env.AIOPS_CONFIG ?? 'config/platform.json'
const {
  platform,
  host,
  port,
  internalToken,
  auth,
  allowActorHeader,
  secureCookies,
  modelProviders,
  models,
  notifications,
  notifier,
} = await compose(configPath)

// /metrics 不带鉴权保护时，至少不要对非回环地址开放。
if (!process.env.AIOPS_METRICS_TOKEN?.trim() && !['127.0.0.1', '::1', 'localhost'].includes(host)) {
  log.warn('AIOPS_METRICS_TOKEN 未设置：/metrics 对外匿名可读；生产或共享网络必须设置')
}

// 远程 DSH/浏览器接入走 HTTPS：证书和私钥必须同时提供，缺一个直接拒绝启动。
const certFile = process.env.AIOPS_TLS_CERT_FILE?.trim()
const keyFile = process.env.AIOPS_TLS_KEY_FILE?.trim()
if (Boolean(certFile) !== Boolean(keyFile)) {
  log.error('TLS 配置不完整：AIOPS_TLS_CERT_FILE 和 AIOPS_TLS_KEY_FILE 必须同时设置')
  process.exit(1)
}
let tls: { cert: Buffer; key: Buffer } | undefined
if (certFile && keyFile) {
  try {
    tls = { cert: await readFile(certFile), key: await readFile(keyFile) }
  } catch (error) {
    log.error('TLS 证书或私钥读取失败', { error })
    process.exit(1)
  }
}

const server = createServer(platform, {
  internalToken,
  ...(auth ? { auth } : {}),
  allowActorHeader,
  // HTTPS 部署自动给会话 Cookie 加 Secure。
  secureCookies: secureCookies || Boolean(tls),
  modelProviders,
  models,
  notifications,
  notifier,
  ...(tls ? { tls } : {}),
})
server.listen(port, host, () => {
  log.info('platform listening', {
    host,
    port,
    scheme: tls ? 'https' : 'http',
    auth: Boolean(auth),
    config: configPath,
  })
})

// 容器停止时先停止接新请求，再关 MCP session 和 MySQL 连接池；25 秒后强制退出。
let stopping = false
function shutdown(signal: string): void {
  if (stopping) return
  stopping = true
  log.info('platform shutting down', { signal })
  const force = setTimeout(() => {
    log.error('优雅退出超时，强制结束')
    process.exit(1)
  }, 25_000)
  force.unref()
  server.closeIdleConnections()
  server.close((error) => {
    void (async () => {
      try {
        await platform.close()
      } catch (closeError) {
        log.error('关闭平台资源失败', { error: closeError })
      }
      clearTimeout(force)
      if (error) {
        log.error('HTTP server 关闭失败', { error })
        process.exit(1)
      }
      process.exit(0)
    })()
  })
}

process.once('SIGTERM', () => shutdown('SIGTERM'))
process.once('SIGINT', () => shutdown('SIGINT'))