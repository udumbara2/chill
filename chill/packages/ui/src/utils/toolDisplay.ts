/**
 * 工具调用显示描述表（工具调用显示约定的唯一数据源）。
 * 一个工具调用 = (动词, 对象, 状态, 详情) 四元组；工具间的显示差异全部是数据，故收敛为本表。
 * 新增内置工具零 UI 代码：查表落空回退 { verb: 原始工具名, detail: 'params' }。
 * 纯函数、零依赖、无响应式——渲染端任何位置可用。
 */

export type ToolDetailKind = 'none' | 'params' | 'fileList' | 'command'

export interface ToolDescriptor {
  /** 中文动词（running 态由组件拼"正在{verb}"） */
  verb: string
  /** 关键对象（行内文案）：文件族取 basename、搜索取 pattern、命令取 purpose/首行 */
  object?: (p: Record<string, any>, result?: any) => string
  /** 对象悬浮全文（完整路径等）；返回非空时对象渲染为可点击链接（点击经 UI 事件在 dock 打开） */
  objectTitle?: (p: Record<string, any>) => string
  /** 展开详情种类：none=不可展开；params=参数键值+结果；fileList=多文件清单；command=命令详情 */
  detail?: ToolDetailKind
}

/** basename（兼容 \ 与 /；渲染端无 node:path，必须端无关实现） */
export const baseName = (p: string): string => {
  if (!p) return ''
  const n = p.replace(/\\/g, '/').replace(/\/+$/, '')
  const i = n.lastIndexOf('/')
  return i >= 0 ? n.slice(i + 1) : n
}

/** 首行截断（命令类对象文案） */
const firstLine = (s: string, max = 60): string => {
  const line = (s || '').split('\n')[0].trim()
  return line.length > max ? line.slice(0, max) + '…' : line
}

/** 文件族对象：basename（title=完整路径） */
const fileObject = (p: Record<string, any>): string => baseName(p?.path || p?.resolvedPath || '')
const fileTitle = (p: Record<string, any>): string => p?.path || p?.resolvedPath || ''

/** read_file 行号区间（与 FileReaderDisplay 旧逻辑逐条对齐：仅结果未覆盖全文时显示） */
const readObject = (p: Record<string, any>, result?: any): string => {
  const base = fileObject(p)
  const s = result?.startLine
  const e = result?.endLine
  const t = result?.totalLines
  if (s !== undefined && e !== undefined && t !== undefined && e - s + 1 < t) {
    return `${base} · 第 ${s}-${e} 行`
  }
  return base
}

/** delete_file 对象：单文件 basename，多文件 "N 个文件" */
const deleteFileObject = (p: Record<string, any>): string => {
  const paths: string[] = Array.isArray(p?.paths) ? p.paths : p?.path ? [p.path] : []
  if (paths.length === 0) return ''
  if (paths.length === 1) return baseName(paths[0])
  return `${paths.length} 个文件`
}

/** 命令族对象：人话 purpose 优先（对齐 Claude Code #40650），落空取命令首行 */
const commandObject = (p: Record<string, any>): string =>
  p?.purpose || firstLine(p?.command || p?.code || '')

const pathProp = (key: string) => (p: Record<string, any>): string => p?.[key] || ''

const FILE_DETAIL_NONE = 'none' as const
const PARAMS = 'params' as const

