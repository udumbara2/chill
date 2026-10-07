import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseCron,
  nextFire,
  countOccurrences,
  stableHash32,
  recurringJitterMs,
  oneShotAdvanceMs,
  parseAt,
  parseRelativeDelay,
  formatLocalRfc3339,
  MAX_RECURRING_JITTER_MS,
  MAX_ONESHOT_ADVANCE_MS,
  MAX_COALESCE_COUNT,
} from '../../src/services/scheduler/cronParser.ts'

// ==================== 解析：合法形态 ====================

test('解析 *：各字段全取值且排序', () => {
  const rule = parseCron('* * * * *')
  assert.equal(rule.minutes.length, 60)
  assert.equal(rule.hours.length, 24)
  assert.equal(rule.daysOfMonth.length, 31)
  assert.equal(rule.months.length, 12)
  assert.equal(rule.daysOfWeek.length, 7)
})

test('解析 */n、单值、区间、逗号列表', () => {
  const rule = parseCron('*/15 9 1 3 1-5')
  assert.deepEqual(rule.minutes, [0, 15, 30, 45])
  assert.deepEqual(rule.hours, [9])
  assert.deepEqual(rule.daysOfMonth, [1])
  assert.deepEqual(rule.months, [3])
  assert.deepEqual(rule.daysOfWeek, [1, 2, 3, 4, 5])

  const list = parseCron('0 9,17 * * *')
  assert.deepEqual(list.hours, [9, 17])
})

test('周字段 7 归一为 0（周日）', () => {
  const rule = parseCron('0 9 * * 0,7')
  assert.deepEqual(rule.daysOfWeek, [0])
})

// ==================== 解析：非法输入一律报错 ====================

test('非法输入：段数错误 / 越界 / 别名 / L W # ? / 步长 0 / 区间倒置', () => {
  assert.throws(() => parseCron('0 9 * *'), /5 段/)
  assert.throws(() => parseCron('0 9 * * * *'), /5 段/)
  assert.throws(() => parseCron('0 25 * * *'), /超出范围/)
  assert.throws(() => parseCron('0 9 * * mon'), /不支持/)
  assert.throws(() => parseCron('0 9 * * jan'), /不支持/)
  assert.throws(() => parseCron('0 9 L * *'), /不支持/)
  assert.throws(() => parseCron('0 9 * * ?'), /不支持/)
  assert.throws(() => parseCron('*/0 * * * *'), /步长/)
  assert.throws(() => parseCron('5-2 * * * *'), /起点大于终点/)
  assert.throws(() => parseCron('0 9 * * 8'), /超出范围/)
  assert.throws(() => parseCron('x * * * *'), /不支持/)
})

// ==================== 下次触发计算 ====================

test('每日 9:00：当天 8:30 → 当天 9:00；9:00 整 → 次日 9:00（严格大于）', () => {
  const rule = parseCron('0 9 * * *')
  const morning = new Date(2026, 7, 18, 8, 30, 0, 0).getTime()
  const at900 = new Date(2026, 7, 18, 9, 0, 0, 0).getTime()
  assert.equal(nextFire(rule, morning), at900)
  const nextDay = new Date(2026, 7, 19, 9, 0, 0, 0).getTime()
  assert.equal(nextFire(rule, at900), nextDay)
})

test('*/15 分钟步进：09:07 → 09:15', () => {
  const rule = parseCron('*/15 * * * *')
  const from = new Date(2026, 7, 18, 9, 7, 30, 0).getTime()
  assert.equal(nextFire(rule, from), new Date(2026, 7, 18, 9, 15, 0, 0).getTime())
})

test('每周五 17:00：周一 → 本周五', () => {
  // 2026-08-17 是周一
  const rule = parseCron('0 17 * * 5')
  const monday = new Date(2026, 7, 17, 10, 0, 0, 0).getTime()
  assert.equal(nextFire(rule, monday), new Date(2026, 7, 21, 17, 0, 0, 0).getTime())
})

test('日/周同时受限取"或"（Vixie 语义）：每月 1 日或每周一', () => {
  // 2026-08-18 周二；8-24 周一；9-1 是下个 1 日。周一先到
  const rule = parseCron('0 0 1 * 1')
  const from = new Date(2026, 7, 18, 10, 0, 0, 0).getTime()
  assert.equal(nextFire(rule, from), new Date(2026, 7, 24, 0, 0, 0, 0).getTime())
})

test('2 月 29 日：有界扫描内找到（2028 闰年）', () => {
  const rule = parseCron('0 0 29 2 *')
  const from = new Date(2026, 7, 18, 0, 0, 0, 0).getTime()
  assert.equal(nextFire(rule, from), new Date(2028, 1, 29, 0, 0, 0, 0).getTime())
})

test('无法满足的规则（2 月 31 日）：有界迭代后明确报错，不死循环', () => {
  const rule = parseCron('0 0 31 2 *')
  const from = new Date(2026, 7, 18, 0, 0, 0, 0).getTime()
  assert.throws(() => nextFire(rule, from), /无法满足/)
})

