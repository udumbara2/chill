import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HookConfigLoader } from '../../src/services/hooks/HookConfigLoader.ts'
import { HookRunner, MAX_HOOK_INVOCATIONS } from '../../src/services/hooks/HookRunner.ts'
import type { HookDispatchContext } from '../../src/services/hooks/HookRunner.ts'
import type { IHookProcessRunner, HookProcessResult } from '../../src/services/hooks/IHookProcessRunner.ts'
import type { IFileSystemProvider } from '../../src/interfaces/IFileSystemProvider.ts'
import type { IKeyValueStore } from '../../src/interfaces/IKeyValueStore.ts'

const CONFIG_PATH = '/home/user/.chill/hooks.json'

/** 内存假 fsProvider */
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

/** 假执行通道：记录调用，按 responder 返回结果 */
class FakeRunner implements IHookProcessRunner {
  calls: Array<{ command: string; input: Record<string, unknown>; timeoutMs: number }> = []
  responder: (command: string, input: Record<string, unknown>) => Promise<HookProcessResult> | HookProcessResult

  constructor(responder: FakeRunner['responder']) {
    this.responder = responder
  }

  async run(command: string, inputJson: string, timeoutMs: number): Promise<HookProcessResult> {
    const input = JSON.parse(inputJson) as Record<string, unknown>
    this.calls.push({ command, input, timeoutMs })
    return this.responder(command, input)
  }
}

const ok = (stdout = ''): HookProcessResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false })
const block = (reason: string): HookProcessResult => ({ exitCode: 2, stdout: '', stderr: reason, timedOut: false })

function makeKv(): IKeyValueStore & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  }
}

interface EnvOptions {
  responder?: FakeRunner['responder']
  kv?: IKeyValueStore
  mtime?: number | null
}

/** 组装 HookRunner：假 fs（内含配置）+ 假 mtime + 假执行通道 */
function makeEnv(config: unknown, opts: EnvOptions = {}) {
  const files = new Map<string, string>()
  if (config !== null) {
    files.set(CONFIG_PATH, typeof config === 'string' ? config : JSON.stringify(config))
  }
  const mtimeState = { value: opts.mtime === undefined ? 1000 : opts.mtime }
  const loader = new HookConfigLoader(makeFakeFs(files), CONFIG_PATH, {
    getMtimeMs: async () => mtimeState.value,
  })
  const fakeRunner = new FakeRunner(opts.responder ?? (() => ok()))
  const runner = new HookRunner({ loader, processRunner: fakeRunner, kv: opts.kv })
  return { runner, loader, fakeRunner, files, mtimeState }
}

const TOOL_CTX: HookDispatchContext = {
  sessionId: 's1',
  cwd: '/proj',
  toolName: 'execute_powershell',
  toolInput: { command: 'ls' },
}

// ---------- matcher 匹配 ----------

test('无配置：verdict allow，零 spawn（零开销基线）', async () => {
  const { runner, fakeRunner } = makeEnv(null)
  const result = await runner.dispatch('PreToolUse', TOOL_CTX)
  assert.equal(result!.verdict.type, 'allow')
  assert.equal(fakeRunner.calls.length, 0)
})

test('matcher 正则命中工具名才执行；不命中零 spawn', async () => {
  const config = {
    hooks: {
      PreToolUse: [
        { matcher: 'execute_powershell', hooks: [{ command: 'node a.mjs' }] },
        { matcher: 'write_file', hooks: [{ command: 'node b.mjs' }] },
      ],
    },
  }
  const { runner, fakeRunner } = makeEnv(config)
  await runner.dispatch('PreToolUse', TOOL_CTX)
  assert.deepEqual(fakeRunner.calls.map((c) => c.command), ['node a.mjs'])
})

