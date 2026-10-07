import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BuiltInToolExecutor } from '../../src/services/builtInToolExecutor.ts'
import { getApprovalChannel, resetApprovalChannel } from '../../src/services/approvals.ts'
import { resetWriteBoundary } from '../../src/services/writeBoundary.ts'
import { eventBus, EVENTS } from '../../src/utils/eventBus.ts'
import type { ApprovalRequestPayload } from '../../src/services/approvals.ts'

/**
 * 既有状态门的回归测试（PolicyLink 化重构的行为锁定）：
 * 非交互只读门（sync/async）、plan 门（sync/async）、非交互 ask_user/computer_use 门、
 * 桌面开关门、autoApply / -p auto 直通判定、goal 五工具"仅目标模式"门。
 * 审批流与写边界的细化行为由 powershellApproval.test.ts / writeToolsBoundary.test.ts 锁定，此处不重复。
 *
 * 重构要求"逻辑原样只换装配"——本文件在重构前后必须全绿且逐字不断言变化。
 */

function makeFsProvider(workDir = 'C:\\proj') {
  return {
    getCurrentDirectory: () => workDir,
    fileExists: async () => ({ success: true, data: false }),
    readFile: async () => ({ success: false, error: 'not found' }),
    writeFile: async () => ({ success: true }),
    deleteFile: async () => ({ success: true }),
    getPathType: async () => ({ success: true, data: { type: 'not_found' } }),
    listDirectory: async () => ({ success: true, data: [] }),
  }
}

