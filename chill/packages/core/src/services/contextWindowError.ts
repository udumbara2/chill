/**
 * provider 上下文窗口超限错误识别（R3 溢出恢复的判定；纯函数）。
 *
 * 归一化范围刻意收窄（仅窗口超限一类，不搭通用错误分类框架）：
 * 各 provider 的官方错误码/文案特征做子串匹配——错误经 baseModelService 原样上抛
 * （HTTP 状态与响应体都在 message 里），无需结构化改造即可识别。
 * 泛化模式（如裸 'context window'）误判风险高，不收录：漏判只是少一次自动恢复
 * （原始错误照常上抛），误判会触发不必要的强制压缩。
 */

/** 各 provider 窗口超限的错误特征（message 子串，大小写敏感——官方文案逐字收录） */
const OVERFLOW_PATTERNS: readonly string[] = [
  // OpenAI / DeepSeek（openai-chat 协议；code: 'context_length_exceeded'）
  'context_length_exceeded',
  // OpenAI 部分模型/网关的文案变体
  'maximum context length',
  // Anthropic（Messages API 400：error.message）
  'prompt is too long',
  'input length and `max_tokens` exceed context limit',
]

/** 判定错误是否为上下文窗口超限（R3 恢复路径的唯一触发条件） */
export function isContextWindowExceeded(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  if (!message) return false
  return OVERFLOW_PATTERNS.some((p) => message.includes(p))
}
