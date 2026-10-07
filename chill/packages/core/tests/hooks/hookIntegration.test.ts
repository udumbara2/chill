import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ChatEngine } from '../../src/engine/ChatEngine.ts'
import type { ChatEngineDeps } from '../../src/engine/types.ts'
import { BuiltInToolExecutor } from '../../src/services/builtInToolExecutor.ts'
import { getApprovalChannel, resetApprovalChannel } from '../../src/services/approvals.ts'
import type { ApprovalRequestPayload } from '../../src/services/approvals.ts'
import { resetWriteBoundary } from '../../src/services/writeBoundary.ts'
import { eventBus, EVENTS } from '../../src/utils/eventBus.ts'
import { HookConfigLoader } from '../../src/services/hooks/HookConfigLoader.ts'
import { HookRunner } from '../../src/services/hooks/HookRunner.ts'
import type { IHookProcessRunner, HookProcessResult } from '../../src/services/hooks/IHookProcessRunner.ts'
import type { IFileSystemProvider } from '../../src/interfaces/IFileSystemProvider.ts'

/**
 * hooks 系统 core 集成测试（阶段 1 挂载点）：
 * PreToolUse deny/transform/单触发、PostToolUse、PermissionRequest allow/deny、
 * SessionStart 首轮注入、UserPromptSubmit deny/注入、Worker 咽喉来源互斥。
 * 真实 HookRunner + 假执行通道（FakeRunner）；引擎侧用最小 fake deps（模式同 goalMode.test.ts），
 * executor 侧用真实 BuiltInToolExecutor（模式同 powershellApproval.test.ts / writeToolsBoundary.test.ts）。
 */

const CONFIG_PATH = '/home/user/.chill/hooks.json'

/** 内存假 fsProvider（HookConfigLoader 用） */
function makeFakeFs(files: Map<string, string>): IFileSystemProvider {
  return {
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
    getPathType: async () => ({ success: true, data: { type: 'file' as const } }),
  }
}

/** 假执行通道：记录调用（input 已解析），按 responder 返回 */
class FakeRunner implements IHookProcessRunner {
  calls: Array<{ command: string; input: Record<string, unknown> }> = []
  responder: (input: Record<string, unknown>) => HookProcessResult

  constructor(responder: FakeRunner['responder']) {
    this.responder = responder
  }

  async run(command: string, inputJson: string): Promise<HookProcessResult> {
    const input = JSON.parse(inputJson) as Record<string, unknown>
    this.calls.push({ command, input })
    return this.responder(input)
  }
}

const ok = (stdout = ''): HookProcessResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false })
const block = (reason: string): HookProcessResult => ({ exitCode: 2, stdout: '', stderr: reason, timedOut: false })

/** 组装真实 HookRunner（假 fs 配置 + 假执行通道） */
function makeHookRunner(config: unknown, responder: FakeRunner['responder']) {
  const files = new Map<string, string>()
  files.set(CONFIG_PATH, JSON.stringify(config))
  const loader = new HookConfigLoader(makeFakeFs(files), CONFIG_PATH)
  const fakeRunner = new FakeRunner(responder)
  const runner = new HookRunner({ loader, processRunner: fakeRunner })
  return { runner, fakeRunner }
}

// ==================== 引擎侧挂载点（ChatEngine） ====================

interface EngineEnvOptions {
  responder: FakeRunner['responder']
  /** 模型首轮返回的工具调用（缺省无工具调用直接收尾） */
  firstTurnToolCalls?: Array<{ id: string; name: string; arguments: string }>
}

