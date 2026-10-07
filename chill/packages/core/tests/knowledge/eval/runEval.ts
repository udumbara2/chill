/**
 * 知识库检索质量评测执行器（二期任务 2，设计见 iDream/知识管理.md 第八节"质量可度量"）
 *
 * 运行方式：cd packages/core && pnpm test:knowledge-eval
 * 开摘要层重跑（任务 3 对比）：KB_EVAL_SUMMARY=1 pnpm test:knowledge-eval（同标尺、另装 mock LLM）
 * 开定位前缀重跑（任务 4 对比）：KB_EVAL_CONTEXTUAL=1 pnpm test:knowledge-eval（两开关可叠加）
 *
 * 流程：建临时库 → 摄入 fixtures（mock embedding）→ 逐用例跑 searchKnowledge
 * → 统计 top-k（k=5）命中率，按类别输出人类可读报告。
 *
 * mock embedding 说明：用确定性的"词袋 hash"向量生成器（Intl.Segmenter 中文分词 →
 * 词 hash 进固定维度 → L2 归一化）。它保证同文本同向量、共享词越多向量越近，
 * 但语义近似能力很弱（同义改写几乎无重叠）。因此：
 * - 本评测的价值在**回归对比**（增强前后同一用例集的命中率变化），不在绝对数字；
 * - 阈值 similarityThreshold 相应下调（词袋余弦量级远小于真实 embedding 的 0.5 门槛）；
 * - rerank 关闭（mock 下 rerank 分数无意义，且要排除网络不确定性）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeRecursive } from '../../helpers/recursiveDelete.ts'
import { SecureStorageService } from '../../../src/services/secureStorageService.ts'
import { EMBEDDING_KEY_PROVIDER } from '../../../src/services/knowledge/embeddingClient.ts'
import { KnowledgeStore } from '../../../src/services/knowledge/knowledgeStore.ts'
import { ingestDocument, docIdForSource } from '../../../src/services/knowledge/ingestPipeline.ts'
import { searchKnowledge } from '../../../src/services/knowledge/retriever.ts'
import { ModelServiceFactory } from '../../../src/services/models/modelServiceFactory.ts'
import { SelectedModelsService } from '../../../src/services/selectedModelsService.ts'
import { FIXTURE_DOCS } from './fixtures.ts'
import { EVAL_CASES, type EvalCase } from './cases.ts'

/** 评测用库名与 top-k */
const EVAL_KB = 'eval'
const TOP_K = 5

/** KB_EVAL_SUMMARY=1 时开启摘要层重跑（任务 3 前后对比；缺省关 = 一期基线） */
const SUMMARY_ON = process.env.KB_EVAL_SUMMARY === '1'
/** KB_EVAL_CONTEXTUAL=1 时开启定位前缀重跑（任务 4 前后对比；与 KB_EVAL_SUMMARY 可叠加） */
const CONTEXTUAL_ON = process.env.KB_EVAL_CONTEXTUAL === '1'

// ==================== mock embedding：确定性词袋 hash 向量 ====================

const MOCK_DIMS = 512

/** FNV-1a 字符串 hash（确定性，同文本同向量） */
function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })

/** 词袋 hash 向量：分词 → 词 hash 进固定维度累计词频 → L2 归一化 */
function mockEmbed(text: string): number[] {
  const vec = new Array<number>(MOCK_DIMS).fill(0)
  for (const { segment, isWordLike } of segmenter.segment(text)) {
    if (!isWordLike) continue
    vec[fnv1a(segment.toLowerCase()) % MOCK_DIMS] += 1
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0))
  return norm === 0 ? vec : vec.map(v => v / norm)
}

/** mock 全局 fetch：只接 /embeddings（rerank 已关，不应有其他请求） */
function installMockFetch() {
  const g = globalThis as any
  g.__evalOrigFetch = g.fetch
  g.fetch = async (url: string, init: any) => {
    if (!String(url).includes('/embeddings')) {
      throw new Error(`评测中出现意外请求: ${url}（rerank 应在评测配置里关闭）`)
    }
    const body = JSON.parse(init.body)
    const data = (body.input as string[]).map((text, i) => ({ embedding: mockEmbed(text), index: i }))
    return {
      ok: true,
      status: 200,
      json: async () => ({ data }),
      text: async () => JSON.stringify({ data }),
    } as Response
  }
}

