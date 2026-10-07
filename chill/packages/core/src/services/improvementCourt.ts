/**
 * improvementCourt — 改进提案开庭唯一事实点（手机端点选裁决卡 · core 侧）
 *
 * "对当前待确认区开庭"的完整链条收敛于此（manage_improvements 提问分支与召唤命令共用，不允许两份）：
 * 老化（applyAging，对齐 TUI 面板打开语义）→ 空账本短回 → 去重（已有开庭在跑则 reannounce 重推
 * 未决裁决卡 + 新调用方挂到共享结果 Promise——一扇门一次开庭，绝不产生两张编号快照可能不一致的卡）
 * → 构造载荷（question 文本维持 formatClusterOverview 现状 + 分页布局前置 planTriageLayout）
 * → getAskChannel().ask（自供 id）→ 收口（结构化 decisions 优先 / 文本回退 parseDecisionInput /
 * 回执复用 formatDecisionSummary）。
 *
 * 单卡原地翻页：ask=一场开庭（开庭到收卷一次落定），页=庭内视图状态（CourtSession：
 * askId/view 快照/pending 快照/offset+trail/decidedByTitle/receipts）。翻页走 cmd 通道
 * （turnImprovementCourtPage，improve.page），不动 ask 生命周期——本页 decisions 先落账再迁移
 * offset，新页卡经 cmd.result.data.card 返回（同快照 + decided 标注 + 线上字节自检）。
 * 旧手机文本「下一批」路径保留在收口循环内（新旧混跑各自正确）。
 *
 * 决策回传双通道：手机点选=结构化 decisions 直达本收口（不绕行人类模糊语法）；同时始终附带编译好的
 * 文本作 answer——旧桌面不认识新字段时走 parseDecisionInput 文本解析（向后兼容 + 人可读审计痕迹）。
 * 两条路汇入同一个 improvementLedger.decide（重读盘 + title 精确匹配 + 未命中幂等），不造第二个解析器。
 *
 * Node-free / renderer 安全（账本 IO 经 improvementLedger 注入，提问经 AskChannel 事件总线）。
 */

import { getAskChannel, type AskChannel } from './askChannel'
import { improvementLedger } from './improvementLedger'
import { randomUuid, MAX_WIRE_BYTES, type AskDecisionEntry, type AskTriageCard } from './relay/envelope'
import {
  buildDecisionView,
  planTriageLayout,
  buildTriagePageCard,
  formatClusterOverview,
  parseDecisionInput,
  type Decision,
  type DecisionParseResult,
  type DecisionView,
  type ParsedProposals,
  type ProposalEntry,
  type TriageLayout,
} from './ImprovementProposalManager'

/** 开庭结果（与 BuiltInToolResult 结构兼容，executeManageImprovements 直接回传） */
export interface CourtResult {
  success: boolean
  data?: string
  error?: string
}

/**
 * 决策结果汇总：回显用户操作（原始输入/显式动作/快捷项语义）+
 * 逐条列出标题与去向 + 未匹配告警 + 文件事后状态，让模型无需看到交互界面也能准确转述。
 * 未提及语义（迭代 1 起）：未提及的条目默认保留待确认，不自动删除。
 * @param after 落盘后的完整解析（四区计数来源）
 * @param result 可选：ask 分支传入 parseDecisionInput 结果（结构化 decisions 路径合成同形对象，
 *   rawInput=随附编译文本）；模型提交分支不传
 */
