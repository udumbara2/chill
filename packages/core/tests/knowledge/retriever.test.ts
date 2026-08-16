import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SecureStorageService } from '../../src/services/secureStorageService.ts'
import { EMBEDDING_KEY_PROVIDER } from '../../src/services/knowledge/embeddingClient.ts'
import { KnowledgeStore, emptyKnowledgeIndex } from '../../src/services/knowledge/knowledgeStore.ts'
import { searchKnowledge } from '../../src/services/knowledge/retriever.ts'
import type { ChunkRecord } from '../../src/services/knowledge/types.ts'

/** 内联 Node fsProvider（同 knowledgeStore.test.ts 的形状） */
function makeEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kbret-'))
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

/** 内存版 ISecureStorage */
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

interface FetchRecord { url: string; body: any; auth: string }

interface MockOptions {
  queryVector?: number[]
  rerankStatus?: number
  rerankResults?: Array<{ index: number; relevance_score: number }>
  rerankThrows?: boolean
}

/** mock 全局 fetch：按 URL 分发 embedding / rerank；rerank 默认按原顺序给递减分 */
function mockFetch(records: FetchRecord[], opts: MockOptions = {}) {
  const g = globalThis as any
  g.__origFetch = g.fetch
  g.fetch = async (url: string, init: any) => {
    const body = JSON.parse(init.body)
    records.push({ url, body, auth: init.headers.Authorization })
    const respond = (status: number, payload: unknown) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => (typeof payload === 'string' ? JSON.parse(payload) : payload),
      text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
    }) as Response
    if (url.includes('/embeddings')) {
      return respond(200, { data: body.input.map((_: string, i: number) => ({ embedding: opts.queryVector ?? [1, 0, 0], index: i })) })
    }
    if (opts.rerankThrows) throw new Error('network down')
    const status = opts.rerankStatus ?? 200
    const payload = status === 200
      ? { output: { results: opts.rerankResults ?? body.input.documents.map((_: string, i: number) => ({ index: i, relevance_score: 0.9 - i * 0.1 })) } }
      : 'Internal Error'
    return respond(status, payload)
  }
}

/** 初始化 store + 全局配置（小维度方便手算余弦；rerank 默认关，逐测开启） */
async function setup(opts: { dims?: number; rerank?: boolean; threshold?: number; topK?: number } = {}) {
  const env = makeEnv()
  const config = await env.store.getGlobalConfig()
  config.embedding.dimensions = opts.dims ?? 3
  config.rerank.enabled = opts.rerank ?? false
  if (opts.threshold !== undefined) config.retrieval.similarityThreshold = opts.threshold
  if (opts.topK !== undefined) config.retrieval.topK = opts.topK
  await env.store.saveGlobalConfig(config)
  return env
}

const parent = (id: string, docId: string, text: string, charStart: number): ChunkRecord =>
  ({ id, docId, charStart, charEnd: charStart + text.length, text })

const child = (id: string, docId: string, parentId: string, text: string, embedding: number[], headingPath?: string): ChunkRecord =>
  ({ id, docId, parentId, headingPath, charStart: 0, charEnd: text.length, text, embedding })

/** 建库并写入索引（快照取自当前全局配置，默认与配置一致） */
async function seed(store: KnowledgeStore, kb: string, chunks: ChunkRecord[]) {
  await store.createKnowledgeBase(kb)
  const index = emptyKnowledgeIndex(await store.getGlobalConfig())
  index.chunks.push(...chunks)
  await store.saveIndex(kb, index)
}

beforeEach(() => {
  SecureStorageService.initialize(makeSecureStorage({ [EMBEDDING_KEY_PROVIDER]: 'sk-test' }) as any)
})

afterEach(() => {
  const g = globalThis as any
  if (g.__origFetch) { g.fetch = g.__origFetch; delete g.__origFetch }
})

