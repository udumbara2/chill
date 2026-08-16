/**
 * 终端宽度实测探测（CPR，光标位置报告）
 *
 * 原理：字符显示宽度是终端本地属性，静态表只能是预测。启动时在 alt-screen 内
 * 写"探测字符 + \x1b[6n"，终端回 \x1b[{row};{col}R，相邻应答列差即该字符在
 * 本终端的真实宽度。探测与懒加载并发（窗口期内完成），任何异常/超时静默回退
 * 静态保守表，绝不影响 TUI 启动。
 *
 * 零闪屏设计（三层递进，互为兜底）：
 * 1) DEC 2026 同步输出（BSU/ESU 包裹全程）：支持的终端（Windows Terminal ≥1.24 等）
 *    在 ESU 前不呈现任何中间帧——探测字形的"写入→擦除"从未上过屏，协议级根除闪屏。
 *    不支持 2026 的终端将这对序列视为无操作，静默降级，无副作用。
 * 2) 同批擦除：擦除序列与探测/查询合并在单次 write 中。CPR 应答在终端解析时即按
 *    当时光标列号生成并入队，与同批后续的擦除无关；不支持 2026 时字形存活时间也从
 *    "CPR 往返等待（~15-200ms）"降为"一次解析（不足一帧）"。
 * 3) SGR conceal：探测字形以 \x1b[8m 隐藏渲染（光标照常推进，CPR 列号不受影响），
 *    兜住"无 2026 且同批内仍被呈现"的残余场景（彩色 emoji 在部分终端不受 conceal
 *    约束，正因此它不是主方案）。
 */
import { applyMeasuredWidths } from './messageModel.js'

/** 探测字符集（类别代表 + 我方常用符号） */
const PROBE_CHARS: Array<{ ch: string; note: string }> = [
  { ch: 'a', note: 'ASCII 基线' },
  { ch: '汉', note: 'CJK 宽类' },
  { ch: '─', note: '制表符' },
  { ch: '◆', note: '歧义类代表' },
  { ch: '⚠', note: '歧义类/statusline' },
  { ch: '😊', note: 'emoji' },
  { ch: '☐', note: '任务列表' },
  { ch: '☑', note: '任务列表' },
  { ch: '•', note: '项目符号' },
]

const CPR_PATTERN = /\x1b\[(\d+);(\d+)R/g
const TIMEOUT_MS = 200

/**
 * 实测终端宽度并应用（成功时调 applyMeasuredWidths）。
 * 全程 try/catch/finally：失败静默，finally 恢复现场（监听/raw mode/stdin 暂停/字节归还）。
 * wrapSync=false：调用方已在外层持有 2026 同步帧（enterTui 原子进入），本函数不再
 * 自发 BSU/ESU——嵌套的 ESU 会提前解除外层同步帧。默认行为不变（非 tmux 自发同步帧）。
 */
export async function probeTerminalWidths(opts?: { wrapSync?: boolean }): Promise<void> {
  const stdin = process.stdin
  const stdout = process.stdout
  const wasRaw = (stdin as { isRaw?: boolean }).isRaw
  let strayBytes = Buffer.alloc(0)

  const onData = (chunk: Buffer | string): void => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    strayBytes = Buffer.concat([strayBytes, buf])
  }

  try {
    if (typeof stdin.setRawMode === 'function') stdin.setRawMode(true)
    stdin.on('data', onData)

    // 单次写入完成"探测 + 查询 + 擦除"：BSU/ESU 同步帧包裹（tmux 会破坏 2026 原子性，跳过），
    // conceal 隐藏字形，擦除紧随查询同批发出——三层兜底，任何终端都不呈现探测内容。
    // CPR 应答在终端解析到查询序列时即按当时列号生成并入队，不受同批后续擦除影响。
    const wrapSync = opts?.wrapSync ?? !process.env.TMUX
    const BSU = wrapSync ? '\x1b[?2026h' : ''
    const ESU = wrapSync ? '\x1b[?2026l' : ''
    let payload = `${BSU}\x1b[1G\x1b[8m`
    for (const { ch } of PROBE_CHARS) payload += `${ch}\x1b[6n`
    payload += `\x1b[28m\x1b[2K\r${ESU}`
    stdout.write(payload)

    const deadline = Date.now() + TIMEOUT_MS
    const cols: number[] = []
    while (Date.now() < deadline && cols.length < PROBE_CHARS.length) {
      await new Promise((r) => setTimeout(r, 15))
      const text = strayBytes.toString('utf8')
      cols.length = 0
      for (const m of text.matchAll(CPR_PATTERN)) cols.push(Number(m[2]))
    }

    if (cols.length > 0) {
      // 相邻应答列差 = 字符宽度;起点列为首个应答列(首个字符为 'a',其宽度=首应答列-1)
      const widths: number[] = []
      let prev = 1
      for (const col of cols) {
        widths.push(col - prev)
        prev = col
      }
      const overrides: Array<[number, number]> = []
      let ambiguousWidth: 1 | 2 | null = null
      widths.forEach((w, i) => {
        if (w !== 1 && w !== 2) return // 豆腐/替换符等异常值丢弃
        const ch = PROBE_CHARS[i].ch
        const cp = ch.codePointAt(0) ?? 0
        overrides.push([cp, w])
        if (ch === '◆') ambiguousWidth = w as 1 | 2
      })
      if (ambiguousWidth !== null || overrides.length > 0) {
        applyMeasuredWidths(ambiguousWidth ?? 2, overrides)
      }
    }

    // 探测行擦除已并入上方单次写入（同批擦除），此处无需再写
  } catch {
    // 任何异常静默回退静态表
  } finally {
    stdin.off('data', onData)
    // 非 CPR 字节(用户恰好按键)归还输入流,不丢输入
    const leftover = strayBytes.toString('utf8').replace(CPR_PATTERN, '')
    if (leftover) stdin.unshift(leftover)
    if (typeof stdin.setRawMode === 'function' && wasRaw !== undefined) stdin.setRawMode(!!wasRaw)
    stdin.pause()
  }
}
