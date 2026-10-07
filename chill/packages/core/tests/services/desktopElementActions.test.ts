import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BuiltInToolExecutor } from '../../src/services/builtInToolExecutor.ts'
import { getApprovalChannel, resetApprovalChannel, type ApprovalRequestPayload } from '../../src/services/approvals.ts'
import { eventBus, EVENTS } from '../../src/utils/eventBus.ts'
import type { DesktopInputAction, UiElementInfo } from '../../src/interfaces/IDesktopController.ts'

/** 两个假元素：#1 有 invoke（按钮），#2 无 invoke 无 value（自绘区），#3 有 value（编辑框） */
const ELEMENTS: UiElementInfo[] = [
  { label: 1, name: '文件', controlType: 'MenuItem', x: 100, y: 10, width: 60, height: 30, hwnd: 111, runtimeId: 'rid-1', hasInvoke: true, hasValue: false, hasToggle: false },
  { label: 2, name: '画布', controlType: 'Pane', x: 200, y: 100, width: 400, height: 300, hwnd: 222, runtimeId: 'rid-2', hasInvoke: false, hasValue: false, hasToggle: false },
  { label: 3, name: '编辑区', controlType: 'Edit', x: 300, y: 200, width: 500, height: 400, hwnd: 333, runtimeId: 'rid-3', hasInvoke: false, hasValue: true, hasToggle: false },
]

/** 假桌面控制器（记录调用序列）+ 开关已开启的 executor */
function makeExecutor(overrides?: {
  snapshotResult?: UiElementInfo[]
  invokeError?: string
}) {
  const calls: { kind: string; detail?: unknown }[] = []
  const inputs: DesktopInputAction[] = []
  const executor = new BuiltInToolExecutor({} as any, {} as any, {} as any, {} as any)
  executor.setDesktopController({
    isAvailable: async () => true,
    // 四期接口扩展（多显示器）；本文件不测选屏路径，给单屏最小桩满足接口
    listDisplays: async () => [
      { index: 0, name: '\\\\.\\DISPLAY1', x: 0, y: 0, width: 2560, height: 1440, dpiScale: 2.0, isPrimary: true },
    ],
    capture: async () => ({
      dataUri: 'data:image/png;base64,QUJD',
      width: 1280, height: 720, dpiScale: 2.0,
      originX: 0, originY: 0, physWidth: 2560, physHeight: 1440,
    }),
    input: async (action: DesktopInputAction) => {
      inputs.push(action)
      calls.push({ kind: 'input', detail: action })
      return { success: true }
    },
    snapshot: async (scope?: string) => {
      calls.push({ kind: 'snapshot', detail: scope })
      return overrides?.snapshotResult ?? ELEMENTS
    },
    invokeElement: async (runtimeId: string) => {
      calls.push({ kind: 'invoke', detail: runtimeId })
      return overrides?.invokeError
        ? { success: false, error: overrides.invokeError }
        : { success: true }
    },
    setElementValue: async (runtimeId: string, text: string) => {
      calls.push({ kind: 'setValue', detail: { runtimeId, text } })
      return { success: true }
    },
    focusWindow: async (hwnd: number) => {
      calls.push({ kind: 'focus', detail: hwnd })
      return { success: true }
    },
  })
  executor.setMediaCapabilitiesProvider(() => ({ supportsImage: true }))
  executor.setConfigStore({
    getItem: (k: string) => (k === 'desktop_control_enabled' ? 'true' : null),
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  })
  return { executor, calls, inputs }
}

/** 监听审批并在请求出现时自动批准（元素级三动作均为主动作，必过审批） */
function autoApprove(t: { after: (fn: () => void) => void }) {
  const requests: ApprovalRequestPayload[] = []
  const listener = (data: ApprovalRequestPayload) => {
    requests.push(data)
    // 下一拍批准（模拟用户点确认），让 executeAsync 继续
    setImmediate(() => getApprovalChannel().resolve(data.toolCallId, { approved: true }))
  }
  eventBus.on(EVENTS.APPROVAL_REQUESTED, listener)
  t.after(() => eventBus.off(EVENTS.APPROVAL_REQUESTED, listener))
  t.after(() => resetApprovalChannel())
  return requests
}

