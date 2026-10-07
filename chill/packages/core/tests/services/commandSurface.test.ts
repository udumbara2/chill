import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  COMMAND_REGISTRY,
  resolveCommand,
  commandCatalog,
  validateArgs,
  buildCommandState,
  executeCommand,
  type CommandEnginePort,
  type CommandModelsReadPort,
} from '../../src/services/commands/commandSurface.ts'

// ==================== 注册表数据 ====================

test('注册表 27 条命令，id 唯一', () => {
  assert.equal(COMMAND_REGISTRY.length, 27)
  const ids = new Set(COMMAND_REGISTRY.map((c) => c.id))
  assert.equal(ids.size, COMMAND_REGISTRY.length)
})

test('fast 通道成员唯一判据：turn.stop + 两个只读 list + idea（纯账本追加）+ improve/improve.page（开庭与翻页）+ C+D 命令（交付物/清单只读 + 账本写经 ledger 串行化）+ autoswitch.set（纯 KV 写不碰引擎串行链）', () => {
  const fast = COMMAND_REGISTRY.filter((c) => c.channel === 'fast').map((c) => c.id).sort()
  assert.deepEqual(fast, ['autoswitch.set', 'front.list', 'idea', 'improve', 'improve.confirmed', 'improve.confirmed.decide', 'improve.page', 'memory', 'memory.delete', 'memory.list', 'memory.seen', 'memory.show', 'model.list', 'task.detail', 'turn.stop'])
})

test('resolveCommand：已知命中 / 未知 undefined', () => {
  assert.equal(resolveCommand('turn.stop')?.channel, 'fast')
  assert.equal(resolveCommand('model.set')?.options?.lazy, 'model.list')
  assert.equal(resolveCommand('nope'), undefined)
})

test('目录投影：排除 internal 选项源，线形字段齐全', () => {
  const catalog = commandCatalog()
  // 本仓为 managed 布局（测试进程在 chill 源码树内）→ managedOnly 的 idea/improve 随目录下发
  assert.equal(catalog.length, 15)
  const desktopSpec = catalog.find((c) => c.id === 'desktop.set')
  assert.ok(desktopSpec, 'desktop.set 应在目录中')
  assert.equal(desktopSpec!.risk, 'confirm')
  assert.equal(desktopSpec!.channel, 'serial')
  const autoswitchSpec = catalog.find((c) => c.id === 'autoswitch.set')
  assert.ok(autoswitchSpec, 'autoswitch.set 应在目录中')
  assert.equal(autoswitchSpec!.risk, 'instant')
  assert.equal(autoswitchSpec!.channel, 'fast')
  const ids = catalog.map((c) => c.id)
  assert.ok(!ids.includes('model.list'))
  assert.ok(!ids.includes('front.list'))
  assert.ok(!ids.includes('session.delete'), 'internal 会话管理命令不进目录（手势携带 sessionId 调用）')
  assert.ok(!ids.includes('session.rename'), 'internal 会话管理命令不进目录（手势携带 sessionId 调用）')
  assert.ok(!ids.includes('improve.page'), 'internal 卡内驱动命令不进目录（裁决卡内翻页行调用）')
  assert.ok(!ids.includes('task.detail'), 'internal 行点击携带参数调用，不进目录')
  assert.ok(!ids.includes('improve.confirmed'), 'internal 空态视图拉取，不进目录')
  assert.ok(!ids.includes('improve.confirmed.decide'), 'internal 清单动作菜单调用，不进目录')
  assert.ok(!ids.includes('memory.list'), 'internal 记忆库命令不进目录（MemorySheet 面板内调用）')
  assert.ok(!ids.includes('memory.show'), 'internal 记忆库命令不进目录')
  assert.ok(!ids.includes('memory.delete'), 'internal 记忆库命令不进目录')
  assert.ok(!ids.includes('memory.seen'), 'internal 记忆库命令不进目录')
  assert.ok(ids.includes('memory'), '记忆目录行应在册（非 managedOnly——npm 模式同样有记忆）')
  assert.ok(ids.includes('turn.stop'))
  assert.ok(ids.includes('idea'), 'managed 布局下 idea 应在目录中')
  assert.ok(ids.includes('improve'), 'managed 布局下 improve 应在目录中')
  for (const entry of catalog) {
    assert.ok(entry.title && entry.section && entry.presentation && entry.risk && entry.channel)
  }
})

