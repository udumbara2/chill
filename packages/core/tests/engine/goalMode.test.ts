import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ChatEngine } from '../../src/engine/ChatEngine.ts'
import { parseGoalVerdict } from '../../src/engine/GoalEvaluator.ts'
import type { ChatEngineDeps } from '../../src/engine/types.ts'
import type { Message } from '../../src/types/models.ts'
import { BuiltInToolExecutor } from '../../src/services/builtInToolExecutor.ts'
import { eventBus, EVENTS } from '../../src/utils/eventBus.ts'
import {
  setGoalsDirOverride,
  saveCurrentGoal,
  readCurrentGoal,
  archiveCurrentGoal,
  clearCurrentGoal,
  getCurrentGoalPath,
} from '../../src/services/goalPersistence.ts'

/**
 * 目标模式（迭代 1）冒烟测试：真实 ChatEngine + 最小 fake deps（模式同 syntheticLanding.test.ts）。
 * 覆盖：达成自动停 / 轮次超限停 / 连续无进展熔断 / 用户中断不续跑 / 失败轮计熔断 /
 *       会话切换清目标 / plan 模式挂起 / 契约注入 / parseGoalVerdict 兜底。
 *
 * 假 modelCaller 按调用形态区分三种调用：
 * - 评估器调用：首条为 system 且含"独立评估器" → 返回 onEvaluate 指定的判定 JSON；
 * - 对话轮：末条消息含"【目标推进"的为 goalTick 轮 → 走 onTickTurn，否则普通用户轮返回 { content:'ok' }；
 * - 其余（首轮自动标题等辅助调用）→ 返回 { content:'ok' }。
 */

interface EmittedEvent { event: string; payload: any }

interface MakeDepsOptions {
  onEvaluate?: (callIndex: number) => string
  onTickTurn?: (tickIndex: number) => Promise<any> | any
  evaluatorModelName?: string
  /** 熔断请示的用户应答（'1'=追加预算 / '2'=修改目标 / '3'=放弃；缺省=无应答通道，退回发事件+清除） */
  askAnswer?: string
  /** 传入则注入 goalStore 并记录全部落盘调用（save/archive/clear） */
  goalStoreCalls?: Array<{ op: string; state?: any }>
}

