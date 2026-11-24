import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  KnowledgeDocument,
  KnowledgeDocumentInput,
  KnowledgeDocumentRecord,
  KnowledgeHit,
  KnowledgeManager,
  KnowledgeProvider,
} from './types.ts'

interface LocalDoc {
  id: string
  title: string
  source: string
  content: string
  actors: string[]
}

const SNIPPET = 180

export class LocalKnowledgeProvider implements KnowledgeProvider, KnowledgeManager {
  private docs: LocalDoc[] | undefined

  constructor(private readonly root: string) {}

  async search(query: string, topK: number, actorId: string): Promise<KnowledgeHit[]> {
    const docs = await this.load()
    const scored = docs
      .filter((doc) => visible(doc, actorId))
      .map((doc) => ({ doc, score: scoreDoc(doc, query) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id))
      .slice(0, topK)
    return scored.map(({ doc, score }) => ({
      docId: doc.id,
      title: doc.title,
      snippet: snippet(doc.content, query),
      source: doc.source,
      score: round(score),
    }))
  }

  async getDocument(docId: string, actorId: string): Promise<KnowledgeDocument> {
    const docs = await this.load()
    const doc = docs.find((item) => item.id === docId && visible(item, actorId))
    if (!doc) throw new Error('文档不存在')
    return {
      content: doc.content,
      source: doc.source,
      meta: { docId: doc.id, title: doc.title },
    }
  }

  async listDocuments(): Promise<KnowledgeDocumentRecord[]> {
    const docs = await this.load()
    return docs.map((doc) => ({
      docId: doc.id,
      title: doc.title,
      source: doc.source,
      actors: [...doc.actors],
      content: doc.content,
    }))
  }

  async saveDocument(input: KnowledgeDocumentInput): Promise<void> {
    const doc = normalizeDocument(input)
    await mkdir(this.root, { recursive: true })
    await writeFile(path.join(this.root, `${doc.id}.md`), renderDocument(doc))
    this.docs = undefined
  }

  async deleteDocument(id: string): Promise<boolean> {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error('文档 id 只能包含小写字母、数字和连字符')
    try {
      await unlink(path.join(this.root, `${id}.md`))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    this.docs = undefined
    return true
  }

  private async load(): Promise<LocalDoc[]> {
    if (this.docs) return this.docs
    const entries = await readdir(this.root, { withFileTypes: true })
    const docs: LocalDoc[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      const raw = await readFile(path.join(this.root, entry.name), 'utf8')
      docs.push(parseDoc(entry.name, raw))
    }
    const ids = new Set<string>()
    for (const doc of docs) {
      if (ids.has(doc.id)) throw new Error(`知识文档 id 重复: ${doc.id}`)
      ids.add(doc.id)
    }
    this.docs = docs
    return docs
  }
}

function parseDoc(filename: string, raw: string): LocalDoc {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) throw new Error(`${filename} 缺少 frontmatter`)
  const fm = match[1] ?? ''
  const content = (match[2] ?? '').trim()
  const id = field(fm, 'id') || filename.replace(/\.md$/, '')
  const title = field(fm, 'title') || id
  const source = field(fm, 'source') || filename
  const actors = field(fm, 'actors')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  return { id, title, source, content, actors }
}

function field(frontmatter: string, key: string): string {
  return frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim() ?? ''
}

function normalizeDocument(input: KnowledgeDocumentInput): KnowledgeDocumentInput {
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error('文档 id 只能包含小写字母、数字和连字符')
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  if (!title || /[\r\n]/.test(title)) throw new Error('title 必填且不能换行')
  const source = typeof input.source === 'string' ? input.source.trim() : ''
  if (!source || /[\r\n]/.test(source)) throw new Error('source 必填且不能换行')
  const content = typeof input.content === 'string' ? input.content.trim() : ''
  if (!content) throw new Error('content 必填')
  const actors = Array.isArray(input.actors)
    ? input.actors.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
    : []
  return { id, title, source, content, actors }
}

function renderDocument(doc: KnowledgeDocumentInput): string {
  const lines = ['---', `id: ${doc.id}`, `title: ${doc.title}`, `source: ${doc.source}`]
  if (doc.actors && doc.actors.length > 0) lines.push(`actors: ${doc.actors.join(',')}`)
  lines.push('---', '', doc.content, '')
  return lines.join('\n')
}

function visible(doc: LocalDoc, actorId: string): boolean {
  return doc.actors.length === 0 || doc.actors.includes(actorId)
}

function scoreDoc(doc: LocalDoc, query: string): number {
  const tokens = tokenize(query)
  if (tokens.length === 0) return 0
  const title = doc.title.toLowerCase()
  const body = doc.content.toLowerCase()
  const phrase = query.trim().toLowerCase()
  let score = 0
  if (phrase && title.includes(phrase)) score += 3
  if (phrase && body.includes(phrase)) score += 2
  for (const token of tokens) {
    if (title.includes(token)) score += 1
    if (body.includes(token)) score += 0.5
  }
  return score
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,，。；;、]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

function snippet(content: string, query: string): string {
  const flat = content.replace(/\s+/g, ' ').trim()
  const needle = query.trim().toLowerCase().slice(0, 40)
  const idx = needle ? flat.toLowerCase().indexOf(needle) : -1
  if (idx < 0) return flat.slice(0, SNIPPET)
  const start = Math.max(0, idx - 40)
  return flat.slice(start, start + SNIPPET)
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}
