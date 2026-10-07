import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeRecursive } from '../helpers/recursiveDelete.ts'
import { SecureStorageService } from '../../src/services/secureStorageService.ts'
import { EMBEDDING_KEY_PROVIDER } from '../../src/services/knowledge/embeddingClient.ts'
import { ModelServiceFactory } from '../../src/services/models/modelServiceFactory.ts'
import { SelectedModelsService } from '../../src/services/selectedModelsService.ts'
import {
  KnowledgeStore,
  computeEnhancementsFingerprint,
  emptyKnowledgeIndex,
} from '../../src/services/knowledge/knowledgeStore.ts'
import { processDocument } from '../../src/services/knowledge/ingestPipeline.ts'
import { resolveActiveEnrichers, runEnrichers, DEFAULT_ENRICHERS } from '../../src/services/knowledge/enrich.ts'
import { summaryEnricher } from '../../src/services/knowledge/summaryEnricher.ts'
import {
  defaultRecallSources,
  runRecallSources,
  searchKnowledge,
  summaryRecallSource,
  SUMMARY_RECALL_WEIGHT,
  type Candidate,
} from '../../src/services/knowledge/retriever.ts'
import { rrfFuse } from '../../src/services/knowledge/vectorSearch.ts'
import { resolveChunkKind, type ChunkRecord } from '../../src/services/knowledge/types.ts'

/** 内联 Node fsProvider（同 knowledgeStore.test.ts 的形状） */
function makeEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kbsum-'))
  const fsProvider = {
    readFile: async (p: string) => {
      try { return { success: true, data: { content: fs.readFileSync(p, 'utf-8') } } } catch { return { success: false } }
    },
    writeFile: async (p: string, content: string) => {
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, content, 'utf-8')
      return { success: true }
    },
    deleteFile: async (p: string) => { try { removeRecursive(p); return { success: true } } catch { return { success: false } } },
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
  return { home, store, cleanup: () => removeRecursive(home) }
}

function makeSecureStorage(initial: Record<string, string>) {
  const map = new Map(Object.entries(initial))
  return {
    storeApiKey: async (provider: string, apiKey: string) => { map.set(provider, apiKey); return true },
    getApiKey: async (provider: string) => map.get(provider) ?? null,
    hasApiKey: async (provider: string) => map.has(provider),
    deleteApiKey: async (provider: string) => map.delete(provider),
    getAllProviders: async () => [...map.keys()],
  }
}

// ==================== mock LLM（ModelServiceFactory.sendChatMessage） ====================

let llmCalls: string[] = []
let llmBehavior: (userContent: string) => Promise<{ content: string }> = async () => ({ content: '这是 mock 摘要' })
let currentModel: string | null = 'test-model'
const origSendChatMessage = ModelServiceFactory.getInstance().sendChatMessage
const origGetCurrentModelName = SelectedModelsService.getInstance().getCurrentModelName

/** 安装 LLM mock：记录调用、按 llmBehavior 响应；currentModel 为 null 模拟未选模型 */
function installLlmMock() {
  llmCalls = []
  llmBehavior = async () => ({ content: '这是 mock 摘要' })
  currentModel = 'test-model'
  ModelServiceFactory.getInstance().sendChatMessage = async (_model: string, messages: any[]) => {
    const user = String(messages[messages.length - 1]?.content ?? '')
    llmCalls.push(user)
    return llmBehavior(user)
  }
  const sel = SelectedModelsService.getInstance()
  sel.getCurrentModelName = () => currentModel
}

afterEach(() => {
  ModelServiceFactory.getInstance().sendChatMessage = origSendChatMessage
  SelectedModelsService.getInstance().getCurrentModelName = origGetCurrentModelName
  const g = globalThis as any
  if (g.__origFetch) { g.fetch = g.__origFetch; delete g.__origFetch }
})

