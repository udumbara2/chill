import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeRecursive } from '../helpers/recursiveDelete.ts'
import {
  KnowledgeStore,
  computeEnhancementsFingerprint,
  emptyKnowledgeIndex,
  resolveEnhancements,
} from '../../src/services/knowledge/knowledgeStore.ts'
import { processDocument } from '../../src/services/knowledge/ingestPipeline.ts'
import { runEnrichers, type ChunkEnricher, type EnrichInput } from '../../src/services/knowledge/enrich.ts'
import {
  defaultRecallSources,
  runRecallSources,
  type Candidate,
  type RecallContext,
} from '../../src/services/knowledge/retriever.ts'
import { bm25Rank, cosineSimilarity } from '../../src/services/knowledge/vectorSearch.ts'
import { DEFAULT_KNOWLEDGE_CONFIG } from '../../src/services/knowledge/types.ts'

/** 内联 Node fsProvider（同 knowledgeStore.test.ts 的形状） */
function makeEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kbstage-'))
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

// ==================== enhancements 配置合并 ====================

test('enhancements 合并：knowledge.json 缺省/部分字段落回默认（均 false）', async () => {
  const { store, cleanup } = makeEnv()
  assert.deepEqual((await store.getGlobalConfig()).enhancements, { summaryLayer: false, contextualPrefix: false })

  fs.mkdirSync(store.knowledgeDir(), { recursive: true })
  fs.writeFileSync(
    path.join(store.knowledgeDir(), 'knowledge.json'),
    JSON.stringify({ enhancements: { summaryLayer: true } })
  )
  const config = await store.getGlobalConfig()
  assert.equal(config.enhancements.summaryLayer, true, '显式字段覆盖默认')
  assert.equal(config.enhancements.contextualPrefix, false, '未写字段落回默认')
  cleanup()
})

test('enhancements 解析：库覆盖优先于全局默认，缺省字段落回全局', async () => {
  const global = structuredClone(DEFAULT_KNOWLEDGE_CONFIG)
  global.enhancements.summaryLayer = true

  // 无覆盖：生效配置 = 全局
  assert.deepEqual(resolveEnhancements(global, null), { summaryLayer: true, contextualPrefix: false })
  // 库覆盖单字段：优先于全局；另一字段仍取全局值
  const kb = { name: 'kb', description: '', createdAt: '', embeddingModel: 'm', embeddingDimensions: 1, enhancements: { summaryLayer: false, contextualPrefix: true } }
  assert.deepEqual(resolveEnhancements(global, kb), { summaryLayer: false, contextualPrefix: true })
  const kbPartial = { ...kb, enhancements: { contextualPrefix: true } }
  assert.deepEqual(resolveEnhancements(global, kbPartial), { summaryLayer: true, contextualPrefix: true })
})

// ==================== 快照指纹比对 ====================

test('指纹比对：增强开关变更 → 不一致；旧版索引（无指纹）→ 不一致', async () => {
  const { store, cleanup } = makeEnv()
  await store.createKnowledgeBase('kb1')
  const index = emptyKnowledgeIndex(await store.getGlobalConfig())
  await store.saveIndex('kb1', index)
  assert.equal(await store.isIndexEmbeddingCurrent('kb1'), true, '指纹一致时应通过')

  // 全局开关变更 → 指纹不一致
  const config = await store.getGlobalConfig()
  config.enhancements.summaryLayer = true
  await store.saveGlobalConfig(config)
  assert.equal(await store.isIndexEmbeddingCurrent('kb1'), false, '开关变更后应检出指纹不一致')

  // 恢复默认后，库级覆盖同样触发不一致（生效配置变了）
  config.enhancements.summaryLayer = false
  await store.saveGlobalConfig(config)
  assert.equal(await store.isIndexEmbeddingCurrent('kb1'), true, '恢复后再次一致')

  // 旧版 index.json：无 enhancementsFingerprint 字段 → 视为不一致需重建
  const legacy = emptyKnowledgeIndex(await store.getGlobalConfig()) as Record<string, unknown>
  delete legacy.enhancementsFingerprint
  await store.saveIndex('kb1', legacy as any)
  assert.equal(await store.isIndexEmbeddingCurrent('kb1'), false, '一期旧索引应触发重建提示')
  cleanup()
})

test('指纹生成：键序稳定，布尔翻转即变', () => {
  const a = computeEnhancementsFingerprint({ summaryLayer: false, contextualPrefix: false })
  const b = computeEnhancementsFingerprint({ summaryLayer: false, contextualPrefix: false })
  assert.equal(a, b)
  assert.notEqual(a, computeEnhancementsFingerprint({ summaryLayer: true, contextualPrefix: false }))
  assert.notEqual(a, computeEnhancementsFingerprint({ summaryLayer: false, contextualPrefix: true }))
})

// ==================== enrich 阶段 ====================

const NOTE_MD = ['# 标题', '', '第一节内容。', '', '## 第二节', '', '第二节内容。'].join('\n')

