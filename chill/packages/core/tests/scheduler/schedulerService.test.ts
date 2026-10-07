import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SchedulerService, MAX_TASKS, MAX_PROMPT_BYTES } from '../../src/services/scheduler/SchedulerService.ts'
import { TaskStore } from '../../src/services/scheduler/TaskStore.ts'
import type { IFileSystemProvider } from '../../src/interfaces/IFileSystemProvider.ts'
import type { NewTaskInput, ScheduledTask } from '../../src/services/scheduler/types.ts'

const FILE = '/home/user/.chill/scheduled-tasks.json'

/** 固定时钟：2026-08-18 09:30 本地时间（周二） */
const NOW = new Date(2026, 7, 18, 9, 30, 0, 0).getTime()

function makeTask(id: string, extra: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id,
    cron: '0 9 * * *',
    prompt: '汇总昨天进展',
    recurring: true,
    scope: 'project',
    workDir: '/proj',
    createdAt: new Date(2026, 7, 17, 0, 0, 0, 0).toISOString(),
    fireCount: 0,
    status: 'active',
    ...extra,
  }
}

function makeStore(initialTasks: ScheduledTask[] = []) {
  const files = new Map<string, string>()
  if (initialTasks.length > 0) files.set(FILE, JSON.stringify({ version: 1, tasks: initialTasks }))
  const mtime = { value: 1000 as number | null }
  const fs: IFileSystemProvider = {
    readFile: async (p: string) => {
      const content = files.get(p)
      return content === undefined ? { success: false, error: 'not found' } : { success: true, data: { content } }
    },
    writeFile: async (p: string, content: string) => {
      files.set(p, content)
      return { success: true }
    },
    deleteFile: async (p: string) => {
      files.delete(p)
      return { success: true }
    },
    listDirectory: async () => ({ success: true, data: { files: [] } }),
    getCurrentDirectory: () => null,
    fileExists: async (p: string) => ({ success: true, data: files.has(p) }),
    getPathType: async (p: string) => ({ success: true, data: { type: 'file' as const } }),
  }
  const store = new TaskStore(fs, FILE, { getMtimeMs: async () => mtime.value })
  return { store, files, mtime }
}

function makeService(
  store: TaskStore,
  opts: {
    workDir?: string
    sessionId?: string
    onFire?: (task: ScheduledTask, coalescedCount: number) => void
    now?: () => number
  } = {}
) {
  const fired: Array<{ task: ScheduledTask; coalescedCount: number }> = []
  const service = new SchedulerService({
    store,
    onFire: opts.onFire ?? ((task, coalescedCount) => { fired.push({ task, coalescedCount }) }),
    getWorkDir: () => (opts.workDir === undefined ? '/proj' : opts.workDir),
    getSessionId: () => opts.sessionId,
    now: opts.now ?? (() => NOW),
  })
  return { service, fired }
}

function validInput(extra: Partial<NewTaskInput> = {}): NewTaskInput {
  return {
    cron: '0 9 * * *',
    prompt: '汇总昨天进展',
    recurring: true,
    scope: 'project',
    workDir: '/proj',
    ...extra,
  }
}

// ==================== 创建校验 ====================

test('创建：合法任务落盘并补齐字段（id/createdAt/fireCount/status）', async () => {
  const { store } = makeStore()
  const { service } = makeService(store)
  const task = await service.validateAndCreate(validInput())
  assert.ok(task.id.startsWith('t-'))
  assert.equal(task.status, 'active')
  assert.equal(task.fireCount, 0)
  assert.equal((await service.list()).length, 1)
})

test('创建校验：cron/at 二选一、recurring 一致性、过去 at、scope 归属字段', async () => {
  const { store } = makeStore()
  const { service } = makeService(store)
  await assert.rejects(() => service.validateAndCreate(validInput({ at: '2027-01-01T09:00:00+08:00' })), /二选一/)
  await assert.rejects(() => service.validateAndCreate(validInput({ cron: undefined, at: undefined })), /二选一/)
  await assert.rejects(() => service.validateAndCreate(validInput({ recurring: false })), /recurring 必须为 true/)
  await assert.rejects(
    () => service.validateAndCreate({ at: '2020-01-01T09:00:00+08:00', prompt: 'x', recurring: false, scope: 'project', workDir: '/proj' }),
    /已过去/
  )
  await assert.rejects(() => service.validateAndCreate(validInput({ workDir: undefined })), /workDir/)
  await assert.rejects(() => service.validateAndCreate(validInput({ scope: 'session' })), /sessionId/)
  await assert.rejects(() => service.validateAndCreate(validInput({ cron: '0 25 * * *' })), /超出范围/)
  await assert.rejects(() => service.validateAndCreate(validInput({ prompt: '' })), /prompt/)
  await assert.rejects(() => service.validateAndCreate(validInput({ prompt: 'x'.repeat(MAX_PROMPT_BYTES + 1) })), /上限/)
  await assert.rejects(() => service.validateAndCreate(validInput({ until: '2020-01-01T00:00:00+08:00' })), /已过去/)
})

