/**
 * 渲染管线语料对拍（dev-only，手动运行：pnpm exec tsx packages/ui/scripts/diff-render-pipelines.ts）
 *
 * 读取 ~/.chill/sessions 真实会话记录，对每条文本消息分别跑：
 * - 旧管线（冻结副本：processThinkingContent + parseContentByTime fence 切分 + 逐项 md.render）
 * - 新管线（segmentStatic 行对齐块级分段 + 逐块 md.render + <link> 过滤）
 * diff 最终 HTML，输出两栏报告：
 * - 预期差异（四类有意改进 + 块序统一），按类别归档
 * - 意外差异（必须归零——出现即新分段器存在正确性缺陷）
 *
 * 本脚本不被应用代码 import、不进 bundle；内嵌的旧管线实现是对拆除前
 * MessageMarkdown.vue 的逐行冻结副本，仅作对拍基准。
 */
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import MarkdownIt from 'markdown-it'
// @ts-ignore - 缺少类型声明
import mk from 'markdown-it-katex'
import anchor from 'markdown-it-anchor'
// @ts-ignore - 缺少类型声明
import taskLists from 'markdown-it-task-lists'
import { segmentStatic, filterLinkTags, IncrementalReasoningNormalizer, tryUnwrapReasoningJson } from '../src/utils/streamSegmenter'

// ==================== 共享 md 实例（与 markdownRenderer.ts 同配置） ====================

const md = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: true,
})
md.use(mk)
md.use(anchor, {
  slugify: (s: string) => s.replace(/[^\w]+/g, '-'),
  permalink: { placement: 'after', symbol: '#', class: 'header-anchor' },
})
md.use(taskLists)

// ==================== 旧管线（冻结副本） ====================