function makeDeps(options: MakeDepsOptions = {}) {
  let evalCalls = 0
  let tickTurns = 0
  const conversationCalls: Message[][] = []
  const events: EmittedEvent[] = []
  const deps: ChatEngineDeps = {
    modelCaller: {
      callOnce: async (params: any) => {
        const msgs: Message[] = params.messages
        const first = msgs[0]
        if (msgs.length === 2 && first?.role === 'system' && typeof first.content === 'string' && first.content.includes('独立评估器')) {
          evalCalls++
          return { content: options.onEvaluate ? options.onEvaluate(evalCalls) : '{"verdict":"continue","progress":true,"reason":"默认继续"}' }
        }
        conversationCalls.push(msgs)
        const last = msgs[msgs.length - 1]
        const lastText = typeof last?.content === 'string' ? last.content : ''
        if (lastText.includes('【目标推进')) {
          tickTurns++
          if (options.onTickTurn) return options.onTickTurn(tickTurns)
          return { content: 'ok' }
        }
        return { content: 'ok' }
      },
    },
    modelInfo: {
      getModelsWithApiKeys: async () => [],
      getModelInfoByName: (name: string) => (name === options.evaluatorModelName ? { name } : undefined),
    } as any,
    selectedModels: { getCurrentModelName: () => 'fake-model' } as any,
    sessionStore: {
      save: async () => ({ success: true }),
      load: async () => ({ success: false }),
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
    eventBus: { on: () => {}, off: () => {}, emit: (event: string, payload: any) => events.push({ event, payload }) },
    getEvaluatorModelName: options.evaluatorModelName ? () => options.evaluatorModelName : undefined,
    getTaskStatusSummary: () => '',
    ...(options.askAnswer !== undefined
      ? { getUserInputProvider: () => ({ ask: async () => options.askAnswer! }) }
      : {}),
    ...(options.goalStoreCalls
      ? {
          goalStore: {
            save: (s: any) => options.goalStoreCalls!.push({ op: 'save', state: { ...s } }),
            archive: (s: any) => options.goalStoreCalls!.push({ op: 'archive', state: { ...s } }),
            clear: () => options.goalStoreCalls!.push({ op: 'clear' }),
          },
        }
      : {}),
  }
  return { deps, events, conversationCalls, stats: () => ({ evalCalls, tickTurns }) }
}

function abortError(): Error {
  const err = new Error('Request aborted')
  err.name = 'AbortError'
  return err
}

test('达成自动停：评估 achieved → GOAL_ACHIEVED + 目标清除，不发 goalTick', async () => {
  const { deps, events, stats } = makeDeps({
    onEvaluate: () => '{"verdict":"achieved","progress":true,"reason":"文件已存在，证据确凿"}',
  })
  const engine = new ChatEngine(deps)
  engine.setGoal('创建文件 x.txt 并确认存在')
  assert.ok(engine.isGoalMode())
  assert.deepEqual(events.map((e) => e.event), ['goal-started'])

  await engine.sendMessage({ text: '开始吧' })

  assert.ok(!engine.isGoalMode(), '达成后应退出目标模式')
  assert.equal(stats().tickTurns, 0, '达成时不应发出 goalTick 轮')
  const kinds = events.map((e) => e.event)
  assert.ok(kinds.includes('goal-achieved'), '应发 GOAL_ACHIEVED')
  assert.ok(kinds.includes('goal-cleared'), '达成后应发 GOAL_CLEARED')
  assert.equal(events.find((e) => e.event === 'goal-achieved')?.payload?.reason, '文件已存在，证据确凿')
  engine.dispose()
})

test('轮次超限停：maxRounds=2 且持续 continue → GOAL_BUDGET_EXHAUSTED + 目标清除', async () => {
  const { deps, events, stats } = makeDeps({
    onEvaluate: () => '{"verdict":"continue","progress":true,"reason":"有进展但未完成"}',
  })
  const engine = new ChatEngine(deps)
  engine.setGoal('永远做不完的事', undefined, 2)

  await engine.sendMessage({ text: '开始吧' })

  assert.equal(stats().tickTurns, 2, '应推进 2 轮后触顶')
  assert.equal(stats().evalCalls, 3, '每轮推进前各评估一次（含首轮）')
  assert.ok(!engine.isGoalMode())
  const exhausted = events.find((e) => e.event === 'goal-budget-exhausted')
  assert.ok(exhausted, '应发 GOAL_BUDGET_EXHAUSTED')
  assert.match(exhausted!.payload.reason, /轮次上限 2/)
  // goalTick 消息带 synthetic 标记并入史
  const ticks = engine.getHistory().filter((m) => m.synthetic === 'goalTick')
  assert.equal(ticks.length, 2)
  assert.match(String(ticks[0].content), /第 1\/2 轮/)
  engine.dispose()
})

test('连续无进展熔断：评估 progress=false 满 3 次 → GOAL_BUDGET_EXHAUSTED + 目标清除', async () => {
  const { deps, events, stats } = makeDeps({
    onEvaluate: () => '{"verdict":"continue","progress":false,"reason":"没有新证据"}',
  })
  const engine = new ChatEngine(deps)
  engine.setGoal('某目标', undefined, 20)

  await engine.sendMessage({ text: '开始吧' })

  assert.equal(stats().tickTurns, 2, '第 3 次无进展判定后直接熔断，不再发第 3 个 tick')
  assert.ok(!engine.isGoalMode())
  const exhausted = events.find((e) => e.event === 'goal-budget-exhausted')
  assert.match(exhausted!.payload.reason, /连续 3 轮无实质进展/)
  engine.dispose()
})

test('用户中断即停：goalTick 轮被 abort → 循环停、不计熔断、目标保留', async () => {
  const { deps, events, stats } = makeDeps({
    onEvaluate: () => '{"verdict":"continue","progress":true,"reason":"继续"}',
    onTickTurn: () => { throw abortError() },
  })
  const engine = new ChatEngine(deps)
  engine.setGoal('某目标')

  await engine.sendMessage({ text: '开始吧' })

  assert.ok(engine.isGoalMode(), '中断后目标应保留（等用户下一句话）')
  assert.equal(stats().tickTurns, 1, '中断的轮之后不得自动续跑')
  assert.ok(!events.some((e) => e.event === 'goal-budget-exhausted'), '中断不计熔断')
  const goal = engine.getGoalState()!
  assert.equal(goal.roundCount, 1)
  assert.equal(goal.noProgressCount, 0, '用户中断不按无进展计')
  engine.dispose()
})

test('失败轮计熔断：goalTick 轮抛异常按无进展计，满 3 次熔断退出，绝不静默重试', async () => {
  const { deps, events, stats } = makeDeps({
    onEvaluate: () => '{"verdict":"continue","progress":true,"reason":"继续"}',
    onTickTurn: () => { throw new Error('API 500') },
  })
  const engine = new ChatEngine(deps)
  engine.setGoal('某目标')

  // 每次失败轮后循环停止（不静默重试），等下一个自然触发点（下一次 sendMessage 收尾）
  await engine.sendMessage({ text: '第一句' })
  assert.ok(engine.isGoalMode())
  assert.equal(engine.getGoalState()!.noProgressCount, 1)
  assert.equal(stats().tickTurns, 1, '失败后本轮循环应立即停止')

  await engine.sendMessage({ text: '第二句' })
  assert.equal(engine.getGoalState()!.noProgressCount, 2)

  await engine.sendMessage({ text: '第三句' })
  assert.ok(!engine.isGoalMode(), '第 3 次失败应熔断退出')
  const exhausted = events.find((e) => e.event === 'goal-budget-exhausted')
  assert.match(exhausted!.payload.reason, /连续 3 轮无实质进展（含失败轮）/)
  engine.dispose()
})

test('目标随会话：startNewSession 清除目标并发 GOAL_CLEARED', async () => {
  const { deps, events } = makeDeps()
  const engine = new ChatEngine(deps)
  engine.setGoal('某目标')
  assert.ok(engine.isGoalMode())

  engine.startNewSession()

  assert.ok(!engine.isGoalMode())
  assert.equal(engine.getSessionState().goalMode, undefined)
  const cleared = events.find((e) => e.event === 'goal-cleared')
  assert.equal(cleared?.payload?.reason, '会话切换')
  engine.dispose()
})

test('plan 模式激活期间目标循环挂起：不评估、不推进；退出 plan 后恢复', async () => {
  const { deps, stats } = makeDeps({
    onEvaluate: () => '{"verdict":"continue","progress":true,"reason":"继续"}',
  })
  const engine = new ChatEngine(deps)
  engine.setGoal('某目标', undefined, 5)
  engine.setPlanMode(true)

  await engine.sendMessage({ text: 'plan 下讨论' })
  assert.equal(stats().evalCalls, 0, 'plan 激活期间不得评估')
  assert.equal(stats().tickTurns, 0)

  engine.setPlanMode(false)
  await engine.sendMessage({ text: 'plan 结束，继续推进' })
  assert.ok(stats().evalCalls > 0, '退出 plan 后目标循环应恢复')
  engine.dispose()
})

test('契约注入：目标激活时对话轮上下文含 GOAL 契约与目标/判据文本', async () => {
  const { deps, conversationCalls } = makeDeps({
    onEvaluate: () => '{"verdict":"achieved","progress":true,"reason":"done"}',
  })
  const engine = new ChatEngine(deps)
  engine.setGoal('把登录模块重构为 JWT 认证', 'npm test 退出码为 0')

  await engine.sendMessage({ text: '开始吧' })

  const firstTurn = conversationCalls[0]
  const sysTexts = firstTurn.filter((m) => m.role === 'system').map((m) => String(m.content))
  assert.ok(sysTexts.some((t) => t.includes('【目标模式】')), '应注入目标模式契约')
  assert.ok(sysTexts.some((t) => t.includes('把登录模块重构为 JWT 认证') && t.includes('npm test 退出码为 0')), '契约应携带目标与判据')
  engine.dispose()
})

test('评估器模型选择：配置的已注册模型优先，未配置/未注册回退会话模型', async () => {
  const seenModels: string[] = []
  const base = makeDeps({
    onEvaluate: () => '{"verdict":"achieved","progress":true,"reason":"done"}',
    evaluatorModelName: 'cheap-eval-model',
  })
  const origCall = base.deps.modelCaller.callOnce
  base.deps.modelCaller.callOnce = async (params: any) => {
    const msgs: Message[] = params.messages
    if (msgs.length === 2 && String(msgs[0]?.content ?? '').includes('独立评估器')) seenModels.push(params.modelName)
    return origCall(params)
  }
  const engine = new ChatEngine(base.deps)
  engine.setGoal('某目标')
  await engine.sendMessage({ text: '开始吧' })
  assert.deepEqual(seenModels, ['cheap-eval-model'])
  engine.dispose()

  // 未配置 → 回退会话模型
  const base2 = makeDeps({ onEvaluate: () => '{"verdict":"achieved","progress":true,"reason":"done"}' })
  const seen2: string[] = []
  const orig2 = base2.deps.modelCaller.callOnce
  base2.deps.modelCaller.callOnce = async (params: any) => {
    const msgs: Message[] = params.messages
    if (msgs.length === 2 && String(msgs[0]?.content ?? '').includes('独立评估器')) seen2.push(params.modelName)
    return orig2(params)
  }
  const engine2 = new ChatEngine(base2.deps)
  engine2.setGoal('某目标')
  await engine2.sendMessage({ text: '开始吧' })
  assert.deepEqual(seen2, ['fake-model'])
  engine2.dispose()
})

test('parseGoalVerdict：合法 JSON 解析；噪声/非法输入按 continue+无进展兜底', () => {
  assert.deepEqual(parseGoalVerdict('{"verdict":"achieved","progress":true,"reason":"好"}'), {
    verdict: 'achieved', progress: true, reason: '好',
  })
  // 允许 JSON 前后有噪声文字（提取首个 JSON 对象）
  assert.equal(parseGoalVerdict('我认为：\n{"verdict":"blocked","progress":false,"reason":"缺权限"}').verdict, 'blocked')
  const bad = parseGoalVerdict('完全不是 JSON')
  assert.equal(bad.verdict, 'continue')
  assert.equal(bad.progress, false)
  const illegal = parseGoalVerdict('{"verdict":"maybe","progress":true}')
  assert.equal(illegal.verdict, 'continue')
  assert.equal(illegal.progress, false)
})

test('评估器异常按 continue+无进展处理（不抛错、计入熔断计数）', async () => {
  const { deps, events } = makeDeps()
  // 覆盖：评估器调用直接 reject（本地计数——stats() 的计数器绑定的是替换前的 callOnce）
  let evalCalls = 0
  let tickTurns = 0
  deps.modelCaller.callOnce = async (params: any) => {
    const msgs: Message[] = params.messages
    if (msgs.length === 2 && String(msgs[0]?.content ?? '').includes('独立评估器')) {
      evalCalls++
      throw new Error('网络超时')
    }
    const last = msgs[msgs.length - 1]
    if (typeof last?.content === 'string' && last.content.includes('【目标推进')) tickTurns++
    return { content: 'ok' }
  }
  const engine = new ChatEngine(deps)
  engine.setGoal('某目标', undefined, 20)

  // 评估失败不抛错、不打断循环：每个推进轮成功后再次评估仍失败，同一触发点内连计 3 次无进展即熔断
  await engine.sendMessage({ text: '第一句' })
  assert.equal(evalCalls, 3, '评估器每轮推进前各调用一次，连续失败 3 次')
  assert.equal(tickTurns, 2, '第 3 次无进展判定后熔断，不再发第 3 个 tick')
  assert.ok(!engine.isGoalMode(), '连续 3 次评估失败应熔断退出')
  const exhausted = events.find((e) => e.event === 'goal-budget-exhausted')
  assert.match(exhausted!.payload.reason, /连续 3 轮无实质进展/)
  engine.dispose()
})

// ==================== 迭代 2：熔断请示 / pause-resume / 落盘归档 / goal 工具 ====================

test('熔断请示-追加预算：暂停→用户选 1→上限 +10、无进展清零、恢复续跑，达成后退出', async () => {
  const { deps, events, stats } = makeDeps({
    askAnswer: '1',
    onEvaluate: (i) =>
      i <= 3
        ? '{"verdict":"continue","progress":false,"reason":"没有新证据"}'
        : '{"verdict":"achieved","progress":true,"reason":"证据齐全"}',
  })
  const engine = new ChatEngine(deps)
  engine.setGoal('某目标', undefined, 20)

  await engine.sendMessage({ text: '开始吧' })

  const kinds = events.map((e) => e.event)
  assert.ok(kinds.includes('goal-budget-exhausted'), '熔断应先发预算耗尽通知')
  assert.equal(events.find((e) => e.event === 'goal-budget-exhausted')?.payload?.paused, true)
  assert.ok(kinds.includes('goal-resumed'), '追加预算后应发恢复事件')
  assert.ok(kinds.includes('goal-achieved'), '续跑后评估达成应发 GOAL_ACHIEVED')
  assert.ok(!engine.isGoalMode())
  assert.equal(stats().evalCalls, 4, '3 次无进展 + 追加预算后再评估 1 次')
  engine.dispose()
})

test('熔断请示-修改目标：暂停保持 paused，循环停止；/goal resume 后恢复推进', async () => {
  const { deps, events, stats } = makeDeps({
    askAnswer: '2',
    onEvaluate: (i) =>
      i <= 3
        ? '{"verdict":"continue","progress":false,"reason":"没有新证据"}'
        : '{"verdict":"achieved","progress":true,"reason":"完成"}',
  })
  const engine = new ChatEngine(deps)
  engine.setGoal('某目标')

  await engine.sendMessage({ text: '开始吧' })

  assert.ok(engine.isGoalMode(), '选修改目标后目标保留')
  assert.equal(engine.getGoalState()!.status, 'paused', '应保持暂停等用户修改')
  assert.equal(stats().evalCalls, 3, '暂停后不得继续评估')

  // 模拟用户改完目标后 /goal resume：引擎空闲立即恢复推进
  await engine.resumeGoal()
  assert.ok(events.some((e) => e.event === 'goal-resumed'))
  assert.ok(!engine.isGoalMode(), '恢复后评估达成，自动退出')
  engine.dispose()
})

test('熔断请示-放弃：用户选 3 → clearGoal 退出', async () => {
  const { deps, events } = makeDeps({
    askAnswer: '3',
    onEvaluate: () => '{"verdict":"continue","progress":false,"reason":"没有新证据"}',
  })
  const engine = new ChatEngine(deps)
  engine.setGoal('某目标')

  await engine.sendMessage({ text: '开始吧' })

  assert.ok(!engine.isGoalMode())
  assert.ok(events.some((e) => e.event === 'goal-cleared'))
  assert.ok(!events.some((e) => e.event === 'goal-resumed'))
  engine.dispose()
})

test('熔断请示通道不可用（无 provider）→ 退回发事件 + clearGoal（迭代 1 行为）', async () => {
  const { deps, events } = makeDeps({
    onEvaluate: () => '{"verdict":"blocked","progress":false,"reason":"判据不可达"}',
  })
  const engine = new ChatEngine(deps)
  engine.setGoal('某目标')

  await engine.sendMessage({ text: '开始吧' })

  assert.ok(!engine.isGoalMode())
  const exhausted = events.find((e) => e.event === 'goal-budget-exhausted')
  assert.ok(exhausted)
  assert.equal(exhausted!.payload.paused, undefined, '无通道时不经暂停直接清除')
  engine.dispose()
})

test('pause/resume：paused 时不评估不推进；resume 后空闲立即恢复', async () => {
  const { deps, events, stats } = makeDeps({
    onEvaluate: () => '{"verdict":"achieved","progress":true,"reason":"done"}',
  })
  const engine = new ChatEngine(deps)
  engine.setGoal('某目标')
  engine.pauseGoal()
  assert.ok(events.some((e) => e.event === 'goal-paused'))

  await engine.sendMessage({ text: '暂停期间说一句' })
  assert.equal(stats().evalCalls, 0, 'paused 时不得评估')

  await engine.resumeGoal()
  assert.ok(events.some((e) => e.event === 'goal-resumed'))
  assert.ok(!engine.isGoalMode(), '恢复后评估达成自动退出')
  engine.dispose()
})

test('落盘与归档：setGoal/tick 后 save，达成后 archive + clear（goalStore 适配器）', async () => {
  const calls: Array<{ op: string; state?: any }> = []
  const { deps } = makeDeps({
    goalStoreCalls: calls,
    onEvaluate: (i) =>
      i === 1
        ? '{"verdict":"continue","progress":true,"reason":"继续"}'
        : '{"verdict":"achieved","progress":true,"reason":"done"}',
  })
  const engine = new ChatEngine(deps)
  engine.setGoal('某目标', '判据 X', 5)
  assert.equal(calls[0]?.op, 'save')
  assert.equal(calls[0]?.state.roundCount, 0)
  assert.equal(calls[0]?.state.maxRounds, 5)

  await engine.sendMessage({ text: '开始吧' })

  const tickSave = calls.filter((c) => c.op === 'save').find((c) => c.state.roundCount === 1)
  assert.ok(tickSave, 'goalTick 后应以 roundCount=1 落盘')
  assert.ok(calls.some((c) => c.op === 'archive' && c.state.objective === '某目标'), '达成后应归档')
  assert.equal(calls[calls.length - 1]?.op, 'clear', '归档后清除工作文档')
  engine.dispose()
})

test('goalPersistence：save/render/read/archive/clear 全流程（tmp 目录，frontmatter 计数齐全）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-store-'))
  setGoalsDirOverride(dir)
  try {
    const state = {
      objective: '目标 A',
      successCriteria: '判据 A',
      status: 'active' as const,
      roundCount: 3,
      noProgressCount: 1,
      maxRounds: 20,
      createdAt: '2026-08-11T00:00:00.000Z',
    }
    saveCurrentGoal(state)
    const content = readCurrentGoal()
    assert.ok(content)
    assert.match(content!, /status: active/)
    assert.match(content!, /roundCount: 3/)
    assert.match(content!, /noProgressCount: 1/)
    assert.match(content!, /# 目标\n\n目标 A/)
    assert.match(content!, /# 完成判据\n\n判据 A/)

    const archivePath = archiveCurrentGoal(state)
    assert.match(archivePath, /goal-\d{8}-\d{4}\.md$/)
    assert.ok(fs.existsSync(archivePath), '归档文件存在')
    assert.equal(readCurrentGoal(), null, '归档后 current-goal.md 已清除')

    saveCurrentGoal(state)
    clearCurrentGoal()
    assert.ok(!fs.existsSync(getCurrentGoalPath()))
  } finally {
    setGoalsDirOverride(null)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---- goal 五工具（真实 BuiltInToolExecutor + fake 通道；构造形状同 knowledgeTools.test.ts） ----

function makeGoalToolEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'goaltools-'))
  const fsProvider: any = {
    getCurrentDirectory: () => home,
    fileExists: async (p: string) => ({ success: fs.existsSync(p) }),
  }
  const executor = new BuiltInToolExecutor(fsProvider, {} as any, {} as any, {} as any, home)
  return {
    executor,
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
  }
}