function restoreFetch() {
  const g = globalThis as any
  if (g.__evalOrigFetch) { g.fetch = g.__evalOrigFetch; delete g.__evalOrigFetch }
}

// ==================== mock LLM（摘要层/定位前缀评测用，KB_EVAL_SUMMARY=1 或 KB_EVAL_CONTEXTUAL=1 时安装） ====================

const origSendChatMessage = ModelServiceFactory.getInstance().sendChatMessage
const origGetCurrentModelName = SelectedModelsService.getInstance().getCurrentModelName

/**
 * 确定性的 LLM 替身，按 system prompt 区分两类调用（词袋 embedding 没有语义能力，
 * 生成式改写无法模拟；替身保证同输入同输出、产出与原文/章节共享词汇——恰好对应增强的机制）：
 * - 摘要：抽取式摘要（去掉 enricher 加的【标签】前缀，压平空白，截取开头 + 概要前缀），
 *   对应"摘要块把章节/全书的核心词浓缩进一个 chunk"；
 * - 定位前缀：从【章节】/【块内容】分节标记解析，产出"此块出自「章节」，讲的是<块内容开头>"，
 *   对应"前缀把章节语境词补进 embedding 文本"（标题路径本就在 embedding 文本里，
 *   词袋 mock 下收益有限，如实记录，见 BASELINE.md）。
 */
function installMockLlm() {
  ModelServiceFactory.getInstance().sendChatMessage = async (_model: string, messages: any[]) => {
    const system = String(messages[0]?.content ?? '')
    const user = String(messages[messages.length - 1]?.content ?? '')
    if (system.includes('定位前缀')) {
      const chapter = user.match(/【章节】\n([^\n]*)/)?.[1] ?? ''
      const chunkBody = (user.split('【块内容】')[1] ?? '').replace(/\s+/g, '')
      const where = chapter && chapter !== '（无标题）' ? `「${chapter}」章节` : '本文档'
      return { content: `此块出自${where}，讲的是${chunkBody.slice(0, 40)}` }
    }
    const body = user.replace(/^【[^】]*】\n?/, '').replace(/\s+/g, '')
    const prefix = user.startsWith('【整篇文档') ? '本文档整体内容概要：' : '本部分内容概要：'
    return { content: `${prefix}${body.slice(0, 120)}` }
  }
  SelectedModelsService.getInstance().getCurrentModelName = () => 'eval-model'
}

function restoreLlm() {
  ModelServiceFactory.getInstance().sendChatMessage = origSendChatMessage
  SelectedModelsService.getInstance().getCurrentModelName = origGetCurrentModelName
}

// ==================== 环境搭建（同 tests/knowledge/ 既有测试的内存 mock 方式） ====================

function makeEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kbeval-'))
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

// ==================== 评测执行 ====================

interface CaseOutcome {
  evalCase: EvalCase
  hit: boolean
  /** 实际 top-k 结果摘要（docKey 列表 + 分数），供报告展示 */
  actual: Array<{ docKey: string; score: number }>
}

