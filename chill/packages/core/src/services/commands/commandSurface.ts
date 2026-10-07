/**
 * 命令面注册表（M8 cmd.* 的唯一事实点）——命令 = core 能力（数据驱动），呈现 = 壳本地。
 *
 * 五壳共享：CLI/UI 经装配注入服务引用（executeCommand / buildCommandState 的 deps）；
 * 手机经 cmd.state.catalog 协议供给（不 import core——壳能力一律由 core 与协议供给）。
 *
 * 纪律（见《手机端命令面-实施规划.md》）：
 * - CommandSpec 是数据：presentation/section 是壳渲染的输入（runtimeProjection 先例——数据非显示代码）
 * - channel 唯一判据：fast = 不碰引擎串行链（只读服务或 abort 并发安全）；serial = 改会话状态（排队轮末生效=诚实语义）
 * - executor 绑定唯一事实点在本文件：双壳只注入服务引用，不写绑定（防按壳分叉的重复实现）
 * - 线形类型 import type 对齐 ../relay/envelope（协议唯一事实点），不双源
 * - 权限档（mode.set/mode.state）不在命令面：既有 M5 通道保持不动
 */
import type { CommandCatalogEntry, CommandStateSnapshot } from '../relay/envelope'
import type { ModelInfo } from '../models/types'
import type { ModelParameterSettings } from '../selectedModelsService'
import type { AvailableSubagent } from '../../orchestrator/types'
import { deriveModelKind } from '../models/deriveModelKind'
import { improvementLedger } from '../improvementLedger'
import { MessageRole, type Message } from '../../types/models'
import { summarizeDigest, type ConfirmedTransition } from '../ImprovementProposalManager'
import { summonImprovementCourt, turnImprovementCourtPage } from '../improvementCourt'
import { getOwnProjectPaths } from '../../utils/projectPaths'
import type { AskDecisionEntry } from '../relay/envelope'
import { setDesktopControl, setAutoSwitchFlag, readDesktopEnabled, readAutoSwitch, type DesktopControlDeps, type DesktopControlStore } from '../desktopControl'

// ==================== 规格类型 ====================

export type CommandChannel = 'fast' | 'serial'
export type CommandRisk = 'instant' | 'confirm' | 'input'
export type CommandSection = 'answer' | 'advance' | 'maintain'
export type CommandPresentation = 'console-row' | 'picker' | 'input-morph' | 'strip' | 'badge'

export interface CommandSpec {
  id: string
  title: string
  section: CommandSection
  presentation: CommandPresentation
  risk: CommandRisk
  channel: CommandChannel
  /** picker 型命令的惰性选项源命令 id（打开时 cmd.request 拉取） */
  options?: { lazy: string }
  /** 选项源类命令（model.list 等）：可执行但不出现在 cmd.state.catalog（非用户面向行） */
  internal?: boolean
  /** 仅 managed 布局（自迭代条件具备）才进目录——npm 模式不下发该行（门控双保险之一；执行器内另有复核） */
  managedOnly?: boolean
}

// ==================== 注册表数据（22 条；新命令 = 加一行，协议零改动） ====================