test('propose_goal：用户批准 → GOAL_PROPOSAL_ACCEPTED 事件携带目标与判据；拒绝/门控分支', async () => {
  const { executor, cleanup } = makeGoalToolEnv()
  const proposals: any[] = []
  const onAccepted = (p: any) => proposals.push(p)
  eventBus.on(EVENTS.GOAL_PROPOSAL_ACCEPTED, onAccepted)
  try {
    // 批准
    executor.setUserInputProvider({ ask: async () => '1' } as any)
    const ok = await executor.executeAsync('propose_goal', JSON.stringify({ objective: '重构登录模块', success_criteria: 'npm test 通过' }))
    assert.equal(ok.success, true)
    assert.equal(proposals.length, 1)
    assert.equal(proposals[0].objective, '重构登录模块')
    assert.equal(proposals[0].successCriteria, 'npm test 通过')

    // 拒绝：不发事件，提示不重复提议
    executor.setUserInputProvider({ ask: async () => '2' } as any)
    const no = await executor.executeAsync('propose_goal', JSON.stringify({ objective: '另一个目标' }))
    assert.equal(no.success, true)
    assert.equal(proposals.length, 1)
    assert.match(String(no.data), /拒绝/)

    // 已在目标模式：门控拒绝
    executor.setGoalMode(true)
    const gated = await executor.executeAsync('propose_goal', JSON.stringify({ objective: 'x' }))
    assert.equal(gated.success, false)
    executor.setGoalMode(false)

    // -p 非交互：直接报错拒绝
    executor.setNonInteractiveMode('auto')
    const nonInteractive = await executor.executeAsync('propose_goal', JSON.stringify({ objective: 'x' }))
    assert.equal(nonInteractive.success, false)
    assert.match(String(nonInteractive.error), /非交互/)
    executor.setNonInteractiveMode(null)
  } finally {
    eventBus.off(EVENTS.GOAL_PROPOSAL_ACCEPTED, onAccepted)
    cleanup()
  }
})

