/**
 * improvePanel.tsx — TUI 改进提案决策面板（迭代 2）
 *
 * 分工：
 * - ImproveController（工厂 createImproveController）：IO 编排——打开时老化、
 *   加载决策视图（TopN/全部）、decide 直构 Decision[] 经 ImprovementLedger 唯一写入口落盘、
 *   statusline pending 镜像（异步泵，30s 由壳侧定时器驱动）。由 tuiShell 创建并注入 TuiApp。
 * - ImprovePanelView：纯渲染（簇行/展开条目/反馈行），无按键逻辑——按键统一在 TuiApp 的
 *   useInput 路由（与 viewer/ask 同一事实点，防多监听双触发）。
 * - ImproveUiState：光标/标记/展开等纯 UI 态，归 TuiApp 本地 state。
 *
 * 安全分级（设计红线）：单键只覆盖无损操作（确认=移入待实施，不触发执行）；
 * 删除走两段式（d 两次确认），且必须经 controller.decide 显式落盘。
 */
import React from 'react'
import { Text } from 'ink'
import {
  improvementLedger,
  formatDigestLine,
  type ClusterSummary,
  type Decision,
  type ProposalEntry,
} from '@assistant-ai/core'

/** 面板数据（open/refresh 的产物；clusters 已按 showAll 截取） */
export interface ImprovePanelData {
  digestLine: string
  agingNote: string | null
  clusters: ClusterSummary[]
  totalClusters: number
  pendingCount: number
  showAll: boolean
}

/** 面板纯 UI 态（TuiApp 本地持有） */
export interface ImproveUiState {
  /** 簇列表光标 */
  cursor: number
  /** 展开的簇下标（clusters 数组内下标；null=无展开） */
  expanded: number | null
  /** 展开簇内的条目光标 */
  entryCursor: number
  /** 已标记簇 id 集合（Y/S 批量动作的目标） */
  marked: Set<string>
  /** 最近动作反馈行（green ✓ / red ✗） */
  feedback: string
  /** 两段式删除的待确认簇 id（第一次 d 置位，第二次 d 执行） */
  pendingDelete: string | null
}

export function initialImproveUiState(): ImproveUiState {
  return { cursor: 0, expanded: null, entryCursor: 0, marked: new Set(), feedback: '', pendingDelete: null }
}

const TOP_N = 5

/** 簇行展示元数据（难度徽标文案） */
function difficultyLabel(c: ClusterSummary): string {
  return c.dominantDifficulty ? `${c.dominantDifficulty}难度为主` : '难度未标'
}

export interface ImproveController {
  /** 打开（进程内首次执行老化）；无提案文件返回 null */
  open(): Promise<ImprovePanelData | null>
  /** 重新加载（showAll=false 只取 Top 5 簇） */
  refresh(showAll: boolean): Promise<ImprovePanelData | null>
  /** 应用决策（结构化面直构 Decision[]，不经 parseDecisionInput）；返回错误文本或 null */
  decide(decisions: Decision[]): Promise<string | null>
  /** statusline pending 镜像（异步泵维护；null=未知/无文件） */
  pendingMirror(): number | null
  /** 手动泵一次镜像（壳侧 30s 定时器调用） */
  pumpMirror(): Promise<void>
}

export function createImproveController(): ImproveController {
  let agingDone = false
  let pending: number | null = null
  const pump = async (): Promise<void> => {
    try {
      const d = await improvementLedger.getDigest()
      pending = d?.pending ?? null
    } catch {
      pending = null
    }
  }
  const load = async (showAll: boolean): Promise<ImprovePanelData | null> => {
    const view = await improvementLedger.getView()
    if (!view) return null
    const digest = await improvementLedger.getDigest()
    const digestLine = digest ? formatDigestLine(digest) : `待确认 ${view.pendingCount} 条`
    const all = view.clusters
    return {
      digestLine,
      agingNote: null,
      clusters: showAll ? all : all.slice(0, TOP_N),
      totalClusters: all.length,
      pendingCount: view.pendingCount,
      showAll,
    }
  }
  void pump()
  return {
    async open() {
      let note: string | null = null
      if (!agingDone) {
        agingDone = true
        try {
          const r = await improvementLedger.applyAging()
          if (r.ok && r.summary) note = r.summary
        } catch {
          /* 老化失败不阻断面板 */
        }
      }
      const data = await load(false)
      void pump()
      if (data && note) return { ...data, agingNote: note }
      return data
    },
    refresh: load,
    async decide(decisions) {
      const res = await improvementLedger.decide(decisions)
      void pump()
      return res.ok ? null : (res.error ?? '写入失败')
    },
    pendingMirror: () => pending,
    pumpMirror: pump,
  }
}

