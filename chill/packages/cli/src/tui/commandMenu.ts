/**
 * TUI 斜杠命令注册表（零依赖）
 *
 * 用途：tuiShell 据此拦截交互式命令（keypress 选择器 / rl.question 提问类，
 * rl 暂停时会挂死）；TuiApp 据此渲染 / 过滤菜单。
 * 注意：条目与 cli.ts 的 showHelp() 文案需同步维护（两处暂为平行事实源）。
 */

export interface CommandMenuEntry {
  /** 命令名（含前导 /，取首个 token 为匹配键） */
  name: string
  desc: string
  /** TUI 内不可用（交互式），命中时提示回 CLI */
  interactive?: boolean
  /** 无损命令（M1）：生成流式输出中也可执行——不碰引擎状态、输出一行回执（tuiShell 运行门对此豁免） */
  streamSafe?: boolean
}

export const COMMAND_MENU: CommandMenuEntry[] = [
  { name: '/help', desc: '显示帮助' },
  { name: '/skill', desc: '安装/卸载/更新/导出 Skill，或查看/启用/禁用' },
  { name: '/desktop', desc: '开关桌面能力（截屏 + 键鼠操作）' },
  { name: '/tools', desc: '工具渐进发现开关与状态（mode on|off、status）' },
  { name: '/mcp', desc: '进入 MCP 管理模式' },
  { name: '/workflow', desc: '进入 Workflow 管理模式' },
  { name: '/back', desc: '返回 Auto 模式（结束 MCP/Workflow 管理）' },
  { name: '/key', desc: '管理 API Key（set/list/delete）' },
  { name: '/model', desc: '管理模型选择（list/switch）' },
  { name: '/front', desc: '查看/选择会话前台（/front off 恢复裸模型）' },
  { name: '/tasks', desc: '列出后台任务（运行中带序号；/tasks cancel <序号|taskId> 停单个）' },
  { name: '/auto-apply', desc: '直销模式：on=任意路径直接写不问；off=圈内直接写、圈外当场批准' },
  { name: '/add-dir', desc: '把目录加入本次会话可写范围（无参列出当前边界）' },
  { name: '/auto-switch', desc: '开启/关闭自迭代后自动版本切换' },
  { name: '/switch-version', desc: '切换到自迭代后的新版本' },
  { name: '/discard-version', desc: '放弃自迭代后的新版本' },
  { name: '/rollback', desc: '交互式选择版本回滚；/r <版本> 直接回滚' },
  { name: '/improve', desc: '改进提案簇级决策面板（y 整簇/space 标记/Y 批量；review=深度审查）' },
  { name: '/idea', desc: '记闪念点子入改进提案「闪念」簇（一句话；流式输出中也可用）', streamSafe: true },
  { name: '/r', desc: '回滚到指定版本（/r <版本>，支持唯一前缀）' },
  { name: '/delete-version', desc: '删除指定历史版本' },
  { name: '/plan', desc: '进入/退出规划模式' },
  { name: '/goal', desc: '设定目标进入目标模式（/goal <目标与判据>；pause/resume/status/clear 管理）' },
  { name: '/pair', desc: '手机配对（出码/list/revoke/config；config 为交互式）', interactive: true },
  { name: '/relay', desc: '中继手动控制（start/stop/status）' },
  { name: '/send', desc: '发送文件到手机（手机端点接收才落盘，48h 内有效）' },
  { name: '/compact', desc: '压缩历史上下文（可带引导语：/compact 重点保留接口设计讨论）' },
  { name: '/fetch-source', desc: '下载 chill 源码并开启自迭代' },
  { name: '/use-npm', desc: '切换回 npm 包版本' },
  { name: '/use-self', desc: '切换到自迭代源码版本' },
  { name: '/config', desc: '查看和设置模型参数（show/set/unset）' },
  { name: '/limits', desc: '委派资源限额（并发/累计；set/unset 调整）' },
  { name: '/team', desc: '团队观测与直达控制（/team policy 改授权/预算）' },
  { name: '/restore', desc: '恢复文件/轮次备份（无参按对话轮次整批回滚）' },
  { name: '/session', desc: '会话管理（list/new/rename/load/delete）' },
  { name: '/memory', desc: '长期记忆管理（list/show/delete）' },
  { name: '/hooks', desc: '生命周期钩子管理（list/enable/disable/log；add 自然语言创建）' },
  { name: '/schedule', desc: '定时任务管理（list/cancel；创建直接对话说明）' },
  { name: '/init', desc: '生成项目 AGENTS.md 约束初稿' },
  { name: '/ui', desc: '启动 UI 模式（Electron）' },
  { name: '/tui', desc: '切换到 TUI 显示（默认入口；/cli 退回）' },
  { name: '/cli', desc: '切换到 CLI 显示' },
  { name: '/exit', desc: '退出' },
]

/** 输入是否为交互式命令（TUI 内不可用） */
export function isInteractiveCommand(input: string): boolean {
  const head = input.trim().split(/\s+/)[0]
  return COMMAND_MENU.some((e) => e.interactive && e.name === head)
}

/** 输入是否为无损命令（streamSafe）：生成流式输出中也可执行（M1——tuiShell 运行门豁免判据） */
export function isStreamSafeCommand(input: string): boolean {
  const head = input.trim().split(/\s+/)[0]
  return COMMAND_MENU.some((e) => e.streamSafe && e.name === head)
}

/** 输入是否为注册表中的已知命令（按首个 token 匹配；未知 / 命令在 TUI 不发给引擎） */
export function isKnownCommand(input: string): boolean {
  const head = input.trim().split(/\s+/)[0]
  return COMMAND_MENU.some((e) => e.name === head)
}

/** / 前缀过滤（菜单用）：输入 '/m' → 以 '/m' 开头的条目 */
export function filterCommandMenu(prefix: string): CommandMenuEntry[] {
  return COMMAND_MENU.filter((e) => e.name.startsWith(prefix))
}
