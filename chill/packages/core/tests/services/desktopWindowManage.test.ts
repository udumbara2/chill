import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BuiltInToolExecutor } from '../../src/services/builtInToolExecutor.ts'
import { getApprovalChannel, resetApprovalChannel, type ApprovalRequestPayload } from '../../src/services/approvals.ts'
import { eventBus, EVENTS } from '../../src/utils/eventBus.ts'
import type { DesktopWindowManageOp } from '../../src/interfaces/IDesktopController.ts'

/**
 * window_manage 动作：参数校验 / rect 分路换算（图像坐标系→物理）/ 审批分类 / 宿主 close 拒绝透传。
 * 假控制器坐标系：物理 2560×1440 → 图像 1280×720（scale=2，原点 0,0）。
 */
function makeExecutor(opts?: { manageError?: string }) {
  const calls: Array<{ hwnd: number; op: DesktopWindowManageOp; rect?: { x: number; y: number; width: number; height: number } }> = []
  const executor = new BuiltInToolExecutor({} as any, {} as any, {} as any, {} as any)
  executor.setDesktopController({
    isAvailable: async () => true,
    listDisplays: async () => [],
    capture: async () => ({
      dataUri: 'data:image/png;base64,QUJD',
      width: 1280, height: 720, dpiScale: 2.0,
      originX: 0, originY: 0, physWidth: 2560, physHeight: 1440,
    }),
    input: async () => ({ success: true }),
    snapshot: async () => [],
    invokeElement: async () => ({ success: true }),
    setElementValue: async () => ({ success: true }),
    focusWindow: async () => ({ success: true }),
    preflight: async () => ({ escPressed: false, x: 0, y: 0 }),
    releaseAllInputs: async () => {},
    setProtectedExtraPids: async () => {},
    setApprovalPending: async () => {},
    manageWindow: async (req) => {
      calls.push(req)
      return opts?.manageError ? { success: false, error: opts.manageError } : { success: true }
    },
  })
  executor.setMediaCapabilitiesProvider(() => ({ supportsImage: true }))
  executor.setConfigStore({
    getItem: (k: string) => (k === 'desktop_control_enabled' ? 'true' : null),
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  })
  return { executor, calls }
}

function autoApprove(t: { after: (fn: () => void) => void }) {
  const requests: ApprovalRequestPayload[] = []
  const listener = (data: ApprovalRequestPayload) => {
    requests.push(data)
    setImmediate(() => getApprovalChannel().resolve(data.toolCallId, { approved: true }))
  }
  eventBus.on(EVENTS.APPROVAL_REQUESTED, listener)
  t.after(() => eventBus.off(EVENTS.APPROVAL_REQUESTED, listener))
  t.after(() => resetApprovalChannel())
  return requests
}

const ARGS = (extra: Record<string, any>) => JSON.stringify({ purpose: 'wm 测试', intent: 'wm 测试', ...extra })

test('参数校验：op 非法 / label 与 hwnd 双缺 / 几何操作缺 rect → 前置错误', async (t) => {
  const { executor, calls } = makeExecutor()
  autoApprove(t)
  await executor.executeAsync('capture_screen', '{}', 'tc-cap')
  let r = await executor.executeAsync('computer_use', ARGS({ action: 'window_manage', hwnd: 123, op: 'explode' }), 'tc-1')
  assert.equal(r.success, false); assert.ok(r.error!.includes('op 参数'))
  r = await executor.executeAsync('computer_use', ARGS({ action: 'window_manage', op: 'minimize' }), 'tc-2')
  assert.equal(r.success, false); assert.ok(r.error!.includes('label 或 hwnd'))
  r = await executor.executeAsync('computer_use', ARGS({ action: 'window_manage', hwnd: 123, op: 'resize' }), 'tc-3')
  assert.equal(r.success, false); assert.ok(r.error!.includes('rect'))
  assert.equal(calls.length, 0)
})

test('resize 换算：图像尺寸 ×imageScale（保位置语义由原生层保）', async (t) => {
  const { executor, calls } = makeExecutor()
  autoApprove(t)
  await executor.executeAsync('capture_screen', '{}', 'tc-cap')
  const r = await executor.executeAsync('computer_use', ARGS({ action: 'window_manage', hwnd: 123, op: 'resize', rect: [0, 0, 320, 240] }), 'tc-4')
  assert.equal(r.success, true)
  assert.deepEqual(calls[0], { hwnd: 123, op: 'resize', rect: { x: 0, y: 0, width: 640, height: 480 } })
})

test('move/set_bounds 换算：图像点 → 物理（scale=2，原点 0,0）', async (t) => {
  const { executor, calls } = makeExecutor()
  autoApprove(t)
  await executor.executeAsync('capture_screen', '{}', 'tc-cap')
  await executor.executeAsync('computer_use', ARGS({ action: 'window_manage', hwnd: 123, op: 'move', rect: [100, 50, 0, 0] }), 'tc-5')
  assert.deepEqual(calls[0].rect, { x: 200, y: 100, width: 0, height: 0 })
  await executor.executeAsync('computer_use', ARGS({ action: 'window_manage', hwnd: 123, op: 'set_bounds', rect: [100, 50, 320, 240] }), 'tc-6')
  assert.deepEqual(calls[1].rect, { x: 200, y: 100, width: 640, height: 480 })
})

test('主动作审批：window_manage 触发审批且人话文案正确', async (t) => {
  const { executor } = makeExecutor()
  const requests = autoApprove(t)
  await executor.executeAsync('capture_screen', '{}', 'tc-cap')
  await executor.executeAsync('computer_use', ARGS({ action: 'window_manage', hwnd: 123, op: 'minimize' }), 'tc-7')
  assert.equal(requests.length, 1)
  assert.ok(requests[0].command.includes('最小化'))
  assert.ok(requests[0].command.includes('hwnd=123'))
})

test('宿主 close 拒绝透传：原生层拒绝文案原样返回', async (t) => {
  const { executor } = makeExecutor({ manageError: 'chill 宿主窗口永远不可经 window_manage 关闭（单不变量）' })
  autoApprove(t)
  const r = await executor.executeAsync('computer_use', ARGS({ action: 'window_manage', hwnd: 456, op: 'close' }), 'tc-8')
  assert.equal(r.success, false)
  assert.ok(r.error!.includes('宿主窗口'))
})
