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

/** 全局配置（knowledge.json，读取时与默认值合并） */
export interface KnowledgeGlobalConfig {
  embedding: EmbeddingConfig
  rerank: RerankConfig
  retrieval: RetrievalConfig
}

/** 全局配置默认值：阿里百炼 text-embedding-v4 / 1024 维 */
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
}

/** 索引中的一条切块记录（子块带 parentId 且独有向量，父块不嵌向量） */
export interface ChunkRecord {
  id: string
  docId: string
  parentId?: string
  /** 标题路径（如 "React > Hooks > useEffect"），Markdown 切块时写入并拼进 embedding 文本前缀 */
  headingPath?: string
  charStart: number
  charEnd: number
  text: string
  embedding?: number[]
}

/** 向量索引（index.json）：embedding 快照供换模型/维度时惰性比对 */
export interface KnowledgeIndex {
  version: number
  embeddingModel: string
  embeddingDimensions: number
  chunks: ChunkRecord[]
}

/** 文档类型：笔记 / PDF 文本抽取 / 会话沉淀 */
export type DocType = 'note' | 'pdf' | 'distilled'

/** 文档 frontmatter（docs/<docId>.md 头部）：用户原始文件不复制，只记来源路径 */
export interface DocFrontmatter {
  sourcePath: string
  type: DocType
  contentHash: string
  createdAt: string
}
