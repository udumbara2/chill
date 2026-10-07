/**
 * wireTrace.ts — 原始线缆捕获（M7增量3·决策33，默认关，隐私优先）。
 *
 * CHILL_TRACE_WIRE=1 时，openaiChatHelpers 流循环把服务端原始 chunk 追加到
 * ~/.chill/trace/wire-<date>.ndjson（一行一个 JSON：{ts, model, chunk}），单文件 5MB
 * 轮转、保留 2 份。背景：2026-09-26 事故中"null 分片是首片还是后续片"因无原始流日志
 * 永不可考——本开关补上这个证据缺口。一切 I/O 失败静默（诊断工具绝不影响请求主流程）；
 * 渲染端无 fs（空 shim）时自然空转。
 */

const TRACE_WIRE_ON = typeof process !== 'undefined' && process.env?.CHILL_TRACE_WIRE === '1'
const ROTATE_BYTES = 5 * 1024 * 1024

export function isWireTraceEnabled(): boolean {
  return TRACE_WIRE_ON
}

export function traceWireChunk(model: string, chunk: unknown): void {
  if (!TRACE_WIRE_ON) return
  void (async () => {
    try {
      const fs = await import('node:fs')
      const path = await import('node:path')
      const home = process.env.USERPROFILE ?? process.env.HOME
      if (!home) return
      const dir = path.join(home, '.chill', 'trace')
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, `wire-${new Date().toISOString().slice(0, 10)}.ndjson`)
      try {
        const st = fs.statSync(file)
        if (st.size > ROTATE_BYTES) fs.renameSync(file, `${file}.1`) // 覆盖旧轮转，保留 2 份
      } catch {
        /* 尚不存在 */
      }
      fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), model, chunk }) + '\n')
    } catch {
      /* 诊断静默失败（渲染端无 fs 等） */
    }
  })()
}
