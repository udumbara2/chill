/**
 * hooks 系统的协议与配置类型定义
 *
 * 协议对齐 Claude Code 事实标准：外部进程 + stdin JSON 输入 + stdout JSON / exit code 输出。
 * 事件词汇表前 10 个与 Claude 对齐（生态脚本可复用），后 3 个为 chill 特色事件
 * （目标模式 / 委派是 chill 的核心能力）。
 */

/** hook 生命周期事件 */
export type HookEvent =
  | 'SessionStart'
  | 'SessionEnd'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PermissionRequest'
  | 'PostToolUse'
  | 'Stop'
  | 'Notification'
  | 'PreCompact'
  | 'PostCompact'
  | 'GoalTransition'
  | 'PreDelegation'
  | 'PostDelegation'

/** 全部合法事件名（配置解析时校验用） */
export const HOOK_EVENTS: readonly HookEvent[] = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'Stop',
  'Notification',
  'PreCompact',
  'PostCompact',
  'GoalTransition',
  'PreDelegation',
  'PostDelegation',
]

/** handler 来源（HookConfigLoader 填充的运行时元数据，hooks.json 中不书写） */
export interface HookSource {
  /** user = 用户级 ~/.chill/hooks.json（默认可信）；project = 项目级 .agents/hooks.json（需哈希信任审查） */
  kind: 'user' | 'project'
  /** 来源 hooks.json 的文件路径（/hooks list 展示与信任记录键的组成部分） */
  path: string
}

/** 项目级 handler 的信任状态：trusted=可信 / new=首见 / changed=已信任过的定义发生变更 */
export type HookTrustStatus = 'trusted' | 'new' | 'changed'

/** 单个 handler 的配置（hooks.json 中 hooks 数组的元素） */
export interface HookHandlerConfig {
  /** 可选名字：/hooks 列表展示与启用/禁用标识使用；缺省时以 command 作为标识 */
  name?: string
  /** handler 类型：首版仅实现 command；prompt/agent 类型预留（走 chill 自身模型服务，后续迭代插入） */
  type: 'command' | 'prompt' | 'agent'
  /** 要执行的命令（command 型必填） */
  command: string
  /** 超时（秒），默认 30 */
  timeout?: number
  /** 默认 false：超时/进程异常 fail-open（警告放行）；true 时按 deny 处理 */
  failClosed?: boolean
  // ---- 以下为 HookConfigLoader 填充的运行时元数据（hooks.json 中不书写） ----
  /** 来源（用户级/项目级及文件路径） */
  source?: HookSource
  /** 项目级 handler 的内容哈希（name+type+command+timeout+failClosed 的 sha256），信任判定依据 */
  trustHash?: string
  /** 项目级 handler 的信任状态（加载器按信任记录标记）；用户级恒为 undefined（默认可信，不走哈希） */
  trust?: HookTrustStatus
  /** 信任记录键（来源路径 + handler 标识），信任批准落盘/查询使用 */
  trustKey?: string
}

/** 项目级 hook 信任询问的请求（HookRunnerDeps.trustApprover 的入参） */
export interface HookTrustApprovalRequest {
  /** handler 标识：`事件:name（缺省 command）` */
  handlerId: string
  event: HookEvent
  command: string
  /** 该 handler 所在的项目级 hooks.json 路径 */
  sourcePath: string
  /** new=首见；changed=此前信任过的定义内容发生变更（需重点警惕供应链投毒） */
  reason: 'new' | 'changed'
}

/** 一个 matcher 组：matcher 命中时执行组内全部 handler */
export interface HookMatcherGroup {
  /**
   * 工具类事件（PreToolUse/PermissionRequest/PostToolUse）：对工具名的正则；
   * 子类型事件（SessionStart/GoalTransition/PreCompact/Notification 等）：与 matcher_value 精确相等。
   * 空字符串或省略 = 全匹配
   */
  matcher?: string
  hooks: HookHandlerConfig[]
}

