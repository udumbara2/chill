import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BuiltInToolExecutor } from '../../src/services/builtInToolExecutor.ts'
import { getApprovalChannel, resetApprovalChannel, type ApprovalRequestPayload } from '../../src/services/approvals.ts'
import { eventBus, EVENTS } from '../../src/utils/eventBus.ts'
import type { DesktopInputAction } from '../../src/interfaces/IDesktopController.ts'
import type { DesktopAuditEntry } from '../../src/interfaces/IDesktopAudit.ts'

/** 收集型审计 sink（仿宿主实现的最小桩：记录 entry + imageDataUri 入参） */
function makeAuditSink() {
  const entries: DesktopAuditEntry[] = []
  const images: (string | undefined)[] = []
  return {
    entries,
    images,
    sink: {
      record(entry: DesktopAuditEntry, imageDataUri?: string) {
        entries.push(entry)
        images.push(imageDataUri)
      },
    },
  }
}

/**
 * 假桌面控制器 + 开关已开启的 executor（同 desktopApproval.test.ts 配方；
 * 可选 failCapture/failInput 注入执行失败；auditOff 模拟 desktop_audit='false'）
 */
function makeExecutor(opts: { failCapture?: boolean; failInputOnCall?: number; auditOff?: boolean; noSink?: boolean } = {}) {
  const inputs: DesktopInputAction[] = []
  const audit = makeAuditSink()
  const executor = new BuiltInToolExecutor({} as any, {} as any, {} as any, {} as any)
  let inputCalls = 0
  executor.setDesktopController({
    isAvailable: async () => true,
    listDisplays: async () => [
      { index: 0, name: '\\\\.\\DISPLAY1', x: 0, y: 0, width: 2560, height: 1440, dpiScale: 2.0, isPrimary: true },
    ],
    capture: async () => {
      if (opts.failCapture) throw new Error('截屏原生调用失败')
      return {
        dataUri: 'data:image/png;base64,QUJD',
        width: 1280, height: 720, dpiScale: 2.0,
        originX: 0, originY: 0, physWidth: 2560, physHeight: 1440,
      }
    },
    input: async (action: DesktopInputAction) => {
      inputCalls++
      inputs.push(action)
      if (opts.failInputOnCall === inputCalls) return { success: false, error: '键鼠注入失败' }
      return { success: true }
    },
    snapshot: async () => [],
    invokeElement: async () => ({ success: true }),
    setElementValue: async () => ({ success: true }),
    focusWindow: async () => ({ success: true }),
  })
  executor.setMediaCapabilitiesProvider(() => ({ supportsImage: true }))
  executor.setConfigStore({
    getItem: (k: string) => {
      if (k === 'desktop_control_enabled') return 'true'
      if (k === 'desktop_audit') return opts.auditOff ? 'false' : null
      return null
    },
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  })
  if (!opts.noSink) executor.setDesktopAuditSink(audit.sink)
  return { executor, inputs, audit }
}

function watchApprovals(t: { after: (fn: () => void) => void }) {
  const requests: ApprovalRequestPayload[] = []
  const listener = (data: ApprovalRequestPayload) => requests.push(data)
  eventBus.on(EVENTS.APPROVAL_REQUESTED, listener)
  t.after(() => eventBus.off(EVENTS.APPROVAL_REQUESTED, listener))
  return requests
}

