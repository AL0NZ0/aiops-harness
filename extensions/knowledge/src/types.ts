export interface KnowledgeHit {
  docId: string
  title: string
  snippet: string
  source: string
  score: number
}

export interface KnowledgeDocument {
  content: string
  source: string
  meta: Record<string, string>
}

export interface KnowledgeDocumentRecord {
  docId: string
  title: string
  source: string
  actors: string[]
  content: string
}

export interface KnowledgeDocumentInput {
  id: string
  title: string
  source: string
  content: string
  actors?: string[]
}

/** 本地 Markdown 知识库才支持页面管理。 */
export interface KnowledgeManager {
  listDocuments(): Promise<KnowledgeDocumentRecord[]>
  saveDocument(input: KnowledgeDocumentInput): Promise<void>
  deleteDocument(id: string): Promise<boolean>
}

/** 统一检索口。向量化和索引留在外部知识库，这里只做入口。 */
export interface KnowledgeProvider {
  search(query: string, topK: number, actorId: string): Promise<KnowledgeHit[]>
  getDocument(docId: string, actorId: string): Promise<KnowledgeDocument>
}
