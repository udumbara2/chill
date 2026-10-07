/**
 * 5 段 cron（分 时 日 月 周，本地时区）解析与下次触发计算
 *
 * 纯函数、零依赖、不 import fs——可单测、可在任意壳层复用。
 *
 * 语法子集（刻意收敛，防 Codex RRULE 事故类复杂语义）：
 * - 支持：星号、星号斜杠 n 步长、单值、区间 `a-b`、逗号列表（如 `0 9,17 * * 1-5`）
 * - 不支持：L/W/#/?/英文名（jan、mon 等）——遇到一律报错而非静默误解
 * - 日/周语义对齐 Vixie cron：日与周同时受限时取"或"，只限一方时取该方
 *
 * 下次触发计算有界：逐日扫描上限 5 年（覆盖 2 月 29 日一个完整周期），
 * 无法满足的规则明确报错，绝不无限迭代（Codex 100% CPU 事故为鉴）。
 *
 * 确定性 jitter：同一任务 id 永远同样偏移（FNV-1a 稳定哈希），防整点共振；
 * 周期任务偏移 = min(周期的 10%, 15 分钟)；一次性 at 落在 :00/:30 时提前 ≤90 秒。
 */

/** 解析后的 cron 规则（各字段为排序去重后的取值表） */
export interface CronRule {
  /** 分（0-59） */
  minutes: number[]
  /** 时（0-23） */
  hours: number[]
  /** 日（1-31） */
  daysOfMonth: number[]
  /** 月（1-12） */
  months: number[]
  /** 周（0-6，0=周日） */
  daysOfWeek: number[]
}

/** 下次触发的逐日扫描上限：5 年（覆盖闰日完整周期 + 余量） */
const MAX_SEARCH_DAYS = 366 * 5

/** 合并补跑计数的迭代上限（错过次数再多也不无限数下去） */
export const MAX_COALESCE_COUNT = 1000

const FIELD_SPECS = [
  { name: '分', min: 0, max: 59 },
  { name: '时', min: 0, max: 23 },
  { name: '日', min: 1, max: 31 },
  { name: '月', min: 1, max: 12 },
  { name: '周', min: 0, max: 7 }, // 7 归一为 0（周日）
] as const

/** 解析单个字段为排序去重的取值数组；任何不支持形态抛中文错误 */
function parseField(field: string, min: number, max: number, fieldName: string): number[] {
  if (field === '') throw new Error(`cron ${fieldName}字段为空`)
  if (/[a-zA-Z]/.test(field)) {
    throw new Error(`cron ${fieldName}字段含不支持的写法 "${field}"（不支持英文别名/L/W 等扩展语法）`)
  }
  if (/[#?]/.test(field)) {
    throw new Error(`cron ${fieldName}字段含不支持的写法 "${field}"（不支持 #/? 扩展语法）`)
  }

  const values = new Set<number>()
  for (const item of field.split(',')) {
    if (item === '*') {
      for (let v = min; v <= max; v++) values.add(v)
      continue
    }
    const stepMatch = /^\*\/(\d+)$/.exec(item)
    if (stepMatch) {
      const step = parseInt(stepMatch[1], 10)
      if (step < 1) throw new Error(`cron ${fieldName}字段步长必须 ≥ 1: "${item}"`)
      for (let v = min; v <= max; v += step) values.add(v)
      continue
    }
    const rangeMatch = /^(\d+)-(\d+)$/.exec(item)
    if (rangeMatch) {
      const a = parseInt(rangeMatch[1], 10)
      const b = parseInt(rangeMatch[2], 10)
      if (a > b) throw new Error(`cron ${fieldName}字段区间起点大于终点: "${item}"`)
      if (a < min || b > max) throw new Error(`cron ${fieldName}字段区间超出范围（${min}-${max}）: "${item}"`)
      for (let v = a; v <= b; v++) values.add(v)
      continue
    }
    if (!/^\d+$/.test(item)) {
      throw new Error(`cron ${fieldName}字段含无法解析的项: "${item}"`)
    }
    const v = parseInt(item, 10)
    if (v < min || v > max) throw new Error(`cron ${fieldName}字段取值超出范围（${min}-${max}）: "${item}"`)
    values.add(v)
  }

  return [...values].sort((a, b) => a - b)
}

/**
 * 解析 5 段 cron 表达式（本地时区语义）。
 * 周字段 7 归一为 0（周日）；非法输入抛中文错误。
 */
export function parseCron(expr: string): CronRule {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) {
    throw new Error(`cron 表达式必须是 5 段（分 时 日 月 周），实得 ${fields.length} 段: "${expr}"`)
  }
  const [minutes, hours, daysOfMonth, months, daysOfWeekRaw] = fields.map((f, i) =>
    parseField(f, FIELD_SPECS[i].min, FIELD_SPECS[i].max, FIELD_SPECS[i].name)
  )
  // 周字段 7 → 0（周日两种写法归一）
  const daysOfWeek = [...new Set(daysOfWeekRaw.map((d) => (d === 7 ? 0 : d)))].sort((a, b) => a - b)
  return { minutes, hours, daysOfMonth, months, daysOfWeek }
}

