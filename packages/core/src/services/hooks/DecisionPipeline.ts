import type { PolicyContext, PolicyLink, PolicyVerdict } from './types'

/**
 * 可同步判定的环节（内置门全是同步判定；hooks 环节只走异步管线，不在同步管线出现）。
 * evaluate 与 evaluateSync 语义必须一致，evaluate 缺省实现为 evaluateSync 的 Promise 包装。
 */
export interface SyncPolicyLink extends PolicyLink {
  evaluateSync(ctx: PolicyContext): PolicyVerdict
}

/**
 * 统一决策管线运行器：有序 PolicyLink 链——串行执行、deny/ask 熔断（bail）、
 * transform waterfall（后续环节看到改写后的 toolInput）。
 *
 * 完整管线顺序（文档化，按挂载点分段执行）：
 *   硬安全（commandSafety，不可覆盖）→ PreToolUse hooks → 内置门（本类串联的这一段）
 *   → PermissionRequest hooks → 审批弹窗。
 * 前两段在 ChatEngine.executeOneToolCall 分叉前（主会话）/ builtInToolExecutor 咽喉（Worker 来源），
 * 后两段在审批发起位置（approveWritePath / executePowerShellAsync）。
 */
export class DecisionPipeline {
  private readonly links: PolicyLink[] = []

  /** 追加环节（顺序即判定顺序） */
  add(link: PolicyLink): this {
    this.links.push(link)
    return this
  }

  /** 环节数（测试/调试用） */
  get size(): number {
    return this.links.length
  }

  /** 异步执行：deny/ask 熔断；transform waterfall；全部放行且有改写时返回最终 transform */
  async run(ctx: PolicyContext): Promise<PolicyVerdict> {
    let current = ctx
    let transformed = false
    for (const link of this.links) {
      const verdict = await link.evaluate(current)
      if (verdict.type === 'deny' || verdict.type === 'ask') return verdict
      if (verdict.type === 'transform') {
        current = { ...current, toolInput: verdict.updatedInput }
        transformed = true
      }
    }
    return transformed ? { type: 'transform', updatedInput: current.toolInput ?? {} } : { type: 'allow' }
  }

  /**
   * 同步执行（同步咽喉用）：要求全部环节实现 evaluateSync（内置门均满足）；
   * 遇到仅异步的环节跳过并告警（不应发生——hooks 环节不编入同步管线）。
   */
  runSync(ctx: PolicyContext): PolicyVerdict {
    let current = ctx
    let transformed = false
    for (const link of this.links) {
      const syncLink = link as Partial<SyncPolicyLink>
      if (typeof syncLink.evaluateSync !== 'function') {
        console.warn(`[DecisionPipeline] 环节 ${link.name} 不支持同步判定，已跳过`)
        continue
      }
      const verdict = syncLink.evaluateSync(current)
      if (verdict.type === 'deny' || verdict.type === 'ask') return verdict
      if (verdict.type === 'transform') {
        current = { ...current, toolInput: verdict.updatedInput }
        transformed = true
      }
    }
    return transformed ? { type: 'transform', updatedInput: current.toolInput ?? {} } : { type: 'allow' }
  }
}
