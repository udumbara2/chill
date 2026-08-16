import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  scaleForModel,
  modelToPhysical,
  virtualDeskNormalize,
  deriveImageScale,
} from '../../src/execution/desktopCoordinates.ts'

test('1080p 物理屏缩放到长边 1280：等比 2/3，坐标双向映射一致', () => {
  const s = scaleForModel(1920, 1080, 1280)
  assert.equal(s.width, 1280)
  assert.equal(s.height, 720)
  assert.ok(Math.abs(s.scale - 1280 / 1920) < 1e-9)
  // 模型图中心点 (640,360) → 物理 (960,540)
  const p = modelToPhysical(640, 360, s.scale)
  assert.deepEqual(p, { x: 960, y: 540 })
})

test('Retina 2x：物理 2560×1440（逻辑 1280×720）缩放与回映按物理像素走', () => {
  const s = scaleForModel(2560, 1440, 1280)
  assert.equal(s.width, 1280)
  assert.equal(s.height, 720)
  assert.equal(s.scale, 0.5)
  // 图像坐标 ×2 回物理像素
  assert.deepEqual(modelToPhysical(100, 50, s.scale), { x: 200, y: 100 })
})

test('不放大：物理长边已小于 maxLongEdge 时 scale=1', () => {
  const s = scaleForModel(1024, 768, 1280)
  assert.equal(s.scale, 1)
  assert.equal(s.width, 1024)
  assert.equal(s.height, 768)
  assert.deepEqual(modelToPhysical(10, 20, s.scale), { x: 10, y: 20 })
})

test('DPI 150%：Per-Monitor V2 下换算只看物理像素，与显示缩放无关', () => {
  // 150% 缩放的 1920×1080 逻辑屏 = 2880×1620 物理像素
  const s = scaleForModel(2880, 1620, 1280)
  assert.equal(s.width, 1280)
  assert.equal(s.height, 720)
  // 图像右下角 (1279,719) → 物理屏内最末像素附近
  const p = modelToPhysical(1279, 719, s.scale)
  assert.ok(p.x <= 2879 && p.y <= 1619)
  assert.deepEqual(modelToPhysical(640, 360, s.scale), { x: 1440, y: 810 })
})

test('负 origin 多显示器：模型坐标加上显示器原点偏移', () => {
  // 副屏在主屏左侧：originX = -1920
  const p = modelToPhysical(640, 360, 1, -1920, 0)
  assert.deepEqual(p, { x: -1280, y: 360 })
})

test('越界 clamp：坐标收拢到虚拟桌面包围盒（含负原点）', () => {
  const displays = [
    { originX: -1920, originY: 0, physWidth: 1920, physHeight: 1080 },
    { originX: 0, originY: 0, physWidth: 1920, physHeight: 1080 },
  ]
  // 超出右边界 → 主屏最末像素 (1919, 1079)
  assert.deepEqual(virtualDeskNormalize(5000, 5000, displays), { x: 1919, y: 1079 })
  // 超出左/上边界（负向）→ 副屏原点 (-1920, 0)
  assert.deepEqual(virtualDeskNormalize(-9999, -100, displays), { x: -1920, y: 0 })
  // 界内坐标不变
  assert.deepEqual(virtualDeskNormalize(-100, 500, displays), { x: -100, y: 500 })
})

test('越界 clamp：无显示器元数据时原样返回（不臆造边界）', () => {
  assert.deepEqual(virtualDeskNormalize(123, -45, []), { x: 123, y: -45 })
})

test('deriveImageScale：从实测尺寸派生换算比（DPI 无关）', () => {
  // 150% DPI 机器：phys 1920×1080、img 1280×720 → 0.667；模型坐标 (640,360) → 物理 (960,540)
  const s1 = deriveImageScale(1280, 1920)
  assert.ok(s1 !== null && Math.abs(s1 - 1280 / 1920) < 1e-9)
  assert.deepEqual(modelToPhysical(640, 360, s1!), { x: 960, y: 540 })
  // 100% DPI 同分辨率：同一结果（证明与 DPI 缩放无关）
  const s2 = deriveImageScale(1280, 1920)
  assert.equal(s1, s2)
  // Retina 类：phys 2560×1440、img 1280×720 → 0.5
  const s3 = deriveImageScale(1280, 2560)
  assert.deepEqual(modelToPhysical(640, 360, s3!), { x: 1280, y: 720 })
})

test('deriveImageScale：元数据不完整返回 null（调用方必须报错而非静默注入）', () => {
  assert.equal(deriveImageScale(0, 1920), null)
  assert.equal(deriveImageScale(1280, 0), null)
  assert.equal(deriveImageScale(NaN, 1920), null)
})