async function setupKb() {
  const env = makeEnv()
  await env.store.createKnowledgeBase('kb1')
  const config = await env.store.getGlobalConfig()
  const kbConfig = (await env.store.getKnowledgeBaseConfig('kb1'))!
  return { ...env, config, kbConfig }
}

test('processDocument：空 enricher 列表时与一期切块结果一致（按 DocType 分派）', async () => {
  const { config, kbConfig, cleanup } = await setupKb()
  const md = await processDocument(NOTE_MD, 'note', 'd1', config, kbConfig)
  assert.ok(md.records.some(c => c.parentId) && md.records.some(c => !c.parentId), 'md 产出父子块')
  assert.deepEqual(md.warnings, [])
  assert.deepEqual(md.children, md.records.filter(c => c.parentId), '嵌向量目标 = 子块')

  const distilled = await processDocument('一条沉淀。', 'distilled', 'd2', config, kbConfig)
  assert.equal(distilled.records.length, 1)
  assert.equal(distilled.children.length, 1, '沉淀单块即嵌向量目标')

  const pdf = await processDocument('第一段。\n\n第二段。', 'pdf', 'd3', config, kbConfig)
  assert.ok(pdf.records.every(c => c.headingPath === undefined), 'pdf 无标题路径')
  cleanup()
})

test('enricher 失败降级：抛错的 enricher 被跳过并收集告警，后续 enricher 照常执行', async () => {
  const { config, kbConfig, cleanup } = await setupKb()
  const failing: ChunkEnricher = {
    name: '爆炸增强',
    enrich: () => { throw new Error('LLM 超时') },
  }
  const appending: ChunkEnricher = {
    name: '附加块',
    enrich: (input: EnrichInput) => [
      ...input.chunks,
      { id: `${input.docId}-extra0`, docId: input.docId, charStart: 0, charEnd: 4, text: '附加摘要块' },
    ],
  }
  const result = await processDocument(NOTE_MD, 'note', 'd1', config, kbConfig, [failing, appending])
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0], /爆炸增强/)
  assert.match(result.warnings[0], /LLM 超时/)
  assert.match(result.warnings[0], /降级/)
  assert.ok(result.records.some(c => c.text === '附加摘要块'), '后续 enricher 的附加块应保留')
  assert.ok(result.records.some(c => c.parentId), '原始切块不受影响')

  // 链式传递：enricher 看到的 chunks 是上一个的输出
  const seen: number[] = []
  const probe: ChunkEnricher = { name: '探针', enrich: input => { seen.push(input.chunks.length) } }
  await processDocument(NOTE_MD, 'note', 'd1', config, kbConfig, [appending, probe])
  const base = await processDocument(NOTE_MD, 'note', 'd1', config, kbConfig)
  assert.deepEqual(seen, [base.records.length + 1], '探针应看到附加后的数组')

  // runEnrichers 直接调用：同步抛错与异步拒约都降级
  const input: EnrichInput = { chunks: [], text: '', docId: 'd', docType: 'note', enhancements: config.enhancements, config, kbConfig }
  const outcome = await runEnrichers(input, [
    failing,
    { name: '拒约', enrich: async () => { throw new Error('网络错误') } },
  ])
  assert.equal(outcome.warnings.length, 2)
  assert.deepEqual(outcome.chunks, [])
  cleanup()
})

// ==================== 召回源数组 ====================

test('召回源数组：与一期手写两路产出完全一致（等价性）', () => {
  const mk = (id: string, text: string, embedding: number[]): Candidate => ({
    kb: 'kb',
    chunk: { id, docId: 'doc', parentId: 'p', charStart: 0, charEnd: text.length, text, embedding },
  })
  const candidates: Candidate[] = [
    mk('c0', '机器学习是人工智能的分支', [1, 0, 0]),
    mk('c1', '今天天气很好', [0.9, 0.1, 0]),
    mk('c2', '深度学习与神经网络', [0, 1, 0]),
  ]
  const queryVector = [1, 0, 0]
  const ctx: RecallContext = {
    query: '机器学习',
    queryVector,
    candidates,
    candId: c => `${c.kb}/${c.chunk.id}`,
  }

  const ranked = runRecallSources(defaultRecallSources(), ctx)
  assert.deepEqual(Object.keys(ranked), ['vector', 'bm25'])

  // 向量路 = 余弦暴力扫描降序（与一期实现同一算法、同一排序）
  const expectedVector = candidates
    .map(c => ({ id: ctx.candId(c), score: cosineSimilarity(queryVector, c.chunk.embedding!) }))
    .sort((a, b) => b.score - a.score)
  assert.deepEqual(ranked.vector, expectedVector)

  // BM25 路 = bm25Rank 结果按下标映射回候选 id
  const expectedBm25 = bm25Rank('机器学习', candidates.map(c => c.chunk.text))
    .map(h => ({ id: ctx.candId(candidates[h.index]), score: h.score }))
  assert.deepEqual(ranked.bm25, expectedBm25)
  assert.ok(ranked.bm25.length > 0 && ranked.bm25[0].id === 'kb/c0')
})
