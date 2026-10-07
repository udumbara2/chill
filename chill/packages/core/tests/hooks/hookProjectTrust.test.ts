import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HookConfigLoader } from '../../src/services/hooks/HookConfigLoader.ts'
import { HookRunner } from '../../src/services/hooks/HookRunner.ts'
import type { HookDispatchContext } from '../../src/services/hooks/HookRunner.ts'
import { computeHandlerTrustHash, sha256Hex, trustKeyOf, TRUSTED_KV_KEY } from '../../src/services/hooks/hookTrust.ts'
import type { IHookProcessRunner, HookProcessResult } from '../../src/services/hooks/IHookProcessRunner.ts'
import type { IFileSystemProvider } from '../../src/interfaces/IFileSystemProvider.ts'
import type { IKeyValueStore } from '../../src/interfaces/IKeyValueStore.ts'
import type { HookTrustApprovalRequest } from '../../src/services/hooks/types.ts'

const USER_PATH = '/home/user/.chill/hooks.json'
const WORK_DIR = '/work/near/deep'

/** 内存假 fsProvider（posix 风格路径键），带读盘计数 */
function makeFakeFs(initialFiles: Record<string, string> = {}) {
  const files = new Map(Object.entries(initialFiles))
  const counters = { readFile: 0 }
  const fs: IFileSystemProvider = {
    readFile: async (p: string) => {
      counters.readFile++
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
    getPathType: async (p: string) => ({
      success: true,
      data: { type: files.has(p) ? ('file' as const) : ('not_found' as const) },
    }),
  }
  return { fs, files, counters }
}

/** 假 mtime provider：按路径取值，测试可逐个拨动 */
function makeFakeMtimes(initial: Record<string, number | null> = {}) {
  const mtimes = new Map(Object.entries(initial))
  return {
    mtimes,
    provider: {
      getMtimeMs: async (p: string) => mtimes.get(p) ?? null,
    },
  }
}

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

/** 假执行通道：记录调用，默认 exit 0 空输出 */
class FakeRunner implements IHookProcessRunner {
  calls: Array<{ command: string; input: Record<string, unknown> }> = []
  async run(command: string, inputJson: string): Promise<HookProcessResult> {
    this.calls.push({ command, input: JSON.parse(inputJson) as Record<string, unknown> })
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
  }
}

function hooksFile(groups: Record<string, unknown>): string {
  return JSON.stringify({ hooks: groups })
}

const TOOL_CTX: HookDispatchContext = {
  sessionId: 's1',
  cwd: WORK_DIR,
  toolName: 'execute_powershell',
  toolInput: { command: 'ls' },
}

// ---------- sha256 自实现正确性（known-answer） ----------

test('sha256Hex：标准答案对照（abc / 空串 / 中文）', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  // 中文（多字节 UTF-8）答案由 node:crypto 交叉验证
  assert.equal(sha256Hex('中文'), '72726d8818f693066ceb69afa364218b692e62ea92b385782363780f47529c21')
})

// ---------- 项目级发现与向上递归 ----------

test('项目级发现：从 workDir 向上递归，近→远排序，缺层跳过', async () => {
  // 各文件用不同 matcher，避免同键覆盖（覆盖规则另有专测），此处专测发现与排序
  const { fs } = makeFakeFs({
    [USER_PATH]: hooksFile({ SessionEnd: [{ matcher: 'user', hooks: [{ command: 'node user.mjs' }] }] }),
    '/work/near/deep/.agents/hooks.json': hooksFile({ SessionEnd: [{ matcher: 'deep', hooks: [{ command: 'node deep.mjs' }] }] }),
    '/work/.agents/hooks.json': hooksFile({ SessionEnd: [{ matcher: 'work', hooks: [{ command: 'node work.mjs' }] }] }),
    // '/work/near/.agents/hooks.json' 不存在：跳过
  })
  const loader = new HookConfigLoader(fs, USER_PATH, makeFakeMtimes().provider, { workDir: WORK_DIR })

  const config = await loader.checkReload()
  const commands = config.SessionEnd!.flatMap((g) => g.hooks.map((h) => h.command))
  assert.deepEqual(commands, ['node deep.mjs', 'node work.mjs', 'node user.mjs'], '项目近→远→用户')
  const sources = config.SessionEnd!.flatMap((g) => g.hooks.map((h) => h.source))
  assert.deepEqual(
    sources.map((s) => s?.kind),
    ['project', 'project', 'user']
  )
  assert.equal(sources[0]?.path, '/work/near/deep/.agents/hooks.json')
  assert.deepEqual(loader.getErrors(), [])
})

