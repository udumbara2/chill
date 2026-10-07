import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChatEngine } from '../../src/engine/ChatEngine.ts'
import type { ChatEngineDeps } from '../../src/engine/types.ts'
import type { Message } from '../../src/types/models.ts'
import { TaskStore } from '../../src/services/scheduler/TaskStore.ts'
import { SchedulerService } from '../../src/services/scheduler/SchedulerService.ts'
import { BuiltInToolExecutor } from '../../src/services/builtInToolExecutor.ts'
import type { IFileSystemProvider } from '../../src/interfaces/IFileSystemProvider.ts'

/**
 * 钉子测试（M0.4，规划《定时任务 serve 持钟与定向路由》）：
 * 多引擎共享 executor（serve 形态装配）下，schedule_task 的创建归属。
 *
 * 场景 A（M3 目标态）：serve 形态引擎（注入 scheduler、不启钟）经自身 __origin 创建
 *   → 归属必须=该引擎本地 workDir/sessionId，绝不被共享 executor 的回退槽
 *   （先构造的 chatService 引擎）劫持——P2 的正向钉。
 * 场景 B（钉子，先红后绿）：未注入 scheduler 的引擎（= 今日 serve 工厂形态）经自身
 *   __origin 创建 → 归属绝不落到他引擎的值上（今日实际：静默落到回退槽引擎的
 *   workDir —— 红）。M1 修复语义：归因明确但该引擎未装配 → 诚实「未装配」失败，
 *   不跨引擎代取（规划原文「scope 报未装配」的兑现）。
 *
 * enum（MessageRole 等）不可运行时导入，一律字符串字面量。
 */

function makeFakeFs() {
  const files = new Map<string, string>()
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
    getCurrentDirectory: () => '/proj-a',
    fileExists: async (p: string) => ({ success: true, data: files.has(p) }),
    getPathType: async (p: string) => ({
      success: true,
      data: { type: files.has(p) ? ('file' as const) : ('not_found' as const) },
    }),
  }
  return { fs, files }
}

/** 最小引擎 deps（真实共享 executor；scheduler 可选注入=serve 两种形态） */
function makeEngineDeps(
  executor: BuiltInToolExecutor,
  workDir: string,
  scheduler: SchedulerService | null
): ChatEngineDeps {
  return {
    modelCaller: { callOnce: async () => ({ content: 'ok' }) },
    modelInfo: {
      getModelsWithApiKeys: async () => [],
      getModelInfoByName: () => undefined,
    } as any,
    selectedModels: { getCurrentModelName: () => 'fake-model' } as any,
    sessionStore: {
      save: async () => ({ success: true }),
      load: async () => ({ success: false }),
    } as any,
    builtInToolExecutor: executor,
    mcpService: { getAggregatedOpenAITools: async () => [] } as any,
    eventBus: { on: () => {}, off: () => {}, emit: () => {} },
    workDir,
    scheduler,
    // 启停归壳（测试不启动时钟；接线语义与 ctor 一致）
    shellOwnsScheduler: true,
  } as any
}

/** 经指定引擎的 __origin 直调 schedule_task（复刻 ChatEngine.buildCallOrigin 的注入形状） */
async function callScheduleTaskAs(
  executor: BuiltInToolExecutor,
  engine: ChatEngine,
  args: Record<string, unknown>,
  toolCallId: string
) {
  const sessionId = engine.getSessionState().sessionId
  return executor.executeAsync(
    'schedule_task',
    JSON.stringify({
      ...args,
      __origin: { source: 'main', handle: engine.getScopeHandle(), sessionId },
    }),
    toolCallId
  )
}

/** 可控时钟（at 时刻须相对 now 为未来） */
const T0 = Date.parse('2026-08-18T10:00:00.000Z')

