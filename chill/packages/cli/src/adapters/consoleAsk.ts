/**
 * consoleAsk.ts — 可撤回控制台提问原语（CLI 壳唯一 stdin 提问入口）
 *
 * 替代 rl.question：Node readline 的挂起 question 构造上不可撤回且独占吞掉下一行输入
 * （实测：question 挂起时 line 事件不派发），落定后残留的僵尸提问会静默吃掉用户输入。
 * 本原语用"摘除主循环 line 监听 + once('line')"实现同等的独占读取，同时暴露 retract——
 * watch 传入渠道与 id 时内部订阅对应 SETTLED 事件，落定即自动收摊（打印提示 + 哨兵兑现），
 * 僵尸提问构造上不可能残留。
 *
 * settledNotice 两个文案组装函数同文件导出（tuiShell 渠道队列收摊时复用，同包内共享）。
 */
import type * as readline from 'readline'
import { eventBus, EVENTS } from '@assistant-ai/core'

/** 呈现面被收摊的哨兵兑现值（调用方据此跳过回灌——channel 已落定，答案无处可去） */
export const SURFACE_RETRACTED: unique symbol = Symbol('surface-retracted')
export type ConsoleAskResult = string | typeof SURFACE_RETRACTED

/** 落定来源 → 人类可读 */
function byText(by: string): string {
  switch (by) {
    case 'phone':
      return '手机端'
    case 'local':
      return '本机'
    case 'timeout':
      return '超时'
    case 'cancelled':
      return '已取消'
    default:
      return by
  }
}

/** 审批落定提示文案（控制台 watch 与 TUI 渠道队列收摊共用） */
export function approvalSettledNotice(s: { approved: boolean; by: string }): string {
  return `（该审批已落定：${byText(s.by)}${s.approved ? '已批准' : '已拒绝'}）`
}

/** 提问落定提示文案（回答截断 50 字符防刷屏） */
export function askSettledNotice(s: { answer: string; by: string }): string {
  const answer = s.answer.length > 50 ? `${s.answer.slice(0, 50)}…` : s.answer
  return `（该提问已落定：${byText(s.by)}回答"${answer}"）`
}

export interface ConsoleAskHandle {
  promise: Promise<ConsoleAskResult>
  /** 外部落定收摊：摘除监听、恢复主循环、打印提示、哨兵兑现（幂等） */
  retract: (notice?: string) => void
}

/**
 * 可撤回控制台提问：独占 stdin 读取一行回答。
 * watch={channel,id} 时订阅对应 SETTLED 事件——该渠道该 id 落定即自动 retract。
 */
export function consoleAsk(
  rl: readline.Interface,
  printText: string,
  watch?: { channel: 'approval' | 'ask'; id: string },
): ConsoleAskHandle {
  // 独占 stdin：摘除主循环 line 监听（防答案同时进提问回调和主对话的双路分发）
  const savedLineListeners = rl.listeners('line')
  rl.removeAllListeners('line')
  const restore = () => {
    for (const l of savedLineListeners) rl.on('line', l as (...args: unknown[]) => void)
  }

  rl.pause()
  process.stdout.write(printText)

  let settled = false
  let resolvePromise!: (r: ConsoleAskResult) => void
  const promise = new Promise<ConsoleAskResult>((res) => {
    resolvePromise = res
  })

  let offWatch: () => void = () => {}
  const finish = (result: ConsoleAskResult, notice?: string): void => {
    if (settled) return
    settled = true
    offWatch()
    restore()
    if (notice !== undefined) process.stdout.write(`${notice}\n`)
    resolvePromise(result)
  }

  const handle: ConsoleAskHandle = {
    promise,
    retract: (notice) => {
      rl.removeListener('line', onLine)
      rl.pause()
      finish(SURFACE_RETRACTED, notice)
    },
  }

  const onLine = (answer: string) => finish(answer.trim())
  rl.resume()
  rl.once('line', onLine)

  if (watch) {
    const event = watch.channel === 'approval' ? EVENTS.APPROVAL_SETTLED : EVENTS.ASK_SETTLED
    const fn = (s: { toolCallId?: string; id?: string; approved?: boolean; answer?: string; by?: string }) => {
      const sid = watch.channel === 'approval' ? s.toolCallId : s.id
      if (sid !== watch.id) return
      handle.retract(
        watch.channel === 'approval'
          ? approvalSettledNotice({ approved: s.approved === true, by: s.by ?? '' })
          : askSettledNotice({ answer: s.answer ?? '', by: s.by ?? '' }),
      )
    }
    eventBus.on(event, fn)
    offWatch = () => eventBus.off(event, fn)
  }

  return handle
}