export const COMMAND_REGISTRY: CommandSpec[] = [
  // fast：不碰引擎串行链（turn.stop 的 abort 并发安全；两个 list 是纯只读服务；idea 是纯文件追加）
  { id: 'turn.stop', title: '停止本轮', section: 'advance', presentation: 'input-morph', risk: 'instant', channel: 'fast' },
  { id: 'model.list', title: '模型列表', section: 'answer', presentation: 'picker', risk: 'instant', channel: 'fast', internal: true },
  { id: 'front.list', title: '前台列表', section: 'answer', presentation: 'picker', risk: 'instant', channel: 'fast', internal: true },
  // serial：改会话状态（轮末生效）
  { id: 'model.set', title: '模型', section: 'answer', presentation: 'picker', risk: 'instant', channel: 'serial', options: { lazy: 'model.list' } },
  { id: 'model.param', title: '思考强度', section: 'answer', presentation: 'picker', risk: 'instant', channel: 'serial' },
  { id: 'front.set', title: '会话前台', section: 'answer', presentation: 'picker', risk: 'instant', channel: 'serial', options: { lazy: 'front.list' } },
  { id: 'plan.set', title: '规划模式', section: 'advance', presentation: 'console-row', risk: 'instant', channel: 'serial' },
  { id: 'compact', title: '压缩上下文', section: 'maintain', presentation: 'console-row', risk: 'confirm', channel: 'serial' },
  { id: 'goal.set', title: '目标', section: 'advance', presentation: 'console-row', risk: 'input', channel: 'serial' },
  { id: 'goal.pause', title: '暂停目标', section: 'advance', presentation: 'strip', risk: 'instant', channel: 'serial' },
  { id: 'goal.resume', title: '恢复目标', section: 'advance', presentation: 'strip', risk: 'instant', channel: 'serial' },
  { id: 'goal.abandon', title: '放弃目标', section: 'advance', presentation: 'strip', risk: 'confirm', channel: 'serial' },
  // 会话管理（首个"非活动会话"命令族：按 args.sessionId 作用于任意会话——PROTOCOL-FROZEN.md
  // "命令作用于桌面活动会话"语义行的成文例外；serial=与在途轮写盘保序；internal=手机手势携带
  // sessionId 调用，不进 cmd.state.catalog 目录行）
  { id: 'session.delete', title: '删除会话', section: 'maintain', presentation: 'console-row', risk: 'confirm', channel: 'serial', internal: true },
  { id: 'session.rename', title: '重命名会话', section: 'maintain', presentation: 'console-row', risk: 'input', channel: 'serial', internal: true },
  // 闪念捕获（决策闭环人类直报入口）：fast=纯账本追加（并发安全由 ledger 串行化承担）；
  // managedOnly=npm 模式目录不下发（手机端查目录决定 💡/菜单行显隐——不自己猜）
  { id: 'idea', title: '记个点子', section: 'maintain', presentation: 'input-morph', risk: 'input', channel: 'fast', managedOnly: true },
  // 提案决策（手机召唤裁决卡）：fast=开庭不碰引擎串行链（ask 走事件总线，账本写有 ledger 串行化；
  // 执行器 fire-and-forget 不 await 开庭 Promise——ask 可能挂很久，命令链不得被楔住）。
  // managedOnly=npm 模式目录不下发；与 CLI/TUI 本地 /improve 面板命令无涉（注册表只喂手机目录）
  { id: 'improve', title: '提案决策', section: 'maintain', presentation: 'console-row', risk: 'instant', channel: 'fast', managedOnly: true },
  // 裁决卡原地翻页（卡内驱动：internal=不进目录不上菜单；fast=落账走 ledger 串行化 + 翻页走
  // 模块级 pageTurnChain 串行化，不碰引擎串行链）。managedOnly 与 improve 同闸
  { id: 'improve.page', title: '裁决卡翻页', section: 'maintain', presentation: 'console-row', risk: 'instant', channel: 'fast', internal: true, managedOnly: true },
  // 子任务交付物拉取（C 迭代，手机工作计划行点击）：fast=纯只读；internal+managedOnly=不进目录、
  // 手机端按目录门控行可点性（目录无此行→不可点，旧桌面零报错降级）
  { id: 'task.detail', title: '子任务交付物', section: 'maintain', presentation: 'console-row', risk: 'instant', channel: 'fast', internal: true, managedOnly: true },
  // 已确认/已关闭清单拉取（D 迭代，手机长按💡空态视图）：fast=纯只读账本投影；门控同上
  { id: 'improve.confirmed', title: '已确认清单', section: 'maintain', presentation: 'console-row', risk: 'instant', channel: 'fast', internal: true, managedOnly: true },
  // 已确认/已关闭区四向流转（D 迭代）：fast=纯账本写（并发安全由 ledger transact 串行化承担，
  // 与 idea 同款判据不碰引擎串行链）；risk=confirm（手机端两��式确认防线）；门控同上
  { id: 'improve.confirmed.decide', title: '已确认流转', section: 'maintain', presentation: 'console-row', risk: 'confirm', channel: 'fast', internal: true, managedOnly: true },
  // 记忆库管理（直记+事��治理迭代）：目录行+四 internal 命令；fast=纯文件读写（memoryStore 单写者，
  // 判据同 idea 账本串行化）；非 managedOnly——npm 模式同样有记忆；memory.delete=confirm（两段防线）
  { id: 'memory', title: '记忆', section: 'maintain', presentation: 'console-row', risk: 'instant', channel: 'fast' },
  { id: 'memory.list', title: '记忆列表', section: 'maintain', presentation: 'console-row', risk: 'instant', channel: 'fast', internal: true },
  { id: 'memory.show', title: '记忆详情', section: 'maintain', presentation: 'console-row', risk: 'instant', channel: 'fast', internal: true },
  { id: 'memory.delete', title: '删除记忆', section: 'maintain', presentation: 'console-row', risk: 'confirm', channel: 'fast', internal: true },
  { id: 'memory.seen', title: '记忆巡检水位', section: 'maintain', presentation: 'console-row', risk: 'instant', channel: 'fast', internal: true },
  // 宿主级开关（��机遥控桌面 CLI/TUI 的 /desktop、/auto-switch 同源同键；共享核心单一事实点在 desktopControl）：
  // desktop.set=confirm（放行键鼠是敏感动作，手机两段式防线）+serial（合成消息注入改会话流，轮末生效不楔在途轮）；
  // autoswitch.set=instant+fast（纯 KV 写不碰引擎串行链——消费点在自迭代收尾，与在途轮语义无涉）
  { id: 'desktop.set', title: '桌面能力', section: 'maintain', presentation: 'console-row', risk: 'confirm', channel: 'serial' },
  { id: 'autoswitch.set', title: '自动切换', section: 'maintain', presentation: 'console-row', risk: 'instant', channel: 'fast' },
]

export function resolveCommand(id: string): CommandSpec | undefined {
  return COMMAND_REGISTRY.find((c) => c.id === id)
}

/**
 * 目录投影（cmd.state.catalog 线形）：排除 internal 选项源命令；managedOnly 命令仅在
 * managed 布局（自迭代条件具备）时下发——npm 模式下手机目录无此行，入口"不存在"而非"禁用"。
 */
export function commandCatalog(): CommandCatalogEntry[] {
  const managed = getOwnProjectPaths().projectPath !== null
  return COMMAND_REGISTRY.filter((c) => !c.internal && (managed || !c.managedOnly)).map((c) => ({
    id: c.id,
    title: c.title,
    section: c.section,
    presentation: c.presentation,
    risk: c.risk,
    channel: c.channel,
    ...(c.options ? { options: { lazy: c.options.lazy } } : {}),
  }))
}

// ==================== args 校验（纯函数） ====================

export interface CommandIssue {
  code: 'invalid_args'
  message: string
}

function needString(args: Record<string, unknown>, key: string, issue: string): CommandIssue | null {
  const v = args[key]
  if (typeof v !== 'string' || !v.trim()) return { code: 'invalid_args', message: `${issue}：缺少字符串参数 ${key}` }
  return null
}

function optString(args: Record<string, unknown>, key: string): CommandIssue | null {
  const v = args[key]
  if (v !== undefined && typeof v !== 'string') return { code: 'invalid_args', message: `参数 ${key} 须为字符串` }
  return null
}