async function waitForRequests(requests: ApprovalRequestPayload[], n: number): Promise<void> {
  for (let i = 0; i < 100 && requests.length < n; i++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(requests.length, n, '审批请求未按预期发出')
}

const ARGS = (extra: Record<string, any>) => JSON.stringify({ purpose: '测试动作', ...extra })

test('审计：capture_screen 成功记 passive 条目（desc 含主屏），截图 dataUri 交 sink', async (t) => {
  const { executor, audit } = makeExecutor()
  t.after(() => resetApprovalChannel())

  const r = await executor.executeAsync('capture_screen', '{}', 'tc-cap')
  assert.equal(r.success, true)
  assert.equal(audit.entries.length, 1)
  const e = audit.entries[0]
  assert.equal(e.tool, 'capture_screen')
  assert.equal(e.action, 'capture')
  assert.equal(e.approval, 'passive')
  assert.equal(e.ok, true)
  assert.ok(e.desc.includes('主屏'))
  assert.ok(typeof e.ts === 'string' && e.ts.length > 0)
  assert.equal(audit.images[0], 'data:image/png;base64,QUJD')
})

test('审计：capture_screen 到达执行阶段的失败记 ok:false；视觉守卫（前置）失败不记', async (t) => {
  const { executor, audit } = makeExecutor({ failCapture: true })
  t.after(() => resetApprovalChannel())

  const r = await executor.executeAsync('capture_screen', '{}', 'tc-cap')
  assert.equal(r.success, false)
  assert.equal(audit.entries.length, 1)
  assert.equal(audit.entries[0].ok, false)
  assert.ok(audit.entries[0].error!.includes('截屏原生调用失败'))

  // 视觉守卫属前置校验：不记
  const g = makeExecutor()
  g.executor.setMediaCapabilitiesProvider(() => ({ supportsImage: false }))
  const r2 = await g.executor.executeAsync('capture_screen', '{}', 'tc-cap2')
  assert.equal(r2.success, false)
  assert.equal(g.audit.entries.length, 0)
})

test('审计：inspect_ui 成功记 passive 观察条目（desc 含范围与元素数）', async (t) => {
  const { executor, audit } = makeExecutor()
  t.after(() => resetApprovalChannel())

  const r = await executor.executeAsync('inspect_ui', '{}', 'tc-ins')
  assert.equal(r.success, true)
  assert.equal(audit.entries.length, 1)
  const e = audit.entries[0]
  assert.equal(e.tool, 'inspect_ui')
  assert.equal(e.approval, 'passive')
  assert.equal(e.ok, true)
  assert.ok(e.desc.includes('当前前台窗口'))
  assert.equal(audit.images[0], undefined)
})

test('审计：被动动作 mouse_move 记 passive + coord 双坐标（图像→物理）', async (t) => {
  const { executor, audit } = makeExecutor()
  t.after(() => resetApprovalChannel())

  await executor.executeAsync('capture_screen', '{}', 'tc-cap')
  const r = await executor.executeAsync('computer_use', ARGS({ action: 'mouse_move', coordinate: [640, 360] }))
  assert.equal(r.success, true)

  assert.equal(audit.entries.length, 2)
  const e = audit.entries[1]
  assert.equal(e.tool, 'computer_use')
  assert.equal(e.action, 'mouse_move')
  assert.equal(e.approval, 'passive')
  assert.equal(e.ok, true)
  assert.equal(e.purpose, '测试动作')
  // 图像 1280×720 / 物理 2560×1440 → 换算比现派生 ×2
  assert.deepEqual(e.coord, { image: [640, 360], phys: [1280, 720] })
})

test('审计：主动作逐次批准记 approved；[s] 授权当动作与后续直通均记 session', async (t) => {
  const { executor, audit } = makeExecutor()
  const requests = watchApprovals(t)
  t.after(() => resetApprovalChannel())

  await executor.executeAsync('capture_screen', '{}', 'tc-cap')

  // 第一击：普通批准（非 [s]）→ approved
  const c1 = executor.executeAsync('computer_use', ARGS({ action: 'left_click', coordinate: [10, 10] }), 'tc-c1')
  await waitForRequests(requests, 1)
  getApprovalChannel().resolve('tc-c1', { approved: true })
  await c1
  assert.equal(audit.entries.at(-1)!.approval, 'approved')

  // 第二击：[s] 批准 → 当动作记 session（会话放行起点）
  const c2 = executor.executeAsync('computer_use', ARGS({ action: 'left_click', coordinate: [10, 10] }), 'tc-c2')
  await waitForRequests(requests, 2)
  getApprovalChannel().resolve('tc-c2', { approved: true, allowSession: true })
  await c2
  assert.equal(audit.entries.at(-1)!.approval, 'session')

  // 第三击：会话放行直通（无审批）→ session
  const r3 = await executor.executeAsync('computer_use', ARGS({ action: 'key', keys: 'CTRL+S' }), 'tc-c3')
  assert.equal(r3.success, true)
  assert.equal(audit.entries.at(-1)!.approval, 'session')
  assert.equal(requests.length, 2)
})

test('审计：用户拒绝记 rejected（ok:false，带拒绝原因），动作未执行', async (t) => {
  const { executor, audit, inputs } = makeExecutor()
  const requests = watchApprovals(t)
  t.after(() => resetApprovalChannel())

  await executor.executeAsync('capture_screen', '{}', 'tc-cap')
  const c1 = executor.executeAsync('computer_use', ARGS({ action: 'left_click', coordinate: [10, 10] }), 'tc-c1')
  await waitForRequests(requests, 1)
  getApprovalChannel().resolve('tc-c1', { approved: false, reason: '不点了' })
  const r = await c1
  assert.equal(r.success, false)

  const e = audit.entries.at(-1)!
  assert.equal(e.approval, 'rejected')
  assert.equal(e.ok, false)
  assert.ok(e.error!.includes('不点了'))
  assert.equal(inputs.length, 0)
})

test('审计：前置校验失败不记（未截屏的坐标动作 pre 失败），执行失败记 ok:false', async (t) => {
  const { executor, audit } = makeExecutor({ failInputOnCall: 1 })
  const requests = watchApprovals(t)
  t.after(() => resetApprovalChannel())

  // 未截屏 → 坐标动作缺坐标系（前置校验）：不记
  const r1 = await executor.executeAsync('computer_use', ARGS({ action: 'mouse_move', coordinate: [1, 1] }))
  assert.equal(r1.success, false)
  assert.equal(audit.entries.length, 0)

  // 截屏后坐标动作，input 执行失败（到达执行阶段）：记 ok:false
  await executor.executeAsync('capture_screen', '{}', 'tc-cap')
  assert.equal(audit.entries.length, 1) // capture 条目
  const r2 = await executor.executeAsync('computer_use', ARGS({ action: 'mouse_move', coordinate: [1, 1] }))
  assert.equal(r2.success, false)
  assert.equal(audit.entries.length, 2)
  assert.equal(audit.entries[1].ok, false)
  assert.ok(audit.entries[1].error!.includes('键鼠注入失败'))
  assert.equal(requests.length, 0) // 全程被动动作，无审批
})

test('审计：批处理逐步各一条（batch 定位 id/step/total），整批一次批准记 approved', async (t) => {
  const { executor, audit } = makeExecutor()
  const requests = watchApprovals(t)
  t.after(() => resetApprovalChannel())

  await executor.executeAsync('capture_screen', '{}', 'tc-cap')
  audit.entries.length = 0 // 只断批处理条目

  const batch = executor.executeAsync(
    'computer_use',
    ARGS({ actions: [
      { action: 'mouse_move', coordinate: [100, 100] },
      { action: 'left_click', coordinate: [100, 100] },
      { action: 'wait', seconds: 0 },
    ] }),
    'tc-batch',
  )
  await waitForRequests(requests, 1)
  getApprovalChannel().resolve('tc-batch', { approved: true })
  const r = await batch
  assert.equal(r.success, true)

  assert.equal(audit.entries.length, 3)
  audit.entries.forEach((e, i) => {
    assert.equal(e.approval, 'approved')
    assert.equal(e.ok, true)
    assert.deepEqual(e.batch, { id: 'tc-batch', step: i + 1, total: 3 })
  })
  assert.equal(audit.entries[0].action, 'mouse_move')
  assert.deepEqual(audit.entries[0].coord, { image: [100, 100], phys: [200, 200] })
  assert.equal(audit.entries[2].action, 'wait')
})

test('审计：批内失败步记 ok:false（带步序），后续步不执行不记；整批被拒记一条 batch 条目', async (t) => {
  // 场景一：第二步 input 失败
  const { executor, audit } = makeExecutor({ failInputOnCall: 2 })
  const requests = watchApprovals(t)
  t.after(() => resetApprovalChannel())

  await executor.executeAsync('capture_screen', '{}', 'tc-cap')
  audit.entries.length = 0

  const batch = executor.executeAsync(
    'computer_use',
    ARGS({ actions: [
      { action: 'mouse_move', coordinate: [10, 10] },
      { action: 'left_click', coordinate: [10, 10] },
      { action: 'wait', seconds: 0 },
    ] }),
    'tc-b1',
  )
  await waitForRequests(requests, 1)
  getApprovalChannel().resolve('tc-b1', { approved: true })
  const r = await batch
  assert.equal(r.success, false)

  assert.equal(audit.entries.length, 2)
  assert.deepEqual(audit.entries[0].batch, { id: 'tc-b1', step: 1, total: 3 })
  assert.equal(audit.entries[0].ok, true)
  assert.deepEqual(audit.entries[1].batch, { id: 'tc-b1', step: 2, total: 3 })
  assert.equal(audit.entries[1].ok, false)
  assert.ok(audit.entries[1].error!.includes('键鼠注入失败'))

  // 场景二：整批被拒 → 一条 action='batch' 的 rejected 条目，逐步不记
  const g = makeExecutor()
  const requests2: ApprovalRequestPayload[] = []
  const listener2 = (d: ApprovalRequestPayload) => requests2.push(d)
  eventBus.on(EVENTS.APPROVAL_REQUESTED, listener2)
  t.after(() => eventBus.off(EVENTS.APPROVAL_REQUESTED, listener2))

  const batch2 = g.executor.executeAsync(
    'computer_use',
    ARGS({ actions: [{ action: 'left_click', coordinate: [1, 1] }, { action: 'wait', seconds: 0 }] }),
    'tc-b2',
  )
  await waitForRequests(requests2, 1)
  getApprovalChannel().resolve('tc-b2', { approved: false, reason: '不批' })
  const r2 = await batch2
  assert.equal(r2.success, false)
  assert.equal(g.audit.entries.length, 1)
  assert.equal(g.audit.entries[0].action, 'batch')
  assert.equal(g.audit.entries[0].approval, 'rejected')
  assert.equal(g.audit.entries[0].ok, false)
})

test('审计：desktop_audit=false 时不发射；sink 未注入时零影响（动作照常成功）', async (t) => {
  const off = makeExecutor({ auditOff: true })
  t.after(() => resetApprovalChannel())
  const r1 = await off.executor.executeAsync('capture_screen', '{}', 'tc-cap')
  assert.equal(r1.success, true)
  assert.equal(off.audit.entries.length, 0)

  const noSink = makeExecutor({ noSink: true })
  const r2 = await noSink.executor.executeAsync('capture_screen', '{}', 'tc-cap')
  assert.equal(r2.success, true)
  const r3 = await noSink.executor.executeAsync('computer_use', ARGS({ action: 'wait', seconds: 0 }))
  assert.equal(r3.success, true)
})

test('审计：sink 抛异常被吞咽，动作执行不受影响', async (t) => {
  const { executor } = makeExecutor({ noSink: true })
  t.after(() => resetApprovalChannel())
  executor.setDesktopAuditSink({
    record() { throw new Error('sink 炸了') },
  })
  const r = await executor.executeAsync('capture_screen', '{}', 'tc-cap')
  assert.equal(r.success, true)
})
