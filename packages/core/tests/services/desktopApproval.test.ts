import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BuiltInToolExecutor } from '../../src/services/builtInToolExecutor.ts'
import { getApprovalChannel, resetApprovalChannel, type ApprovalRequestPayload } from '../../src/services/approvals.ts'
import { eventBus, EVENTS } from '../../src/utils/eventBus.ts'
import type { DesktopInputAction } from '../../src/interfaces/IDesktopController.ts'

/** 假桌面控制器 + 开关已开启的 executor（codeExecutor 等其余依赖在桌面路径不触达） */
function makeDesktopExecutor() {
  const inputs: DesktopInputAction[] = []
  const executor = new BuiltInToolExecutor({} as any, {} as any, {} as any, {} as any)
  executor.setDesktopController({
    isAvailable: async () => true,
    // 物理 2560×1440 → 模型图 1280×720（换算比 0.5 由执行器从 width/physWidth 现派生）
    capture: async () => ({
      dataUri: 'data:image/png;base64,QUJD',
      width: 1280,
      height: 720,
      // dpiScale 是纯信息性字段（故意给一个 ≠ 换算比的值：若执行器误用它，坐标断言必炸）
      dpiScale: 2.0,
      originX: 0,
      originY: 0,
      physWidth: 2560,
      physHeight: 1440,
    }),
    input: async (action: DesktopInputAction) => {
      inputs.push(action)
      return { success: true }
    },
    // 元素级四方法（迭代 3 接口扩展；本文件不测元素路径，给最小桩满足接口）
    snapshot: async () => [],
    invokeElement: async () => ({ success: true }),
    setElementValue: async () => ({ success: true }),
    focusWindow: async () => ({ success: true }),
  })
  executor.setMediaCapabilitiesProvider(() => ({ supportsImage: true }))
  executor.setConfigStore({
    getItem: (k: string) => (k === 'desktop_control_enabled' ? 'true' : null),
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  })
  return { executor, inputs }
}

/** 监听 APPROVAL_REQUESTED（stop 时摘监听并返回快照） */
function watchApprovals(t: { after: (fn: () => void) => void }) {
  const requests: ApprovalRequestPayload[] = []
  const listener = (data: ApprovalRequestPayload) => requests.push(data)
  eventBus.on(EVENTS.APPROVAL_REQUESTED, listener)
  t.after(() => eventBus.off(EVENTS.APPROVAL_REQUESTED, listener))
  return requests
}

/** 等审批请求登记（executor 在发起审批前有 isAvailable 等 await，请求在后续微任务才发出） */
async function waitForRequests(requests: ApprovalRequestPayload[], n: number): Promise<void> {
  for (let i = 0; i < 100 && requests.length < n; i++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(requests.length, n, '审批请求未按预期发出')
}

const ARGS = (extra: Record<string, any>) =>
  JSON.stringify({ purpose: '测试动作', intent: '测试意图', ...extra })

test('三级审批：被动动作 mouse_move 免审批（无 toolCallId 也直通），坐标经模型图→物理换算', async (t) => {
  const { executor, inputs } = makeDesktopExecutor()
  const requests = watchApprovals(t)
  t.after(() => resetApprovalChannel())

  // 先截屏建立坐标系（capture_screen 只读，本就不审批）
  const cap = await executor.executeAsync('capture_screen', '{}', 'tc-cap')
  assert.equal(cap.success, true)

  const result = await executor.executeAsync(
    'computer_use',
    ARGS({ action: 'mouse_move', coordinate: [640, 360] }),
  )
  assert.equal(result.success, true)
  assert.equal(requests.length, 0)
  assert.deepEqual(inputs, [{ action: 'mouse_move', x: 1280, y: 720 }])
})

test('三级审批：被动动作 wait 免审批（无 toolCallId 也直通）', async (t) => {
  const { executor, inputs } = makeDesktopExecutor()
  const requests = watchApprovals(t)
  t.after(() => resetApprovalChannel())

  const result = await executor.executeAsync('computer_use', ARGS({ action: 'wait', seconds: 0 }))
  assert.equal(result.success, true)
  assert.equal(requests.length, 0)
  assert.equal(inputs.length, 0)
})

test('三级审批：主动作审批载荷带 sessionGrantable；[s] 回答后同会话第二个主动作直通', async (t) => {
  const { executor, inputs } = makeDesktopExecutor()
  const requests = watchApprovals(t)
  t.after(() => resetApprovalChannel())

  await executor.executeAsync('capture_screen', '{}', 'tc-cap')

  const first = executor.executeAsync(
    'computer_use',
    ARGS({ action: 'left_click', coordinate: [640, 360] }),
    'tc-c1',
  )
  await waitForRequests(requests, 1)
  assert.equal(requests[0].sessionGrantable, true)
  assert.equal(requests[0].kind, 'command')

  // 壳侧 [s] 回答：批准 + 会话放行
  getApprovalChannel().resolve('tc-c1', { approved: true, allowSession: true })
  const r1 = await first
  assert.equal(r1.success, true)

  // 第二个主动作（新 toolCallId）：会话放行生效，不再审批
  const r2 = await executor.executeAsync(
    'computer_use',
    ARGS({ action: 'key', keys: 'CTRL+S' }),
    'tc-c2',
  )
  assert.equal(r2.success, true)
  assert.equal(requests.length, 1)
  assert.equal(inputs.length, 2)
  assert.deepEqual(inputs[1], { action: 'key', keys: 'ctrl+s' })
})

test('三级审批：resetDesktopSessionAllow 收回后主动作重新逐次审批', async (t) => {
  const { executor } = makeDesktopExecutor()
  const requests = watchApprovals(t)
  t.after(() => resetApprovalChannel())

  await executor.executeAsync('capture_screen', '{}', 'tc-cap')

  const first = executor.executeAsync(
    'computer_use',
    ARGS({ action: 'left_click', coordinate: [10, 10] }),
    'tc-c1',
  )
  await waitForRequests(requests, 1)
  getApprovalChannel().resolve('tc-c1', { approved: true, allowSession: true })
  await first

  executor.resetDesktopSessionAllow()

  const second = executor.executeAsync(
    'computer_use',
    ARGS({ action: 'left_click', coordinate: [10, 10] }),
    'tc-c2',
  )
  await waitForRequests(requests, 2)
  getApprovalChannel().resolve('tc-c2', { approved: false, reason: '不点了' })
  const r2 = await second
  assert.equal(r2.success, false)
  assert.ok(r2.error!.includes('用户拒绝执行'))
})

test('三级审批：主动作缺少 toolCallId 时明确报错（审批无法挂起）', async (t) => {
  const { executor } = makeDesktopExecutor()
  t.after(() => resetApprovalChannel())

  await executor.executeAsync('capture_screen', '{}', 'tc-cap')
  const result = await executor.executeAsync(
    'computer_use',
    ARGS({ action: 'left_click', coordinate: [10, 10] }),
  )
  assert.equal(result.success, false)
  assert.ok(result.error!.includes('toolCallId'))
})