test('countOccurrences：每日 9:00 错过 3 次（含 firstAt），上限截断', () => {
  const rule = parseCron('0 9 * * *')
  const anchor = new Date(2026, 7, 15, 9, 0, 0, 0).getTime()
  const now = new Date(2026, 7, 18, 9, 30, 0, 0).getTime()
  const { count, firstAt } = countOccurrences(rule, anchor, now)
  assert.equal(count, 3) // 16/17/18 日各一次
  assert.equal(firstAt, new Date(2026, 7, 16, 9, 0, 0, 0).getTime())

  const capped = countOccurrences(rule, anchor, now, 2)
  assert.equal(capped.count, 2)
  assert.ok(MAX_COALESCE_COUNT >= 1000)
})

// ==================== jitter 确定性 ====================

test('recurringJitterMs：同一 id 永远同样偏移；幅度 ≤ min(周期10%, 15分钟)', () => {
  const period = 24 * 60 * 60 * 1000 // 每日
  const a = recurringJitterMs('task-A', period)
  assert.equal(a, recurringJitterMs('task-A', period))
  assert.ok(a >= 0 && a <= MAX_RECURRING_JITTER_MS)

  const minute = 60 * 1000
  const b = recurringJitterMs('task-A', minute)
  assert.ok(b >= 0 && b <= 6000) // 1 分钟周期的 10% = 6s
})

test('oneShotAdvanceMs：仅 :00/:30 整点提前 ≤90 秒，其余不偏移', () => {
  const at000 = new Date(2026, 7, 18, 9, 0, 0, 0).getTime()
  const at030 = new Date(2026, 7, 18, 9, 30, 0, 0).getTime()
  const at015 = new Date(2026, 7, 18, 9, 15, 0, 0).getTime()
  const a = oneShotAdvanceMs('task-A', at000)
  assert.equal(a, oneShotAdvanceMs('task-A', at000))
  assert.ok(a >= 0 && a <= MAX_ONESHOT_ADVANCE_MS)
  assert.ok(oneShotAdvanceMs('task-A', at030) >= 0)
  assert.equal(oneShotAdvanceMs('task-A', at015), 0)
})

test('stableHash32：稳定且对输入敏感', () => {
  assert.equal(stableHash32('abc'), stableHash32('abc'))
  assert.notEqual(stableHash32('abc'), stableHash32('abd'))
})

// ==================== at 校验 ====================

test('parseAt：Z 与显式 offset 均可；无 offset / 过去时刻 / 垃圾输入报错', () => {
  const now = new Date(2026, 7, 18, 0, 0, 0, 0).getTime()
  const future = '2027-01-01T09:00:00+08:00'
  assert.equal(parseAt(future, now), Date.parse(future))
  assert.equal(parseAt('2027-01-01T01:00:00Z', now), Date.parse('2027-01-01T01:00:00Z'))

  assert.throws(() => parseAt('2027-01-01 09:00', now), /显式时区偏移/)
  assert.throws(() => parseAt('2027-01-01T09:00:00', now), /显式时区偏移/)
  assert.throws(() => parseAt('2020-01-01T09:00:00+08:00', now), /已过去/)
  assert.throws(() => parseAt('not-a-date', now), /显式时区偏移/)
})


// ==================== 相对时间（schedule_task 的 in 参数换算） ====================

test('parseRelativeDelay：m/h/d 与中文单位换算为绝对时刻；大小写与首尾空白容忍', () => {
  const now = Date.parse('2026-08-18T10:00:00.000Z')
  assert.equal(parseRelativeDelay('20m', now), now + 20 * 60 * 1000)
  assert.equal(parseRelativeDelay('2h', now), now + 2 * 60 * 60 * 1000)
  assert.equal(parseRelativeDelay('1d', now), now + 24 * 60 * 60 * 1000)
  assert.equal(parseRelativeDelay('20分钟', now), now + 20 * 60 * 1000)
  assert.equal(parseRelativeDelay('2小时', now), now + 2 * 60 * 60 * 1000)
  assert.equal(parseRelativeDelay('1天', now), now + 24 * 60 * 60 * 1000)
  assert.equal(parseRelativeDelay(' 30M ', now), now + 30 * 60 * 1000) // 大小写/空白容忍
})

test('parseRelativeDelay：零/负数/复合单位/垃圾输入一律报错', () => {
  const now = Date.parse('2026-08-18T10:00:00.000Z')
  assert.throws(() => parseRelativeDelay('0m', now), /正数/)
  assert.throws(() => parseRelativeDelay('-5m', now), /无法解析/)
  assert.throws(() => parseRelativeDelay('1h30m', now), /无法解析/) // 单单位（刻意收敛）
  assert.throws(() => parseRelativeDelay('二十分钟后', now), /无法解析/)
  assert.throws(() => parseRelativeDelay('', now), /无法解析/)
})

test('formatLocalRfc3339：输出 RFC 3339 显式 offset，且可被 parseAt 原样接受', () => {
  const now = Date.parse('2026-08-18T10:00:00.000Z')
  const target = parseRelativeDelay('20m', now)
  const text = formatLocalRfc3339(target)
  assert.match(text, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/)
  assert.equal(parseAt(text, now), target, '换算结果的落盘形态必须是 parseAt 的合法输入')
})
