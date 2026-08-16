import type { IUserInputProvider, AskUserOption } from '@assistant-ai/core'
import type * as readline from 'readline'
import { isTuiActive, hasAskPresenter, presentAsk } from '../tui/tuiState.js'

export class CLIUserInputProvider implements IUserInputProvider {
  private rl: readline.Interface

  constructor(rl: readline.Interface) {
    this.rl = rl
  }

  async ask(question: string, options?: AskUserOption[], allowFreeText?: boolean, freeTextHint?: string): Promise<string> {
    // TUI 活跃时 rl 已 pause，经 TUI 消息区呈现提问（submit_plan/ask_user 防挂死）
    if (isTuiActive() && hasAskPresenter()) {
      const p = presentAsk(question, options, allowFreeText, freeTextHint)
      if (p) return p
    }
    return new Promise((resolve) => {
      // 根治 stdin 竞争：ask 期间独占输入——临时摘除主循环的 line 监听器，
      // 防止答案同时进问题回调和主对话（双路分发导致提问收到空串）
      const savedLineListeners = this.rl.listeners('line')
      this.rl.removeAllListeners('line')
      const restore = () => {
        for (const l of savedLineListeners) this.rl.on('line', l as (...args: any[]) => void)
      }

      this.rl.pause()

      const separator = '═'.repeat(50)
      process.stdout.write(`\n${separator}\n`)
      process.stdout.write(`\x1b[93m? \x1b[0m${question}\n`)

      if (options && options.length > 0) {
        options.forEach((opt, i) => {
          process.stdout.write(`  [${i + 1}] ${opt.label} — ${opt.description}\n`)
        })
        process.stdout.write(`  [0] 跳过 — 不回答此问题\n`)
        if (allowFreeText) {
          // 自由文本提示文案由提问方携带（规划审批="继续修改规划..."），缺省通用文案
          process.stdout.write(`  ${freeTextHint ?? '也可直接输入回答'}\n`)
        }
      }

      process.stdout.write(`${separator}\n`)
      process.stdout.write(`请输入: `)

      this.rl.resume()
      this.rl.once('line', (answer) => {
        restore()
        resolve(answer.trim())
      })
    })
  }
}
