/**
 * TUI 输入历史（零依赖，内存级）
 *
 * ↑ 召回更早、↓ 召回更新，回到底部恢复召回前的草稿；
 * 空串与连续重复不入库。进程内存级，不做磁盘持久化（后续迭代）。
 */
export class InputHistory {
  private entries: string[] = []
  /** 当前浏览位置；null = 未在召回（用户正在编辑新草稿） */
  private index: number | null = null
  /** 召回前的草稿（回到底部时恢复） */
  private draft = ''

  /** 提交一条输入（空串、与上一条重复的不入库） */
  push(text: string): void {
    const t = text.trim()
    if (!t) return
    if (this.entries[this.entries.length - 1] === t) return
    this.entries.push(t)
    this.reset()
  }

  /** ↑：召回更早的一条；current 为当前输入（首次召回时存为草稿）。无可召回返回 undefined */
  prev(current: string): string | undefined {
    if (this.entries.length === 0) return undefined
    if (this.index === null) {
      this.draft = current
      this.index = this.entries.length - 1
    } else if (this.index > 0) {
      this.index--
    } else {
      return undefined
    }
    return this.entries[this.index]
  }

  /** ↓：召回更新的一条；到底返回草稿。未在召回中返回 undefined */
  next(): string | undefined {
    if (this.index === null) return undefined
    if (this.index < this.entries.length - 1) {
      this.index++
      return this.entries[this.index]
    }
    const d = this.draft
    this.reset()
    return d
  }

  /** 提交或放弃召回后复位浏览状态 */
  reset(): void {
    this.index = null
    this.draft = ''
  }
}