/** Vixie cron 日/周语义：两者同时受限时取"或"，只限一方时取该方 */
function dayMatches(rule: CronRule, day: Date): boolean {
  const domRestricted = rule.daysOfMonth.length < 31
  const dowRestricted = rule.daysOfWeek.length < 7
  const domHit = rule.daysOfMonth.includes(day.getDate())
  const dowHit = rule.daysOfWeek.includes(day.getDay())
  if (domRestricted && dowRestricted) return domHit || dowHit
  return domHit && dowHit
}

/**
 * 下次触发时刻（ms，本地时区）：严格大于 fromMs 的第一个匹配整分钟。
 * 逐日扫描有界（5 年），无法满足抛错——绝不无限迭代。
 */
export function nextFire(rule: CronRule, fromMs: number): number {
  // 起始边界：严格大于 fromMs 的下一整分钟
  const start = new Date(fromMs)
  start.setSeconds(0, 0)
  if (start.getTime() <= fromMs) start.setMinutes(start.getMinutes() + 1)
  const startMs = start.getTime()

  const day = new Date(start.getFullYear(), start.getMonth(), start.getDate())
  for (let d = 0; d <= MAX_SEARCH_DAYS; d++) {
    if (d > 0) day.setDate(day.getDate() + 1)
    if (!rule.months.includes(day.getMonth() + 1)) continue
    if (!dayMatches(rule, day)) continue
    for (const h of rule.hours) {
      for (const m of rule.minutes) {
        const candidate = new Date(day)
        candidate.setHours(h, m, 0, 0)
        if (candidate.getTime() >= startMs) return candidate.getTime()
      }
    }
  }
  throw new Error(`cron 规则未来 5 年内无可触发时刻，无法满足（如 2 月 31 日类自相矛盾）`)
}

/**
 * 统计 (fromExclusiveMs, toMs] 区间内的应触发次数（合并补跑计数用）。
 * 迭代上限 MAX_COALESCE_COUNT：达到即返回（count 语义为"≥ cap"）。
 */
export function countOccurrences(
  rule: CronRule,
  fromExclusiveMs: number,
  toMs: number,
  cap: number = MAX_COALESCE_COUNT
): { count: number; firstAt: number | null } {
  let count = 0
  let firstAt: number | null = null
  let cursor = fromExclusiveMs
  while (count < cap) {
    const next = nextFire(rule, cursor)
    if (next > toMs) break
    if (firstAt === null) firstAt = next
    count++
    cursor = next
  }
  return { count, firstAt }
}

