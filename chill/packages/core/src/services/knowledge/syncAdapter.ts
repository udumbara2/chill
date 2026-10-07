import type { DocFrontmatter, KnowledgeBaseConfig } from './types'

/**
 * 知识库快照同步接口（二期任务 6：只定义，不实现远端；设计见 iDream/知识管理.md 第八节第 3 条）
 *
 * 设计意图：
 * - 快照只含"不可再生的数据"：kb.json 库元数据 + docs/ 文档正本（frontmatter + 正文）
 * - **索引（index.json）不备**：向量索引是 docs/ 正本的易失推导物，且随 embedding 模型/维度/
 *   增强开关变化而失效；导入快照后由调用方走 rebuildIndex 从正本再生（恢复即重建），
 *   既省一半以上快照体积，又天然规避"备份的索引与当前配置不一致"的腐败状态
 * - kb.json 内的 embedding 快照与 enhancements 开关随快照走，导入后既有惰性比对
 *   （isIndexEmbeddingCurrent / enhancements 指纹）会在配置不同时给出重建提示，无需额外机制
 *
 * 三期 OSS adapter 接入约定：
 * - 远端适配器（OSS/WebDAV/…）实现本接口即可，上层不感知传输细节
 * - 快照体视为可 JSON 序列化的纯数据（往返 JSON.parse(JSON.stringify(x)) 必须自洽），
 *   传输编码（分片/压缩/加密）由适配器内部决定
 * - 远端凭证**不进快照、不落 knowledge.json**，统一走 SecureStorageService
 *   （仿 embedding key 的 `knowledge-embedding` provider id 先例，按适配器各起 id）
 * - 冲突策略二期不定（单用户场景先"后写 wins"）；多设备合并留三期随实现一并定稿
 *
 * 注：按设计本接口原拟放 types.ts，因二期并行开发避免文件冲突而独立成文件，
 * 导出汇总由 index.ts 统一处理。
 */

/** 快照格式版本（结构变更时递增，供导入方判断兼容性） */
export const KNOWLEDGE_SNAPSHOT_VERSION = 1

/** 快照中的一篇文档正本（对应 docs/<docId>.md 的解析形态） */
export interface KnowledgeSnapshotDoc {
  docId: string
  frontmatter: DocFrontmatter
  body: string
}

/** 知识库快照：版本 + 导出时间 + kb.json 内容 + docs/ 正本数组（不含 index.json） */
export interface KnowledgeSnapshot {
  version: number
  /** ISO 8601 导出时间 */
  exportedAt: string
  kb: KnowledgeBaseConfig
  docs: KnowledgeSnapshotDoc[]
}

/**
 * 快照同步适配器：导出一个库的快照 / 把快照落回本地存储。
 * importSnapshot 只负责写 kb.json 与 docs/ 正本；索引由调用方随后 rebuildIndex 再生。
 */
export interface KnowledgeSyncAdapter {
  exportSnapshot(kbName: string): Promise<KnowledgeSnapshot>
  importSnapshot(snapshot: KnowledgeSnapshot): Promise<void>
}
