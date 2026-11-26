import { assetSshBlockedReason, type AssetProbeResult } from './asset-probe.ts'
import { toAssetView, type AssetRecord, type AssetStore } from './assets.ts'
import type { CredentialStore } from './credentials.ts'
import type { Tool } from './types.ts'

export interface AssetToolOptions {
  /** 与 Platform 共用的 SSH 连接测试缓存；没有时只返回配置状态。 */
  probes?: Map<string, AssetProbeResult>
  credentials?: CredentialStore
}

/** 模型操作的 SSH 视图：只有 configured=true 且 status=up 的资产才真正可连。 */
export interface AssetSshView {
  configured: boolean
  status: 'up' | 'down' | 'unknown' | 'unchecked'
  checkedAt?: string
  latencyMs?: number
  error?: string
  blockedReason?: string
}

export function createAssetTools(assets: AssetStore, options: AssetToolOptions = {}): Tool[] {
  const view = async (asset: AssetRecord): Promise<Record<string, unknown>> => {
    return { ...toAssetView(asset), ssh: await sshView(asset, options) }
  }
  return [
    {
      name: 'asset.list',
      description:
        '列出本地登记的资产和机器信息。只读。每台资产的 ssh.status 是最近一次真实 SSH 登录测试结果：up=可连接，down=连不上，unchecked=还没测过；ssh.configured=false 表示缺主机、SSH 用户、凭证或未信任主机密钥，不能作为操作目标，blockedReason 给出缺什么。',
      risk: 'read',
      parameters: { type: 'object', properties: {} },
      async execute() {
        const records = await assets.list()
        return { assets: await Promise.all(records.map(view)) }
      },
    },
    {
      name: 'asset.get',
      description:
        '按资产名查询负责人、等级、主机、SSH 配置和最近一次连接测试结果。只读。ssh.status 为 up 才代表最近能连上；ssh.configured=false 时看 ssh.blockedReason，不要把它当成可操作目标。',
      risk: 'read',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
      async execute(args) {
        const name = typeof args.name === 'string' ? args.name.trim() : ''
        if (!name) throw new Error('参数 name 必填')
        const asset = await assets.get(name)
        if (!asset) throw new Error(`没有登记资产 ${name}`)
        return { asset: await view(asset) }
      },
    },
  ]
}

async function sshView(asset: AssetRecord, options: AssetToolOptions): Promise<AssetSshView> {
  if (!options.credentials) {
    const probe = options.probes?.get(asset.name)
    return {
      configured: Boolean(asset.sshHostKeyFingerprint) && Boolean(asset.ip || asset.host) && Boolean(asset.sshUser),
      status: probe?.status ?? 'unchecked',
      ...(probe?.checkedAt ? { checkedAt: probe.checkedAt } : {}),
      ...(probe?.latencyMs !== undefined ? { latencyMs: probe.latencyMs } : {}),
      ...(probe?.error ? { error: probe.error } : {}),
      ...(probe?.blockedReason ? { blockedReason: probe.blockedReason } : {}),
    }
  }
  const blocked = await assetSshBlockedReason(asset, options.credentials)
  const probe = options.probes?.get(asset.name)
  if (blocked) {
    return { configured: false, status: 'unknown', blockedReason: blocked }
  }
  if (!probe || probe.blockedReason) {
    // 配置齐全但这一轮还没测过：不能当成可连接。
    return { configured: true, status: 'unchecked' }
  }
  return {
    configured: true,
    status: probe.status,
    ...(probe.checkedAt ? { checkedAt: probe.checkedAt } : {}),
    ...(probe.latencyMs !== undefined ? { latencyMs: probe.latencyMs } : {}),
    ...(probe.error ? { error: probe.error } : {}),
  }
}
