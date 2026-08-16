/**
 * 上下文压缩服务（/compact 的核心逻辑，纯函数为主，平台无关）
 *
 * 与记忆蒸馏 buildTranscript（memoryDistiller）结构相似但预算策略独立：
 * 蒸馏的 1500/12000 字符上限是"提取长期记忆"的小样本策略；压缩是"全量喂入的
 * 一次大请求"（Claude Code/Codex 实践），预算窗口驱动、单条截断放宽、TOOL 消息
 * 保留内容截断版（"错误与修复"是总结的关键字段，折叠掉就没了）。
 *
 * 主题索引管线：程序供给时间戳（[HH:MM] 前缀 + 时间间隙辅助线）→ 模型按语义归纳
 * 主题 → parseTopicIndex 解析校验，失败时按时间间隙机械切段兜底（索引永远存在）。
 *
 * recall_archived_context 的格式化与压缩转录共用 formatTranscript（参数化预算）。
 */

import type { Message, ModelInfo } from '../../types/models'

/** 单条消息/TOOL 消息/全场转录的截断档位（降级链：收紧截断 8000→2000→500，再丢最旧轮次组） */
interface TranscriptBudget {
  maxMsgChars: number
  maxToolChars: number
}

/** 降级链档位：前 3 档收紧单条截断，后 3 档在最严截断基础上逐档多丢 1 个最旧轮次组 */
const DEGRADE_LEVELS: Array<{ budget: TranscriptBudget; dropTurnGroups: number }> = [
  { budget: { maxMsgChars: 8000, maxToolChars: 1000 }, dropTurnGroups: 0 },
  { budget: { maxMsgChars: 2000, maxToolChars: 500 }, dropTurnGroups: 0 },
  { budget: { maxMsgChars: 500, maxToolChars: 200 }, dropTurnGroups: 0 },
  { budget: { maxMsgChars: 500, maxToolChars: 200 }, dropTurnGroups: 1 },
  { budget: { maxMsgChars: 500, maxToolChars: 200 }, dropTurnGroups: 2 },
  { budget: { maxMsgChars: 500, maxToolChars: 200 }, dropTurnGroups: 3 },
]

/** 时间间隙辅助线的阈值：相邻消息间隔超过 30 分钟插一条分段候选线 */
const TIME_GAP_MS = 30 * 60 * 1000
/** 主题索引条数上限（超出则模型需合并最旧相邻段——给索引设预算，防摘要膨胀） */
const MAX_TOPIC_INDEX_ENTRIES = 20

/** 压缩调用模型回调（引擎侧包装 callOnce 注入；返回总结文本，空串/异常视为失败） */
export type CompactionCallModel = (messages: Message[]) => Promise<string>

/** 提取消息纯文本（content 为 ContentPart[] 时拼接 text 部分；媒体块转为占位符） */
export function messageText(m: Message): string {
  if (typeof m.content === 'string') return m.content
  if (Array.isArray(m.content)) {
    return m.content
      .map((p: any) => {
        if (p?.type === 'text' && p?.text) return p.text
        if (p?.type === 'image_url') return '[图片]'
        if (p?.type === 'video_url') return '[视频]'
        if (p?.type === 'input_audio') return '[音频]'
        return ''
      })
      .filter(Boolean)
      .join(' ')
  }
  return ''
}