async function main() {
  const { store, cleanup } = makeEnv()
  SecureStorageService.initialize(makeSecureStorage({ [EMBEDDING_KEY_PROVIDER]: 'sk-eval' }) as any)
  installMockFetch()
  if (SUMMARY_ON || CONTEXTUAL_ON) installMockLlm()

  try {
    // 评测配置：维度对齐 mock；rerank 关；阈值下调适配词袋余弦量级（见文件头注释）
    const config = await store.getGlobalConfig()
    config.embedding.dimensions = MOCK_DIMS
    config.rerank.enabled = false
    config.retrieval.similarityThreshold = 0.05
    config.enhancements.summaryLayer = SUMMARY_ON
    config.enhancements.contextualPrefix = CONTEXTUAL_ON
    await store.saveGlobalConfig(config)

    // 建库 + 摄入全部 fixtures，建立 fixture key → docId 映射
    await store.createKnowledgeBase(EVAL_KB, '评测语料库')
    const docKeyByDocId = new Map<string, string>()
    let totalChunks = 0
    for (const doc of FIXTURE_DOCS) {
      const result = await ingestDocument(EVAL_KB, doc.sourcePath, doc.content, doc.type)
      docKeyByDocId.set(result.docId, doc.key)
      totalChunks += result.chunkCount
      if (result.warnings.length > 0) console.log(`摄入告警 [${doc.key}]:`, result.warnings)
    }
    // docIdForSource 由摄入管线保证幂等，这里用它反向校验映射完整性
    for (const doc of FIXTURE_DOCS) {
      const docId = await docIdForSource(doc.sourcePath)
      if (docKeyByDocId.get(docId) !== doc.key) throw new Error(`docId 映射异常: ${doc.key}`)
    }

    console.log(`\n知识库检索质量评测（mock 词袋 embedding，${MOCK_DIMS} 维，top_k=${TOP_K}，summaryLayer=${SUMMARY_ON ? '开' : '关'}，contextualPrefix=${CONTEXTUAL_ON ? '开' : '关'}）`)
    console.log(`语料：${FIXTURE_DOCS.length} 篇文档，${totalChunks} 个 chunk；用例：${EVAL_CASES.length} 条\n`)

    const outcomes: CaseOutcome[] = []
    for (const evalCase of EVAL_CASES) {
      const results = await searchKnowledge(evalCase.query, EVAL_KB, TOP_K)
      const expectedDocId = await docIdForSource(FIXTURE_DOCS.find(d => d.key === evalCase.expectDocKey)!.sourcePath)
      const hit = results.some(r =>
        r.docId === expectedDocId
        && (!evalCase.expectHeadingPath || (r.headingPath ?? '').includes(evalCase.expectHeadingPath!))
      )
      outcomes.push({
        evalCase,
        hit,
        actual: results.map(r => ({ docKey: docKeyByDocId.get(r.docId) ?? r.docId, score: Number(r.score.toFixed(4)) })),
      })
    }

    // 逐用例明细
    for (const { evalCase, hit, actual } of outcomes) {
      const mark = hit ? '命中' : '未命中'
      console.log(`[${mark}] ${evalCase.category} / ${evalCase.id}`)
      console.log(`  提问: ${evalCase.query}`)
      console.log(`  期望: ${evalCase.expectDocKey}${evalCase.expectHeadingPath ? `（标题路径含 "${evalCase.expectHeadingPath}"）` : ''}`)
      console.log(`  实际 top-${TOP_K}: ${actual.length ? actual.map(a => `${a.docKey}(${a.score})`).join(', ') : '（无结果）'}`)
      if (evalCase.note) console.log(`  备注: ${evalCase.note}`)
    }

    // 分类汇总
    console.log('\n按类别命中率:')
    const categories = [...new Set(EVAL_CASES.map(c => c.category))]
    let totalHit = 0
    for (const cat of categories) {
      const inCat = outcomes.filter(o => o.evalCase.category === cat)
      const hits = inCat.filter(o => o.hit).length
      totalHit += hits
      console.log(`  ${cat}: ${hits}/${inCat.length}`)
    }
    console.log(`\n总体: ${totalHit}/${outcomes.length}（${Math.round((totalHit / outcomes.length) * 100)}%）`)
    console.log('\n说明：mock 词袋 embedding 语义近似很弱，绝对命中率不代表真实服务质量；')
    console.log('本评测的价值是固定标尺下的回归对比（增强前后同跑本脚本对比命中率）。')
  } finally {
    restoreFetch()
    if (SUMMARY_ON || CONTEXTUAL_ON) restoreLlm()
    cleanup()
  }
}

main().catch(e => {
  console.error('评测执行失败:', e)
  process.exitCode = 1
})
