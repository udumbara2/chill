/**
 * 会话标题工具（core 共享，CLI/UI 两端复用）
 * - smartTruncateTitle：标点/空白边界感知的智能截断，作为默认标题与失败回退
 * - generateSessionTitle：首轮对话后调用 LLM 生成简洁标题；callModel 函数注入，core 不耦合模型服务
 */

/** 无内容时的兜底标题（与历史行为一致） */
const FALLBACK_TITLE = '新会话'

/** 智能截断时优先在这些字符处断开（中英文标点 + 英文空格） */
const BREAK_CHARS = ['，', '。', '！', '？', '；', '、', '：', ',', '.', '!', '?', ';', ':', ' ']

/** LLM 标题的最大长度（字） */
const AUTO_TITLE_MAX = 20

/** 喂给标题 prompt 的用户消息最大长度（字） */
const EXCERPT_MAX = 500

/**
 * 智能截断标题：归一化空白后不超 max 直接返回；超长时在后半段的标点/空格处断开，
 * 找不到合适断点则硬截。永不返回空串。
 */
export function smartTruncateTitle(text: string, max = 30): string {
  const normalized = (text ?? '').replace(/\s+/g, ' ').trim()
  if (!normalized) return FALLBACK_TITLE
  if (normalized.length <= max) return normalized
  const head = normalized.slice(0, max)
  let cut = -1
  for (let i = head.length - 1; i >= Math.floor(max / 2); i--) {
    if (BREAK_CHARS.includes(head[i])) { cut = i; break }
  }
  const result = (cut > 0 ? head.slice(0, cut) : head).trim()
  return result || FALLBACK_TITLE
}

/** 标题生成模型调用（由 CLI/UI 各自封装 sendChatMessage 注入） */
export type TitleCallModel = (prompt: string) => Promise<string>

/**
 * 用 LLM 为首条用户消息生成会话标题。
 * 任何失败（无内容/调用异常/清洗后为空）都返回 null，调用方静默回退到截断标题。
 */
export async function generateSessionTitle(userText: string, callModel: TitleCallModel): Promise<string | null> {
  try {
    const excerpt = (userText ?? '').replace(/\s+/g, ' ').trim().slice(0, EXCERPT_MAX)
    if (!excerpt) return null
    const prompt = `请为以下用户消息开启的对话生成一个不超过 ${AUTO_TITLE_MAX} 个字的会话标题。只输出标题本身，不要引号、不要解释、不要换行。\n\n用户消息：${excerpt}`
    const raw = await callModel(prompt)
    return sanitizeTitle(raw)
  } catch {
    return null
  }
}

/** 清洗模型输出：取首行、去引号/markdown/首尾标点、压空白、限长 */
function sanitizeTitle(raw: string): string | null {
  if (!raw) return null
  let t = raw.split(/\r?\n/)[0]
  t = t
    .replace(/^[\s#*>`"'「『【《（(]+/, '')
    .replace(/[\s#*>`"'」』】》）)。.，,；;：:！!？?]+$/, '')
  t = t.replace(/\s+/g, ' ').trim()
  if (t.length > AUTO_TITLE_MAX) t = t.slice(0, AUTO_TITLE_MAX)
  return t || null
}
