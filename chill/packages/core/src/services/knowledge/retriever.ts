import { embedTexts, getEmbeddingApiKey } from './embeddingClient'
import { KnowledgeStore } from './knowledgeStore'
import { resolveChunkKind, type ChunkKind, type ChunkRecord } from './types'
import { bm25Rank, cosineSimilarity, rrfFuse, type FusedItem, type RankedItem } from './vectorSearch'

/**
 * 知识库检索管线（设计见 iDream/知识管理.md 第四节；二期多路召回见第八节）：
 *
 *   查询向量化（1 次 API 调用）→ 余弦暴力扫描 ∥ BM25（Intl.Segmenter 中文分词，内存现场构建）
 *   ∥ summary 摘要路（二期任务 3，摘要块单独排名，权重可调；索引无摘要块时自动退化为两路）
 *   → RRF 融合 → 阈值过滤 → DashScope rerank（gte-rerank-v2，可关，复用 embedding key）
 *   → top-k → 按 parentId 取父块 + 相邻窗口（前后各 1，去重）→ 返回内容 + 标题路径 + 分数
 *   （命中摘要块时不展开父块窗口，返回"摘要 + 下钻指引"：同 doc 父块列表 + read_knowledge 提示）
 *
 * 只对有向量的块算分（子块与摘要块有向量，父块不嵌向量；沉淀知识每条一块、自身即父级）。
 * 三端同码：存储走注入 provider，网络只用全局 fetch。
 */

/** DashScope rerank 端点与模型（复用 embedding 的 key，同一家服务） */
const RERANK_URL = 'https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank'
const RERANK_MODEL = 'gte-rerank-v2'

/** 单条检索结果：父块正文 + 来源 + 标题路径 + 分数（rerank 开启时为 relevance_score，否则为余弦分） */
export interface KnowledgeSearchResult {
  content: string
  docId: string
  headingPath?: string
  score: number
  /** 来源库名（kbName 省略时跨库检索，不丢来源） */
  kb: string
  /** 命中块类型；仅摘要命中时为 'summary'（content 为"摘要 + 下钻指引"），普通命中缺省 */
  kind?: ChunkKind
}

/** rerank 返回的单项（内部） */
interface RerankItem {
  index: number
  relevanceScore: number
}

/**
 * 调 DashScope rerank API。任何失败（网络异常 / HTTP 错误 / 响应格式不符）都返回 null，
 * 由调用方降级为不重排（按 RRF 顺序返回）——rerank 是质量增强，不应拖垮整个检索。
 */
async function callRerank(query: string, documents: string[], apiKey: string): Promise<RerankItem[] | null> {
  try {
    const res = await fetch(RERANK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: RERANK_MODEL,
        input: { query, documents },
        parameters: { return_documents: false },
      }),
    })
    if (!res.ok) return null
    const parsed = (await res.json()) as { output?: { results?: Array<{ index?: number; relevance_score?: number }> } }
    const results = parsed?.output?.results
    if (!Array.isArray(results)) return null
    const items: RerankItem[] = []
    for (const r of results) {
      if (typeof r?.index !== 'number' || typeof r?.relevance_score !== 'number') return null
      if (r.index < 0 || r.index >= documents.length) return null
      items.push({ index: r.index, relevanceScore: r.relevance_score })
    }
    return items.sort((a, b) => b.relevanceScore - a.relevanceScore)
  } catch {
    return null
  }
}

/** 候选块：有向量的索引记录 + 来源库 */
export interface Candidate {
  kb: string
  chunk: ChunkRecord
}

/** 召回上下文：查询文本 + 查询向量 + 候选列表 + 候选 id 规则（BM25 路不用向量；后续 summary 路复用同一上下文） */
export interface RecallContext {
  query: string
  queryVector: number[]
  candidates: Candidate[]
  candId: (c: Candidate) => string
}

/**
 * 召回源（二期管线阶段化）：每源产出一份按分降序的 ranked list，全部源统一进 RRF 融合。
 * 任务 3 的摘要召回路见 summaryRecallSource。
 */
export interface RecallSource {
  name: 'vector' | 'bm25' | (string & {})
  rank(ctx: RecallContext): RankedItem[]
}

/**
 * 摘要召回路在 RRF 中的权重（向量/BM25 主路权重为 1）。
 * 取 2 的考量：主路双料命中最高积 2/(k+1)，权重 2 让摘要路第一名与之同分——强匹配摘要进 top-k 前列；
 * 同分时主路命中先入列排前（rrfFuse 先施加向量路），细节问题的细节块不被摘要压过；第二名起的摘要
 * （2/(k+2) 及以下）恒低于任何主路双料命中，成群的弱匹配摘要不会挤占细节。
 */
export const SUMMARY_RECALL_WEIGHT = 2

/** 默认召回源列表：向量路（余弦暴力扫描）+ BM25 路（内存现场分词）。
 *  摘要块不进这两条主路，只走 summaryRecallSource 提升路（权重见 SUMMARY_RECALL_WEIGHT 的注释）——
 *  否则摘要块在三条路同时计分（RRF 按名次积分），细节查询下任何过阈摘要都会压过主路双料命中的细节块 */
