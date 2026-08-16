/**
 * TUI 根组件（T3）：消息区（可见窗口）+ 单行输入框 + statusline
 *
 * 布局：根 column 固定 rows 高（满屏；经 pnpm patch 修正 ink 的两处问题后，
 * 满屏帧也走增量渲染路径——写入期间隐藏光标、无全屏清屏、无帧爬行）；
 * 消息区 flexGrow 1、overflow hidden 吃剩余空间；输入行（1 行）+ statusline（1 行）。
 * 输入：Enter 提交；/cli 退出 TUI；/ 命令复用 CLI 处理器（输出进消息区），
 * 输入 '/' 弹过滤菜单（↑/↓ 导航、Tab 补全、Esc 关闭）；
 * ←/→/Home/End 移动光标，任意位置插入/删除（真实终端光标定位，IME 候选窗正确锚定）；
 * ↑/↓ 召回输入历史；PgUp/PgDn 半屏滚动（上滚暂停跟随），Ctrl+End 回底，Ctrl+X 中断。
 */
import React, { useEffect, useReducer, useRef, useState } from 'react'
import { Box, Text, useCursor, useInput } from 'ink'
import { WINDOW_CHROME, displayCharWidth, displayWidthOf, truncateToWidth, type DisplayLine, type MessageModel } from './messageModel.js'
import type { InputHistory } from './inputHistory.js'
import { filterCommandMenu } from './commandMenu.js'
import { filterAgentMenu } from './agentMenu.js'
import { isDividerLine, stripAnsiText } from './markdown.js'

/** resize 风暴去抖：停手该时长后恢复完整渲染（Codex ~100ms 思路，留余量） */
const RESIZE_DEBOUNCE_MS = 150
import { presentPaste, type AskOption, type TodoLine } from './tuiState.js'

/** 活动区清单行数上限（含 header 与省略行）：防长清单撑破帧高、触发增量渲染账本失步。
 *  只截断活动区渲染——tracker 状态与落地留痕文本保持全量 */
export const MAX_TODO_BODY_ROWS = 8

/** 活动区渲染截断：超限时保留前 7 条 + 省略行；in_progress 不在前 7 条时追加并顶替末位
 * （朴素截断会把进行中任务藏进省略区——进行中任务始终可见） */
export function capTodoLines(lines: TodoLine[]): TodoLine[] {
  if (lines.length <= MAX_TODO_BODY_ROWS) return lines
  const head = lines.slice(0, MAX_TODO_BODY_ROWS - 1)
  const inProgress = lines.find((l) => l.status === 'in_progress')
  const kept = inProgress && !head.includes(inProgress) ? [...head.slice(0, -1), inProgress] : head
  const hidden = lines.length - kept.length
  return [...kept, { text: `  … 还有 ${hidden} 项（共 ${lines.length - 1} 项）`, status: 'pending' }]
}

/** statusline 数据来源（tuiShell 注入，每次渲染现取） */
export interface TuiStatus {
  modelName: string
  frontAgent?: string
  planMode: boolean
  /** 目标模式（已推进轮次/上限；undefined 时该段隐藏） */
  goalMode?: { roundCount: number; maxRounds: number }
  /** 引擎是否生成中（spinner/耗时显示开关） */
  running: boolean
  /** 本轮开始时间戳（耗时计算；running 时有效） */
  turnStartedAt: number
  /** 上下文余量状态（core getContextStatus；null 时该段隐藏） */
  contextStatus: { usedTokens: number; maxContextTokens?: number } | null
  /** 后台委派任务（活跃任务数 + 最久任务耗时秒；undefined 时该段隐藏） */
  background?: { count: number; longestSec: number }
}

export interface TuiAppProps {
  model: MessageModel
  history: InputHistory
  onSubmit: (text: string) => void
  onExitCli: () => void
  onAbort: () => void
  statusProvider: () => TuiStatus
  /** 提问状态（挂起时输入优先路由给提问；单字符选项时启用单键应答） */
  askState: () => { pending: boolean; options?: AskOption[]; allowFreeText: boolean; freeTextHint?: string }
  /** resize 风暴停手、恢复完整渲染之前调用（全清+重置 Ink 增量状态——
   *  最大化等大跨度 resize 后 conhost 缓冲区重排会留下增量账本之外的"重影"行,
   *  恢复帧走全量重绘才能冲掉) */
  onResizeSettled?: () => void
}