/** 建库并返回配置（summaryLayer 按参数开启） */
async function setupKb(summaryLayer: boolean) {
  const env = makeEnv()
  await env.store.createKnowledgeBase('kb1')
  const config = await env.store.getGlobalConfig()
  config.enhancements.summaryLayer = summaryLayer
  const kbConfig = (await env.store.getKnowledgeBaseConfig('kb1'))!
  return { ...env, config, kbConfig }
}

const NOTE_MD = [
  '# 笔记', '',
  '## 第一章', '',
  '第一章的内容。', '',
  '## 第二章', '',
  '第二章的内容。',
].join('\n')

// ==================== kind 兼容推断 ====================

test('resolveChunkKind：显式 kind 优先，缺省按 parentId 推断（兼容一期索引）', () => {
  const base = { id: 'x', docId: 'd', charStart: 0, charEnd: 1, text: 't' }
  assert.equal(resolveChunkKind({ ...base, parentId: 'p' }), 'child', '一期子块（无 kind 有 parentId）→ child')
  assert.equal(resolveChunkKind(base), 'parent', '一期父块/沉淀块（无 kind 无 parentId）→ parent')
  assert.equal(resolveChunkKind({ ...base, kind: 'summary' }), 'summary')
  assert.equal(resolveChunkKind({ ...base, kind: 'summary', parentId: 'p' }), 'summary', '章节摘要显式 kind 优先于 parentId 推断')
  assert.equal(resolveChunkKind({ ...base, kind: 'parent', parentId: 'p' }), 'parent', '显式 kind 覆盖推断')
})

// ==================== 摘要生成 ====================

test('摘要生成（note）：章节级指向父块 + 文档级无 parentId，摘要块进嵌向量目标', async () => {
  installLlmMock()
  const { config, kbConfig, cleanup } = await setupKb(true)
  const result = await processDocument(NOTE_MD, 'note', 'd1', config, kbConfig)

  const parents = result.records.filter(c => resolveChunkKind(c) === 'parent')
  const summaries = result.records.filter(c => c.kind === 'summary')
  assert.equal(summaries.length, parents.length + 1, '章节级（每父块一条）+ 文档级一条')
  assert.equal(llmCalls.length, parents.length + 1, '每条摘要一次 LLM 调用')

  const sectionSummaries = summaries.filter(s => s.parentId)
  const docSummaries = summaries.filter(s => !s.parentId)
  assert.equal(docSummaries.length, 1, '文档级摘要 parentId 为空')
  assert.equal(docSummaries[0].charStart, 0)
  assert.equal(docSummaries[0].charEnd, NOTE_MD.length, '文档级摘要覆盖全文区间')
  const parentIds = new Set(parents.map(p => p.id))
  for (const s of sectionSummaries) {
    assert.ok(parentIds.has(s.parentId!), `章节摘要 parentId 应指向父块: ${s.parentId}`)
    assert.ok(s.headingPath, '章节摘要带标题路径')
  }
  for (const s of summaries) {
    assert.equal(s.text, '这是 mock 摘要')
    assert.equal(s.docId, 'd1')
    assert.ok(s.id.startsWith('d1-s'), '摘要块 id 以 -s 序号派生')
  }
  assert.ok(summaries.every(s => result.children.includes(s)), '摘要块全部进嵌向量目标（含文档级）')
  assert.deepEqual(result.warnings, [])
  cleanup()
})

test('摘要生成（pdf）：父块级 + 全书级，无标题路径', async () => {
  installLlmMock()
  const { config, kbConfig, cleanup } = await setupKb(true)
  const pdfText = Array.from({ length: 60 }, (_, i) => `第${i}段的纯文本内容，模拟 PDF 抽取。`).join('\n\n')
  const result = await processDocument(pdfText, 'pdf', 'd2', config, kbConfig)

  const parents = result.records.filter(c => resolveChunkKind(c) === 'parent')
  const summaries = result.records.filter(c => c.kind === 'summary')
  assert.ok(parents.length >= 1)
  assert.equal(summaries.length, parents.length + 1)
  assert.ok(summaries.every(s => s.headingPath === undefined), 'pdf 摘要无标题路径')
  assert.equal(summaries.filter(s => !s.parentId).length, 1, '全书级摘要一条')
  cleanup()
})