test('未传 workDir：仅用户级单文件（阶段 1 行为不变）', async () => {
  const { fs } = makeFakeFs({
    [USER_PATH]: hooksFile({ SessionEnd: [{ hooks: [{ command: 'node user.mjs' }] }] }),
    '/work/near/deep/.agents/hooks.json': hooksFile({ SessionEnd: [{ hooks: [{ command: 'node deep.mjs' }] }] }),
  })
  const loader = new HookConfigLoader(fs, USER_PATH, makeFakeMtimes().provider)
  const config = await loader.checkReload()
  assert.equal(config.SessionEnd!.length, 1)
  assert.equal(config.SessionEnd![0].hooks[0].command, 'node user.mjs')
})

// ---------- 合并覆盖优先级 ----------

test('合并覆盖：同事件同 matcher 项目覆盖用户；近项目覆盖远项目；不同 matcher 并存', async () => {
  const { fs } = makeFakeFs({
    [USER_PATH]: hooksFile({
      PreToolUse: [
        { matcher: 'execute_powershell', hooks: [{ command: 'node user-guard.mjs' }] },
        { matcher: 'write_file', hooks: [{ command: 'node user-fmt.mjs' }] },
      ],
    }),
    '/work/near/deep/.agents/hooks.json': hooksFile({
      PreToolUse: [{ matcher: 'execute_powershell', hooks: [{ command: 'node deep-guard.mjs' }] }],
    }),
    '/work/.agents/hooks.json': hooksFile({
      PreToolUse: [
        { matcher: 'execute_powershell', hooks: [{ command: 'node work-guard.mjs' }] },
        { matcher: 'read_file', hooks: [{ command: 'node work-read.mjs' }] },
      ],
    }),
  })
  const loader = new HookConfigLoader(fs, USER_PATH, makeFakeMtimes().provider, { workDir: WORK_DIR })

  const groups = (await loader.checkReload()).PreToolUse!
  // 顺序 = 优先级从高到低：近项目 → 远项目 → 用户级
  assert.deepEqual(
    groups.map((g) => [g.matcher, g.hooks[0].command]),
    [
      ['execute_powershell', 'node deep-guard.mjs'], // 近项目覆盖远项目与用户级同 matcher 组
      ['read_file', 'node work-read.mjs'],
      ['write_file', 'node user-fmt.mjs'], // 不同 matcher：用户级组保留
    ]
  )
  assert.equal(groups.length, 3, '被覆盖的 user-guard / work-guard 组不得出现')
})

test('合并覆盖：matcher 空串与省略同键（全匹配组互相覆盖）', async () => {
  const { fs } = makeFakeFs({
    [USER_PATH]: hooksFile({ Stop: [{ hooks: [{ command: 'node user-stop.mjs' }] }] }),
    '/work/near/deep/.agents/hooks.json': hooksFile({ Stop: [{ matcher: '', hooks: [{ command: 'node deep-stop.mjs' }] }] }),
  })
  const loader = new HookConfigLoader(fs, USER_PATH, makeFakeMtimes().provider, { workDir: WORK_DIR })
  const groups = (await loader.checkReload()).Stop!
  assert.equal(groups.length, 1)
  assert.equal(groups[0].hooks[0].command, 'node deep-stop.mjs')
})

// ---------- mtime 多文件惰性重载 ----------