/** FNV-1a 32bit 稳定哈希（jitter 的确定性来源：同一任务 id 永远同样偏移） */
export function stableHash32(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** 周期任务 jitter 上限（对齐 Kimi/Claude 参数：周期的 10%、封顶 15 分钟） */
export const MAX_RECURRING_JITTER_MS = 15 * 60 * 1000

/**
 * 周期任务的确定性延后偏移（ms，[0, min(周期10%, 15分钟)]）。
 * periodMs 取相邻两次触发的实际间隔（由调用方用 nextFire 连算两次得到）。
 */
export function recurringJitterMs(taskId: string, periodMs: number): number {
  const span = Math.min(Math.floor(periodMs * 0.1), MAX_RECURRING_JITTER_MS)
  if (span <= 0) return 0
  return stableHash32(taskId) % (span + 1)
}

/** 一次性 at 任务的提前量上限（落在 :00/:30 时提前 ≤90 秒，对齐 Kimi/Claude 参数） */
export const MAX_ONESHOT_ADVANCE_MS = 90 * 1000

/**
 * 一次性任务的确定性提前量（ms，≥0；实际触发 = at - 提前量）。
 * 仅当 at 整点落在 :00/:30（整分、零秒零毫秒）时生效，其余时刻不偏移。
 */
export function oneShotAdvanceMs(taskId: string, atMs: number): number {
  const d = new Date(atMs)
  const onHalfHour = d.getSeconds() === 0 && d.getMilliseconds() === 0 && d.getMinutes() % 30 === 0
  if (!onHalfHour) return 0
  return stableHash32(taskId) % (MAX_ONESHOT_ADVANCE_MS + 1)
}

/** RFC 3339 显式 offset 校验（Z 或 ±HH:MM 必填——含糊时区静默排错是 Codex 事故教训） */
const AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/

/**
 * 解析一次性触发时刻（RFC 3339 显式 offset）。
 * 无 offset / 无法解析 / 已是过去时刻，一律报错。
 */
export function parseAt(input: string, nowMs: number): number {
  if (!AT_PATTERN.test(input.trim())) {
    throw new Error(`at 必须是 RFC 3339 且带显式时区偏移（如 2026-08-18T15:30:00+08:00）: "${input}"`)
  }
  const ms = Date.parse(input.trim())
  if (Number.isNaN(ms)) {
    throw new Error(`at 时刻无法解析: "${input}"`)
  }
  if (ms <= nowMs) {
    throw new Error(`at 时刻已过去: "${input}"`)
  }
  return ms
}

/** 相对时间单位 → 毫秒（m/h/d 与中文单位；调度最小粒度 1 分钟，不设秒级单位） */
const RELATIVE_UNITS: Record<string, number> = {
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  分钟: 60 * 1000,
  小时: 60 * 60 * 1000,
  天: 24 * 60 * 60 * 1000,
}

/**
 * 解析相对时间为绝对触发时刻（ms）："20m" / "2h" / "1d" 或中文 "20分钟" / "2小时" / "1天"。
 * 单单位正整数（大小写不敏感、允许首尾空白）；无法解析 / 非正数一律抛中文错误。
 * （模型取时痛点：模型不知道"现在几点"，相对时间由 executor 以当前时刻换算为绝对 at。）
 */
export function parseRelativeDelay(input: string, nowMs: number): number {
  const match = /^(\d+)\s*(m|h|d|分钟|小时|天)$/i.exec(input.trim())
  if (!match) {
    throw new Error(`相对时间格式无法解析: "${input}"（支持 "20m"/"2h"/"1d" 或 "20分钟"/"2小时"/"1天"）`)
  }
  const amount = parseInt(match[1], 10)
  if (amount <= 0) {
    throw new Error(`相对时间必须为正数: "${input}"`)
  }
  const unitMs = RELATIVE_UNITS[match[2].toLowerCase()] ?? RELATIVE_UNITS[match[2]]
  return nowMs + amount * unitMs
}

/**
 * 格式化为 RFC 3339 显式本地 offset（如 2026-08-18T15:30:00+08:00）——
 * 相对时间换算结果的落盘形态（parseAt 的合法输入，at 字段要求显式 offset）。
 */
export function formatLocalRfc3339(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  const offsetMin = -d.getTimezoneOffset() // getTimezoneOffset 与 RFC 3339 符号相反
  const sign = offsetMin >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMin)
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}