test('场景 A：注入 scheduler 的引擎（serve 目标态）经自身 origin 创建——归属=本地值，不被回退槽劫持', async () => {
  const { fs } = makeFakeFs()
  const store = new TaskStore(fs, '/home/user/.chill/scheduled-tasks.json')
  const scheduler = new SchedulerService({ store, now: () => T0 })
  const executor = new BuiltInToolExecutor(fs, {} as any, {} as any, {
    executePowerShell: async () => ({ success: true, output: 'ok' }),
  } as any)
  executor.setUserInputProvider({ ask: async () => '1' } as any)

  // chatService 形态（先构造，持有共享 executor 的回退槽）与 serve 形态引擎共享同一 executor
  const chatServiceEngine = new ChatEngine(makeEngineDeps(executor, '/proj-a', scheduler))
  const serveEngine = new ChatEngine(makeEngineDeps(executor, '/proj-b', scheduler))
  chatServiceEngine.ensureSessionId()
  serveEngine.ensureSessionId()

  // project scope：归属必须=发起引擎的 workDir（/proj-b），不是回退槽引擎的 /proj-a
  const r1 = await callScheduleTaskAs(executor, serveEngine, {
    at: '2026-08-19T10:00:00+08:00',
    prompt: '提醒我',
  }, 'tc-na-a1')
  assert.equal(r1.success, true, String((r1 as any).error))
  const tasks1 = await scheduler.list()
  assert.equal(tasks1.length, 1)
  assert.equal(tasks1[0].scope, 'project')
  assert.equal(tasks1[0].workDir, '/proj-b', 'project 任务归属=发起引擎本地 workDir，不被回退槽劫持')

  // session scope：sessionId 必须=发起引擎的会话 id
  const r2 = await callScheduleTaskAs(executor, serveEngine, {
    at: '2026-08-19T11:00:00+08:00',
    prompt: '提醒我2',
    scope: 'session',
  }, 'tc-na-a2')
  assert.equal(r2.success, true, String((r2 as any).error))
  const tasks2 = await scheduler.list()
  const sessionTask = tasks2.find((t) => t.scope === 'session')!
  assert.ok(sessionTask, 'session 任务已创建')
  assert.equal(sessionTask.sessionId, serveEngine.getSessionState().sessionId, 'session 任务归属=发起引擎的会话 id')
})

test('场景 B（钉子）：未注入 scheduler 的引擎（今日 serve 形态）——归属绝不落到他引擎值上', async () => {
  const { fs } = makeFakeFs()
  const store = new TaskStore(fs, '/home/user/.chill/scheduled-tasks.json')
  const scheduler = new SchedulerService({ store, now: () => T0 })
  const executor = new BuiltInToolExecutor(fs, {} as any, {} as any, {
    executePowerShell: async () => ({ success: true, output: 'ok' }),
  } as any)
  executor.setUserInputProvider({ ask: async () => '1' } as any)

  // 今日 serve 装配形状：chatService 引擎持回退槽，serve 引擎无 scheduler
  const chatServiceEngine = new ChatEngine(makeEngineDeps(executor, '/proj-a', scheduler))
  const serveEngine = new ChatEngine(makeEngineDeps(executor, '/proj-b', null))
  chatServiceEngine.ensureSessionId()
  serveEngine.ensureSessionId()

  const result = await callScheduleTaskAs(executor, serveEngine, {
    at: '2026-08-19T10:00:00+08:00',
    prompt: '提醒我',
  }, 'tc-na-b1')

  // 不变量：要么诚实失败（未装配，M1 语义），要么成功且归属=发起引擎本地值；
  // 绝不允许静默落到回退槽引擎（chatService）的 /proj-a——今日现状即此病（红）。
  if (result.success) {
    const tasks = await scheduler.list()
    assert.equal(tasks.length, 1)
    assert.equal(tasks[0].scope, 'project')
    assert.notEqual(tasks[0].workDir, '/proj-a', '归属绝不可落到非发起引擎的 workDir（跨引擎代取）')
    assert.equal(tasks[0].workDir, '/proj-b')
  } else {
    assert.ok(
      String((result as any).error).includes('未装配'),
      '失败必须是诚实的「未装配」提示，而非其他错因'
    )
  }
})