/** 事件 → matcher 组数组 */
export type HooksConfig = Partial<Record<HookEvent, HookMatcherGroup[]>>

/** hooks.json 文件的外层结构（{"hooks": {...}}） */
export interface HooksFileShape {
  hooks?: HooksConfig
}

/** 发给 hook 进程的 stdin JSON（snake_case 对齐 Claude 协议，生态脚本可直接复用） */
export interface HookInput {
  session_id: string
  cwd: string
  hook_event_name: HookEvent
  /** 工具类事件：即将/已经执行的工具名 */
  tool_name?: string
  /** 工具类事件：工具入参（决策链中为 waterfall 后的当前值） */
  tool_input?: Record<string, unknown>
  /** PostToolUse：工具执行结果 */
  tool_response?: unknown
  /** 子类型事件的匹配值（SessionStart: startup/resume；PreCompact: manual/auto；GoalTransition: started/achieved/...） */
  matcher_value?: string
  /** Stop 防死循环标志：本次续跑由 Stop hook 强制触发时为 true */
  stop_hook_active?: boolean
  [key: string]: unknown
}

/** hook 进程 stdout 的 JSON 输出协议（exit 0 时解析） */
export interface HookOutput {
  /** 'block'/'deny' = 阻断（配合 reason，两词同义兼容）；等价于 continue:false */
  decision?: string
  /** 阻断/询问的原因，反馈给模型 */
  reason?: string
  /** 展示给用户（不注入模型上下文） */
  systemMessage?: string
  /** false = 阻断（等价于 decision:'block'） */
  continue?: boolean
  hookSpecificOutput?: {
    hookEventName?: string
    /** allow = 放行（PermissionRequest 槽即自动批准）；deny = 阻断；ask = 升级为人工审批 */
    permissionDecision?: 'allow' | 'deny' | 'ask'
    /** 改写工具入参（决策链 waterfall：后续 handler 看到的是改写后的值） */
    updatedInput?: Record<string, unknown>
    /** 注入模型上下文的附加内容；同事件多个 hook 的全部拼接 */
    additionalContext?: string
  }
}

/** 统一决策管线的判定结果（既有的门重构为 PolicyLink 后同样返回此类型） */
export type PolicyVerdict =
  | { type: 'allow' }
  | { type: 'deny'; reason: string }
  | { type: 'ask'; reason?: string }
  | { type: 'transform'; updatedInput: Record<string, unknown> }

/** 决策链路的上下文（一次工具调用/回合的生命周期信息） */
export interface PolicyContext {
  sessionId: string
  cwd: string
  toolName?: string
  toolInput?: Record<string, unknown>
  [key: string]: unknown
}

/**
 * 决策管线的有序环节接口（供后续既有门重构用）：
 * commandSafety 黑名单 / readonly·plan·写边界·goal 门 / hooks / 审批弹窗同构为 PolicyLink，
 * 编入一条有序管线——串行执行、deny 熔断、transform waterfall。
 */
export interface PolicyLink {
  name: string
  evaluate(ctx: PolicyContext): Promise<PolicyVerdict>
}

/** 单次 hook 触发记录（可观测性：/hooks log 展示最近 50 次） */
export interface HookInvocation {
  event: HookEvent
  /** 命中的 matcher（undefined = 全匹配组） */
  matcher?: string
  /** handler 标识（name ?? command） */
  handlerName: string
  command: string
  durationMs: number
  /** null = 进程未能正常退出 */
  exitCode: number | null
  /** 决策摘要：allow / deny / ask / transform / error / skipped-untrusted（项目级未获信任被跳过） */
  decision?: string
  /** 超时 / 进程异常 / 非零退出码等错误描述 */
  error?: string
  /** ISO 时间戳 */
  at: string
}

/** hook 配置的 mtime 探测接口（IFileSystemProvider 无 stat 能力，mtime 由壳层窄接口提供） */
export interface IFileMtimeProvider {
  /** 返回文件 mtime（ms）；文件不存在或探测失败返回 null */
  getMtimeMs(path: string): Promise<number | null>
}
