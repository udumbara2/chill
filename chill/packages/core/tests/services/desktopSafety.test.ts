import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BuiltInToolExecutor } from '../../src/services/builtInToolExecutor.ts'
import { getApprovalChannel, resetApprovalChannel, type ApprovalRequestPayload } from '../../src/services/approvals.ts'
import { eventBus, EVENTS } from '../../src/utils/eventBus.ts'
import type { DesktopInputAction, DesktopPreflight } from '../../src/interfaces/IDesktopController.ts'

/**
 * 桌面安全体系（防崩溃规划 L1）：批首 releaseAllInputs + 逐步 preflight
 * （ESC 物理中止 / 用户鼠标接管暂停 / 探测失败降级不阻断）。
 * 假控制器与 desktopBatch.test.ts 同款坐标系（物理 2560×1440 → 图像 1280×720）。
 */
function makeExecutor(opts?: {
  /** preflight 应答脚本：每次调用弹出队首；空了返回默认（无 ESC、光标 0,0） */
  preflightQueue?: DesktopPreflight[]
  preflightThrows?: boolean
}) {
  const inputs: DesktopInputAction[] = []
  let releaseCount = 0
  let preflightCount = 0
  const queue = [...(opts?.preflightQueue ?? [])]
  const pendingStates: boolean[] = []
  const executor = new BuiltInToolExecutor({} as any, {} as any, {} as any, {} as any)
  executor.setDesktopController({
    isAvailable: async () => true,
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
      return { success: true }
    },
    snapshot: async () => [],
    invokeElement: async () => ({ success: true }),
    setElementValue: async () => ({ success: true }),
    focusWindow: async () => ({ success: true }),
    preflight: async () => {
      preflightCount++
      if (opts?.preflightThrows) throw new Error('模拟探测失败')
      return queue.length > 0 ? queue.shift()! : { escPressed: false, x: 0, y: 0 }
    },
    releaseAllInputs: async () => {
      releaseCount++
    },
    setProtectedExtraPids: async () => {},
    setApprovalPending: async (pending: boolean) => {
      pendingStates.push(pending)
    },
  })
  executor.setMediaCapabilitiesProvider(() => ({ supportsImage: true }))
  executor.setConfigStore({
    getItem: (k: string) => (k === 'desktop_control_enabled' ? 'true' : null),
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  })
  return { executor, inputs, getReleaseCount: () => releaseCount, getPreflightCount: () => preflightCount, pendingStates }
}

function autoApprove(t: { after: (fn: () => void) => void }) {
  const listener = (data: ApprovalRequestPayload) => {
    setImmediate(() => getApprovalChannel().resolve(data.toolCallId, { approved: true }))
  }
  eventBus.on(EVENTS.APPROVAL_REQUESTED, listener)
  t.after(() => eventBus.off(EVENTS.APPROVAL_REQUESTED, listener))
  t.after(() => resetApprovalChannel())
}

const BATCH = (n: number) =>
  JSON.stringify({
    purpose: '安全测试',
    intent: '安全测试',
    actions: Array.from({ length: n }, (_, i) => ({ action: 'type', text: `t${i}` })),
  })

test('批首调用 releaseAllInputs 清理残留卡键状态', async (t) => {
  const { executor, getReleaseCount, getPreflightCount } = makeExecutor()
  autoApprove(t)
  const result = await executor.executeAsync('computer_use', BATCH(2), 'tc-1')
  assert.equal(result.success, true)
  assert.equal(getReleaseCount(), 1)
  assert.ok(getPreflightCount() >= 2) // 批首基线 + 逐步探测 + 逐步基线刷新
})

test('ESC 中止：第 2 步前探测到 ESC → 整批中止，第 2 步起不执行，文案禁止自动重试', async (t) => {
  // preflight 调用序：批首基线 → 步1前 → 步1后基线 → 步2前（ESC!）
  const { executor, inputs } = makeExecutor({
    preflightQueue: [
      { escPressed: false, x: 0, y: 0 },
      { escPressed: false, x: 0, y: 0 },
      { escPressed: false, x: 0, y: 0 },
      { escPressed: true, x: 0, y: 0 },
    ],
  })
  autoApprove(t)
  const result = await executor.executeAsync('computer_use', BATCH(3), 'tc-2')
  assert.equal(result.success, false)
  assert.ok(result.error!.includes('用户按 ESC 中止'))
  assert.ok(result.error!.includes('第 2/3 步及后续未执行'))
  assert.ok(result.error!.includes('不要自动重试') || result.error!.includes('请勿自动重试'))
  assert.deepEqual(inputs, [{ action: 'type', text: 't0' }]) // 只有第 1 步执行了
})

test('用户接管：光标偏离基线超阈值 → 批处理暂停并如实汇报', async (t) => {
  const { executor, inputs } = makeExecutor({
    preflightQueue: [
      { escPressed: false, x: 100, y: 100 }, // 批首基线
      { escPressed: false, x: 100, y: 100 }, // 步1前：无偏差
      { escPressed: false, x: 100, y: 100 }, // 步1后基线
      { escPressed: false, x: 300, y: 100 }, // 步2前：用户把光标移走了 200px
    ],
  })
  autoApprove(t)
  const result = await executor.executeAsync('computer_use', BATCH(3), 'tc-3')
  assert.equal(result.success, false)
  assert.ok(result.error!.includes('用户移动鼠标接管'))
  assert.deepEqual(inputs, [{ action: 'type', text: 't0' }])
})

test('基线内微小偏移（≤15px）不误判接管', async (t) => {
  const { executor, inputs } = makeExecutor({
    preflightQueue: [
      { escPressed: false, x: 100, y: 100 },
      { escPressed: false, x: 105, y: 103 }, // 微小偏移
      { escPressed: false, x: 105, y: 103 },
      { escPressed: false, x: 108, y: 106 },
      { escPressed: false, x: 108, y: 106 },
    ],
  })
  autoApprove(t)
  const result = await executor.executeAsync('computer_use', BATCH(2), 'tc-4')
  assert.equal(result.success, true)
  assert.equal(inputs.length, 2)
})

test('preflight 探测失败降级：不阻断批处理执行', async (t) => {
  const { executor, inputs } = makeExecutor({ preflightThrows: true })
  autoApprove(t)
  const result = await executor.executeAsync('computer_use', BATCH(2), 'tc-5')
  assert.equal(result.success, true)
  assert.equal(inputs.length, 2)
})

test('审批挂起状态传播：挂起 → setApprovalPending(true)，落定 → false；多源计数聚合不互冲', async (t) => {
  const { pendingStates } = (() => {
    const { executor, pendingStates } = makeExecutor()
    void executor // 仅需其订阅副作用
    return { pendingStates }
  })()
  t.after(() => resetApprovalChannel())

  const tick = () => new Promise((r) => setImmediate(r))
  // 通道主路径：两个并发挂起
  const p1 = getApprovalChannel().request({ toolCallId: 'ap-1', kind: 'command', command: 'a', origin: { source: 'main' } } as any)
  const p2 = getApprovalChannel().request({ toolCallId: 'ap-2', kind: 'command', command: 'b', origin: { source: 'main' } } as any)
  await tick()
  assert.deepEqual(pendingStates, [true])
  // 落定一个，另一个仍挂起——计数聚合，不得回落 false
  getApprovalChannel().resolve('ap-1', { approved: true })
  await p1
  await tick()
  assert.deepEqual(pendingStates, [true])
  // 全部落定 → false
  getApprovalChannel().resolve('ap-2', { approved: false })
  await p2
  await tick()
  assert.deepEqual(pendingStates, [true, false])
})
