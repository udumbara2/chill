/**
 * Worker 对话消息拼装（纯逻辑，可单测）：
 * - buildSeedMessages：resume 种子续聊的消息序列（原 transcript + 新追问）；
 * - buildConversation：交付时拼完整对话 transcript（resume_task 的留存载体）。
 *
 * 从 GenericSubagentWorker 抽出（Worker 模块 import 即执行 main，不可直接单测），
 * 与 lengthCapWarning.ts 同一先例。
 */

/**
 * resume 种子消息：[...原对话(含 system), 新 user]。
 * 不重复加 system（transcript 已含）、不渲染 userPromptTemplate（追问是直白指令，防二次包装）。
 */
export function buildSeedMessages(priorMessages: unknown[], userMessage: string): unknown[] {
  return [
    ...priorMessages,
    {
      role: 'user',
      content: userMessage,
      timestamp: new Date(),
    },
  ]
}

/**
 * 完整对话 transcript：请求消息（含 system）+ 工具循环增量 + 最终 assistant 消息。
 * producedMessages 不含末轮 assistant 消息（baseModelService 约定，由调用方用响应自行补上）。
 */
export function buildConversation(
  requestMessages: unknown[],
  response: { content?: string; reasoningContent?: string; producedMessages?: unknown[] }
): unknown[] {
  return [
    ...requestMessages,
    ...(response.producedMessages ?? []),
    {
      role: 'assistant',
      content: response.content || '',
      reasoningContent: response.reasoningContent || '',
      timestamp: new Date(),
    },
  ]
}