test('多文件 mtime 重载：任一文件变化/新增/消失即重载，全不变零读盘', async () => {
  // 各文件用不同事件，避免同事件同 matcher 的覆盖规则干扰（覆盖另有专测）
  const { fs, files, counters } = makeFakeFs({
    [USER_PATH]: hooksFile({ SessionEnd: [{ hooks: [{ command: 'node user.mjs' }] }] }),
    '/work/near/deep/.agents/hooks.json': hooksFile({ SessionStart: [{ hooks: [{ command: 'node deep.mjs' }] }] }),
  })
  const m = makeFakeMtimes({ [USER_PATH]: 100, '/work/near/deep/.agents/hooks.json': 200 })
  const loader = new HookConfigLoader(fs, USER_PATH, m.provider, { workDir: WORK_DIR })

  await loader.checkReload()
  assert.equal(counters.readFile, 2, '首次加载读两个文件')

  // 全部不变：零读盘
  await loader.checkReload()
  await loader.checkReload()
  assert.equal(counters.readFile, 2, '签名不变不得重读')

  // 远层新增项目 hooks.json（此前不存在）：文件集合变化 → 整体重载（重读全部来源文件）并发现
  files.set('/work/.agents/hooks.json', hooksFile({ PostCompact: [{ hooks: [{ command: 'node work.mjs' }] }] }))
  m.mtimes.set('/work/.agents/hooks.json', 300)
  let config = await loader.checkReload()
  assert.equal(counters.readFile, 5, '重载为整体重读：2 + 3')
  assert.equal(config.SessionStart![0].hooks[0].command, 'node deep.mjs')
  assert.equal(config.PostCompact![0].hooks[0].command, 'node work.mjs')
  assert.equal(config.SessionEnd![0].hooks[0].command, 'node user.mjs')

  // 项目文件内容变化（mtime 拨动）：重读生效
  files.set('/work/near/deep/.agents/hooks.json', hooksFile({ SessionStart: [{ hooks: [{ command: 'node deep-v2.mjs' }] }] }))
  m.mtimes.set('/work/near/deep/.agents/hooks.json', 201)
  config = await loader.checkReload()
  assert.equal(config.SessionStart![0].hooks[0].command, 'node deep-v2.mjs')

  // 项目文件消失：该来源从合并结果中移除
  files.delete('/work/near/deep/.agents/hooks.json')
  m.mtimes.delete('/work/near/deep/.agents/hooks.json')
  config = await loader.checkReload()
  assert.equal(config.SessionStart, undefined)
  assert.equal(config.PostCompact![0].hooks[0].command, 'node work.mjs')
  assert.equal(config.SessionEnd![0].hooks[0].command, 'node user.mjs')
})

// ---------- 哈希信任标记（首见/变更/可信） ----------

test('信任标记：空记录=new；哈希匹配=trusted；哈希不符=changed；用户级不标记', async () => {
  const { fs } = makeFakeFs({
    // 用户级用不同 matcher，避免与项目级全匹配组同键被覆盖（覆盖规则另有专测）
    [USER_PATH]: hooksFile({ PreToolUse: [{ matcher: 'write_file', hooks: [{ command: 'node user.mjs' }] }] }),
    '/work/near/deep/.agents/hooks.json': hooksFile({
      PreToolUse: [
        {
          hooks: [
            { name: 'fresh', command: 'node fresh.mjs' },
            { name: 'stable', command: 'node stable.mjs', timeout: 10 },
            { name: 'mutated', command: 'node mutated.mjs' },
          ],
        },
      ],
    }),
  })
  const kv = makeKv()
  // 预置信任记录：stable 用正确哈希（可信），mutated 用旧哈希（已变更）
  const stableHash = computeHandlerTrustHash({ name: 'stable', type: 'command', command: 'node stable.mjs', timeout: 10, failClosed: false })
  kv.setItem(
    TRUSTED_KV_KEY,
    JSON.stringify({
      [trustKeyOf('/work/near/deep/.agents/hooks.json', 'PreToolUse:stable')]: stableHash,
      [trustKeyOf('/work/near/deep/.agents/hooks.json', 'PreToolUse:mutated')]: '0'.repeat(64),
    })
  )
  const loader = new HookConfigLoader(fs, USER_PATH, makeFakeMtimes().provider, { workDir: WORK_DIR, kv })

  const handlers = (await loader.checkReload()).PreToolUse![0].hooks
  assert.equal(handlers[0].trust, 'new')
  assert.equal(handlers[1].trust, 'trusted')
  assert.equal(handlers[2].trust, 'changed')
  // 用户级 handler：无信任字段（默认可信）
  const userHandler = loader.getConfig().PreToolUse![1].hooks[0]
  assert.equal(userHandler.source?.kind, 'user')
  assert.equal(userHandler.trust, undefined)
  assert.equal(userHandler.trustHash, undefined)
})