test('创建限额：50 个活跃任务后拒绝新建', async () => {
  const fifty = Array.from({ length: MAX_TASKS }, (_, i) => makeTask(`t-${i}`))
  const { store } = makeStore(fifty)
  const { service } = makeService(store)
  await assert.rejects(() => service.validateAndCreate(validInput()), /上限 50/)
})

// ==================== 到期判定与触发 ====================

test('到期触发：project scope 匹配（目录大小写/斜杠归一），onFire 收到任务与 coalescedCount=1', async () => {
  // createdAt=今天 08:30 → 只有今天 09:00 一个槽位到期（昨天创建会累计 2 次，另见 collapse 用例）
  const { store } = makeStore([makeTask('t-1', { workDir: 'C:\\Proj', createdAt: new Date(2026, 7, 18, 8, 30, 0, 0).toISOString() })])
  const { service, fired } = makeService(store, { workDir: 'c:/proj/' })
  const decisions = await service.tick()
  assert.equal(fired.length, 1)
  assert.equal(fired[0].task.id, 't-1')
  assert.equal(fired[0].coalescedCount, 1)
  assert.equal(decisions.length, 1)
})

test('scope 不匹配：不触发，记 overdue', async () => {
  const { store } = makeStore([makeTask('t-1', { workDir: '/other' })])
  const { service, fired } = makeService(store, { workDir: '/proj' })
  await service.tick()
  assert.equal(fired.length, 0)
  const overdue = service.getOverdue()
  assert.equal(overdue.length, 1)
  assert.equal(overdue[0].task.id, 't-1')
  assert.equal(overdue[0].scopeMatches, false)
})

test('session scope：仅绑定的 sessionId 触发', async () => {
  const task = makeTask('t-1', { scope: 'session', sessionId: 's-1', workDir: undefined })
  const { store } = makeStore([task])
  const miss = makeService(store, { workDir: '/proj', sessionId: 's-2' })
  await miss.service.tick()
  assert.equal(miss.fired.length, 0)

  const hit = makeService(store, { workDir: '/proj', sessionId: 's-1' })
  await hit.service.tick()
  assert.equal(hit.fired.length, 1)
})

test('一次性 at 任务：到期触发，markFired 后转 done', async () => {
  const at = new Date(2026, 7, 18, 9, 0, 0, 0).toISOString() // 09:00 本地 → :00 整点提前 ≤90s，09:30 已到期
  const task = makeTask('t-1', { cron: undefined, at, recurring: false })
  const { store } = makeStore([task])
  const { service, fired } = makeService(store)
  await service.tick()
  assert.equal(fired.length, 1)

  assert.equal(await service.markFired('t-1'), true)
  const after = (await service.list()).find((t) => t.id === 't-1')!
  assert.equal(after.status, 'done')
  assert.equal(after.fireCount, 1)
  assert.ok(after.lastFireAt)

  // done 后 tick 不再触发
  const again = makeService(store)
  await again.service.tick()
  assert.equal(again.fired.length, 0)
})

test('逾期 collapse-to-latest：上次触发在 3 天前，coalescedCount=3', async () => {
  const lastFire = new Date(2026, 7, 15, 9, 0, 0, 0) // 周六 09:00
  const task = makeTask('t-1', { lastFireAt: lastFire.toISOString(), fireCount: 5 })
  const { store } = makeStore([task])
  const { service, fired } = makeService(store)
  await service.tick()
  assert.equal(fired.length, 1)
  assert.equal(fired[0].coalescedCount, 3, '16/17/18 日三次合并为一次')
})

test('乐观判重：触发前 reload 发现另一端已 markFired，跳过不双触发', async () => {
  const task = makeTask('t-1')
  const { store, files, mtime } = makeStore([task])
  const { service, fired } = makeService(store)

  // 第二次 checkReload（触发前那次）模拟另一端写入 lastFireAt
  const orig = store.checkReload.bind(store)
  let calls = 0
  store.checkReload = async () => {
    calls++
    if (calls === 2) {
      files.set(FILE, JSON.stringify({
        version: 1,
        tasks: [{ ...task, lastFireAt: new Date(NOW).toISOString(), fireCount: 1 }],
      }))
      mtime.value = (mtime.value ?? 0) + 1
    }
    return orig()
  }

  await service.tick()
  assert.equal(fired.length, 0, '另一端刚触发过则本端跳过')
})

// ==================== until 与完结 ====================

test('until 已过期且下次应触发越过 until：tick 直接转 done，不触发', async () => {
  const task = makeTask('t-1', { until: new Date(2026, 7, 17, 0, 0, 0, 0).toISOString() })
  const { store } = makeStore([task])
  const { service, fired } = makeService(store)
  await service.tick()
  assert.equal(fired.length, 0)
  assert.equal((await service.list()).find((t) => t.id === 't-1')!.status, 'done')
})

