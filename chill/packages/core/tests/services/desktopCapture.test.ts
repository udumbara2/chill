import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BuiltInToolExecutor } from '../../src/services/builtInToolExecutor.ts'
import { resetApprovalChannel } from '../../src/services/approvals.ts'
import type { DesktopInputAction, DisplayInfo, DesktopCaptureRegion } from '../../src/interfaces/IDesktopController.ts'

/**
 * capture_screen 四期扩展：display 选屏透传 + 多屏摘要清单、region zoom 换算与点击映射。
 * 假控制器模拟 napi 行为：crop 时先裁剪再等比缩放（长边 ≤1280），origin/phys 按裁剪框回写。
 */

interface CaptureReq { display?: number; maxLongEdge?: number; regionPhys?: DesktopCaptureRegion }

const DISPLAYS_SINGLE: DisplayInfo[] = [
  { index: 0, name: '\\\\.\\DISPLAY1', x: 0, y: 0, width: 2560, height: 1440, dpiScale: 2.0, isPrimary: true },
]
const DISPLAYS_DUAL: DisplayInfo[] = [
  ...DISPLAYS_SINGLE,
  { index: 1, name: '\\\\.\\DISPLAY2', x: 2560, y: 0, width: 1920, height: 1080, dpiScale: 1.0, isPrimary: false },
]