function timeOf(m: Message): number {
  const t = m.timestamp instanceof Date ? m.timestamp.getTime() : new Date(m.timestamp).getTime()
  return Number.isNaN(t) ? 0 : t
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** 本地时区 HH:MM（主题索引时间段、recall from/to 参数的格式） */
export function formatHHMM(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 本地时区 MM-DD HH:MM（跨日消息的时间戳前缀） */
export function formatMMDDHHMM(d: Date): string {
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${formatHHMM(d)}`
}

/**
 * 消息时间戳前缀：与参考日（本批最新消息的本地日期）同日用 [HH:MM]，跨日用 [MM-DD HH:MM]。
 * 时间事实完全由程序供给，模型不负责"算时间"，杜绝时间戳幻觉。
 */
export function formatMessageTime(m: Message, refDate: Date): string {
  const d = new Date(timeOf(m))
  const sameDay =
    d.getFullYear() === refDate.getFullYear() &&
    d.getMonth() === refDate.getMonth() &&
    d.getDate() === refDate.getDate()
  return sameDay ? formatHHMM(d) : formatMMDDHHMM(d)
}

/**
 * 转录格式化器（压缩转录与 recall 检索共用）：
 * `[HH:MM] 角色: 内容`，媒体占位符，assistant 的 toolCalls 折叠为 [调用工具: names]，
 * TOOL 消息保留内容截断版（maxToolChars），单条 maxMsgChars 截断。
 * timeGaps=true 时相邻消息间隔 > 30 分钟处插一条分段候选辅助线（压缩转录用；recall 不用）。
 */
export function formatTranscript(
  messages: Message[],
  opts: { maxMsgChars: number; maxToolChars: number; timeGaps?: boolean }
): string {
  if (messages.length === 0) return ''
  const refDate = new Date(timeOf(messages[messages.length - 1]) || Date.now())
  const parts: string[] = []
  let prevTs = 0
  for (const m of messages) {
    if (m.role === 'system') continue
    const ts = timeOf(m)
    if (opts.timeGaps && prevTs > 0 && ts - prevTs > TIME_GAP_MS) {
      parts.push(`──── 时间间隔 ${((ts - prevTs) / 3600000).toFixed(1)}h ────`)
    }
    prevTs = ts
    const role = m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : '工具'
    let text = messageText(m).replace(/\s+/g, ' ').trim()
    if (m.toolCalls?.length) {
      const names = m.toolCalls.map((tc) => tc.function?.name).filter(Boolean).join(', ')
      text = `${text} [调用工具: ${names}]`.trim()
    }
    if (!text) continue
    text = text.slice(0, m.role === 'tool' ? opts.maxToolChars : opts.maxMsgChars)
    parts.push(`[${formatMessageTime(m, refDate)}] ${role}: ${text}`)
  }
  return parts.join('\n')
}

/**
 * 转录总预算（窗口驱动）：当前模型 maxContextTokens − 输出余量(~8k token) − prompt 本体(~2k)，
 * 按保守 2 字符/token 换算。模型信息未知时按 128k 窗口兜底。
 */
export function computeTranscriptBudgetChars(maxContextTokens?: number): number {
  const window = maxContextTokens && maxContextTokens > 0 ? maxContextTokens : 128000
  return Math.max(20000, (window - 8000 - 2000) * 2)
}

/** 按 user 消息切轮次组（一组 = 一条 user 消息起到下一条 user 消息前；首条 user 之前的消息归为首组前缀） */
function splitTurnGroups(messages: Message[]): Message[][] {
  const groups: Message[][] = []
  for (const m of messages) {
    if (m.role === 'user' || groups.length === 0) {
      groups.push([m])
    } else {
      groups[groups.length - 1].push(m)
    }
  }
  return groups
}

/** 丢最旧 N 个轮次组（降级链后段用；返回剩余消息，至少保留最后一组） */
function dropOldestTurnGroups(messages: Message[], count: number): Message[] {
  if (count <= 0) return messages
  const groups = splitTurnGroups(messages)
  const keepFrom = Math.min(count, Math.max(0, groups.length - 1))
  return groups.slice(keepFrom).flat()
}

const COMPACTION_SYSTEM_PROMPT = `你是上下文压缩器。为接手本会话的另一个模型写一份交接摘要，使其仅凭摘要即可无缝继续工作。摘要的读者是模型，不是用户。

【固定分节】按以下 Markdown 分节输出，无内容的分节写"（无）"：
## 目标与意图
## 关键决策
## 约束与偏好
## 已完成与进行中
## 待办与下一步
## 错误与修复
## 关键文件与引用
## 会话主题索引

【要求】
- 已被后续结论推翻的决策保留并标注（Superseded: 被什么取代）；不确定是否仍成立的信息标注（UNVERIFIED）
- 错误码、报错信息、关键路径/标识符引用原文，不要转述
- 相对日期一律转换为绝对日期
- 若输入含"此前压缩摘要"，在其基础上增量更新承接（不重写推翻它，吸收进新摘要）

【会话主题索引契约】
- 转录每条消息带 [HH:MM] 或 [MM-DD HH:MM] 时间戳前缀，时间照抄转录，禁止自己推算
- 先按语义找主题边界（同一话题跨时间间隙可并为一段，话题切换处分段），再为每个主题照抄起止时间
- 固定行格式：- 主题一句话（HH:MM–HH:MM），主题在前、时间在后，按时间升序
- 所有时间段的并集必须覆盖转录首尾、互不重叠；条数不超过 ${MAX_TOPIC_INDEX_ENTRIES} 条，超出则合并最旧的相邻段
- 若"此前压缩摘要"中已有主题索引，旧条目原样保留，只追加新段

【输出】只输出摘要 Markdown 本体，不要输出任何额外说明。`

/**
 * 压缩主流程：增量转录（旧总结 + 新增消息）→ 单次模型调用；
 * 超预算/调用失败按降级链重试（收紧单条截断 8000→2000→500 → 丢最旧轮次组 ≤3 次）；
 * 全部失败返回 null（调用方保证零副作用）。
 */
export async function compactMessages(
  prevSummary: string | undefined,
  newMessages: Message[],
  callModel: CompactionCallModel,
  guidance?: string,
  budgetChars?: number
): Promise<string | null> {
  const budget = budgetChars ?? computeTranscriptBudgetChars()
  for (const level of DEGRADE_LEVELS) {
    const candidate = dropOldestTurnGroups(newMessages, level.dropTurnGroups)
    const transcript = formatTranscript(candidate, { ...level.budget, timeGaps: true })
    // 超预算且还有下一档：不浪费一次模型调用，直接降级
    const isLast = level === DEGRADE_LEVELS[DEGRADE_LEVELS.length - 1]
    if (transcript.length > budget && !isLast) continue

    const userParts: string[] = []
    if (prevSummary) {
      userParts.push(`【此前压缩摘要】\n${prevSummary}`)
    }
    userParts.push(`【新增对话转录】\n${transcript || '（无）'}`)
    if (guidance?.trim()) {
      userParts.push(`【用户引导语（压缩侧重点）】\n${guidance.trim()}`)
    }
    const promptMessages: Message[] = [
      { role: 'system' as Message['role'], content: COMPACTION_SYSTEM_PROMPT, timestamp: new Date() },
      { role: 'user' as Message['role'], content: userParts.join('\n\n'), timestamp: new Date() },
    ]

    let summary = ''
    try {
      summary = (await callModel(promptMessages)).trim()
    } catch {
      summary = ''
    }
    if (!summary) continue

    // 主题索引程序校验 + 机械兜底（索引是检索辅助，宁可降级不可失败）
    return parseTopicIndex(summary, newMessages)
  }
  return null
}

/**
 * 主题索引解析校验 + 机械兜底：
 * 解析 `## 会话主题索引` 节的 `- 主题（HH:MM–HH:MM）` 行，校验每条可解析且按时间升序；
 * 解析失败或条目数为 0 时降级：按时间间隙（>30min）机械切段，段名取该段首条用户消息前 30 字。
 * 返回修正后的总结全文（索引节替换为校验/兜底结果）。
 */
export function parseTopicIndex(summary: string, messages: Message[]): string {
  const sectionRe = /## 会话主题索引\s*\n([\s\S]*?)(?=\n## |\s*$)/
  const match = summary.match(sectionRe)
  const entries = match ? parseTopicIndexEntries(match[1]) : []
  if (entries.length > 0) {
    // 条数超预算：保留最新 MAX_TOPIC_INDEX_ENTRIES 条（合并最旧段是模型的约定，程序兜底直接裁）
    const kept = entries.slice(-MAX_TOPIC_INDEX_ENTRIES)
    const section = kept.map((e) => `- ${e.topic}（${e.from}–${e.to}）`).join('\n')
    return match ? summary.replace(sectionRe, `## 会话主题索引\n${section}`) : `${summary.trim()}\n\n## 会话主题索引\n${section}`
  }
  // 机械兜底
  const fallback = buildMechanicalTopicIndex(messages)
  return match
    ? summary.replace(sectionRe, `## 会话主题索引\n${fallback}`)
    : `${summary.trim()}\n\n## 会话主题索引\n${fallback}`
}

/** 解析索引行（兼容全/半角括号与 – / - 连接符）：返回按出现顺序的主题条目；任一行不合规或乱序则整体视为无效 */
function parseTopicIndexEntries(section: string): Array<{ topic: string; from: string; to: string }> {
  const entries: Array<{ topic: string; from: string; to: string; fromMin: number }> = []
  const lineRe = /^-\s*(.+?)[（(](\d{2}:\d{2}|\d{2}-\d{2} \d{2}:\d{2})\s*[–-]\s*(\d{2}:\d{2}|\d{2}-\d{2} \d{2}:\d{2})[）)]\s*$/
  for (const rawLine of section.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const m = line.match(lineRe)
    if (!m) return []
    entries.push({ topic: m[1].trim(), from: m[2], to: m[3], fromMin: timeToMinutes(m[2]) })
  }
  if (entries.length === 0) return []
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].fromMin < entries[i - 1].fromMin) return []
  }
  return entries
}