test('摘要生成（distilled）：跳过增强，零 LLM 调用', async () => {
  installLlmMock()
  const { config, kbConfig, cleanup } = await setupKb(true)
  const result = await processDocument('一条沉淀知识。', 'distilled', 'd3', config, kbConfig)
  assert.equal(result.records.length, 1, '沉淀仍是一条单块')
  assert.equal(llmCalls.length, 0, 'distilled 不调 LLM')
  cleanup()
})

// ==================== 开关门控 ====================

test('开关关闭：零 LLM 调用、无摘要块（门控 + enricher 自检双保险）', async () => {
  installLlmMock()
  const { config, kbConfig, cleanup } = await setupKb(false)

  // 门控：resolveActiveEnrichers 不含摘要 enricher
  assert.deepEqual(resolveActiveEnrichers(config.enhancements), DEFAULT_ENRICHERS)
  const result = await processDocument(NOTE_MD, 'note', 'd1', config, kbConfig)
  assert.equal(llmCalls.length, 0, '开关关时 processDocument 零 LLM 调用')
  assert.ok(result.records.every(c => c.kind !== 'summary'))

  // 自检：直接把 summaryEnricher 塞进链里也不应调用（双保险）
  const outcome = await runEnrichers(
    { chunks: [], text: 't', docId: 'd', docType: 'note', enhancements: config.enhancements, config, kbConfig },
    [summaryEnricher]
  )
  assert.equal(llmCalls.length, 0, 'enricher 内部自检开关，仍零调用')
  assert.deepEqual(outcome.chunks, [])
  cleanup()
})

test('开关开启：resolveActiveEnrichers 追加摘要 enricher', async () => {
  const { config, cleanup } = await setupKb(true)
  const active = resolveActiveEnrichers(config.enhancements)
  assert.equal(active.length, DEFAULT_ENRICHERS.length + 1)
  assert.equal(active[active.length - 1].name, '摘要层')
  cleanup()
})

// ==================== 失败降级 ====================

test('失败降级：LLM 抛错/空响应/未选模型 → 告警 + 无摘要摄入，不阻塞', async () => {
  installLlmMock()
  const { config, kbConfig, cleanup } = await setupKb(true)
  // 无增强基线：同文档、开关关闭（与降级结果对比）
  const configOff = structuredClone(config)
  configOff.enhancements.summaryLayer = false
  const baseline = await processDocument(NOTE_MD, 'note', 'd1', configOff, kbConfig)

  // LLM 抛错
  llmBehavior = async () => { throw new Error('LLM 超时') }
  const failed = await processDocument(NOTE_MD, 'note', 'd1', config, kbConfig)
  assert.equal(failed.warnings.length, 1)
  assert.match(failed.warnings[0], /摘要层/)
  assert.match(failed.warnings[0], /LLM 超时/)
  assert.match(failed.warnings[0], /降级/)
  assert.deepEqual(failed.records, baseline.records, '降级后 records 与无增强一致')
  assert.deepEqual(failed.children, baseline.children)

  // 空响应
  llmBehavior = async () => ({ content: '   ' })
  const empty = await processDocument(NOTE_MD, 'note', 'd1', config, kbConfig)
  assert.equal(empty.warnings.length, 1)
  assert.match(empty.warnings[0], /空摘要/)

  // 未选模型
  currentModel = null
  const callsBefore = llmCalls.length
  const noModel = await processDocument(NOTE_MD, 'note', 'd1', config, kbConfig)
  assert.equal(noModel.warnings.length, 1)
  assert.match(noModel.warnings[0], /未选择聊天模型/)
  assert.equal(llmCalls.length, callsBefore, '未选模型时不发起调用')
  cleanup()
})

// ==================== 快照指纹 ====================

