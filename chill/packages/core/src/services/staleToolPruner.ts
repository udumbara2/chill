import type { Message } from '../types/models'

/**
 * R1 确定性剪枝（发送视图的纯投影变换；services/contextPressure 的同级纯函数模块）：
 * 较早轮次的超大 TOOL 结果在投影中截为头/尾预览 + 标记，削减每轮重发的死重量。
 *
 * 纪律（规划 v1 §五 R1）：
 * - **纯投影**：不改权威历史、不 spill、不落盘——下轮组装现算，天然 replay-safe；
 * - **全函数**：任何异常回退"原样不剪枝"，绝不让剪枝炸掉发送；
 * - **只改 content 字段**：toolCallId/timestamp/结构原样保留，toolCalls/TOOL 配对天然完整；
 * - **轮口径与 compactHistory/媒体保留一致**：以 user 消息为轮边界，最近 keepRounds=2 轮不动。
 *
 * 参数对齐行业实践（DSH ToolResultPruner 同量级）：阈值 8192 字符、头 4096 + 尾 1024。
 */

/** 超过此字符数的旧轮 TOOL 结果才剪枝（8192 与 DSH thresholdChars 同值） */
export const PRUNE_THRESHOLD_CHARS = 8192
/** 剪枝后保留的头部字符数 */
export const PRUNE_HEAD_CHARS = 4096
/** 剪枝后保留的尾部字符数 */
export const PRUNE_TAIL_CHARS = 1024
/** 中段替换标记（诚实文案：全文在会话记录中；不承诺 read_file——工具结果不是文件） */
export const PRUNE_MARKER =
  '\n\n[...旧工具结果中段已剪枝（完整结果保留在会话记录中；如需其中细节请说明）...]\n\n'

/** role 的运行时字符串值（enum 值即 'user'/'tool'；测试环境不可运行时导入 enum，统一字面量） */
const ROLE_USER = 'user'
const ROLE_TOOL = 'tool'

/** UTF-16 码元切片的代理对安全修正：边界落在代理对中间时整体包含该字符对 */
function sliceCodePointSafe(text: string, start: number, end: number): string {
  let s = start
  let e = end
  // 边界处是低位代理 → 说明切在代理对中间：起点前移、终点后移，保证不产生孤立代理
  if (s > 0 && s < text.length && (text.charCodeAt(s) & 0xfc00) === 0xdc00) s -= 1
  if (e > 0 && e < text.length && (text.charCodeAt(e) & 0xfc00) === 0xdc00) e += 1
  return text.slice(Math.max(0, s), Math.min(text.length, e))
}

/**
 * 剪枝旧轮超大 TOOL 结果（纯函数）。
 * @param messages 发送视图切片（buildEffectiveHistory 的产物；含压缩摘要合成消息也无妨——
 *   合成消息 role=user，只会影响轮边界计数，语义正确）
 * @param keepRounds 最近 N 轮原文保留（缺省 2，与 compactHistory 保留尾/媒体保留窗口同口径）
 * @returns 新数组（无可剪枝时原样返回同一引用，零分配）
 */
export function pruneStaleToolResults(messages: Message[], keepRounds = 2): Message[] {
  try {
    const userIdxes: number[] = []
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === ROLE_USER) userIdxes.push(i)
    }
    // user 消息不足 keepRounds+1 条：全部内容都在保留窗口内（与 compactHistory 的轮口径一致）
    if (userIdxes.length <= keepRounds) return messages
    const staleBefore = userIdxes[userIdxes.length - keepRounds]

    let changed = false
    const out = messages.map((m, i) => {
      if (i >= staleBefore || m.role !== ROLE_TOOL) return m
      const text = typeof m.content === 'string' ? m.content : ''
      if (text.length <= PRUNE_THRESHOLD_CHARS) return m
      changed = true
      return {
        ...m,
        content:
          sliceCodePointSafe(text, 0, PRUNE_HEAD_CHARS) +
          PRUNE_MARKER +
          sliceCodePointSafe(text, text.length - PRUNE_TAIL_CHARS, text.length),
      }
    })
    return changed ? out : messages
  } catch {
    // 全函数纪律：异常回退原样（宁可重发全文，不让剪枝炸掉发送）
    return messages
  }
}
