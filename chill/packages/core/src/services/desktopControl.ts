/**
 * desktopControl.ts — 宿主级开关共享核心（单一事实点）。
 *
 * 两条开关、两处入口、一份逻辑：
 * - 键值真相：desktop_control_enabled（桌面能力：截屏+键鼠注入放行）/ autoSwitchAfterIteration（自迭代后自动版本切换）
 *   —— 与 CLI 本地 /desktop、/auto-switch 完全同键同源（谁写都一样，读点全部收敛到这两个常量）
 * - 入口一：CLI/TUI 本地命令（cli.ts handleDesktop/handleAutoSwitch 薄壳——stdout 呈现留壳）
 * - 入口二：命令面执行器（commandSurface 'desktop.set'/'autoswitch.set'——手机遥控）
 * - 变更通告：DESKTOP_CONTROL_TOGGLED / AUTOSWITCH_TOGGLED（唯一变更通告口——本地与遥控经同一事件收敛，
 *   relay 桥 wireCommandState 订阅即时推 cmd.state；emit 在本核心而非引擎，"不为发事件改引擎"）
 *
 * 端口最小面（结构兼容，双壳注入真实服务引用，测试注入 fake）：
 * - store 必需：键值读写面（CLI ctx.keyValueStore / UI IPCKeyValueStore 同构）
 * - engine 可选：合成消息口（工具集变化对模型静默，必须显式告知——否则模型沿旧能力认知回答）
 * - desktop 可选：原生模块可用性探测（开启时防"开了却没反应"；缺省=不探测，available 回流 undefined）
 * - sessionAllow 可选：桌面操作会话级放行收回口（off 时 [s] 授权随开关关闭失效；缺省=跳过，无放行可收的宿主语义）
 */

import { eventBus, EVENTS } from '../utils/eventBus'

/** 键值读写面（与 CLI ctx.keyValueStore / UI IPCKeyValueStore 结构兼容的最小面） */
export interface DesktopControlStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): unknown
}

/** 合成消息注入口（ChatEngine.appendSyntheticMessage 结构兼容） */
export interface SyntheticMessagePort {
  appendSyntheticMessage(text: string, tag?: string): unknown
}

/** 原生模块可用性探测口（IDesktopController.isAvailable 结构兼容） */
export interface DesktopAvailabilityPort {
  isAvailable(): Promise<boolean>
}

/** 桌面操作会话级放行收回口（builtInExecutor.resetDesktopSessionAllow 结构兼容） */
export interface DesktopSessionAllowPort {
  resetDesktopSessionAllow(): unknown
}

/** 共享核心依赖（CLI 壳 / 命令面执行器共用一形态） */
export interface DesktopControlDeps {
  store: DesktopControlStore
  engine?: SyntheticMessagePort
  desktop?: DesktopAvailabilityPort
  sessionAllow?: DesktopSessionAllowPort
}

// ==================== 键名常量（D8 键名零漂移的唯一事实点） ====================

export const DESKTOP_CONTROL_ENABLED_KEY = 'desktop_control_enabled'
export const AUTOSWITCH_AFTER_ITERATION_KEY = 'autoSwitchAfterIteration'

// ==================== 读面（cmd.state 快照与 CLI 状态行共用；undefined=无读口/未知，≠false） ====================

/** 读面最小形（只读 getItem——命令面状态快照注入的 hostFlags 口） */
export type DesktopFlagReadStore = Pick<DesktopControlStore, 'getItem'>

export function readDesktopEnabled(store?: DesktopFlagReadStore): boolean | undefined {
  if (!store) return undefined
  return store.getItem(DESKTOP_CONTROL_ENABLED_KEY) === 'true'
}

export function readAutoSwitch(store?: DesktopFlagReadStore): boolean | undefined {
  if (!store) return undefined
  return store.getItem(AUTOSWITCH_AFTER_ITERATION_KEY) === 'true'
}

// ==================== 合成消息文案（与 CLI 历史文案逐字一致——改文案只改这里，两端同步） ====================

export const DESKTOP_ENABLED_NOTICE =
  '【桌面能力已开启】你新增了三个内置工具：capture_screen（截取主显示器屏幕，只读免审批，返回缩放后图像与坐标系说明）；inspect_ui（UI 元素感知，只读免审批，返回当前窗口可交互元素编号表）；computer_use（键鼠操作：元素级动作 click_element/set_value/focus_window 按 inspect_ui 编号操作（优先），像素动作点击/拖拽/滚动/输入文本/组合键/等待（回退），主动作需用户审批，coordinate 以最近一次截图的图像坐标系为准）。若当前模型不支持视觉，截图图片会被替换为占位符，建议提醒用户切换视觉模型。'

export const DESKTOP_DISABLED_NOTICE =
  '【桌面能力已关闭】capture_screen、inspect_ui 与 computer_use 已从你的可用工具集移除，不要再尝试调用；如用户询问，请说明桌面能力已被用户关闭（可用 /desktop on 重新开启）。'

// ==================== 写面（共享核心） ====================

/** 结果形态（ok=false 时为 CommandExecutorResult 同构错误） */
export type DesktopControlResult = { ok: true; available?: boolean } | { ok: false; error: { code: string; message: string } }

/**
 * 桌面能力开关（写键 + 合成消息 + off 收回会话放行 + on 探测原生模块 + 事件通告）。
 * engine 必需（合成消息是模型能力认知的关键动作，缺失即拒绝执行）；desktop/sessionAllow 可选��
 */
export async function setDesktopControl(deps: DesktopControlDeps, on: boolean): Promise<DesktopControlResult> {
  if (!deps.engine) return { ok: false, error: { code: 'unsupported', message: '引擎未装配（合成消息无注入口）' } }
  deps.store.setItem(DESKTOP_CONTROL_ENABLED_KEY, on ? 'true' : 'false')
  if (on) {
    deps.engine.appendSyntheticMessage(DESKTOP_ENABLED_NOTICE, 'desktopToggle')
  } else {
    // 收回桌面操作的会话级放行（[s] 授权随开关关闭失效）
    deps.sessionAllow?.resetDesktopSessionAllow()
    deps.engine.appendSyntheticMessage(DESKTOP_DISABLED_NOTICE, 'desktopToggle')
  }
  const available = deps.desktop ? await deps.desktop.isAvailable() : undefined
  emitToggle(DESKTOP_CONTROL_TOGGLED_EVENT, on)
  return { ok: true, ...(available !== undefined ? { available } : {}) }
}

/**
 * 自迭代后自动版本切换开关（纯键值写 + 事件通告；消费点在自迭代收尾读键，与在途轮语义无涉）。
 */
export function setAutoSwitchFlag(deps: Pick<DesktopControlDeps, 'store'>, on: boolean): { ok: true } {
  deps.store.setItem(AUTOSWITCH_AFTER_ITERATION_KEY, on ? 'true' : 'false')
  emitToggle(AUTOSWITCH_TOGGLED_EVENT, on)
  return { ok: true }
}

// ==================== 事件（唯一变更通告口：本地命令与手机遥控经同一事件收敛，relay 桥广播手机） ====================

export const DESKTOP_CONTROL_TOGGLED_EVENT = EVENTS.DESKTOP_CONTROL_TOGGLED
export const AUTOSWITCH_TOGGLED_EVENT = EVENTS.AUTOSWITCH_TOGGLED

function emitToggle(event: string, on: boolean): void {
  eventBus.emit(event, { on })
}