test('propose_goal → 引擎联动：批准后引擎真正进入目标模式（全局事件总线双通道）', async () => {
  const { executor, cleanup } = makeGoalToolEnv()
  const { deps } = makeDeps({ onEvaluate: () => '{"verdict":"achieved","progress":true,"reason":"done"}' })
  // 引擎用全局事件总线（不注入 eventBus），与 executor 同一通道
  delete (deps as any).eventBus
  deps.builtInToolExecutor = executor as any
  const engine = new ChatEngine(deps)
  try {
    executor.setUserInputProvider({ ask: async () => '开启目标模式' } as any)
    const result = await executor.executeAsync('propose_goal', JSON.stringify({ objective: '提议的目标', success_criteria: '判据' }))
    assert.equal(result.success, true)
    assert.ok(engine.isGoalMode(), '批准后引擎应已进入目标模式')
    assert.equal(engine.getGoalState()!.objective, '提议的目标')
    assert.equal(engine.getGoalState()!.successCriteria, '判据')
  } finally {
    engine.dispose()
    cleanup()
  }
})

test('write_goal：修订目标/判据经 GOAL_UPDATED 联动引擎状态并落盘；轮次计数不变', async () => {
  const { executor, cleanup } = makeGoalToolEnv()
  const storeCalls: Array<{ op: string; state?: any }> = []
  const { deps } = makeDeps({ goalStoreCalls: storeCalls })
  delete (deps as any).eventBus
  deps.builtInToolExecutor = executor as any
  const engine = new ChatEngine(deps)
  try {
    engine.setGoal('旧目标', '旧判据', 7)
    // 引擎 setGoalMode 同步 executor 门（applyGoalState 的 executor 同步通道）
    const updated = await executor.executeAsync('write_goal', JSON.stringify({ success_criteria: '新判据' }))
    assert.equal(updated.success, true)
    const goal = engine.getGoalState()!
    assert.equal(goal.objective, '旧目标', '未提供的字段保持不变')
    assert.equal(goal.successCriteria, '新判据')
    assert.equal(goal.maxRounds, 7, '修订不影响轮次预算')
    const lastSave = [...storeCalls].reverse().find((c) => c.op === 'save')
    assert.equal(lastSave?.state.successCriteria, '新判据', '修订后应落盘')

    // 非目标模式门控
    engine.clearGoal()
    const gated = await executor.executeAsync('write_goal', JSON.stringify({ objective: 'x' }))
    assert.equal(gated.success, false)
  } finally {
    engine.dispose()
    cleanup()
  }
})