export function formatDecisionSummary(decisions: Array<{ title: string; action: string }>, after: ParsedProposals, pendingTitles: string[], result?: DecisionParseResult): string {
  const pendingSet = new Set(pendingTitles)
  // skip 语义是"保留待确认"，标题是否匹配无影响；confirm/close 未匹配则静默无效，必须告警
  const unmatched = decisions.filter(d => d.action !== 'skip' && !pendingSet.has(d.title))
  const titlesOf = (action: string) => decisions.filter(d => d.action === action && (action === 'skip' || pendingSet.has(d.title))).map(d => d.title)
  const confirmed = titlesOf('confirm')
  const closed = titlesOf('close')
  const skipped = titlesOf('skip')
  // 摘要长度折叠：超过 5 条只列前 5，避免删除几十条时刷屏
  const joinTitles = (titles: string[]): string => {
    if (titles.length === 0) return '无'
    if (titles.length <= 5) return titles.join('；')
    return `${titles.slice(0, 5).join('；')} 等 ${titles.length} 条`
  }
  const stateLine = `文件当前状态：待确认 ${after.pending.length} 条，已确认 ${after.confirmed.length} 条，已实现 ${after.closed.length} 条，已关闭 ${after.discarded.length} 条。`

  // 模型提交分支（无 result）：保持简洁计数；说明未提及语义（未提及保留，不自动删除）
  if (!result) {
    const lines = [
      `（本次调用传入 decisions 参数，工具直接应用模型提交的决策；未提及的条目保留在待确认区，不会自动删除）`,
      `proposals 文件已更新（应用模型提交的 ${decisions.length - unmatched.length} 条决策）：`,
      `- 确认 ${confirmed.length} 条（移入"已确认"区）：${joinTitles(confirmed)}`,
      `- 删除 ${closed.length} 条（移入"已关闭"区，可恢复）：${joinTitles(closed)}`,
    ]
    if (skipped.length > 0) {
      lines.push(`- 跳过 ${skipped.length} 条（保留在"待确认"区）：${joinTitles(skipped)}`)
    }
    if (unmatched.length > 0) {
      lines.push(`- 未生效 ${unmatched.length} 条（标题未匹配"待确认"区条目，已忽略）：${unmatched.map(d => d.title).join('；')}`)
    }
    lines.push(stateLine)
    return lines.join('\n')
  }

  // ask 分支（有 result）：回显用户输入 + 显式动作 + 执行路径说明
  const PATH_NOTE = '（本次调用未传 decisions 参数 → 工具已直接向终端用户（对话中的人类）展示待确认列表并等待其输入决策；未提及的条目默认保留待确认，不会静默删除）'
  const shortcutNote: Record<string, string> = { 'all': '全部确认', 's all': '全部跳过，本次未修改文件', 'del all': '全部删除' }
  // s all 未修改文件，head 不含"文件已更新"；其他分支 head 含"文件已更新"
  const head = result.shortcut === 's all'
    ? `用户输入：${result.rawInput}（${shortcutNote[result.shortcut] || result.shortcut}）`
    : result.shortcut
      ? `proposals 文件已更新（用户输入：${result.rawInput}（${shortcutNote[result.shortcut] || result.shortcut}））：`
      : `proposals 文件已更新（用户输入：${result.rawInput}）：`
  const lines = [PATH_NOTE, head]

  if (result.shortcut === 's all') {
    // 全部跳过：无实际变更，不列明细
    lines.push(stateLine)
    return lines.join('\n')
  }

  if (confirmed.length > 0) {
    lines.push(`- 确认 ${confirmed.length} 条（移入"已确认"区）：${joinTitles(confirmed)}`)
  }
  if (closed.length > 0) {
    lines.push(`- 删除 ${closed.length} 条（移入"已关闭"区，可恢复）：${joinTitles(closed)}`)
  }
  if (skipped.length > 0) {
    lines.push(`- 跳过 ${skipped.length} 条（保留在"待确认"区）：${joinTitles(skipped)}`)
  }
  if (result.invalidNums.length > 0) {
    lines.push(`- 编号 ${result.invalidNums.join('、')} 越界未生效，已忽略`)
  }
  if (result.invalidTargets.length > 0) {
    lines.push(`- 目标 ${result.invalidTargets.join('、')} 未匹配任何问题簇，已忽略`)
  }
  if (unmatched.length > 0) {
    lines.push(`- 未生效 ${unmatched.length} 条（标题未匹配"待确认"区条目，已忽略）：${unmatched.map(d => d.title).join('；')}`)
  }
  lines.push(stateLine)
  return lines.join('\n')
}

/**
 * 结构化 decisions 按**发出的那份 card** 展开为账本决策（构造与收口同源——簇 id 碰撞消歧规则
 * （#N 后缀）天然一致；若从 view 重建 clusterById，同 id 后者覆盖前者会把决策作用到错误的簇）。
 * 簇级 clusterId → 卡上该簇 entries 的 title 集、单条 title 直接校验；未知簇/未命中 title 幂等丢弃。
 * 无 card（预算降级为纯文本 ask）时不存在结构化 decisions 来源，返回空由调用方落回文本解析。
 * 产出按 pending 快照顺序（与 parseDecisionInput 产出同序，回执稳定）；同 title 重复出现后者胜出。
 */