/** 逐命令参数校验；返回 null = 通过。控制面 args 是结构化 JSON，永不插值进对话文本。 */
export function validateArgs(spec: CommandSpec, args?: Record<string, unknown>): CommandIssue | null {
  const a = args ?? {}
  switch (spec.id) {
    case 'model.set':
      return needString(a, 'name', '模型名缺失')
    case 'model.param':
      if (typeof a['param'] !== 'string' || !a['param']) return { code: 'invalid_args', message: '缺少参数名 param' }
      if (a['value'] === undefined || a['value'] === null) return { code: 'invalid_args', message: '缺少参数值 value' }
      return null
    case 'front.set': {
      const t = a['type']
      if (t !== undefined && t !== null && typeof t !== 'string') return { code: 'invalid_args', message: '参数 type 须为字符串或 null' }
      return null
    }
    case 'plan.set':
      if (typeof a['on'] !== 'boolean') return { code: 'invalid_args', message: '缺少布尔参数 on' }
      return null
    case 'desktop.set':
    case 'autoswitch.set':
      if (typeof a['on'] !== 'boolean') return { code: 'invalid_args', message: '缺少布尔参数 on' }
      return null
    case 'compact':
      return optString(a, 'guidance')
    case 'idea':
      return needString(a, 'text', '点子内容缺失')
    case 'improve.page': {
      const dir = a['dir']
      if (dir !== 'next' && dir !== 'prev') return { code: 'invalid_args', message: 'dir 须为 next|prev' }
      const ds = a['decisions']
      if (ds !== undefined) {
        if (!Array.isArray(ds)) return { code: 'invalid_args', message: 'decisions 须为数组' }
        for (const d of ds) {
          if (d === null || typeof d !== 'object') return { code: 'invalid_args', message: 'decisions 元素须为对象' }
          const e = d as Record<string, unknown>
          if (e['action'] !== 'confirm' && e['action'] !== 'close' && e['action'] !== 'skip') {
            return { code: 'invalid_args', message: 'decisions.action 须为 confirm|close|skip' }
          }
          const hasCluster = typeof e['clusterId'] === 'string' && e['clusterId'] !== ''
          const hasTitle = typeof e['title'] === 'string' && e['title'] !== ''
          if (!hasCluster && !hasTitle) return { code: 'invalid_args', message: 'decisions 元素须带 clusterId 或 title' }
        }
      }
      return null
    }
    case 'memory.show':
    case 'memory.delete':
      return needString(a, 'title', '记忆标题缺失')
    case 'session.delete':
      return needString(a, 'sessionId', '会话 id 缺失')
    case 'session.rename': {
      const sid = needString(a, 'sessionId', '会话 id 缺失')
      if (sid) return sid
      const t = needString(a, 'title', '标题缺失')
      if (t) return t
      if (String(a['title']).trim().length > 100) return { code: 'invalid_args', message: '标题超长（≤100 字符）' }
      return null
    }
    case 'goal.set': {
      const name = needString(a, 'objective', '目标缺失')
      if (name) return name
      const crit = optString(a, 'criteria')
      if (crit) return crit
      const mr = a['maxRounds']
      if (mr !== undefined && (typeof mr !== 'number' || !Number.isInteger(mr) || mr < 1 || mr > 100)) {
        return { code: 'invalid_args', message: 'maxRounds 须为 1-100 的整数' }
      }
      return null
    }
    default:
      // turn.stop / model.list / front.list / goal.pause / goal.resume / goal.abandon：无必填参数
      return null
  }
}

// ==================== 引擎/服务端口（结构化最小面；双壳注入真实服务引用，测试注入 fake） ====================

/** 状态快照所需的引擎读口（ChatEngine 结构兼容） */
export interface CommandEnginePort {
  getSessionState(): {
    sessionId: string | null
    planMode: boolean
    frontAgent?: string
    isRunning: boolean
    goalMode?: { active: boolean; objective: string; roundCount: number; maxRounds: number }
  }
  getContextStatus(): { usedTokens: number; usedTokensApprox?: boolean; maxContextTokens?: number } | null
}

/** 命令执行所需的引擎写口（M2 起绑定；ChatEngine 结构兼容） */
export interface CommandEngineWritePort extends CommandEnginePort {
  abort(): void
  setPlanMode(on: boolean): void
  setFrontAgent(type?: string): void
  /** 前台候选（仅本地模板；远程模板无连续对话能力只能被 task 委派——与 CLI /front 同口径） */
  getFrontAgentCandidates(): AvailableSubagent[]
  compactHistory(guidance?: string, opts?: { trigger?: string }): Promise<unknown>
  setGoal(objective: string, successCriteria?: string, maxRounds?: number): void
  pauseGoal(): void
  resumeGoal(): Promise<void>
  clearGoal(): void
  /** 脱离当前会话记录（清记录 id 铸新 id、保留历史——session.delete 删活动会话时防引擎下次 save 复活文件） */
  detachSession(): void
  /** 合成消息注入（desktop.set 开关告知模型工具集变化；可选=旧 fake 可缺省，执行器守卫） */
  appendSyntheticMessage?(text: string, tag?: string): unknown
  /** 活动会话全量历史（task.detail 的活动会话数据源——settle 消息可能尚未落盘，内存才是真相源） */
  getHistory?(): Message[]
}

export interface CommandModelsReadPort {
  getCurrentModelName(): string | null
  getModelParameters(modelName: string): Record<string, unknown> | null
}

export interface CommandModelsWritePort extends CommandModelsReadPort {
  saveCurrentModelName(modelName: string): void
  getModelParameterSettings(modelName: string): ModelParameterSettings | null
  saveModelParameterSettings(settings: ModelParameterSettings): void
}

