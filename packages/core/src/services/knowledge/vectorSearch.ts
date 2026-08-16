/**
 * 知识库检索算分模块（设计见 iDream/知识管理.md 第四节）：余弦 + BM25 + RRF 融合。
 *
 * - 向量路：cosineSimilarity 暴力余弦扫描（个人规模 1k–1 万 chunk 毫秒级且精确，不引向量库）
 * - 关键词路：bm25Rank 标准 BM25（k1=1.2, b=0.75），中文用 Intl.Segmenter('zh') 按词分，
 *   英文/数字按空格与标点边界（同一 Segmenter 天然覆盖），零依赖
 * - 融合：rrfFuse 倒数排名融合（RRF, k=60），两路各出一份排名，按名次融合与分数量纲无关
 *
 * 零依赖纯函数，三端同码（不 import 任何 Node/Electron API）。
 */

/** Intl.Segmenter 的最小结构类型（core 的 lib 是 ES2020，不带 Intl.Segmenter 声明，自行描述形状） */
interface WordSegmenter {
  segment(text: string): Iterable<{ segment: string; isWordLike?: boolean }>
}

/** 模块级复用：Segmenter 构建有成本；不支持的环境（旧引擎）落回 null 走兜底分词 */
let cachedSegmenter: WordSegmenter | null | undefined

function getSegmenter(): WordSegmenter | null {
  if (cachedSegmenter === undefined) {
    const Ctor = (Intl as unknown as { Segmenter?: new (locale: string, opts: { granularity: 'word' }) => WordSegmenter }).Segmenter
    cachedSegmenter = typeof Ctor === 'function' ? new Ctor('zh', { granularity: 'word' }) : null
  }
  return cachedSegmenter
}

/**
 * 分词：中文按词（Intl.Segmenter 'zh' word 粒度），英文/数字按空格与标点边界，统一小写。
 * 无 Intl.Segmenter 的环境兜底：CJK 逐字、其余按非字母数字边界切。
 */
export function tokenize(text: string): string[] {
  const seg = getSegmenter()
  if (seg) {
    const tokens: string[] = []
    for (const part of seg.segment(text.toLowerCase())) {
      const t = part.segment.trim()
      // isWordLike 滤掉空白与纯标点；中文词、英文单词、数字都会保留
      if (part.isWordLike && t) tokens.push(t)
    }
    return tokens
  }
  return (text.toLowerCase().match(/[一-鿿]|[a-z0-9]+/g) ?? [])
}

/** 余弦相似度；任一向量零范数返回 0，维度不一致抛中文错误（正常流程由快照比对先行拦截） */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`向量维度不一致（${a.length} vs ${b.length}），请检查 embedding 配置与索引快照`)
  }
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/** BM25 命中：chunks 下标 + 分数（按分数降序返回，零分项不返回） */
export interface Bm25Hit {
  index: number
  score: number
}

/**
 * 标准 BM25 排名（k1=1.2, b=0.75）。语料为传入的 chunks 文本数组（内存现场分词，不落盘）。
 * IDF 用 Lucene 非负变体 ln(1 + (N-n+0.5)/(n+0.5))，避免经典公式在 n > N/2 时出负分。
 */
export function bm25Rank(query: string, chunks: string[], k1 = 1.2, b = 0.75): Bm25Hit[] {
  const docs = chunks.map(tokenize)
  const n = docs.length
  if (n === 0) return []
  const avgdl = docs.reduce((sum, d) => sum + d.length, 0) / n
  const df = new Map<string, number>()
  for (const doc of docs) {
    for (const term of new Set(doc)) df.set(term, (df.get(term) ?? 0) + 1)
  }
  const hits: Bm25Hit[] = []
  for (let index = 0; index < n; index++) {
    const doc = docs[index]
    const tf = new Map<string, number>()
    for (const term of doc) tf.set(term, (tf.get(term) ?? 0) + 1)
    let score = 0
    for (const term of new Set(tokenize(query))) {
      const termDf = df.get(term) ?? 0
      if (termDf === 0) continue
      const f = tf.get(term) ?? 0
      if (f === 0) continue
      const idf = Math.log(1 + (n - termDf + 0.5) / (termDf + 0.5))
      score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * doc.length) / (avgdl || 1)))
    }
    if (score > 0) hits.push({ index, score })
  }
  return hits.sort((x, y) => y.score - x.score)
}

/** 一路排名的单项：id 为候选标识（retriever 用 `${kb}/${chunk.id}`），score 为该路原始分 */
export interface RankedItem {
  id: string
  score: number
}

/** RRF 融合结果：score 为融合分，vectorScore/bm25Score 保留两路原始分（缺路为 null） */
export interface FusedItem {
  id: string
  score: number
  vectorScore: number | null
  bm25Score: number | null
}

/**
 * 倒数排名融合（RRF, k=60）：score = Σ 1/(k + rank)，只依赖名次，与两路分数量纲无关。
 * 输入两路各自按分降序的排名，输出按融合分降序。
 */
export function rrfFuse(vectorRanked: RankedItem[], bm25Ranked: RankedItem[], k = 60): FusedItem[] {
  const map = new Map<string, FusedItem>()
  const apply = (list: RankedItem[], key: 'vectorScore' | 'bm25Score') => {
    list.forEach((item, rank) => {
      let fused = map.get(item.id)
      if (!fused) {
        fused = { id: item.id, score: 0, vectorScore: null, bm25Score: null }
        map.set(item.id, fused)
      }
      fused.score += 1 / (k + rank + 1)
      fused[key] = item.score
    })
  }
  apply(vectorRanked, 'vectorScore')
  apply(bm25Ranked, 'bm25Score')
  return [...map.values()].sort((a, b) => b.score - a.score)
}
