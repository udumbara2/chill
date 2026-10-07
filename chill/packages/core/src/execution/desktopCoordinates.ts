/**
 * 桌面坐标换算纯函数（模型图像坐标 ↔ 虚拟桌面物理像素）。
 *
 * 坐标系约定：
 * - 模型看到的是"等比缩放后的截图"，其输出坐标属于该图像的坐标空间（原点左上）；
 * - 原生层（Rust）只认虚拟桌面物理像素（多显示器时 origin 可为负）；
 * - 双向换算是 core 的责任：截图前 scaleForModel 定缩放，点击前 modelToPhysical 映回物理像素，
 *   最后 virtualDeskNormalize clamp 到虚拟桌面范围内防越界注入。
 * DPI 说明：宿主进程声明 Per-Monitor V2 后截屏与输入注入同在物理像素坐标系，
 * Windows 显示缩放（125%/150%）不参与换算；macOS Retina 的 dpiScale 体现在
 * physWidth/physHeight 与缩放系数的比例中。
 */

/** 显示器边界（虚拟桌面物理像素坐标系） */
export interface DisplayBounds {
  originX: number
  originY: number
  physWidth: number
  physHeight: number
}

/** 等比缩放结果 */
export interface ModelScale {
  /** 模型图像宽（物理宽 × scale，取整） */
  width: number
  /** 模型图像高 */
  height: number
  /** 图像像素 / 物理像素（≤1；不放大） */
  scale: number
}

/**
 * 物理尺寸 → 模型图像尺寸：长边压到 maxLongEdge 以内，等比缩放（不放大）。
 * 非等比拉伸会把模型的坐标判断一起带偏，故只按长边算单一系数。
 */
export function scaleForModel(physWidth: number, physHeight: number, maxLongEdge: number): ModelScale {
  const longEdge = Math.max(physWidth, physHeight)
  const scale = longEdge > maxLongEdge ? maxLongEdge / longEdge : 1
  return {
    width: Math.round(physWidth * scale),
    height: Math.round(physHeight * scale),
    scale,
  }
}

/**
 * 从实测尺寸派生"图像像素 / 物理像素"换算比（modelToPhysical 的 scale 输入）。
 * 这是唯一合法的换算比来源——契约只运输实测事实（width/physWidth），
 * 不运输任何外部声明的 scale 字段（历史上 DPI 缩放比被误当换算比导致点击系统性偏移）。
 * 返回 null 表示元数据不完整（调用方应明确报错引导重新截屏，严禁静默按 1:1 注入）。
 */
export function deriveImageScale(imgWidth: number, physWidth: number): number | null {
  if (!imgWidth || !physWidth || imgWidth <= 0 || physWidth <= 0) return null
  return imgWidth / physWidth
}

/**
 * 模型图像坐标 → 虚拟桌面物理像素坐标。
 * scale 为"图像像素 / 物理像素"（deriveImageScale 的产出）；
 * originX/originY 为目标显示器在虚拟桌面中的原点（可为负）。
 */
export function modelToPhysical(
  x: number,
  y: number,
  scale: number,
  originX = 0,
  originY = 0,
): { x: number; y: number } {
  return {
    x: originX + Math.round(x / scale),
    y: originY + Math.round(y / scale),
  }
}

/**
 * region zoom：把"最近一次截图图像坐标系"下的区域 [x1,y1,x2,y2] 换算为虚拟桌面物理裁剪矩形。
 * meta 即最近一次截屏的元数据（originX/originY + width/physWidth），与 modelToPhysical 同一换算比来源；
 * 结果 clamp 到该截图对应的物理范围。全屏区域就是 crop=整屏的退化情形。
 * 坐标倒置/越界出空矩形 → 返回 { error }（调用方组织报错文案）；meta 缺尺寸同理。
 */
export function regionToPhysicalRect(
  region: readonly [number, number, number, number],
  meta: { originX: number; originY: number; width: number; height: number; physWidth: number; physHeight: number },
): { x: number; y: number; width: number; height: number } | { error: string } {
  const [x1, y1, x2, y2] = region.map(Number)
  if (![x1, y1, x2, y2].every((v) => Number.isFinite(v))) {
    return { error: 'region 需要 4 个数字坐标 [x1, y1, x2, y2]' }
  }
  if (x2 <= x1 || y2 <= y1) {
    return { error: `region 坐标倒置或为空：[${x1}, ${y1}, ${x2}, ${y2}]（要求 x2>x1 且 y2>y1）` }
  }
  const imageScale = deriveImageScale(meta.width, meta.physWidth)
  if (imageScale === null) {
    return { error: '截屏元数据不完整（缺少图像/物理尺寸）：请重新调用 capture_screen 后再框选区域' }
  }
  // 先 clamp 到图像范围（越界部分直接收拢），再换算物理像素
  const cx1 = Math.min(Math.max(x1, 0), meta.width)
  const cy1 = Math.min(Math.max(y1, 0), meta.height)
  const cx2 = Math.min(Math.max(x2, 0), meta.width)
  const cy2 = Math.min(Math.max(y2, 0), meta.height)
  if (cx2 <= cx1 || cy2 <= cy1) {
    return { error: `region 完全越出最近一次截图范围（图像 ${meta.width}×${meta.height}）：[${x1}, ${y1}, ${x2}, ${y2}]` }
  }
  const p1 = modelToPhysical(cx1, cy1, imageScale, meta.originX, meta.originY)
  const p2 = modelToPhysical(cx2, cy2, imageScale, meta.originX, meta.originY)
  return { x: p1.x, y: p1.y, width: Math.max(1, p2.x - p1.x), height: Math.max(1, p2.y - p1.y) }
}

/**
 * 越界 clamp：把物理像素坐标收拢到虚拟桌面范围（全部显示器的包围盒，origin 可为负）。
 * 模型坐标幻觉/偏移可能产出屏幕外坐标，直接注入会点到不可预期的位置。
 */
export function virtualDeskNormalize(
  x: number,
  y: number,
  displays: DisplayBounds[],
): { x: number; y: number } {
  if (displays.length === 0) return { x, y }
  const minX = Math.min(...displays.map((d) => d.originX))
  const minY = Math.min(...displays.map((d) => d.originY))
  const maxX = Math.max(...displays.map((d) => d.originX + d.physWidth - 1))
  const maxY = Math.max(...displays.map((d) => d.originY + d.physHeight - 1))
  return {
    x: Math.min(Math.max(x, minX), maxX),
    y: Math.min(Math.max(y, minY), maxY),
  }
}