/** 最小 fake deps 的引擎环境（executor 为门面假实现，记录调用） */
function makeEngineEnv(config: unknown, options: EngineEnvOptions) {
  const { runner, fakeRunner } = makeHookRunner(config, options.responder)
  const events: Array<{ event: string; payload: any }> = []
  const modelCalls: Array<{ messages: any[] }> = []
  const executorCalls: Array<{ toolName: string; args: string }> = []
  const injected: { runner?: unknown; contextProvider?: () => { sessionId: string; cwd: string } } = {}
  let firstCall = true

  const deps: ChatEngineDeps = {
    modelCaller: {
      callOnce: async (params: any) => {
        modelCalls.push({ messages: params.messages })
        if (firstCall && options.firstTurnToolCalls) {
          firstCall = false
          return {
            content: '',
            toolCalls: options.firstTurnToolCalls.map((tc) => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: tc.arguments },
            })),
          }
        }
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
      load: async () => ({ success: false }),
    } as any,
    builtInToolExecutor: {
      execute: () => ({ success: true, data: { content: 'sync-result' } }),
      executeAsync: async (toolName: string, args: string) => {
        executorCalls.push({ toolName, args })
        return { success: true, data: { content: `result-of-${toolName}` } }
      },
      setPlanMode: () => {},
      getAutoApply: () => false,
      getNonInteractiveMode: () => null,
      applyAutoApplyBatch: async () => new Map(),
      setHookRunner: (r: unknown) => {
        injected.runner = r
      },
      setHookContextProvider: (p: () => { sessionId: string; cwd: string }) => {
        injected.contextProvider = p
      },
    } as any,
    mcpService: { getAggregatedOpenAITools: async () => [] } as any,
    eventBus: { on: () => {}, off: () => {}, emit: (event: string, payload: any) => events.push({ event, payload }) },
    hookRunner: runner,
    workDir: '/proj',
  }
  return { deps, runner, fakeRunner, events, modelCalls, executorCalls, injected }
}

test('PreToolUse deny：工具不执行，原因经工具结果 error 反馈模型', async () => {
  const { deps, fakeRunner, executorCalls } = makeEngineEnv(
    { hooks: { PreToolUse: [{ matcher: 'read_file', hooks: [{ command: 'guard.mjs' }] }] } },
    {
      responder: () => block('该文件禁止读取'),
      firstTurnToolCalls: [{ id: 'tc1', name: 'read_file', arguments: '{"path":"secret.txt"}' }],
    },
  )
  const engine = new ChatEngine(deps)
  const result = await engine.sendMessage({ text: '读一下 secret.txt' })

  assert.equal(executorCalls.length, 0, 'deny 后工具不应执行')
  const toolMsg = result.producedMessages.find((m) => m.role === 'tool')
  assert.ok(toolMsg, '应有失败 TOOL 消息反馈模型')
  assert.match(String(toolMsg!.content), /该文件禁止读取/)
  assert.equal(toolMsg!.toolCallStatus, 'failed')
  // 单触发：一次工具调用只过一次 PreToolUse（主会话挂点），PostToolUse 不触发（未执行）
  const preCalls = fakeRunner.calls.filter((c) => c.input.hook_event_name === 'PreToolUse')
  const postCalls = fakeRunner.calls.filter((c) => c.input.hook_event_name === 'PostToolUse')
  assert.equal(preCalls.length, 1)
  assert.equal(postCalls.length, 0)
  engine.dispose()
})

test('PreToolUse transform：改写入参后按新参数执行；PostToolUse 成功路径触发一次', async () => {
  const { deps, executorCalls, fakeRunner } = makeEngineEnv(
    {
      hooks: {
        PreToolUse: [{ matcher: 'read_file', hooks: [{ command: 'rewrite.mjs' }] }],
        PostToolUse: [{ matcher: 'read_file', hooks: [{ command: 'audit.mjs' }] }],
      },
    },
    {
      responder: (input) =>
        input.hook_event_name === 'PreToolUse'
          ? ok(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { path: '/safe/redirected.txt' } } }))
          : ok(),
      firstTurnToolCalls: [{ id: 'tc1', name: 'read_file', arguments: '{"path":"secret.txt"}' }],
    },
  )
  const engine = new ChatEngine(deps)
  const result = await engine.sendMessage({ text: '读文件' })

  assert.equal(executorCalls.length, 1)
  const executedArgs = JSON.parse(executorCalls[0].args)
  assert.equal(executedArgs.path, '/safe/redirected.txt', '执行的是改写后的入参')
  assert.ok(executedArgs.__origin?.handle, '2.1 主会话注入 __origin 归因（保留字段，业务字段不失真）')
  const toolMsg = result.producedMessages.find((m) => m.role === 'tool')
  assert.equal(toolMsg!.toolCallStatus, 'success')
  // Pre/Post 各一次（单触发）
  assert.equal(fakeRunner.calls.filter((c) => c.input.hook_event_name === 'PreToolUse').length, 1)
  assert.equal(fakeRunner.calls.filter((c) => c.input.hook_event_name === 'PostToolUse').length, 1)
  engine.dispose()
})