test('基本检索：命中子块返回父块文本，相邻同 doc 父块窗口去重', async () => {
  const { store, cleanup } = await setup()
  const records: FetchRecord[] = []
  mockFetch(records, { queryVector: [1, 0, 0] })
  await seed(store, 'notes', [
    parent('p0', 'doc1', '父块零', 0),
    parent('p1', 'doc1', '父块一', 100),
    parent('p2', 'doc1', '父块二', 200),
    child('c0', 'doc1', 'p0', '子块零', [1, 0, 0]),
    child('c1', 'doc1', 'p1', '子块一', [0.9, 0.1, 0], 'React > Hooks'),
    child('c2', 'doc1', 'p2', '子块二', [0, 1, 0]), // 余弦 0，被默认阈值 0.5 过滤
  ])

  const results = await searchKnowledge('查询')
  // 命中 c0/c1：c0 → p0（窗口带 p1）；c1 → p1（窗口 p0/p1 已出，只补 p2）
  assert.deepEqual(results.map(r => r.content), ['父块零', '父块一', '父块二'])
  assert.equal(results.filter(r => r.content === '父块一').length, 1, '重叠窗口应去重')
  assert.ok(Math.abs(results[0].score - 1) < 1e-9, '未 rerank 时分数为余弦分')
  assert.equal(results[1].docId, 'doc1')
  assert.equal(results[2].headingPath, 'React > Hooks', '父块无标题路径时落回命中子块的')
  assert.ok(results.every(r => r.kb === 'notes'))

  // 查询向量化恰好 1 次 API 调用
  const embedCalls = records.filter(r => r.url.includes('/embeddings'))
  assert.equal(embedCalls.length, 1)
  assert.deepEqual(embedCalls[0].body.input, ['查询'])
  assert.equal(records.some(r => r.url.includes('/services/rerank/')), false, 'rerank 关时不应发 rerank 请求')
  cleanup()
})

test('阈值过滤：作用于余弦分，0.5 滤掉正交结果，调低到 0 放行', async () => {
  const chunks = [
    parent('pa', 'docA', '父块A', 0),
    parent('pb', 'docB', '父块B', 0),
    child('ca', 'docA', 'pa', '子块A', [1, 0, 0]),
    child('cb', 'docB', 'pb', '子块B', [0, 1, 0]),
  ]
  const records: FetchRecord[] = []
  mockFetch(records, { queryVector: [1, 0, 0] })

  const strict = await setup()
  await seed(strict.store, 'kb', chunks)
  const filtered = await searchKnowledge('查询')
  assert.deepEqual(filtered.map(r => r.content), ['父块A'], '余弦 0 低于默认阈值 0.5，应被过滤')
  strict.cleanup()

  const loose = await setup({ threshold: 0 })
  await seed(loose.store, 'kb', chunks)
  const all = await searchKnowledge('查询')
  assert.deepEqual(all.map(r => r.content), ['父块A', '父块B'], '阈值 0 时余弦 0 也放行')
  loose.cleanup()
})

test('rerank 开：按 relevance_score 重排并换分，请求符合 DashScope 协议', async () => {
  const { store, cleanup } = await setup({ rerank: true })
  const records: FetchRecord[] = []
  mockFetch(records, {
    queryVector: [1, 0, 0],
    // 故意颠倒：向量路 A 在前，rerank 把 B 排前
    rerankResults: [{ index: 1, relevance_score: 0.99 }, { index: 0, relevance_score: 0.05 }],
  })
  await seed(store, 'kb', [
    parent('pa', 'docA', '父块A', 0),
    parent('pb', 'docB', '父块B', 0),
    child('ca', 'docA', 'pa', '子块A', [1, 0, 0]),
    child('cb', 'docB', 'pb', '子块B', [0.9, 0.1, 0]),
  ])

  const results = await searchKnowledge('查询')
  assert.deepEqual(results.map(r => r.content), ['父块B', '父块A'], '最终顺序应服从 rerank')
  assert.deepEqual(results.map(r => r.score), [0.99, 0.05], '分数应换为 relevance_score')

  const rerankCall = records.find(r => r.url.includes('/services/rerank/'))!
  assert.equal(rerankCall.url, 'https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank')
  assert.equal(rerankCall.auth, 'Bearer sk-test', '复用 embedding 的 key')
  assert.equal(rerankCall.body.model, 'gte-rerank-v2')
  assert.equal(rerankCall.body.input.query, '查询')
  assert.deepEqual(rerankCall.body.input.documents, ['子块A', '子块B'])
  cleanup()
})

