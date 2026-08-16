import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SecureStorageService } from '../../src/services/secureStorageService.ts'
import { KnowledgeStore } from '../../src/services/knowledge/knowledgeStore.ts'
import { EMBEDDING_KEY_PROVIDER } from '../../src/services/knowledge/embeddingClient.ts'
import { ingestDocument, rebuildIndex } from '../../src/services/knowledge/ingestPipeline.ts'

/** 内联 Node fsProvider（同 IFileSystemProvider 形状；deleteFile 支持删目录） */
function makeEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kbrebuild-'))
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

/** mock 全局 fetch：按请求的 dimensions 生成对应长度伪向量（首维 = 批内序号），记录每次调用 */
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
        data: body.input.map((_text: string, i: number) => ({
          embedding: Array.from({ length: body.dimensions }, (_, j) => (j === 0 ? i : 0)),
          index: i,
        })),
      }),
      text: async () => '',
    } as Response
  }
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

const DISTILLED = '排错经验：维度不一致时不要删库，用 rebuild_knowledge_index 重建即可。'

/** 换全局 embedding 配置（模拟用户换模型/维度） */
async function switchEmbedding(store: KnowledgeStore, model: string, dimensions: number) {
  const config = await store.getGlobalConfig()
  config.embedding.model = model
  config.embedding.dimensions = dimensions
  await store.saveGlobalConfig(config)
}

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

test('重建索引：换模型/维度后快照更新、全部子块带新维度向量、chunk id 稳定、正本不改写', async () => {
  const { home, store, cleanup } = makeEnv()
  await store.createKnowledgeBase('kb1')
  const note = await ingestDocument('kb1', 'C:\\notes\\react.md', NOTE_MD, 'note')
  const distilled = await ingestDocument('kb1', 'distilled:排错经验', DISTILLED, 'distilled')

  // 重建前的索引快照与 chunk id、正本原文（用于事后比对）
  const before = (await store.readIndex('kb1'))!
  const idsBefore = before.chunks.map(c => c.id).sort()
  const docPath = (docId: string) => path.join(home, '.chill', 'knowledge', 'kb1', 'docs', `${docId}.md`)
  const rawBefore = new Map([
    [note.docId, fs.readFileSync(docPath(note.docId), 'utf-8')],
    [distilled.docId, fs.readFileSync(docPath(distilled.docId), 'utf-8')],
  ])

  // 换 embedding 模型/维度后重建
  await switchEmbedding(store, 'text-embedding-v3', 8)
  const callsBefore = calls.length
  const result = await rebuildIndex('kb1')
  assert.equal(result.docCount, 2)
  assert.equal(result.chunkCount, before.chunks.length, '正本未变，重建前后切块数一致')
  assert.ok(result.childCount > 0)
  assert.ok(calls.length > callsBefore, '重建应发出新的 embedding 请求')
  assert.ok(calls.slice(callsBefore).every(c => c.body.model === 'text-embedding-v3' && c.body.dimensions === 8))

  // 索引快照对齐新配置；子块全部带新维度向量，父块不嵌向量
  const after = (await store.readIndex('kb1'))!
  assert.equal(after.embeddingModel, 'text-embedding-v3')
  assert.equal(after.embeddingDimensions, 8)
  assert.equal(after.chunks.length, result.chunkCount)
  const parents = after.chunks.filter(c => !c.parentId && c.docId !== distilled.docId)
  const children = after.chunks.filter(c => c.parentId)
  assert.ok(children.length > 0 && children.every(c => c.embedding?.length === 8), '子块均为新维度向量')
  assert.ok(parents.every(c => c.embedding === undefined), '父块不嵌向量')
  assert.deepEqual(after.chunks.map(c => c.id).sort(), idsBefore, 'chunk id 由 docId 前缀派生，重建后稳定')

  // 正本只读不写
  for (const [docId, raw] of rawBefore) {
    assert.equal(fs.readFileSync(docPath(docId), 'utf-8'), raw, `正本不应被改写: ${docId}`)
  }
  cleanup()
})