test('UserPromptSubmit deny：消息丢弃、模型不调用、HOOK_MESSAGE 告知用户', async () => {
  const { deps, events, modelCalls } = makeEngineEnv(
    { hooks: { UserPromptSubmit: [{ hooks: [{ command: 'filter.mjs' }] }] } },
    { responder: () => block('输入包含密钥') },
  )
  const engine = new ChatEngine(deps)
  const result = await engine.sendMessage({ text: '我的 key 是 sk-xxx' })

  assert.equal(modelCalls.length, 0, 'deny 后不应调用模型')
  assert.deepEqual(result.producedMessages, [])
  assert.equal(engine.getHistory().length, 0, '消息不入历史')
  const hookEvents = events.filter((e) => e.event === EVENTS.HOOK_MESSAGE)
  assert.ok(hookEvents.some((e) => String(e.payload.messages).includes('已拦截该消息：输入包含密钥')))
  // stdin 协议：prompt 字段透传（Claude 兼容）
  engine.dispose()
})

test('UserPromptSubmit additionalContext：注入本轮上下文（首轮组装可见）', async () => {
  const { deps, modelCalls, fakeRunner } = makeEngineEnv(
    { hooks: { UserPromptSubmit: [{ hooks: [{ command: 'ctx.mjs' }] }] } },
    {
      responder: () =>
        ok(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'INJECTED-PROMPT-CTX' } })),
    },
  )
  const engine = new ChatEngine(deps)
  await engine.sendMessage({ text: '提交代码' })

  assert.ok(modelCalls.length >= 1)
  const systemTexts = modelCalls[0].messages.filter((m) => m.role === 'system').map((m) => String(m.content))
  assert.ok(systemTexts.some((t) => t.includes('INJECTED-PROMPT-CTX')), '注入内容应在首轮组装上下文中')
  assert.equal(fakeRunner.calls[0].input.prompt, '提交代码', 'prompt 字段应随 stdin 透传')
  engine.dispose()
})

test('SessionStart：startNewSession 登记 startup，首轮组装 await 注入 additionalContext', async () => {
  const { deps, modelCalls, fakeRunner } = makeEngineEnv(
    { hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ command: 'env.sh' }] }] } },
    { responder: () => ok('GIT-STATUS-MARKER') },
  )
  const engine = new ChatEngine(deps)
  engine.startNewSession()
  await engine.sendMessage({ text: '你好' })

  const sessionStartCalls = fakeRunner.calls.filter((c) => c.input.hook_event_name === 'SessionStart')
  assert.equal(sessionStartCalls.length, 1, 'SessionStart 只触发一次')
  assert.equal(sessionStartCalls[0].input.matcher_value, 'startup')
  const systemTexts = modelCalls[0].messages.filter((m) => m.role === 'system').map((m) => String(m.content))
  assert.ok(systemTexts.some((t) => t.includes('GIT-STATUS-MARKER')), '纯文本 stdout 应注入首轮上下文')
  engine.dispose()
})

test('SessionStart：matcher 不匹配（resume vs startup）时首轮无注入、零 spawn', async () => {
  const { deps, modelCalls, fakeRunner } = makeEngineEnv(
    { hooks: { SessionStart: [{ matcher: 'resume', hooks: [{ command: 'env.sh' }] }] } },
    { responder: () => ok('SHOULD-NOT-APPEAR') },
  )
  const engine = new ChatEngine(deps)
  engine.startNewSession()
  await engine.sendMessage({ text: '你好' })

  assert.equal(fakeRunner.calls.length, 0, 'matcher 不命中不 spawn')
  const all = modelCalls[0].messages.map((m) => String(m.content)).join('\n')
  assert.ok(!all.includes('SHOULD-NOT-APPEAR'))
  engine.dispose()
})

test('引擎装配：hookRunner 透传 executor（Worker 咽喉依赖），会话上下文闭包注册', async () => {
  const { deps, injected } = makeEngineEnv({ hooks: {} }, { responder: () => ok() })
  const engine = new ChatEngine(deps)
  assert.ok(injected.runner, 'setHookRunner 应被引擎调用')
  assert.ok(injected.contextProvider, 'setHookContextProvider 应被引擎调用')
  engine.dispose()
})

// ==================== executor 侧挂载点（PermissionRequest 减码槽 + Worker 咽喉） ====================

