/**
 * contextOverflowTrace.ts — 窗口超限现场落盘（默认开、仅错误路径、纯元数据）。
 *
 * 照 wireTrace.ts 先例：lazy fs、一切失败静默（诊断绝不影响请求主流程）、渲染端无 fs
 * 自然空转；node:test 环境（NODE_TEST_CONTEXT）静音——测试零污染、零注入面。
 *
 * 立项背景（2026-10-07）：事故会话文件被删导致 900,902 token 请求的构成永久不可考。
 * 会话文件不含发送视图（切片/注入/钳制后申报），线缆形状只能靠本文件在 400 时刻记录。
 * 隐私：只记元数据（角色/字符数/媒体块数/工具名/估算），不含任何内容文本。
 */

const TEST_ENV = typeof process !== 'undefined' && !!process.env?.NODE_TEST_CONTEXT

export function appendContextOverflowTrace(entry: Record<string, unknown>): void {
  if (TEST_ENV) return
  void (async () => {
    try {
      const fs = await import('node:fs')
      const path = await import('node:path')
      const home = process.env.USERPROFILE ?? process.env.HOME
      if (!home) return
      const dir = path.join(home, '.chill', 'trace')
      fs.mkdirSync(dir, { recursive: true })
      const now = new Date()
      const file = path.join(dir, `context-overflow-${now.toISOString().replace(/[:.]/g, '-')}.json`)
      fs.writeFileSync(file, JSON.stringify({ ts: now.toISOString(), ...entry }, null, 2))
    } catch {
      /* 诊断静默失败（渲染端无 fs 等） */
    }
  })()
}
