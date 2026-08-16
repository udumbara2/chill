import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SecureStorageService } from '../../src/services/secureStorageService.ts'
import { KnowledgeStore } from '../../src/services/knowledge/knowledgeStore.ts'
import { EMBEDDING_KEY_PROVIDER } from '../../src/services/knowledge/embeddingClient.ts'
import { DEFAULT_KNOWLEDGE_CONFIG } from '../../src/services/knowledge/types.ts'
import {
  docIdForSource,
  extractPdfText,
  ingestDocument,
  ingestPdf,
  removeDocument,
} from '../../src/services/knowledge/ingestPipeline.ts'

const DIM = 4 // 测试伪向量维度（与全局配置的 dimensions 无关，只用于辨识）

/** 内联 Node fsProvider（同 IFileSystemProvider 形状；deleteFile 支持删目录） */
function makeEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kbingest-'))
  const fsProvider = {
    readFile: async (p: string) => {
      try { return { success: true, data: { content: fs.readFileSync(p, 'utf-8') } } } catch { return { success: false } }
    },
    writeFile: async (p: string, content: string) => {
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, content, 'utf-8')
      return { success: true }
    },
    deleteFile: async (p: string) => { try { fs.rmSync(p, { recursive: true, force: true }); return { success: true } } catch { return { success: false } } },
    listDirectory: async (p: string) => {
      try {
        const files = fs.readdirSync(p, { withFileTypes: true }).map(e => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' }))
        return { success: true, data: { files } }
      } catch { return { success: false } }
    },
    getCurrentDirectory: () => null,
    fileExists: async (p: string) => ({ success: fs.existsSync(p) }),
    getPathType: async (p: string) => ({ success: true, data: fs.existsSync(p) ? (fs.statSync(p).isDirectory() ? 'directory' : 'file') : null }),
  }
  const store = KnowledgeStore.getInstance()
  store.init(fsProvider as any, { getUserDataPath: () => path.join(home, '.chill'), getUserHomePath: () => home } as any)
  return { home, store, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) }
}

/** 内存版 ISecureStorage（同接口形状） */
function makeSecureStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    storeApiKey: async (provider: string, apiKey: string) => { map.set(provider, apiKey); return true },
    getApiKey: async (provider: string) => map.get(provider) ?? null,
    hasApiKey: async (provider: string) => map.has(provider),
    deleteApiKey: async (provider: string) => map.delete(provider),
    getAllProviders: async () => [...map.keys()],
  }
}

interface FetchCall { url: string; body: { model: string; input: string[]; dimensions: number } }

/** mock 全局 fetch：按 input 生成可辨识伪向量（首维 = 批内序号），记录每次调用 */
function mockFetch(calls: FetchCall[]) {
  const g = globalThis as any
  g.__origFetch = g.fetch
  g.fetch = async (url: string, init: any) => {
    const body = JSON.parse(init.body)
    calls.push({ url, body })
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: body.input.map((text: string, i: number) => ({
          embedding: [i, text.length, i + 0.1, 0],
          index: i,
        })),
      }),
      text: async () => '',
    } as Response
  }
}

/** 构造最小 hello-world PDF（单页 Helvetica 文本，xref 偏移现场计算保证合法） */
function buildHelloPdf(text: string): Uint8Array {
  const enc = new TextEncoder()
  const content = `BT /F1 24 Tf 100 700 Td (${text}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ]
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = [0]
  objects.forEach((body, i) => {
    offsets.push(enc.encode(pdf).length)
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xrefStart = enc.encode(pdf).length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (let i = 1; i <= objects.length; i++) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`
  return enc.encode(pdf)
}

const NOTE_MD = [
  '# React 笔记',
  '',
  '## Hooks',
  '',
  'useEffect 在依赖变化时执行副作用，返回函数用于清理。',
  '',
  '## 状态管理',
  '',
  'useState 返回状态与更新函数，更新触发重渲染。',
].join('\n')

let calls: FetchCall[]

beforeEach(() => {
  calls = []
  mockFetch(calls)
  SecureStorageService.initialize(makeSecureStorage({ [EMBEDDING_KEY_PROVIDER]: 'sk-test' }) as any)
})

afterEach(() => {
  const g = globalThis as any
  if (g.__origFetch) { g.fetch = g.__origFetch; delete g.__origFetch }
})

