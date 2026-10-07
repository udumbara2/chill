import * as path from 'path'
import type { IFileSystemProvider } from '../../interfaces/IFileSystemProvider'
import type { IPathProvider } from '../../interfaces/IPathProvider'
import {
  DEFAULT_KNOWLEDGE_CONFIG,
  type DocFrontmatter,
  type DocType,
  type EnhancementsConfig,
  type KnowledgeBaseConfig,
  type KnowledgeGlobalConfig,
  type KnowledgeIndex,
} from './types'

/**
 * 知识库存储（~/.chill/knowledge/，JSON + Markdown，无第三方依赖）
 *
 * 本骨架只管读写：全局配置（knowledge.json 读取时合并默认值）、知识库 CRUD（一库一目录）、
 * docs/ 正本与 index.json 读写原语、embedding 快照惰性比对。embedding/切块/检索在后续任务叠加。
 * 换 embedding 模型/维度时比对 index.json 快照与全局配置，不一致由上层返回重建提示（不在启动期输出）。
 */

const DOC_TYPES: DocType[] = ['note', 'pdf', 'office', 'image', 'distilled']

/** 当前索引格式版本（结构变更时递增，供上层判断重建） */
export const KNOWLEDGE_INDEX_VERSION = 1

/** 解析生效的增强配置：kb.json 的逐库覆盖优先于 knowledge.json 的全局默认 */
export function resolveEnhancements(
  config: KnowledgeGlobalConfig,
  kbConfig?: KnowledgeBaseConfig | null
): EnhancementsConfig {
  return { ...config.enhancements, ...(kbConfig?.enhancements ?? {}) }
}

/** 增强指纹：生效增强配置的稳定序列化（键序固定），开关任一变更即产生新指纹 */
export function computeEnhancementsFingerprint(enhancements: EnhancementsConfig): string {
  return JSON.stringify({
    summaryLayer: enhancements.summaryLayer,
    contextualPrefix: enhancements.contextualPrefix,
  })
}

/** 空索引（带当前全局 embedding 快照 + 生效增强指纹） */
export function emptyKnowledgeIndex(config: KnowledgeGlobalConfig, kbConfig?: KnowledgeBaseConfig | null): KnowledgeIndex {
  return {
    version: KNOWLEDGE_INDEX_VERSION,
    embeddingModel: config.embedding.model,
    embeddingDimensions: config.embedding.dimensions,
    enhancementsFingerprint: computeEnhancementsFingerprint(resolveEnhancements(config, kbConfig)),
    chunks: [],
  }
}

/** 库名校验：作为目录名使用，拒绝空名/路径分隔符/Windows 保留字符 */
export function isValidKbName(name: string): boolean {
  const n = (name ?? '').trim()
  return n.length > 0 && n !== '.' && n !== '..' && !/[\\/:*?"<>|]/.test(n)
}

function serializeDoc(frontmatter: DocFrontmatter, body: string): string {
  const lines = [
    `sourcePath: ${frontmatter.sourcePath}`,
    `type: ${frontmatter.type}`,
    `contentHash: ${frontmatter.contentHash}`,
    `createdAt: ${frontmatter.createdAt}`,
  ]
  return `---\n${lines.join('\n')}\n---\n\n${body.trim()}\n`
}

/** 解析文档正本（同 memoryStore 的简易 frontmatter 格式；损坏返回 null） */
function parseDoc(raw: string): { frontmatter: DocFrontmatter; body: string } | null {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!m) return null
  const meta: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':')
    if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  const type = (DOC_TYPES as string[]).includes(meta.type) ? (meta.type as DocType) : 'note'
  return {
    frontmatter: {
      sourcePath: meta.sourcePath || '',
      type,
      contentHash: meta.contentHash || '',
      createdAt: meta.createdAt || '',
    },
    body: raw.slice(m[0].length).trim(),
  }
}

export class KnowledgeStore {
  private static instance: KnowledgeStore
  private fsProvider: IFileSystemProvider | null = null
  private pathProvider: IPathProvider | null = null

  private constructor() {}

  static getInstance(): KnowledgeStore {
    if (!KnowledgeStore.instance) KnowledgeStore.instance = new KnowledgeStore()
    return KnowledgeStore.instance
  }

  /** 注入平台实现：CLI 注 Node provider，UI 注 Electron IPC provider */
  init(fsProvider: IFileSystemProvider, pathProvider: IPathProvider): void {
    this.fsProvider = fsProvider
    this.pathProvider = pathProvider
  }

  isReady(): boolean {
    return this.fsProvider !== null && this.pathProvider !== null
  }