// ==================== args 校验 ====================

test('validateArgs：model.set 缺 name 拒绝', () => {
  const spec = resolveCommand('model.set')!
  assert.equal(validateArgs(spec, {})!.code, 'invalid_args')
  assert.equal(validateArgs(spec, { name: 'GLM-5.3' }), null)
})

test('validateArgs：plan.set 须布尔 on', () => {
  const spec = resolveCommand('plan.set')!
  assert.equal(validateArgs(spec, { on: 'yes' })!.code, 'invalid_args')
  assert.equal(validateArgs(spec, { on: true }), null)
})

test('validateArgs：desktop.set / autoswitch.set 须布尔 on', () => {
  for (const id of ['desktop.set', 'autoswitch.set']) {
    const spec = resolveCommand(id)!
    assert.equal(validateArgs(spec, {})!.code, 'invalid_args', id)
    assert.equal(validateArgs(spec, { on: 1 })!.code, 'invalid_args', id)
    assert.equal(validateArgs(spec, { on: false }), null, id)
  }
})

test('validateArgs：goal.set objective 必填 + maxRounds 1-100 整数', () => {
  const spec = resolveCommand('goal.set')!
  assert.equal(validateArgs(spec, {})!.code, 'invalid_args')
  assert.equal(validateArgs(spec, { objective: '完成 X' }), null)
  assert.equal(validateArgs(spec, { objective: '完成 X', maxRounds: 0 })!.code, 'invalid_args')
  assert.equal(validateArgs(spec, { objective: '完成 X', maxRounds: 3.5 })!.code, 'invalid_args')
  assert.equal(validateArgs(spec, { objective: '完成 X', criteria: '判据', maxRounds: 12 }), null)
})

test('validateArgs：idea text 必填', () => {
  const spec = resolveCommand('idea')!
  assert.equal(validateArgs(spec, {})!.code, 'invalid_args')
  assert.equal(validateArgs(spec, { text: '搜索结果默认过滤构建产物' }), null)
})

test('validateArgs：无参命令（turn.stop 等）空 args 通过', () => {
  for (const id of ['turn.stop', 'model.list', 'front.list', 'goal.pause', 'goal.resume', 'goal.abandon']) {
    assert.equal(validateArgs(resolveCommand(id)!, undefined), null, id)
  }
})

// ==================== 状态快照 ====================

function fakeEngine(over: Partial<ReturnType<CommandEnginePort['getSessionState']>> = {}, ctx?: ReturnType<CommandEnginePort['getContextStatus']>): CommandEnginePort {
  return {
    getSessionState: () => ({
      sessionId: 'sess-1',
      planMode: true,
      frontAgent: 'code-reviewer',
      isRunning: false,
      goalMode: { active: false, objective: '重构登录模块', roundCount: 3, maxRounds: 12 },
      ...over,
    }),
    getContextStatus: () => ctx ?? null,
  }
}

function fakeModels(name: string | null = 'GLM-5.3', params: Record<string, unknown> | null = { reasoning_effort: 'high' }): CommandModelsReadPort {
  return {
    getCurrentModelName: () => name,
    getModelParameters: () => params,
  }
}

test('buildCommandState：全量快照口径（paused 映射 / effort / front / ctx approx 透传）', () => {
  const snap = buildCommandState({
    engine: fakeEngine({}, { usedTokens: 9100, usedTokensApprox: true, maxContextTokens: 200000 }),
    models: fakeModels(),
  })
  assert.equal(snap.sessionId, 'sess-1')
  assert.equal(snap.running, false)
  assert.equal(snap.plan, true)
  assert.deepEqual(snap.model, { name: 'GLM-5.3', effort: 'high' })
  assert.equal(snap.front, 'code-reviewer')
  assert.deepEqual(snap.goal, { status: 'paused', objective: '重构登录模块', round: 3, maxRounds: 12 })
  assert.deepEqual(snap.ctx, { used: 9100, max: 200000, approx: true })
})