test('matcher 空串/省略 = 全匹配', async () => {
  const config = {
    hooks: {
      PreToolUse: [
        { hooks: [{ command: 'node all.mjs' }] },
        { matcher: '', hooks: [{ command: 'node all2.mjs' }] },
      ],
    },
  }
  const { runner, fakeRunner } = makeEnv(config)
  await runner.dispatch('PreToolUse', TOOL_CTX)
  assert.equal(fakeRunner.calls.length, 2)
})

test('非法正则 matcher：fail-open 跳过该组 + 警告，不影响其他组', async () => {
  const config = {
    hooks: {
      PreToolUse: [
        { matcher: '([非法', hooks: [{ command: 'node bad.mjs' }] },
        { matcher: 'powershell', hooks: [{ command: 'node good.mjs' }] },
      ],
    },
  }
  const { runner, fakeRunner } = makeEnv(config)
  const result = await runner.dispatch('PreToolUse', TOOL_CTX)
  assert.deepEqual(fakeRunner.calls.map((c) => c.command), ['node good.mjs'])
  assert.ok(result!.systemMessages.some((m) => m.includes('正则')), '应有非法正则警告')
  assert.equal(result!.verdict.type, 'allow')
})

test('子类型事件按 matcher_value 精确相等匹配（SessionStart: startup/resume）', async () => {
  const config = {
    hooks: {
      SessionStart: [
        { matcher: 'startup', hooks: [{ command: 'node on-start.mjs' }] },
        { matcher: 'resume', hooks: [{ command: 'node on-resume.mjs' }] },
      ],
    },
  }
  const { runner, fakeRunner } = makeEnv(config)
  const ctx: HookDispatchContext = { sessionId: 's1', cwd: '/proj', matcherValue: 'startup' }
  await runner.dispatch('SessionStart', ctx)
  assert.deepEqual(fakeRunner.calls.map((c) => c.command), ['node on-start.mjs'])
  assert.equal(fakeRunner.calls[0].input.matcher_value, 'startup')
})

// ---------- 决策链语义 ----------

test('exit 2 阻断：deny 熔断（bail），stderr 为 reason，后续 handler 不执行', async () => {
  const config = {
    hooks: {
      PreToolUse: [
        {
          matcher: 'powershell',
          hooks: [
            { command: 'node deny.mjs' },
            { command: 'node never.mjs' },
          ],
        },
      ],
    },
  }
  const { runner, fakeRunner } = makeEnv(config, {
    responder: (cmd) => (cmd.includes('deny') ? block('危险命令被拒绝') : ok()),
  })
  const result = await runner.dispatch('PreToolUse', TOOL_CTX)
  assert.deepEqual(result!.verdict, { type: 'deny', reason: '危险命令被拒绝' })
  assert.deepEqual(fakeRunner.calls.map((c) => c.command), ['node deny.mjs'], 'deny 后不得执行后续 handler')
})

test('updatedInput waterfall：后续 handler 看到改写后的入参，最终 verdict 为 transform', async () => {
  const config = {
    hooks: {
      PreToolUse: [
        {
          hooks: [
            { command: 'node rewrite.mjs' },
            { command: 'node observe.mjs' },
          ],
        },
      ],
    },
  }
  const { runner, fakeRunner } = makeEnv(config, {
    responder: (cmd) =>
      cmd.includes('rewrite')
        ? ok(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command: 'ls -la' } } }))
        : ok(),
  })
  const result = await runner.dispatch('PreToolUse', TOOL_CTX)
  assert.deepEqual(result!.verdict, { type: 'transform', updatedInput: { command: 'ls -la' } })
  assert.deepEqual(fakeRunner.calls[1].input.tool_input, { command: 'ls -la' }, 'waterfall：第二个 hook 收到改写后的 tool_input')
})

