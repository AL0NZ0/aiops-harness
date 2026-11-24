import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { HttpKnowledgeProvider } from '../../extensions/knowledge/src/index.ts'

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

test('RAGFlow、Dify 和 generic 都映射成统一检索结果', async () => {
  const seen: string[] = []
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers['x-actor-id'] ?? ''}`)
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      if (req.url === '/api/v1/retrieval') {
        res.end(JSON.stringify({ code: 0, data: { chunks: [{ content: 'postgres refused', document_id: 'doc-1', document_keyword: 'checkout', document_name: 'wiki/checkout.md', similarity: 0.88 }] } }))
        return
      }
      if (req.url?.startsWith('/api/v1/datasets/ds/documents/doc-1/chunks')) {
        res.end(JSON.stringify({ code: 0, data: { chunks: [{ content: 'full postgres runbook' }], document: { name: 'wiki/checkout.md' } } }))
        return
      }
      if (req.url === '/v1/datasets/ds/retrieve') {
        res.end(JSON.stringify({ records: [{ score: 0.71, segment: { id: 'seg-1', content: 'scale the deployment', document_id: 'doc-2', document: { id: 'doc-2', name: 'wiki/cpu.md' } } }] }))
        return
      }
      if (req.url?.startsWith('/v1/datasets/ds/documents/doc-2/segments')) {
        res.end(JSON.stringify({ data: [{ content: 'full cpu doc' }] }))
        return
      }
      if (req.url === '/search') {
        assert.match(body, /"top_k":2/)
        res.end(JSON.stringify({ hits: [{ doc_id: 'g1', title: 'generic', snippet: 'snippet', source: 'wiki/generic.md', score: 0.4 }] }))
        return
      }
      res.statusCode = 404
      res.end('{}')
    })
  })
  const base = await listen(server)
  try {
    const ragflow = new HttpKnowledgeProvider({ kind: 'ragflow', baseUrl: base, apiKey: 'k', datasetId: 'ds', fetchImpl: fetch })
    const hits = await ragflow.search('postgres', 2, 'alice')
    assert.equal(hits[0]?.docId, 'doc-1')
    assert.equal(hits[0]?.source, 'wiki/checkout.md')
    assert.equal(hits[0]?.score, 0.88)
    const doc = await ragflow.getDocument('doc-1', 'alice')
    assert.equal(doc.content, 'full postgres runbook')
    assert.equal(doc.source, 'wiki/checkout.md')

    const dify = new HttpKnowledgeProvider({ kind: 'dify', baseUrl: base, datasetId: 'ds', fetchImpl: fetch })
    const difyHits = await dify.search('cpu', 1, 'bob')
    assert.equal(difyHits[0]?.title, 'wiki/cpu.md')
    assert.equal(difyHits[0]?.score, 0.71)
    assert.equal((await dify.getDocument('doc-2', 'bob')).content, 'full cpu doc')

    const generic = new HttpKnowledgeProvider({ kind: 'generic', baseUrl: base, fetchImpl: fetch })
    assert.equal((await generic.search('q', 2, 'alice'))[0]?.docId, 'g1')
    assert.ok(seen.some((line) => line.includes('alice')))
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})
