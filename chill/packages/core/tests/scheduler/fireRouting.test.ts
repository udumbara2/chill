import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TaskStore } from '../../src/services/scheduler/TaskStore.ts'
import { SchedulerService } from '../../src/services/scheduler/SchedulerService.ts'
import { resolveScheduledFireTarget } from '../../src/services/scheduler/fireRouting.ts'
import type { FireTargetSnapshot } from '../../src/services/scheduler/fireRouting.ts'
import type { ScheduledTask } from '../../src/services/scheduler/types.ts'
import type { IFileSystemProvider } from '../../src/interfaces/IFileSystemProvider.ts'

/**
 * M2 定向路由纯函数测试（规划《定时任务 serve 持钟与定向路由》）：
 * session 三分支（在册/装载/orphan）、project 四分支（活跃优先/最近活跃/最近会话装载/新建兜底）、
 * workDir 归一匹配、markOrphaned/markSessionDeleted 清账写点。
 */

const T0 = Date.parse('2026-08-18T10:00:00.000Z')

function makeFakeFs(initialFiles: Record<string, string> = {}) {
  const files = new Map(Object.entries(initialFiles))
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
    getCurrentDirectory: () => '/proj',
    fileExists: async (p: string) => ({ success: true, data: files.has(p) }),
    getPathType: async (p: string) => ({
      success: true,
      data: { type: files.has(p) ? ('file' as const) : ('not_found' as const) },
    }),
  }
  return { fs, files }
}

function snapOf(partial: Partial<FireTargetSnapshot> = {}): FireTargetSnapshot {
  return {
    engines: [],
    sessionExists: () => false,
    latestSessionInDir: () => undefined,
    ...partial,
  }
}

function sessionTask(sessionId: string): ScheduledTask {
  return { id: 't-s', at: '2026-08-18T09:00:00.000Z', prompt: 'p', recurring: false, scope: 'session', sessionId, createdAt: '2026-08-17T09:00:00.000Z', fireCount: 0, status: 'active' } as ScheduledTask
}

function projectTask(workDir: string): ScheduledTask {
  return { id: 't-p', cron: '0 9 * * *', prompt: 'p', recurring: true, scope: 'project', workDir, createdAt: '2026-08-17T09:00:00.000Z', fireCount: 0, status: 'active' } as ScheduledTask
}

// ---------- session 分支 ----------

test('session：在册→engine；不在册但盘上有→load；都不行→orphan', async () => {
  const t = sessionTask('s-a')
  assert.deepEqual(
    resolveScheduledFireTarget(t, snapOf({ engines: [{ sessionId: 's-a', workDir: '/x' }] })),
    { kind: 'engine', sessionId: 's-a' }
  )
  assert.deepEqual(
    resolveScheduledFireTarget(t, snapOf({ sessionExists: (id) => id === 's-a' })),
    { kind: 'load', sessionId: 's-a' }
  )
  const orphan = resolveScheduledFireTarget(t, snapOf())
  assert.equal(orphan.kind, 'orphan')
  assert.ok(orphan.kind === 'orphan' && orphan.reason.includes('s-a'))
  // 缺 sessionId 的损坏条目 → orphan
  assert.equal(resolveScheduledFireTarget({ ...t, sessionId: undefined }, snapOf()).kind, 'orphan')
})

// ---------- project 分支 ----------

test('project：在册匹配引擎活跃优先、其次最近活跃；workDir 归一匹配（斜杠/大小写）', async () => {
  const t = projectTask('C:/Proj/X/')
  const snap = snapOf({
    engines: [
      { sessionId: 's-old', workDir: 'c:\\proj\\x', lastActiveAt: 100 },   // 归一匹配（大小写/斜杠）
      { sessionId: 's-active', workDir: 'C:/PROJ/x', isActive: true },     // 活跃优先胜出
      { sessionId: 's-other', workDir: 'c:/proj/y' },                      // 不匹配
    ],
  })
  assert.deepEqual(resolveScheduledFireTarget(t, snap), { kind: 'engine', sessionId: 's-active' })

  const noActive = snapOf({
    engines: [
      { sessionId: 's-newer', workDir: 'c:/proj/x', lastActiveAt: 200 },
      { sessionId: 's-older', workDir: 'c:/proj/x', lastActiveAt: 100 },
    ],
  })
  assert.deepEqual(resolveScheduledFireTarget(t, noActive), { kind: 'engine', sessionId: 's-newer' })
})

test('project：无在册→该目录最近会话 load；无会话→newSession 兜底（死目录照常新建）', async () => {
  const t = projectTask('/proj/x')
  assert.deepEqual(
    resolveScheduledFireTarget(t, snapOf({ latestSessionInDir: () => 's-latest', sessionExists: (id) => id === 's-latest' })),
    { kind: 'load', sessionId: 's-latest' }
  )
  // 目录无任何会话（含目录不存在的情形——照常 newSession，不做存在性拦截）
  assert.deepEqual(resolveScheduledFireTarget(t, snapOf()), { kind: 'newSession', workDir: '/proj/x' })
})

// ---------- markOrphaned / markSessionDeleted ----------

test('markOrphaned：active→orphaned 幂等；markSessionDeleted：批量清账只打 session 任务', async () => {
  const { fs } = makeFakeFs()
  const store = new TaskStore(fs, '/home/user/.chill/scheduled-tasks.json')
  const scheduler = new SchedulerService({ store, now: () => T0 })
  await store.saveAll([
    sessionTask('s-gone'),
    { ...projectTask('/proj'), id: 't-p2' },
    { ...sessionTask('s-keep'), id: 't-keep' },
    { ...sessionTask('s-gone'), id: 't-done', status: 'done' },
  ])

  assert.equal(await scheduler.markOrphaned('t-keep'), true)
  let tasks = await scheduler.list()
  assert.equal(tasks.find((t) => t.id === 't-keep')?.status, 'orphaned')
  assert.equal(await scheduler.markOrphaned('t-keep'), false, '非 active 不再转（幂等）')
  assert.equal(await scheduler.markOrphaned('t-nope'), false)

  const hit = await scheduler.markSessionDeleted('s-gone')
  assert.deepEqual(hit, ['t-s'], '只清账 active 的绑定任务（done 不动）')
  tasks = await scheduler.list()
  assert.equal(tasks.find((t) => t.id === 't-s')?.status, 'orphaned', '绑定被删会话的 active 任务清账')
  assert.equal(tasks.find((t) => t.id === 't-done')?.status, 'done', 'done 任务不动（已终态）')
  assert.equal(tasks.find((t) => t.id === 't-p2')?.status, 'active', 'project 任务不受会话删除影响')
  assert.equal(tasks.find((t) => t.id === 't-keep')?.status, 'orphaned', '先前已 orphaned 的保持')
})