export interface CommandModelInfoPort {
  getModelsWithApiKeys(): Promise<ModelInfo[]>
  /** 与 CLI /model list 同口径：全部模型 + hasApiKey 状态（手机列表的正式数据源） */
  getAllModelsWithApiKeyStatus(): Promise<Array<{ model: ModelInfo; hasApiKey: boolean }>>
}

/** 状态快照依赖（双壳共用 buildCommandState——单一实现，防按壳分叉） */
export interface CommandStateDeps {
  engine?: CommandEnginePort
  models?: CommandModelsReadPort
  /** 宿主开关读面（cmd.state 快照的 desktop/autoswitch 标量；未装配→字段缺省=未知，≠false） */
  hostFlags?: Pick<DesktopControlStore, 'getItem'>
  /** 记忆"新 N"同步读口（newCount 缓存在 memoryStore 内；未装配→字段缺省=未知） */
  memory?: { getNewCount(): number | undefined }
}

/**
 * 命令面状态快照（cmd.state.state 的唯一产出点）。
 * 口径：ctx = engine getContextStatus（lastUsage 实测 → 压缩 checkpoint 估值，approx 透传）；
 * goal = goalMode.active ? 'active' : 'paused'（达成即归档清目标，无常态 achieved）；
 * model.effort = 当前模型参数 reasoning_effort（未设置则缺省）。
 */
export function buildCommandState(deps: CommandStateDeps): CommandStateSnapshot {
  const s = deps.engine?.getSessionState()
  const modelName = deps.models?.getCurrentModelName() ?? null
  const params = modelName ? (deps.models?.getModelParameters(modelName) ?? null) : null
  const effortRaw = params?.['reasoning_effort']
  const effort = typeof effortRaw === 'string' && effortRaw ? effortRaw : undefined
  const ctx = deps.engine?.getContextStatus() ?? null
  const desktop = readDesktopEnabled(deps.hostFlags)
  const autoswitch = readAutoSwitch(deps.hostFlags)
  return {
    sessionId: s?.sessionId ?? null,
    running: s?.isRunning ?? false,
    plan: s?.planMode ?? false,
    model: modelName ? { name: modelName, ...(effort !== undefined ? { effort } : {}) } : null,
    front: s?.frontAgent ?? null,
    goal: s?.goalMode
      ? {
          status: s.goalMode.active ? 'active' : 'paused',
          objective: s.goalMode.objective,
          round: s.goalMode.roundCount,
          maxRounds: s.goalMode.maxRounds,
        }
      : null,
    ctx: ctx
      ? {
          used: ctx.usedTokens,
          ...(ctx.maxContextTokens !== undefined ? { max: ctx.maxContextTokens } : {}),
          ...(ctx.usedTokensApprox ? { approx: true } : {}),
        }
      : null,
    // 宿主级标量（不随会话变；undefined=未装配读口/未知，严格区别于已关 false）
    ...(desktop !== undefined ? { desktop } : {}),
    ...(autoswitch !== undefined ? { autoswitch } : {}),
    ...(deps.memory !== undefined ? { memoryNewCount: deps.memory.getNewCount() } : {}),
  }
}

// ==================== 执行机械（M1 dormant：executors 空，M2-M4 逐里程碑填充） ====================

/**
 * 会话持久化端口（session.delete/session.rename 的执行面；Node-free 纯注入：
 * CLI 直连 SessionPersistence，UI 经 host API IPC + 注册表收口适配——与 SessionResult 同构）
 */
export interface CommandSessionsPort {
  patchTitle(id: string, title: string): Promise<{ success: boolean; error?: string }>
  delete(id: string): Promise<{ success: boolean; error?: string }>
  /** 读会话消息（task.detail 的非活动会话数据源；未装配时该路径诚实 unsupported） */
  readMessages?(id: string): Promise<Message[] | null>
}

/** 记忆库执行端口（结构兼容 memoryStore 单例公共面；MemoryEntry 结构内联取所需字段） */
export interface MemoryCommandEntry {
  name: string
  type: string
  hook: string
  body: string
  importance: number
  created_at: string
  updated_at: string
  last_used_at: string
  usage_count: number
}

export interface MemoryCommandPort {
  list(): Promise<MemoryCommandEntry[]>
  readSeenAt(): Promise<string | null>
  writeSeenAt(ts: string): Promise<void>
  isNewerEntry(e: MemoryCommandEntry, seenAt: string | null): boolean
  remove(title: string): Promise<{ success: boolean; error?: string }>
}

export interface CommandExecDeps {
  engine?: CommandEngineWritePort
  models?: CommandModelsWritePort
  modelInfo?: CommandModelInfoPort
  /** 会话持久化执行面（session.delete/session.rename；守卫与活动会话收尾在执行器，端口只是能力） */
  sessions?: CommandSessionsPort
  /**
   * M4：目标首轮 kick（设定即开工——CLI 用 chat(arg)、TUI 用 GOAL_STARTED 监听，relay 用此注入）。
   * 执行器对它 fire-and-forget（不 await——首轮可跑很久，命令链不得被楔住；
   * 后续轮次由引擎回合决策点自驱，每轮 TURN_SETTLED → cmd.state 推进可见）。
   */
  startGoalRound?: (objective: string) => Promise<void>
  /**
   * 宿主级开关执行面（desktop.set/autoswitch.set）：CLI serve 壳经 ctx 组装
   * （keyValueStore + engine + desktopController + builtInExecutor）；UI 壳暂不装配（诚实 unsupported）。
   * 绑定逻辑单一事实点在 desktopControl 共享核心，壳只注入服务引用
   */
  desktopControl?: DesktopControlDeps
  /**
   * 记忆库执行面（memory.list/show/delete/seen）：结构兼容 memoryStore 单例公共面；
   * 双壳注入真实引用（CLI ctx / UI host），测试注入 fake；未装配→诚实 unsupported
   */
  memoryStore?: MemoryCommandPort
}

