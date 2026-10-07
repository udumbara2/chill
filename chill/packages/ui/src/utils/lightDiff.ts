/**
 * 轻量视图的 diff 自绘数据层（消费 pendingOperations，不依赖 TipTap DiffPreviewExtension）
 *
 * 与编辑器侧 diff 预览同一数据源（pendingOperationsStore），保证轻量视图 / 编辑器 / 页签徽标三方同源。
 * 操作位置优先取 plainTextFrom/plainTextTo（写作文件本就纯文本落盘），多操作按时间序依次施加并跟踪偏移。
 */

import type { PendingOperation } from '../stores/pendingOperationsStore'

export interface LightDiffCounts {
  add: number
  del: number
}

export interface DiffLineRow {
  type: 'same' | 'add' | 'del'
  text: string
}

/** Windows 路径归一（比较用：统一斜杠、忽略大小写） */
export function normalizeFilePath(filePath: string): string {
  // 防御性：调用方误传 ref/对象时收敛为空串而非抛 TypeError
  return (typeof filePath === 'string' ? filePath : '').replace(/\\/g, '/').toLowerCase()
}

/** 取出作用于指定文件的全部待确认操作 */
export function collectFileOperations(operations: PendingOperation[], filePath: string): PendingOperation[] {
  const target = normalizeFilePath(filePath)
  return operations.filter(op => normalizeFilePath(op.resolvedPath || op.filePath) === target)
}

const countLines = (text: string): number => {
  const trimmed = text.replace(/\n+$/, '')
  return trimmed ? trimmed.split('\n').length : 0
}

/** create/delete_file 是整文件操作，内容在 parameters 上（防御性兼容多种载荷形状） */
const wholeFileContent = (op: PendingOperation): string => {
  const params = op.parameters || {}
  return typeof params.content === 'string'
    ? params.content
    : typeof params.file_text === 'string'
      ? params.file_text
      : ''
}

interface FlatOp {
  type: string
  from: number
  to: number
  insertContent: string
  deleteContent: string
}

const flattenOps = (fileOps: PendingOperation[]): FlatOp[] => {
  const flat: FlatOp[] = []
  for (const op of fileOps) {
    for (const o of op.operations || []) {
      if (o.type === 'create') {
        // 整文件创建：视为从头插入全文
        flat.push({ type: 'create', from: 0, to: 0, insertContent: o.insertContent ?? wholeFileContent(op), deleteContent: '' })
      } else if (o.type === 'delete_file') {
        flat.push({ type: 'delete_file', from: 0, to: Number.MAX_SAFE_INTEGER, insertContent: '', deleteContent: '' })
      } else {
        const from = o.plainTextFrom ?? o.from ?? 0
        const to = o.plainTextTo ?? o.to ?? from
        flat.push({
          type: o.type,
          from,
          to,
          insertContent: o.insertContent ?? '',
          deleteContent: o.deleteContent ?? ''
        })
      }
    }
  }
  return flat
}

/** `+N -M` 徽标计数：插入/删除内容的行数聚合（dock 页签徽标与各轻量视图同源） */
export function diffCounts(fileOps: PendingOperation[]): LightDiffCounts {
  let add = 0
  let del = 0
  for (const op of fileOps) {
    for (const o of op.operations || []) {
      if (o.type === 'create') {
        add += countLines(o.insertContent ?? wholeFileContent(op))
      } else if (o.type === 'delete_file') {
        del += countLines(op.snapshotPlainText ?? '')
      } else {
        add += countLines(o.insertContent ?? '')
        del += countLines(o.deleteContent ?? '')
      }
    }
  }
  return { add, del }
}

/** diff 基准文本：优先首个操作携带的文档快照，缺失时回退当前文件内容（近似基准） */
export function diffBaseText(fileOps: PendingOperation[], currentContent: string): string {
  for (const op of fileOps) {
    if (typeof op.snapshotPlainText === 'string') return op.snapshotPlainText
  }
  return currentContent
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

/** 将操作依次施加到基准文本，得到预览全文（供 code/html 视图的改动模式） */
export function applyOperations(base: string, fileOps: PendingOperation[]): string {
  let text = base
  let delta = 0
  for (const o of flattenOps(fileOps)) {
    if (o.type === 'delete_file') {
      delta -= text.length
      text = ''
      continue
    }
    const start = clamp(o.from + delta, 0, text.length)
    const end = o.type === 'insert' ? start : clamp(o.to + delta, start, text.length)
    text = text.slice(0, start) + o.insertContent + text.slice(end)
    delta += o.insertContent.length - (end - start)
  }
  return text
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** 逐行包裹，避免跨行 span 打断 markdown 块级解析 */
const wrapLines = (text: string, cls: string): string =>
  text
    .split('\n')
    .map(line => (line.trim() ? `<span class="${cls}">${escapeHtml(line)}</span>` : line))
    .join('\n')

/**
 * 构造带增删标注的 markdown 源（document 轻量视图用）：
 * 插入段以 lv-diff-add、删除段以 lv-diff-del 内联标注，经 html:true 的 markdown-it 渲染后保留。
 */
export function buildAnnotatedSource(base: string, fileOps: PendingOperation[]): string {
  let text = base
  let delta = 0
  for (const o of flattenOps(fileOps)) {
    if (o.type === 'delete_file') {
      return wrapLines(text, 'lv-diff-del')
    }
    const start = clamp(o.from + delta, 0, text.length)
    const end = o.type === 'insert' ? start : clamp(o.to + delta, start, text.length)
    const removed = text.slice(start, end)
    let replacement = ''
    if (removed) replacement += wrapLines(removed, 'lv-diff-del')
    if (o.insertContent) replacement += (replacement ? '\n' : '') + wrapLines(o.insertContent, 'lv-diff-add')
    text = text.slice(0, start) + replacement + text.slice(end)
    delta += replacement.length - (end - start)
  }
  return text
}

/** 行级 diff（code 视图改动模式；行数超限返回 null 仅保留徽标，避免大文件卡顿） */
export function lineDiffRows(base: string, preview: string, maxLines = 2000): DiffLineRow[] | null {
  const a = base.split('\n')
  const b = preview.split('\n')
  if (a.length > maxLines || b.length > maxLines || a.length * b.length > 4_000_000) return null

  // 标准 LCS 动态规划
  const n = a.length
  const m = b.length
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const rows: DiffLineRow[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ type: 'same', text: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ type: 'del', text: a[i] })
      i++
    } else {
      rows.push({ type: 'add', text: b[j] })
      j++
    }
  }
  while (i < n) rows.push({ type: 'del', text: a[i++] })
  while (j < m) rows.push({ type: 'add', text: b[j++] })
  return rows
}