const ARGS = (extra: Record<string, any>) =>
  JSON.stringify({ purpose: '测试动作', intent: '测试意图', ...extra })

/** 先 inspect_ui 建立快照（只读免审批） */
async function inspectFirst(executor: BuiltInToolExecutor) {
  const r = await executor.executeAsync('inspect_ui', '{}', 'tc-inspect')
  assert.equal(r.success, true, `inspect_ui 应先成功: ${r.error}`)
  return r
}

test('inspect_ui：正常表格式化为编号元素表（含 bbox 物理像素与 patterns 标记）', async (t) => {
  const { executor, calls } = makeExecutor()
  const r = await executor.executeAsync('inspect_ui', '{}', 'tc-1')
  assert.equal(r.success, true)
  const content = r.data!.content as string
  assert.ok(content.includes('共 3 个可交互元素'))
  assert.ok(content.includes('[1] 文件 (MenuItem) bbox=(100,10,60,30) hwnd=111 patterns=invoke'))
  assert.ok(content.includes('[2] 画布 (Pane) bbox=(200,100,400,300) hwnd=222 patterns=无'))
  assert.ok(content.includes('[3] 编辑区 (Edit) bbox=(300,200,500,400) hwnd=333 patterns=value'))
  // 缺省 scope 为 active_window
  assert.deepEqual(calls[0], { kind: 'snapshot', detail: 'active_window' })
})

test('inspect_ui：空表返回明确回退文案（自绘/游戏窗口 → capture_screen + 像素坐标）', async () => {
  const { executor } = makeExecutor({ snapshotResult: [] })
  const r = await executor.executeAsync('inspect_ui', '{}', 'tc-2')
  assert.equal(r.success, true)
  assert.ok(r.data!.content.includes('未发现可交互元素'))
  assert.ok(r.data!.content.includes('capture_screen'))
})

test('inspect_ui：超 200 元素截断并注明', async () => {
  const many: UiElementInfo[] = Array.from({ length: 250 }, (_, i) => ({
    label: i + 1, name: `元素${i + 1}`, controlType: 'Button',
    x: 0, y: 0, width: 10, height: 10, hwnd: 1, runtimeId: `rid-${i + 1}`,
    hasInvoke: true, hasValue: false, hasToggle: false,
  }))
  const { executor } = makeExecutor({ snapshotResult: many })
  const r = await executor.executeAsync('inspect_ui', '{}', 'tc-3')
  assert.equal(r.success, true)
  const content = r.data!.content as string
  assert.ok(content.includes('共 250 个'))
  assert.ok(content.includes('仅显示前 200 个'))
  assert.ok(content.includes('[200]'))
  assert.ok(!content.includes('[201]'))
})

test('click_element：无快照 / label 越界时明确报错并引导 inspect_ui', async (t) => {
  const { executor } = makeExecutor()
  autoApprove(t)

  // 无快照
  const r1 = await executor.executeAsync('computer_use', ARGS({ action: 'click_element', label: 1 }), 'tc-4a')
  assert.equal(r1.success, false)
  assert.ok(r1.error!.includes('请先调用 inspect_ui'))

  // 越界（快照只有 3 个元素）
  await inspectFirst(executor)
  const r2 = await executor.executeAsync('computer_use', ARGS({ action: 'click_element', label: 99 }), 'tc-4b')
  assert.equal(r2.success, false)
  assert.ok(r2.error!.includes('不在最近一次 inspect_ui 结果中'))
})

test('click_element：有 invoke 元素走 InvokePattern（不动鼠标、不 focus），审批文案人话化', async (t) => {
  const { executor, calls, inputs } = makeExecutor()
  const requests = autoApprove(t)
  await inspectFirst(executor)

  const r = await executor.executeAsync('computer_use', ARGS({ action: 'click_element', label: 1 }), 'tc-5')
  assert.equal(r.success, true)
  // invoke 优先：只调 invokeElement，不 focus、不像素点击
  assert.deepEqual(calls.filter((c) => c.kind !== 'snapshot'), [{ kind: 'invoke', detail: 'rid-1' }])
  assert.equal(inputs.length, 0)
  assert.ok(r.data!.content.includes('invoke 直接调用'))
  // 审批文案：点击【文件】（MenuItem）
  assert.equal(requests[0].command, '点击【文件】（MenuItem）')
})