/** "HH:MM" 或 "MM-DD HH:MM" → 可比较的分钟数（跨日格式按日*1440+分钟，仅用于升序校验） */
function timeToMinutes(s: string): number {
  const mmdd = s.match(/^(\d{2})-(\d{2}) (\d{2}):(\d{2})$/)
  if (mmdd) return (Number(mmdd[1]) * 31 + Number(mmdd[2])) * 1440 + Number(mmdd[3]) * 60 + Number(mmdd[4])
  const hm = s.match(/^(\d{2}):(\d{2})$/)
  return hm ? Number(hm[1]) * 60 + Number(hm[2]) : 0
}

/** 机械兜底索引：按时间间隙（>30min）切段，段名取该段首条用户消息前 30 字，时间取段首尾消息 */
function buildMechanicalTopicIndex(messages: Message[]): string {
  const valid = messages.filter((m) => m.role !== 'system')
  if (valid.length === 0) return '- （无对话内容）'
  const refDate = new Date(timeOf(valid[valid.length - 1]) || Date.now())
  const segments: Message[][] = [[valid[0]]]
  for (let i = 1; i < valid.length; i++) {
    if (timeOf(valid[i]) - timeOf(valid[i - 1]) > TIME_GAP_MS) {
      segments.push([valid[i]])
    } else {
      segments[segments.length - 1].push(valid[i])
    }
  }
  return segments
    .map((seg) => {
      const firstUser = seg.find((m) => m.role === 'user') ?? seg[0]
      const topic = (messageText(firstUser).replace(/\s+/g, ' ').trim() || '（无文本）').slice(0, 30)
      const from = formatMessageTime(seg[0], refDate)
      const to = formatMessageTime(seg[seg.length - 1], refDate)
      return `- ${topic}（${from}–${to}）`
    })
    .join('\n')
}

/**
 * 压缩调用的思考模式关闭参数覆盖（提取+结构化任务不需要推理链，纯成本）：
 * 按模型声明的 supportedParameters 覆盖——声明 thinking 的关思考；
 * 只声明 reasoning_effort 的压到最低档；都未声明的不动。
 */
export function buildThinkingOffOverrides(modelInfo?: ModelInfo): Record<string, unknown> {
  const names = new Set((modelInfo?.supportedParameters ?? []).map((p) => p.name))
  if (names.has('thinking')) return { thinking: false }
  if (names.has('reasoning_effort')) return { reasoning_effort: 'low' }
  return {}
}
