/**
 * 桌面审计日志（desktop audit trail）接口。
 * 桌面能力在真实桌面执行不可逆动作，审计留痕是信任基础：每次到达执行阶段的桌面动作
 * （含被拒绝的——用户决策必须留痕）发射一条 DesktopAuditEntry，由宿主注入的 sink 落盘。
 * core 平台无关硬约束：落盘（JSONL/截图文件）是平台相关能力，只能经本接口注入实现
 * （CLI 注入 NodeDesktopAuditSink 写 ~/.chill/desktop-audit/；UI 经 IPC 桥到主进程同款实现）。
 * 记录时点规则：只记到达执行阶段的（审批通过/会话放行/被动免批）+ 被拒绝的；
 * 前置校验失败（label 越界、未截屏等未产生副作用的）不记——模型已从工具结果收到错误，审计不重复噪音。
 */

/** 单条桌面审计记录（JSONL 一行） */
export interface DesktopAuditEntry {
  /** ISO 时间戳（executor 发射时现取） */
  ts: string
  /** 工具名：capture_screen / inspect_ui / computer_use */
  tool: string
  /** 动作名（computer_use 的 action；capture_screen/inspect_ui 为观察事件名） */
  action: string
  /** 人话描述（与审批弹窗同源的 describeComputerUseAction 文案） */
  desc: string
  /** 模型自报意图（computer_use 的 purpose 参数；归因"想做 vs 实做"的差距） */
  purpose?: string
  /** 坐标双记（坐标类动作携带：图像坐标 → 换算后物理坐标；复盘时区分"猜错"与"算错"） */
  coord?: { image: [number, number]; phys: [number, number] }
  /** 审批结论四态：approved=用户逐次批准 / rejected=用户拒绝 / session=[s] 会话放行 / passive=被动免批 */
  approval: 'approved' | 'rejected' | 'session' | 'passive'
  /** 执行是否成功（rejected 条目恒 false） */
  ok: boolean
  /** 失败原因（ok=false 时携带） */
  error?: string
  /** 批处理定位（批内逐步各一条：id=整批 toolCallId，step/total 为步序） */
  batch?: { id: string; step: number; total: number }
  /** 关联截图文件相对路径（shots/xxx.png；由 sink 落盘后回填，executor 不填） */
  shot?: string
}

/**
 * 审计落盘接收方（fire-and-forget）：executor 调用即忘，不等待、不感知成败。
 * 有截屏结果时 executor 把图像 dataUri 一并交给 sink——sink 负责解码落盘并把相对路径回填 entry.shot。
 * 实现必须全程容错（内部 try/catch 吞咽）：审计是旁路不是关键路径，写盘失败不得影响动作执行。
 */
export interface DesktopAuditSink {
  record(entry: DesktopAuditEntry, imageDataUri?: string): void
}