test('permissionDecision deny/ask/allow：deny 与 ask 熔断，allow 继续', async () => {
  const config = {
    hooks: {
      PermissionRequest: [
        {
          matcher: 'powershell',
          hooks: [
            { command: 'node ask.mjs' },
            { command: 'node never.mjs' },
          ],
        },
      ],
    },
  }
  const { runner, fakeRunner } = makeEnv(config, {
    responder: () =>
      ok(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', permissionDecision: 'ask' }, reason: '需要人工确认' })),
  })
  const result = await runner.dispatch('PermissionRequest', TOOL_CTX)
  assert.deepEqual(result!.verdict, { type: 'ask', reason: '需要人工确认' })
  assert.equal(fakeRunner.calls.length, 1, 'ask 熔断后续 handler')

  const env2 = makeEnv(
    {
      hooks: {
        PermissionRequest: [
          {
            matcher: 'powershell',
            hooks: [{ command: 'node allow.mjs' }, { command: 'node also.mjs' }],
          },
        ],
      },
    },
    {
      responder: () =>
        ok(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', permissionDecision: 'allow' } })),
    }
  )
  const result2 = await env2.runner.dispatch('PermissionRequest', TOOL_CTX)
  assert.equal(result2!.verdict.type, 'allow')
  assert.equal(env2.fakeRunner.calls.length, 2, 'allow 不熔断')
})

test('顶层 decision:block 与 continue:false 均判 deny', async () => {
  const config = { hooks: { Stop: [{ hooks: [{ command: 'node check.mjs' }] }] } }
  const ctx: HookDispatchContext = { sessionId: 's1', cwd: '/proj' }

  const env1 = makeEnv(config, { responder: () => ok(JSON.stringify({ decision: 'block', reason: '测试未通过' })) })
  const r1 = await env1.runner.dispatch('Stop', ctx)
  assert.deepEqual(r1!.verdict, { type: 'deny', reason: '测试未通过' })

  const env2 = makeEnv(config, { responder: () => ok(JSON.stringify({ continue: false, reason: '停下来' })) })
  const r2 = await env2.runner.dispatch('Stop', ctx)
  assert.deepEqual(r2!.verdict, { type: 'deny', reason: '停下来' })
})

test('additionalContext 全部拼接（保持执行顺序），systemMessage 单独收集', async () => {
  const config = {
    hooks: {
      SessionStart: [
        {
          hooks: [
            { command: 'node git-status.mjs' },
            { command: 'node todos.mjs' },
          ],
        },
      ],
    },
  }
  const { runner } = makeEnv(config, {
    responder: (cmd) =>
      cmd.includes('git-status')
        ? ok(JSON.stringify({ hookSpecificOutput: { additionalContext: '分支: master' }, systemMessage: 'git 状态已注入' }))
        : ok(JSON.stringify({ hookSpecificOutput: { additionalContext: 'TODO: 3 项' } })),
  })
  const result = await runner.dispatch('SessionStart', { sessionId: 's1', cwd: '/proj', matcherValue: 'startup' })
  assert.deepEqual(result!.additionalContext, ['分支: master', 'TODO: 3 项'])
  assert.deepEqual(result!.systemMessages, ['git 状态已注入'])
})

test('exit 0 但 stdout 非 JSON：污染容错，按纯文本 additionalContext 处理', async () => {
  const config = { hooks: { SessionStart: [{ hooks: [{ command: 'node plain.mjs' }] }] } }
  const { runner } = makeEnv(config, { responder: () => ok('当前分支 master，3 个未提交文件') })
  const result = await runner.dispatch('SessionStart', { sessionId: 's1', cwd: '/proj' })
  assert.deepEqual(result!.additionalContext, ['当前分支 master，3 个未提交文件'])
  assert.equal(result!.verdict.type, 'allow')
})

test('其他退出码：非阻断警告，verdict allow', async () => {
  const config = { hooks: { PreToolUse: [{ hooks: [{ command: 'node buggy.mjs' }] }] } }
  const { runner } = makeEnv(config, {
    responder: () => ({ exitCode: 1, stdout: '', stderr: '脚本报错了', timedOut: false }),
  })
  const result = await runner.dispatch('PreToolUse', TOOL_CTX)
  assert.equal(result!.verdict.type, 'allow')
  assert.ok(result!.systemMessages.some((m) => m.includes('退出码 1') && m.includes('脚本报错了')))
})

// ---------- 超时 / 异常 / failClosed ----------

test('超时 fail-open：警告放行；failClosed:true 时按 deny 处理', async () => {
  const config = {
    hooks: {
      PreToolUse: [
        {
          hooks: [
            { command: 'node slow.mjs', timeout: 3 },
            { command: 'node strict.mjs', timeout: 3, failClosed: true },
          ],
        },
      ],
    },
  }
  const { runner, fakeRunner } = makeEnv(config, {
    responder: () => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }),
  })
  const result = await runner.dispatch('PreToolUse', TOOL_CTX)
  // 第一个 fail-open（警告），第二个 failClosed → deny 熔断
  assert.equal(result!.verdict.type, 'deny')
  assert.match((result!.verdict as { reason: string }).reason, /超时.*failClosed/)
  assert.ok(result!.systemMessages.some((m) => m.includes('fail-open')))
  assert.equal(fakeRunner.calls[0].timeoutMs, 3000, 'handler.timeout（秒）换算为毫秒')
})