test('md 摄入全流程：doc 正本 + 索引父子块 + 子块带向量与标题路径', async () => {
  const { store, cleanup } = makeEnv()
  await store.createKnowledgeBase('kb1')

  const result = await ingestDocument('kb1', 'C:\\notes\\react.md', NOTE_MD, 'note')
  assert.equal(result.status, 'ingested')
  assert.equal(result.docId, await docIdForSource('C:\\notes\\react.md'))
  assert.ok(result.chunkCount > 0 && result.childCount > 0)
  assert.equal(calls.length, 1, '子块不多，一次批量 embedding 请求即可')
  assert.equal(calls[0].body.input.length, result.childCount, 'embedding 条数 = 子块数')

  // doc 正本：frontmatter 含来源/类型/hash，body 为原文
  const doc = await store.readDoc('kb1', result.docId)
  assert.equal(doc?.frontmatter.sourcePath, 'C:\\notes\\react.md')
  assert.equal(doc?.frontmatter.type, 'note')
  assert.ok(doc?.frontmatter.contentHash)
  assert.equal(doc?.body, NOTE_MD.trim())

  // 索引：快照对齐全局配置；父块无向量，子块带 parentId + 向量 + headingPath
  const index = await store.readIndex('kb1')
  assert.equal(index?.embeddingModel, DEFAULT_KNOWLEDGE_CONFIG.embedding.model)
  assert.equal(index?.embeddingDimensions, DEFAULT_KNOWLEDGE_CONFIG.embedding.dimensions)
  assert.equal(index?.chunks.length, result.chunkCount)
  const parents = index!.chunks.filter(c => !c.parentId)
  const children = index!.chunks.filter(c => c.parentId)
  assert.ok(parents.length > 0 && children.length > 0, 'md 切块应产生父子块')
  assert.ok(parents.every(c => c.embedding === undefined), '父块不嵌向量')
  assert.ok(children.every(c => Array.isArray(c.embedding) && c.embedding.length === DIM), '子块均有向量')
  assert.ok(children.some(c => c.headingPath === 'React 笔记 > Hooks'), '子块带标题路径')
  assert.ok(children.every(c => parents.some(p => p.id === c.parentId)), '子块 parentId 均能指到父块')

  // embedding 请求文本带标题路径前缀（穷人版 Contextual Retrieval）
  assert.ok(calls[0].body.input.some(t => t.startsWith('React 笔记 > Hooks\n')))
  cleanup()
})

test('hash 未变跳过：不发 embedding 请求，返回 skipped', async () => {
  const { store, cleanup } = makeEnv()
  await store.createKnowledgeBase('kb1')

  const first = await ingestDocument('kb1', 'a.md', NOTE_MD, 'note')
  assert.equal(first.status, 'ingested')
  assert.equal(calls.length, 1)

  const again = await ingestDocument('kb1', 'a.md', NOTE_MD, 'note')
  assert.equal(again.status, 'skipped')
  assert.equal(again.docId, first.docId)
  assert.equal(calls.length, 1, '内容未变不应再请求 embedding')
  const index = await store.readIndex('kb1')
  assert.equal(index?.chunks.length, first.chunkCount, '索引保持不变')
  cleanup()
})

test('重复摄入幂等：内容变化后重切重嵌，旧记录先剔除、chunk id 稳定', async () => {
  const { store, cleanup } = makeEnv()
  await store.createKnowledgeBase('kb1')

  const v1 = await ingestDocument('kb1', 'a.md', '# 标题\n\n第一版内容。', 'note')
  const ids1 = (await store.readIndex('kb1'))!.chunks.map(c => c.id).sort()

  // 同内容再来一次（skipped），索引应与首次一致
  await ingestDocument('kb1', 'a.md', '# 标题\n\n第一版内容。', 'note')
  assert.deepEqual((await store.readIndex('kb1'))!.chunks.map(c => c.id).sort(), ids1)

  // 内容变化：旧记录剔除、新记录写入，doc 仍只有一篇
  const v2 = await ingestDocument('kb1', 'a.md', '# 标题\n\n第二版内容，加长了不少。', 'note')
  assert.equal(v2.status, 'ingested')
  assert.equal(v2.docId, v1.docId)
  const index = await store.readIndex('kb1')
  assert.equal(index!.chunks.filter(c => c.docId === v1.docId).length, v2.chunkCount)
  assert.ok(index!.chunks.every(c => c.text.includes('第二版')), '旧切块应被剔除')
  assert.deepEqual(await store.listDocs('kb1'), [v1.docId])
  const doc = await store.readDoc('kb1', v1.docId)
  assert.equal(doc?.frontmatter.createdAt, (await store.readDoc('kb1', v1.docId))?.frontmatter.createdAt)
  cleanup()
})