function expandStructuredDecisions(entries: AskDecisionEntry[], card: AskTriageCard | undefined, pending: ProposalEntry[]): Decision[] {
  if (!card) return []
  const pendingTitles = new Set(pending.map((e) => e.title))
  const clusterById = new Map(card.clusters.map((c) => [c.id, c]))
  const actionByTitle = new Map<string, Decision['action']>()
  for (const e of entries) {
    if (e.clusterId !== undefined) {
      const cluster = clusterById.get(e.clusterId)
      if (!cluster) continue // 未知簇（陈旧快照）幂等丢弃
      for (const entry of cluster.entries ?? []) {
        if (pendingTitles.has(entry.title)) actionByTitle.set(entry.title, e.action)
      }
    } else if (e.title !== undefined) {
      if (pendingTitles.has(e.title)) actionByTitle.set(e.title, e.action)
      // 未命中 title 幂等丢弃
    }
  }
  const decisions: Decision[] = []
  for (const entry of pending) {
    const action = actionByTitle.get(entry.title)
    if (action) decisions.push({ title: entry.title, action })
  }
  return decisions
}

/**
 * 开庭会话态（原地翻页的事实源）。**ask = 一场开庭（开庭到收卷一次落定）；页 = 庭内视图状态**——
 * 翻页是开庭的状态迁移（改 offset + 记 decided），不是新开庭。
 * 内存态不持久化（与 AskChannel 挂起同语义：桌面重启=庭没了，手机残留卡翻页报"没有进行中的裁决"）。
 */
interface CourtSession {
  /** 当前页 ask id（原地翻页不变；旧手机文本「下一批」路径重发时更新） */
  askId: string
  /** 开庭快照（翻页/重发共用——entries 编号与簇 id 消歧口径稳定） */
  view: DecisionView
  pending: ProposalEntry[]
  /** 分页布局（开庭时一次性计算的会话事实——"第 x/y 批"的 y 全程恒定；null=预算末档不带卡纯文本庭） */
  layout: TriageLayout | null
  /** 当前页索引（翻页=纯索引迁移，clamp 在布局边界内） */
  pageIndex: number
  /** 本庭已落账（title → 动作）：页卡 entries 的 decided 标注数据源（标注与落账同一事实点） */
  decidedByTitle: Map<string, 'confirm' | 'close' | 'skip'>
  /** 落账回执累计（翻页落账与收卷落定共用，收卷时汇总进最终 CourtResult） */
  receipts: string[]
  /** 已收卷（ask 落定后翻页一律报"没有进行中的裁决"——防"提交后又点翻页"竞态） */
  settled: boolean
  /** 当前页卡（翻页落账的展开基底 = 手机手上那张） */
  card?: AskTriageCard
}

/** 模块级活动开庭（去重共享 Promise；一扇门一次开庭） */
interface ActiveCourt {
  promise: Promise<CourtResult>
  /** session 在开庭构造完成后挂上（手机有卡可点时必然已挂——卡先于可点存在） */
  session: CourtSession | null
}

let activeCourt: ActiveCourt | null = null

/** 构造当前页卡（布局投影 + 已决标注 + inplace 能力声明；预算由布局的最坏余量保证，serve 不重算） */
function buildPageCard(session: CourtSession): AskTriageCard | null {
  if (!session.layout) return null
  const card = buildTriagePageCard(session.view, session.layout, session.pageIndex, {
    pending: session.pending,
    decidedByTitle: session.decidedByTitle,
  })
  return card ? { ...card, inplace: true } : null
}

/** 开庭归因（透传给 ask 载荷的 sessionId 等）：模型开庭带发起会话归因（卡进来源会话时间线）；召唤开庭不传（纯旁路全局浮层） */
export type CourtAttribution = { sessionId?: string; taskId?: string; itemId?: string }

/**
 * 开庭入口（唯一）：已有开庭在跑 → reannounce 重推未决裁决卡（手机端同 id 幂等收敛）+
 * 新调用方共享同一结果 Promise；否则起新庭。
 * 归因分流（2026-10-04）：attribution 由调用方身份决定——manage_improvements 模型分支传
 * askAttribution（发起会话），cmd improve 召唤路径不传（旁路卡不归属任何会话）。分页重发沿用同一归因。
 */
