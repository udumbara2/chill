import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChatEngine } from '../../src/engine/ChatEngine.ts'
import type { ChatEngineDeps } from '../../src/engine/types.ts'
import { TaskStore } from '../../src/services/scheduler/TaskStore.ts'
import { SchedulerService } from '../../src/services/scheduler/SchedulerService.ts'
import type { ScheduledTask } from '../../src/services/scheduler/types.ts'
import type { IFileSystemProvider } from '../../src/interfaces/IFileSystemProvider.ts'

/**
 * M1 定向模式（fireMode: 'directed'）行为测试——规划《定时任务 serve 持钟与定向路由》：
 * 1. tick 到期即触发（不做活跃匹配；active 缺省模式仍活跃匹配不触发）；
 * 2. detectOverdue 返回空（引擎侧补跑退役），until 越期转 done 的清理保留；
 * 3. 引擎侧抑制：directed 引擎 loadSession 绝不触发逾期补跑（detectOverdue 不被调用）。
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

function makeTask(partial: Partial<ScheduledTask> & { id: string }): ScheduledTask {
  return {
    cron: '0 9 * * *',
    prompt: 'p',
    recurring: true,
    scope: 'project',
    workDir: '/proj-x',
    createdAt: '2026-08-17T09:00:00.000Z',
    fireCount: 0,
    status: 'active',
    ...partial,
  } as ScheduledTask
}

test('directed：到期即触发（无活跃上下文也触发）；active 缺省：不匹配不触发', async () => {
  // directed：任务绑 /proj-x 且无任何活跃上下文 getter——活跃匹配模式下必不触发
  const directed = (() => {
    const { fs } = makeFakeFs()
    const store = new TaskStore(fs, '/home/user/.chill/scheduled-tasks.json')
    const fired: string[] = []
    const scheduler = new SchedulerService({
      store,
      fireMode: 'directed',
      now: () => T0,
      onFire: (t) => {
        fired.push(t.id)
      },
    })
    return { store, scheduler, fired }
  })()

  const due = makeTask({ id: 't-due', cron: '0 8 * * *' }) // 08:00 UTC? —— 用 at 更直观
  // 直接用一次性 at：T0-1h 已过期 → 到期
  const oneShot = makeTask({ id: 't-one', cron: undefined, at: '2026-08-18T09:00:00.000Z', recurring: false, scope: 'session', sessionId: 's-else' })
  await directed.store.saveAll([due, oneShot])
  const fired = await directed.scheduler.tick()
  assert.equal(fired.length, 2, 'directed：到期即触发，不因 scope 不匹配（session 绑他话/workDir 无活跃源）而搁置')
  assert.ok(directed.fired.includes('t-one'))

  // active（缺省）：同任务形态 + 无活跃上下文 → 不触发、记 overdue
  const active = (() => {
    const { fs } = makeFakeFs()
    const store = new TaskStore(fs, '/home/user/.chill/scheduled-tasks.json')
    const scheduler = new SchedulerService({ store, now: () => T0 })
    return { store, scheduler }
  })()
  await active.store.saveAll([oneShot])
  const firedActive = await active.scheduler.tick()
  assert.equal(firedActive.length, 0, 'active 缺省：scope 不匹配不触发（现状逐位不变）')
  assert.equal(active.scheduler.getOverdue().length, 1, 'active 缺省：登记逾期')
})

test('directed：detectOverdue 返回空（引擎侧补跑退役）；until 越期转 done 清理保留', async () => {
  const { fs } = makeFakeFs()
  const store = new TaskStore(fs, '/home/user/.chill/scheduled-tasks.json')
  const scheduler = new SchedulerService({ store, fireMode: 'directed', now: () => T0 })
  const due = makeTask({ id: 't-due2', cron: undefined, at: '2026-08-18T09:00:00.000Z', recurring: false, scope: 'session', sessionId: 's-me' })
  // 下一槽位=本地 08:00（cron 本地时区；createdAt 之后首个槽）；until 早于该槽 → 离线期间寿终
  const expiredUntil = makeTask({ id: 't-dead', cron: '0 8 * * *', until: '2026-08-17T23:00:00.000Z' })
  await store.saveAll([due, expiredUntil])

  const records = await scheduler.detectOverdue()
  assert.equal(records.length, 0, 'directed：不产出补跑记录')
  const tasks = await scheduler.list()
  assert.equal(tasks.find((t) => t.id === 't-dead')?.status, 'done', 'until 越期转 done 的清理保留')
  assert.equal(tasks.find((t) => t.id === 't-due2')?.status, 'active', '未越期任务不受影响')
})

test('directed 引擎：loadSession 不触发引擎侧补跑（detectOverdue 根本不被调用）', async () => {
  let detectCalled = false
  const stubScheduler = {
    getFireMode: () => 'directed' as const,
    detectOverdue: async () => {
      detectCalled = true
      return []
    },
    setOnFire: () => {},
    setActiveContext: () => {},
    // ChatEngine 其他触点（构造接线）——最小桩
    ...( { } as any ),
  }
  let modelCalled = 0
  const deps: ChatEngineDeps = {
    modelCaller: { callOnce: async () => { modelCalled += 1; return { content: 'ok' } } },
    modelInfo: { getModelsWithApiKeys: async () => [], getModelInfoByName: () => undefined } as any,
    selectedModels: { getCurrentModelName: () => 'fake-model' } as any,
    sessionStore: {
      save: async () => ({ success: true }),
      load: async () => ({
        success: true,
        record: {
          id: 's-load-target',
          title: 't',
          titleSource: 'default',
          messages: [],
          createdAt: '2026-08-17T09:00:00.000Z',
          updatedAt: '2026-08-17T09:00:00.000Z',
        },
      }),
    } as any,
    builtInToolExecutor: {
      execute: () => ({ success: true }),
      executeAsync: async () => ({ success: true }),
      setPlanMode: () => {},
      getAutoApply: () => false,
      getNonInteractiveMode: () => null,
      applyAutoApplyBatch: async () => new Map(),
    } as any,
    mcpService: { getAggregatedOpenAITools: async () => [] } as any,
    eventBus: { on: () => {}, off: () => {}, emit: () => {} },
    workDir: '/proj',
    scheduler: stubScheduler as any,
    shellOwnsScheduler: true,
  } as any
  const engine = new ChatEngine(deps)
  await engine.loadSession('s-load-target')
  assert.equal(detectCalled, false, 'directed 引擎装载会话不得触发逾期检测（引擎侧补跑退役）')
  assert.equal(modelCalled, 0, '不得产生任何补跑轮')
})