test('read_goal：返回目标文档原文；无文档/非目标模式报错', async () => {
  const { executor, cleanup } = makeGoalToolEnv()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-read-'))
  setGoalsDirOverride(dir)
  try {
    executor.setGoalMode(true)
    const missing = await executor.executeAsync('read_goal', '{}')
    assert.equal(missing.success, false)
    assert.match(String(missing.error), /不存在/)

    saveCurrentGoal({
      objective: '目标 R', successCriteria: '判据 R', status: 'active',
      roundCount: 1, noProgressCount: 0, maxRounds: 20, createdAt: '2026-08-11T00:00:00.000Z',
    })
    const ok = await executor.executeAsync('read_goal', '{}')
    assert.equal(ok.success, true)
    assert.match(String(ok.data), /目标 R/)

    executor.setGoalMode(false)
    const gated = await executor.executeAsync('read_goal', '{}')
    assert.equal(gated.success, false)
  } finally {
    setGoalsDirOverride(null)
    fs.rmSync(dir, { recursive: true, force: true })
    cleanup()
  }
})

test('request_goal_review：达成经引擎回调归档退出；未达成返回评估理由继续干活', async () => {
  const { executor, cleanup } = makeGoalToolEnv()
  const storeCalls: Array<{ op: string; state?: any }> = []
  // 评估器达成：模型在对话轮中调用 request_goal_review（fake executeAsync 透传到真实 executor）
  const { deps, events } = makeDeps({
    goalStoreCalls: storeCalls,
    onEvaluate: () => '{"verdict":"achieved","progress":true,"reason":"证据确凿"}',
  })
  deps.builtInToolExecutor = executor as any
  const engine = new ChatEngine(deps)
  try {
    engine.setGoal('某目标', '判据')
    // 直接调 executor（等价于模型在轮次中发起工具调用）
    const achieved = await executor.executeAsync('request_goal_review', '{}')
    assert.equal(achieved.success, true)
    assert.match(String(achieved.data), /评估通过/)
    assert.ok(!engine.isGoalMode(), '交卷通过后退出目标模式')
    assert.ok(events.some((e) => e.event === 'goal-achieved'))
    assert.ok(storeCalls.some((c) => c.op === 'archive'), '交卷通过后归档')

    // 未达成：返回理由，目标保留（回调由引擎注册，引擎已 clear 后重建一个目标）
    engine.setGoal('另一个目标', '判据')
    executor.setGoalReviewProvider(async () => ({ achieved: false, message: '评估未通过：缺少测试输出证据' }))
    const notYet = await executor.executeAsync('request_goal_review', '{}')
    assert.equal(notYet.success, true)
    assert.match(String(notYet.data), /评估未通过/)
    assert.ok(engine.isGoalMode(), '未通过时目标保留')
  } finally {
    engine.dispose()
    cleanup()
  }
})