export function openImprovementCourt(attribution?: CourtAttribution): Promise<CourtResult> {
  const ch = getAskChannel()
  if (activeCourt) {
    const pendingCard = ch.listPending().find((p) => p.card !== undefined)
    if (pendingCard) ch.reannounce(pendingCard.id)
    return activeCourt.promise
  }
  const box: ActiveCourt = { promise: null!, session: null }
  const run = doOpenCourt(ch, box, attribution).finally(() => {
    activeCourt = null
  })
  box.promise = run
  activeCourt = box
  return run
}

/**
 * 召唤开庭（cmd 通道入口，improve 命令的执行面）：去中→重推 / 空账本→空态 / 否则 fire-and-forget 开庭。
 * 即时返回三态供 cmdResult 回执；开庭 Promise 不 await（ask 可能挂很久，命令链不得被楔住——
 * startGoalRound fire-and-forget 同款纪律）。语义=对当前待确认区开庭，不触发 self-improve 审查。
 */
export async function summonImprovementCourt(): Promise<'empty' | 'reannounced' | 'issued'> {
  const ch = getAskChannel()
  if (activeCourt) {
    const pendingCard = ch.listPending().find((p) => p.card !== undefined)
    if (pendingCard) ch.reannounce(pendingCard.id)
    return 'reannounced'
  }
  // 预检与开庭同口径（先老化再判空——全陈旧账本不误报"已发出"；开庭内老化幂等 no-op）
  await improvementLedger.applyAging()
  const parsed = await improvementLedger.getParsed()
  if (!parsed || parsed.pending.length === 0) return 'empty'
  void openImprovementCourt().catch(() => {})
  return 'issued'
}

/** 翻页结果（cmd.result data 载体） */
export type CourtPageResult = { ok: true; card: AskTriageCard } | { ok: false; error: string }

/** 翻页串行化链（防连点双翻：翻页=落账+状态迁移，必须逐页顺序执行） */
let pageTurnChain: Promise<unknown> = Promise.resolve()

/**
 * 原地翻页（improve.page cmd 通道执行面）：活性检查（无开庭/已收卷 → 明确错误）→ 串行化 →
 * 本页 decisions 按**当前页 card** 展开落账（翻页即提交，崩溃安全不丢；回执累计进 session，收卷汇总）
 * → 页索引迁移（纯索引：pages[i±1]，clamp=边界页原地不动）→ 布局投影新页卡（decided 标注体积
 * 已在布局预算预留，serve 不爆）→ 线上字节自检（cmd.result 明文 ≈ card JSON + 信封开销，
 * base64url 膨胀 4/3 后须 ≤ MAX_WIRE_BYTES，超限返回错误不翻页——手机停留本页+toast，不静默丢）。
 */
export function turnImprovementCourtPage(dir: 'next' | 'prev', decisions?: AskDecisionEntry[]): Promise<CourtPageResult> {
  const exec = async (): Promise<CourtPageResult> => {
    const session = activeCourt?.session
    if (!session || session.settled) return { ok: false, error: '没有进行中的裁决' }
    if (!session.layout) return { ok: false, error: '当前裁决无裁决卡，不可翻页' }

    // 本页 decisions 先落账（title 匹配幂等：重复提交同动作无害）
    if (decisions && decisions.length > 0) {
      const expanded = expandStructuredDecisions(decisions, session.card, session.pending)
      if (expanded.length > 0) {
        const res = await improvementLedger.decide(expanded)
        if (!res.ok) return { ok: false, error: `翻页落账失败: ${res.error}` }
        for (const d of expanded) session.decidedByTitle.set(d.title, d.action)
        const after = await improvementLedger.getParsed()
        session.receipts.push(formatDecisionSummary(expanded, after!, session.pending.map((e) => e.title)))
      }
    }

    // 页索引迁移（布局确定性后 trail 退役：prev=pages[i-1]，无需记轨迹）
    const prevIndex = session.pageIndex
    if (dir === 'next') {
      if (session.pageIndex + 1 < session.layout.pages.length) session.pageIndex++
    } else {
      if (session.pageIndex > 0) session.pageIndex--
    }

    // 新页卡（cmd.result 场景无 question 同捆；布局按含 question 的更严口径预留过预算）
    const card = buildPageCard(session)
    if (!card) {
      session.pageIndex = prevIndex // 回滚游标，停留本页
      return { ok: false, error: '页载荷构造失败（超预算），未翻页' }
    }
    const wireBytes = Math.ceil((new TextEncoder().encode(JSON.stringify(card)).length + 256) * 4 / 3)
    if (wireBytes > MAX_WIRE_BYTES) {
      session.pageIndex = prevIndex
      return { ok: false, error: '页载荷超线上字节上限，未翻页' }
    }
    session.card = card
    return { ok: true, card }
  }
  const run = pageTurnChain.then(exec, exec)
  pageTurnChain = run
  return run
}