export function defaultRecallSources(): RecallSource[] {
  return [
    {
      name: 'vector',
      rank: ctx => ctx.candidates
        .filter(c => resolveChunkKind(c.chunk) !== 'summary')
        .map(c => ({ id: ctx.candId(c), score: cosineSimilarity(ctx.queryVector, c.chunk.embedding!) }))
        .sort((a, b) => b.score - a.score),
    },
    {
      name: 'bm25',
      rank: ctx => {
        const nonSummary = ctx.candidates.filter(c => resolveChunkKind(c.chunk) !== 'summary')
        return bm25Rank(ctx.query, nonSummary.map(c => c.chunk.text))
          .map(h => ({ id: ctx.candId(nonSummary[h.index]), score: h.score }))
      },
    },
  ]
}

/** 摘要召回源（二期任务 3）：只对摘要块（kind='summary'，带向量）按余弦排名，作为提升路单独进 RRF */
export function summaryRecallSource(): RecallSource {
  return {
    name: 'summary',
    rank: ctx => ctx.candidates
      .filter(c => resolveChunkKind(c.chunk) === 'summary')
      .map(c => ({ id: ctx.candId(c), score: cosineSimilarity(ctx.queryVector, c.chunk.embedding!) }))
      .sort((a, b) => b.score - a.score),
  }
}

/** 执行全部召回源，返回 源名 → ranked list（源顺序即列表顺序，同名源后者覆盖前者） */
export function runRecallSources(sources: RecallSource[], ctx: RecallContext): Record<string, RankedItem[]> {
  const ranked: Record<string, RankedItem[]> = {}
  for (const source of sources) ranked[source.name] = source.rank(ctx)
  return ranked
}

/**
 * 知识库检索主入口。kbName 省略时检索全部库；topK 缺省取全局配置（默认 5）。
 *
 * 阈值说明：similarityThreshold（默认 0.5）作用于**余弦分**——它是绝对、可解释的相似度，
 * 0.5 是常用余弦门槛；RRF 融合分量级 ~1/60 无法对 0.5，归一化后又会让第一名恒过阈值使阈值失效。
 * BM25 的作用因此体现为在过阈值的候选里参与重排，而不是单独捞低向量分的结果。
 */
