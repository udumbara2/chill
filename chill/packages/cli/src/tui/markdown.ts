/**
 * Markdown 最小渲染解析（零依赖）
 *
 * 行内样式（标题/粗体/斜体/删除线/行内代码/链接/任务列表/引用/列表）→ ANSI SGR 文本，
 * 供模型层注入后走 ANSI 感知折行；围栏状态机供代码块打标；保守配对（宁漏勿染）。
 * 表格检测（行/分隔行/对齐）在此，表格渲染在 messageModel（需显示宽度函数）。
 * 语法高亮/脚注/上标下标不在最小子集内。
 */

const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const ITALIC = '\x1b[3m'
const UNDERLINE = '\x1b[4m'
const STRIKE = '\x1b[9m'
const CYAN = '\x1b[36m'
const RESET = '\x1b[0m'

/** HTML 实体(限这五个,不发明全表) */
const ENTITIES: Array<[RegExp, string]> = [
  [/&amp;/g, '&'],
  [/&lt;/g, '<'],
  [/&gt;/g, '>'],
  [/&quot;/g, '"'],
  [/&#39;/g, "'"],
]

function decodeEntities(text: string): string {
  let out = text
  for (const [re, ch] of ENTITIES) out = out.replace(re, ch)
  return out
}

/** plain 段(非行内代码段)全规则:实体→任务列表→链接→列表标记→删除线→粗→斜;
 *  inlineOnly 时跳过 ^ 锚定的块级规则(任务列表/列表标记),供表格单元格等片段使用 */
function stylePlainSegment(text: string, inlineOnly: boolean): string {
  let out = decodeEntities(text)
  let dimLine = false
  if (!inlineOnly) {
    // 任务列表(先于列表标记替换,否则 - [ ] 先变 • [ ] 失配)
    out = out.replace(/^(\s*)[-*+] \[ \]\s*/, '$1☐ ')
    out = out.replace(/^(\s*)[-*+] \[[xX✓]\]\s*/, (_m, indent: string) => {
      dimLine = true
      return `${indent}☑ `
    })
  }
  // 链接 [label](url) → OSC 8 可点(cyan+underline label)+ dim(url) 兜底
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => {
    const styled = `${CYAN}${UNDERLINE}${label}${RESET}`
    return `\x1b]8;;${url}\x07${styled}\x1b]8;;\x07${DIM}(${url})${RESET}`
  })
  if (!inlineOnly) {
    // 无序列表标记 → •
    out = out.replace(/^(\s*)[-+]\s+/, '$1• ')
  }
  // 删除线(先于加粗/斜体,防 ~~ 与 * 互相干扰)
  out = out.replace(/~~([^~\n]+)~~/g, `${STRIKE}$1${RESET}`)
  // 加粗(保守:内容不含 *)
  out = out.replace(/\*\*([^*\n]+)\*\*/g, `${BOLD}$1${RESET}`)
  // 斜体(保守:单 * 配对,前后不粘 *)
  out = out.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, `${ITALIC}$1${RESET}`)
  return dimLine ? `${DIM}${out}${RESET}` : out
}

/** 行内 Markdown → ANSI 样式文本。
 *  标题:`#`~`######` → 去 # 前缀;L1/L2 加粗,L3+ 加粗+暗;
 *  引用:`> 开头` → 整行 dim(实体同步解码);
 *  其余按反引号分段:code 段只染 cyan(字面优先),plain 段全规则;
 *  inlineOnly=true:跳过全部 ^ 锚定块级规则(标题/引用/任务列表/列表标记),供表格单元格使用 */
export function styleInlineMarkdown(text: string, inlineOnly = false): string {
  if (!inlineOnly) {
    // 标题(1~6 级):去前缀,L1/L2 加粗,L3 及以上加粗+暗
    const heading = /^(#{1,6})\s+(\S.*)$/.exec(text)
    if (heading) {
      const title = heading[2]
      return heading[1].length <= 2 ? `${BOLD}${title}${RESET}` : `${BOLD}${DIM}${title}${RESET}`
    }
    // 引用:整行 dim
    if (/^>\s/.test(text)) {
      return `${DIM}${decodeEntities(text)}${RESET}`
    }
  }
  // 按反引号分段(code/plain 交替):奇数段为 code
  return text
    .split(/(`[^`\n]+`)/g)
    .map((seg, i) => {
      if (i % 2 === 1) return `${CYAN}${seg.slice(1, -1)}${RESET}`
      return seg ? stylePlainSegment(seg, inlineOnly) : seg
    })
    .join('')
}

/** 分割线行(--- / *** / ___,≥3 个,允许前导空白) */
export function isDividerLine(text: string): boolean {
  return /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(text)
}

/** 围栏标记行(``` 或 ~~~ 开头,允许前导空白) */
export function isFenceLine(line: string): boolean {
  return /^\s*(```|~~~)/.test(line)
}

/** 表格数据/表头行(以 | 起、| 止,允许前导空白) */
export function isTableRowLine(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line)
}

/** 表格分隔行(每格仅 ≥3 个 - 加可选前后 :,如 |---|:---:|---:|) */
export function isTableSeparatorLine(line: string): boolean {
  if (!/^\s*\|?[\s:|-]+\|?\s*$/.test(line)) return false
  const cells = line.trim().replace(/^\||\|$/g, '').split('|')
  return cells.length > 0 && cells.every((c) => /^\s*:?-{3,}:?\s*$/.test(c))
}

/** 分隔行 → 各列对齐方式(默认左;:--: 居中;--: 右) */
export function parseAlignment(sepLine: string): Array<'left' | 'center' | 'right'> {
  return sepLine
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => {
      const spec = c.trim()
      const left = spec.startsWith(':')
      const right = spec.endsWith(':')
      return left && right ? 'center' : right ? 'right' : 'left'
    })
}

/** 剥离 ANSI SGR 与 OSC 序列(搜索匹配用) */
export function stripAnsiText(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
}
