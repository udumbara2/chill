import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  scaleForModel,
  modelToPhysical,
  virtualDeskNormalize,
  deriveImageScale,
  regionToPhysicalRect,
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

// ========== region zoom：图像坐标系区域 → 物理裁剪矩形（四期） ==========

/** 全屏 meta：物理 2560×1440 → 图像 1280×720（换算比 0.5），主屏原点 (0,0) */
const FULL_META = { originX: 0, originY: 0, width: 1280, height: 720, physWidth: 2560, physHeight: 1440 }

test('regionToPhysicalRect：全屏区域退化为整屏裁剪框', () => {
  const r = regionToPhysicalRect([0, 0, 1280, 720], FULL_META)
  assert.deepEqual(r, { x: 0, y: 0, width: 2560, height: 1440 })
})

test('regionToPhysicalRect：局部区域按换算比 + origin 映回物理像素', () => {
  // 图像 (100,100)-(740,460) → 物理 (200,200)-(1480,920)
  const r = regionToPhysicalRect([100, 100, 740, 460], FULL_META)
  assert.deepEqual(r, { x: 200, y: 200, width: 1280, height: 720 })
})

test('regionToPhysicalRect：负 origin 显示器（多屏）区域换算含原点偏移', () => {
  const meta = { ...FULL_META, originX: -2560 }
  const r = regionToPhysicalRect([100, 100, 740, 460], meta)
  assert.deepEqual(r, { x: -2360, y: 200, width: 1280, height: 720 })
})

test('regionToPhysicalRect：渐进 zoom——以 zoom 图的 meta 再框选仍正确', () => {
  // 第一轮 zoom：框出物理 (200,200) 起 1280×720 的区域；capture 层按裁剪框回写 meta
  // （物理 1280×720 不放大 → 图像 1280×720，origin 为裁剪框左上角）
  const zoomMeta = { originX: 200, originY: 200, width: 1280, height: 720, physWidth: 1280, physHeight: 720 }
  // 在 zoom 图上框左四分之一 (0,0)-(320,720) → 物理 (200,200) 起 320×720
  const r = regionToPhysicalRect([0, 0, 320, 720], zoomMeta)
  assert.deepEqual(r, { x: 200, y: 200, width: 320, height: 720 })
})

test('regionToPhysicalRect：越界部分 clamp 到图像范围', () => {
  // 左上越界 → 收拢到 (0,0)
  const r = regionToPhysicalRect([-100, -50, 640, 360], FULL_META)
  assert.deepEqual(r, { x: 0, y: 0, width: 1280, height: 720 })
})

test('regionToPhysicalRect：坐标倒置/空区域明确报错', () => {
  assert.ok('error' in regionToPhysicalRect([740, 460, 100, 100], FULL_META))
  assert.ok('error' in regionToPhysicalRect([100, 100, 100, 460], FULL_META))
})

test('regionToPhysicalRect：完全越出图像范围明确报错', () => {
  assert.ok('error' in regionToPhysicalRect([2000, 2000, 3000, 3000], FULL_META))
})

test('regionToPhysicalRect：meta 尺寸缺失明确报错（严禁静默按 1:1）', () => {
  const badMeta = { originX: 0, originY: 0, width: 0, height: 720, physWidth: 2560, physHeight: 1440 }
  assert.ok('error' in regionToPhysicalRect([0, 0, 100, 100], badMeta))
})

test('region zoom 后点击映射：zoom 图坐标经既有 toPhysical 路径命中物理点', () => {
  // 模拟 zoom 后的 meta（crop=物理 (200,200) 起 1280×720，图像 1280×720，scale=1）
  const zoomMeta = { originX: 200, originY: 200, width: 1280, height: 720, physWidth: 1280, physHeight: 720 }
  const imageScale = deriveImageScale(zoomMeta.width, zoomMeta.physWidth)!
  // zoom 图内 (10, 20) → 物理 (210, 220)：meta 结构与 toPhysical 零改动的直接证明
  assert.deepEqual(modelToPhysical(10, 20, imageScale, zoomMeta.originX, zoomMeta.originY), { x: 210, y: 220 })
})
