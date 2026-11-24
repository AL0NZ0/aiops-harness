import type { KnowledgeDocument, KnowledgeHit, KnowledgeProvider } from './types.ts'

export type HttpKnowledgeKind = 'ragflow' | 'dify' | 'generic'

export interface HttpKnowledgeConfig {
  kind: HttpKnowledgeKind
  baseUrl: string
  apiKey?: string
  datasetId?: string
  fetchImpl?: typeof fetch
}

/**
 * 外部知识库的薄适配。
 * RAGFlow 走 /api/v1/retrieval，Dify 走 /v1/datasets/{id}/retrieve，
 * generic 走本平台约定的 /search 与 /documents。
 */
export class HttpKnowledgeProvider implements KnowledgeProvider {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(private readonly config: HttpKnowledgeConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '')
    this.fetchImpl = config.fetchImpl ?? fetch
    if ((config.kind === 'ragflow' || config.kind === 'dify') && !config.datasetId) {
      throw new Error(`${config.kind} 需要 datasetId`)
    }
  }

  async search(query: string, topK: number, actorId: string): Promise<KnowledgeHit[]> {
    if (this.config.kind === 'ragflow') return this.searchRagflow(query, topK, actorId)
    if (this.config.kind === 'dify') return this.searchDify(query, topK, actorId)
    return this.searchGeneric(query, topK, actorId)
  }

  async getDocument(docId: string, actorId: string): Promise<KnowledgeDocument> {
    if (this.config.kind === 'ragflow') return this.documentRagflow(docId, actorId)
    if (this.config.kind === 'dify') return this.documentDify(docId, actorId)
    return this.documentGeneric(docId, actorId)
  }

  private async searchRagflow(query: string, topK: number, actorId: string): Promise<KnowledgeHit[]> {
    const body = await this.post('/api/v1/retrieval', actorId, {
      question: query,
      dataset_ids: [this.config.datasetId],
      page_size: topK,
      top_k: topK,
    })
    assertOkCode(body)
    const chunks = arrayAt(body, ['data', 'chunks']) ?? arrayAt(body, ['chunks']) ?? []
    return chunks.slice(0, topK).map((chunk) => ({
      docId: text(chunk, 'document_id') || text(chunk, 'id'),
      title: text(chunk, 'document_keyword') || text(chunk, 'document_name') || text(chunk, 'document_id'),
      snippet: clip(text(chunk, 'content')),
      source: text(chunk, 'document_name') || 'ragflow',
      score: numberAt(chunk, 'similarity') || numberAt(chunk, 'score'),
    }))
  }

  private async documentRagflow(docId: string, actorId: string): Promise<KnowledgeDocument> {
    const datasetId = this.config.datasetId ?? ''
    const body = await this.get(`/api/v1/datasets/${encodeURIComponent(datasetId)}/documents/${encodeURIComponent(docId)}/chunks`, actorId)
    assertOkCode(body)
    const chunks = arrayAt(body, ['data', 'chunks']) ?? arrayAt(body, ['data']) ?? []
    const document = recordAt(body, ['data', 'document']) ?? {}
    const content = chunks.map((chunk) => text(chunk, 'content')).filter(Boolean).join('\n\n')
    if (!content) throw new Error('文档不存在')
    const title = text(document, 'name')
    return { content, source: title || 'ragflow', meta: { docId, title } }
  }

  private async searchDify(query: string, topK: number, actorId: string): Promise<KnowledgeHit[]> {
    const datasetId = this.config.datasetId ?? ''
    const body = await this.post(`/v1/datasets/${encodeURIComponent(datasetId)}/retrieve`, actorId, {
      query,
      retrieval_model: {
        search_method: 'semantic_search',
        reranking_enable: false,
        top_k: topK,
        score_threshold_enabled: false,
      },
    })
    const records = arrayAt(body, ['records']) ?? []
    return records.slice(0, topK).map((record) => {
      const segment = recordAt(record, ['segment']) ?? {}
      const document = recordAt(segment, ['document']) ?? {}
      return {
        docId: text(segment, 'document_id') || text(document, 'id') || text(segment, 'id'),
        title: text(document, 'name') || text(segment, 'document_id'),
        snippet: clip(text(segment, 'content')),
        source: text(document, 'name') || 'dify',
        score: numberAt(record, 'score'),
      }
    })
  }

  private async documentDify(docId: string, actorId: string): Promise<KnowledgeDocument> {
    const datasetId = this.config.datasetId ?? ''
    const body = await this.get(
      `/v1/datasets/${encodeURIComponent(datasetId)}/documents/${encodeURIComponent(docId)}/segments?limit=100`,
      actorId,
    )
    const segments = arrayAt(body, ['data']) ?? []
    const content = segments.map((segment) => text(segment, 'content')).filter(Boolean).join('\n\n')
    if (!content) throw new Error('文档不存在')
    return { content, source: 'dify', meta: { docId, title: docId } }
  }

  private async searchGeneric(query: string, topK: number, actorId: string): Promise<KnowledgeHit[]> {
    const body = await this.post('/search', actorId, { query, top_k: topK })
    const hits = arrayAt(body, ['hits']) ?? []
    return hits.slice(0, topK).map((hit) => ({
      docId: text(hit, 'doc_id'),
      title: text(hit, 'title'),
      snippet: text(hit, 'snippet'),
      source: text(hit, 'source'),
      score: numberAt(hit, 'score'),
    }))
  }

  private async documentGeneric(docId: string, actorId: string): Promise<KnowledgeDocument> {
    const body = await this.post('/documents', actorId, { doc_id: docId })
    const content = text(body, 'content')
    if (!content) throw new Error('文档不存在')
    const meta = recordAt(body, ['meta']) ?? {}
    const metaStrings: Record<string, string> = { docId }
    for (const [key, value] of Object.entries(meta)) {
      if (typeof value === 'string') metaStrings[key] = value
    }
    return { content, source: text(body, 'source'), meta: metaStrings }
  }

  private async post(pathname: string, actorId: string, payload: unknown): Promise<Record<string, unknown>> {
    return this.request('POST', pathname, actorId, payload)
  }

  private async get(pathname: string, actorId: string): Promise<Record<string, unknown>> {
    return this.request('GET', pathname, actorId)
  }

  private async request(method: string, pathname: string, actorId: string, payload?: unknown): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { 'x-actor-id': actorId }
    if (payload !== undefined) headers['content-type'] = 'application/json'
    if (this.config.apiKey) headers.authorization = `Bearer ${this.config.apiKey}`
    const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      method,
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
    })
    const textBody = await response.text()
    if (!response.ok) throw new Error(`知识库请求失败 ${response.status}: ${textBody.slice(0, 200)}`)
    const parsed: unknown = textBody ? JSON.parse(textBody) : {}
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('知识库返回的不是对象')
    return parsed as Record<string, unknown>
  }
}

function assertOkCode(body: Record<string, unknown>): void {
  if (typeof body.code === 'number' && body.code !== 0) {
    const message = typeof body.message === 'string' ? body.message : '知识库返回错误'
    throw new Error(message)
  }
}

function arrayAt(body: Record<string, unknown>, path: string[]): Record<string, unknown>[] | undefined {
  const value = walk(body, path)
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
}

function recordAt(body: Record<string, unknown>, path: string[]): Record<string, unknown> | undefined {
  const value = walk(body, path)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function walk(body: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = body
  for (const key of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function text(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

function numberAt(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  return typeof value === 'number' ? value : 0
}

function clip(content: string): string {
  return content.replace(/\s+/g, ' ').trim().slice(0, 180)
}
