/**
 * 工具结果大小防线（上下文膨胀防护，规划 plan-20260814-1429）
 *
 * 【第2层·系统闸门】capToolResult：所有工具结果写入会话历史前的统一大小闸门——
 *   超 TOOL_RESULT_BUDGET 字符 → 完整内容 spill 落盘（fs 可用时）+ 头/尾预览 + 路径引用；
 *   无 fs（UI 渲染进程，vite 打包后 fs 为 shim）降级为头尾截断 + 显式标记。
 *   纯函数无副作用（不修改入参）——事件载荷（TOOL_MESSAGE_CREATED，壳侧显示用）与入史内容
 *   由调用方分别构造，杜绝同对象引用把显示层一起截断。
 *   行业参照：Claude Code Bash inline ~30K + 落盘 spilling；Codex 10K token 头尾截断；
 *   DeepSeek 官方 truncation_policy 10000 tokens；middle-truncation + 显式标记为三家共识，
 *   绝不静默截断。
 *
 * 【第1层·语义层】applyReadFileBudget：read_file 分页契约——默认 2000 行且 40K 字符（先到为准）、
 *   单行 2000 字符截断、超限返回 PARTIAL 通知（总行数/总字符 + offset 续读指引 + 单行巨长文件
 *   的 search_content 指引）；显式请求范围裁完仍超字符帽 → 报错建议缩小范围或改用
 *   search_content（对齐 Claude Code Read：显式超限报错而非静默截断；长行截断不报错，
 *   返回带标记内容即可——否则会话 JSON 类长行密集文件每一页都报错，read_file 事实上不可用）。
 */

import * as fs from 'fs'
import * as os from 'os'
import { join } from 'path'

/** 闸门预算：超过此字符数的工具结果被 cap（>read_file 40K 语义帽，两层永不双重截断） */
export const TOOL_RESULT_BUDGET = 50000
/** spill/降级预览的头尾各取字符数 */
export const SPILL_PREVIEW_CHARS = 5000
/** spill 文件保留时长（毫秒） */
export const SPILL_MAX_AGE_MS = 72 * 60 * 60 * 1000
/** read_file 默认行数上限 */
export const READ_DEFAULT_LINES = 2000
/** read_file 单次读取字符帽 */
export const READ_MAX_CHARS = 40000
/** read_file 单行字符上限（超长行截断） */
export const READ_LINE_MAX_CHARS = 2000

/** fs 能力探测（缓存）：UI 渲染进程 vite 打包后 fs 为空 shim，降级不落盘路径 */
let fsAvailable: boolean | undefined
function hasFs(): boolean {
  if (fsAvailable === undefined) {
    fsAvailable = Boolean(
      fs && typeof (fs as any).writeFileSync === 'function' &&
      os && typeof os.tmpdir === 'function'
    )
  }
  return fsAvailable
}

let lastCleanup = 0
/** 72h 惰性清扫（每次 spill 顺带，节流至每小时最多一次） */
function cleanupOldSpills(dir: string): void {
  const now = Date.now()
  if (now - lastCleanup < 60 * 60 * 1000) return
  lastCleanup = now
  try {
    for (const name of fs.readdirSync(dir)) {
      try {
        const p = join(dir, name)
        if (fs.statSync(p).mtimeMs < now - SPILL_MAX_AGE_MS) {
          fs.unlinkSync(p)
        }
      } catch { /* 单文件清扫失败忽略 */ }
    }
  } catch { /* 目录不存在等忽略 */ }
}

/** 落盘完整内容，返回文件绝对路径；失败/无 fs 返回 null */
function trySpill(content: string): string | null {
  if (!hasFs()) return null
  try {
    const dir = join(os.tmpdir(), 'chill-spills')
    fs.mkdirSync(dir, { recursive: true })
    cleanupOldSpills(dir)
    const file = join(dir, `spill_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.txt`)
    fs.writeFileSync(file, content, 'utf-8')
    return file
  } catch {
    return null
  }
}

/**
 * 系统闸门：cap 超大工具结果。
 * 纯函数（不修改入参）；小结果原样返回（零开销路径，引用不变）。
 * 调用方约定：TOOL_MESSAGE_CREATED 事件载荷传原始内容构造的完整对象，入史对象才用本函数结果。
 */