test('沉淀型文档（无外部来源，正本只在 docs/）可重建', async () => {
  const { store, cleanup } = makeEnv()
  await store.createKnowledgeBase('kb1')
  const distilled = await ingestDocument('kb1', 'distilled:只存在于库内', DISTILLED, 'distilled')

  await switchEmbedding(store, 'text-embedding-v3', 8)
  const result = await rebuildIndex('kb1')
  assert.equal(result.docCount, 1)
  assert.equal(result.chunkCount, 1)
  assert.equal(result.childCount, 1)

  const chunks = (await store.readIndex('kb1'))!.chunks
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].id, `${distilled.docId}-c0`, '沉淀单块 id 与摄入时一致')
  assert.equal(chunks[0].text, DISTILLED.trim())
  assert.equal(chunks[0].embedding?.length, 8, '沉淀块已按新维度重新嵌向量')
  cleanup()
})

test('embedding 失败：重建抛错且旧 index.json 原样保留', async () => {
  const { home, store, cleanup } = makeEnv()
  await store.createKnowledgeBase('kb1')
  await ingestDocument('kb1', 'a.md', NOTE_MD, 'note')
  const indexPath = path.join(home, '.chill', 'knowledge', 'kb1', 'index.json')
  const rawBefore = fs.readFileSync(indexPath, 'utf-8')

  await switchEmbedding(store, 'text-embedding-v3', 8)
  // 换失败版 fetch（用例内自行恢复，不影响 beforeEach/afterEach 的 mock 链条）
  const g = globalThis as any
  const okFetch = g.fetch
  g.fetch = async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => 'Internal Server Error' } as Response)
  try {
    await assert.rejects(() => rebuildIndex('kb1'), /HTTP 500/)
  } finally {
    g.fetch = okFetch
  }

  assert.equal(fs.readFileSync(indexPath, 'utf-8'), rawBefore, '失败后旧 index.json 不应被破坏')
  const index = (await store.readIndex('kb1'))!
  assert.equal(index.embeddingModel, 'text-embedding-v4', '快照仍是旧模型')
  cleanup()
})

test('维度不一致的错误文案指引 rebuild_knowledge_index（不再有删库指引）', async () => {
  const { store, cleanup } = makeEnv()
  await store.createKnowledgeBase('kb1')
  await ingestDocument('kb1', 'a.md', NOTE_MD, 'note')

  await switchEmbedding(store, 'text-embedding-v3', 8)
  await assert.rejects(
    () => ingestDocument('kb1', 'b.md', '# 新\n\n另一些内容。', 'note'),
    (e: Error) => {
      assert.match(e.message, /rebuild_knowledge_index/)
      assert.match(e.message, /设置-知识库页签/)
      assert.ok(!e.message.includes('删除该知识库'), '不应再指引删库重建')
      return true
    }
  )
  cleanup()
})

test('异常路径：库不存在 / 正本损坏时不留半截索引', async () => {
  const { home, store, cleanup } = makeEnv()
  await assert.rejects(() => rebuildIndex('不存在'), /未找到知识库/)

  await store.createKnowledgeBase('kb1')
  await ingestDocument('kb1', 'a.md', NOTE_MD, 'note')
  const indexPath = path.join(home, '.chill', 'knowledge', 'kb1', 'index.json')
  const rawBefore = fs.readFileSync(indexPath, 'utf-8')

  // 人为损坏一篇正本（frontmatter 破坏后 readDoc 返回 null）
  const [docId] = await store.listDocs('kb1')
  fs.writeFileSync(path.join(home, '.chill', 'knowledge', 'kb1', 'docs', `${docId}.md`), '没有 frontmatter 的损坏内容', 'utf-8')
  await assert.rejects(() => rebuildIndex('kb1'), /正本缺失或损坏/)
  assert.equal(fs.readFileSync(indexPath, 'utf-8'), rawBefore, '正本损坏时旧索引不动')
  cleanup()
})