test('快照指纹：summaryLayer 开关翻转即变', async () => {
  const off = computeEnhancementsFingerprint({ summaryLayer: false, contextualPrefix: false })
  const on = computeEnhancementsFingerprint({ summaryLayer: true, contextualPrefix: false })
  assert.notEqual(off, on)
  const { store, cleanup } = await setupKb(false)
  const config = await store.getGlobalConfig()
  config.enhancements.summaryLayer = true
  const kbConfig = await store.getKnowledgeBaseConfig('kb1')
  assert.notEqual(
    emptyKnowledgeIndex(config, kbConfig).enhancementsFingerprint,
    emptyKnowledgeIndex(await store.getGlobalConfig(), kbConfig).enhancementsFingerprint,
    '索引指纹随 summaryLayer 生效配置变化'
  )
  cleanup()
})

// ==================== summary 召回路 ====================

const EMB = {
  child: [0, 1, 0],
  summary: [1, 0, 0],
}

function seedCandidates(): Candidate[] {
  // 与检索主流程一致：候选只含有向量的块（父块不嵌向量，不进候选）
  const child: ChunkRecord = { id: 'c0', docId: 'doc', parentId: 'p0', charStart: 0, charEnd: 50, text: '子块正文', embedding: EMB.child }
  const sectionSummary: ChunkRecord = { id: 's0', docId: 'doc', parentId: 'p0', kind: 'summary', charStart: 0, charEnd: 100, text: '章节摘要', embedding: EMB.summary }
  const docSummary: ChunkRecord = { id: 's1', docId: 'doc', kind: 'summary', charStart: 0, charEnd: 100, text: '全书摘要', embedding: EMB.summary }
  return [child, sectionSummary, docSummary].map(chunk => ({ kb: 'kb', chunk }))
}

test('summary 召回源：只排摘要块作提升路；主路（向量/BM25）不含摘要块', () => {
  const candidates = seedCandidates()
  const ctx = { query: 'q', queryVector: [1, 0, 0], candidates, candId: (c: Candidate) => `${c.kb}/${c.chunk.id}` }

  const two = runRecallSources(defaultRecallSources(), ctx)
  assert.deepEqual(Object.keys(two), ['vector', 'bm25'])
  assert.ok(two.vector.every(i => i.id !== 'kb/s0' && i.id !== 'kb/s1'), '向量路排除摘要块（避免三路重复计分）')

  const three = runRecallSources([...defaultRecallSources(), summaryRecallSource()], ctx)
  assert.deepEqual(three.summary.map(i => i.id), ['kb/s0', 'kb/s1'], '摘要提升路只含摘要块，按余弦降序')
})

test('RRF 摘要路：缺省退化为两路；权重 2 与主路双料第一同分且不反超', () => {
  const vector = [{ id: 'a', score: 0.9 }]
  const bm25 = [{ id: 'a', score: 3 }]
  const summary = [{ id: 'b', score: 0.8 }, { id: 'c', score: 0.7 }]

  const fusedTwo = rrfFuse(vector, bm25)
  assert.ok(fusedTwo.every(f => f.summaryScore === null), '不传摘要路时 summaryScore 为 null')
  assert.equal(fusedTwo.length, 1)

  // 默认权重 2：a 主路双料第一（2/61）与 b 摘要路第一（2/61）同分，a 先入列排前；c 第二名（2/62）居后
  const fused = rrfFuse(vector, bm25, 60, summary, SUMMARY_RECALL_WEIGHT)
  assert.equal(SUMMARY_RECALL_WEIGHT, 2, '默认权重设计为 2（与主路双料第一同分）')
  assert.deepEqual(fused.map(f => f.id), ['a', 'b', 'c'], '双料主路命中 > 摘要第一（同分先入列）> 摘要第二')
  assert.equal(fused.find(f => f.id === 'b')!.summaryScore, 0.8)

  // 权重可调：调到 3 后摘要路第一（3/61）反超双料第一（2/61）
  const fusedW3 = rrfFuse(vector, bm25, 60, summary, 3)
  assert.equal(fusedW3[0].id, 'b', '权重调高后摘要路排名影响力增大')
})

// ==================== 检索集成：摘要命中与退化 ====================