const oldProcessThinkingContent = (content: string): string => {
  if (!content || typeof content !== 'string') return ''
  let processed = content
  processed = processed.replace(/<link[^>]*>/gi, '')
  try {
    if (processed.trim().startsWith('{') && processed.trim().endsWith('}')) {
      const jsonData = JSON.parse(processed)
      const thinkingFields = ['thinking', 'reasoning', 'thought', 'analysis']
      for (const field of thinkingFields) {
        if (jsonData[field]) return jsonData[field]
      }
      const textFields = Object.values(jsonData).filter((v) => typeof v === 'string').join('\n')
      if (textFields) return textFields
    }
  } catch {
    /* 不是有效的JSON，继续处理 */
  }
  processed = processed
    .replace(/\\\\n/g, '\n')
    .replace(/\\\\r/g, '\r')
    .replace(/\\\\t/g, '\t')
    .replace(/\\r\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .replace(/\\\\\\\\/g, '\\\\')
    .replace(/\\\\"/g, '"')
    .replace(/\\\\'/g, "'")
  processed = processed
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .join('\n')
  return processed
}

interface OldItem {
  id: string
  type: 'text' | 'code'
  content: string
  language?: string
  isStreaming?: boolean
}

const oldParseContentByTime = (content: string): OldItem[] => {
  const items: OldItem[] = []
  if (!content) return items
  const lines = content.split('\n')
  let currentText = ''
  let inCodeBlock = false
  let currentCodeLanguage = ''
  let currentCodeContent = ''
  let position = 0
  for (const line of lines) {
    const codeBlockStartMatch = line.match(/^```(\w+)?$/)
    if (codeBlockStartMatch) {
      if (currentText.trim()) {
        items.push({ id: `text-${position}`, type: 'text', content: currentText.trim(), position: position++ } as OldItem)
        currentText = ''
      }
      if (!inCodeBlock) {
        inCodeBlock = true
        currentCodeLanguage = codeBlockStartMatch[1] || 'text'
        currentCodeContent = ''
      } else {
        if (currentCodeContent.trim()) {
          items.push({
            id: `code-${position}`,
            type: 'code',
            content: currentCodeContent.trim(),
            language: currentCodeLanguage,
            isStreaming: false,
            position: position++,
          } as OldItem)
        }
        inCodeBlock = false
        currentCodeLanguage = ''
        currentCodeContent = ''
      }
    } else if (inCodeBlock) {
      currentCodeContent += line + '\n'
    } else {
      currentText += line + '\n'
    }
  }
  if (currentText.trim()) {
    items.push({ id: `text-${position}`, type: 'text', content: currentText.trim(), position: position++ } as OldItem)
  }
  if (currentCodeContent.trim()) {
    items.push({
      id: `code-${position}`,
      type: 'code',
      content: currentCodeContent.trim(),
      language: currentCodeLanguage,
      isStreaming: true,
      position: position++,
    } as OldItem)
  }
  return items
}

/** 旧管线产出：文本项 HTML 串联 + 代码项内容清单 */
const oldPipeline = (raw: string): { html: string; codes: { content: string; language: string }[] } => {
  const processed = oldProcessThinkingContent(raw)
  const items = oldParseContentByTime(processed)
  let html = ''
  const codes: { content: string; language: string }[] = []
  for (const item of items) {
    if (item.type === 'text') html += md.render(item.content)
    else codes.push({ content: item.content, language: item.language || 'text' })
  }
  return { html, codes }
}

// ==================== 新管线 ====================

const newPipeline = (raw: string, reasoning: boolean): { html: string; codes: { content: string; language: string }[] } => {
  let text = ''
  if (reasoning) {
    const unwrapped = tryUnwrapReasoningJson(raw)
    const normalizer = new IncrementalReasoningNormalizer()
    text = normalizer.push(unwrapped ? unwrapped.text : raw) + normalizer.flushTail()
  } else {
    text = raw
  }
  const segments = segmentStatic(text)
  let html = ''
  const codes: { content: string; language: string }[] = []
  for (const seg of segments) {
    if (seg.type === 'text') html += md.render(filterLinkTags(seg.content))
    else codes.push({ content: filterLinkTags(seg.content), language: seg.language || 'text' })
  }
  return { html, codes }
}

// ==================== 预期差异判定 ====================

type DiffKind = 'PARA_SPLIT' | 'CODE_BLANK' | 'LITERAL_ESCAPE' | 'HARD_BREAK' | 'UNKNOWN'

const classifyDiff = (raw: string, oldHtml: string, newHtml: string): DiffKind => {
  // ①段落拆分：旧空行被删（<br> 连接），新独立 <p>
  if (
    oldHtml.replace(/<br\s*\/?>/g, '').replace(/<\/?p>/g, '') ===
      newHtml.replace(/<\/?p>/g, '').replace(/<br\s*\/?>/g, '') &&
    /<br/.test(oldHtml) &&
    /<p>/.test(newHtml)
  ) {
    return 'PARA_SPLIT'
  }
  // 归一空白后相同（标签顺序差异等）
  const norm = (s: string) => s.replace(/\s+/g, ' ').replace(/<br\s*\/?>/g, ' ').replace(/<\/?p>/g, '').trim()
  if (norm(oldHtml) === norm(newHtml)) return 'PARA_SPLIT'
  // ②代码块空行保留 / ③字面转义 / ④硬换行：内容层差异（代码清单逐项比对兜底）
  if (raw.includes('\\n') || raw.includes('\\r') || raw.includes('\\t')) return 'LITERAL_ESCAPE'
  if (/[ \t]\n/.test(raw)) return 'HARD_BREAK'
  if (raw.includes('\n\n')) return 'CODE_BLANK'
  return 'UNKNOWN'
}

// ==================== 主流程 ====================

interface SessionMessage {
  role?: string
  content?: unknown
  reasoningContent?: string
  synthetic?: string
}

const extractTexts = (message: SessionMessage): { text: string; reasoning: boolean }[] => {
  const out: { text: string; reasoning: boolean }[] = []
  if (message.reasoningContent && typeof message.reasoningContent === 'string') {
    out.push({ text: message.reasoningContent, reasoning: true })
  }
  const c = message.content
  if (typeof c === 'string' && c) out.push({ text: c, reasoning: false })
  else if (Array.isArray(c)) {
    for (const part of c) {
      if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string' && part.text) {
        out.push({ text: part.text, reasoning: false })
      }
    }
  }
  return out
}

const sessionsDir = path.join(os.homedir(), '.chill', 'sessions')
const files = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json')) : []

let totalTexts = 0
let identical = 0
const expected = new Map<DiffKind, number>()
const unexpected: { file: string; role: string; preview: string }[] = []

for (const file of files) {
  let record: { messages?: SessionMessage[] }
  try {
    record = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf-8'))
  } catch {
    continue
  }
  for (const message of record.messages ?? []) {
    // tool/system 消息不经过 MessageMarkdown 渲染路径（旧架构 v-show 隐藏、新架构 feed 直接过滤），
    // 对拍仅覆盖用户可见文本
    if (message.role === 'tool' || message.role === 'system') continue
    for (const { text, reasoning } of extractTexts(message)) {
      totalTexts++
      const old = oldPipeline(text)
      const next = newPipeline(text, reasoning)
      const codeIdentical =
        old.codes.length === next.codes.length &&
        old.codes.every((c, i) => c.content === next.codes[i].content && c.language === next.codes[i].language)
      if (old.html === next.html && codeIdentical) {
        identical++
        continue
      }
      const kind = classifyDiff(text, old.html, next.html)
      if (kind === 'UNKNOWN') {
        unexpected.push({
          file,
          role: message.role ?? '?',
          preview: text.slice(0, 120).replace(/\n/g, '\\n'),
        })
      } else {
        expected.set(kind, (expected.get(kind) ?? 0) + 1)
      }
    }
  }
}

console.log('==================== 渲染管线语料对拍报告 ====================')
console.log(`语料：${files.length} 个会话文件，${totalTexts} 条文本`)
console.log(`逐字节一致：${identical} (${totalTexts ? ((identical / totalTexts) * 100).toFixed(1) : '0'}%)`)
console.log('\n---- 预期差异（有意改进） ----')
const kindLabels: Record<DiffKind, string> = {
  PARA_SPLIT: '①多段落独立 <p>（旧空行被删、段落合并 <br>）',
  CODE_BLANK: '②代码块/内容空行保留（旧被删除）',
  LITERAL_ESCAPE: '③字面 \\n 序列不被改写（正文非 reasoning 路径）',
  HARD_BREAK: '④行尾空格保留（两空格硬换行生效）',
  UNKNOWN: '?? 意外',
}
for (const kind of ['PARA_SPLIT', 'CODE_BLANK', 'LITERAL_ESCAPE', 'HARD_BREAK'] as DiffKind[]) {
  console.log(`${kindLabels[kind]}: ${expected.get(kind) ?? 0}`)
}
console.log(`\n---- 意外差异（必须归零） ----`)
console.log(`计数：${unexpected.length}`)
for (const u of unexpected.slice(0, 20)) {
  console.log(`  [${u.file}] role=${u.role} | ${u.preview}`)
}
if (unexpected.length > 20) console.log(`  ……共 ${unexpected.length} 条`)
