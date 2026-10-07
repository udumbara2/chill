import type { Message } from '../../types/models'
import { ModelServiceFactory } from '../models/modelServiceFactory'
import { SelectedModelsService } from '../selectedModelsService'
import type { ChunkEnricher, EnrichInput } from './enrich'
import { resolveChunkKind, type ChunkRecord } from './types'

/**
 * LLM 定位前缀 enricher（二期任务 4：Contextual Retrieval，设计见 iDream/知识管理.md 第八节第 2/4 条）。
 *
 * 为每个子块生成 1-2 句定位前缀（"此块出自某文档某章节，讲的是…"），写入 chunk.contextPrefix；
 * embedding 文本由 chunker.embeddingText 组装为 定位前缀 + 标题路径前缀 + 正文，
 * chunk.text 始终保持无前缀的干净正文（检索结果返回给模型无需剥离——根本不混入）。
 *
 * 前缀只加在子块（child）上：父块不嵌向量无需定位；摘要块本身已是全局浓缩，不再叠加；
 * distilled 每条一块、本身即完整知识，跳过增强（与摘要层一致）。
 *
 * LLM 调用走摘要层同款路径（ModelServiceFactory.sendChatMessage，用户当前选中模型，零新配置）。
 * 开关默认关：enhancements.contextualPrefix 关闭时直接返回，零 LLM 调用。
 * 失败降级契约：任何 LLM 调用失败抛错，由 runEnrichers 收集告警并降级为无前缀摄入，不阻塞入库。
 */

/** 喂给模型的文档摘录最大字符数（超出截头，控制 token 成本；定位只需全局语境） */
const MAX_DOC_EXCERPT_CHARS = 3000

const PREFIX_SYSTEM_PROMPT = `你是知识库定位前缀生成器。给你一篇文档的摘录和其中一个内容块，
请用 1-2 句话（50 字以内）写一段定位前缀：说明此块出自文档的什么位置、主要讲的是什么，
用于检索时把块和文档整体语境关联起来。要求：保留专有名词与术语；直接输出前缀正文，不要列表、不要解释。`

/**
 * 调当前选中聊天模型生成一条定位前缀；空响应视为失败（抛错走降级）。
 * user 消息用【文档摘录】/【章节】/【块内容】分节——既给模型清晰结构，也让评测的确定性 mock
 * （tests/knowledge/eval/runEval.ts）能稳定解析出章节与块内容。
 */
async function generatePrefix(modelName: string, docExcerpt: string, chunk: ChunkRecord): Promise<string> {
  const messages: Message[] = [
    { role: 'system' as Message['role'], content: PREFIX_SYSTEM_PROMPT, timestamp: new Date() },
    {
      role: 'user' as Message['role'],
      content: `【文档摘录】\n${docExcerpt}\n【章节】\n${chunk.headingPath ?? '（无标题）'}\n【块内容】\n${chunk.text}`,
      timestamp: new Date(),
    },
  ]
  const response = await ModelServiceFactory.getInstance().sendChatMessage(modelName, messages, {})
  const prefix = (response?.content ?? '').trim()
  if (!prefix) throw new Error('模型返回了空定位前缀')
  return prefix
}

/**
 * 定位前缀 enricher。注册路径见 enrich.ts 的 resolveActiveEnrichers（按 contextualPrefix 开关门控，
 * 不在 DEFAULT_ENRICHERS 常驻列表里）；此处仍自检开关作为双保险。
 */
export const contextualPrefixEnricher: ChunkEnricher = {
  name: '定位前缀',
  async enrich(input: EnrichInput): Promise<ChunkRecord[] | void> {
    if (!input.enhancements.contextualPrefix) return // 开关关闭：零 LLM 调用
    if (input.docType === 'distilled') return // 沉淀知识跳过增强

    const children = input.chunks.filter(c => resolveChunkKind(c) === 'child')
    if (children.length === 0) return

    const modelName = SelectedModelsService.getInstance().getCurrentModelName()
    if (!modelName) throw new Error('未选择聊天模型，无法生成定位前缀（请先在设置中选择模型）')

    const docExcerpt = input.text.length > MAX_DOC_EXCERPT_CHARS
      ? `${input.text.slice(0, MAX_DOC_EXCERPT_CHARS)}…`
      : input.text

    // 每个子块一次 LLM 调用（串行，与摘要层一致；个人规模文档子块数有限）
    const prefixById = new Map<string, string>()
    for (const child of children) {
      prefixById.set(child.id, await generatePrefix(modelName, docExcerpt, child))
    }
    // 只写 contextPrefix 字段，chunk.text 不动（干净正文契约）
    return input.chunks.map(c => {
      const prefix = prefixById.get(c.id)
      return prefix ? { ...c, contextPrefix: prefix } : c
    })
  },
}
