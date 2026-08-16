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
