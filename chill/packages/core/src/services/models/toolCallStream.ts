/**
 * toolCallStream.ts — 流式工具调用分片的单调累积器（纯函数、Node-free）。
 *
 * 边界防御第一闸（M7 增量 3 · 决策 26）：分片只能增加信息，不能减少。
 * null / 空串 / 缺键 = 无信息，一律不覆盖已累积的好值——事故（2026-09-26）中
 * 服务端分片带显式 `"id": null`，旧实现按"键存在即覆盖"把好值抹掉（或原样收下
 * 首片 null），落盘成畸形 toolCalls 后每次请求被服务端秒拒，会话永久砖死。
 *
 * 终局 finalizeToolCalls 校验 id / function.name / arguments；畸形抛
 * MalformedToolCallError，由 openAIChatHandler 的重试包装丢弃该轮输出
 * （工具从未执行，无副作用）并重发一次请求。
 */

/** 畸形工具调用（终局校验不通过）：调用方应丢弃本轮模型输出并有限重试，绝不执行 */
export class MalformedToolCallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MalformedToolCallError'
  }
}

/**
 * 畸形自动重试一次（决策 26）：首次 MalformedToolCallError → 丢弃本轮输出重发一次
 * （工具从未执行、无副作用）；aborted() 为真不重试；第二次仍畸形或其他异常原样上抛。
 */
export async function withMalformedRetry<T>(fn: () => Promise<T>, aborted?: () => boolean): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof MalformedToolCallError && !(aborted?.() ?? false)) {
      return await fn()
    }
    throw err
  }
}

/** 「有信息」判定：非空白字符串才算（null/undefined/空串/纯空白不携带身份） */
function informative(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

/** 单调合并单个槽位：frag 携带的信息只增不减 */
function mergeSlot(prev: any, frag: any): any {
  const prevFn = (prev && typeof prev.function === 'object' && prev.function) || {}
  const fragFn = (frag && typeof frag.function === 'object' && frag.function) || {}
  const id = informative(frag?.id) ? frag.id : informative(prev?.id) ? prev.id : undefined
  const name = informative(fragFn.name) ? fragFn.name : informative(prevFn.name) ? prevFn.name : undefined
  const prevArgs = typeof prevFn.arguments === 'string' ? prevFn.arguments : ''
  const fragArgs = typeof fragFn.arguments === 'string' ? fragFn.arguments : ''
  const out: any = {
    ...prev,
    ...frag,
    function: {
      ...prevFn,
      ...fragFn,
      arguments: prevArgs + fragArgs,
    },
  }
  // 修掉"键存在即覆盖（含 null）"的陷阱：无信息的 id/name 不落键
  //（缺失与显式 null 在终局校验处同罪；区别只是落盘形态——jsonify 时缺失键自然省略）
  if (id !== undefined) out.id = id
  else delete out.id
  if (name !== undefined) out.function.name = name
  else delete out.function.name
  return out
}

/**
 * 累积流式分片。槽位语义与旧 processStreamToolCalls 对齐：有 index 且在界内 = 合并，
 * 否则开新槽；差异仅在合并是**单调**的——null/空/缺键不覆盖好值，arguments 只拼接。
 */
export function accumulateToolCallDelta(delta: any, currentToolCalls: any[]): any[] {
  const toolCalls = currentToolCalls
  if (!delta || !Array.isArray(delta.tool_calls)) return toolCalls
  for (const frag of delta.tool_calls) {
    if (!frag || typeof frag !== 'object') continue
    const index = frag.index
    if (typeof index === 'number' && index >= 0 && index < toolCalls.length) {
      toolCalls[index] = mergeSlot(toolCalls[index], frag)
    } else {
      // 新槽原样入列（显式 null 保留原样，终局校验把关）；浅拷贝同旧实现（分片不复用）
      toolCalls.push({ ...frag })
    }
  }
  return toolCalls
}

/**
 * 终局校验：id / function.name 必须为非空白字符串；arguments 空/全空白合法（无参调用），
 * **非空但 JSON.parse 失败判畸形**（典型：流被截断——绝不静默置空执行）。
 * 空列表直接通过。不通过抛 MalformedToolCallError（含全部问题项明细）。
 */
export function finalizeToolCalls(toolCalls: any[] | undefined): any[] {
  if (!toolCalls || toolCalls.length === 0) return []
  const problems: string[] = []
  toolCalls.forEach((tc, i) => {
    const fn = (tc && typeof tc.function === 'object' && tc.function) || {}
    if (!informative(tc?.id)) problems.push(`第${i + 1}项 id 缺失或为空`)
    if (!informative(fn.name)) problems.push(`第${i + 1}项 function.name 缺失或为空`)
    const args = typeof fn.arguments === 'string' ? fn.arguments : ''
    if (args.trim().length > 0) {
      try {
        JSON.parse(args)
      } catch {
        problems.push(`第${i + 1}项 arguments 非合法 JSON（疑似流截断）`)
      }
    }
  })
  if (problems.length > 0) {
    throw new MalformedToolCallError(`模型返回了畸形的工具调用：${problems.join('；')}`)
  }
  return toolCalls
}