test('removeDocument 级联清理：删 doc 正本 + 剔除索引记录，不影响其他文档', async () => {
  const { store, cleanup } = makeEnv()
  await store.createKnowledgeBase('kb1')

  const r1 = await ingestDocument('kb1', 'a.md', '# 甲\n\n甲文档内容。', 'note')
  const r2 = await ingestDocument('kb1', 'b.md', '# 乙\n\n乙文档内容。', 'note')
  const total = (await store.readIndex('kb1'))!.chunks.length
  assert.equal(total, r1.chunkCount + r2.chunkCount)

  const removed = await removeDocument('kb1', r1.docId)
  assert.equal(removed.success, true)
  assert.equal(removed.removedChunks, r1.chunkCount)
  assert.equal(await store.readDoc('kb1', r1.docId), null, 'doc 正本应被删除')
  const index = await store.readIndex('kb1')
  assert.equal(index!.chunks.length, r2.chunkCount, '索引只剩另一篇文档的记录')
  assert.ok(index!.chunks.every(c => c.docId === r2.docId))

  const again = await removeDocument('kb1', r1.docId)
  assert.equal(again.success, false, '重复删除应报错')
  assert.match(again.error!, /未找到文档/)
  cleanup()
})

test('PDF 摄入：pdfjs 抽取最小 PDF 文本后走同一管线', async () => {
  const { store, cleanup } = makeEnv()
  await store.createKnowledgeBase('kb1')

  const buffer = buildHelloPdf('Hello World')
  assert.match(await extractPdfText(buffer), /Hello World/, '抽取应拿到正文')

  const result = await ingestPdf('kb1', buffer, 'C:\\docs\\hello.pdf')
  assert.equal(result.status, 'ingested')
  const doc = await store.readDoc('kb1', result.docId)
  assert.equal(doc?.frontmatter.type, 'pdf')
  assert.match(doc!.body, /Hello World/)
  const index = await store.readIndex('kb1')
  assert.ok(index!.chunks.some(c => c.text.includes('Hello World') && c.embedding), 'PDF 文本切块已嵌向量')
  cleanup()
})

test('embedding 快照不一致：抛出带中文重建指引的错误', async () => {
  const { store, cleanup } = makeEnv()
  await store.createKnowledgeBase('kb1')
  await ingestDocument('kb1', 'a.md', '# 标题\n\n一些内容。', 'note')

  // 换 embedding 模型，触发快照不一致
  const config = await store.getGlobalConfig()
  config.embedding.model = 'text-embedding-v3'
  await store.saveGlobalConfig(config)

  await assert.rejects(
    () => ingestDocument('kb1', 'b.md', '# 新\n\n另一些内容。', 'note'),
    (e: Error) => {
      assert.match(e.message, /不一致/)
      assert.match(e.message, /重建/)
      return true
    }
  )
  await assert.rejects(() => ingestPdf('kb1', buildHelloPdf('Hi'), 'x.pdf'), /重建/)
  cleanup()
})

test('异常路径：库不存在 / 内容为空 / key 未配置', async () => {
  const { store, cleanup } = makeEnv()
  await assert.rejects(() => ingestDocument('不存在', 'a.md', '# 内容', 'note'), /未找到知识库/)

  await store.createKnowledgeBase('kb1')
  await assert.rejects(() => ingestDocument('kb1', 'a.md', '   ', 'note'), /内容为空/)

  SecureStorageService.initialize(makeSecureStorage() as any)
  await assert.rejects(() => ingestDocument('kb1', 'a.md', '# 标题\n\n内容。', 'note'), /API key 未配置/)
  assert.equal(await store.readIndex('kb1'), null, '失败后不应写入索引')
  cleanup()
})

test('沉淀知识：单块不切分，直接嵌向量且无父块', async () => {
  const { store, cleanup } = makeEnv()
  await store.createKnowledgeBase('kb1')

  const longText = '这是一条很长的沉淀知识。'.repeat(50) // 超过默认 childChunkSize 也不切
  const result = await ingestDocument('kb1', 'session:42#fact:1', longText, 'distilled')
  assert.equal(result.chunkCount, 1)
  assert.equal(result.childCount, 1)
  const chunks = (await store.readIndex('kb1'))!.chunks
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].parentId, undefined)
  assert.equal(chunks[0].text, longText.trim())
  assert.ok(Array.isArray(chunks[0].embedding))
  cleanup()
})
