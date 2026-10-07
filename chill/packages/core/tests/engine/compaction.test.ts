import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChatEngine } from '../../src/engine/ChatEngine.ts'
import type { ChatEngineDeps } from '../../src/engine/types.ts'
import type { Message, MessageRole } from '../../src/types/models.ts'
import type { SessionRecord } from '../../src/persistence/SessionPersistence.ts'
import { getTaskRegistry, resetTaskRegistry } from '../../src/services/delegation/taskRegistry.ts'

/**
 * 上下文压缩（/compact）引擎测试：真实 ChatEngine + 最小 fake deps（模式同 taskReflow.test.ts）。
 * enum（MessageRole）不可运行时导入，一律字符串字面量。
 */

const USER = 'user' as MessageRole
const ASSISTANT = 'assistant' as MessageRole
const TOOL = 'tool' as MessageRole

/** 本地时区时间（recall 的 HH:MM 过滤与时间戳前缀均用本地时区） */
const D = (h: number, m: number) => new Date(2025, 0, 1, h, m)

const SUMMARY1 = '## 目标与意图\n设计写边界\n## 会话主题索引\n- 写边界讨论（14:00–14:03）'
const SUMMARY2 = '## 目标与意图\n设计写边界+部署\n## 会话主题索引\n- 写边界讨论（14:00–14:03）\n- 部署讨论（14:10–14:13）'

