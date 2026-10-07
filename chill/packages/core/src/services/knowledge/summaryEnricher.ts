import type { Message } from '../../types/models'
import { ModelServiceFactory } from '../models/modelServiceFactory'
import { SelectedModelsService } from '../selectedModelsService'
import type { ChunkEnricher, EnrichInput } from './enrich'
import { resolveChunkKind, type ChunkRecord } from './types'

/**
 * 摘要层 enricher（二期任务 3，设计见 iDream/知识管理.md 第八节第 2 条）。
 *
 * 摘要即 chunk：摄入/重建时为文档生成摘要块（kind='summary'、带 embedding、text 为摘要正文），
 * 参与同一向量索引的独立召回路（retriever 的 summary 源），命中返回"摘要 + 下钻指引"。
 *
 * 分层按 DocType：
 * - note（Markdown）：章节级（每个父块一条摘要，parentId 指向该章父块）+ 文档级（parentId 为空）
 * - pdf：父块级 + 全书级（结构同上，纯文本切块无标题路径）
 * - distilled：跳过（每条一个 chunk，本身即完整知识，无需摘要）
 *
 * LLM 调用走同类路径（ModelServiceFactory.sendChatMessage，用户当前选中模型，零新配置）。
 * 开关默认关：enhancements.summaryLayer 关闭时直接返回，零 LLM 调用。
 * 失败降级契约：任何 LLM 调用失败抛错，由 runEnrichers 收集告警并降级为无摘要摄入，不阻塞入库。
 */

/** 单次摘要输入的最大字符数（超出截断，控制 token 成本） */
const MAX_SUMMARY_INPUT_CHARS = 3000

const SUMMARY_SYSTEM_PROMPT = `你是知识库摘要器。为用户提供的内容写一段简明摘要（100 字以内），用于检索召回。
要求：概括主题与关键结论；保留专有名词、术语与数字；直接输出摘要正文，不要列表、不要前缀解释。`

/** 调当前选中聊天模型生成一段摘要；空响应视为失败（抛错走降级） */
async function summarize(modelName: string, label: string, text: string): Promise<string> {
  const truncated = text.length > MAX_SUMMARY_INPUT_CHARS ? `${text.slice(0, MAX_SUMMARY_INPUT_CHARS)}…` : text
  const messages: Message[] = [
    { role: 'system' as Message['role'], content: SUMMARY_SYSTEM_PROMPT, timestamp: new Date() },
    { role: 'user' as Message['role'], content: `【${label}】\n${truncated}`, timestamp: new Date() },
  ]
  const response = await ModelServiceFactory.getInstance().sendChatMessage(modelName, messages, {})
  const summary = (response?.content ?? '').trim()
  if (!summary) throw new Error('模型返回了空摘要')
  return summary
}

/**
 * 摘要层 enricher。注册路径见 enrich.ts 的 resolveActiveEnrichers（按 summaryLayer 开关门控，
 * 不在 DEFAULT_ENRICHERS 常驻列表里）；此处仍自检开关作为双保险。
 */
export const summaryEnricher: ChunkEnricher = {
  name: '摘要层',
  async enrich(input: EnrichInput): Promise<ChunkRecord[] | void> {
    if (!input.enhancements.summaryLayer) return // 开关关闭：零 LLM 调用
    if (input.docType === 'distilled') return // 沉淀知识跳过增强

    const modelName = SelectedModelsService.getInstance().getCurrentModelName()
    if (!modelName) throw new Error('未选择聊天模型，无法生成摘要（请先在设置中选择模型）')

    const parents = input.chunks.filter(c => resolveChunkKind(c) === 'parent')
    if (parents.length === 0) return

    const summaries: ChunkRecord[] = []
    let seq = 0
    // 章节级（note）/ 父块级（pdf）：每个父块一条摘要，parentId 指向该父块，标题路径随行
    for (const parent of parents) {
      const label = parent.headingPath ? `章节「${parent.headingPath}」内容` : '文档片段内容'
      summaries.push({
        id: `${input.docId}-s${seq++}`,
        docId: input.docId,
        parentId: parent.id,
        kind: 'summary',
        headingPath: parent.headingPath,
        charStart: parent.charStart,
        charEnd: parent.charEnd,
        text: await summarize(modelName, label, parent.text),
      })
    }
    // 文档级（note）/ 全书级（pdf）：parentId 为空，覆盖全文区间
    summaries.push({
      id: `${input.docId}-s${seq++}`,
      docId: input.docId,
      kind: 'summary',
      charStart: 0,
      charEnd: input.text.length,
      text: await summarize(modelName, '整篇文档内容', input.text),
    })
    return [...input.chunks, ...summaries]
  },
}