function makeExecutor(opts?: { displays?: DisplayInfo[] }) {
  const displays = opts?.displays ?? DISPLAYS_SINGLE
  const captureReqs: CaptureReq[] = []
  const inputs: DesktopInputAction[] = []
  const executor = new BuiltInToolExecutor({} as any, {} as any, {} as any, {} as any)
  executor.setDesktopController({
    isAvailable: async () => true,
    listDisplays: async () => displays,
    capture: async (req?: CaptureReq) => {
      captureReqs.push(req ?? {})
      const d = displays.find((x) => x.index === (req?.display ?? displays.find((p) => p.isPrimary)!.index))!
      // crop 回写：origin/phys 按裁剪框；否则整屏（模拟 napi captureDisplay 的 crop 语义）
      const crop = req?.regionPhys
      const originX = crop ? crop.x : d.x
      const originY = crop ? crop.y : d.y
      const physWidth = crop ? crop.width : d.width
      const physHeight = crop ? crop.height : d.height
      const longEdge = Math.max(physWidth, physHeight)
      const scale = longEdge > 1280 ? 1280 / longEdge : 1
      return {
        dataUri: 'data:image/png;base64,QUJD',
        width: Math.round(physWidth * scale),
        height: Math.round(physHeight * scale),
        dpiScale: d.dpiScale,
        originX, originY, physWidth, physHeight,
      }
    },
    input: async (action: DesktopInputAction) => {
      inputs.push(action)
      return { success: true }
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
  return { executor, captureReqs, inputs }
}

test('display 透传：capture_screen 的 display 参数原样传给控制器', async (t) => {
  const { executor, captureReqs } = makeExecutor({ displays: DISPLAYS_DUAL })
  t.after(() => resetApprovalChannel())

  const r = await executor.executeAsync('capture_screen', JSON.stringify({ display: 1 }), 'tc-cap')
  assert.equal(r.success, true)
  assert.equal(captureReqs[0].display, 1)
  // 副屏 1920×1080 → 图像 1280×720，origin 回写副屏原点
  assert.ok(r.data.content.includes('截图尺寸 1280×720'))
})

test('多屏摘要附加显示器清单；单屏不附加', async (t) => {
  const dual = makeExecutor({ displays: DISPLAYS_DUAL })
  t.after(() => resetApprovalChannel())

  const r1 = await dual.executor.executeAsync('capture_screen', '{}', 'tc-cap1')
  assert.equal(r1.success, true)
  assert.ok(r1.data.content.includes('当前共 2 台显示器'))
  assert.ok(r1.data.content.includes('#0 2560×1440 @(0,0)（主屏）'))
  assert.ok(r1.data.content.includes('#1 1920×1080 @(2560,0)'))

  const single = makeExecutor({ displays: DISPLAYS_SINGLE })
  const r2 = await single.executor.executeAsync('capture_screen', '{}', 'tc-cap2')
  assert.equal(r2.success, true)
  assert.ok(!r2.data.content.includes('台显示器'))
})

test('region zoom：无前置截屏明确报错引导先全屏截屏', async (t) => {
  const { executor } = makeExecutor()
  t.after(() => resetApprovalChannel())

  const r = await executor.executeAsync('capture_screen', JSON.stringify({ region: [0, 0, 100, 100] }), 'tc-cap')
  assert.equal(r.success, false)
  assert.ok(r.error!.includes('请先 capture_screen 全屏截屏再框选区域'))
})

test('region zoom：图像坐标经当前 meta 换算物理裁剪矩形透传', async (t) => {
  const { executor, captureReqs } = makeExecutor()
  t.after(() => resetApprovalChannel())

  await executor.executeAsync('capture_screen', '{}', 'tc-cap1')
  const r = await executor.executeAsync('capture_screen', JSON.stringify({ region: [100, 100, 740, 460] }), 'tc-cap2')
  assert.equal(r.success, true)
  // 图像 1280×720（物理 2560×1440，比 0.5）：(100,100)-(740,460) → 物理 (200,200) 起 1280×720
  assert.deepEqual(captureReqs[1].regionPhys, { x: 200, y: 200, width: 1280, height: 720 })
})

test('region zoom：倒置/完全越界坐标明确报错', async (t) => {
  const { executor } = makeExecutor()
  t.after(() => resetApprovalChannel())

  await executor.executeAsync('capture_screen', '{}', 'tc-cap1')
  const inverted = await executor.executeAsync('capture_screen', JSON.stringify({ region: [740, 460, 100, 100] }), 'tc-cap2')
  assert.equal(inverted.success, false)
  assert.ok(inverted.error!.includes('倒置'))
  const outside = await executor.executeAsync('capture_screen', JSON.stringify({ region: [2000, 2000, 3000, 3000] }), 'tc-cap3')
  assert.equal(outside.success, false)
  assert.ok(outside.error!.includes('越出'))
})

test('region zoom 后点击映射：zoom 图坐标经既有换算路径命中物理点（meta/toPhysical 零改动）', async (t) => {
  const { executor, inputs } = makeExecutor()
  t.after(() => resetApprovalChannel())

  await executor.executeAsync('capture_screen', '{}', 'tc-cap1')
  // zoom：物理 (200,200) 起 1280×720 区域，不放大（图像 1280×720，scale=1，origin=(200,200)）
  await executor.executeAsync('capture_screen', JSON.stringify({ region: [100, 100, 740, 460] }), 'tc-cap2')
  // zoom 图内 (10,20) 点击 → 物理 (210,220)（mouse_move 免审批，聚焦坐标映射断言）
  const r = await executor.executeAsync(
    'computer_use',
    JSON.stringify({ action: 'mouse_move', coordinate: [10, 20], purpose: 'p', intent: 'i' }),
  )
  assert.equal(r.success, true)
  assert.deepEqual(inputs, [{ action: 'mouse_move', x: 210, y: 220 }])
})

test('region zoom：渐进放大——zoom 图上再框选，二级裁剪矩形按 zoom meta 换算', async (t) => {
  const { executor, captureReqs, inputs } = makeExecutor()
  t.after(() => resetApprovalChannel())

  await executor.executeAsync('capture_screen', '{}', 'tc-cap1')
  await executor.executeAsync('capture_screen', JSON.stringify({ region: [100, 100, 740, 460] }), 'tc-cap2')
  // 在一级 zoom 图（origin=(200,200)，phys 1280×720，scale=1）上框左四分之一
  const r = await executor.executeAsync('capture_screen', JSON.stringify({ region: [0, 0, 320, 720] }), 'tc-cap3')
  assert.equal(r.success, true)
  assert.deepEqual(captureReqs[2].regionPhys, { x: 200, y: 200, width: 320, height: 720 })
  // 二级 zoom 图（320×720 不放大）内 (10,20) → 物理 (210,220)
  await executor.executeAsync(
    'computer_use',
    JSON.stringify({ action: 'mouse_move', coordinate: [10, 20], purpose: 'p', intent: 'i' }),
  )
  assert.deepEqual(inputs, [{ action: 'mouse_move', x: 210, y: 220 }])
})

test('region zoom：无参 capture_screen 回到全屏坐标系', async (t) => {
  const { executor, captureReqs, inputs } = makeExecutor()
  t.after(() => resetApprovalChannel())

  await executor.executeAsync('capture_screen', '{}', 'tc-cap1')
  await executor.executeAsync('capture_screen', JSON.stringify({ region: [100, 100, 740, 460] }), 'tc-cap2')
  const r = await executor.executeAsync('capture_screen', '{}', 'tc-cap3')
  assert.equal(r.success, true)
  assert.equal(captureReqs[2].regionPhys, undefined)
  // 全屏坐标系恢复：(640,360) → 物理 (1280,720)
  await executor.executeAsync(
    'computer_use',
    JSON.stringify({ action: 'mouse_move', coordinate: [640, 360], purpose: 'p', intent: 'i' }),
  )
  assert.deepEqual(inputs, [{ action: 'mouse_move', x: 1280, y: 720 }])
})
