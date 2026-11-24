export type {
  KnowledgeDocument,
  KnowledgeDocumentInput,
  KnowledgeDocumentRecord,
  KnowledgeHit,
  KnowledgeManager,
  KnowledgeProvider,
} from './types.ts'
export { LocalKnowledgeProvider } from './local.ts'
export { HttpKnowledgeProvider } from './http.ts'
export type { HttpKnowledgeConfig, HttpKnowledgeKind } from './http.ts'