  /** 未初始化时抛明确错误（知识库操作不允许静默降级） */
  private requireReady(): void {
    if (!this.isReady()) throw new Error('KnowledgeStore 未初始化（缺 fsProvider 或 pathProvider）')
  }

  knowledgeDir(): string {
    if (!this.pathProvider) throw new Error('KnowledgeStore 未初始化（缺 pathProvider）')
    return path.join(this.pathProvider.getUserDataPath(), 'knowledge')
  }

  private kbDir(name: string): string {
    return path.join(this.knowledgeDir(), name)
  }

  private docsDir(name: string): string {
    return path.join(this.kbDir(name), 'docs')
  }

  // ==================== 全局配置（knowledge.json） ====================

  private globalConfigFile(): string {
    return path.join(this.knowledgeDir(), 'knowledge.json')
  }

  /** 读取全局配置（不存在/损坏返回默认值；部分字段缺失逐节合并默认值） */
  async getGlobalConfig(): Promise<KnowledgeGlobalConfig> {
    this.requireReady()
    const d = DEFAULT_KNOWLEDGE_CONFIG
    try {
      const read = await this.fsProvider!.readFile(this.globalConfigFile())
      if (!read.success) return structuredClone(d)
      const raw: string = read.data?.content ?? read.data ?? ''
      const parsed = JSON.parse(typeof raw === 'string' ? raw : String(raw))
      if (!parsed || typeof parsed !== 'object') return structuredClone(d)
      return {
        embedding: { ...d.embedding, ...(parsed.embedding ?? {}) },
        rerank: { ...d.rerank, ...(parsed.rerank ?? {}) },
        retrieval: { ...d.retrieval, ...(parsed.retrieval ?? {}) },
        enhancements: { ...d.enhancements, ...(parsed.enhancements ?? {}) },
      }
    } catch {
      return structuredClone(d)
    }
  }

  async saveGlobalConfig(config: KnowledgeGlobalConfig): Promise<{ success: boolean; error?: string }> {
    this.requireReady()
    const write = await this.fsProvider!.writeFile(this.globalConfigFile(), JSON.stringify(config, null, 2))
    if (!write.success) return { success: false, error: write.error || '写入全局配置失败' }
    return { success: true }
  }

  // ==================== 知识库 CRUD ====================

  /** 列出全部知识库（按名称升序；kb.json 损坏的目录跳过） */
  async listKnowledgeBases(): Promise<KnowledgeBaseConfig[]> {
    this.requireReady()
    const result = await this.fsProvider!.listDirectory(this.knowledgeDir())
    if (!result.success) return []
    const files: Array<{ name: string; type: string }> = result.data?.files ?? result.data?.data?.files ?? []
    const kbs: KnowledgeBaseConfig[] = []
    for (const f of files) {
      if (f.type !== 'directory') continue
      const config = await this.getKnowledgeBaseConfig(f.name)
      if (config) kbs.push(config)
    }
    return kbs.sort((a, b) => a.name.localeCompare(b.name))
  }

  /** 读取单个库的 kb.json（不存在/损坏返回 null）。兼容说明：一期 kb.json 无 enhancements 字段，
   *  按可选覆盖处理（缺省落回全局默认），无需迁移 */
  async getKnowledgeBaseConfig(name: string): Promise<KnowledgeBaseConfig | null> {
    this.requireReady()
    try {
      const read = await this.fsProvider!.readFile(path.join(this.kbDir(name), 'kb.json'))
      if (!read.success) return null
      const raw: string = read.data?.content ?? read.data ?? ''
      const parsed = JSON.parse(typeof raw === 'string' ? raw : String(raw))
      if (!parsed || typeof parsed !== 'object' || typeof parsed.name !== 'string') return null
      return parsed as KnowledgeBaseConfig
    } catch {
      return null
    }
  }

  /** 建库：写 kb.json（embedding 快照取自当前全局配置）；重名或非法名返回错误 */
  async createKnowledgeBase(name: string, description = ''): Promise<{ success: boolean; error?: string }> {
    this.requireReady()
    const trimmed = (name ?? '').trim()
    if (!isValidKbName(trimmed)) return { success: false, error: `非法知识库名: ${name}` }
    if (await this.getKnowledgeBaseConfig(trimmed)) return { success: false, error: `知识库已存在: ${trimmed}` }
    const config = await this.getGlobalConfig()
    const kbConfig: KnowledgeBaseConfig = {
      name: trimmed,
      description,
      createdAt: new Date().toISOString(),
      embeddingModel: config.embedding.model,
      embeddingDimensions: config.embedding.dimensions,
    }
    const write = await this.fsProvider!.writeFile(
      path.join(this.kbDir(trimmed), 'kb.json'),
      JSON.stringify(kbConfig, null, 2)
    )
    if (!write.success) return { success: false, error: write.error || '写入 kb.json 失败' }
    return { success: true }
  }