test('buildCommandState：active 目标 / effort 未设置 / ctx 无分母', () => {
  const snap = buildCommandState({
    engine: fakeEngine({ planMode: false, isRunning: true, goalMode: { active: true, objective: 'o', roundCount: 1, maxRounds: 5 }, frontAgent: undefined }, { usedTokens: 100 }),
    models: fakeModels('DeepSeek-V4', {}),
  })
  assert.equal(snap.running, true)
  assert.equal(snap.plan, false)
  assert.deepEqual(snap.model, { name: 'DeepSeek-V4' })
  assert.equal(snap.front, null)
  assert.deepEqual(snap.goal, { status: 'active', objective: 'o', round: 1, maxRounds: 5 })
  assert.deepEqual(snap.ctx, { used: 100 })
})

test('buildCommandState：空依赖 → 全空态（不显示错误数字）', () => {
  const snap = buildCommandState({})
  assert.equal(snap.sessionId, null)
  assert.equal(snap.running, false)
  assert.equal(snap.plan, false)
  assert.equal(snap.model, null)
  assert.equal(snap.front, null)
  assert.equal(snap.goal, null)
  assert.equal(snap.ctx, null)
})

// ==================== 执行机械（M1 dormant） ====================

test('executeCommand：未知命令 fail-closed', async () => {
  const r = await executeCommand({}, 'nope')
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.error.code, 'unsupported')
})

test('executeCommand：args 非法 fail-closed', async () => {
  const r = await executeCommand({}, 'plan.set', { on: 1 })
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.error.code, 'invalid_args')
})

// ==================== M2 executors ====================

function fakeEngineWrite() {
  const calls: string[] = []
  const candidates = [
    { type: 'coder', name: '代码审查员', description: '改动审查' },
    { type: 'explore', name: '探索员' },
  ]
  return {
    calls,
    candidates,
    port: {
      getSessionState: () => ({ sessionId: 's-1', planMode: false, frontAgent: undefined, isRunning: false }),
      getContextStatus: () => null,
      abort: () => {
        calls.push('abort')
      },
      setPlanMode: (on: boolean) => {
        calls.push(`plan:${on}`)
      },
      setFrontAgent: (type?: string) => {
        calls.push(`front:${type ?? '∅'}`)
      },
      getFrontAgentCandidates: () => candidates,
      compactHistory: async (guidance?: string, opts?: { trigger?: string }) => {
        calls.push(`compact:${guidance ?? ''}:${opts?.trigger ?? ''}`)
        if (guidance === 'THROW') throw new Error('生成进行中，请先 abort()')
        return { checkpoint: {} }
      },
      setGoal: (objective: string, criteria?: string, maxRounds?: number) => {
        if (objective === 'THROW') throw new Error('另一个会话正在目标模式')
        calls.push(`goal:set:${objective}:${criteria ?? ''}:${maxRounds ?? ''}`)
      },
      pauseGoal: () => {
        calls.push('goal:pause')
      },
      resumeGoal: async () => {
        calls.push('goal:resume')
      },
      clearGoal: () => {
        calls.push('goal:clear')
      },
      detachSession: () => {
        calls.push('detach')
      },
    },
  }
}

function fakeModelsWrite(current: string | null = 'GLM-5.3', params: Record<string, unknown> = { reasoning_effort: 'high' }) {
  const saved: Array<{ modelName: string; parameters: Record<string, unknown> }> = []
  return {
    saved,
    port: {
      getCurrentModelName: () => current,
      getModelParameters: () => params,
      saveCurrentModelName: (n: string) => {
        saved.push({ modelName: n, parameters: {} })
        current = n
      },
      getModelParameterSettings: () => (current ? { modelName: current, parameters: { ...params } } : null),
      saveModelParameterSettings: (s: { modelName: string; parameters: Record<string, unknown> }) => {
        saved.push(s)
        params = { ...s.parameters }
      },
    },
  }
}

test('M2 turn.stop：调 abort（空转幂等无异常）', async () => {
  const e = fakeEngineWrite()
  const r = await executeCommand({ engine: e.port }, 'turn.stop')
  assert.equal(r.ok, true)
  assert.deepEqual(e.calls, ['abort'])
})

