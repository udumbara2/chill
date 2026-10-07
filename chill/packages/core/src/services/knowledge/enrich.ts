import type {
  ChunkRecord,
  DocType,
  EnhancementsConfig,
  KnowledgeBaseConfig,
  KnowledgeGlobalConfig,
} from './types'
import { summaryEnricher } from './summaryEnricher'
import { contextualPrefixEnricher } from './contextualPrefixEnricher'

/**
 * enrich 阶段接口（二期管线阶段化，设计见 iDream/知识管理.md 第八节）。
 *
 * 摄入管线显式化为 extract → chunk → enrich → embed → 落盘后，enrich 是切块与嵌向量之间的
 * 增强挂点：任务 3 的摘要层、任务 4 的 LLM 定位前缀都作为 enricher 接入，ingest 与 rebuild
 * 走同一管线（processDocument），增强不会在重建时静默丢失。
 *
 * 现有的"标题路径前缀"逻辑（chunker.ts 的 embeddingText）在 embed 时拼前缀，视作隐式 enricher，
 * 保持原样不搬动。DEFAULT_ENRICHERS 为常驻 enricher（仍为空）；摘要层（summaryEnricher，任务 3）
 * 与定位前缀（contextualPrefixEnricher，任务 4）按各自开关经 resolveActiveEnrichers 门控启用，不常驻。
 *
 * 失败降级契约：单个 enricher 抛错/拒约时降级为无增强继续，错误收集进 warnings，不得阻塞摄入。
 */

/** enrich 阶段输入：切块产物 + 文档全文 + 上下文（含生效的增强配置） */
export interface EnrichInput {
  /** 切块产物（父块 + 子块扁平数组）；enricher 链式传递，每个 enricher 看到的是上一个的输出 */
  chunks: ChunkRecord[]
  /** 文档全文（已 trim） */
  text: string
  docId: string
  docType: DocType
  /** 生效的增强配置（库覆盖优先于全局默认，已解析） */
  enhancements: EnhancementsConfig
  config: KnowledgeGlobalConfig
  kbConfig: KnowledgeBaseConfig
}

/**
 * chunk 增强器：输入切块产物与文档上下文，返回修改/附加后的完整 chunk 数组
 * （附加 chunks 如摘要块直接并入返回数组；修改 embedding 文本通过改写 chunk 实现）。
 * 返回 void 表示不做任何改动。实现可为同步或异步（LLM 调用）。
 */
export interface ChunkEnricher {
  /** 增强器名（用于降级告警文案） */
  name: string
  enrich(input: EnrichInput): Promise<ChunkRecord[] | void> | ChunkRecord[] | void
}

/** enrich 阶段输出：最终 chunk 数组 + 降级告警 */
export interface EnrichOutcome {
  chunks: ChunkRecord[]
  warnings: string[]
}

/**
 * 依次执行 enricher 链（输出作为下一个的输入）。单个 enricher 失败（抛错/拒约）
 * 降级为跳过该增强继续，收集告警；绝不向外抛错——增强是质量优化，不得阻塞摄入。
 */
export async function runEnrichers(input: EnrichInput, enrichers: ChunkEnricher[]): Promise<EnrichOutcome> {
  let chunks = input.chunks
  const warnings: string[] = []
  for (const enricher of enrichers) {
    try {
      const out = await enricher.enrich({ ...input, chunks })
      if (out) chunks = out
    } catch (e) {
      warnings.push(`增强 "${enricher.name}" 失败，已降级为无增强继续: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return { chunks, warnings }
}

/** 当前生效的 enricher 列表（任务 3/4 的摘要层/定位前缀经 resolveActiveEnrichers 按开关追加；常驻为空） */
export const DEFAULT_ENRICHERS: ChunkEnricher[] = []

/**
 * 按生效增强配置解析实际启用的 enricher 链：常驻 enricher（base，缺省 DEFAULT_ENRICHERS）
 * 在前，开关门控的增强 enricher 追加在后。摘要层（summaryLayer）与定位前缀（contextualPrefix）
 * 只在各自开关开启时启用（关闭即零 LLM 调用）；两开关同开时摘要层在前（追加摘要块）、
 * 定位前缀在后（只改写子块的 contextPrefix，二者互不干扰）。
 */
export function resolveActiveEnrichers(
  enhancements: EnhancementsConfig,
  base: ChunkEnricher[] = DEFAULT_ENRICHERS
): ChunkEnricher[] {
  const active = [...base]
  if (enhancements.summaryLayer) active.push(summaryEnricher)
  if (enhancements.contextualPrefix) active.push(contextualPrefixEnricher)
  return active
}