/** 簇行文本（不含高亮属性；TuiApp 按 cursor/marked 决定 inverse/dim） */
export function clusterRowText(c: ClusterSummary, marked: boolean): string {
  const parts = [` ${c.id} · ${c.name} · ${c.count} 条`]
  if (c.recent > 0) parts.push(`近期+${c.recent}`)
  parts.push(difficultyLabel(c))
  if (marked) parts.push('✓已标记')
  return parts.join(' · ')
}

/** 展开簇内的条目行文本 */
export function entryRowText(e: ProposalEntry, isLast: boolean): string {
  const diff = e.difficulty ? ` · ${e.difficulty}难度` : ''
  return `   ${isLast ? '└─' : '├─'} ${e.title}${diff}`
}

/** 面板主体（纯渲染；availRows 为可用行数，内部截断防撑破帧） */
export function ImprovePanelView({
  data,
  ui,
  cols,
}: {
  data: ImprovePanelData | null
  ui: ImproveUiState
  cols: number
}): React.JSX.Element {
  if (!data) {
    return (
      <Text dimColor> 改进提案加载中…（或 ~/.chill/improvement-proposals.md 不存在：npm 模式下自动攒料不运行）</Text>
    )
  }
  if (data.clusters.length === 0) {
    return <Text dimColor> 📬 暂无待确认改进提案（{data.pendingCount} 条在册）· 按 q 返回</Text>
  }
  const rows: React.JSX.Element[] = []
  const push = (text: string, opts: { inverse?: boolean; dim?: boolean; color?: string; bold?: boolean } = {}) => {
    rows.push(
      <Text key={rows.length} wrap="truncate" {...(opts.inverse ? { inverse: true } : {})} {...(opts.dim ? { dimColor: true } : {})} {...(opts.color ? { color: opts.color } : {})} {...(opts.bold ? { bold: true } : {})}>
        {text.length > cols ? `${text.slice(0, Math.max(0, cols - 1))}…` : text}
      </Text>,
    )
  }
  push(` 📬 改进提案决策 · ${data.digestLine}`, { bold: true })
  if (data.agingNote) push(` ⏳ ${data.agingNote}`, { color: 'yellow' })
  push('─'.repeat(Math.max(8, Math.min(cols - 1, 60))), { dim: true })
  data.clusters.forEach((c, i) => {
    const isCursor = i === ui.cursor && ui.expanded === null
    push(`${i === ui.cursor ? '▶' : ' '} ${clusterRowText(c, ui.marked.has(c.id)).slice(1)}`, {
      inverse: isCursor || (ui.expanded === i && i === ui.cursor),
      dim: ui.pendingDelete !== null && ui.pendingDelete === c.id,
    })
    if (ui.expanded === i) {
      c.entries.forEach((e, ei) => {
        const isEntryCursor = i === ui.cursor && ei === ui.entryCursor
        push(entryRowText(e, ei === c.entries.length - 1), { inverse: isEntryCursor })
      })
      push(`    [y] 确认高亮条 · [a] 确认整簇 · [u] 收起`, { dim: true })
    }
  })
  if (data.totalClusters > data.clusters.length) {
    push(` …（Top ${data.clusters.length} 簇 · 按 m 展开全部 ${data.totalClusters} 簇）`, { dim: true })
  }
  if (ui.feedback) {
    push(ui.feedback, { color: ui.feedback.startsWith('✗') ? 'red' : 'green' })
  }
  return <>{rows}</>
}

/** 底部快捷键提示行（不写满右下角——帧纪律由外层 truncate 承担） */
export function improveHintLine(ui: ImproveUiState, markedCount: number): string {
  if (ui.pendingDelete) return ` 再按 d 确认删除 ${ui.pendingDelete} 簇（移入已关闭，可恢复）· 其他键取消`
  return ' [Enter/y] 确认 · [s] 跳过 · [space] 标记 · [Y] 确认已标记' +
    (markedCount > 0 ? `(${markedCount})` : '') +
    ' · [e] 展开 · [a] 全簇 · [m] 全部簇 · [d] 删除×2 · [q] 完成'
}
