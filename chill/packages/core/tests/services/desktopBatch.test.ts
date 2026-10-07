import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BuiltInToolExecutor } from '../../src/services/builtInToolExecutor.ts'
import { getApprovalChannel, resetApprovalChannel, type ApprovalRequestPayload } from '../../src/services/approvals.ts'
import { eventBus, EVENTS } from '../../src/utils/eventBus.ts'
import type { DesktopInputAction } from '../../src/interfaces/IDesktopController.ts'

/**
 * 动作批处理（四期）：actions 数组整批一次审批、按序执行、遇错即停。
 * 假控制器与 desktopApproval.test.ts 同款坐标系（物理 2560×1440 → 图像 1280×720）。
 */
function makeExecutor(opts?: { failOnInput?: (a: DesktopInputAction) => string | null }) {
  const inputs: DesktopInputAction[] = []
  let captureCount = 0
  const executor = new BuiltInToolExecutor({} as any, {} as any, {} as any, {} as any)
  executor.setDesktopController({
    isAvailable: async () => true,
    listDisplays: async () => [
      { index: 0, name: '\\\\.\\DISPLAY1', x: 0, y: 0, width: 2560, height: 1440, dpiScale: 2.0, isPrimary: true },
    ],
    capture: async () => {
      captureCount++
      return {
        dataUri: 'data:image/png;base64,QUJD',
        width: 1280, height: 720, dpiScale: 2.0,
        originX: 0, originY: 0, physWidth: 2560, physHeight: 1440,
      }
    },
    input: async (action: DesktopInputAction) => {
      inputs.push(action)
      const err = opts?.failOnInput?.(action)
      return err ? { success: false, error: err } : { success: true }
    },
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
  return { executor, inputs, getCaptureCount: () => captureCount }
}

/** 监听审批并自动批准（记录载荷供断言）；返回审批请求列表 */
function autoApprove(t: { after: (fn: () => void) => void }, allowSession = false) {
  const requests: ApprovalRequestPayload[] = []
  const listener = (data: ApprovalRequestPayload) => {
    requests.push(data)
    setImmediate(() => getApprovalChannel().resolve(data.toolCallId, { approved: true, allowSession }))
  }
  eventBus.on(EVENTS.APPROVAL_REQUESTED, listener)
  t.after(() => eventBus.off(EVENTS.APPROVAL_REQUESTED, listener))
  t.after(() => resetApprovalChannel())
  return requests
}

const ARGS = (extra: Record<string, any>) =>
  JSON.stringify({ purpose: '测试批处理', intent: '测试意图', ...extra })

test('批处理：按序执行且整批一次审批，审批载荷为编号人话清单', async (t) => {
  const { executor, inputs } = makeExecutor()
  const requests = autoApprove(t)

  await executor.executeAsync('capture_screen', '{}', 'tc-cap')
  const result = await executor.executeAsync(
    'computer_use',
    ARGS({
      actions: [
        { action: 'left_click', coordinate: [640, 360] },
        { action: 'type', text: 'hello' },
        { action: 'key', keys: 'CTRL+S' },
      ],
    }),
    'tc-batch',
  )
  assert.equal(result.success, true)
  assert.ok(result.data.content.includes('3/3 步全部成功'))
  // 整批一次审批：编号清单 + sessionGrantable（[s] 语义不变）
  assert.equal(requests.length, 1)
  assert.ok(requests[0].command.includes('批量桌面操作（共 3 步）'))
  assert.ok(requests[0].command.includes('1. 鼠标左键点击 (640, 360)'))
  assert.ok(requests[0].command.includes('2. 输入文本「hello」'))
  assert.ok(requests[0].command.includes('3. 按下按键「CTRL+S」'))
  assert.equal(requests[0].sessionGrantable, true)
  // 按序执行，坐标经模型图→物理换算（640,360 → 1280,720）
  assert.deepEqual(inputs, [
    { action: 'mouse_click', x: 1280, y: 720, button: 'left', count: 1 },
    { action: 'type', text: 'hello' },
    { action: 'key', keys: 'ctrl+s' },
  ])
})

test('批处理：遇错即停——返回失败步号/原因 + 已完成步摘要，后续步不执行', async (t) => {
  const { executor, inputs } = makeExecutor({
    failOnInput: (a) => (a.action === 'type' ? '模拟宿主输入失败' : null),
  })
  autoApprove(t)

  await executor.executeAsync('capture_screen', '{}', 'tc-cap')
  const result = await executor.executeAsync(
    'computer_use',
    ARGS({
      actions: [
        { action: 'left_click', coordinate: [10, 10] },
        { action: 'type', text: 'hello' },
        { action: 'key', keys: 'enter' },
      ],
    }),
    'tc-batch',
  )
  assert.equal(result.success, false)
  assert.ok(result.error!.includes('第 2/3 步失败：模拟宿主输入失败'))
  assert.ok(result.error!.includes('已完成 1 步'))
  assert.ok(result.error!.includes('1. 鼠标左键点击 (10, 10)'))
  // 第 3 步未执行
  assert.equal(inputs.length, 2)
})

test('批处理：参数校验失败同样遇错即停（缺 text 的 type）', async (t) => {
  const { executor, inputs } = makeExecutor()
  autoApprove(t)

  const result = await executor.executeAsync(
    'computer_use',
    ARGS({ actions: [{ action: 'wait', seconds: 0 }, { action: 'type' }, { action: 'wait', seconds: 0 }] }),
    'tc-batch',
  )
  assert.equal(result.success, false)
  assert.ok(result.error!.includes('第 2/3 步失败：type 需要提供 text 参数'))
  assert.equal(inputs.length, 0)
})

test('批处理：上限 20 个动作，超出明确报错且不审批不执行', async (t) => {
  const { executor, inputs } = makeExecutor()
  const requests: ApprovalRequestPayload[] = []
  const listener = (data: ApprovalRequestPayload) => requests.push(data)
  eventBus.on(EVENTS.APPROVAL_REQUESTED, listener)
  t.after(() => eventBus.off(EVENTS.APPROVAL_REQUESTED, listener))
  t.after(() => resetApprovalChannel())

  const actions = Array.from({ length: 21 }, () => ({ action: 'wait', seconds: 0 }))
  const result = await executor.executeAsync('computer_use', ARGS({ actions }), 'tc-batch')
  assert.equal(result.success, false)
  assert.ok(result.error!.includes('上限为 20'))
  assert.equal(requests.length, 0)
  assert.equal(inputs.length, 0)
})

test('批处理：纯被动批（mouse_move/wait/screenshot）免审批直通', async (t) => {
  const { executor, inputs, getCaptureCount } = makeExecutor()
  const requests: ApprovalRequestPayload[] = []
  const listener = (data: ApprovalRequestPayload) => requests.push(data)
  eventBus.on(EVENTS.APPROVAL_REQUESTED, listener)
  t.after(() => eventBus.off(EVENTS.APPROVAL_REQUESTED, listener))
  t.after(() => resetApprovalChannel())

  await executor.executeAsync('capture_screen', '{}', 'tc-cap')
  const result = await executor.executeAsync(
    'computer_use',
    ARGS({ actions: [{ action: 'mouse_move', coordinate: [100, 100] }, { action: 'wait', seconds: 0 }, { action: 'screenshot' }] }),
    'tc-batch',
  )
  assert.equal(result.success, true)
  assert.equal(requests.length, 0)
  assert.deepEqual(inputs, [{ action: 'mouse_move', x: 200, y: 200 }])
  // 末步为 screenshot：回传最终截图（建立坐标系 1 次 + 批内 1 次）
  assert.equal(getCaptureCount(), 2)
  assert.ok(result.mediaParts && result.mediaParts.length === 1)
})

test('批处理：含任一主动作则整批需审批（被动判定按批内最高等级）', async (t) => {
  const { executor } = makeExecutor()
  const requests = autoApprove(t)

  await executor.executeAsync('capture_screen', '{}', 'tc-cap')
  const result = await executor.executeAsync(
    'computer_use',
    ARGS({ actions: [{ action: 'wait', seconds: 0 }, { action: 'key', keys: 'enter' }] }),
    'tc-batch',
  )
  assert.equal(result.success, true)
  assert.equal(requests.length, 1)
})

test('批处理：[s] 会话放行后后续主动作直通（desktopSessionAllowed 语义不变）', async (t) => {
  const { executor, inputs } = makeExecutor()
  const requests = autoApprove(t, true)

  await executor.executeAsync('capture_screen', '{}', 'tc-cap')
  const r1 = await executor.executeAsync(
    'computer_use',
    ARGS({ actions: [{ action: 'left_click', coordinate: [1, 1] }] }),
    'tc-batch',
  )
  assert.equal(r1.success, true)
  assert.equal(requests.length, 1)

  // 会话放行生效：第二个主动作（单动作路径）不再审批
  const r2 = await executor.executeAsync(
    'computer_use',
    ARGS({ action: 'key', keys: 'enter' }),
    'tc-c2',
  )
  assert.equal(r2.success, true)
  assert.equal(requests.length, 1)
  assert.equal(inputs.length, 2)
})

test('批处理：actions 与单动作参数互斥，actions 存在时优先', async (t) => {
  const { executor, inputs } = makeExecutor()
  autoApprove(t)

  const result = await executor.executeAsync(
    'computer_use',
    // action=type 存在但 actions 优先：只执行批内的 key
    ARGS({ action: 'type', text: '不应执行', actions: [{ action: 'key', keys: 'enter' }] }),
    'tc-batch',
  )
  assert.equal(result.success, true)
  assert.deepEqual(inputs, [{ action: 'key', keys: 'enter' }])
})

test('批处理：screenshotAfter=true 批末回传最终截图', async (t) => {
  const { executor, getCaptureCount } = makeExecutor()
  autoApprove(t)

  const result = await executor.executeAsync(
    'computer_use',
    ARGS({ actions: [{ action: 'key', keys: 'enter' }], screenshotAfter: true }),
    'tc-batch',
  )
  assert.equal(result.success, true)
  assert.equal(getCaptureCount(), 1)
  assert.ok(result.mediaParts && result.mediaParts.length === 1)
  assert.ok(result.data.content.includes('截图尺寸 1280×720'))
})

test('批处理：缺 toolCallId 的主动作批明确报错（审批无法挂起）', async (t) => {
  const { executor } = makeExecutor()
  t.after(() => resetApprovalChannel())

  const result = await executor.executeAsync(
    'computer_use',
    ARGS({ actions: [{ action: 'key', keys: 'enter' }] }),
  )
  assert.equal(result.success, false)
  assert.ok(result.error!.includes('toolCallId'))
})
