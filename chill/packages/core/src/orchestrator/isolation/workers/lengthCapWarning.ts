/**
 * 输出长度封顶的诚实标记（纯函数，独立成模块供测试——Worker 主文件 import 即启动，不可被测试引用）：
 * 非空输出顶到 maxTokens 时在尾部追加警告。不判失败（部分内容仍有用），
 * 但静默截断 = 结果保真链断裂，调用方必须知道并可按指引调大配额重派。
 */
export function appendLengthCapWarning(
  content: string,
  completionTokens: number,
  maxTokens: number
): string {
  if (completionTokens < maxTokens) return content
  return (
    content +
    `\n\n【警告】输出已达 maxTokens 上限（${maxTokens}），内容可能不完整，` +
    `可用 override_parameters.max_tokens 调大后重试。`
  )
}
