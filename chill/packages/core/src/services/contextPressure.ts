/**
 * 上下文压力判定（纯函数；R2 自动压缩的决策核心）。
 *
 * 单一职责：给定实测用量与窗口上限，回答"此刻是否应自动压缩"。
 * 数据源裁决（SSOT）：provider usage 权威（引擎 lastUsage）；本模块不做字符估算——
 * 无实测数据时一律判定"不触发"（宁可不压，不可盲压）。
 *
 * 行业对齐：DSH thresholdRatio=0.8 / Codex ~90% / Claude Code 水位百分比可配；
 * 默认阈值 0.8（各壳层可经 configStore 键 compact_threshold 覆盖）。
 */

/** 压力判定输入（全部现取，无内部状态） */
export interface ContextPressureInput {
  /** 最近一次 API 调用的实测用量（引擎 lastUsage；null = 尚无实测，不判定） */
  lastUsage: { promptTokens: number; completionTokens: number } | null
  /** 当前模型窗口上限（getContextStatus 同源解析；undefined = 窗口未登记，不判定） */
  maxContextTokens?: number
  /** 自动压缩总开关（缺省视为开） */
  autoCompactEnabled: boolean
  /** 触发阈值（0-1；缺省 DEFAULT_COMPACT_THRESHOLD） */
  compactThreshold: number
}

/** 压力判定结果 */
export interface ContextPressureDecision {
  /** 实测占用/窗口上限；无法计算（无实测或无分母）时为 null */
  ratio: number | null
  /** 是否应触发自动压缩 */
  shouldCompact: boolean
  /** 判定依据（状态栏提示/日志/测试断言用） */
  reason: ContextPressureSkipReason | 'threshold-exceeded'
}

/** 不触发的具体原因（呈现与测试断言用） */
export type ContextPressureSkipReason =
  | 'disabled' // 总开关关（configStore auto_compact = false）
  | 'no-usage' // 尚无实测用量（新会话/服务未返回 usage/压缩后未回报）
  | 'no-window' // 模型窗口未登记（maxContextTokens undefined）
  | 'below-threshold' // 压力未达阈值

/** 默认触发阈值（占用/窗口 > 0.8） */
export const DEFAULT_COMPACT_THRESHOLD = 0.8

/**
 * 判定是否应自动压缩。
 * 判定顺序（短路）：开关 → 实测用量在场 → 分母在场 → 阈值比较。
 */
export function evaluateContextPressure(input: ContextPressureInput): ContextPressureDecision {
  const threshold = input.compactThreshold > 0 && input.compactThreshold <= 1
    ? input.compactThreshold
    : DEFAULT_COMPACT_THRESHOLD

  if (!input.autoCompactEnabled) {
    return { ratio: null, shouldCompact: false, reason: 'disabled' }
  }
  if (!input.lastUsage) {
    return { ratio: null, shouldCompact: false, reason: 'no-usage' }
  }
  if (!input.maxContextTokens || input.maxContextTokens <= 0) {
    return { ratio: null, shouldCompact: false, reason: 'no-window' }
  }
  const used = input.lastUsage.promptTokens + input.lastUsage.completionTokens
  const ratio = used / input.maxContextTokens
  if (ratio > threshold) {
    return { ratio, shouldCompact: true, reason: 'threshold-exceeded' }
  }
  return { ratio, shouldCompact: false, reason: 'below-threshold' }
}