async function doOpenCourt(ch: AskChannel, box: ActiveCourt, attribution?: CourtAttribution): Promise<CourtResult> {
  // 空账本短回（无文件=空态，维持工具既有语义，不因老化前置而报错）
  const existing = await improvementLedger.getParsed()
  if (!existing) return { success: true, data: '（暂无待确认改进提案）' }

  // 开庭前补做 30 天老化（对齐 TUI 面板打开语义；老化失败不阻断开庭，照 TUI 先例容忍）
  const aging = await improvementLedger.applyAging()
  const agingLine = aging.ok && aging.summary ? `⏳ ${aging.summary}\n` : ''
  const parsed = (await improvementLedger.getParsed()) ?? existing
  if (parsed.pending.length === 0) {
    return { success: true, data: `${agingLine}（暂无待确认改进提案）` }
  }

  // 构造载荷：question 文本维持 formatClusterOverview 现状一字不动（TUI/GUI/旧手机渲染零变化）；
  // 卡载荷由分页布局投影供给（降级链收口：理由截断→首条详情→分页→不带 card 纯文本降级）。
  // 分页自描述：多页时 card 带 batch:{offset,total,pageIndex,pageCount}，question 尾部追加「下一批」提示行
  // （唯一新增文本，仅多页时存在；簇摘要+语法说明部分一字不动）。
  const basePrompt =
    `${formatClusterOverview(parsed)}\n\n` +
    `请回复你的决策（簇编号=组名前缀 C 编号，可整簇裁决）：\n` +
    `- y C26 或「确认 C26 簇」  确认整簇（移入已确认区）\n` +
    `- s C26 / s all      跳过（保留待确认）\n` +
    `- del C26 / del all  删除整簇（移入已关闭区，可恢复）\n` +
    `- all                全部确认\n` +
    `未提及的条目默认保留待确认，不会静默删除。逐条阅读与单条裁决请用桌面 /improve 面板。`

  // 结构化选项（AskChannel options 枢纽：TUI ↑↓ 菜单 / GUI 按钮弹窗 / 手机选项卡自动点亮；
  // label 为友好短语，parseDecisionInput 宽松解析——只给无空格簇标识出按钮，防分词歧义）
  const view = buildDecisionView(parsed)
  const topClusters = view.clusters.filter(c => !/\s/.test(c.id)).slice(0, 3)
  const options: Array<{ label: string; description: string }> = topClusters.map(c => ({
    label: `确认 ${c.id} 簇`,
    description: `${c.count} 条 · ${c.dominantDifficulty ? `${c.dominantDifficulty}难度为主` : '难度未标'}${c.recent > 0 ? ` · 近期新增 ${c.recent}` : ''}`,
  }))
  options.push({ label: '跳过本轮', description: '全部保留待确认，本次不处理' })

  const pendingTitles = parsed.pending.map(e => e.title)

  // 分页布局前置（"第 x/y 批"跳变根治）：开庭时按最终 question 字节一次性计算完整布局
  // （同一 view 快照、同一预算口径、decided 最坏余量——布局是纯函数，页界与页数全程恒定）。
  // 两遍：先按基础 question 规划；多页则追加尾部提示行后按新字节数重规划（新字节只可能让布局更保守）。
  let prompt = basePrompt
  let layout = planTriageLayout(view, new TextEncoder().encode(prompt).length, { pending: parsed.pending })
  if (layout && layout.pages.length > 1) {
    const hidden = view.clusters.length - layout.pages[0]!.clusterCount
    const promptWithTail = `${basePrompt}\n\n（其余 ${hidden} 簇已在桌面就绪，回复「下一批」）`
    const relayout = planTriageLayout(view, new TextEncoder().encode(promptWithTail).length, { pending: parsed.pending })
    if (relayout) {
      prompt = promptWithTail
      layout = relayout
    }
  }

  // 开庭会话态：页=庭内视图状态（原地翻页=页索引迁移 + 记 decided，不动 ask 生命周期）
  const session: CourtSession = {
    askId: '',
    view,
    pending: parsed.pending,
    layout,
    pageIndex: 0,
    decidedByTitle: new Map(),
    receipts: [],
    settled: false,
  }
  box.session = session

  // 分批开庭循环：旧手机文本「下一批」重发属同一场开庭的延续（在 doOpenCourt 内循环，不触发去重）；
  // 新手机原地翻页不经此循环（ask 保持挂起，页迁移全在 turnImprovementCourtPage）
  for (;;) {
    const card = buildPageCard(session)
    const id = randomUuid()
    session.askId = id
    session.card = card ?? undefined
    const response = await ch.ask(prompt, options, true, '如 y C26 确认整簇 / s all 全部跳过', attribution, { id, card: card ?? undefined })
    const trimmed = (response || '').trim()

    // 快捷收场：用户点了「跳过本轮」类选项 → 明确的无变更语义（不报"未识别"）
    if (/^(跳过本轮|稍后|下次再说)/.test(trimmed)) {
      session.receipts.push(
        session.receipts.length === 0
          ? `用户选择跳过本轮：全部 ${parsed.pending.length} 条保留待确认，文件未修改。`
          : '用户选择跳过本轮：其余待确认条目保留，本轮未修改。',
      )
      break
    }

    // 「下一批」识别在 parseDecisionInput 之前短路（它是决策语法解析器，不塞导航语义）；
    // 与已点选决策同发不互斥：decisions 照常随本次落定落账，随后重发下一批卡片
    const isNextBatch = trimmed === '下一批'

    // 收口：结构化 decisions 优先（手机点选双通道之结构化路；全部未命中幂等丢弃后回退文本解析）
    const structured = ch.takeSettledDecisions(id)
    let decisions: Decision[] | null = null
    let result: DecisionParseResult | undefined
    if (structured) {
      // 按本批次发出的 card 展开（分批翻页各批用自己的卡；消歧后缀口径与构造同源）
      const expanded = expandStructuredDecisions(structured, card ?? undefined, parsed.pending)
      if (expanded.length > 0) {
        decisions = expanded
        // 回执复用 ask 分支格式：rawInput=随附编译文本（落定展示"用户输入：y C26 del C30"保持人可读审计痕迹）
        result = { rawInput: trimmed, shortcut: null, decisions: expanded, explicitCount: expanded.length, autoClosedCount: 0, invalidNums: [], invalidTargets: [] }
      }
    }
    if (!decisions && !isNextBatch) {
      // 文本回退：簇语法/友好短语/快捷项 + 未提及默认保留（keep）+ 空输入保护
      result = parseDecisionInput(response, parsed.pending, { onUnmentioned: 'keep' })
      if (result.decisions.length === 0) {
        const shown = trimmed || '（空白）'
        session.receipts.push(
          session.receipts.length === 0
            ? `（本次调用未传 decisions 参数 → 工具已直接向终端用户（对话中的人类）展示待确认列表并等待其输入决策）\n未识别到有效决策（用户输入：${shown}），文件未修改`
            : `未识别到有效决策（用户输入：${shown}），本轮未修改`,
        )
        break
      }
      decisions = result.decisions
    }

    if (decisions && decisions.length > 0) {
      const res = await improvementLedger.decide(decisions)
      if (!res.ok) return { success: false, error: `manage_improvements 执行失败: ${res.error}` }
      const after = await improvementLedger.getParsed()
      session.receipts.push(formatDecisionSummary(decisions, after!, pendingTitles, result))
    }

    if (isNextBatch) {
      // 旧手机文本路径：游标=布局页索引（pages[i+1]；布局在开庭时已按同一快照算定，页界与翻页口径一致）
      const layout = session.layout
      if (layout && session.pageIndex + 1 < layout.pages.length) {
        session.pageIndex++
        continue
      }
      session.receipts.push(session.card ? '（已是最后一批，没有更多簇）' : '（无分批裁决卡，无可翻页）')
    }
    break
  }

  session.settled = true
  return { success: true, data: agingLine + session.receipts.join('\n') }
}