test('click_element：无 invoke 元素回退 focusWindow + 像素直点 bbox 中心（物理像素，不过 toPhysical）', async (t) => {
  const { executor, calls, inputs } = makeExecutor()
  autoApprove(t)
  // 先截屏建立模型图坐标系（换算比 0.5）：若错误走 toPhysical，坐标会被换算污染
  await executor.executeAsync('capture_screen', '{}', 'tc-cap')
  await inspectFirst(executor)

  // 元素 #2：bbox=(200,100,400,300) → 中心 (400,250) 物理像素
  const r = await executor.executeAsync('computer_use', ARGS({ action: 'click_element', label: 2 }), 'tc-6')
  assert.equal(r.success, true)
  assert.deepEqual(calls.filter((c) => c.kind === 'focus'), [{ kind: 'focus', detail: 222 }])
  assert.deepEqual(inputs, [{ action: 'mouse_click', x: 400, y: 250, button: 'left', count: 1 }])
  assert.ok(r.data!.content.includes('bbox 中心'))
})

test('click_element：元素失效错误透传（引导重新 inspect_ui）', async (t) => {
  const { executor } = makeExecutor({ invokeError: '元素已失效，请重新 inspect_ui' })
  autoApprove(t)
  await inspectFirst(executor)

  const r = await executor.executeAsync('computer_use', ARGS({ action: 'click_element', label: 1 }), 'tc-7')
  assert.equal(r.success, false)
  assert.ok(r.error!.includes('元素已失效，请重新 inspect_ui'))
})

test('set_value：有 value 元素走 ValuePattern 直接写入', async (t) => {
  const { executor, calls, inputs } = makeExecutor()
  autoApprove(t)
  await inspectFirst(executor)

  const r = await executor.executeAsync('computer_use', ARGS({ action: 'set_value', label: 3, text: '你好' }), 'tc-8')
  assert.equal(r.success, true)
  assert.deepEqual(calls.filter((c) => c.kind !== 'snapshot'), [
    { kind: 'setValue', detail: { runtimeId: 'rid-3', text: '你好' } },
  ])
  assert.equal(inputs.length, 0)
})

test('set_value：无 value pattern 回退 focus + 像素点击 + ctrl+a/delete 全清 + type', async (t) => {
  const { executor, calls, inputs } = makeExecutor()
  autoApprove(t)
  await inspectFirst(executor)

  const r = await executor.executeAsync('computer_use', ARGS({ action: 'set_value', label: 2, text: 'abc' }), 'tc-9')
  assert.equal(r.success, true)
  assert.deepEqual(calls.filter((c) => c.kind === 'focus'), [{ kind: 'focus', detail: 222 }])
  // 点击 bbox 中心（200+400/2, 100+300/2）→ 全清 → 键入
  assert.deepEqual(inputs, [
    { action: 'mouse_click', x: 400, y: 250, button: 'left', count: 1 },
    { action: 'key', keys: 'ctrl+a' },
    { action: 'key', keys: 'delete' },
    { action: 'type', text: 'abc' },
  ])
})

test('focus_window：label 与 hwnd 双缺时明确报错；hwnd 直通；label 解析取元素 hwnd', async (t) => {
  const { executor, calls } = makeExecutor()
  autoApprove(t)

  // 双缺
  const r1 = await executor.executeAsync('computer_use', ARGS({ action: 'focus_window' }), 'tc-10a')
  assert.equal(r1.success, false)
  assert.ok(r1.error!.includes('label 或 hwnd'))

  // hwnd 直通（无需快照）
  const r2 = await executor.executeAsync('computer_use', ARGS({ action: 'focus_window', hwnd: 777 }), 'tc-10b')
  assert.equal(r2.success, true)
  assert.deepEqual(calls.filter((c) => c.kind === 'focus'), [{ kind: 'focus', detail: 777 }])

  // label 解析
  await inspectFirst(executor)
  const r3 = await executor.executeAsync('computer_use', ARGS({ action: 'focus_window', label: 3 }), 'tc-10c')
  assert.equal(r3.success, true)
  assert.deepEqual(calls.filter((c) => c.kind === 'focus').at(-1), { kind: 'focus', detail: 333 })
})