export const TOOL_DESCRIPTORS: Record<string, ToolDescriptor> = {
  // ---- 任务清单族（聊天流走 ToolLineDisplay 留痕；活体显示 = 进度药丸，约定 5） ----
  create_task_list: { verb: '创建任务清单', object: (p) => (p?.tasks?.length ? `${p.tasks.length} 项` : '') },
  update_task_status: { verb: '更新任务状态', object: (p) => (p?.updates?.length ? `${p.updates.length} 项` : '') },
  delete_task: { verb: '删除任务', object: (p) => (p?.task_ids?.length ? `${p.task_ids.length} 项` : '') },
  add_task: { verb: '添加任务', object: (p) => (p?.tasks?.length ? `${p.tasks.length} 项` : '') },
  task: { verb: '委派子代理' },
  query_task_status: { verb: '查询任务状态', detail: PARAMS },
  cancel_task: { verb: '取消任务', detail: PARAMS },
  batch_task: { verb: '批量委派任务', detail: PARAMS },
  resume_task: { verb: '恢复任务', detail: PARAMS },

  // ---- 命令执行族 ----
  execute_powershell: { verb: '运行 PowerShell', object: commandObject, detail: 'command' },
  execute_code: { verb: '运行代码', object: commandObject, detail: 'command' },

  // ---- 文件族（行即终态，不可展开；basename 可点击打开） ----
  read_file: { verb: '读取', object: readObject, objectTitle: fileTitle, detail: FILE_DETAIL_NONE },
  create_file: { verb: '创建', object: fileObject, objectTitle: fileTitle, detail: FILE_DETAIL_NONE },
  insert_content: { verb: '插入内容', object: fileObject, objectTitle: fileTitle, detail: FILE_DETAIL_NONE },
  replace_content: { verb: '替换内容', object: fileObject, objectTitle: fileTitle, detail: FILE_DETAIL_NONE },
  delete_content: { verb: '删除内容', object: fileObject, objectTitle: fileTitle, detail: FILE_DETAIL_NONE },
  delete_file: { verb: '删除文件', object: deleteFileObject, detail: 'fileList' },
  list_files: { verb: '列出文件', object: fileObject, objectTitle: fileTitle, detail: PARAMS },
  get_current_directory: { verb: '获取当前目录', detail: PARAMS },
  search_content: { verb: '搜索内容', object: (p) => (p?.pattern ? `"${p.pattern}"` : ''), detail: PARAMS },

  // ---- 模型管理族 ----
  add_model: { verb: '添加模型', object: pathProp('model_name'), detail: PARAMS },
  remove_model: { verb: '移除模型', object: pathProp('model_name'), detail: PARAMS },
  modify_model: { verb: '修改模型', object: pathProp('model_name'), detail: PARAMS },
  list_models: { verb: '列出模型', detail: PARAMS },

  // ---- 媒体生成族 ----
  generate_image: { verb: '生成图片', object: (p) => firstLine(p?.prompt || '', 40), detail: PARAMS },
  generate_video: { verb: '生成视频', object: (p) => firstLine(p?.prompt || '', 40), detail: PARAMS },
  generate_audio: { verb: '生成音频', object: (p) => firstLine(p?.prompt || '', 40), detail: PARAMS },

  // ---- 规划/目标族（交互走 PlanAskDialog，工具行只留痕） ----
  enter_plan_mode: { verb: '进入规划模式', detail: PARAMS },
  write_plan: { verb: '写入规划', detail: PARAMS },
  read_plan: { verb: '读取规划', detail: PARAMS },
  submit_plan: { verb: '提交规划', detail: PARAMS },
  propose_goal: { verb: '提议目标', object: (p) => firstLine(p?.objective || '', 40), detail: PARAMS },
  write_goal: { verb: '写入目标', detail: PARAMS },
  read_goal: { verb: '读取目标', detail: PARAMS },
  request_goal_review: { verb: '请求目标评审', detail: PARAMS },
  report_goal_blocked: { verb: '报告目标受阻', object: (p) => firstLine(p?.reason || '', 40), detail: PARAMS },

  // ---- MCP/技能族 ----
  list_mcp_servers: { verb: '列出 MCP 服务', detail: PARAMS },
  add_mcp_server: { verb: '添加 MCP 服务', object: pathProp('server_name'), detail: PARAMS },
  delete_mcp_server: { verb: '删除 MCP 服务', object: pathProp('server_name'), detail: PARAMS },
  modify_mcp_server: { verb: '修改 MCP 服务', object: pathProp('server_name'), detail: PARAMS },
  install_skill: { verb: '安装技能', object: pathProp('source'), detail: PARAMS },
  uninstall_skill: { verb: '卸载技能', object: pathProp('name'), detail: PARAMS },
  update_skill: { verb: '更新技能', object: pathProp('name'), detail: PARAMS },
  list_skills: { verb: '列出技能', detail: PARAMS },
  trigger_guardian: { verb: '触发守护', object: (p) => baseName(p?.project_path || ''), detail: PARAMS },

  // ---- 检索/会话/网络族 ----
  search_sessions: { verb: '搜索会话', object: (p) => (p?.query ? `"${p.query}"` : ''), detail: PARAMS },
  recall_archived_context: { verb: '召回归档上下文', detail: PARAMS },
  web_fetch: { verb: '抓取网页', object: pathProp('url'), detail: PARAMS },
  web_search: { verb: '联网搜索', object: (p) => (p?.query ? `"${p.query}"` : ''), detail: PARAMS },
  search_tools: { verb: '检索工具', object: (p) => (p?.query ? `"${p.query}"` : ''), detail: PARAMS },

  // ---- 记忆/改进族 ----
  save_memory: { verb: '保存记忆', object: (p) => firstLine(p?.title || '', 40), detail: PARAMS },
  delete_memory: { verb: '删除记忆', object: pathProp('title'), detail: PARAMS },
  manage_improvements: { verb: '管理改进项', detail: PARAMS },

  // ---- 提问族（交互面=PlanAskDialog） ----
  ask_user: { verb: '询问用户', object: (p) => firstLine(p?.question || '', 40), detail: PARAMS },

  // ---- 知识库族 ----
  list_knowledge_bases: { verb: '列出知识库', detail: PARAMS },
  create_knowledge_base: { verb: '创建知识库', object: pathProp('name'), detail: PARAMS },
  delete_knowledge_base: { verb: '删除知识库', object: pathProp('name'), detail: PARAMS },
  add_knowledge: { verb: '添加知识', object: (p) => firstLine(p?.title || p?.kb || '', 40), detail: PARAMS },
  search_knowledge: { verb: '搜索知识', object: (p) => (p?.query ? `"${p.query}"` : ''), detail: PARAMS },
  read_knowledge: { verb: '读取知识', object: pathProp('kb'), detail: PARAMS },
  distill_knowledge: { verb: '蒸馏知识', object: (p) => firstLine(p?.title || p?.kb || '', 40), detail: PARAMS },
  delete_knowledge: { verb: '删除知识', object: pathProp('kb'), detail: PARAMS },
  rebuild_knowledge_index: { verb: '重建知识索引', object: pathProp('kb'), detail: PARAMS },

  // ---- 桌面能力族 ----
  capture_screen: { verb: '屏幕截屏', detail: PARAMS },
  inspect_ui: { verb: '检查界面元素', detail: PARAMS },
  computer_use: { verb: '桌面操作', object: (p) => firstLine(p?.purpose || '', 40), detail: PARAMS },

  // ---- 定时任务族 ----
  schedule_task: { verb: '创建定时任务', object: (p) => firstLine(p?.prompt || '', 40), detail: PARAMS },
  list_scheduled_tasks: { verb: '列出定时任务', detail: PARAMS },
  cancel_scheduled_task: { verb: '取消定时任务', object: pathProp('id'), detail: PARAMS },
}

Object.freeze(TOOL_DESCRIPTORS)

/** 查表 + 兜底（MCP 工具与未登记工具：原始名 + params 详情） */
export function resolveDescriptor(toolName: string): ToolDescriptor {
  return TOOL_DESCRIPTORS[toolName] ?? { verb: toolName, detail: 'params' }
}

/** UI 内部事件：点击工具行文件对象 → 在 dock 打开该文件（Home.vue 监听；组件与 dock 零直接耦合） */
export const UI_EVENTS = {
  OPEN_FILE_IN_DOCK: 'ui:open-file-in-dock',
  /** 团队运行时装配完成(teamAssetService 发射;runtimePillStore 据此绑定 onChange——修装配晚于绑定的时序竞争) */
  TEAM_RUNTIME_READY: 'ui:team-runtime-ready',
} as const
