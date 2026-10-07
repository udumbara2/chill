import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TaskStore } from '../../src/services/scheduler/TaskStore.ts'
import { SchedulerService } from '../../src/services/scheduler/SchedulerService.ts'
import { createClaimGate } from '../../src/services/scheduler/claimGate.ts'
import type { ScheduledTask } from '../../src/services/scheduler/types.ts'
import type { IFileSystemProvider } from '../../src/interfaces/IFileSystemProvider.ts'

/**
 * M6 跨进程触发抢占闸测试（规划《定时任务 serve 持钟与定向路由》）：
 * 独占单胜者、TTL 兜崩溃（未过期宁等勿抢/过期可夺）、无原语优雅降级、
 * markFired 落定释放、SchedulerService 集成（抢占失败跳过本轮）。
 */

const T0 = Date.parse('2026-08-18T10:00:00.000Z')

/** 内存假 fs：含 createFileExclusive（O_EXCL 语义模拟） */
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
    createFileExclusive: async (p: string, content: string) => {
      if (files.has(p)) return { success: true, data: false }
      files.set(p, content)
      return { success: true, data: true }
    },
  }
  return { fs, files }
}

test('claimGate：独占单胜者；release 后可重新抢占；不同任务互不干扰', async () => {
  const { fs } = makeFakeFs()
  const nowState = { value: T0 }
  const a = createClaimGate({ fs, claimsDir: '/claims', now: () => nowState.value })
  const b = createClaimGate({ fs, claimsDir: '/claims', now: () => nowState.value })
  assert.equal(a.enabled, true)

  assert.equal(await a.acquire('t-1'), true, '首抢成功')
  assert.equal(await b.acquire('t-1'), false, '他进程持有 → 拒绝')
  assert.equal(await b.acquire('t-2'), true, '不同任务互不干扰')

  await a.release('t-1')
  assert.equal(await b.acquire('t-1'), true, 'release 后可重新抢占')
})

test('claimGate：TTL 兜崩溃——未过期宁等勿抢；过期可夺取', async () => {
  const { fs } = makeFakeFs()
  const nowState = { value: T0 }
  const gate = createClaimGate({ fs, claimsDir: '/claims', now: () => nowState.value, ttlMs: 30 * 60 * 1000 })
  const other = createClaimGate({ fs, claimsDir: '/claims', now: () => nowState.value, ttlMs: 30 * 60 * 1000 })
  assert.equal(await gate.acquire('t-x'), true)

  nowState.value = T0 + 29 * 60 * 1000 // 29min：合法长轮次进行中——不得误判崩溃残留
  assert.equal(await other.acquire('t-x'), false, '未过期：宁等勿抢（防复现双跑）')

  nowState.value = T0 + 31 * 60 * 1000 // 31min：崩溃残留——可夺取
  assert.equal(await other.acquire('t-x'), true, '过期：删除重试独占成功')
})

test('claimGate：宿主无 createFileExclusive 原语 → 优雅降级（无闸放行）', async () => {
  const { fs } = makeFakeFs()
  const bare: IFileSystemProvider = {
    readFile: fs.readFile,
    writeFile: fs.writeFile,
    deleteFile: fs.deleteFile,
    listDirectory: fs.listDirectory,
    getCurrentDirectory: fs.getCurrentDirectory,
    fileExists: fs.fileExists,
    getPathType: fs.getPathType,
    // 无 createFileExclusive
  }
  const gate = createClaimGate({ fs: bare, claimsDir: '/claims' })
  assert.equal(gate.enabled, false)
  assert.equal(await gate.acquire('t-1'), true, '降级=放行（乐观判重现状）')
  await gate.release('t-1') // 无操作不抛
})

test('SchedulerService 集成：抢占失败跳过本轮；markFired 落定释放后下一轮可触发', async () => {
  const { fs } = makeFakeFs()
  const store = new TaskStore(fs, '/home/user/.chill/scheduled-tasks.json')
  const fired: string[] = []
  // 他进程先抢占 t-c
  const foreign = createClaimGate({ fs, claimsDir: '/claims', now: () => T0 })
  assert.equal(await foreign.acquire('t-c'), true)

  const scheduler = new SchedulerService({
    store,
    fireMode: 'directed',
    now: () => T0,
    claimGate: createClaimGate({ fs, claimsDir: '/claims', now: () => T0 }),
    onFire: (t) => {
      fired.push(t.id)
    },
  })
  const oneShot = {
    id: 't-c',
    at: '2026-08-18T09:00:00.000Z',
    prompt: 'p',
    recurring: false,
    scope: 'session',
    sessionId: 's-x',
    createdAt: '2026-08-17T09:00:00.000Z',
    fireCount: 0,
    status: 'active',
  } as ScheduledTask
  await store.saveAll([oneShot])

  const r1 = await scheduler.tick()
  assert.equal(r1.length, 0, '他进程持有 claim → 跳过本轮（双跑窗口归零）')
  assert.equal(fired.length, 0)

  await foreign.release('t-c') // 他进程落定释放
  const r2 = await scheduler.tick()
  assert.equal(r2.length, 1, '释放后下一自然触发点可触发')
  assert.equal(fired.length, 1)

  // markFired 释放自有 claim：本进程触发后 claim 被清除（目录无残留）——
  // 直接验证：同目录新建 gate 可立即抢占（说明 markFired 已释放）
  await scheduler.markFired('t-c', 'completed')
  const reGate = createClaimGate({ fs, claimsDir: '/claims', now: () => T0 })
  assert.equal(await reGate.acquire('t-c'), true, 'markFired 落定即释放 claim')
})