test('markFired：周期任务下次应触发越过 until 时转 done', async () => {
  // until = 今天 09:20；今天 09:00 槽位（含 ≤15 分钟 jitter 也早于 09:20）触发后，下一槽（明天 09:00）越过 until → done
  const task = makeTask('t-1', { until: new Date(2026, 7, 18, 9, 20, 0, 0).toISOString() })
  const { store } = makeStore([task])
  const { service, fired } = makeService(store)
  await service.tick()
  assert.equal(fired.length, 1)
  await service.markFired('t-1')
  const after = (await service.list()).find((t) => t.id === 't-1')!
  assert.equal(after.status, 'done')
  assert.equal(after.fireCount, 1)
})

// ==================== 逾期检测与取消 ====================

test('detectOverdue：返回错过任务的 missedCount 与 scopeMatches 标注', async () => {
  const due = makeTask('t-due', { workDir: '/proj' })
  const otherDir = makeTask('t-other', { workDir: '/other' })
  const future = makeTask('t-future', { cron: '0 23 * * *', createdAt: new Date(2026, 7, 18, 9, 0, 0, 0).toISOString() }) // 今晚 23 点才首次触发，未到期
  const { store } = makeStore([due, otherDir, future])
  const { service } = makeService(store, { workDir: '/proj' })
  const records = await service.detectOverdue()
  assert.equal(records.length, 2)
  const byId = new Map(records.map((r) => [r.task.id, r]))
  assert.equal(byId.get('t-due')!.scopeMatches, true)
  assert.equal(byId.get('t-other')!.scopeMatches, false)
  assert.ok(byId.get('t-due')!.missedCount >= 1)
})

test('cancel：移除任务并清除逾期记录；不存在返回 false', async () => {
  const { store } = makeStore([makeTask('t-1', { workDir: '/other' })])
  const { service } = makeService(store, { workDir: '/proj' })
  await service.tick() // 登记 overdue
  assert.equal(service.getOverdue().length, 1)

  assert.equal(await service.cancel('t-1'), true)
  assert.equal(await service.cancel('t-1'), false)
  assert.equal((await service.list()).length, 0)
  assert.equal(service.getOverdue().length, 0)
})

// ==================== 生命周期 ====================

test('start/stop：启动即挂对齐定时器，停止后清空', () => {
  const { store } = makeStore()
  const { service } = makeService(store)
  assert.equal(service.running, false)
  service.start()
  assert.equal(service.running, true)
  service.stop()
  assert.equal(service.running, false)
})


// ==================== markFired 执行记录（lastRun 写回两态） ====================

test('markFired completed：lastRun 与 lastFireAt 同刻单次写回；failed 只写 lastRun 不动判重字段', async () => {
  const { store, mtime } = makeStore([makeTask('t-run')])
  const { service } = makeService(store)

  // completed：lastFireAt/fireCount 推进 + lastRun.outcome='completed'（单写点，判重仍只看 lastFireAt）
  assert.equal(await service.markFired('t-run', 'completed', 3), true)
  // 拨动 mtime 强制重读落盘内容（走 parse 往返，验证 lastRun 持久化形状）
  mtime.value = 2000
  let stored = (await service.list()).find((t) => t.id === 't-run')!
  assert.ok(stored.lastFireAt)
  assert.equal(stored.fireCount, 1)
  assert.equal(stored.lastRun?.outcome, 'completed')
  assert.equal(stored.lastRun?.firedAt, stored.lastFireAt, 'completed 时 lastRun.firedAt 与 lastFireAt 同刻')
  assert.equal(stored.lastRun?.coalescedCount, 3)

  // failed：只写 lastRun（outcome='failed'），lastFireAt/fireCount/status 不动（重试语义不变）
  const beforeFireAt = stored.lastFireAt
  assert.equal(await service.markFired('t-run', 'failed', 2), true)
  mtime.value = 3000
  stored = (await service.list()).find((t) => t.id === 't-run')!
  assert.equal(stored.lastFireAt, beforeFireAt, 'failed 不得推进 lastFireAt')
  assert.equal(stored.fireCount, 1, 'failed 不得推进 fireCount')
  assert.equal(stored.status, 'active')
  assert.equal(stored.lastRun?.outcome, 'failed')
  assert.equal(stored.lastRun?.coalescedCount, 2)

  // 缺省参数保持旧语义（completed）
  assert.equal(await service.markFired('t-run'), true)
  stored = (await service.list()).find((t) => t.id === 't-run')!
  assert.equal(stored.fireCount, 2)
  assert.equal(stored.lastRun?.outcome, 'completed')
})

test('markFired：lastRun 形状非法的盘上记录按无记录清洗（不拖垮条目）', async () => {
  const bad = makeTask('t-bad')
  ;(bad as any).lastRun = { firedAt: 123, outcome: 'maybe' } // 非法形状
  const { store } = makeStore([bad])
  const tasks = await store.checkReload()
  assert.equal(tasks[0].lastRun, undefined)
})
