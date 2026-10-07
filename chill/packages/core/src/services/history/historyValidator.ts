/**
 * historyValidator.ts — 消息入史合法性校验（纯函数、Node-free）。
 *
 * 边界防御第二闸（M7 增量 3 · 决策 27/28）：只校验【线缆相关】不变量——
 * 事故（2026-09-26）中畸形消息（toolCalls id/name 显式 null、tool 消息 toolCallId null）
 * 未经校验落盘，此后每次模型请求都被服务端秒拒，会话永久砖死。
 * 严禁过度约束：多模态 content 形状、toolCallStatus、synthetic 标记等内容层字段一概不碰。
 */

export type ValidationOutcome = { ok: true } | { ok: false; reason: string }

const VALID_ROLES = new Set(['user', 'assistant', 'system', 'tool'])

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

export function validateMessage(msg: unknown): ValidationOutcome {
  if (!msg || typeof msg !== 'object') return { ok: false, reason: '消息不是对象' }
  const m = msg as Record<string, unknown>
  if (typeof m.role !== 'string' || !VALID_ROLES.has(m.role)) {
    return { ok: false, reason: `role 非法: ${String(m.role)}` }
  }
  // assistant 的工具调用：toolCalls 若存在必须是数组；每项 id 与 function.name
  // 必须为非空字符串（wire 强约束——null/缺失/空白同罪，事故 idx66 即显式 null）
  if (m.role === 'assistant' && m.toolCalls !== undefined && m.toolCalls !== null) {
    if (!Array.isArray(m.toolCalls)) {
      return { ok: false, reason: 'assistant.toolCalls 存在但不是数组' }
    }
    for (let i = 0; i < m.toolCalls.length; i++) {
      const tc = m.toolCalls[i] as Record<string, any> | null | undefined
      const fn = tc && typeof tc.function === 'object' && tc.function ? tc.function : {}
      if (!nonEmptyString(tc?.id)) return { ok: false, reason: `assistant.toolCalls[${i}].id 缺失或为空` }
      if (!nonEmptyString(fn.name)) return { ok: false, reason: `assistant.toolCalls[${i}].function.name 缺失或为空` }
    }
  }
  // tool 消息必须携带非空 toolCallId（wire 上 tool_call_id 缺失 → 服务端拒绝整包请求）
  if (m.role === 'tool' && !nonEmptyString(m.toolCallId)) {
    return { ok: false, reason: 'tool 消息 toolCallId 缺失或为空' }
  }
  return { ok: true }
}

/** 批量校验：保序返回合法/非法两组（非法项带原始索引与原因）——写闸/读闸/doctor 共用 */
export function partitionMessages(
  messages: unknown[],
): { valid: unknown[]; invalid: Array<{ index: number; message: unknown; reason: string }> } {
  const valid: unknown[] = []
  const invalid: Array<{ index: number; message: unknown; reason: string }> = []
  messages.forEach((m, index) => {
    const r = validateMessage(m)
    if (r.ok) valid.push(m)
    else invalid.push({ index, message: m, reason: r.reason })
  })
  return { valid, invalid }
}

/**
 * 重复折叠判据（M7增量3·决策33，doctor repair 共用；纯函数）：
 * 在「无 assistant 间隔的 user 消息段」内按文本去重保首份——中继重投堆积的真实形态
 * 是 ABABAB 交替重复（2026-09-26 事故实证），单纯"连续同文"抓不全。
 * assistant 消息重置段（一次真实回复隔开的重复发言是人的显式决定，不折叠）。
 * 返回应折叠（保留首份之外的）消息索引列表。
 */
export function findCollapsibleDuplicateIndices(messages: unknown[]): number[] {
  const collapsible: number[] = []
  let seenInRun = new Set<string>()
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    const role = m && typeof m === 'object' ? (m as Record<string, unknown>).role : undefined
    if (role === 'assistant') {
      seenInRun = new Set()
      continue
    }
    if (role !== 'user') continue
    const content = (m as Record<string, unknown>).content
    const key = typeof content === 'string' ? content : JSON.stringify(content ?? null)
    if (seenInRun.has(key)) collapsible.push(i)
    else seenInRun.add(key)
  }
  return collapsible
}