export function capToolResult(content: string): string {
  if (typeof content !== 'string' || content.length <= TOOL_RESULT_BUDGET) {
    return content
  }
  const head = content.slice(0, SPILL_PREVIEW_CHARS)
  const tail = content.slice(-SPILL_PREVIEW_CHARS)
  const omitted = content.length - SPILL_PREVIEW_CHARS * 2
  const spillPath = trySpill(content)
  if (spillPath) {
    return (
      `【工具结果过大，已截断并保存】原始大小 ${content.length} 字符，完整内容已写入:\n${spillPath}\n` +
      `（可用 read_file 分页读取该文件；72 小时后自动清理）\n` +
      `=== 头部预览（前 ${SPILL_PREVIEW_CHARS} 字符）===\n${head}\n` +
      `…[中间省略 ${omitted} 字符]…\n` +
      `=== 尾部预览（后 ${SPILL_PREVIEW_CHARS} 字符）===\n${tail}`
    )
  }
  return (
    `【工具结果过大，已截断（当前环境无法落盘，仅保留头尾预览）】原始大小 ${content.length} 字符\n` +
    `=== 头部预览（前 ${SPILL_PREVIEW_CHARS} 字符）===\n${head}\n` +
    `…[中间省略 ${omitted} 字符]…\n` +
    `=== 尾部预览（后 ${SPILL_PREVIEW_CHARS} 字符）===\n${tail}`
  )
}

export interface ReadBudgetResult {
  /** 最终返回给模型的内容（PARTIAL 时已含通知尾部）；error 时为空串 */
  content: string
  totalLines: number
  totalChars: number
  /** 显式请求范围仍超字符帽 → 报错文本（不静默截断） */
  error?: string
}

/**
 * read_file 分页契约（对 fsProvider 行切片结果生效，与其实现无关）：
 * 1) 单行超 2000 字符截断 + 显式标记；
 * 2) 显式范围（模型传了 limit/offset）：裁完仍超 40K 字符 → 报错（长行截断本身不报错，
 *    返回带标记内容）；默认读取：超 40K 或发生长行截断 → 截断 + PARTIAL 通知
 *    （单行巨长文件被截到 2K 后字节帽可能不再触发，但模型必须知道总量与续读方法）。
 */
export function applyReadFileBudget(
  selected: string,
  totalLines: number,
  totalChars: number,
  explicitRange: boolean,
  rangeLabel: string
): ReadBudgetResult {
  // 1) 单行超长截断（对齐 Claude Code：单行 >2000 字符截断）
  const lineClamped = selected
    .split('\n')
    .map(line =>
      line.length > READ_LINE_MAX_CHARS
        ? line.slice(0, READ_LINE_MAX_CHARS) + ` …[单行截断，原 ${line.length} 字符]`
        : line
    )
    .join('\n')

  const hadLineLoss = lineClamped.length < selected.length

  // 2a) 显式范围：只在裁完仍超字符帽时报错（报错建议缩小范围/换工具）
  if (explicitRange) {
    if (lineClamped.length > READ_MAX_CHARS) {
      return {
        content: '',
        totalLines,
        totalChars,
        error:
          `请求范围（${rangeLabel}）约 ${lineClamped.length} 字符，超过单次读取上限 ${READ_MAX_CHARS} 字符。` +
          `请减小 limit 分段读取；单行超长文件（如会话 JSON）行分页无效，请用 search_content 按关键词定位。`
      }
    }
    // 长行截断不报错：返回带标记内容即可（否则长行密集文件每一页都报错，read_file 事实上不可用）
    return { content: lineClamped, totalLines, totalChars }
  }

  // 2b) 默认读取：字节帽触发或发生长行截断 → PARTIAL 通知（绝不静默）
  if (lineClamped.length > READ_MAX_CHARS || hadLineLoss) {
    const kept = lineClamped.slice(0, READ_MAX_CHARS)
    const sizeLabel = totalLines > 0 ? `${totalLines} 行 / ${totalChars} 字符` : `${totalChars} 字符（行数未统计）`
    const notice =
      `\n\n【部分读取 PARTIAL】文件共 ${sizeLabel}，本次返回约 ${kept.length} 字符` +
      (lineClamped.length > READ_MAX_CHARS ? `（已达单次上限 ${READ_MAX_CHARS} 字符）` : '') + `。\n` +
      `- 多行文件：用 read_file 的 offset 参数继续读取后续内容\n` +
      `- 单行超长文件（如会话 JSON）行分页无效：请用 search_content 按关键词定位\n` +
      `- 超过 2000 字符的长行已截断并标记`
    return { content: kept + notice, totalLines, totalChars }
  }

  return { content: lineClamped, totalLines, totalChars }
}