/** mock 全局 fetch：embedding 按文本内容定向（摘要→x 轴，子块→y 轴），rerank 关 */
function mockFetchForSummary() {
  const g = globalThis as any
  g.__origFetch = g.fetch
  g.fetch = async (url: string, init: any) => {
    const body = JSON.parse(init.body)
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: (body.input as string[]).map((text, i) => ({
          embedding: text.includes('摘要') || text.includes('概括') ? EMB.summary : EMB.child,
          index: i,
        })),
      }),
      text: async () => '',
    } as Response
  }
}

async function seedKb(store: KnowledgeStore, chunks: ChunkRecord[]) {
  await store.createKnowledgeBase('kb1')
  const index = emptyKnowledgeIndex(await store.getGlobalConfig())
  index.chunks.push(...chunks)
  await store.saveIndex('kb1', index)
}

test('检索：摘要命中返回"摘要 + 下钻指引"，不展开父块窗口', async () => {
  SecureStorageService.initialize(makeSecureStorage({ [EMBEDDING_KEY_PROVIDER]: 'sk-test' }) as any)
  const env = makeEnv()
  const config = await env.store.getGlobalConfig()
  config.embedding.dimensions = 3
  config.rerank.enabled = false
  config.retrieval.similarityThreshold = 0.5
  await env.store.saveGlobalConfig(config)

  const parent: ChunkRecord = { id: 'p0', docId: 'doc', headingPath: '第一章', charStart: 0, charEnd: 100, text: '父块正文内容' }
  const child: ChunkRecord = { id: 'c0', docId: 'doc', parentId: 'p0', charStart: 0, charEnd: 50, text: '子块正文内容', embedding: EMB.child }
  const docSummary: ChunkRecord = { id: 's1', docId: 'doc', kind: 'summary', charStart: 0, charEnd: 100, text: '全书要点概括', embedding: EMB.summary }
  await seedKb(env.store, [parent, child, docSummary])
  mockFetchForSummary()

  // 查询词嵌"概括"→ 查询向量 = x 轴 → 子块余弦 0（不过阈）、摘要余弦 1（过阈）
  const results = await searchKnowledge('帮我概括一下', 'kb1')
  assert.equal(results.length, 1, '只有摘要命中，不展开父块窗口')
  const hit = results[0]
  assert.equal(hit.kind, 'summary')
  assert.equal(hit.docId, 'doc')
  assert.match(hit.content, /【摘要】全书要点概括/)
  assert.match(hit.content, /read_knowledge/, '带 read_knowledge 下钻提示')
  assert.match(hit.content, /doc_id: "doc"/)
  assert.match(hit.content, /1\. 第一章/, '附同 doc 父块列表（标题路径）')
  assert.equal(hit.score, 1, '摘要路余弦分作为输出分')
  env.cleanup()
})

test('检索：无摘要块时退化为两路召回（行为与一期一致）', async () => {
  SecureStorageService.initialize(makeSecureStorage({ [EMBEDDING_KEY_PROVIDER]: 'sk-test' }) as any)
  const env = makeEnv()
  const config = await env.store.getGlobalConfig()
  config.embedding.dimensions = 3
  config.rerank.enabled = false
  config.retrieval.similarityThreshold = 0.5
  await env.store.saveGlobalConfig(config)

  const parent: ChunkRecord = { id: 'p0', docId: 'doc', charStart: 0, charEnd: 100, text: '父块正文内容' }
  const child: ChunkRecord = { id: 'c0', docId: 'doc', parentId: 'p0', charStart: 0, charEnd: 50, text: '子块正文内容', embedding: EMB.child }
  await seedKb(env.store, [parent, child])
  mockFetchForSummary()

  const results = await searchKnowledge('随便一个问题', 'kb1')
  assert.equal(results.length, 1, '子块命中解析到父块返回')
  assert.equal(results[0].kind, undefined, '普通命中无 kind 字段')
  assert.equal(results[0].content, '父块正文内容')
  env.cleanup()
})
