/**
 * 围栏代码块语法高亮（lowlight HAST 树遍历 → 16 色 SGR 行数组）
 *
 * 设计约定（根 AGENTS.md「语法高亮」）：
 * - 高亮是完成态呈现——仅闭合块调用（messageModel 的围栏分支保证），未闭合块零开销；
 * - 16 色 ANSI 跟随终端主题（禁 truecolor）；色表保守，不染 punctuation/operator/attr；
 * - 纯函数 + 内容即键缓存（只有闭合块会进来，内容天然冻结，无过期）；
 * - 行数不变性是视觉行账本铁律：任何可能破行数的路径一律返回 null 走素色。
 *
 * 引擎路径与 Gemini CLI 官方 CodeColorizer 同款（lowlight → HAST，className 映射色），
 * 但整块高亮（非其逐行），跨行注释/字符串着色连续。
 */
import { common, createLowlight } from 'lowlight'
import type { Root, RootContent, Element, Text as HastText } from 'hast'
import powershell from 'highlight.js/lib/languages/powershell'
import dos from 'highlight.js/lib/languages/dos'
import { stripAnsiText } from './markdown.js'

const low = createLowlight(common)
// lowlight common 的 37 种语言不含 powershell/dos(bat/cmd)；chill 是 Windows 主场项目，补注册
// （hljs 别名内建覆盖 ps/ps1/bat/cmd；语言定义与 lowlight 内嵌 highlight.js 同为 v11，兼容）
low.register('powershell', powershell)
low.register('dos', dos)

/** 闭合块着色上界（字符数；实测成本 ≈0.5ms/KB，40KB ≈ 20ms 一次性） */
const MAX_CHARS = 40960
/** 缓存条数上界（FIFO；闭合块内容冻结、内容即键、无过期；~3MB 内存上界） */
const CACHE_MAX = 100

const SGR_RESET = '\x1b[0m'

/**
 * 色表（16 色，保守；键为去 `hljs-` 前缀后的实际类名）。
 * v11 作用域以类数组呈现（如 ['hljs-title','function_']），末位优先规则下 function_ 先命中，
 * 故键必须是 function_/class_ 而非点号形式。attr/variable/punctuation/operator 等不染（降噪，
 * 规避 Claude Code #21034 万花筒教训）。
 */
const COLOR_MAP: Readonly<Record<string, string>> = {
  keyword: '\x1b[35m', // 品红
  'selector-tag': '\x1b[35m',
  string: '\x1b[32m', // 绿
  regexp: '\x1b[32m',
  addition: '\x1b[32m', // ```diff 的 + 行（git 惯例字色，免整行补齐、折行免疫）
  comment: '\x1b[90m', // 亮黑
  quote: '\x1b[90m',
  meta: '\x1b[90m',
  number: '\x1b[36m', // 青
  literal: '\x1b[36m',
  title: '\x1b[34m', // 蓝
  function_: '\x1b[34m',
  section: '\x1b[34m',
  class_: '\x1b[33m', // 黄
  type: '\x1b[33m',
  built_in: '\x1b[33m',
  deletion: '\x1b[31m', // ```diff 的 - 行
}

/** element 类数组 → SGR（去 hljs- 前缀，末位优先取首个命中；Gemini 语义：精细作用域优先） */
function colorOf(node: Element): string | undefined {
  const classes = (node.properties?.className as string[] | undefined) ?? []
  for (let i = classes.length - 1; i >= 0; i--) {
    const key = classes[i].replace(/^hljs-/, '')
    const color = COLOR_MAP[key]
    if (color) return color
  }
  return undefined
}

/** HAST 子树 → 输出行数组（就地按 \n 切分；行尾 reset、下行开头重放激活色，防渗色到边框） */
function emitNodes(children: RootContent[], inherited: string | undefined, rows: string[]): void {
  const append = (text: string, active: string | undefined): void => {
    // text 不含 \n（调用方已切分）
    if (!text) return
    rows[rows.length - 1] += active ? active + text + SGR_RESET : text
  }
  for (const node of children) {
    if (node.type === 'text') {
      const segments = (node as HastText).value.split('\n')
      segments.forEach((seg, i) => {
        if (i > 0) rows.push('') // 换行：新行（行内激活色由各 segment 自带 active+reset，无需跨行重放）
        append(seg, inherited)
      })
    } else if (node.type === 'element') {
      emitNodes((node as Element).children, colorOf(node as Element) ?? inherited, rows)
    }
    // 其余节点类型（comment/doctype）不出现于 hljs 输出，忽略
  }
}

/** 结果缓存（FIFO 淘汰：Map 迭代序即插入序） */
const cache = new Map<string, string[]>()

/**
 * 闭合代码块 → 带 SGR 的行数组；任何失败路径返回 null（调用方走字面素色，即现状）。
 * 不变量：返回行数 == 输入 split('\n') 行数；strip ANSI 后逐字等于原文。
 */
export function highlightCode(code: string, lang: string): string[] | null {
  // 防御病态输入含原始 ESC（Gemini 同款）；strip 后行数若变（OSC 可跨 \n 匹配）→ 素色，铁律不可破
  const clean = stripAnsiText(code)
  if (clean.split('\n').length !== code.split('\n').length) return null
  const normalized = lang.toLowerCase()
  if (!low.registered(normalized)) return null
  if (clean.length > MAX_CHARS) return null
  const key = normalized + '\0' + clean
  const hit = cache.get(key)
  if (hit) return hit
  try {
    const tree: Root = low.highlight(normalized, clean)
    if (!tree.children || tree.children.length === 0) return null
    const rows = ['']
    emitNodes(tree.children, undefined, rows)
    cache.set(key, rows)
    if (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next()
      if (!oldest.done) cache.delete(oldest.value)
    }
    return rows
  } catch {
    return null
  }
}