test('rerank 失败降级：HTTP 500 与网络异常都落回 RRF 顺序，不抛错', async () => {
  const seedChunks = [
    parent('pa', 'docA', '父块A', 0),
    parent('pb', 'docB', '父块B', 0),
    child('ca', 'docA', 'pa', '子块A', [1, 0, 0]),
    child('cb', 'docB', 'pb', '子块B', [0.9, 0.1, 0]),
  ]
  for (const opts of [{ rerankStatus: 500 }, { rerankThrows: true }]) {
    const { store, cleanup } = await setup({ rerank: true })
    const records: FetchRecord[] = []
    mockFetch(records, { queryVector: [1, 0, 0], ...opts })
    await seed(store, 'kb', seedChunks)
    const results = await searchKnowledge('查询')
    assert.deepEqual(results.map(r => r.content), ['父块A', '父块B'], 'rerank 失败应保持向量/RRF 顺序')
    assert.ok(Math.abs(results[0].score - 1) < 1e-9, '降级后分数落回余弦分')
    cleanup()
  }
})

test('跨库检索：省略 kbName 搜全部库并带来源；指定库只搜该库；库不存在报错', async () => {
  const { store, cleanup } = await setup()
  const records: FetchRecord[] = []
  mockFetch(records, { queryVector: [1, 0, 0] })
  await seed(store, 'kb1', [
    parent('pa', 'docA', '库一的父块', 0),
    child('ca', 'docA', 'pa', '子块A', [1, 0, 0]),
  ])
  await seed(store, 'kb2', [
    parent('pb', 'docB', '库二的父块', 0),
    child('cb', 'docB', 'pb', '子块B', [0.95, 0.05, 0]),
  ])

  const all = await searchKnowledge('查询')
  assert.deepEqual(all.map(r => r.kb), ['kb1', 'kb2'], '两库结果按分数排序合并返回')

  const only2 = await searchKnowledge('查询', 'kb2')
  assert.deepEqual(only2.map(r => r.kb), ['kb2'])

  await assert.rejects(() => searchKnowledge('查询', '不存在'), /未找到知识库/)
  cleanup()
})

test('维度/模型不一致：抛带重建指引的中文错误，且不发任何 API 请求', async () => {
  const { store, cleanup } = await setup()
  const records: FetchRecord[] = []
  mockFetch(records, { queryVector: [1, 0, 0] })
  await seed(store, 'kb1', [
    parent('pa', 'docA', '父块A', 0),
    child('ca', 'docA', 'pa', '子块A', [1, 0, 0]),
  ])
  // 篡改索引快照，模拟建库后换了 embedding 模型
  const index = (await store.readIndex('kb1'))!
  index.embeddingModel = 'old-model'
  await store.saveIndex('kb1', index)

  await assert.rejects(
    () => searchKnowledge('查询', 'kb1'),
    (e: Error) => {
      assert.match(e.message, /kb1/)
      assert.match(e.message, /重建/, '错误应含重建指引')
      return true
    }
  )
  assert.equal(records.length, 0, '快照比对应在查询向量化之前拦截')
  cleanup()
})

test('边界：空查询返回空；无索引的库返回空且不调 API', async () => {
  const { store, cleanup } = await setup()
  const records: FetchRecord[] = []
  mockFetch(records)
  await store.createKnowledgeBase('empty')

  assert.deepEqual(await searchKnowledge('   '), [])
  assert.deepEqual(await searchKnowledge('查询', 'empty'), [])
  assert.equal(records.length, 0, '无候选时不应发 embedding 请求')
  cleanup()
})
