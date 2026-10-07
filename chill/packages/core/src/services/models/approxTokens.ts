/**
 * 无 usage 回报时的 token 估值(计量中间件 · 迭代 1)
 *
 * 唯一估值点:服务商不回 usage(或全 0)时,由 BaseModelService 聚合层按本函数估值,
 * 下游(Worker/执行器/账本)纯透传不二次估。比率沿用代码库既有先例口径 2 字符/token
 * (ChatEngine 压缩检查点 usageAfterApproxTokens),预算闸是粗粒度信号,`~` 标注近似属性。
 *
 * 字符统计覆盖完整计费载荷(thinking 模型的推理 token 与工具参数都计费):
 *   输入侧 = Σ 每条消息的 messageText(复用 compactionService 导出,媒体块占位防爆估)
 *            + reasoningContent + toolCalls 序列化;
 *   输出侧 = content + reasoningContent + toolCalls 序列化。
 * 与 ChatEngine:1273 先例同一比率、各自载荷(先例只量文本占用故不含这两项,不反向改它)。
 */

import type { Message, ModelResponse } from '../../types/models'
import { messageText } from '../compaction/compactionService'

/** 先例比率:2 字符 ≈ 1 token;下限 1(空响应也至少计 1,防 0 值被当"无计量数据") */
const approx = (chars: number): number => Math.max(1, Math.round(chars / 2))

/** 单条消息的计费载荷字符数(纯文本 + 推理内容 + 工具调用参数序列化) */
function messageChars(m: Message): number {
  let chars = messageText(m).length
  if (m.reasoningContent) chars += m.reasoningContent.length
  if (m.toolCalls && m.toolCalls.length > 0) chars += JSON.stringify(m.toolCalls).length
  return chars
}

/**
 * 单轮请求-响应的 token 估值:promptTokens = 输入侧,completionTokens = 输出侧。
 * 仅在服务商未回报 usage 时由中间件聚合层调用。
 */
export function approxTokensForRound(
  processedMessages: Message[],
  response: ModelResponse,
): { promptTokens: number; completionTokens: number; totalTokens: number } {
  const inChars = processedMessages.reduce((sum, m) => sum + messageChars(m), 0)
  let outChars = (response.content ?? '').length
  if (response.reasoningContent) outChars += response.reasoningContent.length
  if (response.toolCalls && response.toolCalls.length > 0) outChars += JSON.stringify(response.toolCalls).length
  const promptTokens = approx(inChars)
  const completionTokens = approx(outChars)
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens }
}