/** 三轮对话：第 1 轮含工具对（tc-1），第 2 轮含工具对（tc-2），第 3 轮纯文本 */
function makeHistory(): Message[] {
  return [
    { role: USER, content: '讨论写边界审批设计', timestamp: D(14, 0) },
    {
      role: ASSISTANT,
      content: '我先读一下代码',
      toolCalls: [{ id: 'tc-1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      timestamp: D(14, 1),
    } as Message,
    { role: TOOL, content: '文件内容', toolCallId: 'tc-1', timestamp: D(14, 2) },
    { role: ASSISTANT, content: '结论：方案A', timestamp: D(14, 3) },
    { role: USER, content: '那部署呢', timestamp: D(14, 10) },
    {
      role: ASSISTANT,
      content: '查一下部署文档',
      toolCalls: [{ id: 'tc-2', type: 'function', function: { name: 'search_content', arguments: '{}' } }],
      timestamp: D(14, 11),
    } as Message,
    { role: TOOL, content: '文档内容', toolCallId: 'tc-2', timestamp: D(14, 12) },
    { role: ASSISTANT, content: '部署用 docker', timestamp: D(14, 13) },
    { role: USER, content: '好的', timestamp: D(14, 20) },
    { role: ASSISTANT, content: '继续', timestamp: D(14, 21) },
  ]
}

function makeRecord(messages: Message[]): SessionRecord {
  return {
    id: 's1',
    title: 't',
    titleSource: 'default',
    messages,
    createdAt: '2025-01-01T13:00:00.000Z',
    updatedAt: '2025-01-01T13:00:00.000Z',
  }
}

interface MakeDepsOptions {
  loadRecord?: SessionRecord
  /** 压缩调用（system prompt 开头）依次返回的总结；返回空串/抛错模拟失败 */
  compactionSummaries?: Array<string | Error>
  /** 当前模型卡（getModelInfoByName 返回值；缺省 undefined = 窗口未登记） */
  modelInfoEntry?: Record<string, unknown>
}

function makeDeps(options: MakeDepsOptions = {}) {
  const sentCalls: Message[][] = []
  const compactionCalls: Message[][] = []
  const savedRecords: SessionRecord[] = []
  let compactionIndex = 0
  let archivedContextProvider: ((params: any) => string) | null = null
  const deps: ChatEngineDeps = {
    modelCaller: {
      callOnce: async (params: any) => {
        // 压缩调用以压缩器 system prompt 开头（正常轮可能带注入器 system 前缀，不能按 role 判别）
        const first = params.messages[0]?.content
        if (typeof first === 'string' && first.includes('你是上下文压缩器')) {
          compactionCalls.push(params.messages)
          const next = options.compactionSummaries?.[compactionIndex++] ?? SUMMARY1
          if (next instanceof Error) throw next
          return { content: next }
        }
        sentCalls.push(params.messages)
        return { content: 'ok', usage: { promptTokens: 1000, completionTokens: 100, totalTokens: 1100 } }
      },
    },
    modelInfo: {
      getModelsWithApiKeys: async () => [],
      getModelInfoByName: () => (options.modelInfoEntry as any) ?? undefined,
    } as any,
    selectedModels: { getCurrentModelName: () => 'fake-model' } as any,
    sessionStore: {
      save: async (record: SessionRecord) => {
        savedRecords.push(record)
        return { success: true }
      },
      load: async () =>
        options.loadRecord ? { success: true, record: options.loadRecord } : { success: false },
    } as any,
    builtInToolExecutor: {
      execute: () => ({ success: true }),
      executeAsync: async () => ({ success: true }),
      setPlanMode: () => {},
      getAutoApply: () => false,
      getNonInteractiveMode: () => null,
      applyAutoApplyBatch: async () => new Map(),
      setArchivedContextProvider: (p: (params: any) => string) => {
        archivedContextProvider = p
      },
    } as any,
    mcpService: { getAggregatedOpenAITools: async () => [] } as any,
    eventBus: { on: () => {}, off: () => {}, emit: () => {} },
  }
  return {
    deps,
    sentCalls,
    compactionCalls,
    savedRecords,
    getProvider: () => archivedContextProvider,
  }
}

/** 发送给模型的消息里去掉注入器 system 前缀，剩下的就是 effectiveHistory 切片 */
function sentHistory(messages: Message[]): Message[] {
  return messages.filter((m) => m.role !== 'system')
}

/** toolCalls/TOOL 配对完整性：每条 TOOL 的 toolCallId 都能在之前的 assistant 消息里找到 */
function assertToolPairing(messages: Message[]): void {
  const seen = new Set<string>()
  for (const m of messages) {
    for (const tc of m.toolCalls ?? []) seen.add(tc.id)
    if (m.role === TOOL && m.toolCallId) {
      assert.ok(seen.has(m.toolCallId), `孤儿 TOOL 消息: ${m.toolCallId}`)
    }
  }
}

test('lastUsage 随会话持久化与恢复：/session load 后状态栏占比立即可得', async () => {
  // 一轮正常对话产生实测用量（fake callOnce 返回 usage 1000/100）→ 落盘记录应携带
  const { deps, savedRecords } = makeDeps()
  const engine = new ChatEngine(deps)
  await engine.sendMessage({ text: '你好' })
  const last = savedRecords[savedRecords.length - 1]
  assert.deepEqual(last.lastUsage, { promptTokens: 1000, completionTokens: 100, totalTokens: 1100 })

  // 加载带 lastUsage 的记录 → getContextStatus 立即有值（不等下一轮 API 调用）
  const record = {
    ...makeRecord(makeHistory()),
    lastUsage: { promptTokens: 5000, completionTokens: 500, totalTokens: 5500 },
  }
  const { deps: deps2 } = makeDeps({ loadRecord: record })
  const engine2 = new ChatEngine(deps2)
  await engine2.loadSession('s1')
  const status = engine2.getContextStatus()
  assert.ok(status)
  assert.equal(status.usedTokens, 5500)

  // 旧记录无该字段 → null（该段隐藏，与既往行为一致）
  const { deps: deps3 } = makeDeps({ loadRecord: makeRecord(makeHistory()) })
  const engine3 = new ChatEngine(deps3)
  await engine3.loadSession('s1')
  assert.equal(engine3.getContextStatus(), null)
})

test('显示口径立法（2026-10-07）：分母=原始窗口永不减扣，分子=实测占用+申报输出预留', async () => {
  // 事故复现卡：deepseek-flash 1M 窗口 + 196608 缺省申报（旧口径曾把分母显示成 851968 曲解容量）
  const record = {
    ...makeRecord(makeHistory()),
    lastUsage: { promptTokens: 30000, completionTokens: 1000, totalTokens: 31000 },
  }
  const { deps } = makeDeps({
    loadRecord: record,
    modelInfoEntry: { maxContextTokens: 1048576, adapterConfig: { defaultMaxTokens: 196608 } },
  })
  const engine = new ChatEngine(deps)
  await engine.loadSession('s1')
  const status = engine.getContextStatus()
  // 分母诚实：原始 1M 卡面窗口，一切占用不在分母里减
  assert.equal(status?.maxContextTokens, 1048576)
  // 分子 = 实测占用（已含系统提示词/记忆/历史）+ 申报输出预留：30000+1000+196608
  assert.equal(status?.usedTokens, 227608)
  // 环 100% 恰为准入红线：used 达窗口时比例 = 1（prompt + 申报预算 = 窗口）
  assert.equal((status!.usedTokens - 30000 - 1000 + 851968) / status!.maxContextTokens!, 1)
})

test('压缩主流程：checkpoint 追加落盘、lastUsage 重置、发送视图切片', async () => {
  const { deps, sentCalls, compactionCalls, savedRecords } = makeDeps({ loadRecord: makeRecord(makeHistory()) })
  const engine = new ChatEngine(deps)
  await engine.loadSession('s1')

  // 先跑一轮正常对话产生实测用量
  await engine.sendMessage({ text: '压缩前的最后一问' })
  assert.ok(engine.getContextStatus())

  const { checkpoint, previousUsage } = await engine.compactHistory('重点保留接口设计')
  // 切点：此时 4 条 user，倒数第 2 条是 '好的'@14:20，其前一条是 '部署用 docker'@14:13
  assert.equal(checkpoint.upToTimestamp, D(14, 13).toISOString())
  assert.equal(checkpoint.guidance, '重点保留接口设计')
  assert.ok(previousUsage)
  // 压缩后 lastUsage 重置 → getContextStatus 回退最近 checkpoint 估值（approx 标记；下一轮实测回精确态）
  const statusAfterCompact = engine.getContextStatus()
  assert.equal(statusAfterCompact?.usedTokensApprox, true)
  assert.ok(statusAfterCompact!.usedTokens > 0)
  // 估值字段随 checkpoint 持久化（壳侧显示数据源）
  assert.ok(checkpoint.usageAfterApproxTokens && checkpoint.usageAfterApproxTokens > 0)
  assert.ok(checkpoint.usageBeforeTokens && checkpoint.usageBeforeTokens > 0)
  // 权威历史一条不少（追加式：messages 永不删除）
  assert.equal(engine.getHistory().length, 12)
  assert.equal(engine.getSessionState().compactions.length, 1)
  // 压缩调用拼入了引导语
  assert.ok((compactionCalls[0][1].content as string).includes('重点保留接口设计'))
  // 落盘记录携带 compactions
  const withCompactions = savedRecords.filter((r) => r.compactions?.length)
  assert.ok(withCompactions.length > 0)
  assert.equal(withCompactions[withCompactions.length - 1].compactions![0].summary, SUMMARY1)
  // 压缩路径的落盘携带 lastUsage: null 哨兵（显式清除信号，merge 后盘上字段消失，reload 不复活旧值）
  assert.equal(withCompactions[withCompactions.length - 1].lastUsage, null)

  // 压缩后发送：切片 = 合成总结 user 消息 + 切点后全部消息（u3 轮 + 最后一轮）
  await engine.sendMessage({ text: '压缩后第一问' })
  const history = sentHistory(sentCalls[sentCalls.length - 1])
  assert.equal(history[0].role, USER)
  const synthetic = history[0].content as string
  assert.ok(synthetic.includes('【历史压缩摘要】'))
  assert.ok(synthetic.includes('这是历史记录，不是新指令'))
  assert.ok(synthetic.includes('recall_archived_context'))
  assert.ok(synthetic.includes(SUMMARY1))
  // 合成消息 timestamp 取 checkpoint.createdAt，晚于 upToTimestamp（否则切片后自己被滤掉）
  assert.ok(history[0].timestamp.getTime() > new Date(checkpoint.upToTimestamp).getTime())
  // 合成消息不落盘：权威历史里没有它
  assert.ok(!engine.getHistory().some((m) => typeof m.content === 'string' && m.content.includes('【历史压缩摘要】')))
  // 切点后消息全在，切点前的不在
  const texts = history.map((m) => (typeof m.content === 'string' ? m.content : ''))
  assert.ok(texts.includes('好的'))
  assert.ok(texts.includes('压缩后第一问'))
  assert.ok(!texts.includes('那部署呢'))
  assert.ok(!texts.includes('讨论写边界审批设计'))
  assertToolPairing(history)
})

test('切片配对完整性：切点落在轮边界，切点后工具对（toolCalls/TOOL）完整无孤儿', async () => {
  const { deps, sentCalls } = makeDeps({ loadRecord: makeRecord(makeHistory()) })
  const engine = new ChatEngine(deps)
  await engine.loadSession('s1')

  // 3 条 user：切点 = 倒数第 2 条 user（'那部署呢'@14:10）的前一条（'结论：方案A'@14:03）
  const { checkpoint } = await engine.compactHistory()
  assert.equal(checkpoint.upToTimestamp, D(14, 3).toISOString())

  await engine.sendMessage({ text: '压缩后追问' })
  const history = sentHistory(sentCalls[sentCalls.length - 1])
  // 切点后含第 2 轮完整工具对（tc-2）：assistant toolCalls 与 TOOL 都在、顺序正确
  const texts = history.map((m) => (typeof m.content === 'string' ? m.content : ''))
  assert.ok(texts.includes('查一下部署文档'))
  assert.ok(texts.includes('文档内容'))
  assertToolPairing(history)
})

test('二次压缩：转录 = 旧总结 + 增量消息，发送视图只有最新总结（不嵌套）', async () => {
  const { deps, sentCalls, compactionCalls } = makeDeps({
    loadRecord: makeRecord(makeHistory()),
    compactionSummaries: [SUMMARY1, SUMMARY2],
  })
  const engine = new ChatEngine(deps)
  await engine.loadSession('s1')

  await engine.compactHistory()
  await engine.sendMessage({ text: '压缩间的新问题' })
  await engine.compactHistory()
  assert.equal(engine.getSessionState().compactions.length, 2)

  // 第二次压缩的转录：含旧总结，增量只覆盖 (14:13, 新切点]——含 u2 轮、不含 u1 轮
  const secondPrompt = compactionCalls[1][1].content as string
  assert.ok(secondPrompt.includes('【此前压缩摘要】'))
  assert.ok(secondPrompt.includes(SUMMARY1))
  assert.ok(secondPrompt.includes('那部署呢'))
  assert.ok(!secondPrompt.includes('讨论写边界审批设计'))

  // 发送视图：恰好一条合成总结消息，内容是最新总结（摘要的摘要不嵌套）
  await engine.sendMessage({ text: '第二问' })
  const history = sentHistory(sentCalls[sentCalls.length - 1])
  const synthetics = history.filter(
    (m) => typeof m.content === 'string' && m.content.includes('【历史压缩摘要】')
  )
  assert.equal(synthetics.length, 1)
  assert.ok((synthetics[0].content as string).includes(SUMMARY2))
  assertToolPairing(history)
})

test('护栏：历史太短 / 后台任务在途 / 生成进行中，均拒绝压缩', async (t) => {
  // 历史太短（不足 3 条 user 消息）
  const short = makeDeps({
    loadRecord: makeRecord([
      { role: USER, content: 'u1', timestamp: D(14, 0) },
      { role: ASSISTANT, content: 'a1', timestamp: D(14, 1) },
      { role: USER, content: 'u2', timestamp: D(14, 2) },
      { role: ASSISTANT, content: 'a2', timestamp: D(14, 3) },
    ]),
  })
  const engineShort = new ChatEngine(short.deps)
  await engineShort.loadSession('s1')
  await assert.rejects(engineShort.compactHistory(), /历史太短/)

  // 后台任务在途
  resetTaskRegistry()
  t.after(() => resetTaskRegistry())
  const busy = makeDeps({ loadRecord: makeRecord(makeHistory()) })
  const engineBusy = new ChatEngine(busy.deps)
  await engineBusy.loadSession('s1')
  getTaskRegistry().register({
    taskId: 'task-x',
    toolCallId: 'tc-x',
    subagentType: 'code-reviewer',
    description: '在途任务',
    batchId: 'b1',
  })
  await assert.rejects(engineBusy.compactHistory(), /后台任务/)
  resetTaskRegistry()

  // 生成进行中
  const running = makeDeps({ loadRecord: makeRecord(makeHistory()) })
  running.deps.modelCaller.callOnce = () => new Promise(() => {}) // 永不返回
  const engineRunning = new ChatEngine(running.deps)
  await engineRunning.loadSession('s1')
  const turn = engineRunning.sendMessage({ text: '触发中' })
  // 等 sendMessage 真正进入 running 状态（否则护栏检查会赶在置位之前）
  const start = Date.now()
  while (!engineRunning.getSessionState().isRunning) {
    if (Date.now() - start > 3000) throw new Error('等待 running 超时')
    await new Promise((r) => setTimeout(r, 20))
  }
  await assert.rejects(engineRunning.compactHistory(), /生成进行中/)
  engineRunning.abort()
  await turn
})

test('失败零副作用：模型调用降级链耗尽后抛错，记录完全不动', async () => {
  const { deps, savedRecords } = makeDeps({
    loadRecord: makeRecord(makeHistory()),
    compactionSummaries: [new Error('overflow'), new Error('overflow'), new Error('overflow'), new Error('overflow'), new Error('overflow'), new Error('overflow')],
  })
  const engine = new ChatEngine(deps)
  await engine.loadSession('s1')
  const savesBefore = savedRecords.length
  const historyBefore = engine.getHistory().length

  await assert.rejects(engine.compactHistory(), /压缩失败/)
  assert.equal(engine.getSessionState().compactions.length, 0)
  assert.equal(engine.getHistory().length, historyBefore)
  assert.equal(savedRecords.length, savesBefore) // persist 未被调用
})

test('recall_archived_context：时间段/关键词过滤、连带上下文、总量截断、无参数返回索引', async () => {
  const { deps, getProvider } = makeDeps({ loadRecord: makeRecord(makeHistory()) })
  const engine = new ChatEngine(deps)
  await engine.loadSession('s1')
  // 引擎构造时已向 executor 注册取数回调
  assert.ok(getProvider())

  // 无 checkpoint：防御性提示
  assert.ok(engine.recallArchivedContext({}).includes('没有压缩历史'))

  await engine.compactHistory()

  // 不带参数：返回主题索引 + 用法
  const menu = engine.recallArchivedContext({})
  assert.ok(menu.includes('- 写边界讨论（14:00–14:03）'))
  assert.ok(menu.includes('keyword'))

  // 关键词命中：连带后 1 条（保住问答对）；切点之后的消息不在检索范围
  const byKeyword = engine.recallArchivedContext({ keyword: '写边界' })
  assert.ok(byKeyword.includes('[14:00] 用户: 讨论写边界审批设计'))
  assert.ok(byKeyword.includes('我先读一下代码'))
  assert.ok(!byKeyword.includes('那部署呢'))

  // 时间段过滤
  const byTime = engine.recallArchivedContext({ from: '14:01', to: '14:02' })
  assert.ok(byTime.includes('[14:01] 助手:'))
  assert.ok(byTime.includes('[14:02] 工具:'))
  assert.ok(!byTime.includes('[14:00]'))

  // 未命中
  assert.ok(engine.recallArchivedContext({ keyword: '不存在的关键词' }).includes('未命中'))

  // 总量截断：从最新往前保留并提示
  const truncated = engine.recallArchivedContext({ maxChars: 60 })
  assert.ok(truncated.includes('已按 max_chars=60 截断'))
  assert.ok(truncated.length < 60 + 100)

  // executor 注册回调与引擎接口一致（工具执行分支的转调目标）
  assert.equal(getProvider()!({ keyword: '写边界' }), byKeyword)
})