export type CommandExecutorResult = { ok: true; data?: Record<string, unknown> } | { ok: false; error: { code: string; message: string } }

export type CommandExecutor = (deps: CommandExecDeps, args: Record<string, unknown>) => Promise<CommandExecutorResult>

const unsupportedDep = (what: string): CommandExecutorResult => ({ ok: false, error: { code: 'unsupported', message: `${what}未装配` } })

/** task.detail 交付物截断预算（字节）：PLAINTEXT_BUDGET_BYTES 45KB 内留足信封结构与状态字段余量 */
const TASK_DETAIL_LIMIT_BYTES = 24 * 1024
/** 按字节预算截断：中文 3 字节场景从 1/3 处向上试探；超限时尾部拼接截断标注 */
function truncateToBytes(text: string, limitBytes: number, note: string): { text: string; truncated: boolean } {
  if (new TextEncoder().encode(text).length <= limitBytes) return { text, truncated: false }
  let chars = Math.floor(limitBytes / 3)
  while (chars + 256 < text.length && new TextEncoder().encode(text.slice(0, chars + 256)).length <= limitBytes) {
    chars += 256
  }
  return { text: text.slice(0, chars) + note, truncated: true }
}

/** 模型选项线形（model.list 应答 data.options 元素；efforts=reasoning_effort 枚举升序，随模型定义） */
export interface ModelOptionWire {
  name: string
  displayName?: string
  provider?: string
  /** reasoning_effort 枚举（升序=强度升序；空数组=该模型无此参数） */
  efforts: string[]
  /** 凭据槽是否已配 Key（false=行禁用+标注，配 Key 是桌面 /key 的资产管理边界） */
  hasKey: boolean
  /** 出厂卡退役标记（退役卡仍可选但标注） */
  deprecated?: boolean
}

