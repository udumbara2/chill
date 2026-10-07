/**
 * `@` 提及解析（文件/媒体提及）
 *
 * `@` = 提及一个实体：带扩展名（@图.png）= 文件提及（本模块，现阶段媒体类）；
 * kebab-case 无点号（@security-reviewer）= agent 提及（agentMention.ts）。
 * 本模块只做纯词法解析（文本 → 结构化引用），不碰文件系统——
 * 存在性校验与字节读取是宿主职责（CLI 侧 cliMediaAdapter.resolveMediaMentions）。
 *
 * 降级规则与 @agent 同构：不匹配已知媒体扩展名的 `@xxx` 原样保留按普通文本处理。
 */

/** 全项目唯一 ext↔kind↔MIME 事实表（壳侧 MIME 查询一律从这里派生，严禁另建） */
export const MEDIA_EXTENSIONS: Record<string, { kind: 'image' | 'video'; mime: string }> = {
  '.jpg': { kind: 'image', mime: 'image/jpeg' },
  '.jpeg': { kind: 'image', mime: 'image/jpeg' },
  '.png': { kind: 'image', mime: 'image/png' },
  '.gif': { kind: 'image', mime: 'image/gif' },
  '.webp': { kind: 'image', mime: 'image/webp' },
  '.bmp': { kind: 'image', mime: 'image/bmp' },
  '.svg': { kind: 'image', mime: 'image/svg+xml' },
  '.mp4': { kind: 'video', mime: 'video/mp4' },
  '.webm': { kind: 'video', mime: 'video/webm' },
  '.mov': { kind: 'video', mime: 'video/quicktime' },
  '.avi': { kind: 'video', mime: 'video/x-msvideo' },
  '.mkv': { kind: 'video', mime: 'video/x-matroska' },
}

export interface MediaMention {
  /** 原始提及文本（含 @ 与引号），用于从原文剔除 */
  raw: string
  /** 提取出的路径（已去引号） */
  path: string
  kind: 'image' | 'video'
}

// 扩展名 alternation（不带点，供正则使用）；匹配后须跟非字母数字边界，防 `.pngx` 误配
const EXT_ALT = Object.keys(MEDIA_EXTENSIONS).map((e) => e.slice(1)).join('|')
// 三种形态：@"带空格路径"、@'带空格路径'、@无空格token；均要求以已知媒体扩展名结尾
const MENTION_PATTERN = new RegExp(
  `@"([^"]+\\.(?:${EXT_ALT}))"|@'([^']+\\.(?:${EXT_ALT}))'|@(\\S+?\\.(?:${EXT_ALT}))(?![a-z0-9])`,
  'gi'
)

/**
 * 从用户文本中解析文件/媒体提及
 * @param text - 用户输入文本
 * @returns text = 剔除已识别 mention 后的清理文本（多余空白压平）；
 *          mentions = 识别到的媒体提及（不匹配的一律不留痕，按普通文本处理）
 */
export function parseMediaMentions(text: string): { text: string; mentions: MediaMention[] } {
  const mentions: MediaMention[] = []
  const cleaned = text.replace(MENTION_PATTERN, (raw, dq: string, sq: string, bare: string) => {
    const path = dq ?? sq ?? bare
    const ext = path.slice(path.lastIndexOf('.')).toLowerCase()
    const entry = MEDIA_EXTENSIONS[ext]
    if (!entry) return raw // 双保险：正则命中但表内无此扩展名（理论上不可达）
    mentions.push({ raw, path, kind: entry.kind })
    return ' '
  })
  return { text: cleaned.replace(/\s+/g, ' ').trim(), mentions }
}
