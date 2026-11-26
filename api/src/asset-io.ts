import ExcelJS from 'exceljs'
import type { AssetView } from './assets.ts'

export interface AssetImportRow {
  /** 表格行号（从 1 开始，含表头行，方便用户对照 Excel）。 */
  row: number
  name: string
  host: string
  ip: string
  env: string
  owner: string
  tier: string
  repo: string
  note: string
  sshPort?: number
  sshUser: string
  credentialName: string
  jumpAsset: string
  /** 解析阶段就能确定的错误；有错误时整行跳过。 */
  error?: string
}

export interface AssetImportEntry {
  row: number
  name: string
  status: 'imported' | 'failed'
  error?: string
}

export interface AssetImportResult {
  total: number
  imported: number
  failed: number
  mode: 'skip' | 'overwrite'
  entries: AssetImportEntry[]
}

interface Column {
  key: string
  header: string
  aliases: string[]
  width: number
  hint: string
}

const COLUMNS: Column[] = [
  { key: 'name', header: '名称', aliases: ['name', '资产名'], width: 24, hint: '必填；小写字母、数字、点、下划线、连字符' },
  { key: 'host', header: '主机', aliases: ['host', '主机名'], width: 24, hint: '主机名，可留空' },
  { key: 'ip', header: 'IP', aliases: ['ip', '地址'], width: 18, hint: 'IP 地址，可留空' },
  { key: 'env', header: '环境', aliases: ['env'], width: 10, hint: '例如 prod / staging / dev' },
  { key: 'owner', header: '负责人', aliases: ['owner'], width: 12, hint: '资产负责人' },
  { key: 'tier', header: '等级', aliases: ['tier'], width: 10, hint: '例如 critical / normal' },
  { key: 'repo', header: '仓库', aliases: ['repo'], width: 20, hint: '代码或配置仓库，可留空' },
  { key: 'note', header: '备注', aliases: ['note'], width: 30, hint: '自由备注' },
  { key: 'sshPort', header: 'SSH端口', aliases: ['sshport', 'ssh端口', '端口'], width: 10, hint: '1-65535，留空默认 22' },
  { key: 'sshUser', header: 'SSH用户', aliases: ['sshuser', 'ssh用户', '用户'], width: 14, hint: '登录用户名' },
  { key: 'credentialName', header: '凭证名称', aliases: ['credential', 'credentialname', '凭证'], width: 20, hint: '必须与密码私钥管理里的凭证名一致；留空表示不关联' },
  { key: 'jumpAsset', header: '跳板机', aliases: ['jumpasset', 'jump', '跳板机资产'], width: 20, hint: '已存在或本文件中的资产名；留空表示不用跳板机' },
]

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, '')
}

/** ExcelJS 的单元格值可能是公式、超链接或富文本，统一提取成文本。 */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') {
    const cell = value as {
      text?: unknown
      richText?: Array<{ text?: unknown }>
      result?: unknown
      error?: unknown
    }
    if (typeof cell.text === 'string') return cell.text.trim()
    if (Array.isArray(cell.richText)) {
      return cell.richText.map((part) => String(part?.text ?? '')).join('').trim()
    }
    if (cell.result !== undefined) return cellText(cell.result)
    if (cell.error !== undefined) return ''
  }
  return String(value).trim()
}

function assetCell(asset: AssetView, key: string, credentialNames: Map<string, string>): string | number {
  switch (key) {
    case 'name':
      return asset.name
    case 'host':
      return asset.host ?? ''
    case 'ip':
      return asset.ip ?? ''
    case 'env':
      return asset.env ?? ''
    case 'owner':
      return asset.owner ?? ''
    case 'tier':
      return asset.tier ?? ''
    case 'repo':
      return asset.repo ?? ''
    case 'note':
      return asset.note ?? ''
    case 'sshPort':
      return asset.sshPort ?? ''
    case 'sshUser':
      return asset.sshUser ?? ''
    case 'credentialName':
      return asset.sshCredentialId ? (credentialNames.get(asset.sshCredentialId) ?? '') : ''
    case 'jumpAsset':
      return asset.sshJumpAsset ?? ''
    default:
      return ''
  }
}

/** 导出资产表：第一张是数据表，第二张列字段说明；没有资产时只导出表头和说明，可直接当模板。 */
export async function buildAssetWorkbook(
  assets: AssetView[],
  credentialNames: Map<string, string>,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('资产')
  sheet.columns = COLUMNS.map((column) => ({ header: column.header, key: column.key, width: column.width }))
  for (const asset of assets) {
    const row: Record<string, string | number> = {}
    for (const column of COLUMNS) row[column.key] = assetCell(asset, column.key, credentialNames)
    sheet.addRow(row)
  }

  const help = workbook.addWorksheet('说明')
  help.columns = [
    { header: '字段', key: 'field', width: 14 },
    { header: '说明', key: 'hint', width: 80 },
  ]
  for (const column of COLUMNS) help.addRow({ field: column.header, hint: column.hint })
  help.addRow({ field: '导入规则', hint: '默认跳过同名资产；勾选「覆盖同名资产」后按行更新。主机密钥指纹和 SSH 只读路径不随表格导入。' })
  help.addRow({ field: '日志', hint: '导入完成后页面会逐行显示成功或失败原因，失败行不会中断后续导入。' })

  const buffer = await workbook.xlsx.writeBuffer()
  return Buffer.from(buffer)
}

/** 解析第一张工作表；中英文表头都认，解析阶段的错误写进 row.error。 */
export async function parseAssetWorkbook(buffer: Buffer): Promise<AssetImportRow[]> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer)
  const sheet = workbook.worksheets[0]
  if (!sheet) return []

  const headerCells = (sheet.getRow(1).values as unknown[] | undefined)?.slice(1) ?? []
  if (!headerCells.length) return []
  const header = headerCells.map((cell) => normalizeHeader(cellText(cell)))
  const indexByKey = new Map<string, number>()
  for (const column of COLUMNS) {
    const candidates = [column.header, ...column.aliases].map(normalizeHeader)
    const index = header.findIndex((item) => candidates.includes(item))
    if (index >= 0) indexByKey.set(column.key, index)
  }
  if (!indexByKey.has('name')) throw new Error('缺少「名称」列')

  const rows: AssetImportRow[] = []
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber)
    const cells = ((row.values as unknown[] | undefined) ?? []).slice(1)
    const mapped = [...indexByKey.values()].map((index) => cellText(cells[index]))
    if (mapped.every((item) => item === '')) continue
    const get = (key: string): string => {
      const cellIndex = indexByKey.get(key)
      return cellIndex === undefined ? '' : cellText(cells[cellIndex])
    }
    const name = get('name')
    const portText = get('sshPort')
    let sshPort: number | undefined
    let error: string | undefined
    if (!name) {
      error = '名称不能为空'
    } else if (portText) {
      const parsed = Number(portText)
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) error = 'SSH端口必须是 1 到 65535 的整数'
      else sshPort = parsed
    }
    rows.push({
      row: rowNumber,
      name,
      host: get('host'),
      ip: get('ip'),
      env: get('env'),
      owner: get('owner'),
      tier: get('tier'),
      repo: get('repo'),
      note: get('note'),
      ...(sshPort ? { sshPort } : {}),
      sshUser: get('sshUser'),
      credentialName: get('credentialName'),
      jumpAsset: get('jumpAsset'),
      ...(error ? { error } : {}),
    })
  }
  return rows
}