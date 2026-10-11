/**
 * qrBlock.ts — QR 终端半块渲染（纯函数，2026-10-11 TUI 配对原生化）。
 *
 * 两行模块拼一个字符行（▀▄█ + 空格）× 前景黑/背景白（着色归呈现层）——正方形模块 +
 * 正确极性，手机摄像头直接扫屏幕（qrcode-terminal 的反色 + 字符纵横比失真两病均治；
 * 物理依据见 core qrRenderPlan 注释：模块数随载荷增长，渲染必须自适应）。
 *
 * 输入矩阵来自 qrcode 库 `QRCode.create().modules`（{size, data}，data 行主序、非 0=暗）。
 * 零依赖（不 import qrcode/ink），可单测。
 */

export interface QrMatrix {
  size: number
  data: ArrayLike<number>
}

/** 矩阵 → 半块字符行集（含 margin 静区；cols=字符列数=总模块列，rows=字符行数=总模块行/2 向上取整） */
export function qrHalfBlockLines(m: QrMatrix, margin: number): { lines: string[]; cols: number; rows: number } {
  const total = m.size + margin * 2
  const bit = (r: number, c: number): boolean => {
    const rr = r - margin
    const cc = c - margin
    if (rr < 0 || cc < 0 || rr >= m.size || cc >= m.size) return false
    return m.data[rr * m.size + cc] !== 0
  }
  const lines: string[] = []
  for (let r = 0; r < total; r += 2) {
    let line = ''
    for (let c = 0; c < total; c++) {
      const top = bit(r, c)
      const bottom = r + 1 < total ? bit(r + 1, c) : false
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' '
    }
    lines.push(line)
  }
  return { lines, cols: total, rows: lines.length }
}

/**
 * 半块行 → 经典 CLI 直印块（配对小码规划 R2.4 渲染器统一）：SGR 前景黑/背景白包裹——
 * 正确极性 + 正方形模块，与 TUI 的 ink 着色同源同效（qrcode-terminal 的反色+纵横比失真两病
 * 随其退役消亡）。整块包裹（起笔置色、末笔复位），行间零重置减转义噪声。
 *
 * 淘汰档案（2026-10-11 真机实测）：braille 4×密度点阵渲染（每字符格 2×4=8 模块）几何上
 * 成立且能让默认窗口内显，但字体把盲文点渲染为带缝隙的圆点——实机扫码不识别，一票否决。
 * 勿再尝试点阵类渲染；实心方块是扫码器唯一可靠的食物。
 */
export function qrAnsiBlock(lines: string[]): string {
  const ON = '\x1b[30;47m'
  const OFF = '\x1b[0m'
  return lines.map((l, i) => (i === 0 ? ON : '') + l).join('\n') + OFF
}
