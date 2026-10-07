import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChatEngine } from '../../src/engine/ChatEngine.ts'
import type { ChatEngineDeps } from '../../src/engine/types.ts'
import type { Message, MessageRole } from '../../src/types/models.ts'
import type { SessionRecord } from '../../src/persistence/SessionPersistence.ts'
import { TaskStore } from '../../src/services/scheduler/TaskStore.ts'
import { SchedulerService } from '../../src/services/scheduler/SchedulerService.ts'
import type { ScheduledTask } from '../../src/services/scheduler/types.ts'
import { BuiltInToolExecutor } from '../../src/services/builtInToolExecutor.ts'
import type { IFileSystemProvider } from '../../src/interfaces/IFileSystemProvider.ts'

/**
 * 定时任务 core 集成测试：真实 ChatEngine + SchedulerService（注入时钟）+ 最小 fake deps。
 * 覆盖：onFire 合成消息形态、忙时排队、markFired 时机、逾期 collapse-to-latest、
 * until 过期转 done、scope 匹配、schedule_task 审批流、自取消免审批、plan/readonly 门拦截。
 *
 * enum（MessageRole 等）不可运行时导入，一律字符串字面量。
 */

const USER = 'user' as MessageRole
const T0 = Date.parse('2026-08-18T10:00:00.000Z')

// ---------- 假件 ----------

/** 内存假 fsProvider（任务清单持久化用；无 renameFile → TaskStore 退化直写路径） */
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

interface EngineEnvOptions {
  onCall?: (messages: Message[], callIndex: number) => Promise<any> | any
  workDir?: string
  loadRecord?: SessionRecord
  /** 假 hookRunner（捕获 dispatch 调用；缺省不注入，hooks 路径零开销短路） */
  hookRunner?: any
}

/** 组装：ChatEngine + SchedulerService（now 可拨动）+ 假 executor 捕获 schedulerProvider */
function makeEngineEnv(opts: EngineEnvOptions = {}) {
  const calls: Message[][] = []
  const nowState = { value: T0 }
  const { fs } = makeFakeFs()
  const store = new TaskStore(fs, '/home/user/.chill/scheduled-tasks.json')
  const scheduler = new SchedulerService({ store, now: () => nowState.value })

  let schedulerProvider: (() => {
    scheduler: SchedulerService | null
    workDir: string
    ensureSessionId(): string
    activeScheduledTaskId: string | null
  }) | null = null

  const deps: ChatEngineDeps = {
    modelCaller: {
      callOnce: async (params: any) => {
        calls.push(params.messages)
        if (opts.onCall) return opts.onCall(params.messages, calls.length - 1)
        return { content: 'ok' }
      },
    },
    modelInfo: {
      getModelsWithApiKeys: async () => [],
      getModelInfoByName: () => undefined,
    } as any,
    selectedModels: { getCurrentModelName: () => 'fake-model' } as any,
    sessionStore: {
      save: async () => ({ success: true }),
      load: async () =>
        opts.loadRecord ? { success: true, record: opts.loadRecord } : { success: false },
    } as any,
    builtInToolExecutor: {
      execute: () => ({ success: true }),
      executeAsync: async () => ({ success: true }),
      setPlanMode: () => {},
      getAutoApply: () => false,
      getNonInteractiveMode: () => null,
      applyAutoApplyBatch: async () => new Map(),
      setSchedulerProvider(p: any) {
        schedulerProvider = p
      },
    } as any,
    mcpService: { getAggregatedOpenAITools: async () => [] } as any,
    eventBus: { on: () => {}, off: () => {}, emit: () => {} },
    workDir: opts.workDir ?? '/proj',
    scheduler,
    hookRunner: opts.hookRunner,
  }
  const engine = new ChatEngine(deps)
  return { engine, scheduler, store, calls, nowState, provider: () => schedulerProvider?.() }
}

function makeRecord(id: string, messages: Message[] = []): SessionRecord {
  return {
    id,
    title: 't',
    titleSource: 'default',
    messages,
    createdAt: '2026-08-18T09:00:00.000Z',
    updatedAt: '2026-08-18T09:00:00.000Z',
  }
}