  /** 删库：整目录删除（含 docs/ 与 index.json） */
  async deleteKnowledgeBase(name: string): Promise<{ success: boolean; error?: string }> {
    this.requireReady()
    if (!(await this.getKnowledgeBaseConfig(name))) return { success: false, error: `未找到知识库: ${name}` }
    const del = await this.fsProvider!.deleteFile(this.kbDir(name))
    if (!del.success) return { success: false, error: del.error || '删除知识库失败' }
    return { success: true }
  }

  // ==================== 索引（index.json） ====================

  /** 读索引（不存在/损坏返回 null）。兼容说明：一期 index.json 无 enhancementsFingerprint 字段，
   *  此处原样读出（undefined），由 isIndexEmbeddingCurrent 判为不一致并提示重建 */
  async readIndex(name: string): Promise<KnowledgeIndex | null> {
    this.requireReady()
    try {
      const read = await this.fsProvider!.readFile(path.join(this.kbDir(name), 'index.json'))
      if (!read.success) return null
      const raw: string = read.data?.content ?? read.data ?? ''
      const parsed = JSON.parse(typeof raw === 'string' ? raw : String(raw))
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.chunks)) return null
      return parsed as KnowledgeIndex
    } catch {
      return null
    }
  }

  async saveIndex(name: string, index: KnowledgeIndex): Promise<{ success: boolean; error?: string }> {
    this.requireReady()
    const write = await this.fsProvider!.writeFile(
      path.join(this.kbDir(name), 'index.json'),
      JSON.stringify(index)
    )
    if (!write.success) return { success: false, error: write.error || '写入索引失败' }
    return { success: true }
  }

  /**
   * 惰性比对：index.json 的 embedding 快照 + 增强指纹是否与当前生效配置一致。
   * 不一致（换了模型/维度/增强开关）时上层应提示重建；无索引视为一致（无内容可重建）。
   * 兼容说明：一期 index.json 无 enhancementsFingerprint 字段，比对必然失败 → 视为不一致，
   * 用户现有库会触发一次重建提示（重建后即带指纹，属预期行为）。
   */
  async isIndexEmbeddingCurrent(name: string): Promise<boolean> {
    this.requireReady()
    const index = await this.readIndex(name)
    if (!index) return true
    const config = await this.getGlobalConfig()
    const kbConfig = await this.getKnowledgeBaseConfig(name)
    return index.embeddingModel === config.embedding.model
      && index.embeddingDimensions === config.embedding.dimensions
      && index.enhancementsFingerprint === computeEnhancementsFingerprint(resolveEnhancements(config, kbConfig))
  }

  // ==================== 文档正本（docs/<docId>.md） ====================

  /** 读文档（不存在/损坏返回 null） */
  async readDoc(name: string, docId: string): Promise<{ frontmatter: DocFrontmatter; body: string } | null> {
    this.requireReady()
    const read = await this.fsProvider!.readFile(path.join(this.docsDir(name), `${docId}.md`))
    if (!read.success) return null
    const raw: string = read.data?.content ?? read.data ?? ''
    return parseDoc(typeof raw === 'string' ? raw : String(raw))
  }

  async saveDoc(name: string, docId: string, frontmatter: DocFrontmatter, body: string): Promise<{ success: boolean; error?: string }> {
    this.requireReady()
    const write = await this.fsProvider!.writeFile(
      path.join(this.docsDir(name), `${docId}.md`),
      serializeDoc(frontmatter, body)
    )
    if (!write.success) return { success: false, error: write.error || '写入文档失败' }
    return { success: true }
  }

  async deleteDoc(name: string, docId: string): Promise<{ success: boolean; error?: string }> {
    this.requireReady()
    const del = await this.fsProvider!.deleteFile(path.join(this.docsDir(name), `${docId}.md`))
    if (!del.success) return { success: false, error: del.error || '删除文档失败' }
    return { success: true }
  }

  /** 列出库内全部 docId（按名称升序） */
  async listDocs(name: string): Promise<string[]> {
    this.requireReady()
    const result = await this.fsProvider!.listDirectory(this.docsDir(name))
    if (!result.success) return []
    const files: Array<{ name: string; type: string }> = result.data?.files ?? result.data?.data?.files ?? []
    return files
      .filter(f => f.type === 'file' && f.name.endsWith('.md'))
      .map(f => f.name.replace(/\.md$/, ''))
      .sort((a, b) => a.localeCompare(b))
  }
}

export const knowledgeStore = KnowledgeStore.getInstance()
