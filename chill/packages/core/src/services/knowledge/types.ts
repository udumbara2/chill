/**
 * 知识库模块类型定义（布局见 iDream/知识管理.md 第三节）
 *
 * ~/.chill/knowledge/
 * ├── knowledge.json     全局配置（embedding / rerank / 检索参数）
 * └── <kb-name>/
 *     ├── kb.json        库元数据（含 embedding 模型+维度快照）
 *     ├── docs/<docId>.md  文档正本（frontmatter + Markdown 正文）
 *     └── index.json     向量索引（父子块同为记录，子块带 parentId 且独有向量）
 */

/** 库元数据（kb.json）：embeddingModel/embeddingDimensions 为建库时的快照，换模型/维度后惰性比对提示重建 */
export interface KnowledgeBaseConfig {
  name: string
  description: string
  createdAt: string
  embeddingModel: string
  embeddingDimensions: number
  /** 逐库增强开关覆盖（二期；缺省字段落回全局 knowledge.json 的 enhancements） */
  enhancements?: Partial<EnhancementsConfig>
}

/** embedding 服务配置（任意 OpenAI 兼容服务；API key 走 SecureStorageService，不落盘） */
export interface EmbeddingConfig {
  provider: string
  baseURL: string
  model: string
  dimensions: number
}

/** rerank 开关（DashScope rerank，可关） */
export interface RerankConfig {
  enabled: boolean
}

/** 检索与切块参数 */
export interface RetrievalConfig {
  topK: number
  similarityThreshold: number
  childChunkSize: number
  parentChunkSize: number
}

/** 增强开关（二期管线阶段化）：全局默认在 knowledge.json，逐库覆盖在 kb.json，默认均关 */
export interface EnhancementsConfig {
  /** 摘要层：章节/全书摘要作为 chunk 参与召回（任务 3） */
  summaryLayer: boolean
  /** LLM 定位前缀：Contextual Retrieval，embeddingText 拼 LLM 生成的前缀（任务 4） */
  contextualPrefix: boolean
}

/** 全局配置（knowledge.json，读取时与默认值合并） */
export interface KnowledgeGlobalConfig {
  embedding: EmbeddingConfig
  rerank: RerankConfig
  retrieval: RetrievalConfig
  enhancements: EnhancementsConfig
}

/** 全局配置默认值：阿里百炼 text-embedding-v4 / 1024 维；增强开关默认均关 */
export const DEFAULT_KNOWLEDGE_CONFIG: KnowledgeGlobalConfig = {
  embedding: {
    provider: 'dashscope',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'text-embedding-v4',
    dimensions: 1024,
  },
  rerank: { enabled: true },
  retrieval: {
    topK: 5,
    similarityThreshold: 0.5,
    childChunkSize: 300,
    parentChunkSize: 1200,
  },
  enhancements: {
    summaryLayer: false,
    contextualPrefix: false,
  },
}

/** 块类型（二期摘要层）：child 子块 / parent 父块 / summary 摘要块 */
export type ChunkKind = 'child' | 'parent' | 'summary'

/** 索引中的一条切块记录（子块带 parentId 且独有向量，父块不嵌向量；摘要块带向量、kind='summary'） */
export interface ChunkRecord {
  id: string
  docId: string
  parentId?: string
  /**
   * 块类型（二期）；一期索引无此字段，读取时按 parentId 推断（有 parentId 为 child，否则 parent），
   * 见 resolveChunkKind——一期索引无需迁移
   */
  kind?: ChunkKind
  /** 标题路径（如 "React > Hooks > useEffect"），Markdown 切块时写入并拼进 embedding 文本前缀 */
  headingPath?: string
  /**
   * LLM 定位前缀（二期任务 4 Contextual Retrieval，如 "此块出自某文档某章节，讲的是…"），
   * 只拼进 embedding 文本（见 chunker.embeddingText），text 始终保持无前缀的干净正文
   */
  contextPrefix?: string
  charStart: number
  charEnd: number
  text: string
  embedding?: number[]
}

/** 解析块类型：显式 kind 优先；缺省按 parentId 推断（向后兼容一期索引） */
export function resolveChunkKind(chunk: ChunkRecord): ChunkKind {
  return chunk.kind ?? (chunk.parentId ? 'child' : 'parent')
}

/** 向量索引（index.json）：embedding 快照 + 增强指纹供换模型/维度/开关时惰性比对 */
export interface KnowledgeIndex {
  version: number
  embeddingModel: string
  embeddingDimensions: number
  /** 生效增强配置的序列化指纹（二期）；开关变更即不一致，触发健康告警/重建提示 */
  enhancementsFingerprint: string
  chunks: ChunkRecord[]
}

/** 文档类型：笔记 / PDF 文本抽取（含扫描件 OCR）/ Office 文档（docx/xlsx/pptx）/ 图片 OCR / 会话沉淀 */
export type DocType = 'note' | 'pdf' | 'office' | 'image' | 'distilled'

/** 文档 frontmatter（docs/<docId>.md 头部）：用户原始文件不复制，只记来源路径 */
export interface DocFrontmatter {
  sourcePath: string
  type: DocType
  contentHash: string
  createdAt: string
}