/** 剥离文本下标 → 原文下标 的映射（SGR/OSC 序列不占位；搜索高亮在剥离文本上匹配、映射回原文切分，
 *  转义序列整体归入其后续文本段，绝不在序列中间下刀——语法高亮行 SGR 密集，查询词可能命中序列内含子串） */
function strippedIndexMap(text: string): { stripped: string; map: number[] } {
  const ANSI = /\x1b\[[0-9;]*m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
  let stripped = ''
  const map: number[] = []
  let last = 0
  for (const m of text.matchAll(ANSI)) {
    const idx = m.index ?? 0
    for (let j = last; j < idx; j++) { map.push(j); stripped += text[j] }
    last = idx + m[0].length
  }
  for (let j = last; j < text.length; j++) { map.push(j); stripped += text[j] }
  return { stripped, map }
}

/** 把文本按查询词切段：当前命中行反色、其他命中行下划线（无命中原样返回）。
 *  匹配在剥离 ANSI 的文本上做（命中区间经索引映射回原文；命中段内容剥离样式交由外层 Text 属性呈现，
 *  防段内 reset 吃掉反色/下划线） */
export function renderWithHighlight(text: string, query: string, current: boolean): React.ReactNode {
  const { stripped, map } = strippedIndexMap(text)
  const lower = stripped.toLowerCase()
  const q = query.toLowerCase()
  if (!q || !lower.includes(q)) return text || ' '
  const parts: React.ReactNode[] = []
  let i = 0 // 剥离文本下标
  let pos = 0 // 原文下标
  let k = 0
  while (i < stripped.length) {
    const hit = lower.indexOf(q, i)
    if (hit === -1) {
      parts.push(text.slice(pos))
      break
    }
    const rawStart = map[hit]
    const rawEnd = map[hit + q.length - 1] + 1
    if (rawStart > pos) parts.push(text.slice(pos, rawStart))
    parts.push(
      <Text key={k++} {...(current ? { inverse: true } : { underline: true })}>
        {stripAnsiText(text.slice(rawStart, rawEnd))}
      </Text>
    )
    pos = rawEnd
    i = hit + q.length
  }
  return <>{parts}</>
}

/** 类别着色：user→'>' green+正文加粗（轮次锚点），assistant 白（默认色），thinking 灰+斜体，tool 青，notice 黄，error 红；
 *  围栏代码块内行带 dim 边框；围栏标记行 dim；highlight 非空时按查询词高亮（current 行反色、其余下划线） */
export function Line({ line, highlight, current }: { line: DisplayLine; highlight?: string; current?: boolean }): React.JSX.Element {
  const content = highlight ? renderWithHighlight(line.text, highlight, current ?? false) : line.text || ' '
  if (line.inCodeBlock) {
    return (
      <Text wrap="truncate">
        <Text dimColor>│ </Text>
        {content}
      </Text>
    )
  }
  if (line.kind === 'user') {
    // 用户行 = 轮次锚点：'>' 提示符 green + 正文加粗（悬挂缩进的续行无 '>'，整行加粗）
    if (!highlight && line.text.startsWith('>')) {
      return (
        <Text wrap="truncate">
          <Text color="green">{'>'}</Text>
          <Text bold>{line.text.slice(1)}</Text>
        </Text>
      )
    }
    return <Text bold wrap="truncate">{content}</Text>
  }
  if (line.kind === 'assistant' && isDividerLine(line.text)) {
    // 分割线(--- 等)→ 整行 dim 横线(U+2500 在 Windows Terminal 按 1 列)
    return <Text dimColor wrap="truncate">{'─'.repeat(process.stdout.columns ?? 80)}</Text>
  }
  if (line.kind === 'assistant' && /^\s*(```|~~~)/.test(line.text)) {
    return <Text dimColor wrap="truncate">{content}</Text>
  }
  // thinking 灰+斜体（行业共识视觉降级；SGR 3 在不被支持的终端自动忽略，优雅降级）
  if (line.kind === 'thinking') return <Text dimColor italic wrap="truncate">{content}</Text>
  if (line.kind === 'tool') return <Text color="cyan" wrap="truncate">{content}</Text>
  // 工具结果回显与查看器详情块：dim 弱化（对齐 thinking 观感），不抢标记行的视觉层级
  if (line.kind === 'toolResult') return <Text dimColor wrap="truncate">{content}</Text>
  if (line.kind === 'notice') return <Text color="yellow" wrap="truncate">{content}</Text>
  if (line.kind === 'error') return <Text color="red" wrap="truncate">{content}</Text>
  return <Text wrap="truncate">{content}</Text>
}

export function TuiApp(props: TuiAppProps): React.JSX.Element {
  const { model } = props
  const [input, setInput] = useState('')
  /** 光标位置（码点索引，0..len） */
  const [cursor, setCursor] = useState(0)
  /** / 菜单选中项索引 */
  const [menuIndex, setMenuIndex] = useState(0)
  /** Esc 关闭菜单（输入变化时复位） */
  const [menuDismissed, setMenuDismissed] = useState(false)
  /** 查看器搜索输入态与搜索词 */
  const [searchMode, setSearchMode] = useState(false)
  const [searchText, setSearchText] = useState('')
  const [searchRan, setSearchRan] = useState(false)
  /** 真实终端光标定位（IME 候选窗锚定用；commit 阶段冲刷） */
  const { setCursorPosition } = useCursor()
  // model 变更 / 终端 resize 都经 bump 触发重渲染（模型在 React 外，不走 state）
  const [, bump] = useReducer((x: number) => x + 1, 0)
  /** resize 风暴态：拖拽期间渲染极简占位帧（密集全屏帧重写是 win10 conhost 崩溃的
   *  负载主因——alt-screen 已解 scrollback 重排，剩余可控变量就是写入量）；
   *  每次 resize 重置计时器，停手 RESIZE_DEBOUNCE_MS 后恢复完整渲染（Codex 同款 ~100ms 思路） */
  const [resizing, setResizing] = useState(false)
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rows = process.stdout.rows ?? 24
  const cols = process.stdout.columns ?? 80
  /** 半屏滚动步长（视觉行） */
  const pageStep = Math.max(1, Math.floor((rows - WINDOW_CHROME) / 2))

  useEffect(() => model.subscribe(bump), [model])
  useEffect(() => {
    const onResize = (): void => {
      setResizing(true)
      // 风暴期内 setResizing(true) 是幂等不渲染的——占位帧也要跟随最新尺寸,显式 bump
      bump()
      if (resizeTimer.current) clearTimeout(resizeTimer.current)
      resizeTimer.current = setTimeout(() => {
        // 恢复前全清+全量重绘(鬼影清理,见 onResizeSettled 注释)
        props.onResizeSettled?.()
        setResizing(false)
      }, RESIZE_DEBOUNCE_MS)
    }
    process.stdout.on('resize', onResize)
    return () => {
      process.stdout.off('resize', onResize)
      if (resizeTimer.current) clearTimeout(resizeTimer.current)
    }
  }, [])

  const cps = Array.from(input)

  // 单键应答态判定:提问挂起 + 禁止自由文本 + 全部选项标签为单字符
  const ask = props.askState()
  const singleKeyAsk =
    ask.pending &&
    !ask.allowFreeText &&
    !!ask.options &&
    ask.options.length > 0 &&
    ask.options.every((op) => Array.from(op.label).length === 1)
  /** 交互选择菜单态:提问挂起 + 有选项 + 非单键——↑↓ 移动、回车确认选中项、Esc 取消;
   *  键入编号/文本照常作答(经 resolveAskAnswer 归一) */
  const askMenuOpen = ask.pending && !!ask.options && ask.options.length > 0 && !singleKeyAsk
  const [askSel, setAskSel] = useState(0)
  const askOptionsRef = useRef<typeof ask.options>(undefined)
  useEffect(() => {
    if (ask.options !== askOptionsRef.current) {
      askOptionsRef.current = ask.options
      setAskSel(0)
    }
  }, [ask.options])
  const askMenuSel = Math.min(askSel, (ask.options?.length ?? 1) - 1)

  // / 菜单：仅当输入为 '/xxx' 形态（无空格）且非提问等待中时弹出；Esc 可关闭
  // @ 菜单：输入末尾为 '@xxx' 形态（kebab-case）时弹出 agent 列表（模板每次渲染现取，热更新即时反映）
  const agentMatch = /(?:^|\s)(@[a-z0-9-]*)$/.exec(input)
  const menuMode: 'slash' | 'agent' | null =
    menuDismissed || props.askState().pending ? null : /^\/\S*$/.test(input) ? 'slash' : agentMatch ? 'agent' : null
  const menuItems: { name: string; desc: string; interactive?: boolean }[] =
    menuMode === 'slash' ? filterCommandMenu(input) : menuMode === 'agent' ? filterAgentMenu(agentMatch?.[1] ?? '') : []
  const menuOpen = menuItems.length > 0
  const menuSel = Math.min(menuIndex, menuItems.length - 1)
  /** 菜单可见行数（窗口计算需让出这些行）。打开期间固定 8 行：
   *  行数不变则底部区域无位移，规避增量渲染在行数突变时的撕裂残留 */
  const MENU_HEIGHT = 8
  const menuRows = menuOpen || askMenuOpen ? MENU_HEIGHT : 0

  /** 输入变化统一入口：复位菜单选中与 Esc 关闭态 */
  const setInputAndMenu = (text: string): void => {
    setInput(text)
    setMenuIndex(0)
    setMenuDismissed(false)
  }

  /** 菜单补全：/ 命令整体替换输入；@ agent 仅替换输入末尾的 @token 并补尾部空格（保留前文） */
  const applyMenuCompletion = (name: string): void => {
    const next = menuMode === 'agent' ? input.replace(/@[a-z0-9-]*$/, `${name} `) : name
    setInputAndMenu(next)
    setCursor(Array.from(next).length)
  }

  /** 在光标处插入文本（粘贴块整体到达；过滤控制字符，含 \n \r —— 单行输入框） */
  const insertAtCursor = (text: string): void => {
    const clean = Array.from(text)
      .filter((c) => displayCharWidth(c) > 0)
      .join('')
    if (!clean) return
    setInputAndMenu(cps.slice(0, cursor).join('') + clean + cps.slice(cursor).join(''))
    setCursor(cursor + Array.from(clean).length)
  }

  useInput((ch, key) => {
    if (key.ctrl && ch === 'x') {
      props.onAbort()
      return
    }
    // Ctrl+V 粘贴:raw mode 下终端原生粘贴被禁用,经 cli.ts 注册的 readClipboard 读取,
    // 归一化与 CLI 一致(\r\n→\n、去尾换行、内部换行转空格;insertAtCursor 再过滤控制字符)
    if (key.ctrl && ch === 'v') {
      const clip = presentPaste()
        .replace(/\r\n/g, '\n')
        .replace(/\n+$/, '')
        .replace(/\n/g, ' ')
      if (clip) insertAtCursor(clip)
      return
    }
    // 单键应答态:提问等待中 + 单字符选项时,y/n/数字/Esc 直接作答(仅次 Ctrl+X)
    if (singleKeyAsk) {
      if (key.escape) {
        props.onSubmit('esc')
        return
      }
      if (ch) {
        const lower = ch.toLowerCase()
        const hit = ask.options!.find((op) => op.label.toLowerCase() === lower)
        if (hit) {
          props.onSubmit(hit.label)
          return
        }
        if (/^[0-9]$/.test(ch)) {
          props.onSubmit(ch)
          return
        }
      }
      return
    }
    // 交互选择菜单态:↑↓ 移动选中、回车确认(空输入=选中项,有输入=键入答案)、Esc 取消
    if (askMenuOpen) {
      const len = ask.options!.length
      if (key.upArrow) {
        setAskSel((s) => (s - 1 + len) % len)
        return
      }
      if (key.downArrow) {
        setAskSel((s) => (s + 1) % len)
        return
      }
      if (key.escape) {
        props.onSubmit('esc')
        return
      }
      if (key.return && input === '') {
        props.onSubmit(ask.options![askMenuSel].label)
        return
      }
      // 其余按键落入正常输入编辑(键入编号/文本,回车提交走常规路径)
    }
    // transcript 查看器键路由（最高优先，打开时菜单/历史/提交等全部让位）
    if (model.viewerOpen) {
      // 搜索输入态：打字/退格编辑，Enter 执行搜索并退出输入态，Esc 放弃
      if (searchMode) {
        if (key.escape) {
          setSearchMode(false)
          return
        }
        if (key.return) {
          model.viewerSearch(searchText)
          setSearchRan(true)
          setSearchMode(false)
          return
        }
        if (key.backspace || key.delete) {
          setSearchText((s) => Array.from(s).slice(0, -1).join(''))
          return
        }
        if (ch && !key.ctrl && !key.meta) {
          const clean = Array.from(ch)
            .filter((c) => displayCharWidth(c) > 0)
            .join('')
          if (clean) setSearchText((s) => s + clean)
          return
        }
        return
      }
      if (key.escape || (key.ctrl && ch === 'o')) {
        model.toggleViewer()
        return
      }
      if (ch === '/') {
        setSearchMode(true)
        return
      }
      if (ch === 'n') {
        model.viewerJumpToMatch(1)
        return
      }
      if (ch === 'N') {
        model.viewerJumpToMatch(-1)
        return
      }
      if (ch === 'g') {
        model.viewerToTop()
        return
      }
      if (ch === 'G') {
        model.viewerToBottom()
        return
      }
      if (ch === '[' || ch === '{') {
        model.viewerJumpUser(-1)
        return
      }
      if (ch === ']' || ch === '}') {
        model.viewerJumpUser(1)
        return
      }
      if (key.upArrow) {
        model.viewerScroll(-1)
        return
      }
      if (key.downArrow) {
        model.viewerScroll(1)
        return
      }
      if (key.pageUp) {
        model.viewerPage(-1)
        return
      }
      if (key.pageDown) {
        model.viewerPage(1)
        return
      }
      if (key.home) {
        model.viewerToTop()
        return
      }
      if (key.end) {
        model.viewerToBottom()
        return
      }
      return
    }
    // Ctrl+O 打开查看器（提问回答等待中忽略）
    if (key.ctrl && ch === 'o') {
      if (!props.askState().pending) model.toggleViewer()
      return
    }
    // 菜单可见时：↑/↓ 归菜单导航（不触发历史召回），Tab 补全选中项，Esc 关菜单；
    // Enter：未输全先补全到选中项（可继续补参数），已输全则落到下方提交流程
    if (menuOpen) {
      if (key.upArrow) {
        setMenuIndex((i) => (i - 1 + menuItems.length) % menuItems.length)
        return
      }
      if (key.downArrow) {
        setMenuIndex((i) => (i + 1) % menuItems.length)
        return
      }
      if (key.tab) {
        applyMenuCompletion(menuItems[menuSel].name)
        return
      }
      if (key.escape) {
        setMenuDismissed(true)
        return
      }
      // Enter：未输全先补全到选中项（/ 可继续补参数；@ 补全带尾空格后菜单自闭合，再按 Enter 即提交），
      // 已输全则落到下方提交流程
      const completed =
        menuMode === 'agent' ? input.endsWith(menuItems[menuSel].name) : input === menuItems[menuSel].name
      if (key.return && !completed) {
        applyMenuCompletion(menuItems[menuSel].name)
        return
      }
    }
    if (key.pageUp) {
      model.scrollUp(pageStep)
      return
    }
    if (key.pageDown) {
      model.scrollDown(pageStep)
      return
    }
    if (key.ctrl && key.end) {
      model.toBottom()
      return
    }
    if (key.return) {
      const text = input
      setInputAndMenu('')
      setCursor(0)
      if (text.trim() === '/cli') {
        props.history.reset()
        props.onExitCli()
        return
      }
      if (text.trim()) {
        props.history.push(text)
        props.onSubmit(text)
      }
      return
    }
    if (key.upArrow) {
      const recalled = props.history.prev(input)
      if (recalled !== undefined) {
        setInputAndMenu(recalled)
        setCursor(Array.from(recalled).length)
      }
      return
    }
    if (key.downArrow) {
      const recalled = props.history.next()
      if (recalled !== undefined) {
        setInputAndMenu(recalled)
        setCursor(Array.from(recalled).length)
      }
      return
    }
    if (key.leftArrow) {
      setCursor((c) => Math.max(0, c - 1))
      return
    }
    if (key.rightArrow) {
      setCursor((c) => Math.min(cps.length, c + 1))
      return
    }
    if (key.home) {
      setCursor(0)
      return
    }
    if (key.end) {
      setCursor(cps.length)
      return
    }
    // Ink 把 \x7f(Windows 终端 Backspace 实际发送的字符)映射为 key.delete 而非
    // key.backspace(parse-keypress.js 的已知 TODO),二者在此无法区分,统一按"删光标前字符"
    if (key.backspace || key.delete) {
      if (cursor > 0) {
        setInputAndMenu(cps.slice(0, cursor - 1).join('') + cps.slice(cursor).join(''))
        setCursor(cursor - 1)
      }
      return
    }
    // 方向键/功能键等 ch 为空，忽略；粘贴的多字符块整体到达
    if (ch && !key.ctrl && !key.meta) insertAtCursor(ch)
  })

  // 模型层统一视觉行流：follow 时含 in-flight（原地增长钉底），暂停跟随时只给 committed
  // 菜单可见时窗口让出菜单行；任务清单活动区占独立区块，窗口同样让出其行数
  const todoLines = model.getTodoLines()
  const todoView = todoLines ? capTodoLines(todoLines) : null
  const todoRows = todoView ? todoView.length : 0
  const lines = model.visibleRows(rows - menuRows - todoRows, cols)
  const status = props.statusProvider()
  // spinner:ASCII 帧(Win10 终端字体缺盲文 ⠋ 系字符会显示为豆腐块,ASCII 全环境安全)
  const spinnerFrames = ['|', '/', '-', '\\']
  const spinner = spinnerFrames[Math.floor(Date.now() / 300) % spinnerFrames.length]
  const elapsedSec = status.running ? Math.max(0, Math.floor((Date.now() - status.turnStartedAt) / 1000)) : 0
  // 上下文余量：分子=实测占用、分母=当前模型窗口;分母缺失或服务未返回 usage 时该段隐藏
  const fmtTokens = (n: number): string =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
  const contextText = status.contextStatus?.maxContextTokens
    ? `上下文 ${fmtTokens(status.contextStatus.usedTokens)}/${fmtTokens(status.contextStatus.maxContextTokens)}(${Math.max(0, Math.round(100 * (1 - status.contextStatus.usedTokens / status.contextStatus.maxContextTokens)))}%)`
    : null
  // 底部行永不写满(cols-1):帧最后一行写满整个宽度时,末字符落在 alt 缓冲区右下角,
  // 触发 conhost 延迟折行(pending-wrap),下一帧写入时缓冲区滚动一行——帧下移、
  // 增量账本失步、每 tick 层叠一行(最大化后行不满宽即正常的根因)
  const statusLine = truncateToWidth(
    `${status.modelName}` +
      (status.running ? ` | ${spinner} 生成中 ${elapsedSec}s` : '') +
      (contextText !== null ? ` | ${contextText}` : '') +
      (status.frontAgent ? ` | 前台: ${status.frontAgent}` : '') +
      (status.background ? ` | 后台: ${status.background.count} (最长 ${status.background.longestSec}s)` : '') +
      (status.planMode ? ' | 规划模式' : '') +
      (status.goalMode ? ` | 目标模式 · 第 ${status.goalMode.roundCount} 轮` : '') +
      (model.follow ? '' : ' | 已暂停跟随 (Ctrl+End 回底)'),
    cols - 1
  )

  // 询问挂起常驻提示(statusline 行内黄色段,不新增行、不破坏帧数学):
  // 后台任务 settle 收集等场景下提问只是消息区一条 notice,易被滚动/重渲染刷走,
  // 用户不知道有询问在等输入——此处让挂起状态在底部常驻可见。
  // 与 statusLine 同处一个行向 Box(并排渲染):两者合并宽度必须 ≤ cols-1(不写满右下角,
  // 防 pending-wrap/折行引发的帧爬行层叠)。预算不足时宁可不渲染提示(消息区 notice
  // 仍完整可见)——曾用下限 6 强行显示,长状态栏下合并行必然溢出,是层叠真凶。
  const statusLineWidth = displayWidthOf(stripAnsiText(statusLine))
  const askBudget = cols - 1 - statusLineWidth - 3
  const askPendingText =
    ask.pending && askBudget >= 8
      ? truncateToWidth(
          '⚠ 等待确认: ' +
            (ask.options?.map((op) => `[${op.label}]${op.description ?? ''}`).join(' ') || '输入回答') +
            (ask.allowFreeText ? ' (也可直接输入回答)' : ''),
          askBudget
        )
      : null

  // 生成中每 300ms 定时重渲染（spinner 转动/耗时走字；空闲无定时器，零成本）
  const running = status.running
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => bump(), 300)
    return () => clearInterval(timer)
  }, [running])

  // 输入可视窗：以光标为基准滑动（列宽按显示宽度），保证光标始终可见
  const promptW = 2 // '> '
  const avail = Math.max(1, cols - promptW)
  let winStart = 0
  let wBefore = 0
  for (let i = cursor - 1; i >= 0; i--) {
    const w = displayCharWidth(cps[i])
    if (wBefore + w > avail - 1) break // 光标位本身至少占 1 列
    wBefore += w
    winStart = i
  }
  let winEnd = cps.length
  let wSum = 0
  for (let i = winStart; i < cps.length; i++) {
    const w = displayCharWidth(cps[i])
    if (wSum + w > avail) {
      winEnd = i
      break
    }
    wSum += w
  }
  const inputVisible = cps.slice(winStart, winEnd).join('')

  // 真实终端光标放到文本插入点（useCursor 在 commit 阶段冲刷到 log-update）：
  // IME 候选窗锚定硬件光标，反色假光标会让候选窗错位到别处——行业做法
  // （Codex ratatui set_cursor_position、Claude Code 接 Ink useCursor）均为真光标。
  // x = 提示符宽 + 光标前可见文本显示宽。
  // y 补偿 +1：Ink 全屏输出（outputHeight >= stdout.rows，本应用恒成立）不带尾部换行，
  // 而 buildCursorSuffix 的光标基准假设帧以换行结尾，无换行时落位偏上一行。
  // 真实终端光标（useCursor 在 commit 阶段冲刷到 log-update）：IME 候选窗锚定硬件光标，
  // 行业做法（Codex ratatui set_cursor_position、Claude Code 接 Ink useCursor）均为真光标。
  // 根高度 rows-1 使 Ink 走增量路径（带尾部换行），光标 y 直给、无补偿；
  // 该路径写入期间隐藏光标、写完才重现——不产生帧尾↔插入点的振荡鬼影。
  // 输入行与查看器提示行都在帧第 rows-3 行（消息区 rows-3 + 输入/提示 + statusline = rows-1）。
  if (model.viewerOpen) {
    if (searchMode) {
      let w = 0
      for (const c of searchText) w += displayCharWidth(c)
      setCursorPosition({ x: 2 + w, y: rows - 1 })
    } else {
      setCursorPosition(undefined)
    }
  } else {
    // 流式生成中隐藏终端光标：用户不在打字(无需 IME 锚定)，且避免 Ink log-update
    // 的 buildReturnToBottom 在无尾部换行全屏模式下计算错误的下移距离(坐标不匹配)
    // 导致增量渲染光标偏移 → 状态栏鬼影
    setCursorPosition(status.running ? undefined : { x: promptW + wBefore, y: rows - 1 })
  }

  // resize 风暴期：占位帧（帧高维持 rows,增量渲染数学不变;跳过全部数据计算,
  // 帧写入量从几十 KB 降至几百字节;in-flight 数据继续缓冲,恢复帧一并呈现)
  if (resizing) {
    return (
      <Box flexDirection="column" height={rows}>
        <Text dimColor>调整窗口大小中，松开恢复…</Text>
      </Box>
    )
  }

  // transcript 查看器：全屏替代消息区与输入行，statusline 保留，底部 1 行操作提示
  if (model.viewerOpen) {
    const viewerLines = model.viewerRows(rows - 2, cols)
    const [matchNow, matchTotal] = model.viewerMatchState
    const hint = truncateToWidth(
      searchMode
        ? `/ ${searchText}`
        : ' Esc 关闭 · ↑↓ 滚动 · PgUp/PgDn 翻页 · g/G 顶/底 · / 搜索 · n/N 换匹配 · {/} 换提问' +
          (matchTotal > 0 ? ` · 匹配 ${matchNow}/${matchTotal}` : searchRan && searchText.trim() ? ' · 无匹配' : ''),
      cols
    )
    return (
      <Box flexDirection="column" height={rows}>
        <Box flexDirection="column" flexGrow={1} justifyContent="flex-start" overflow="hidden">
          {viewerLines.map((line, i) => (
            <Line
              key={line.key}
              line={line}
              highlight={model.viewerQuery || undefined}
              current={model.viewerTopIndex + i === model.viewerCurrentRow}
            />
          ))}
        </Box>
        <Box>
          <Text dimColor wrap="truncate">{hint}</Text>
        </Box>
        <Box>
          {askPendingText && (
            <Text color="yellow" wrap="truncate">{`${askPendingText} | `}</Text>
          )}
          <Text dimColor wrap="truncate">{statusLine}</Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" height={rows}>
      <Box flexDirection="column" flexGrow={1} justifyContent="flex-start" overflow="hidden">
        {lines.map((line) => (
          <Line key={line.key} line={line} />
        ))}
      </Box>
      {todoView !== null && (
        /* 任务清单活动区：挂载在消息区与输入区之间，状态事件原位刷新（不滚入历史）；
           四状态着色（✓dim / ●cyan / ○默认 / ✗red）；落地即由模型撤除（todoLines=null）；
           行数封顶 MAX_TODO_BODY_ROWS（in_progress 优先保留 + 省略行），防撑破帧高 */
        <Box flexDirection="column">
          {todoView.map((l, i) => (
            <Text
              key={i}
              wrap="truncate"
              dimColor={l.status === 'completed'}
              color={l.status === 'in_progress' ? 'cyan' : l.status === 'failed' ? 'red' : undefined}
            >
              {l.text}
            </Text>
          ))}
        </Box>
      )}
      {menuOpen && (
        /* 固定 8 行 + 下对齐：命令项贴着输入行"落地"，空白补在上面；
           行数不变可避免增量渲染在菜单伸缩时的撕裂残留。
           滑动窗口：选中项超出 8 行时窗口跟随，始终可见 */
        <Box flexDirection="column" height={MENU_HEIGHT} justifyContent="flex-end">
          {(() => {
            const menuStart = menuSel >= MENU_HEIGHT ? menuSel - MENU_HEIGHT + 1 : 0
            return menuItems.slice(menuStart, menuStart + MENU_HEIGHT).map((entry, i) => (
              <Text key={entry.name} wrap="truncate" inverse={menuStart + i === menuSel}>
                {truncateToWidth(` ${entry.name}  ${entry.desc}${entry.interactive ? '（需 /cli）' : ''}`, cols)}
              </Text>
            ))
          })()}
        </Box>
      )}
      {askMenuOpen && (
        /* 提问交互选择菜单:与命令菜单同模式(固定 8 行/滑动窗口/反色选中),
           ↑↓ 移动、回车确认、Esc 取消(语义对齐 CLI 的按键选择器);
           自由文本 ask(allowFreeText)时底部渲染提示行(不可选中,滑动窗口让出 1 行);
           提示文案由提问方携带(规划审批="继续修改规划..."),缺省用通用文案 */
        <Box flexDirection="column" height={MENU_HEIGHT} justifyContent="flex-end">
          {(() => {
            const menuRowsForOptions = MENU_HEIGHT - (ask.allowFreeText ? 1 : 0)
            const menuStart = askMenuSel >= menuRowsForOptions ? askMenuSel - menuRowsForOptions + 1 : 0
            return (
              <>
                {ask.options!.slice(menuStart, menuStart + menuRowsForOptions).map((op, i) => (
                  <Text key={`${menuStart + i}`} wrap="truncate" inverse={menuStart + i === askMenuSel}>
                    {truncateToWidth(` ${op.label}  ${op.description ?? ''}`, cols)}
                  </Text>
                ))}
                {ask.allowFreeText && (
                  <Text wrap="truncate" dimColor>
                    {truncateToWidth(` ── ${ask.freeTextHint ?? '也可直接输入回答'}`, cols)}
                  </Text>
                )}
              </>
            )
          })()}
        </Box>
      )}
      <Box>
        <Text wrap="truncate">&gt; {inputVisible}</Text>
      </Box>
      <Box>
        {askPendingText && (
          <Text color="yellow" wrap="truncate">{`${askPendingText} | `}</Text>
        )}
        <Text dimColor wrap="truncate">{statusLine}</Text>
      </Box>
    </Box>
  )
}