test('执行通道抛异常 / exitCode null：fail-open 警告放行', async () => {
  const config = { hooks: { PreToolUse: [{ hooks: [{ command: 'node x.mjs' }] }] } }

  const env1 = makeEnv(config, {
    responder: () => {
      throw new Error('spawn ENOENT')
    },
  })
  const r1 = await env1.runner.dispatch('PreToolUse', TOOL_CTX)
  assert.equal(r1!.verdict.type, 'allow')
  assert.ok(r1!.systemMessages.some((m) => m.includes('spawn ENOENT')))

  const env2 = makeEnv(config, { responder: () => ({ exitCode: null, stdout: '', stderr: '', timedOut: false }) })
  const r2 = await env2.runner.dispatch('PreToolUse', TOOL_CTX)
  assert.equal(r2!.verdict.type, 'allow')
  assert.ok(r2!.systemMessages.some((m) => m.includes('未能正常退出')))
})

// ---------- 通知事件 ----------

test('通知事件：并行 fire-and-forget，返回 null，阻断输出被忽略但记录触发', async () => {
  const config = {
    hooks: {
      SessionEnd: [
        {
          hooks: [
            { command: 'node backup.mjs' },
            { command: 'node weird.mjs' },
          ],
        },
      ],
    },
  }
  const { runner, fakeRunner } = makeEnv(config, {
    responder: (cmd) => (cmd.includes('weird') ? block('这条输出应被忽略') : ok('随意输出')),
  })
  const result = await runner.dispatch('SessionEnd', { sessionId: 's1', cwd: '/proj' })
  assert.equal(result, null, '通知事件无聚合返回')
  assert.equal(fakeRunner.calls.length, 2, '两个 handler 都执行')
  const invocations = runner.getRecentInvocations()
  assert.equal(invocations.length, 2)
  assert.ok(invocations.every((i) => i.event === 'SessionEnd'))
})

// ---------- 禁用状态 ----------

test('禁用状态：KV 预置 hooks.disabled 的 handler 不执行；disable/enable 持久化', async () => {
  const config = {
    hooks: {
      PreToolUse: [
        {
          hooks: [
            { name: 'guard', command: 'node guard.mjs' },
            { command: 'node other.mjs' },
          ],
        },
      ],
    },
  }
  const kv = makeKv()
  kv.setItem('hooks.disabled', JSON.stringify(['PreToolUse:guard']))
  const { runner, fakeRunner } = makeEnv(config, { kv })

  await runner.dispatch('PreToolUse', TOOL_CTX)
  assert.deepEqual(fakeRunner.calls.map((c) => c.command), ['node other.mjs'], '被禁用的 handler 不执行')

  runner.disable('PreToolUse:node other.mjs')
  assert.deepEqual(JSON.parse(kv.map.get('hooks.disabled')!).sort(), ['PreToolUse:guard', 'PreToolUse:node other.mjs'].sort())

  fakeRunner.calls.length = 0
  runner.enable('PreToolUse:guard')
  await runner.dispatch('PreToolUse', TOOL_CTX)
  assert.deepEqual(fakeRunner.calls.map((c) => c.command), ['node guard.mjs'])
})

