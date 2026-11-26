import type { AssetRecord } from './assets.ts'
import type { CredentialStore } from './credentials.ts'

/**
 * 资产 SSH 连接测试结果，只存在进程内，重启后重新探测。
 * up = 真实 SSH 登录成功（认证、主机密钥和跳板机都通过）；down = 测试失败；
 * unknown = 缺主机、用户名、凭证或信任指纹，没有发起连接。
 */
export interface AssetProbeResult {
  name: string
  status: 'up' | 'down' | 'unknown'
  checkedAt: string
  target?: string
  latencyMs?: number
  error?: string
  /** 缺配置时不探测，直接给原因，页面和模型据此说明。 */
  blockedReason?: string
}

/** 凭证是否可用：内联密码/私钥，或引用的凭证里有对应密钥。 */
export async function assetCredentialReady(
  asset: AssetRecord,
  credentials: CredentialStore,
): Promise<boolean> {
  if (asset.sshCredentialId) {
    const credential = await credentials.get(asset.sshCredentialId)
    if (!credential) return false
    return credential.type === 'password' ? Boolean(credential.password) : Boolean(credential.privateKey)
  }
  return Boolean(asset.sshPassword || asset.sshKey)
}

/**
 * 资产能否作为 SSH 操作目标的前置条件，返回缺什么；undefined 表示配置齐全。
 * 只有配置齐全的资产才参与后台 SSH 探测，也只有它们能真正执行 ssh.* 工具。
 */
export async function assetSshBlockedReason(
  asset: AssetRecord,
  credentials: CredentialStore,
): Promise<string | undefined> {
  if (!(asset.ip || asset.host)) return '资产没有 IP 或主机名'
  if (!asset.sshUser) return '没有配置 SSH 用户名'
  if (!(await assetCredentialReady(asset, credentials))) {
    return asset.sshCredentialId ? '引用的 SSH 凭证不存在或没有密钥' : '没有配置 SSH 凭证'
  }
  if (!asset.sshHostKeyFingerprint) return '尚未信任 SSH 主机密钥'
  return undefined
}