test('M2 model.list：CLI 同口径——全部 chat 模型 + hasKey，生成模型剔除', async () => {
  const modelInfo = {
    getModelsWithApiKeys: async () => [],
    getAllModelsWithApiKeyStatus: async () => [
      { model: { name: 'GLM-5.3', displayName: 'GLM 5.3', provider: 'Z.ai', supportedParameters: [{ name: 'reasoning_effort', enumValues: ['low', 'high', 'max'] }] }, hasApiKey: true },
      { model: { name: 'Kimi-K3', provider: 'Moonshot', supportedParameters: [{ name: 'reasoning_effort', enumValues: ['low', 'medium', 'xhigh'] }] }, hasApiKey: true },
      { model: { name: '无Key模型', provider: 'X', supportedParameters: [] }, hasApiKey: false },
      { model: { name: 'cogview-4', provider: 'Z.ai', adapterConfig: { protocol: 'openai-image' }, supportedParameters: [] }, hasApiKey: true },
      { model: { name: '退役卡', provider: 'X', supportedParameters: [], deprecated: true }, hasApiKey: true },
    ],
  }
  const r = await executeCommand({ modelInfo }, 'model.list')
  assert.equal(r.ok, true)
  if (r.ok) {
    const options = (r.data?.['options'] as Array<{ name: string; hasKey: boolean; deprecated?: boolean }>) ?? []
    const names = options.map((o) => o.name)
    // 生成模型剔除；无 Key 的 chat 模型保留（手机端禁用+标注）
    assert.deepEqual(names.sort(), ['GLM-5.3', 'Kimi-K3', '无Key模型', '退役卡'])
    const noKey = options.find((o) => o.name === '无Key模型')!
    assert.equal(noKey.hasKey, false)
    assert.equal(options.find((o) => o.name === 'GLM-5.3')!.hasKey, true)
    assert.equal(options.find((o) => o.name === '退役卡')!.deprecated, true)
    // efforts 枚举仍随模型定义
    const kimi = (r.data?.['options'] as Array<{ name: string; efforts: string[] }>).find((o) => o.name === 'Kimi-K3')!
    assert.ok(kimi.efforts.includes('xhigh'))
  }
})

test('M2 model.set：写当前模型名', async () => {
  const m = fakeModelsWrite()
  const r = await executeCommand({ models: m.port }, 'model.set', { name: 'Kimi-K3' })
  assert.equal(r.ok, true)
  assert.equal(m.saved[0]!.modelName, 'Kimi-K3')
})

test('M2 model.param：per-model 键值合并写（保留既有参数）', async () => {
  const m = fakeModelsWrite('GLM-5.3', { reasoning_effort: 'high', temperature: 0.7 })
  const r = await executeCommand({ models: m.port }, 'model.param', { param: 'reasoning_effort', value: 'max' })
  assert.equal(r.ok, true)
  assert.deepEqual(m.saved[0]!.parameters, { reasoning_effort: 'max', temperature: 0.7 })
})

test('M2 model.param：无当前模型 → guard 诚实回错', async () => {
  const m = fakeModelsWrite(null)
  const r = await executeCommand({ models: m.port }, 'model.param', { param: 'reasoning_effort', value: 'high' })
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.error.code, 'guard')
})

test('M2 executor 依赖缺位 → 诚实 unsupported（不抛错）', async () => {
  const r1 = await executeCommand({}, 'turn.stop')
  assert.equal(r1.ok, false)
  const r2 = await executeCommand({}, 'model.list')
  assert.equal(r2.ok, false)
  const r3 = await executeCommand({}, 'model.set', { name: 'x' })
  assert.equal(r3.ok, false)
})

// ==================== M3 executors ====================

test('M3 front.list：候选枚举（type/name/description 线形）', async () => {
  const e = fakeEngineWrite()
  const r = await executeCommand({ engine: e.port }, 'front.list')
  assert.equal(r.ok, true)
  if (r.ok) {
    const options = (r.data?.['options'] as Array<{ type: string; name: string; description?: string }>) ?? []
    assert.equal(options.length, 2)
    assert.equal(options[0]!.type, 'coder')
    assert.equal(options[0]!.description, '改动审查')
    assert.equal(options[1]!.description, undefined)
  }
})