// ---------- 可观测性 ----------

test('环形缓冲：只保留最近 50 次，最新在前，字段完整', async () => {
  const config = { hooks: { PreToolUse: [{ matcher: 'powershell', hooks: [{ name: 'h', command: 'node h.mjs' }] }] } }
  const { runner, fakeRunner } = makeEnv(config, { responder: () => block('拒') })
  for (let i = 0; i < MAX_HOOK_INVOCATIONS + 5; i++) {
    await runner.dispatch('PreToolUse', TOOL_CTX)
  }
  const invocations = runner.getRecentInvocations()
  assert.equal(invocations.length, MAX_HOOK_INVOCATIONS)
  assert.equal(fakeRunner.calls.length, MAX_HOOK_INVOCATIONS + 5)
  const latest = invocations[0]
  assert.equal(latest.event, 'PreToolUse')
  assert.equal(latest.matcher, 'powershell')
  assert.equal(latest.handlerName, 'h')
  assert.equal(latest.command, 'node h.mjs')
  assert.equal(latest.exitCode, 2)
  assert.equal(latest.decision, 'deny')
  assert.equal(typeof latest.durationMs, 'number')
  assert.ok(typeof latest.at === 'string' && latest.at.includes('T'))
})

// ---------- 派发前惰性重载 ----------

test('每次派发前 checkReload：mtime 变化后新配置即生效', async () => {
  const configV1 = { hooks: { PreToolUse: [{ hooks: [{ command: 'node v1.mjs' }] }] } }
  const env = makeEnv(configV1, { mtime: 1000 })

  await env.runner.dispatch('PreToolUse', TOOL_CTX)
  assert.deepEqual(env.fakeRunner.calls.map((c) => c.command), ['node v1.mjs'])

  env.files.set(CONFIG_PATH, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: 'node v2.mjs' }] }] } }))
  env.mtimeState.value = 2000
  await env.runner.dispatch('PreToolUse', TOOL_CTX)
  assert.deepEqual(env.fakeRunner.calls.map((c) => c.command), ['node v1.mjs', 'node v2.mjs'], '改配置下一轮派发即生效')
})

// ---------- 未实现类型 ----------

test('prompt/agent 型 handler 首版未实现：跳过并警告，command 型不受影响', async () => {
  const config = {
    hooks: {
      PreToolUse: [
        {
          hooks: [
            { type: 'prompt', command: '评估是否放行' },
            { command: 'node real.mjs' },
          ],
        },
      ],
    },
  }
  const { runner, fakeRunner } = makeEnv(config)
  const result = await runner.dispatch('PreToolUse', TOOL_CTX)
  assert.deepEqual(fakeRunner.calls.map((c) => c.command), ['node real.mjs'])
  assert.ok(result!.systemMessages.some((m) => m.includes('prompt') && m.includes('未实现')))
})

// ---------- stdin 输入协议 ----------

test('stdin 输入协议字段完整（snake_case）', async () => {
  const config = { hooks: { PostToolUse: [{ hooks: [{ command: 'node capture.mjs' }] }] } }
  const { runner, fakeRunner } = makeEnv(config)
  await runner.dispatch('PostToolUse', {
    sessionId: 's1',
    cwd: '/proj',
    toolName: 'write_file',
    toolInput: { path: 'a.ts' },
    toolResponse: { ok: true },
  })
  const input = fakeRunner.calls[0].input
  assert.equal(input.session_id, 's1')
  assert.equal(input.cwd, '/proj')
  assert.equal(input.hook_event_name, 'PostToolUse')
  assert.equal(input.tool_name, 'write_file')
  assert.deepEqual(input.tool_input, { path: 'a.ts' })
  assert.deepEqual(input.tool_response, { ok: true })
})