function makeExecutor() {
  const calls: Array<{ command: string; options: any }> = []
  const codeExecutor = {
    executePowerShell: async (command: string, options: any) => {
      calls.push({ command, options })
      return { success: true, output: `ok:${command}` }
    },
  }
  const executor = new BuiltInToolExecutor(
    makeFsProvider() as any,
    {} as any,
    {} as any,
    codeExecutor as any,
  )
  return { executor, calls }
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

// ---------- plan 门 ----------

test('plan 门（异步）：修改性工具拦截、只读工具放行', async (t) => {
  const { executor } = makeExecutor()
  watchApprovals(t)
  executor.setPlanMode(true)

  const blocked = await executor.executeAsync('create_file', JSON.stringify({ path: 'a.txt', content: 'x' }), 'tc-p1')
  assert.equal(blocked.success, false)
  assert.ok(blocked.error!.includes('当前处于规划模式，禁止执行修改性操作'))

  // 只读工具放行（会真实落到 fs 读取失败，但绝不是门拦截文案）
  const read = await executor.executeAsync('read_file', JSON.stringify({ path: 'a.txt' }))
  assert.ok(!read.error?.includes('规划模式'), `只读工具不应被 plan 门拦截: ${read.error}`)
})

test('plan 门（同步）：create_task_list 拦截、get_current_directory 放行', async (t) => {
  const { executor } = makeExecutor()
  watchApprovals(t)
  executor.setPlanMode(true)

  const blocked = executor.execute('create_task_list', JSON.stringify({ tasks: [{ id: '1', content: 'x' }] }))
  assert.equal(blocked.success, false)
  assert.ok(blocked.error!.includes('当前处于规划模式，禁止执行修改性操作'))

  const allowed = executor.execute('get_current_directory', '{}')
  assert.equal(allowed.success, true)
})

// ---------- 非交互门（chill -p） ----------

test('非交互只读门（异步）：readonly 档拦截修改性工具', async (t) => {
  const { executor } = makeExecutor()
  watchApprovals(t)
  executor.setNonInteractiveMode('readonly')

  const blocked = await executor.executeAsync('create_file', JSON.stringify({ path: 'a.txt', content: 'x' }), 'tc-r1')
  assert.equal(blocked.success, false)
  assert.ok(blocked.error!.includes('当前为非交互只读模式（chill -p 默认），禁止执行修改性操作'))
})

test('非交互只读门（同步）：readonly 档拦截 create_task_list', async (t) => {
  const { executor } = makeExecutor()
  watchApprovals(t)
  executor.setNonInteractiveMode('readonly')

  const blocked = executor.execute('create_task_list', JSON.stringify({ tasks: [{ id: '1', content: 'x' }] }))
  assert.equal(blocked.success, false)
  assert.ok(blocked.error!.includes('当前为非交互只读模式（chill -p 默认），禁止执行修改性操作'))
})

test('非交互门：ask_user 在 readonly / auto 两档均拒绝', async (t) => {
  const { executor } = makeExecutor()
  watchApprovals(t)

  executor.setNonInteractiveMode('readonly')
  const r1 = await executor.executeAsync('ask_user', JSON.stringify({ question: 'q' }))
  assert.equal(r1.success, false)
  assert.ok(r1.error!.includes('非交互模式不支持向用户提问'))

  executor.setNonInteractiveMode('auto')
  const r2 = await executor.executeAsync('ask_user', JSON.stringify({ question: 'q' }))
  assert.equal(r2.success, false)
  assert.ok(r2.error!.includes('非交互模式不支持向用户提问'))
})

test('非交互 auto 档：computer_use 拒绝（防审批挂死）', async (t) => {
  const { executor } = makeExecutor()
  watchApprovals(t)
  executor.setNonInteractiveMode('auto')

  const r = await executor.executeAsync('computer_use', JSON.stringify({ action: 'wait', seconds: 1 }), 'tc-c1')
  assert.equal(r.success, false)
  assert.ok(r.error!.includes('非交互模式（chill -p）不支持 computer_use'))
})

// ---------- 桌面开关门 ----------

test('桌面开关门：未开启 desktop_control_enabled 时桌面工具拒绝', async (t) => {
  const { executor } = makeExecutor()
  watchApprovals(t)

  const r = await executor.executeAsync('capture_screen', '{}', 'tc-d1')
  assert.equal(r.success, false)
  assert.ok(r.error!.includes('桌面控制能力未启用'))
})

// ---------- autoApply / -p auto 直通判定 ----------

test('autoApply 直通：安全命令直接执行无审批；危险命令仍走审批', async (t) => {
  const { executor, calls } = makeExecutor()
  const approvals = watchApprovals(t)
  executor.setAutoApply(true)

  const safe = await executor.executeAsync(
    'execute_powershell',
    JSON.stringify({ command: 'echo hi', purpose: 'p', intent: 'i' }),
    'tc-a1',
  )
  assert.equal(safe.success, true)
  assert.equal(safe.data.content, 'ok:echo hi')
  assert.equal(calls.length, 1)
  assert.equal(approvals.length, 0, '安全命令不应触发审批')

  const pending = executor.executeAsync(
    'execute_powershell',
    JSON.stringify({ command: 'rm -rf /', purpose: 'p', intent: 'i' }),
    'tc-a2',
  )
  assert.equal(approvals.length, 1, '危险命令在 autoApply 下仍须审批')
  getApprovalChannel().resolve('tc-a2', { approved: true })
  const dangerous = await pending
  assert.equal(dangerous.success, true)
  assert.equal(calls.length, 2)
})

test('非交互 auto 档直通：危险命令同样直接执行（无人可确认）', async (t) => {
  const { executor, calls } = makeExecutor()
  const approvals = watchApprovals(t)
  executor.setNonInteractiveMode('auto')

  const r = await executor.executeAsync(
    'execute_powershell',
    JSON.stringify({ command: 'rm -rf /', purpose: 'p', intent: 'i' }),
    'tc-a3',
  )
  assert.equal(r.success, true)
  assert.equal(calls.length, 1)
  assert.equal(approvals.length, 0)
})

// ---------- goal 五工具"仅目标模式"门 ----------

test('goal 门：write_goal/read_goal/request_goal_review/report_goal_blocked 非目标模式拒绝', async (t) => {
  const { executor } = makeExecutor()
  watchApprovals(t)

  const cases: Array<[string, string, string]> = [
    ['write_goal', JSON.stringify({ objective: 'x' }), 'write_goal 仅在目标模式下可用'],
    ['read_goal', '{}', 'read_goal 仅在目标模式下可用'],
    ['request_goal_review', '{}', 'request_goal_review 仅在目标模式下可用'],
    ['report_goal_blocked', JSON.stringify({ reason: 'r' }), 'report_goal_blocked 仅在目标模式下可用'],
  ]
  for (const [tool, args, expectMsg] of cases) {
    const r = await executor.executeAsync(tool, args)
    assert.equal(r.success, false, `${tool} 应被拒绝`)
    assert.ok(r.error!.includes(expectMsg), `${tool} 拒绝文案不符: ${r.error}`)
  }
})

test('goal 门：propose_goal 在目标模式下拒绝（无需重复提议）', async (t) => {
  const { executor } = makeExecutor()
  watchApprovals(t)
  executor.setGoalMode(true)

  const r = await executor.executeAsync('propose_goal', JSON.stringify({ objective: 'x' }))
  assert.equal(r.success, false)
  assert.ok(r.error!.includes('当前已处于目标模式，无需提议'))
})

test('goal 门：write_goal 在目标模式下放行并发 GOAL_UPDATED', async (t) => {
  const { executor } = makeExecutor()
  watchApprovals(t)
  executor.setGoalMode(true)

  const updated: any[] = []
  const listener = (p: any) => updated.push(p)
  eventBus.on(EVENTS.GOAL_UPDATED, listener)
  t.after(() => eventBus.off(EVENTS.GOAL_UPDATED, listener))

  const r = await executor.executeAsync('write_goal', JSON.stringify({ objective: '新目标' }))
  assert.equal(r.success, true)
  assert.equal(updated.length, 1)
  assert.equal(updated[0].objective, '新目标')
})

// ---------- 权限模式门（交互式三态选择器） ----------

test('权限只读门（异步）：readonly 拦截修改性工具、放行只读工具、豁免 task', async (t) => {
  const { executor } = makeExecutor()
  watchApprovals(t)
  executor.setPermissionMode('readonly')

  const blocked = await executor.executeAsync('create_file', JSON.stringify({ path: 'a.txt', content: 'x' }), 'tc-pr1')
  assert.equal(blocked.success, false)
  assert.ok(blocked.error!.includes('当前为只读模式'), `拒绝文案不符: ${blocked.error}`)

  // 只读工具放行（落到真实 fs 失败也不是门拦截）
  const read = await executor.executeAsync('read_file', JSON.stringify({ path: 'a.txt' }))
  assert.ok(!read.error?.includes('只读模式'), `只读工具不应被权限只读门拦截: ${read.error}`)

  // task 豁免（委派经 Worker 代理回本门，修改性调用仍被拦）
  const planBlocked = await executor.executeAsync('execute_powershell', JSON.stringify({ command: 'echo x', purpose: 'p', intent: 'i' }), 'tc-pr2')
  assert.equal(planBlocked.success, false)
  assert.ok(planBlocked.error!.includes('当前为只读模式'))
})

test('权限只读门（同步）：create_task_list 拦截、get_current_directory 放行', async (t) => {
  const { executor } = makeExecutor()
  watchApprovals(t)
  executor.setPermissionMode('readonly')

  const blocked = executor.execute('create_task_list', JSON.stringify({ tasks: [{ id: '1', content: 'x' }] }))
  assert.equal(blocked.success, false)
  assert.ok(blocked.error!.includes('当前为只读模式'))

  const allowed = executor.execute('get_current_directory', '{}')
  assert.equal(allowed.success, true)
})

test('权限模式三态切换：boundary 默认；fullAccess 安全命令直通；回 boundary 恢复审批', async (t) => {
  const { executor, calls } = makeExecutor()
  const approvals = watchApprovals(t)
  assert.equal(executor.getPermissionMode(), 'boundary')

  executor.setPermissionMode('fullAccess')
  const safe = await executor.executeAsync('execute_powershell', JSON.stringify({ command: 'echo hi', purpose: 'p', intent: 'i' }), 'tc-pm1')
  assert.equal(safe.success, true)
  assert.equal(calls.length, 1)
  assert.equal(approvals.length, 0)

  executor.setPermissionMode('boundary')
  const pending = executor.executeAsync('execute_powershell', JSON.stringify({ command: 'echo hi2', purpose: 'p', intent: 'i' }), 'tc-pm2')
  assert.equal(approvals.length, 1, '回到边界档应恢复审批')
  getApprovalChannel().resolve('tc-pm2', { approved: true })
  await pending
})

test('权限模式 shim：setAutoApply/getAutoApply 映射 fullAccess/boundary', async (t) => {
  const { executor } = makeExecutor()
  watchApprovals(t)

  executor.setAutoApply(true)
  assert.equal(executor.getPermissionMode(), 'fullAccess')
  assert.equal(executor.getAutoApply(), true)

  executor.setAutoApply(false)
  assert.equal(executor.getPermissionMode(), 'boundary')
  assert.equal(executor.getAutoApply(), false)
})

test('权限只读与 -p readonly 叠加：任一成立即拦截', async (t) => {
  const { executor } = makeExecutor()
  watchApprovals(t)

  executor.setPermissionMode('readonly')
  executor.setNonInteractiveMode('readonly')
  const r = await executor.executeAsync('create_file', JSON.stringify({ path: 'a.txt', content: 'x' }), 'tc-mix1')
  assert.equal(r.success, false)

  // 只关权限只读，-p readonly 仍拦
  executor.setPermissionMode('boundary')
  const r2 = await executor.executeAsync('create_file', JSON.stringify({ path: 'a.txt', content: 'x' }), 'tc-mix2')
  assert.equal(r2.success, false)
  assert.ok(r2.error!.includes('非交互只读'))
})