/** 执行器绑定（唯一事实点在本文件；M2：turn.stop / model.list / model.set / model.param） */
const COMMAND_EXECUTORS: Record<string, CommandExecutor> = {
  // fast：abort 并发安全（空转 no-op 幂等）
  'turn.stop': async (deps) => {
    if (!deps.engine) return unsupportedDep('引擎')
    deps.engine.abort()
    return { ok: true }
  },
  // fast：纯只读目录（picker 打开时惰性拉取；轮次运行中即时返回）。
  // 口径=CLI /model list 同款：全部 chat 协议模型（生成模型不可切换，剔除）+ hasKey 状态——
  // 手机列表与桌面列表同源（初版误用 getModelsWithApiKeys 只回有 Key 的，桌面 ✗ 未配 Key 项在手机缺席）
  'model.list': async (deps) => {
    if (!deps.modelInfo) return unsupportedDep('模型目录')
    const all = await deps.modelInfo.getAllModelsWithApiKeyStatus()
    const options: ModelOptionWire[] = all
      .filter((e) => deriveModelKind(e.model.adapterConfig?.protocol) === 'chat')
      .map((e) => ({
        name: e.model.name,
        ...(e.model.displayName ? { displayName: e.model.displayName } : {}),
        ...(e.model.provider ? { provider: e.model.provider } : {}),
        efforts: e.model.supportedParameters?.find((p) => p.name === 'reasoning_effort')?.enumValues ?? [],
        hasKey: e.hasApiKey,
        ...(e.model.deprecated ? { deprecated: true } : {}),
      }))
    return { ok: true, data: { options } }
  },
  // serial：设置写（排队轮末=下一轮生效的正确语义——轮中切模型无定义）
  'model.set': async (deps, args) => {
    if (!deps.models) return unsupportedDep('模型服务')
    deps.models.saveCurrentModelName(String(args['name']))
    return { ok: true }
  },
  // serial：参数型命令通例（per-model 键值合并写；effort/temperature/… 同路）
  'model.param': async (deps, args) => {
    if (!deps.models) return unsupportedDep('模型服务')
    const name = deps.models.getCurrentModelName()
    if (!name) return { ok: false, error: { code: 'guard', message: '当前未选择模型' } }
    const param = String(args['param'])
    const existing = deps.models.getModelParameterSettings(name)
    deps.models.saveModelParameterSettings({
      modelName: name,
      parameters: { ...(existing?.parameters ?? {}), [param]: args['value'] },
    })
    return { ok: true }
  },
  // M3：前台（fast 只读枚举 + serial 切换）/ 规划 / 压缩
  'front.list': async (deps) => {
    if (!deps.engine) return unsupportedDep('引擎')
    const candidates = deps.engine.getFrontAgentCandidates()
    return {
      ok: true,
      data: {
        options: candidates.map((c) => ({
          type: c.type,
          name: c.name,
          ...(c.description ? { description: c.description } : {}),
        })),
      },
    }
  },
  'front.set': async (deps, args) => {
    if (!deps.engine) return unsupportedDep('引擎')
    const raw = args['type']
    const type = raw === null || raw === undefined || raw === '' ? undefined : String(raw)
    // 合法性校验（照 CLI /front 口径：仅本地模板可选；off/null = 裸模型）
    if (type !== undefined) {
      const candidates = deps.engine.getFrontAgentCandidates()
      if (!candidates.some((c) => c.type === type)) {
        return { ok: false, error: { code: 'guard', message: `不可选为前台: ${type}（仅本地模板可选）` } }
      }
    }
    deps.engine.setFrontAgent(type)
    return { ok: true }
  },
  'plan.set': async (deps, args) => {
    if (!deps.engine) return unsupportedDep('引擎')
    deps.engine.setPlanMode(args['on'] === true)
    return { ok: true }
  },
  // 宿主级开关（手机遥控桌面 CLI/TUI 的 /desktop、/auto-switch——共享核心单一事实点在 desktopControl，
  // 与 CLI 本地命令同键同源；stdout/视觉模型推荐等呈现留壳）。desktop.set 的可用性探测结果经 data.available 回流
  'desktop.set': async (deps, args) => {
    const port = deps.desktopControl
    if (!port?.store) return unsupportedDep('宿主开关存储')
    // 引擎从命令面 deps 现取（makeExecuteCommand 惰性取活动引擎——serve 多引擎活性；合成消息注入目标=活动会话）。
    // 可选方法适配：CommandEngineWritePort.appendSyntheticMessage 为可选（旧 fake 可缺省），守卫后闭包收窄为必选
    if (!deps.engine?.appendSyntheticMessage) return unsupportedDep('引擎合成消息口')
    const engine = deps.engine
    const append = (text: string, tag?: string) => engine.appendSyntheticMessage!(text, tag)
    const r = await setDesktopControl({ ...port, engine: { appendSyntheticMessage: append } }, args['on'] === true)
    if (!r.ok) return r
    return { ok: true, data: { ...(r.available !== undefined ? { available: r.available } : {}) } }
  },
  'autoswitch.set': async (deps, args) => {
    const port = deps.desktopControl
    if (!port?.store) return unsupportedDep('宿主开关存储')
    setAutoSwitchFlag(port, args['on'] === true)
    return { ok: true }
  },
  'compact': async (deps, args) => {
    if (!deps.engine) return unsupportedDep('引擎')
    const guidance = typeof args['guidance'] === 'string' && args['guidance'].trim() ? args['guidance'] : undefined
    try {
      await deps.engine.compactHistory(guidance, { trigger: 'manual' })
      return { ok: true, data: { compacted: true } } // token 前后对比经 cmd.state.ctx 回流呈现（唯一落定）
    } catch (err) {
      // 引擎守卫（running/<3 条用户消息/无模型等）诚实回流——手机 toast 错误，视图经 cmd.state 愈合
      return { ok: false, error: { code: 'guard', message: err instanceof Error ? err.message : String(err) } }
    }
  },
  // M4：目标生命周期（goal.set 设定即开工；turn.stop 与 goal 正交——停本轮不停自主推进，
  // 真正停推进是 goal.pause，手机目标详情提供 pause 即为此设计）
  'goal.set': async (deps, args) => {
    if (!deps.engine) return unsupportedDep('引擎')
    const objective = String(args['objective'])
    try {
      deps.engine.setGoal(
        objective,
        typeof args['criteria'] === 'string' && args['criteria'] ? args['criteria'] : undefined,
        typeof args['maxRounds'] === 'number' ? args['maxRounds'] : undefined,
      )
    } catch (err) {
      // 引擎守卫（空目标/另一会话目标互斥）诚实回流
      return { ok: false, error: { code: 'guard', message: err instanceof Error ? err.message : String(err) } }
    }
    if (deps.startGoalRound) void deps.startGoalRound(objective).catch(() => {}) // fire-and-forget：链不楔
    return { ok: true }
  },
  'goal.pause': async (deps) => {
    if (!deps.engine) return unsupportedDep('引擎')
    deps.engine.pauseGoal()
    return { ok: true }
  },
  'goal.resume': async (deps) => {
    if (!deps.engine) return unsupportedDep('引擎')
    // fire-and-forget：resumeGoal 会驱动推进循环（可多轮），命令链不得 await 整个循环
    void deps.engine.resumeGoal().catch(() => {})
    return { ok: true }
  },
  'goal.abandon': async (deps) => {
    if (!deps.engine) return unsupportedDep('引擎')
    deps.engine.clearGoal()
    return { ok: true }
  },
  // 会话管理（serial：与在途轮写盘保序——轮末生效；守卫与活动会话收尾全部在此，端口只是能力注入）。
  // 改名：patchTitle 原子写 title+titleSource='manual'，盘上 manual 不被引擎后续 save 冲掉由
  // mergeRecord 的 TITLE_SOURCE_PRIORITY 既有保护承担（引擎内存旧标题经 watch 自愈回流刷新）
  'session.rename': async (deps, args) => {
    if (!deps.sessions) return unsupportedDep('会话持久化')
    const r = await deps.sessions.patchTitle(String(args['sessionId']), String(args['title']).trim())
    if (!r.success) return { ok: false, error: { code: 'guard', message: r.error ?? '重命名失败' } }
    return { ok: true, data: { renamed: true } }
  },
  // 删除：目标是本壳引擎活动会话且正在跑 → 拒绝（手机一次滑删不构成中止在途轮的授权）；
  // 活动且空闲 → 先 detachSession（铸新 id，继续对话写新记录，防引擎下次 save 复活文件——
  // CLI /session delete 同款语义），detach 抛错（后台任务在途）则不删文件、诚实回错；
  // 非活动会话直接删（他壳已装载的经既有 watch 自愈链收敛；UI 后台注册表由壳侧端口收口）
  'session.delete': async (deps, args) => {
    if (!deps.sessions) return unsupportedDep('会话持久化')
    const id = String(args['sessionId'])
    const st = deps.engine?.getSessionState()
    if (st?.sessionId === id) {
      if (st.isRunning) return { ok: false, error: { code: 'guard', message: '该会话正在生成中，请稍后再删' } }
      if (!deps.engine) return unsupportedDep('引擎')
      try {
        deps.engine.detachSession()
      } catch (err) {
        return { ok: false, error: { code: 'guard', message: err instanceof Error ? err.message : String(err) } }
      }
    }
    const r = await deps.sessions.delete(id)
    if (!r.success) return { ok: false, error: { code: 'guard', message: r.error ?? '删除失败' } }
    return { ok: true, data: { deleted: true } }
  },
  // 闪念捕获（fast：纯账本追加，不碰引擎串行链；并发安全由 ledger 内 transact 串行化承担）。
  // 门控双保险之二：执行器内 managed 复核（fail-closed——npm 模式目录无此行，但协议直调仍拒）
  'idea': async (_deps, args) => {
    if (getOwnProjectPaths().projectPath === null) {
      return { ok: false, error: { code: 'guard', message: '此功能需开启自迭代（/fetch-source 下载源码后可用）' } }
    }
    if (!improvementLedger.isInitialized()) {
      return { ok: false, error: { code: 'unsupported', message: '改进提案账本未装配' } }
    }
    const r = await improvementLedger.capture(String(args['text']), '手机闪念')
    if (!r.ok) return { ok: false, error: { code: 'guard', message: r.error ?? '写入失败' } }
    if (r.duplicated) return { ok: true, data: { duplicated: true } }
    return { ok: true, data: { captured: true, ...(r.truncated ? { truncated: true } : {}) } }
  },
  // 提案决策（fast：召唤开庭=老化+读账本+发 ask，不碰引擎串行链）。
  // 门控双保险之二：执行器内 managed 复核（fail-closed——npm 模式目录无此行，但协议直调仍拒）。
  // 开庭 Promise fire-and-forget（不 await——ask 挂起期间命令链照常服务）；三态回执即时返回
  'improve': async () => {
    if (getOwnProjectPaths().projectPath === null) {
      return { ok: false, error: { code: 'guard', message: '此功能需开启自迭代（/fetch-source 下载源码后可用）' } }
    }
    if (!improvementLedger.isInitialized()) {
      return { ok: false, error: { code: 'unsupported', message: '改进提案账本未装配' } }
    }
    const r = await summonImprovementCourt()
    // P3（空态有信息）：不只说"没有待确认"，给出账本另一视图的统计与去向（手机 toast 原样透传；
    // 账本缺失/损坏时 getParsed→null，计数兑底 0 不抛错）
    let message: string
    if (r === 'empty') {
      const parsed = await improvementLedger.getParsed()
      const confirmed = parsed ? summarizeDigest(parsed).confirmed : 0
      message = `没有待确认提案 · 已确认 ${confirmed} 条待实施（桌面 /improve 面板可查看）`
    } else {
      message = r === 'reannounced' ? '裁决卡已重推' : '裁决卡已发出'
    }
    return { ok: true, data: { message, court: r } }
  },
  // 裁决卡原地翻页（fast：本页 decisions 先落账再换页，全部在 turnImprovementCourtPage 串行化）。
  // 门控双保险之二：执行器内 managed 复核（与 improve 同闸——internal 不进目录，但协议直调仍拒）
  'improve.page': async (_deps, args) => {
    if (getOwnProjectPaths().projectPath === null) {
      return { ok: false, error: { code: 'guard', message: '此功能需开启自迭代（/fetch-source 下载源码后可用）' } }
    }
    const r = await turnImprovementCourtPage(args['dir'] as 'next' | 'prev', args['decisions'] as AskDecisionEntry[] | undefined)
    if (!r.ok) return { ok: false, error: { code: 'guard', message: r.error } }
    return { ok: true, data: { card: r.card as unknown as Record<string, unknown> } }
  },
  // 子任务交付物拉取（C 迭代）。internal=手机工作计划行点击携带 sessionId/taskId 调用；
  // 活动会话引擎内存直读（settle 消息可能未落盘），非活动经 sessions.readMessages；
  // content 统一解 {content} JSON 包装（成功态写回线形）；adopt 落盘信封（超 400KB 结果）
  // 原样透传（自带路径+预览，落盘文件读取列后续迭代）
  'task.detail': async (deps, args) => {
    const sessionId = String(args['sessionId'] ?? '')
    const taskId = String(args['taskId'] ?? '')
    if (!sessionId || !taskId) {
      return { ok: false, error: { code: 'invalid_args', message: '缺少 sessionId / taskId' } }
    }
    let messages: Message[] | null = null
    if (deps.engine?.getSessionState().sessionId === sessionId) {
      messages = deps.engine.getHistory?.() ?? null
    }
    if (!messages) {
      messages = deps.sessions?.readMessages ? await deps.sessions.readMessages(sessionId) : null
    }
    if (!messages) {
      return { ok: false, error: { code: 'unsupported', message: '会话不可读（不存在或读取通道未装配）' } }
    }
    const msg = [...messages].reverse().find((m) => m.role === MessageRole.TOOL && m.toolCallId === taskId)
    if (!msg) return { ok: false, error: { code: 'guard', message: '未找到该子任务的结果消息' } }
    let deliverable = typeof msg.content === 'string' ? msg.content : ''
    try {
      const j = JSON.parse(deliverable) as { content?: unknown }
      if (j && typeof j.content === 'string') deliverable = j.content
    } catch {
      /* 失败文本/非 JSON 原样 */
    }
    const cut = truncateToBytes(deliverable, TASK_DETAIL_LIMIT_BYTES, '\n…（交付物超长已截断，完整内容请��桌面查看）')
    return {
      ok: true,
      data: { status: msg.toolCallStatus ?? null, deliverable: cut.text, truncated: cut.truncated },
    }
  },
  // 已确认/已关闭清单拉取（D 迭代）。internal+managedOnly 同 task.detail（目录门控降级）；
  // ⚠️ zone 命名暗坑：线形 zone 'closed'=账本「已关闭」区（parsed.discarded）——
  // core parsed.closed 是「已实现」区，映射处勿混淆（三审审查员提示）
  'improve.confirmed': async (_deps, args) => {
    if (getOwnProjectPaths().projectPath === null) {
      return { ok: false, error: { code: 'guard', message: '此功能需开启自迭代（/fetch-source 下载源码后可用）' } }
    }
    if (!improvementLedger.isInitialized()) {
      return { ok: false, error: { code: 'unsupported', message: '改进提案账本未装配' } }
    }
    const parsed = await improvementLedger.getParsed()
    if (!parsed) return { ok: false, error: { code: 'unsupported', message: '账本不可读（文件缺失或损坏）' } }
    const zone = args['zone'] === 'closed' ? 'closed' : 'confirmed'
    const src = zone === 'closed' ? parsed.discarded : parsed.confirmed
    const CAP = 50
    const entries = [...src]
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, CAP)
      .map((e) => ({ title: e.title, date: e.date, group: e.group ?? null }))
    return { ok: true, data: { zone, total: src.length, truncated: src.length > CAP, entries } }
  },
  // 已确认/已关闭区四向流转（D 迭代）：close 已确认→已关闭归档 / implement →已实现（手工结账）/
  // requeue →待确认重审 / reopen 已关闭→已确认（误关恢复）；未命中幂等无操作（对齐 decide 语义）
  'improve.confirmed.decide': async (_deps, args) => {
    if (getOwnProjectPaths().projectPath === null) {
      return { ok: false, error: { code: 'guard', message: '此功能需开启自迭代（/fetch-source 下载源码后可用）' } }
    }
    if (!improvementLedger.isInitialized()) {
      return { ok: false, error: { code: 'unsupported', message: '改进提案账本未装配' } }
    }
    const titles = Array.isArray(args['titles']) ? args['titles'].map((t) => String(t)).filter(Boolean) : []
    const action = String(args['action'] ?? '')
    const actions: string[] = ['close', 'implement', 'requeue', 'reopen']
    if (titles.length === 0 || !actions.includes(action)) {
      return { ok: false, error: { code: 'invalid_args', message: '需要非空 titles 与 action ∈ close/implement/requeue/reopen' } }
    }
    const r = await improvementLedger.applyConfirmedTransitions(
      titles.map((title) => ({ title, action: action as ConfirmedTransition['action'] })),
    )
    if (!r.ok) return { ok: false, error: { code: 'guard', message: r.error ?? '写入失败' } }
    return {
      ok: true,
      data: { applied: r.applied, ...(r.applied === 0 ? { message: '未命中任何条目（幂等无操作）' } : {}) },
    }
  },
  // ==================== 记忆库管理（直记+事后治理；端口 memoryStore） ====================
  // 目录行 noop：面板打开由端侧路由（ChatScreen onOpenMemory），命令通道仅作可执行性确认
  'memory': async () => ({ ok: true, data: {} }),
  'memory.list': async (deps) => {
    const port = deps.memoryStore
    if (!port) return unsupportedDep('记忆库')
    const [entries, seenAt] = await Promise.all([port.list(), port.readSeenAt()])
    const items = entries
      .sort((a, b2) => b2.updated_at.localeCompare(a.updated_at))
      .map(e => ({ name: e.name, type: e.type, hook: e.hook.slice(0, 60), importance: e.importance, updated_at: e.updated_at, new: port.isNewerEntry(e, seenAt) }))
    return { ok: true, data: { items, total: items.length, newCount: items.filter(i => i.new).length } }
  },
  'memory.show': async (deps, args) => {
    const port = deps.memoryStore
    if (!port) return unsupportedDep('记忆库')
    const title = String(args['title'] ?? '')
    const entries = await port.list()
    const target = entries.find(e => e.name.toLowerCase() === title.toLowerCase())
    if (!target) return { ok: false, error: { code: 'not_found', message: `未找到记忆: ${title}` } }
    return { ok: true, data: { entry: { name: target.name, type: target.type, body: target.body, created_at: target.created_at, updated_at: target.updated_at, importance: target.importance, usage_count: target.usage_count, last_used_at: target.last_used_at } } }
  },
  'memory.delete': async (deps, args) => {
    const port = deps.memoryStore
    if (!port) return unsupportedDep('记忆库')
    const title = String(args['title'] ?? '')
    const result = await port.remove(title)
    if (!result.success) return { ok: false, error: { code: 'delete_failed', message: result.error ?? '删除失败' } }
    return { ok: true, data: { deleted: title } }
  },
  'memory.seen': async (deps) => {
    const port = deps.memoryStore
    if (!port) return unsupportedDep('记忆库')
    await port.writeSeenAt(new Date().toISOString())
    return { ok: true, data: {} }
  },}

/**
 * 命令执行入口（RelayBridge.handleCmdRequest 经 deps.executeCommand 委托至此）。
 * fail-closed：未知命令 / 非法 args / 执行器未装配 / 执行异常 → 诚实回 error，绝不沉默。
 */
export async function executeCommand(deps: CommandExecDeps, cmd: string, args?: Record<string, unknown>): Promise<CommandExecutorResult> {
  const spec = resolveCommand(cmd)
  if (!spec) return { ok: false, error: { code: 'unsupported', message: `未知命令：${cmd}` } }
  const issue = validateArgs(spec, args)
  if (issue) return { ok: false, error: issue }
  const executor = COMMAND_EXECUTORS[cmd]
  if (!executor) return { ok: false, error: { code: 'unsupported', message: `命令尚未开放：${cmd}` } }
  try {
    return await executor(deps, args ?? {})
  } catch (err) {
    return { ok: false, error: { code: 'internal', message: err instanceof Error ? err.message : String(err) } }
  }
}