/** read_file 可用的假 fsProvider（记录读取路径；list_files 等需要完整形状的实现，worker 测试统一用 read_file） */
function makeWorkerFs(readPaths: string[]) {
  return {
    getCurrentDirectory: () => 'C:\\proj',
    fileExists: async () => ({ success: true, data: true }),
    readFile: async (p: string) => {
      readPaths.push(p)
      return { success: true, data: { content: `content-of-${p}` } }
    },
    writeFile: async () => ({ success: true }),
    deleteFile: async () => ({ success: true }),
    getPathType: async () => ({ success: true, data: { type: 'file' as const } }),
    listDirectory: async () => ({ success: true, data: [] }),
  }
}

function makeRealExecutorEnv(config: unknown, responder: FakeRunner['responder']) {
  const { runner, fakeRunner } = makeHookRunner(config, responder)
  const calls: Array<{ command: string }> = []
  const readPaths: string[] = []
  const codeExecutor = {
    executePowerShell: async (command: string) => {
      calls.push({ command })
      return { success: true, output: `ok:${command}` }
    },
  }
  const executor = new BuiltInToolExecutor(makeWorkerFs(readPaths) as any, {} as any, {} as any, codeExecutor as any)
  executor.setHookRunner(runner)
  executor.setHookContextProvider(() => ({ sessionId: 's1', cwd: '/proj' }))
  return { executor, fakeRunner, calls, readPaths }
}

function watchApprovals(t: { after: (fn: () => void) => void }): ApprovalRequestPayload[] {
  const captured: ApprovalRequestPayload[] = []
  const listener = (p: ApprovalRequestPayload) => captured.push(p)
  eventBus.on(EVENTS.APPROVAL_REQUESTED, listener)
  t.after(() => {
    eventBus.off(EVENTS.APPROVAL_REQUESTED, listener)
    resetApprovalChannel()
    resetWriteBoundary()
  })
  return captured
}