test('report_goal_blocked：触发熔断请示通道；追加预算/放弃两分支文案回传模型', async () => {
  const { executor, cleanup } = makeGoalToolEnv()
  try {
    // 追加预算分支
    const env1 = makeDeps({ askAnswer: '1' })
    env1.deps.builtInToolExecutor = executor as any
    const engine1 = new ChatEngine(env1.deps)
    engine1.setGoal('某目标', undefined, 5)
    const extend = await executor.executeAsync('report_goal_blocked', JSON.stringify({ reason: '缺权限' }))
    assert.equal(extend.success, true)
    assert.match(String(extend.data), /追加 10 轮/)
    const goal1 = engine1.getGoalState()!
    assert.equal(goal1.status, 'active')
    assert.equal(goal1.maxRounds, 15, '预算 +10')
    engine1.dispose()

    // 放弃分支
    const env2 = makeDeps({ askAnswer: '3' })
    env2.deps.builtInToolExecutor = executor as any
    const engine2 = new ChatEngine(env2.deps)
    engine2.setGoal('某目标')
    const abandon = await executor.executeAsync('report_goal_blocked', JSON.stringify({ reason: '做不下去' }))
    assert.equal(abandon.success, true)
    assert.match(String(abandon.data), /放弃了目标/)
    assert.ok(!engine2.isGoalMode())
    engine2.dispose()

    // 非目标模式门控
    const gated = await executor.executeAsync('report_goal_blocked', JSON.stringify({ reason: 'x' }))
    assert.equal(gated.success, false)
  } finally {
    cleanup()
  }
})