test('M3 front.set：合法候选切换 / 非法候选 guard 拒绝 / null=裸模型', async () => {
  const e = fakeEngineWrite()
  const ok = await executeCommand({ engine: e.port }, 'front.set', { type: 'coder' })
  assert.equal(ok.ok, true)
  const bad = await executeCommand({ engine: e.port }, 'front.set', { type: 'remote-x' })
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.equal(bad.error.code, 'guard')
  const off = await executeCommand({ engine: e.port }, 'front.set', { type: null })
  assert.equal(off.ok, true)
  assert.deepEqual(e.calls.filter((c) => c.startsWith('front:')), ['front:coder', 'front:∅'])
})

test('M3 plan.set：on/off 直通引擎', async () => {
  const e = fakeEngineWrite()
  assert.equal((await executeCommand({ engine: e.port }, 'plan.set', { on: true })).ok, true)
  assert.equal((await executeCommand({ engine: e.port }, 'plan.set', { on: false })).ok, true)
  assert.deepEqual(e.calls.filter((c) => c.startsWith('plan:')), ['plan:true', 'plan:false'])
})

test('M3 compact：guidance 透传 + trigger=manual；守卫异常诚实 guard 回流', async () => {
  const e = fakeEngineWrite()
  const ok = await executeCommand({ engine: e.port }, 'compact', { guidance: '保留登录模块细节' })
  assert.equal(ok.ok, true)
  assert.ok(e.calls.includes('compact:保留登录模块细节:manual'))
  const guard = await executeCommand({ engine: e.port }, 'compact', { guidance: 'THROW' })
  assert.equal(guard.ok, false)
  if (!guard.ok) {
    assert.equal(guard.error.code, 'guard')
    assert.match(guard.error.message, /生成进行中/)
  }
})

// ==================== M4 executors ====================

test('M4 goal.set：透传 objective/criteria/maxRounds + 首轮 kick fire-and-forget', async () => {
  const e = fakeEngineWrite()
  const kicks: string[] = []
  const r = await executeCommand(
    { engine: e.port, startGoalRound: async (o) => { kicks.push(o) } },
    'goal.set',
    { objective: '修复登录', criteria: 'test 过', maxRounds: 12 },
  )
  assert.equal(r.ok, true)
  assert.ok(e.calls.includes('goal:set:修复登录:test 过:12'))
  assert.deepEqual(kicks, ['修复登录'], '设定即开工（kick 已发，不阻塞命令链）')
})

test('M4 goal.set：引擎互斥守卫诚实 guard 回流且不 kick', async () => {
  const e = fakeEngineWrite()
  const kicks: string[] = []
  const r = await executeCommand(
    { engine: e.port, startGoalRound: async (o) => { kicks.push(o) } },
    'goal.set',
    { objective: 'THROW' },
  )
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.error.code, 'guard')
  assert.equal(kicks.length, 0)
})

test('M4 goal.set：无 kick 依赖亦可设定（首轮回落为下轮用户输入/resume）', async () => {
  const e = fakeEngineWrite()
  const r = await executeCommand({ engine: e.port }, 'goal.set', { objective: '目标 X' })
  assert.equal(r.ok, true)
})

test('M4 goal.pause/resume/abandon：直通引擎（resume fire-and-forget 不阻塞）', async () => {
  const e = fakeEngineWrite()
  assert.equal((await executeCommand({ engine: e.port }, 'goal.pause')).ok, true)
  assert.equal((await executeCommand({ engine: e.port }, 'goal.resume')).ok, true)
  assert.equal((await executeCommand({ engine: e.port }, 'goal.abandon')).ok, true)
  assert.deepEqual(e.calls.filter((c) => c.startsWith('goal:')), ['goal:pause', 'goal:resume', 'goal:clear'])
})

// ==================== 会话管理 executors（session.delete / session.rename；首个按 args.sessionId 作用任意会话的命令族） ====================