export async function searchKnowledge(query: string, kbName?: string, topK?: number): Promise<KnowledgeSearchResult[]> {
  const store = KnowledgeStore.getInstance()
  const q = (query ?? '').trim()
  if (!q) return []
  const config = await store.getGlobalConfig()

  // 目标库：省略 kbName 时检索全部库；显式给名但不存在时抛明确错误
  let kbNames: string[]
  if (kbName) {
    if (!(await store.getKnowledgeBaseConfig(kbName))) throw new Error(`未找到知识库: ${kbName}`)
    kbNames = [kbName]
  } else {
    kbNames = (await store.listKnowledgeBases()).map(k => k.name)
  }

  // 加载索引入内存；embedding 快照惰性比对，不一致抛带重建指引的中文错误
  const candidates: Candidate[] = []
  // 每库：id → 记录（解析 parentId），docId → 父级记录列表（按原文顺序，供相邻窗口取用）
  const recordById = new Map<string, Map<string, ChunkRecord>>()
  const parentsByDoc = new Map<string, ChunkRecord[]>()
  for (const kb of kbNames) {
    if (!(await store.isIndexEmbeddingCurrent(kb))) {
      throw new Error(
        `知识库 "${kb}" 的向量索引与当前 embedding 配置（${config.embedding.model} / ${config.embedding.dimensions} 维）不一致，`
        + '旧向量不可复用。请重建该库索引：换 embedding 模型/维度后需要重新摄入全部文档'
        + '（删除库内 index.json 后逐文档重新 add_knowledge，或删库重建）。'
      )
    }
    const index = await store.readIndex(kb)
    if (!index || index.chunks.length === 0) continue
    const byId = new Map<string, ChunkRecord>()
    for (const chunk of index.chunks) byId.set(chunk.id, chunk)
    recordById.set(kb, byId)
    // 父级记录 = 父块 + 沉淀知识的独立块（kind 解析为 parent；摘要块不算父级，不进相邻窗口），
    // 按 docId 分组、按原文偏移排序。一期索引无 kind 字段，按 parentId 推断后行为不变
    for (const chunk of index.chunks) {
      if (resolveChunkKind(chunk) !== 'parent') continue
      const key = `${kb}/${chunk.docId}`
      let list = parentsByDoc.get(key)
      if (!list) {
        list = []
        parentsByDoc.set(key, list)
      }
      list.push(chunk)
    }
    for (const chunk of index.chunks) {
      if (Array.isArray(chunk.embedding) && chunk.embedding.length > 0) {
        candidates.push({ kb, chunk })
      }
    }
  }
  for (const list of parentsByDoc.values()) list.sort((a, b) => a.charStart - b.charStart)
  if (candidates.length === 0) return []

  // 查询向量化（1 次 API 调用）
  const apiKey = await getEmbeddingApiKey()
  const [queryVector] = await embedTexts([q], config.embedding, apiKey)

  // 候选 id：`${kb}/${chunk.id}`，跨库唯一
  const candId = (c: Candidate) => `${c.kb}/${c.chunk.id}`
  const candById = new Map(candidates.map(c => [candId(c), c]))

  // 多路召回：向量路 + BM25 路常驻；索引含摘要块时追加 summary 路（无摘要块自动退化为两路）
  const sources = defaultRecallSources()
  if (candidates.some(c => resolveChunkKind(c.chunk) === 'summary')) sources.push(summaryRecallSource())
  const ranked = runRecallSources(sources, { query: q, queryVector, candidates, candId })

  // RRF 融合（摘要路带权重进融合）→ 阈值过滤：余弦分过阈即保留，
  // 主路（vector）与摘要路（summary）同为余弦分量级，任一路过阈都算命中（理由见函数注释）
  const threshold = config.retrieval.similarityThreshold
  const hits: FusedItem[] = rrfFuse(ranked.vector, ranked.bm25, 60, ranked.summary, SUMMARY_RECALL_WEIGHT)
    .filter(h => (h.vectorScore ?? -1) >= threshold || (h.summaryScore ?? -1) >= threshold)
  if (hits.length === 0) return []

  // rerank（可关）：成功则按 relevance_score 重排并换分；失败降级为 RRF 顺序、输出余弦分
  let ordered: Array<{ cand: Candidate; score: number }>
  let reranked: RerankItem[] | null = null
  if (config.rerank.enabled) {
    reranked = await callRerank(q, hits.map(h => candById.get(h.id)!.chunk.text), apiKey)
  }
  if (reranked) {
    ordered = reranked.map(r => ({ cand: candById.get(hits[r.index].id)!, score: r.relevanceScore }))
  } else {
    ordered = hits.map(h => ({ cand: candById.get(h.id)!, score: h.vectorScore ?? h.summaryScore ?? 0 }))
  }

  const limit = Math.max(1, topK ?? config.retrieval.topK)
  ordered = ordered.slice(0, limit)

  // 父块 + 相邻窗口：命中块解析到父级（有 parentId 取父块，否则自身即父级），
  // 再取同 doc 前后各 1 个父级块作为上下文窗口；命中与窗口统一按 `${kb}/${父块id}` 去重，
  // 重叠窗口与多命中同父块只出一次。窗口块继承命中块分数（它是附带上下文，非独立命中）。
  const results: KnowledgeSearchResult[] = []
  const seen = new Set<string>()
  for (const { cand, score } of ordered) {
    const byId = recordById.get(cand.kb)!
    // 摘要命中：不展开父块窗口，返回"摘要 + 下钻指引"（附同 doc 父块列表，提示 read_knowledge 深读）
    if (resolveChunkKind(cand.chunk) === 'summary') {
      const key = `${cand.kb}/${cand.chunk.id}`
      if (seen.has(key)) continue
      seen.add(key)
      const docParents = parentsByDoc.get(`${cand.kb}/${cand.chunk.docId}`) ?? []
      results.push({
        content: buildSummaryDrilldown(cand.kb, cand.chunk, docParents),
        docId: cand.chunk.docId,
        headingPath: cand.chunk.headingPath,
        score,
        kb: cand.kb,
        kind: 'summary',
      })
      continue
    }
    const parent = (cand.chunk.parentId ? byId.get(cand.chunk.parentId) : undefined) ?? cand.chunk
    const docParents = parentsByDoc.get(`${cand.kb}/${parent.docId}`) ?? [parent]
    let i = docParents.findIndex(p => p.id === parent.id)
    if (i === -1) {
      docParents.splice(i = 0, 0, parent) // 父级缺失（索引损坏）时兜底只返回自身
      docParents.length = 1
    }
    for (const p of [docParents[i - 1], docParents[i], docParents[i + 1]]) {
      if (!p) continue
      const key = `${cand.kb}/${p.id}`
      if (seen.has(key)) continue
      seen.add(key)
      results.push({
        content: p.text,
        docId: p.docId,
        headingPath: p.headingPath ?? cand.chunk.headingPath,
        score,
        kb: cand.kb,
      })
    }
  }
  return results
}

/** 摘要命中的返回内容：摘要正文 + 下钻指引（同 doc 父块列表 + read_knowledge 深读提示） */
function buildSummaryDrilldown(kb: string, chunk: ChunkRecord, docParents: ChunkRecord[]): string {
  const lines = [
    `【摘要】${chunk.text}`,
    '',
    `—— 以上是知识库 "${kb}" 中文档（doc_id: "${chunk.docId}"）的摘要块。`
    + `需要完整内容时，用 read_knowledge 传入 kb="${kb}"、doc_id="${chunk.docId}" 阅读全文。`,
  ]
  if (docParents.length === 0) {
    lines.push('该文档没有可下钻的父块。')
  } else {
    lines.push(`该文档共 ${docParents.length} 个父块，可按需下钻深读：`)
    docParents.forEach((p, i) => {
      const label = p.headingPath ?? `${p.text.slice(0, 20)}…`
      lines.push(`${i + 1}. ${label}`)
    })
  }
  return lines.join('\n')
}
