// native-desktop UIA 冒烟：启动记事本 → focus_window → active_window 快照（前 20 个元素）
// → 对【文件】菜单做 ui_invoke 实测 → 关闭记事本。不触碰其他窗口。
// 用法：node scripts/smoke-ui.mjs   （在 packages/native-desktop 目录下）
import { spawn } from 'node:child_process'
import * as native from '../index.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function fmt(e) {
  const pats = [e.hasInvoke && 'invoke', e.hasValue && 'value', e.hasToggle && 'toggle']
    .filter(Boolean)
    .join('|')
  return (
    `#${e.label} [${e.controlType}] "${e.name}" ` +
    `bbox=(${e.x},${e.y},${e.width}x${e.height}) hwnd=${e.hwnd} rid=${e.runtimeId} ${pats}`
  )
}

// 启动记事本并等其窗口出现
console.log('== 启动 notepad.exe ==')
const proc = spawn('notepad.exe')
await sleep(1500)

// 取记事本主窗口 hwnd（desktop 快照按规格只收可交互元素，Window 不在其中）
const { execSync } = await import('node:child_process')
const hwndStr = execSync(
  'powershell -NoProfile -Command "(Get-Process notepad | Select-Object -First 1).MainWindowHandle"'
)
  .toString()
  .trim()
const notepadHwnd = Number(hwndStr)
if (!notepadHwnd) {
  proc.kill()
  throw new Error('拿不到记事本窗口句柄')
}
console.log(`记事本窗口: hwnd=${notepadHwnd}`)

// focus_window 实测（Rust 侧内部已做 GetForegroundWindow 回读，失败会抛错）
console.log('\n== focus_window(记事本 hwnd) ==')
native.focusWindow(notepadHwnd)
await sleep(300)
const fgSnap = native.uiSnapshot('active_window')
// active_window 能拿到记事本的子元素即说明焦点已在记事本
console.log(`focus_window 调用成功；active_window 快照元素数=${fgSnap.length}`)
// 外部回读 GetForegroundWindow 对比（快照里子控件 hwnd 是控件句柄，不能直接比）
const fgHwnd = Number(
  execSync(
    'powershell -NoProfile -Command "Add-Type -MemberDefinition \'[System.Runtime.InteropServices.DllImport(\\"user32.dll\\")] public static extern System.IntPtr GetForegroundWindow();\' -Name U32 -Namespace W; [W.U32]::GetForegroundWindow().ToInt64()"'
  )
    .toString()
    .trim()
)
console.log(
  `GetForegroundWindow 回读=${fgHwnd} 期望=${notepadHwnd} ` +
    (fgHwnd === notepadHwnd ? '一致 ✔' : '不一致 ✘')
)

// 打印前 20 个元素
console.log('\n== active_window 快照前 20 个元素 ==')
for (const e of fgSnap.slice(0, 20)) console.log(fmt(e))
if (fgSnap.length > 20) console.log(`... 共 ${fgSnap.length} 个`)

// 找【文件】菜单做 ui_invoke 实测（无害：只展开菜单，随后 Esc 收起）
const fileMenu =
  fgSnap.find((e) => e.hasInvoke && e.controlType === 'MenuItem' && /文件|File/.test(e.name)) ??
  fgSnap.find((e) => e.hasInvoke)
if (!fileMenu) throw new Error('快照中没有支持 invoke 的元素')
console.log(`\n== ui_invoke 实测: ${fmt(fileMenu)} ==`)
native.uiInvoke(fileMenu.runtimeId)
await sleep(500)
// 验证菜单确实展开：此时 active_window 快照应能见到【另存为/保存】等子菜单项
const after = native.uiSnapshot('active_window')
const sub = after.find((e) => e.controlType === 'MenuItem' && /保存|另存为|Save/.test(e.name))
console.log(sub ? `菜单已展开，见到子项: ${fmt(sub)}` : '（未见子菜单项，可能未展开）')
native.key('esc') // 收起菜单

// ui_set_value 实测：写入记事本编辑区（无害临时内容，随后不保存直接关窗）
const edit = fgSnap.find((e) => e.hasValue)
if (edit) {
  console.log(`\n== ui_set_value 实测: ${fmt(edit)} ==`)
  native.uiSetValue(edit.runtimeId, 'uia smoke test')
  console.log('ui_set_value 调用成功')
}

// 失效元素错误路径验证：关掉记事本后再 invoke 旧 runtime_id
proc.kill()
await sleep(800)
try {
  native.uiInvoke(fileMenu.runtimeId)
  console.log('\n失效元素 invoke 未报错（意外）')
} catch (e) {
  console.log(`\n失效元素 invoke 报错（符合预期）: ${e.message}`)
}

console.log('\nUIA 冒烟完成 ✔')