/** 共享时序数组的 fake 端口对（断言 detach 先于 delete 的跨端口顺序） */
function fakeSessionAdmin(sessionId: string | null, opts: { isRunning?: boolean; detachThrows?: boolean } = {}) {
  const seq: string[] = []
  const state = { failPatch: false, failDelete: false }
  const engine = {
    getSessionState: () => ({ sessionId, planMode: false, isRunning: opts.isRunning ?? false }),
    getContextStatus: () => null,
    abort: () => {},
    setPlanMode: () => {},
    setFrontAgent: () => {},
    getFrontAgentCandidates: () => [],
    compactHistory: async () => ({}),
    setGoal: () => {},
    pauseGoal: () => {},
    resumeGoal: async () => {},
    clearGoal: () => {},
    detachSession: () => {
      seq.push('detach')
      if (opts.detachThrows) throw new Error('有后台任务进行中')
    },
  }
  const sessions = {
    patchTitle: async (id: string, title: string) => {
      seq.push(`patchTitle:${id}:${title}`)
      return state.failPatch ? { success: false, error: `Session not found: ${id}` } : { success: true }
    },
    delete: async (id: string) => {
      seq.push(`delete:${id}`)
      return state.failDelete ? { success: false, error: 'io error' } : { success: true }
    },
  }
  return { seq, state, engine, sessions }
}

test('session.rename：trim 后写 patchTitle；失败诚实 guard 回流', async () => {
  const f = fakeSessionAdmin('s-1')
  const ok = await executeCommand({ engine: f.engine, sessions: f.sessions }, 'session.rename', { sessionId: 's-9', title: '  新标题  ' })
  assert.equal(ok.ok, true)
  assert.deepEqual(f.seq, ['patchTitle:s-9:新标题'])
  f.state.failPatch = true
  const bad = await executeCommand({ engine: f.engine, sessions: f.sessions }, 'session.rename', { sessionId: 's-x', title: 't' })
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.equal(bad.error.code, 'guard')
})

test('session.rename：args 校验——缺 sessionId/缺标题/超长标题均 invalid_args', async () => {
  const f = fakeSessionAdmin(null)
  for (const args of [{ title: 't' }, { sessionId: 's-1' }, { sessionId: 's-1', title: 'x'.repeat(101) }]) {
    const r = await executeCommand({ engine: f.engine, sessions: f.sessions }, 'session.rename', args)
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.error.code, 'invalid_args')
  }
  assert.deepEqual(f.seq, [], '校验短路，不触达端口')
})

test('session.delete：非活动会话直接删，不触 detach', async () => {
  const f = fakeSessionAdmin('s-active')
  const r = await executeCommand({ engine: f.engine, sessions: f.sessions }, 'session.delete', { sessionId: 's-other' })
  assert.equal(r.ok, true)
  assert.deepEqual(f.seq, ['delete:s-other'])
})

test('session.delete：活动空闲会话先 detach 后删（顺序断言，防引擎 save 复活文件）', async () => {
  const f = fakeSessionAdmin('s-1')
  const r = await executeCommand({ engine: f.engine, sessions: f.sessions }, 'session.delete', { sessionId: 's-1' })
  assert.equal(r.ok, true)
  assert.deepEqual(f.seq, ['detach', 'delete:s-1'])
})

test('session.delete：活动会话正在跑 → guard 拒绝，detach/delete 均不触达', async () => {
  const f = fakeSessionAdmin('s-1', { isRunning: true })
  const r = await executeCommand({ engine: f.engine, sessions: f.sessions }, 'session.delete', { sessionId: 's-1' })
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.error.code, 'guard')
  assert.deepEqual(f.seq, [])
})

test('session.delete：detach 抛错（后台任务在途）→ 诚实回错且不删文件', async () => {
  const f = fakeSessionAdmin('s-1', { detachThrows: true })
  const r = await executeCommand({ engine: f.engine, sessions: f.sessions }, 'session.delete', { sessionId: 's-1' })
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.error.code, 'guard')
  assert.deepEqual(f.seq, ['detach'], 'detach 尝试后中止，delete 未触达')
})

test('session.delete/rename：sessions 端口未装配 → 诚实 unsupported', async () => {
  const r1 = await executeCommand({}, 'session.delete', { sessionId: 's-1' })
  assert.equal(r1.ok, false)
  if (!r1.ok) assert.equal(r1.error.code, 'unsupported')
  const r2 = await executeCommand({}, 'session.rename', { sessionId: 's-1', title: 't' })
  assert.equal(r2.ok, false)
  if (!r2.ok) assert.equal(r2.error.code, 'unsupported')
})
