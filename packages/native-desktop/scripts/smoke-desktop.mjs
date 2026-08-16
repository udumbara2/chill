// native-desktop 冒烟脚本：列显示器 → 截主屏 → 光标位置 → 移动鼠标回位
// 用法：node scripts/smoke-desktop.mjs   （在 packages/native-desktop 目录下）
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import * as native from '../index.js'

const outDir = dirname(dirname(fileURLToPath(import.meta.url)))

console.log('== list_displays ==')
const displays = native.listDisplays()
console.log(JSON.stringify(displays, null, 2))

const primary = displays.find((d) => d.isPrimary) ?? displays[0]
console.log(`\n== capture_display(index=${primary.index}, maxLongEdge=1280) ==`)
const cap = native.captureDisplay(primary.index, 1280)
const pngPath = join(outDir, 'smoke-capture.png')
writeFileSync(pngPath, cap.png)
console.log(
  `缩放后 ${cap.width}x${cap.height}, 物理 ${cap.physWidth}x${cap.physHeight}, ` +
    `dpi=${cap.dpiScale}, origin=(${cap.originX},${cap.originY}), png=${cap.png.length} bytes -> ${pngPath}`
)

console.log('\n== cursor_position ==')
const pos = native.cursorPosition()
console.log(`当前光标: (${pos[0]}, ${pos[1]})`)

console.log('\n== mouse_move (100,100) 后移回原位 ==')
native.mouseMove(100, 100)
const moved = native.cursorPosition()
console.log(`移动后: (${moved[0]}, ${moved[1]})`)
native.mouseMove(pos[0], pos[1])
const restored = native.cursorPosition()
console.log(`恢复后: (${restored[0]}, ${restored[1]})`)

console.log('\n冒烟完成 ✔')