test('执行相关字段参与哈希：仅改 timeout 也判定为已变更', async () => {
  const h1 = computeHandlerTrustHash({ name: 'a', type: 'command', command: 'node a.mjs', timeout: 30, failClosed: false })
  const h2 = computeHandlerTrustHash({ name: 'a', type: 'command', command: 'node a.mjs', timeout: 60, failClosed: false })
  const h3 = computeHandlerTrustHash({ name: 'a', type: 'command', command: 'node a.mjs', timeout: 30, failClosed: true })
  assert.notEqual(h1, h2)
  assert.notEqual(h1, h3)
})

// ---------- HookRunner 信任闸 ----------

/** 组装：项目级配置 + 可选 trustApprover 的运行环境 */
function makeProjectEnv(opts: { kv?: IKeyValueStore; approver?: (req: HookTrustApprovalRequest) => Promise<boolean> } = {}) {
  const { fs, files } = makeFakeFs({
    '/work/near/deep/.agents/hooks.json': hooksFile({
      PreToolUse: [{ matcher: 'execute_powershell', hooks: [{ name: 'guard', command: 'node guard.mjs' }] }],
    }),
  })
  const loader = new HookConfigLoader(fs, USER_PATH, makeFakeMtimes().provider, { workDir: WORK_DIR, kv: opts.kv })
  const fakeRunner = new FakeRunner()
  const runner = new HookRunner({ loader, processRunner: fakeRunner, kv: opts.kv, trustApprover: opts.approver })
  return { runner, loader, fakeRunner, files }
}

test('用户级 hooks 默认可信：无 trustApprover 也直接执行', async () => {
  const { fs } = makeFakeFs({
    [USER_PATH]: hooksFile({ PreToolUse: [{ hooks: [{ command: 'node user.mjs' }] }] }),
  })
  const loader = new HookConfigLoader(fs, USER_PATH, makeFakeMtimes().provider, { workDir: WORK_DIR })
  const fakeRunner = new FakeRunner()
  const runner = new HookRunner({ loader, processRunner: fakeRunner })
  const result = await runner.dispatch('PreToolUse', TOOL_CTX)
  assert.equal(result!.verdict.type, 'allow')
  assert.equal(fakeRunner.calls.length, 1)
})

test('不可信跳过（无 trustApprover）：不执行 + 警告 + 触发记录 skipped-untrusted', async () => {
  const { runner, fakeRunner } = makeProjectEnv()
  const result = await runner.dispatch('PreToolUse', TOOL_CTX)
  assert.equal(fakeRunner.calls.length, 0, '不可信 handler 不得执行')
  assert.equal(result!.verdict.type, 'allow', '跳过不等于阻断')
  assert.ok(result!.systemMessages.some((m) => m.includes('未获信任') && m.includes('无交互询问通道')))
  const invocations = runner.getRecentInvocations()
  assert.equal(invocations.length, 1)
  assert.equal(invocations[0].decision, 'skipped-untrusted')
  assert.equal(invocations[0].handlerName, 'guard')
})