test('PermissionRequest allow：白名单自动批准跳过弹窗，直接执行', async (t) => {
  const approvals = watchApprovals(t)
  const { executor, calls } = makeRealExecutorEnv(
    {
      hooks: {
        PermissionRequest: [
          {
            matcher: 'execute_powershell',
            hooks: [{ command: 'whitelist.mjs' }],
          },
        ],
      },
    },
    () => ok(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', permissionDecision: 'allow' } })),
  )

  const result = await executor.executeAsync(
    'execute_powershell',
    JSON.stringify({ command: 'git status', purpose: 'p', intent: 'i' }),
    'tc-pr1',
  )
  assert.equal(result.success, true)
  assert.equal(calls.length, 1, '命令应直接执行')
  assert.equal(approvals.length, 0, 'hook allow 后不弹审批')
})

test('PermissionRequest 无 hook 决策（hook 无意见）：照常弹审批', async (t) => {
  const approvals = watchApprovals(t)
  const { executor } = makeRealExecutorEnv(
    { hooks: { PermissionRequest: [{ matcher: 'execute_powershell', hooks: [{ command: 'noop.mjs' }] }] } },
    () => ok(), // exit 0 无输出 = 无意见
  )

  const pending = executor.executeAsync(
    'execute_powershell',
    JSON.stringify({ command: 'git status', purpose: 'p', intent: 'i' }),
    'tc-pr2',
  )
  // hook 派发是异步的，审批请求在微任务后发射（无 runner 的既有路径仍保持同步发射，见回归测试）
  await new Promise((r) => setImmediate(r))
  assert.equal(approvals.length, 1, '无 hook 决策时必须走人工审批')
  getApprovalChannel().resolve('tc-pr2', { approved: true })
  const result = await pending
  assert.equal(result.success, true)
})

test('PermissionRequest deny：hook 拒绝，不执行不弹窗', async (t) => {
  const approvals = watchApprovals(t)
  const { executor, calls } = makeRealExecutorEnv(
    { hooks: { PermissionRequest: [{ matcher: 'execute_powershell', hooks: [{ command: 'deny.mjs' }] }] } },
    () => block('公司策略禁止该命令'),
  )

  const result = await executor.executeAsync(
    'execute_powershell',
    JSON.stringify({ command: 'git status', purpose: 'p', intent: 'i' }),
    'tc-pr3',
  )
  assert.equal(result.success, false)
  assert.match(result.error!, /hook 拒绝执行: 公司策略禁止该命令/)
  assert.equal(calls.length, 0)
  assert.equal(approvals.length, 0)
})

test('PermissionRequest allow 不免审危险命令（commandSafety 硬安全不可覆盖）', async (t) => {
  const approvals = watchApprovals(t)
  const { executor } = makeRealExecutorEnv(
    {
      hooks: {
        PermissionRequest: [
          { matcher: 'execute_powershell', hooks: [{ command: 'whitelist.mjs' }] },
        ],
      },
    },
    () => ok(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', permissionDecision: 'allow' } })),
  )

  const pending = executor.executeAsync(
    'execute_powershell',
    JSON.stringify({ command: 'rm -rf /', purpose: 'p', intent: 'i' }),
    'tc-pr4',
  )
  await new Promise((r) => setImmediate(r)) // 等 hook 派发完成
  assert.equal(approvals.length, 1, '危险命令即使 hook allow 也必须弹审批')
  getApprovalChannel().resolve('tc-pr4', { approved: false, reason: '太危险' })
  const result = await pending
  assert.equal(result.success, false)
})

test('Worker 咽喉：subagent 来源触发 Pre/Post 各一次；主会话来源咽喉零触发（来源互斥）', async (t) => {
  watchApprovals(t)
  const { executor, fakeRunner, readPaths } = makeRealExecutorEnv(
    {
      hooks: {
        PreToolUse: [{ hooks: [{ command: 'pre.mjs' }] }],
        PostToolUse: [{ hooks: [{ command: 'post.mjs' }] }],
      },
    },
    () => ok(),
  )

  // 主会话来源（无 __origin）：咽喉短路，hooks 不触发（主会话挂点在 executeOneToolCall）
  const mainResult = await executor.executeAsync('read_file', JSON.stringify({ path: '/x.txt' }))
  assert.equal(mainResult.success, true)
  assert.equal(readPaths.length, 1)
  assert.equal(fakeRunner.calls.length, 0, '主会话调用不应在 executor 咽喉触发 hooks')

  // Worker 来源（__origin.source='subagent'，网关注入）：Pre/Post 各一次
  const workerResult = await executor.executeAsync(
    'read_file',
    JSON.stringify({ path: '/y.txt', __origin: { source: 'subagent', taskId: 'task-1' } }),
    'tc-w1',
  )
  assert.equal(workerResult.success, true)
  const preCalls = fakeRunner.calls.filter((c) => c.input.hook_event_name === 'PreToolUse')
  const postCalls = fakeRunner.calls.filter((c) => c.input.hook_event_name === 'PostToolUse')
  assert.equal(preCalls.length, 1, 'Worker 调用 PreToolUse 恰好一次')
  assert.equal(postCalls.length, 1, 'Worker 调用 PostToolUse 恰好一次')
  assert.equal(preCalls[0].input.session_id, 's1', '会话上下文闭包提供 sessionId')
})

test('Worker 咽喉 PreToolUse deny：工具不执行，原因返回；transform 保留 __origin 归属', async (t) => {
  watchApprovals(t)
  // deny 分支
  const denyEnv = makeRealExecutorEnv(
    { hooks: { PreToolUse: [{ matcher: 'read_file', hooks: [{ command: 'deny.mjs' }] }] } },
    () => block('worker 禁止该操作'),
  )
  const denied = await denyEnv.executor.executeAsync(
    'read_file',
    JSON.stringify({ path: '/x.txt', __origin: { source: 'subagent', taskId: 'task-1' } }),
    'tc-w2',
  )
  assert.equal(denied.success, false)
  assert.match(denied.error!, /worker 禁止该操作/)
  assert.equal(denyEnv.readPaths.length, 0, 'deny 后工具不应执行')

  // transform 分支：改写 path，__origin 强制带回（hook 不可改写归属）
  const transformEnv = makeRealExecutorEnv(
    { hooks: { PreToolUse: [{ matcher: 'read_file', hooks: [{ command: 'rewrite.mjs' }] }] } },
    (input) => {
      // hook 看到的入参含 __origin（透传），改写只给业务字段
      assert.ok((input.tool_input as any).__origin?.source === 'subagent')
      return ok(
        JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { path: '/rewritten.txt' } } }),
      )
    },
  )
  const transformed = await transformEnv.executor.executeAsync(
    'read_file',
    JSON.stringify({ path: '/x.txt', __origin: { source: 'subagent', taskId: 'task-1' } }),
    'tc-w3',
  )
  assert.equal(transformed.success, true)
  assert.deepEqual(transformEnv.readPaths, ['/rewritten.txt'], '改写后的 path 应生效')
})
