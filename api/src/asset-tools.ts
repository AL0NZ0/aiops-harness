import { toAssetView, type AssetStore } from './assets.ts'
import type { Tool } from './types.ts'

export function createAssetTools(assets: AssetStore): Tool[] {
  return [
    {
      name: 'asset.list',
      description: '列出本地登记的资产和机器信息。只读。',
      risk: 'read',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return { assets: (await assets.list()).map(toAssetView) }
      },
    },
    {
      name: 'asset.get',
      description: '按资产名查询负责人、等级、主机和归属。只读。',
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
        return { asset: toAssetView(asset) }
      },
    },
  ]
}