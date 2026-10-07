/**
 * per-agent 工具权限声明（单一事实源）
 *
 * 统一优先级链（全系统唯一解析规则）：
 *   本次执行的工具 = Lead 显式委派（available_tools；["none"] → 显式清零）
 *                ?? 模板/节点 tools 声明（省略 → 零；[all] → 全量；[a,b] → 名单）
 *   结果再经 disallowed_tools / readonly 约束过滤（约束不参与覆盖轴）
 *
 * tools 字段语义格（模板/节点层；省略 = 零工具统一默认，最小权限）：
 * - 省略 / [] / [none]     → 零默认（空白名单）；[] 与 [none] 由解析层归一化为省略并警告
 * - [all]                  → 不限制（TOOL_POLICY_ALL；与 readonly 组合 = 全部只读工具）
 * - [a, b]                 → 默认名单（Lead 委派可显式覆盖，不是天花板/交集）
 * - [none, x] 混写         → 解析层报错（语义矛盾）
 * - [all, x]               → all 生效，x 忽略（解析层警告）
 * 关键字精确小写匹配（与工具名同命名空间同规则）；[ALL] 等变体按普通工具名走 typo 报错。
 *
 * null 契约：null = 不限制，仅两个来源——远程模板（执行在外部系统）与显式 [all] 且无其他约束。
 * isToolAllowedByPolicy(null) 全放行；零默认策略（whitelist = 空集）天然全拒。
 *
 * 两个生效通道共用本模块，禁止复制第二份判定逻辑：
 * - 委派通道：StandardSubagentExecutor 实现优先级链（Lead 指派 ?? 模板默认）；
 * - 前台通道：ChatEngine 工具集组装源头过滤。
 *
 * 纯逻辑、无 Node 依赖，渲染进程可用（仿 rolePrompt.ts 先例）。
 */

/** 规划模式下被拦截的工具（修改性操作；其余只读工具放行）。
 * 名单单一事实源在本文件（per-agent 权限与 plan 门同一口径）；
 * builtInTools.ts 经 re-export 兼容既有 import——勿在此文件 import builtInTools(防循环)。
 * task/batch_task 保留在列表中供 readonly 门（chill -p）拦截；
 * plan 模式门对 task/batch_task 豁免——Subagent 的工具集由 ChatEngine.buildDelegationContext 过滤为只读。
 * query_task_status/cancel_task 为任务管理只读/控制操作，放行。
 * schedule_task/cancel_scheduled_task 是写操作（创建/取消定时任务）在此名单；
 * list_scheduled_tasks 只读，不在名单。
 * mobile_send_file 在此名单（外发副作用——plan=只读语义下禁发文件到手机）。
 * board 整工具入名单（写类 action=修改性）；action 级 read 豁免在各门内做（isBoardReadOnlyAction），
 * 看板 read 是唯一的板面只读探查（无独立 board_status 工具），plan=只读语义下必须放行。 */
export const PLAN_MODE_BLOCKED_TOOLS: string[] = ['create_task_list', 'update_task_status', 'delete_task', 'add_task', 'execute_powershell', 'execute_code', 'create_file', 'delete_file', 'insert_content', 'replace_content', 'delete_content', 'add_model', 'remove_model', 'modify_model', 'add_mcp_server', 'delete_mcp_server', 'modify_mcp_server', 'install_skill', 'uninstall_skill', 'update_skill', 'trigger_guardian', 'manage_improvements', 'generate_image', 'generate_video', 'generate_audio', 'task', 'batch_task', 'resume_task', 'run_workflow', 'use_team', 'team_board', 'send_message', 'team_policy', 'approve_plan', 'computer_use', 'schedule_task', 'cancel_scheduled_task', 'board', 'mobile_send_file']


/** 本地模板类型字面量（types.ts 的 TemplateType 是 enum，node strip-only 测试不可运行时导入；
 * 与 SubagentTemplateManager.test.ts 的字面量替代约定一致；取值即 enum 的字符串值） */
const LOCAL_TEMPLATE_TYPES: readonly string[] = ['builtin', 'custom']

/** "all" 关键字：tools 的特殊值，语义 = 不限制 */
export const TOOL_POLICY_ALL = 'all'

/** "none" 关键字：仅委派层（available_tools: ["none"]）有意义 = 显式零工具；
 * 模板/节点层省略即零，[none] 由解析层归一化为省略（此处仅作防御性识别） */
export const TOOL_POLICY_NONE = 'none'

/**
 * 权限声明来源的最小结构（SubagentTemplate 与 AvailableSubagent 转换结果均满足，
 * 委派指南展示层可经此复用同一解析器）
 */
export interface ToolPolicySource {
  type?: string
  tools?: string[]
  disallowed_tools?: string[]
  readonly?: boolean
}

/**
 * 解析后的 agent 工具权限策略
 */
export interface AgentToolPolicy {
  /** 白名单（undefined = 不限定集合，仅受 readonly/disallowed 约束） */
  whitelist?: Set<string>
  /** 只读：剔除 PLAN_MODE_BLOCKED_TOOLS */
  readonly: boolean
  /** 黑名单（最后扣除） */
  disallowed: Set<string>
}

/**
 * 从模板解析工具权限策略
 * @param template - Subagent 模板（或满足 ToolPolicySource 的最小结构）
 * @returns 策略对象；远程模板或显式 [all] 且无其他约束时返回 null（不限制）
 */
export function resolveAgentToolPolicy(template: ToolPolicySource): AgentToolPolicy | null {
  // 远程模板（remote-mcp/remote-api/A2A/Coze）的执行在外部系统，工具权限管不到
  const type = template.type ?? 'builtin'
  if (!LOCAL_TEMPLATE_TYPES.includes(type)) {
    return null
  }

  const tools = template.tools
  const disallowedTools = template.disallowed_tools
  const readonly = template.readonly === true

  // tools 轴（统一收敛语义；解析层已归一化 [] / [none]，此处防御性兜底）：
  // 省略/空/[none] → 零默认（空白名单）；[all] → 不限定集合；[a,b] → 名单
  const toolList = Array.isArray(tools) ? tools : undefined
  const whitelist: Set<string> | undefined =
    toolList?.includes(TOOL_POLICY_ALL) === true
      ? undefined
      : !toolList || toolList.length === 0 || toolList.includes(TOOL_POLICY_NONE)
        ? new Set<string>()
        : new Set(toolList)
  const disallowed =
    Array.isArray(disallowedTools) && disallowedTools.length > 0
      ? new Set(disallowedTools)
      : new Set<string>()

  // 不限定集合且无其他约束 = 不限制（null；来源只有 [all]，省略已是零默认策略）
  if (!whitelist && !readonly && disallowed.size === 0) {
    return null
  }

  return { whitelist, readonly, disallowed }
}

/**
 * 判定工具是否被策略允许
 * 优先级：whitelist → 扣除 PLAN_MODE_BLOCKED_TOOLS（readonly）→ 扣除 disallowed
 * @param policy - resolveAgentToolPolicy 的返回值；null（不限制）时一律放行
 * @param toolName - 工具名
 */
export function isToolAllowedByPolicy(policy: AgentToolPolicy | null, toolName: string): boolean {
  if (!policy) return true
  if (policy.whitelist && !policy.whitelist.has(toolName)) return false
  if (policy.readonly && PLAN_MODE_BLOCKED_TOOLS.includes(toolName)) return false
  if (policy.disallowed.has(toolName)) return false
  return true
}