test('trustApprover 批准：当场询问 → 执行 → 信任记录落盘 → 二次派发不再询问', async () => {
  const kv = makeKv()
  const asks: HookTrustApprovalRequest[] = []
  const { runner, fakeRunner } = makeProjectEnv({
    kv,
    approver: async (req) => {
      asks.push(req)
      return true
    },
  })

  await runner.dispatch('PreToolUse', TOOL_CTX)
  assert.equal(asks.length, 1)
  assert.deepEqual(asks[0], {
    handlerId: 'PreToolUse:guard',
    event: 'PreToolUse',
    command: 'node guard.mjs',
    sourcePath: '/work/near/deep/.agents/hooks.json',
    reason: 'new',
  })
  assert.equal(fakeRunner.calls.length, 1, '批准后即执行')

  // 信任记录已写入 kv
  const records = JSON.parse(kv.map.get(TRUSTED_KV_KEY)!) as Record<string, string>
  assert.equal(Object.keys(records).length, 1)
  assert.ok(Object.keys(records)[0].includes('PreToolUse:guard'))

  // 二次派发：缓存内已可信，不再询问
  await runner.dispatch('PreToolUse', TOOL_CTX)
  assert.equal(asks.length, 1)
  assert.equal(fakeRunner.calls.length, 2)
})

test('trustApprover 拒绝：不执行 + 本进程内不再重复询问', async () => {
  const asks: HookTrustApprovalRequest[] = []
  const { runner, fakeRunner } = makeProjectEnv({
    approver: async (req) => {
      asks.push(req)
      return false
    },
  })
  const r1 = await runner.dispatch('PreToolUse', TOOL_CTX)
  const r2 = await runner.dispatch('PreToolUse', TOOL_CTX)
  assert.equal(asks.length, 1, '拒绝后不反复询问')
  assert.equal(fakeRunner.calls.length, 0)
  assert.ok(r1!.systemMessages.some((m) => m.includes('未获信任批准')))
  assert.equal(runner.getRecentInvocations().filter((i) => i.decision === 'skipped-untrusted').length, 2)
})

test('信任持久化：同一 kv 重建 loader+runner 后直接可信执行（无需询问）', async () => {
  const kv = makeKv()
  const asks: HookTrustApprovalRequest[] = []
  const env1 = makeProjectEnv({
    kv,
    approver: async (req) => {
      asks.push(req)
      return true
    },
  })
  await env1.runner.dispatch('PreToolUse', TOOL_CTX)
  assert.equal(asks.length, 1)

  // 模拟重启：新 loader + 新 runner，同一 kv，不给 trustApprover 也应执行
  const env2 = makeProjectEnv({ kv })
  const result = await env2.runner.dispatch('PreToolUse', TOOL_CTX)
  assert.equal(result!.verdict.type, 'allow')
  assert.equal(env2.fakeRunner.calls.length, 1, '已信任定义重启后直接执行')
  assert.equal(
    env2.runner.getRecentInvocations().filter((i) => i.decision === 'skipped-untrusted').length,
    0
  )
})

test('已变更（changed）：reason 为 changed；批准新哈希后落盘更新', async () => {
  const kv = makeKv()
  // 预置旧哈希（与当前定义不符）→ changed
  kv.setItem(
    TRUSTED_KV_KEY,
    JSON.stringify({ [trustKeyOf('/work/near/deep/.agents/hooks.json', 'PreToolUse:guard')]: 'f'.repeat(64) })
  )
  const asks: HookTrustApprovalRequest[] = []
  const { runner, fakeRunner } = makeProjectEnv({
    kv,
    approver: async (req) => {
      asks.push(req)
      return true
    },
  })
  await runner.dispatch('PreToolUse', TOOL_CTX)
  assert.equal(asks[0].reason, 'changed')
  assert.equal(fakeRunner.calls.length, 1)
  const records = JSON.parse(kv.map.get(TRUSTED_KV_KEY)!) as Record<string, string>
  assert.notEqual(Object.values(records)[0], 'f'.repeat(64), '批准后信任记录更新为新哈希')
})

test('trustApprover 抛异常：视同拒绝（安全侧失败），不执行', async () => {
  const { runner, fakeRunner } = makeProjectEnv({
    approver: async () => {
      throw new Error('UI 异常')
    },
  })
  const result = await runner.dispatch('PreToolUse', TOOL_CTX)
  assert.equal(fakeRunner.calls.length, 0)
  assert.equal(result!.verdict.type, 'allow')
  assert.equal(runner.getRecentInvocations()[0].decision, 'skipped-untrusted')
})
