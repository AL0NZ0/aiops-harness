export function describeResult(tool: string, data: unknown): string[] {
  if (!isRecord(data)) return []
  if (tool === 'knowledge.search' && Array.isArray(data.hits)) {
    return data.hits.flatMap((hit) => {
      if (!isRecord(hit)) return []
      const title = asString(hit.title)
      const source = asString(hit.source)
      return title ? [`${title} 来源 ${source}`] : []
    })
  }
  if (tool === 'knowledge.get_document') {
    const source = asString(data.source)
    return source ? [`文档 ${source}`] : []
  }
  if (tool === 'asset.get' && isRecord(data.asset)) {
    const asset = data.asset
    return [`${asString(asset.name)} 负责人 ${asString(asset.owner)} 等级 ${asString(asset.tier)}`]
  }
  return []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
