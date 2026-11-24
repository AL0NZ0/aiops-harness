import type { KnowledgeProvider } from '../../extensions/knowledge/src/types.ts'
import type { Tool } from './types.ts'

export function createKnowledgeTools(provider: KnowledgeProvider): Tool[] {
  return [
    {
      name: 'knowledge.search',
      description: '检索外部知识库，返回文档编号、标题、片段、来源和分数。只读。',
      risk: 'read',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          top_k: { type: 'integer' },
        },
        required: ['query'],
      },
      async execute(args, ctx) {
        const query = text(args.query, 'query')
        const topK = topKOf(args.top_k)
        const hits = await provider.search(query, topK, ctx.actorId)
        return { hits }
      },
    },
    {
      name: 'knowledge.get_document',
      description: '按文档编号读取全文、来源和元信息。只读。',
      risk: 'read',
      parameters: {
        type: 'object',
        properties: { doc_id: { type: 'string' } },
        required: ['doc_id'],
      },
      async execute(args, ctx) {
        return provider.getDocument(text(args.doc_id, 'doc_id'), ctx.actorId)
      },
    },
  ]
}

function text(value: unknown, key: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`参数 ${key} 必填`)
  return value.trim()
}

function topKOf(value: unknown): number {
  if (value === undefined) return 5
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 20) {
    throw new Error('参数 top_k 必须是 1 到 20 的整数')
  }
  return value
}
