/**
 * outputBudget.ts — 上下文窗口准入定律（SSOT，2026-10-07「截图后 400」根治立项）。
 *
 * 定律：服务端在请求准入瞬间裁决 prompt_tokens + 申报输出预算 ≤ maxContextTokens
 * （DeepSeek 实测 + Anthropic 官方文案同款，见 contextWindowError.ts 收录）。本模块是
 * 定律在客户端的唯一事实点，两个投影：
 *  - 压力（内部判定）：effectiveContextWindow —— R2 自动压缩触发线的「有效窗口」分母
 *    （显示分母禁用：显示口径 = 原始窗口，占用与预留一律归分子——2026-10-07 手机环
 *    「852k 曲解容量」实测反馈后立法，见 getContextStatus）；
 *  - 动态（申报）：clampModelConfig —— 请求出口按当次载荷收窄 max_tokens，请求恒合法。
 *
 * 与 approxTokens.ts 的边界（不合并）：approxTokens 是计费估值（期望值，flat 2 字符/token，
 * 无 usage 时的 ~ 显示兜底）；本模块是准入估值（保守上界，防拒绝）。flat 0.5 token/字
 * 对 CJK 低估约 2 倍（2026-10-07 探针实测随机 CJK 0.97 token/字），计费无害、准入危险。
 *
 * 系数依据（同探针）：CJK ×1.0（0.97 上界压线）；ASCII/代码 ×0.35（实际 ~0.3）；
 * 1280×853 截图实测 677 token → 媒体块 +2000（约 3 倍冗余）。
 * 详见《max_tokens挤占上下文窗口-根治-实施规划.md》。
 */

import type { Message, ModelConfig, ToolDefinition } from '../../types/models'

/** 单媒体块（image_url/video_url/input_audio 及未知非文本块）的准入估算 */
const MEDIA_PART_TOKENS = 2000
/** 请求结构开销（角色标注/JSON 骨架等线缆膨胀） */
const STRUCTURE_OVERHEAD_TOKENS = 500
/** 钳制地板：再近崖也保留的输出预算（防荒谬收窄） */
export const OUTPUT_BUDGET_FLOOR = 4096

/** 文本准入估算：CJK 系（含全角/假名/谚文）1 字/token，其余 0.35 字/token（探针实测口径） */
export function estimateTokensForText(text: string): number {
  let cjk = 0
  let other = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      i++ // 代理对按 1 码点计
      other++
    } else if (code >= 0x2e80 && code <= 0xffef) {
      cjk++
    } else {
      other++
    }
  }
  return cjk + other * 0.35
}

function messageTokens(m: Message): number {
  let est = 0
  const c = m.content
  if (typeof c === 'string') {
    est += estimateTokensForText(c)
  } else if (Array.isArray(c)) {
    for (const part of c) {
      if (!part) continue
      if (part.type === 'text') est += estimateTokensForText(part.text ?? '')
      else est += MEDIA_PART_TOKENS
    }
  }
  // reasoningContent 是否上线缆因协议而异——计入恒为保守方向（思考模型单轮可达数万 token）
  if (m.reasoningContent) est += estimateTokensForText(m.reasoningContent)
  if (m.toolCalls && m.toolCalls.length > 0) est += estimateTokensForText(JSON.stringify(m.toolCalls))
  return est
}

/**
 * 一次模型请求的 prompt 准入估算（保守上界方向；服务端分词器才是权威）。
 * 供 callModelAPI 出口钳制与溢出 trace 使用——勿挪作计费显示（那是 approxTokens 的职责）。
 */
export function estimatePromptTokens(messages: Message[], tools?: ToolDefinition[]): number {
  let est = STRUCTURE_OVERHEAD_TOKENS
  for (const m of messages) est += messageTokens(m)
  if (tools && tools.length > 0) est += estimateTokensForText(JSON.stringify(tools))
  return Math.ceil(est)
}

/** 准入余量：估算方差随载荷等比放大（2% 窗口，下限 8192） */
export function admissionMargin(window: number): number {
  return Math.max(8192, Math.round(window * 0.02))
}

/**
 * 申报输出预算钳制（动态投影核心）：
 * requested/window 缺失或非正 → 原样返回（legacy 行为不变）；
 * requested ≤ 窗口−估算−余量 → 原样返回（常态字节不变）；
 * 否则收窄（地板 4096）——宁可截断输出，不做 400 全轮失败。
 */
export function clampOutputBudget(
  requested: number | undefined,
  window: number | undefined,
  estPromptTokens: number,
): number | undefined {
  if (requested === undefined || requested <= 0) return requested
  if (!window || window <= 0) return requested
  const allowed = Math.floor(window - estPromptTokens - admissionMargin(window))
  if (requested <= allowed) return requested
  return Math.min(requested, Math.max(OUTPUT_BUDGET_FLOOR, allowed))
}

/**
 * 实际申报的输出预算解析（用户 /model 参数覆盖优先于卡面缺省；无任何申报 = 0）。
 * 显示口径（getContextStatus）与有效窗口共用同一解析——显示分子含申报预留、
 * 压力分母减申报预留，两投影永不漂移。
 */
export function resolveDeclaredMaxTokens(
  modelInfo: { adapterConfig?: { defaultMaxTokens?: number } } | undefined,
  resolvedMaxTokens?: number,
): number {
  if (resolvedMaxTokens !== undefined && resolvedMaxTokens > 0) return resolvedMaxTokens
  return modelInfo?.adapterConfig?.defaultMaxTokens ?? 0
}

/**
 * 有效窗口（压力投影）：窗口 − 实际申报的输出预算（用户 /model 参数覆盖优先于卡面缺省；
 * 与 nodeFactory/modelServiceFactory 的参数读取同源）。退化卡防护：下限 50% 窗口；
 * 窗口未登记 → undefined（消费方维持现状）。
 * 仅用于内部压力判定（自动压缩触发线）——**显示分母禁用本函数**（显示口径=原始窗口，
 * 占用与预留一律归分子，见 getContextStatus）。
 */
export function effectiveContextWindow(
  modelInfo: { maxContextTokens?: number; adapterConfig?: { defaultMaxTokens?: number } } | undefined,
  resolvedMaxTokens?: number,
): number | undefined {
  const window = modelInfo?.maxContextTokens
  if (!window || window <= 0) return undefined
  const declared = resolveDeclaredMaxTokens(modelInfo, resolvedMaxTokens)
  return Math.max(window - declared, Math.floor(window * 0.5))
}

/** callModelAPI 出口钳制：未触发时返回原 config 对象（引用恒等 → 线缆字节不变） */
export function clampModelConfig(
  config: ModelConfig,
  maxContextTokens: number | undefined,
  messages: Message[],
  tools: ToolDefinition[],
): ModelConfig {
  const clamped = clampOutputBudget(config.maxTokens, maxContextTokens, estimatePromptTokens(messages, tools))
  if (clamped === config.maxTokens) return config
  return { ...config, maxTokens: clamped }
}