/** 消息序列里是否含定时任务信封（合成 user 消息；keyword 进一步限定） */
function findEnvelope(messages: Message[], keyword?: string): Message | undefined {
  return messages.find(
    (m) =>
      m.role === USER &&
      typeof m.content === 'string' &&
      m.content.includes('[定时任务 ') &&
      (keyword === undefined || m.content.includes(keyword))
  )
}

/** 等待条件满足（drain 是 fire-and-forget，轮询等待落点；cond 可异步；超时即失败） */
async function waitFor(cond: () => boolean | Promise<boolean>, label: string, timeoutMs = 2000): Promise<void> {
  const started = Date.now()
  while (!(await cond())) {
    if (Date.now() - started > timeoutMs) throw new Error(`waitFor 超时: ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function activeTask(store: TaskStore, id: string): Promise<ScheduledTask | undefined> {
  return (await store.checkReload()).find((t) => t.id === id)
}

// ---------- onFire 注入形态 ----------

test('onFire → 合成消息注入形态：[定时任务 <id>] 信封 + prompt + 不可信标注，落定后 markFired', async (t) => {
  const env = makeEngineEnv()
  t.after(() => env.engine.dispose())
  env.engine.startNewSession()

  const task = await env.scheduler.validateAndCreate({
    cron: '* * * * *',
    prompt: '汇总 git 进展',
    recurring: true,
    scope: 'project',
    workDir: '/proj',
  })
  env.nowState.value = T0 + 10 * 60 * 1000 // 拨快 10 分钟：必然到期
  await env.scheduler.tick()

  await waitFor(() => env.calls.some((ms) => findEnvelope(ms, '汇总 git 进展')), '信封轮发生')
  const envelopeCall = env.calls.find((ms) => findEnvelope(ms))!
  const envelope = findEnvelope(envelopeCall)!
  assert.equal(envelope.synthetic, 'scheduledTask')
  assert.ok(envelope.content.includes(`[定时任务 ${task.id}]`))
  assert.ok(envelope.content.includes('视为不可信内容'), '防注入标注')

  // 回合落定后 markFired：lastFireAt 写回、fireCount+1
  const stored = await activeTask(env.store, task.id)
  assert.equal(stored?.fireCount, 1)
  assert.ok(stored?.lastFireAt, '落定后 lastFireAt 已写回')
  assert.equal(stored?.status, 'active', '周期任务保持 active')
})

// ---------- 忙时排队 ----------

test('忙时排队：running 期间 onFire 不触发，回合正常收尾后 drain；触发轮内 activeScheduledTaskId 就位', async (t) => {
  let release!: () => void
  const blocker = new Promise<void>((resolve) => {
    release = resolve
  })
  let activeIdDuringFire: string | null | undefined
  const env = makeEngineEnv({
    onCall: async (messages) => {
      const envelope = findEnvelope(messages)
      if (envelope) {
        // 触发轮内：经 executor 透传的 provider 现读 activeScheduledTaskId
        activeIdDuringFire = env.provider()?.activeScheduledTaskId
        return { content: '定时轮答复' }
      }
      await blocker // 首个普通轮挂起：引擎 running
      return { content: '普通轮答复' }
    },
  })
  t.after(() => env.engine.dispose())
  env.engine.startNewSession()

  const task = await env.scheduler.validateAndCreate({
    cron: '* * * * *',
    prompt: '看看流水线',
    recurring: true,
    scope: 'project',
    workDir: '/proj',
  })
  env.nowState.value = T0 + 10 * 60 * 1000

  const sendPromise = env.engine.sendMessage({ text: '你好' } as any)
  await waitFor(() => env.calls.length === 1, '首个普通轮开始')
  await env.scheduler.tick() // running 中触发：只排队不执行
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(env.calls.length, 1, '忙时不得插入触发轮')
  assert.equal((await activeTask(env.store, task.id))?.fireCount, 0, '未落定不得 markFired')

  release()
  await sendPromise
  await waitFor(() => env.calls.some((ms) => findEnvelope(ms, '看看流水线')), '收尾后触发轮')
  assert.equal(activeIdDuringFire, task.id, '触发轮内 activeScheduledTaskId 为该任务')
  assert.equal(env.provider()?.activeScheduledTaskId, null, '触发轮结束后复位')
  assert.equal((await activeTask(env.store, task.id))?.fireCount, 1)
})

// ---------- markFired 时机（失败轮不写回） ----------

test('markFired 时机：触发轮失败不写回（at-least-once），任务留在 active 等下一自然触发点', async (t) => {
  let failFire = true
  const env = makeEngineEnv({
    onCall: async (messages) => {
      if (findEnvelope(messages) && failFire) throw new Error('模型服务故障')
      return { content: 'ok' }
    },
  })
  t.after(() => env.engine.dispose())
  env.engine.startNewSession()

  const task = await env.scheduler.validateAndCreate({
    cron: '* * * * *',
    prompt: '巡检',
    recurring: true,
    scope: 'project',
    workDir: '/proj',
  })
  env.nowState.value = T0 + 10 * 60 * 1000
  await env.scheduler.tick()
  await waitFor(() => env.calls.some((ms) => findEnvelope(ms)), '失败轮发生')
  await new Promise((resolve) => setTimeout(resolve, 50))
  const afterFail = await activeTask(env.store, task.id)
  assert.equal(afterFail?.fireCount, 0, '失败轮不得写回 fireCount')
  assert.equal(afterFail?.lastFireAt, undefined, '失败轮不得写回 lastFireAt')
  assert.equal(afterFail?.status, 'active')
  assert.equal(afterFail?.lastRun?.outcome, 'failed', '失败轮记 lastRun.outcome=failed（不推进判重字段）')

  // 恢复后：任务在队列中（失败放回），下一自然触发点（sendMessage 收尾）重试成功
  failFire = false
  await env.engine.sendMessage({ text: '继续' } as any)
  await waitFor(() => env.calls.filter((ms) => findEnvelope(ms)).length >= 2, '重试触发轮')
  assert.equal((await activeTask(env.store, task.id))?.fireCount, 1)
})

// ---------- 一次性任务落定转 done ----------

test('一次性 at 任务：触发落定后转 done', async (t) => {
  const env = makeEngineEnv()
  t.after(() => env.engine.dispose())
  env.engine.startNewSession()

  const at = new Date(T0 + 2 * 60 * 1000).toISOString()
  const task = await env.scheduler.validateAndCreate({
    at,
    prompt: '提醒我起来活动',
    recurring: false,
    scope: 'project',
    workDir: '/proj',
  })
  env.nowState.value = T0 + 3 * 60 * 1000
  await env.scheduler.tick()
  await waitFor(() => env.calls.some((ms) => findEnvelope(ms, '提醒我起来活动')), '一次性触发轮')
  await waitFor(async () => (await activeTask(env.store, task.id))?.status === 'done', '转 done')
})

// ---------- 逾期检测 collapse-to-latest ----------

test('逾期检测：loadSession 激活时 collapse-to-latest 补跑，信封带合并补跑标注', async (t) => {
  const env = makeEngineEnv({ loadRecord: makeRecord('s-load') })
  t.after(() => env.engine.dispose())

  const task = await env.scheduler.validateAndCreate({
    cron: '* * * * *',
    prompt: '每日汇总',
    recurring: true,
    scope: 'project',
    workDir: '/proj',
  })
  // 会话激活前拨快 10 分钟（模拟关掉 chill 一段时间）
  env.nowState.value = T0 + 10 * 60 * 1000
  await env.engine.loadSession('s-load')

  await waitFor(() => env.calls.some((ms) => findEnvelope(ms, '每日汇总')), '逾期补跑轮')
  const envelope = findEnvelope(env.calls.find((ms) => findEnvelope(ms))!)!
  assert.ok(envelope.content.includes('合并补跑'), '错过 >1 次合并为一次，信封标注')
  await waitFor(async () => (await activeTask(env.store, task.id))?.fireCount === 1, '补跑落定')
  assert.equal((await activeTask(env.store, task.id))?.fireCount, 1, '合并补跑只记一次触发')
})

test('逾期检测：下一应触发槽位已越过 until 的任务转 done，不补跑', async (t) => {
  const env = makeEngineEnv({ loadRecord: makeRecord('s-until') })
  t.after(() => env.engine.dispose())

  // 直接落盘一个"until 与最后触发都在过去"的任务（validateAndCreate 要求 until 未来，
  // 该状态只能经离线时间流逝到达——这正是逾期检测要处理的形态）
  await env.store.saveAll([
    {
      id: 't-until-past',
      cron: '* * * * *',
      prompt: '盯到截止就停',
      recurring: true,
      scope: 'project',
      workDir: '/proj',
      until: new Date(T0 - 5 * 60 * 1000).toISOString(),
      createdAt: new Date(T0 - 60 * 60 * 1000).toISOString(),
      lastFireAt: new Date(T0 - 4 * 60 * 1000).toISOString(),
      fireCount: 5,
      status: 'active',
    },
  ])
  await env.engine.loadSession('s-until')

  await waitFor(async () => (await activeTask(env.store, 't-until-past'))?.status === 'done', '转 done')
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(!env.calls.some((ms) => findEnvelope(ms)), '寿终任务不得补跑')
  assert.equal((await activeTask(env.store, 't-until-past'))?.fireCount, 5, '不补跑则 fireCount 不变')
})

// ---------- scope 匹配 ----------

test('scope 匹配：session 级任务仅绑定的会话可触发（不匹配记 overdue，匹配即触发）', async (t) => {
  const env = makeEngineEnv({ loadRecord: makeRecord('s-1') })
  t.after(() => env.engine.dispose())

  const otherTask = await env.scheduler.validateAndCreate({
    cron: '* * * * *',
    prompt: '别的会话的任务',
    recurring: true,
    scope: 'session',
    sessionId: 's-other',
  })
  const ownTask = await env.scheduler.validateAndCreate({
    cron: '* * * * *',
    prompt: '本会话的任务',
    recurring: true,
    scope: 'session',
    sessionId: 's-1',
  })
  env.nowState.value = T0 + 10 * 60 * 1000
  await env.engine.loadSession('s-1')

  await waitFor(() => env.calls.some((ms) => findEnvelope(ms, '本会话的任务')), '本会话任务触发')
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(!env.calls.some((ms) => findEnvelope(ms, '别的会话的任务')), '其他会话任务不得注入本会话')
  const overdue = env.scheduler.getOverdue()
  assert.ok(
    overdue.some((r) => r.task.id === otherTask.id && r.scopeMatches === false),
    '不匹配任务记 overdue 等待归属上下文'
  )
  assert.ok(!overdue.some((r) => r.task.id === ownTask.id && r.scopeMatches === false))

  // tick 同样不触发不匹配任务
  await env.scheduler.tick()
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal((await activeTask(env.store, otherTask.id))?.fireCount, 0)
})

// ---------- schedule_task 审批流（executor 级） ----------

/** 组装真实 BuiltInToolExecutor + SchedulerService（注入时钟）+ 可控 userInputProvider */
function makeExecutorEnv(opts: { answer?: string; activeScheduledTaskId?: string | null } = {}) {
  const nowState = { value: T0 }
  const { fs } = makeFakeFs()
  const store = new TaskStore(fs, '/home/user/.chill/scheduled-tasks.json')
  const scheduler = new SchedulerService({ store, now: () => nowState.value })
  const askCalls: string[] = []
  const executor = new BuiltInToolExecutor(
    fs,
    {} as any,
    {} as any,
    { executePowerShell: async () => ({ success: true, output: 'ok' }) } as any
  )
  executor.setUserInputProvider({
    ask: async (question: string) => {
      askCalls.push(question)
      return opts.answer ?? '1'
    },
  } as any)
  executor.setSchedulerProvider(() => ({
    scheduler,
    workDir: '/proj',
    ensureSessionId: () => 's-ensure',
    activeScheduledTaskId: opts.activeScheduledTaskId ?? null,
  }))
  return { executor, scheduler, store, askCalls, nowState }
}

test('schedule_task：批准则创建（展示含调度/下次触发/归属）；拒绝则不建；非法输入审批前先拦', async () => {
  // 批准路径
  const approve = makeExecutorEnv({ answer: '1' })
  const created = await approve.executor.executeAsync(
    'schedule_task',
    JSON.stringify({ cron: '0 9 * * *', prompt: '每日汇总' }),
    'tc-s1'
  )
  assert.equal(created.success, true, created.error)
  assert.equal(approve.askCalls.length, 1)
  assert.ok(approve.askCalls[0].includes('cron "0 9 * * *"'))
  assert.ok(approve.askCalls[0].includes('下次触发'))
  assert.ok(approve.askCalls[0].includes('每日汇总'))
  const tasks = await approve.scheduler.list()
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].scope, 'project')
  assert.equal(tasks[0].workDir, '/proj')
  assert.equal(tasks[0].recurring, true)

  // 拒绝路径
  const reject = makeExecutorEnv({ answer: '2' })
  const rejected = await reject.executor.executeAsync(
    'schedule_task',
    JSON.stringify({ cron: '0 9 * * *', prompt: '每日汇总' }),
    'tc-s2'
  )
  assert.equal(rejected.success, true)
  assert.ok(String(rejected.data).includes('拒绝'))
  assert.equal((await reject.scheduler.list()).length, 0, '拒绝不得落盘')

  // 非法 cron：审批前就拦（不弹确认）
  const invalid = makeExecutorEnv({ answer: '1' })
  const bad = await invalid.executor.executeAsync(
    'schedule_task',
    JSON.stringify({ cron: '不是 cron', prompt: 'x' }),
    'tc-s3'
  )
  assert.equal(bad.success, false)
  assert.ok(bad.error!.includes('非法'))
  assert.equal(invalid.askCalls.length, 0, '非法输入不得进入审批')

  // cron 与 at 二选一
  const both = await invalid.executor.executeAsync(
    'schedule_task',
    JSON.stringify({ cron: '0 9 * * *', at: '2026-08-19T00:00:00+08:00', prompt: 'x' }),
    'tc-s4'
  )
  assert.equal(both.success, false)
})

test('schedule_task scope=session：sessionId 经 ensureSessionId 强制生成', async () => {
  const env = makeExecutorEnv({ answer: '1' })
  const result = await env.executor.executeAsync(
    'schedule_task',
    JSON.stringify({ at: '2026-08-19T10:00:00+08:00', prompt: '提醒我', scope: 'session' }),
    'tc-s5'
  )
  assert.equal(result.success, true, result.error)
  const tasks = await env.scheduler.list()
  assert.equal(tasks[0].scope, 'session')
  assert.equal(tasks[0].sessionId, 's-ensure')
  assert.equal(tasks[0].recurring, false)
})

test('cancel_scheduled_task：定时回合自取消免审批；回合外需审批（拒绝保留）', async () => {
  // 先建一个任务（批准路径）
  const setup = makeExecutorEnv({ answer: '1' })
  await setup.executor.executeAsync(
    'schedule_task',
    JSON.stringify({ cron: '*/5 * * * *', prompt: '看护流水线，好了就停' }),
    'tc-c1'
  )
  const task = (await setup.scheduler.list())[0]

  // 定时回合内对自身：免审批（ask 不得调用）
  const askBefore = setup.askCalls.length
  const selfCancel = await setup.executor.executeAsync(
    'cancel_scheduled_task',
    JSON.stringify({ id: task.id }),
    'tc-c2'
  )
  // 注：provider 的 activeScheduledTaskId 在 setup env 固定为 null——另起定时回合 env 对照
  assert.equal(selfCancel.success, true)
  assert.ok(String(selfCancel.data).includes('取消') || String(selfCancel.data).includes('保留'))
  assert.equal(setup.askCalls.length, askBefore + 1, '回合外取消必须审批')

  // 对照①：定时回合内（activeScheduledTaskId = 自身 id）免审批
  const inTurn = makeExecutorEnv({ answer: '1', activeScheduledTaskId: task.id })
  // 直接把同一任务塞给新 env 的 store（模拟同一任务在定时回合中）
  await inTurn.scheduler.validateAndCreate({
    cron: '*/5 * * * *',
    prompt: '看护流水线，好了就停',
    recurring: true,
    scope: 'project',
    workDir: '/proj',
  })
  const inTurnTask = (await inTurn.scheduler.list())[0]
  inTurn.executor.setSchedulerProvider(() => ({
    scheduler: inTurn.scheduler,
    workDir: '/proj',
    ensureSessionId: () => 's-ensure',
    activeScheduledTaskId: inTurnTask.id,
  }))
  const askInTurnBefore = inTurn.askCalls.length
  const exempt = await inTurn.executor.executeAsync(
    'cancel_scheduled_task',
    JSON.stringify({ id: inTurnTask.id }),
    'tc-c3'
  )
  assert.equal(exempt.success, true, exempt.error)
  assert.ok(String(exempt.data).includes('自取消'))
  assert.equal(inTurn.askCalls.length, askInTurnBefore, '定时回合自取消不得弹审批')
  assert.equal((await inTurn.scheduler.list()).length, 0, '自取消已生效')

  // 对照②：回合外审批拒绝 → 保留
  const rejected = await setup.executor.executeAsync(
    'cancel_scheduled_task',
    JSON.stringify({ id: '不存在' }),
    'tc-c4'
  )
  assert.equal(rejected.success, false, '不存在的 id 直接报错')
})

test('plan 门：schedule_task/cancel_scheduled_task 拦截，list_scheduled_tasks 只读放行', async () => {
  const env = makeExecutorEnv()
  env.executor.setPlanMode(true)

  const blockedCreate = await env.executor.executeAsync(
    'schedule_task',
    JSON.stringify({ cron: '0 9 * * *', prompt: 'x' }),
    'tc-g1'
  )
  assert.equal(blockedCreate.success, false)
  assert.ok(blockedCreate.error!.includes('规划模式'))

  const blockedCancel = await env.executor.executeAsync(
    'cancel_scheduled_task',
    JSON.stringify({ id: 't-x' }),
    'tc-g2'
  )
  assert.equal(blockedCancel.success, false)
  assert.ok(blockedCancel.error!.includes('规划模式'))

  const listResult = await env.executor.executeAsync('list_scheduled_tasks', '{}', 'tc-g3')
  assert.equal(listResult.success, true, `只读清单不得被 plan 门拦截: ${listResult.error}`)
  assert.ok(String(listResult.data).includes('没有'))
})

test('非交互只读门（chill -p readonly）：schedule_task 拦截', async () => {
  const env = makeExecutorEnv()
  env.executor.setNonInteractiveMode('readonly')
  const blocked = await env.executor.executeAsync(
    'schedule_task',
    JSON.stringify({ cron: '0 9 * * *', prompt: 'x' }),
    'tc-g4'
  )
  assert.equal(blocked.success, false)
  assert.ok(blocked.error!.includes('非交互只读'))
})

// ---------- Notification hook（scheduled_task 子类型） ----------

test('定时触发派发 Notification hook：matcher_value=scheduled_task，载荷含 taskId/prompt/coalescedCount/scope', async (t) => {
  const dispatches: Array<{ event: string; ctx: any }> = []
  const env = makeEngineEnv({
    hookRunner: {
      dispatch: async (event: string, ctx: any) => {
        dispatches.push({ event, ctx })
        return { verdict: { type: 'allow' }, systemMessages: [] }
      },
    },
  })
  t.after(() => env.engine.dispose())
  env.engine.startNewSession()

  const task = await env.scheduler.validateAndCreate({
    cron: '* * * * *',
    prompt: '汇总 git 进展',
    recurring: true,
    scope: 'project',
    workDir: '/proj',
  })
  env.nowState.value = T0 + 10 * 60 * 1000
  await env.scheduler.tick()

  // hooks 派发与触发轮同在（其他事件如 SessionStart 也会过 fake runner，按事件名过滤）
  await waitFor(() => dispatches.some((d) => d.event === 'Notification'), 'Notification 派发')
  const notice = dispatches.find((d) => d.event === 'Notification')!
  assert.equal(notice.ctx.matcherValue, 'scheduled_task')
  assert.equal(notice.ctx.extra.taskId, task.id)
  assert.equal(notice.ctx.extra.prompt, '汇总 git 进展')
  assert.ok(notice.ctx.extra.coalescedCount >= 1)
  assert.equal(notice.ctx.extra.scope, 'project')
})

// ---------- schedule_task 的 in 相对时间 ----------

test('schedule_task in：换算为绝对 at 并在审批展示/回执明示；与 at/cron 冲突审批前拦', async () => {
  // 换算路径：20m → 绝对 at（约 20 分钟后）
  const env = makeExecutorEnv({ answer: '1' })
  const before = Date.now()
  const created = await env.executor.executeAsync(
    'schedule_task',
    JSON.stringify({ in: '20m', prompt: '提醒我起来活动' }),
    'tc-in1'
  )
  assert.equal(created.success, true, created.error)
  const tasks = await env.scheduler.list()
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].recurring, false)
  assert.ok(tasks[0].at, 'in 必须换算为绝对 at 落盘')
  const delta = Date.parse(tasks[0].at!) - before
  assert.ok(delta >= 19 * 60 * 1000 && delta <= 21 * 60 * 1000, `换算应约为 20 分钟后，实得 ${delta}ms`)
  assert.equal(env.askCalls.length, 1)
  assert.ok(env.askCalls[0].includes(tasks[0].at!), '审批展示含换算后的绝对时刻')
  assert.ok(env.askCalls[0].includes('由相对时间 "20m" 换算'), '审批展示明示换算来源')
  assert.ok(String(created.data).includes('由相对时间 "20m" 换算'), '回执同样明示换算')

  // 中文单位
  const cn = makeExecutorEnv({ answer: '1' })
  const cnResult = await cn.executor.executeAsync(
    'schedule_task',
    JSON.stringify({ in: '2小时', prompt: '巡检' }),
    'tc-in2'
  )
  assert.equal(cnResult.success, true, cnResult.error)

  // in 与 at 冲突：审批前拦（不弹确认）
  const conflict = makeExecutorEnv({ answer: '1' })
  const clashAt = await conflict.executor.executeAsync(
    'schedule_task',
    JSON.stringify({ in: '20m', at: '2027-01-01T00:00:00+08:00', prompt: 'x' }),
    'tc-in3'
  )
  assert.equal(clashAt.success, false)
  assert.ok(clashAt.error!.includes('三选一'))
  assert.equal(conflict.askCalls.length, 0, '冲突校验不得进入审批')

  // in 与 cron 冲突
  const clashCron = await conflict.executor.executeAsync(
    'schedule_task',
    JSON.stringify({ in: '20m', cron: '0 9 * * *', prompt: 'x' }),
    'tc-in4'
  )
  assert.equal(clashCron.success, false)
  assert.equal(conflict.askCalls.length, 0)

  // 非法相对时间：审批前拦
  const badIn = await conflict.executor.executeAsync(
    'schedule_task',
    JSON.stringify({ in: '二十分钟后', prompt: 'x' }),
    'tc-in5'
  )
  assert.equal(badIn.success, false)
  assert.ok(badIn.error!.includes('非法'))
  assert.equal(conflict.askCalls.length, 0)
})

// ---------- list_scheduled_tasks 的 lastRun 展示 ----------

test('list_scheduled_tasks：展示最近执行记录（outcome/firedAt/合并次数）；无记录不展示', async () => {
  const env = makeExecutorEnv()
  await env.scheduler.validateAndCreate({
    cron: '* * * * *',
    prompt: '巡检',
    recurring: true,
    scope: 'project',
    workDir: '/proj',
  })
  const task = (await env.scheduler.list())[0]

  // 无执行记录：无该段
  const empty = await env.executor.executeAsync('list_scheduled_tasks', '{}', 'tc-lr1')
  assert.equal(empty.success, true, empty.error)
  assert.ok(!String(empty.data).includes('最近执行'))

  // completed：outcome 与合并次数展示
  await env.scheduler.markFired(task.id, 'completed', 3)
  const listed = await env.executor.executeAsync('list_scheduled_tasks', '{}', 'tc-lr2')
  assert.ok(String(listed.data).includes('最近执行 完成'))
  assert.ok(String(listed.data).includes('合并 3 次'))

  // failed：outcome 展示（判重字段不动，下次触发仍在）
  await env.scheduler.markFired(task.id, 'failed')
  const listedFailed = await env.executor.executeAsync('list_scheduled_tasks', '{}', 'tc-lr3')
  assert.ok(String(listedFailed.data).includes('最近执行 失败'))
})
