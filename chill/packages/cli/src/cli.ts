#!/usr/bin/env node
// 全局设置 Python 子进程 UTF-8 编码，防止 emoji/中文等在 GBK 系统代码页下崩溃或乱码
process.env.PYTHONIOENCODING = 'utf-8'

import * as readline from 'node:readline'
import { spawn, execSync } from 'node:child_process'

import { existsSync, mkdtempSync, readFileSync, appendFileSync, readdirSync, realpathSync, rmdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CliContext } from './context/CliContext.js'
import { CliChatService } from './commands/CliChatService.js'
import { CliMcpService } from './commands/CliMcpService.js'
import { CliSessionService } from './commands/CliSessionService.js'
// TUI 状态(零依赖小模块,静态引入不进懒加载 chunk):顶层输出/提问旁路的检查点
import { isTuiActive, presentPrint, hasAskPresenter, presentAsk, registerCommandDispatcher, registerPasteProvider } from './tui/tuiState.js'
// 任务清单跟踪器（活动区挂载 + 落地入史；事件处理委托，返回值非 null 时走 CLI 回退打印）
import { onTaskListCreated, onTaskStatusUpdated, onTaskDeleted, onTaskAdded, clearTodoList, setTodoLandRecorder } from './todoTracker.js'
import { CliWorkflowService } from './commands/CliWorkflowService.js'
import { CliRelayClient } from './relay/relayClient.js'
import { ServeSessions } from './relay/serveSessions.js'
import { consoleAsk, SURFACE_RETRACTED } from './adapters/consoleAsk.js'
import { handlePair, handleRelay, makeAskConfirm } from './relay/pairCommands.js'
import { runServeControl, taskExists, spawnServeRestartHelper, writeServeAlarm } from './serveControl.js'
import { resolveMediaMentions } from './adapters/cliMediaAdapter.js'
import { fetchSource, getWorkspaceProjectDir, isSelfVersionUsable, readPointer, writePointer } from './commands/fetchSource.js'
import { eventBus, EVENTS, SecureStorageService, modelInfoService, providerManager, SelectedModelsService, getSkillRegistry, parseSkillMd, writeInstallMeta, readInstallMeta, gitClone, decompressArchive, downloadFile, getOwnProjectPaths, deriveModelKind, reloadSkillRegistry, memoryStore, memoryDecayScore, improvementProposer, improvementLedger, formatDigestLine, formatEntriesGrouped, parseDecisionInput, summarizeDigest, agentInstructions, getTemplateManager, parseAgentMentions, parseBareAgentMention, getForkManager, getTaskRegistry, getApprovalChannel, getAskChannel, getWriteBoundary, INIT_AGENTS_MD_PROMPT, messageText, getProviderDocUrl, getRecommendedVisionModelName, resolveKeySlotId, listKeySlotDomains, nextKillChordState, cancelAllRunningTasks, executeCancelTask, resolveTaskCancelTarget, approvalQuestionText, normalizeApprovalAnswer, ProjectPersistence, latestSessionIdInDir, type ApprovalRequestPayload, type AskRequestPayload, type BackupEntry, type TurnGroup, type DesktopAuditEntry, type HookEvent, type HookTrustApprovalRequest, type ScheduledTask, type SessionRecord, type FileReceiptPayload, type ChatEngine, watchVersionToken } from '@assistant-ai/core'

import { setDesktopControl, setAutoSwitchFlag, readDesktopEnabled, type DesktopControlDeps } from '@assistant-ai/core'/** Ctrl+K 双击停止全部后台任务的确认窗截止时刻（null = 未上膛；过期惰性判定，无需定时器） */
let killChordConfirmUntil: number | null = null
// 首次使用向导（bootstrap loader）：零 Key 用户首启引导（见 firstRunWizard.ts 文件头）
import { detectFirstRun, runFirstRunWizard, WIZARD_DISMISSED_KEY } from './commands/firstRunWizard.js'

// stdout/stderr 管道容错(常驻):win10 conhost 在快速 resize 高负载时控制台写入会
// 失败(EPIPE/EIO/EOF,已实证),伪终端(ConPTY/VS Code/Git Bash)下管道瞬断同理——
// 这类瞬断不该杀死进程;挂 error 监听后流错误不再升级为未捕获异常
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err?.code === 'EPIPE' || err?.code === 'EIO' || err?.code === 'EOF') return
    throw err
  })
}


// 模式判定由 getOwnProjectPaths 自锚定完成（junction 布局下自动反推 junction 路径）。
// projectPaths 仅供自迭代机制（workcopy/guardian/versions）显式取用，不再是工作目录基准——
// 工作目录永远 = 用户启动目录（process.cwd()）
const projectPaths = getOwnProjectPaths()

// CWD 规范化：若 CLI 从 chill 或 chill-workcopy 目录树内启动，统一切换到项目父目录，
// 避免 execute_powershell 缺省 cwd 落入版本目录树（目录内 CWD 会导致版本切换/清理时 EBUSY）
// npm 模式（projectPath 为 null）下用户在哪个目录启动就留在哪个目录
{
  const cwd = process.cwd().toLowerCase()
  const insideDir = (dir: string) => {
    const d = dir.toLowerCase()
    return cwd === d || cwd.startsWith(d + sep)
  }
  const projectPath = projectPaths.projectPath
  if (projectPath !== null && (insideDir(projectPath) || insideDir(join(projectPaths.parentDir, 'chill-workcopy')))) {
    process.chdir(projectPaths.parentDir)
  }
}

const ctx = await new CliContext(process.cwd()).init()


// 小贴士库：覆盖全部值得提醒用户的功能，/help 末尾随机显示一条
const STARTUP_TIPS = [
  // --- 会话与记忆 ---
  '输入 /session list 查看历史会话，/session load <序号> 继续上次对话',
  '对话中说"记住……"即可让模型保存长期记忆，输入 /memory 管理所有记忆',
  '输入 /init 分析代码库并生成项目 AGENTS.md 约束初稿',

  // --- 模型与配置 ---
  '输入 /model switch 交互式切换对话模型',
  '输入 /key set <供应商> <Key> 添加 API Key，/key list 查看已有',
  '输入 /config show 查看当前模型参数，/config set <key> <value> 修改',

  // --- 能力扩展 ---
  '使用 /skill list 查看已安装技能，/skill install 安装新技能',
  '输入 /mcp 进入 MCP 管理模式，连接外部工具服务',
  '输入 /front 查看/选择会话前台（裸模型或本地 Agent）',

  // --- 规划与执行 ---
  '输入 /plan 进入规划模式，先讨论打磨再执行，避免盲目改动',
  '写文件默认圈内直接生效、圈外当场请你批准；输入 /add-dir <路径> 扩大可写范围，/auto-apply on 全量直接写不问',

  // --- 自迭代 ---
  '输入 /fetch-source 下载源码开启自迭代，/rollback 回滚到历史版本',
  '输入 /r <版本前缀> 快速回滚，/delete-version <版本> 清理旧版本',

  // --- 显示切换 ---
  '输入 /ui 启动桌面 UI 模式，/tui 切换到终端富文本显示',
  '按 Ctrl+X 中断当前生成，Ctrl+V 粘贴剪贴板内容',

  // --- 文件操作 ---
  '使用 @文件路径 发送图片或视频（如 @./photo.jpg）',
  '使用 @agent名 点名委派任务（如 @code-reviewer 审查改动；TUI/UI 输入 @ 有列表）',
  '输入 /restore <文件路径> 恢复文件到备份版本，无参 /restore 按对话轮次整批回滚',
  '使用 /workflow 进入工作流管理模式',
]

// ===== argv 解析（手工，不引依赖）=====
// -p|--print：非交互一次性执行（默认只读，--auto 放开修改）；--cli：强制 CLI 显示（默认 TUI）
// --serve：无界面常驻宿主（手机遥控后端；与 -p/--cli/任务文本互斥；控制面经 chill serve on/off/status）
// flag 与任务文本可任意顺序：chill -p "任务" / chill -p --auto "任务" / chill --auto -p "任务" 均合法
let printPrompt: string | null = null
let printMode = false
let printAuto = false
// --cli:强制 CLI 显示(默认入口已翻转为 TUI,此为出口)
let forceCli = false
// --serve:无界面常驻宿主(实施规划 D1;分支体见 -p 分支之后)
let serveMode = false
{
  const argv = process.argv.slice(2)
  const usage = '用法: chill [-p|--print] [--auto] [--cli] <任务>\n  -p, --print  非交互一次性执行（默认只读，--auto 放开修改）\n  --cli        强制 CLI 显示（默认 TUI 显示）\n  --serve      无界面常驻宿主（手机遥控后端）\n  serve        常驻宿主控制面：chill serve on|off|status\n  web          启动 Web UI（浏览器打开终端打印的地址）'
  // D14 控制面首词门控：极早分流（先于 CliContext/引擎构造，毫秒级）——runServeControl 自带退出
  if (argv[0] === 'serve') {
    runServeControl(argv.slice(1))
    process.exit(0)
  }
  for (const arg of argv) {
    if (arg === '-p' || arg === '--print') {
      printMode = true
    } else if (arg === '--auto') {
      printAuto = true
    } else if (arg === '--cli') {
      forceCli = true
    } else if (arg === '--serve') {
      serveMode = true
    } else if (arg.startsWith('-') && arg !== '-') {
      process.stderr.write(`未知参数: ${arg}\n${usage}\n`)
      process.exit(2)
    } else if (printPrompt === null) {
      printPrompt = arg
    } else {
      process.stderr.write(`多余参数: ${arg}（任务含空格请用引号包裹）\n${usage}\n`)
      process.exit(2)
    }
  }
  // --serve 是互斥的进程形态：一次性执行/强制显示/任务文本都与之矛盾
  if (serveMode && (printMode || printAuto || forceCli || printPrompt !== null)) {
    const conflicts = [
      printMode && '-p/--print',
      printAuto && '--auto',
      forceCli && '--cli',
      printPrompt !== null && '任务文本',
    ].filter(Boolean).join('/')
    process.stderr.write(`--serve（无界面常驻宿主）不能与 ${conflicts} 组合\n${usage}\n`)
    process.exit(2)
  }
  if (printPrompt !== null && !printMode) {
    process.stderr.write(`任务参数需配合 -p/--print 使用\n${usage}\n`)
    process.exit(2)
  }
  if (printMode && printPrompt === null) {
    process.stderr.write(`-p/--print 缺少任务内容\n${usage}\n`)
    process.exit(2)
  }
}

// ===== 显示模式早定 + 启动输出分流（TUI 原则：输出归通道，主屏零闪屏）=====
// TTY 且非 -p/--cli 时直进 TUI：欢迎内容（banner/入口提示/约束/通知）收集为数据，
// 由 enterTui 在消息区原生渲染；CLI 路径照原样打印（输出与分流前逐字节一致）。
const wantTui = printPrompt === null && !forceCli && !serveMode && process.stdout.isTTY
const startupLines: string[] = []
const startupOut = (text: string): void => {
  if (wantTui) startupLines.push(text)
  else process.stdout.write(text)
}

/** 旁路通知输出：-p 非交互模式写 stderr，保证 stdout 只有助手正文；交互模式写 stdout */
/** 旁路通知输出：TUI 活跃时转交 TUI 消息区（防污染 alt-screen 画面）；-p 非交互写 stderr；否则写 stdout */
function notify(text: string): void {
  if (isTuiActive()) {
    if (!presentPrint(text)) process.stderr.write(text)
    return
  }
  if (printPrompt !== null) process.stderr.write(text)
  else process.stdout.write(text)
}

// ===== 任务清单事件（活动区挂载 + 落地留痕入引擎历史）=====
// TUI 活跃期快照推活动区原位刷新（历史区零任务行）；全部 completed/failed 或被新列表
// 取代时最终态经 landRecorder 写入引擎历史（synthetic:'todoLanding'，显示由历史重建派生）。
// 跟踪器返回非 null 文本时走 CLI 回退打印（创建/落地全量清单、更新紧凑单行）
// 工作计划树迭代 0：来源过滤统一规则——黑名单制拒 'subagent'（Worker 写入整表覆盖会污染主清单；
// undefined/'main'/'mobile'[手机发起轮次的主引擎调用]照收；todoTracker 的事件入口即下列四委托，
// 过滤在本层一次收口）
const acceptTaskEventSource = (source: unknown): boolean => source !== 'subagent'
eventBus.on(EVENTS.TASK_LIST_CREATED, (payload: any) => {
  if (!acceptTaskEventSource(payload?.source)) return
  const tasks = payload.tasks || payload
  if (!Array.isArray(tasks) || tasks.length === 0) return
  const out = onTaskListCreated(tasks)
  if (out !== null) notify(out)
})

eventBus.on(EVENTS.TASK_STATUS_UPDATED, (payload: any) => {
  if (!acceptTaskEventSource(payload?.source)) return
  const out = onTaskStatusUpdated(payload.taskId, payload.status, payload.content)
  if (out !== null) notify(out)
})

eventBus.on(EVENTS.TASK_DELETED, (payload: any) => {
  if (!acceptTaskEventSource(payload?.source)) return
  const out = onTaskDeleted(payload.taskId)
  if (out !== null) notify(out)
})

eventBus.on(EVENTS.TASK_ADDED, (payload: any) => {
  if (!acceptTaskEventSource(payload?.source)) return
  const task = payload.task || payload
  const out = onTaskAdded(task.id || task.task_id || '', task.content || '')
  if (out !== null) notify(out)
})

// 版本切换成功事件：置标志，由本轮对话完成后的 finally 块驱动旧窗口退出（确认成功+告别完毕才退出）
let pendingSwitchExit = false
// 本进程亲历切换事件（发起壳标志，M1.7 旁观自续的去重闸——事件同步先于令牌 watch 异步回调）
let localSwitchInitiated = false
// serve 换版接续出口（M1.3）：serve 分支装配（serveMode 永远到不了下方 finally 消费点——
// --serve 分支是 await new Promise<never>）；事件路径延迟 5s 调用（告别语先投递手机）
let serveVersionSwitchExit: ((origin: string) => void) | null = null
eventBus.on('chill:switch-succeeded', (payload: any) => {
  pendingSwitchExit = true
  localSwitchInitiated = true
  // M1.6：接续窗统一收敛到本订阅器——发起壳=CLI/TUI → 先开新窗（先开后退，零感知接替）；
  // 发起壳=serve → 不开窗（serveVersionSwitchExit 走自退+小助手拉起）；-p 一次性形态无窗可续。
  // 三处历史 spawn（core executor / 手动切换 4386 / 回滚 2734）全部收敛于此，双窗风险消除。
  if (!serveMode && !printMode && projectPaths.projectPath !== null) {
    const guardianPath = join(projectPaths.parentDir, 'chill-guardian', 'switcher.js')
    if (existsSync(guardianPath)) {
      spawn('node', [guardianPath, '--launch', projectPaths.projectPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      }).unref()
    }
  }
  // M1.3：serve 发起路径——5s 告别缓冲后优雅自退（小助手拉起新版本）
  if (serveMode) {
    setTimeout(() => {
      serveVersionSwitchExit?.(`chill:switch-succeeded${payload?.version ? ` v${payload.version}` : ''}`)
    }, 5000).unref()
  }
})

// 版本切换进度（/switch-version 手动路径用事件突破 TUI 命令捕获，实时显示进度）
eventBus.on('chill:switch-progress', (msg: string) => {
  if (!isTuiActive()) {
    process.stdout.write(msg + '\n')
  }
})

// 通用命令进度（/compact 等长耗时命令用事件突破 TUI 命令捕获，实时显示进度）
eventBus.on('chill:command-progress', (msg: string) => {
  if (!isTuiActive()) {
    process.stdout.write(msg + '\n')
  }
})

// 生成任务进度（视频等异步生成，由 AsyncTaskHandler 引擎发出）
eventBus.on(EVENTS.GENERATION_PROGRESS, (payload: any) => {
  const kindLabel = payload?.kind === 'video-gen' ? '视频' : '生成物'
  notify(`\r⏳ ${kindLabel}生成中…已等待 ${payload?.elapsedSec ?? 0}s   `)
})

// 规划被批准：自动退出规划模式并开始执行（planMode 状态源在引擎，引擎已监听同一事件自同步，此处只提示，不回调 setPlanMode 防回环）
eventBus.on(EVENTS.PLAN_APPROVED, () => {
  notify('\n✓ 规划已批准，已自动退出规划模式，开始执行。\n')
})

// d→m 文件发送回执（FILE_RECEIPT；无等待器的迟到 receipt 同样到此——送达事实须让用户可见）：
// 控制台打印一行 + 当前会话留痕（合成消息 fileReceipt，模型可见——mobile_send_file 承诺
// "送达后我会在会话里告诉你"的兑现通道）；TUI 激活时 notify 走消息区，不裸打印腐蚀渲染
eventBus.on(EVENTS.FILE_RECEIPT, (p: FileReceiptPayload) => {
  const label = p.name ? `《${p.name}》` : '文件'
  const text = p.ok ? `手机已接收${label}` : `手机接收${label}失败：${p.error ?? '未知原因'}`
  notify(`\n📱 ${text}\n`)
  // 落会话留痕仅限归属会话仍是当前会话（发送后已切会话则只打印——不写错历史）
  if (!p.sessionId || p.sessionId === activeEngine().getSessionState().sessionId) {
    activeEngine().appendSyntheticMessage(`（📱 ${text}）`, 'fileReceipt')
  }
})

// R2 压力触发的自动压缩完成（判定在引擎 contextPressure；此处只提示，不回调引擎 API 防回环）。
// 用量对比口径与手动 /compact 相同：前=引擎重置前 lastUsage 实测；后=总结+保留尾字符粗估（2 字符/token）标"约"
eventBus.on(EVENTS.CONTEXT_AUTO_COMPACTED, (payload: any) => {
  const { checkpoint, previousUsage } = payload ?? {}
  const upTo = checkpoint ? new Date(checkpoint.upToTimestamp).getTime() : 0
  const tailChars = chatService
    .getMessages()
    .filter((m) => new Date(m.timestamp).getTime() > upTo)
    .reduce((sum, m) => sum + messageText(m).length, 0)
  const summaryChars = checkpoint?.summary?.length ?? 0
  const afterTokens = Math.max(1, Math.round((summaryChars + tailChars) / 2))
  const fmt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n))
  if (previousUsage) {
    const beforeTokens = previousUsage.promptTokens + previousUsage.completionTokens
    const freed = beforeTokens > 0 ? Math.max(0, Math.round((1 - afterTokens / beforeTokens) * 100)) : 0
    notify(`\n✦ 上下文占用已达阈值，已自动压缩：${fmt(beforeTokens)} → 约 ${fmt(afterTokens)}（已释放约 ${freed}%）。原对话全部保留。\n`)
  } else {
    notify(`\n✦ 上下文占用已达阈值，已自动压缩：压缩后上下文约 ${fmt(afterTokens)}。原对话全部保留。\n`)
  }
})

// R3 溢出恢复完成（引擎 callWithOverflowRecovery 强制压缩后重试成功；此处只提示）
eventBus.on(EVENTS.CONTEXT_OVERFLOW_RECOVERED, () => {
  notify('\n✦ 上下文超出模型窗口上限，已自动强制压缩并重试本轮请求。原对话全部保留；如仍异常可用 /compact 手动压缩。\n')
})

// 模型调用 enter_plan_mode 主动进入规划模式（退出只能由用户批准或 /plan off，模型无法自行退出）
eventBus.on(EVENTS.PLAN_MODE_ENTERED, () => {
  notify('\n■ 模型已进入规划模式：修改性操作将被拦截，模型打磨规划后由你审阅批准。\n')
})

// 目标模式事件提示（goalMode 状态源在引擎；此处只提示，不回调引擎 API 防回环）
eventBus.on(EVENTS.GOAL_STARTED, (payload: any) => {
  notify(`\n◎ 已进入目标模式（轮次上限 ${payload?.maxRounds ?? 20}）：每轮结束自动评估，未达成将自动续跑；/goal clear 可随时放弃。\n`)
})
eventBus.on(EVENTS.GOAL_ACHIEVED, (payload: any) => {
  notify(`\n✓ 目标已达成（${payload?.reason ?? '评估通过'}；共推进 ${payload?.roundCount ?? 0} 轮），已自动退出目标模式。\n`)
})
eventBus.on(EVENTS.GOAL_CLEARED, (payload: any) => {
  notify(`\n○ 目标已清除${payload?.reason ? `（${payload.reason}）` : ''}，已退出目标模式。\n`)
})
eventBus.on(EVENTS.GOAL_BUDGET_EXHAUSTED, (payload: any) => {
  // paused=true：随后紧跟熔断请示问答；无 paused：无应答通道，已直接退出
  notify(`\n■ 目标模式${payload?.paused ? '已自动暂停' : '已停止'}：${payload?.reason ?? '预算耗尽'}。\n`)
})
eventBus.on(EVENTS.GOAL_PAUSED, () => {
  notify('\n‖ 目标已暂停（/goal resume 恢复推进）。\n')
})
eventBus.on(EVENTS.GOAL_RESUMED, (payload: any) => {
  notify(`\n▶ 目标已恢复推进（轮次上限 ${payload?.maxRounds ?? '?'}）。\n`)
})

// hook 面向用户的信息（警告/拦截理由/systemMessage）：core 经 HOOK_MESSAGE 抛出，此处渲染。
// 走 notify 既有三模式分流（TUI 消息区 / -p stderr / 交互 stdout），一行一条、[hook] 前缀
eventBus.on(EVENTS.HOOK_MESSAGE, (payload: { event?: string; messages?: string[] }) => {
  const messages = payload?.messages
  if (!Array.isArray(messages)) return
  for (const msg of messages) {
    if (msg) notify(`\n[hook] ${msg}\n`)
  }
})

/** 同步执行 switcher 并解析其 RESULT_JSON 输出（超时 300s 杀死并返回 {timeout:true}） */
function runSwitcher(guardianPath: string, switcherArgs: string[], logFn: (msg: string) => void): Promise<any> {
  return new Promise((resolve) => {
    const child = spawn('node', [guardianPath, ...switcherArgs], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    let out = ''
    let errBuf = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill() } catch { /* 忽略 */ }
    }, 300000)
    child.stdout?.on('data', (d) => { out += d.toString() })
    child.stderr?.on('data', (d) => { errBuf += d.toString() })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ success: false, step: 'spawn', reason: err.message, guidance: '无法启动 switcher 进程，检查 node 是否在 PATH 中。' })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      logFn(`switcher exit: code=${code}, timedOut=${timedOut}`)
      if (timedOut) {
        resolve({ timeout: true })
        return
      }
      const m = out.match(/RESULT_JSON:(\{.*\})/)
      if (m) {
        try { resolve(JSON.parse(m[1])); return } catch { /* 落到通用失败 */ }
      }
      resolve({
        success: false,
        step: 'switcher执行',
        reason: `switcher 异常退出（退出码 ${code}），未输出结果。stderr: ${errBuf.slice(-300)}`,
        guidance: '查看 chill-guardian/switcher-debug.log 获取详情。'
      })
    })
  })
}

const mcpService = new CliMcpService(ctx, ctx.mcpConfigPersistence)
const workflowService = new CliWorkflowService(ctx)

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
})

// [stdin-watch-debug 埋点已退役 2026-10-04]：2026-09-15 为抓"readline Invalid string length
// 崩溃"而埋，但当时误判了流——真凶是 readline 裸读文件流遇单行超 V8 字符串上限(~536M 字符)
// 在 data 事件上下文炸死进程（serve 实测崩溃+本地复现），stdin 从未收到过任何数据（埋点全程零命中）。
// 根治已落到 core utils/boundedLineReader（有界行读取，AGENTS.md《文件行读取约定》）。

// 读取系统剪贴板内容（Windows）
function readClipboard(): string {
  if (process.platform !== 'win32') return ''
  try {
    // 强制 PowerShell 输出 UTF-8，避免系统代码页(CP936)导致中文乱码
    const psCommand = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; Get-Clipboard -Raw`
    const commandBytes = Buffer.from(psCommand, 'utf16le')
    const encodedCommand = commandBytes.toString('base64')
    return execSync(`powershell -NoProfile -EncodedCommand ${encodedCommand}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    })
  } catch {
    return ''
  }
}

// 支持 Ctrl+V 粘贴（raw mode 下终端原生粘贴被禁用）
// 同一份能力注册给 TUI（TuiApp 的 Ctrl+V 经 presentPaste 调用）
registerPasteProvider(readClipboard)

process.stdin.on('keypress', (_str: string, key: any) => {
  // TUI 活跃时输入归 Ink:Ctrl+V 不写已 pause 的 rl,Ctrl+X 由 TuiApp 经 onAbort 处理
  if (isTuiActive()) return
  if (key && key.ctrl && key.name === 'v') {
    // 删除 readline 刚插入的 0x16 控制字符
    if (rl.line.length > 0 && rl.line.charCodeAt(rl.cursor - 1) === 0x16) {
      rl.write(null, { ctrl: true, name: 'h' })
    }
    // 读取剪贴板，去除尾部换行，内部换行转空格
    const clip = readClipboard()
      .replace(/\r\n/g, '\n')
      .replace(/\n+$/, '')
      .replace(/\n/g, ' ')
    rl.write(clip)
  }
  if (key && key.ctrl && key.name === 'x') {
    if (isChatting) {
      chatService.abortCurrent()
    }
  }
  // Ctrl+K 双击停止全部后台任务（对齐官方双击确认语义）：仅空行识别——
  // readline 的 Ctrl+K 默认"删至行尾"，输入有字时保留 readline 原义（空行时该原义无效果）
  if (key && key.ctrl && key.name === 'k' && rl.line === '') {
    const now = Date.now()
    const r = nextKillChordState(killChordConfirmUntil, now)
    if (r.action === 'confirm') {
      killChordConfirmUntil = null
      cancelAllRunningTasks().then(({ cancelled }) => {
        notify(`[已停止] ${cancelled} 个后台任务已取消\n`)
      })
    } else {
      const n = getTaskRegistry().listRunning().length
      if (n > 0) {
        killChordConfirmUntil = r.confirmUntil
        notify(`再按一次 Ctrl+K 确认停止 ${n} 个后台任务\n`)
      } else {
        // N=0：仅提示，不进入确认窗（防"取消 0 个"的语义怪态）
        notify('没有正在运行的后台任务\n')
      }
    }
  }
})

// AskChannel 常驻唯一提问入口（与 ApprovalChannel 常驻总线对齐；呈现面订阅见下方 ASK_REQUESTED 与 tuiShell）
ctx.builtInExecutor.setUserInputProvider(getAskChannel())

// 项目级 hook 信任询问通道（阶段 2）：交互模式注入；必须在下方 startNewSession 补登记前就位——
// SessionStart 派发登记即触发加载时哈希审查。-p 非交互无应答通道不注入（trustApprover 拒绝并警告）
if (!printMode) {
  ctx.hookTrustAsker = askHookTrust
}

const sessionService = new CliSessionService()
// M3：serve 形态的 chatService 引擎退位不注入 scheduler（ctor 零接线不抢注——持钟与
// 定向路由归 serveSessions 装配点）；交互 CLI 缺省不变（注入 + ctor 自动 start）
const chatService = new CliChatService(ctx, rl, sessionService.store, serveMode ? { noScheduler: true } : undefined)
// 进程首个会话补登记 SessionStart(startup) hooks 派发：此前仅 /session new·load 走
// startNewSession/loadSession，启动即得的全新会话不经过二者，SessionStart 永不触发
// （启动时历史/目标等状态本就为空，此处调用语义与 /session new 一致、无副作用差异）
chatService.startNewSession()

// ===== M1（多会话并行规划）：serve 形态的 registry 多会话宿主 =====
// serve 分支经 ServeSessions 多引擎（core SessionRegistry + 注入共享 scheduler 的 serve 工厂）；
// chatService 引擎在 serve 退位闲置（空会话、内存可忽略、scheduler 零接线）。交互 CLI 不构造（单引擎语义不变）。
// M3 定向路由：serveSessions 构造即接管 ctx.scheduler（directed + onFire 路由 + start）——
// serve 是唯一 24/7 长驻壳，手机遥控场景（人不在电脑前）定时任务按时执行由它兜底。
// 构造须在 relayClient 之前（deps 注入点）；活跃引擎惰性铸（对齐上方 startNewSession 语义）。
const serveSessions = serveMode
  ? new ServeSessions({
      ctx,
      sessionStore: sessionService.store,
      loadIfNewer: (id) => sessionService.loadIfNewer(id),
      // M3 定向路由的盘上查询（轻量：存在性=文件探测；最近会话=sessionIndex 元数据）
      sessionExists: (id) => existsSync(join(sessionService.getSessionsDir(), `${id}.json`)),
      latestSessionInDir: (dir) => latestSessionIdInDir(sessionService.getSessionsDir(), dir),
      onFireRouted: (note) => {
        process.stdout.write(`[serve] [sched] ${note}\n`)
      },
      // M2.1：回收时同步清桥 per-session 运行时（链 Map 条目 + 聚合格——防长驻进程无界增长）
      pruneBridgeRuntime: (id) => relayClientRef.current?.pruneSessionRuntime(id),
      onEvicted: (id, reason) => {
        process.stdout.write(`[serve] 闲置回收会话 ${id}（${reason === 'idle' ? '30min 无活动' : '超引擎数软帽 LRU'}；重开会话自动从盘装载）\n`)
      },
      // F-3：轮次停滞告警（心跳滴漏型模型挂死的可见性；只告警不杀——手机打开该会话可 turn.stop）
      onStallAlarm: (id, stalledMinutes) => {
        const msg = `会话 ${id} 的轮次已 ${stalledMinutes} 分钟无任何进展——疑似模型流挂死；手机打开该会话后可停止命令中止（一切状态在盘，中止零丢失）`
        process.stdout.write(`[serve] ⚠ 停滞告警：${msg}\n`)
        writeServeAlarm(`轮次停滞：${msg}`)
      },
    })
  : null
/** relayClient 引用槽（serveSessions 的回收回调需要它；relayClient 构造在下方） */
const relayClientRef: { current: CliRelayClient | null } = { current: null }
/** 活跃引擎统一出口：serve=registry 活跃（惰性铸空会话）；交互=chatService 单引擎 */
const activeEngine = (): ChatEngine =>
  serveSessions ? serveSessions.getActiveEngine() : chatService.getEngine()

// 任务清单落地留痕：最终态全量文本写入引擎历史（synthetic:'todoLanding'；TUI/CLI/-p 模式无关），
// 显示由历史重建派生（单一通道）。每次现取引擎（M1：serve=活跃引擎）
setTodoLandRecorder((text) => activeEngine().appendSyntheticMessage(text, 'todoLanding'))
// 逐条自动保存与首轮自动标题已由 ChatEngine 负责（每轮结束落盘 ~/.chill/sessions/<id>.json）；
// 此处只保留 watch 跟随：/session load 切换、/session new 后首次落盘生成新 id 均经此重挂。
// M1：serve 不做 watch 跟随（无头无展示；非活跃会话的盘上更新由发言前锚定 + 切换时重读收敛）
chatService.onMessagesChanged = () => {
  if (!serveSessions) followWatch(chatService.getSessionId())
}

// ===== relay（M2a）：进程内常驻 RelayClient（租约仲裁 + 传输 + RelayBridge） =====
// getEngine 懒取（chatService 单例 getter，不闭包捕获引擎实例）；配对确认经 rl/TUI 提问
// M6：projects.json 只读实例（catalog 项目字段/悬空归一化数据源；本进程只 list 不写）
const relayProjectPersistence = new ProjectPersistence(ctx.pathProvider)

/** D4：serve（无界面宿主）的配对确认一律拒绝——授权行为必须有人看的壳在场（记日志留痕） */
function serveDenyPairingConfirm(device: string, fingerprint: string): Promise<boolean> {
  process.stdout.write(`[serve] 已拒绝配对请求（${device} / ${fingerprint.slice(0, 16)}…）——无界面宿主不批准配对；请在交互终端（chill）内经 /pair 完成\n`)
  return Promise.resolve(false)
}

/** D13：存在外部写入者（serve/他端壳可能写本会话）——followWatch 的启用条件之一 */
let relaySyncPossible = false

const relayClient = new CliRelayClient({
  userDataPath: ctx.pathProvider.getUserDataPath(),
  ownerId: `cli:${process.pid}`,
  pairingManager: ctx.pairingManager,
  // M1（多会话并行）：serve=registry 活跃引擎（惰性铸）；交互=chatService 单引擎（不变）
  getEngine: () => activeEngine(),
  // M1：serve 形态注入点（enqueue 直寻/registry 版守卫/不装 wireActiveSession——定案 7/3）
  ...(serveSessions
    ? {
        resolveEngine: (sessionId: string | undefined) => serveSessions.resolveEngine(sessionId),
        ensureActiveSessionOverride: (sessionId: string) => serveSessions.ensureActive(sessionId),
        ensureNewSessionOverride: () => serveSessions.ensureNew(),
        wireActiveSessionDisabled: true,
        // F-2：attach 即激活——手机打开哪个会话，停止/plan/model 命令就作用于哪个（控制盲区根治）
        onSessionAttached: (sid) => serveSessions.onPeerAttach(sid),
        // 运行态标志：registry 单源薄包（桥 runningAll + catalog 对账快照）
        getRunningSessionIds: () => serveSessions.runningSessionIds(),
      }
    : {
        // 运行态标志（交互 CLI 单引擎）：isRunning 时 id 必已铸（runTurn ensureSessionId 先行）
        getRunningSessionIds: () => {
          const e = chatService.getEngine()
          const sid = e.getSessionState().sessionId
          return e.getSessionState().isRunning && sid ? [sid] : []
        },
      }),
  // M5：权限模式读/写闭包（真相源=executor；合法值校验在此，非法返 false 不写真相源）
  getPermissionMode: () => ctx.builtInExecutor.getPermissionMode(),
  setPermissionMode: (mode, by) => {
    if (mode !== 'readonly' && mode !== 'boundary' && mode !== 'fullAccess') return false
    ctx.builtInExecutor.setPermissionMode(mode, by === 'phone' ? 'phone' : 'local')
    return true
  },
  askConfirm: serveMode ? serveDenyPairingConfirm : makeAskConfirm(rl),
  // D12 接力闭环（enqueue 锚定，无条件——对所有宿主模式生效）：手机消息入队前先采纳盘上更新
  //（写者无关：TUI/GUI/他端 serve 写过即收）。自包含实现——严禁复用 applyPeerRecord/printSyncLine
  //（定义于 serve 分支之后的线性流，serve 永不执行 → TDZ；且内嵌 readline 显示）。
  // 轮中进行中跳过重载（防在途轮内存换底；该窗口属 R2 已接受的轮次级竞写范围，见实施规划）。
  // M1：serve 形态按目标会话锚定（锚定目标=enqueue 目标）；交互形态锚定当前会话（行为不变）。
  ...(serveSessions
    ? {
        anchorBeforeEnqueue: async (input: { sessionId?: string }) => {
          await serveSessions.anchorTarget(input.sessionId)
        },
      }
    : {
        anchorBeforeEnqueue: async () => {
          const id = chatService.getSessionId()
          if (id === null) return
          if (chatService.getEngine().getSessionState().isRunning) return
          const record = await sessionService.loadIfNewer(id)
          if (record) await chatService.reloadSession(record.id)
        },
      }),
  // M6：会话同步真相源闭包（sessions 目录 / projects.json 只读 / 单会话直读）
  sessionsDir: sessionService.getSessionsDir(),
  listProjects: async () => (await relayProjectPersistence.list()).records ?? [],
  loadSessionRecord: (id) => sessionService.loadRecord(id),
  // 命令面 session.delete/session.rename 执行面（CliSessionService 薄转发 SessionPersistence）
  patchSessionTitle: (id, title) => sessionService.patchTitleRecord(id, title),
  deleteSessionRecord: (id) => sessionService.deleteRecord(id),
  // 宿主级开关执行面（desktop.set/autoswitch.set；单一事实点在 core desktopControl）：store 与 CLI 本地
  // /desktop 同键同源；engine 由命令面执行器从活动引擎现取（serve 多引擎惰性活性）；探测与放行收回经 ctx
  desktopControlPort: {
    store: ctx.keyValueStore,
    desktop: ctx.desktopController,
    sessionAllow: ctx.builtInExecutor,
  },})
// M1：serve 的 active.changed 直推（serveSessions.setActive → 桥；不装 wireActiveSession 的补偿通道）
serveSessions?.onActiveChanged((sid) => relayClient.pushActiveChanged(sid))
relayClientRef.current = relayClient
// M2.1：闲置回收计时器（判定归 core 纯函数；serve 只挂 5min 编排——照 wsKeepalive 先例）
serveSessions?.startEvictionTimer()
// mobile_send_file 工具的发送通道注入（T4）：sessionId 由注入 fn 惰性取当前活跃引擎会话
//（仿 relayEngineWiring enqueue 的 getEngine() 先例）；桥未挂载/未持租约时 relayClient 诚实报错
ctx.builtInExecutor.setRelayFileSender(({ path }) =>
  relayClient.sendFileToMobile(path, { sessionId: activeEngine().getSessionState().sessionId ?? undefined }),
)
// 已配对设备存在时配置完成即自启（租约在他端则静默让位，/relay status 可见）
void ctx.pairingManager.getRelayConfig().then(async (config) => {
  // M2.1（版本切换接续规划）：体验窗不连 relay——凭既有 workcopy 目录探测（sessionService.isPreview）
  // 把候补都免了：验收期手机确定性由旧版本服务，体验窗永不成为手机的服务者（设计不变量 4）
  if (sessionService.isPreview) return
  if (!config) return
  const devices = await ctx.pairingManager.listDevices()
  if (devices.length > 0) {
    // D13：存在外部写入者（serve/他端壳）→ 启用当前会话 watch（此前 flag 未立时空过，此处补挂；
    // 回声过滤使无外部写入时零成本）。然后照常自启 relay。
    // M1：serve 形态不做 watch 跟随（无头无展示；收敛=发言前锚定 + 切换时重读，见装配点注释）
    relaySyncPossible = true
    if (!serveSessions) followWatch(chatService.getSessionId())
    await relayClient.start().catch(() => {})
  }
})

// M1.7（版本切换接续规划）：CLI 旁观窗换版自续——非 serve/非 -p/非体验窗的长驻 CLI 订阅换版令牌；
// 他端发起切换时本窗不发起（localSwitchInitiated=false）→ 先打提示（用户知情），等本轮聊天结束
// （isChatting=false，不抢正在聊天的窗口）→ 新窗先开、旧窗优雅退租退出（与发起窗同款收尾）。
// TUI 安全输出走 presentPrint；进程退出前经 destroyWorkersBeforeExit 退租+销毁 Worker。
if (!serveMode && !printMode && !sessionService.isPreview && projectPaths.projectPath !== null) {
  let bystanderArmed = false
  const bystanderToast = (text: string): void => {
    if (isTuiActive()) {
      if (!presentPrint(text)) process.stderr.write(text + '\n')
    } else {
      process.stdout.write(text + '\n')
    }
  }
  const bystanderSucceed = (): void => {
    if (bystanderArmed) return
    bystanderArmed = true
    const guardianPath = join(projectPaths.parentDir, 'chill-guardian', 'switcher.js')
    if (existsSync(guardianPath)) {
      spawn('node', [guardianPath, '--launch', projectPaths.projectPath!], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      }).unref()
    }
    bystanderToast('\nℹ 本窗口将在 5 秒后自动接替为新版本（新窗口已打开）...')
    setTimeout(() => { void destroyWorkersBeforeExit().finally(() => process.exit(0)) }, 5000)
  }
  watchVersionToken(join(ctx.pathProvider.getUserDataPath(), 'version-switched.json'), (t) => {
    if (localSwitchInitiated || bystanderArmed) return // 本窗即发起窗（订阅器已处理）或已在接替中
    bystanderToast(`\nℹ 新版本已就位（${t.version}），本轮对话结束后本窗口将自动接替为新版本`)
    const trySucceed = (): void => {
      if (bystanderArmed) return
      if (isChatting) {
        setTimeout(trySucceed, 2000)
        return
      }
      bystanderSucceed()
    }
    setTimeout(trySucceed, 1000)
  }, 5000)
}

// ===== 退出清理：后台 Worker 销毁（委派异步化） =====
// process.on('exit') 无法完成 async，各退出口（/exit、rl close、SIGINT、-p）须在 exit 前显式 await；
// 幂等：rl.close() 同步触发的 close 回调与调用方可能各走一次（try/catch 形态照抄 electron before-quit）
let exitWorkersCleaned = false
async function destroyWorkersBeforeExit(): Promise<void> {
  if (exitWorkersCleaned) return
  exitWorkersCleaned = true
  try {
    await relayClient.stop()
  } catch (error) {
    console.error('[cli] 停止 relay 失败:', error)
  }
  try {
    await getForkManager().destroyAllEnvironments()
  } catch (error) {
    console.error('[cli] 清理 Subagent 隔离环境失败:', error)
  }
}

// ===== SessionEnd hooks（阶段 4）：各退出口在 exit 前显式 await（同 destroyWorkersBeforeExit 先例） =====
// core 契约 ChatEngine.endSession()：通知式 hooks、共享 1.5s 超时预算、幂等——不会拖死退出；
// 防御性判存：core 未落位时零行为，壳层不阻塞退出。
// 共享 in-flight Promise（非布尔旗标）：/exit 与 stdin EOF 的 rl close 会并发各走一条退出链，
// 后到链必须等同一次派发落定，否则抢先 process.exit 会截断 hook 执行
let sessionEndPromise: Promise<void> | null = null
function fireSessionEndBeforeExit(): Promise<void> {
  if (!sessionEndPromise) {
    sessionEndPromise = (async () => {
      try {
        // 软退出先中断在途轮：abort 触发引擎封口+落盘（中断轮产出留痕），
        // 有界等待落定（2s 兜底，防落盘卡死退出）；无在途轮时零开销空转
        const runningEngine = chatService.getEngine()
        if (runningEngine.getSessionState().isRunning) {
          runningEngine.abort()
          const deadline = Date.now() + 2000
          while (runningEngine.getSessionState().isRunning && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 50))
          }
        }
        const engine = chatService.getEngine() as unknown as { endSession?: () => Promise<void> }
        if (typeof engine.endSession === 'function') await engine.endSession()
      } catch (error) {
        console.error('[cli] SessionEnd hooks 执行失败:', error)
      }
    })()
  }
  return sessionEndPromise
}

// ===== -p 非交互一次性执行：跳过蒸馏/banner/REPL，对话完成后直接退出 =====
if (printPrompt !== null) {
  // 默认只读，--auto 放开修改：core 侧按此模式拦截/放行工具，CLI 侧另由 setNonInteractive 跳过确认交互
  ctx.builtInExecutor.setNonInteractiveMode(printAuto ? 'auto' : 'readonly')
  chatService.setNonInteractive(true)
  // @文件路径 媒体提及解析（先文件后 agent，与 REPL 同规则）；回显走 stderr 保 stdout 只有助手正文
  const media = await resolveMediaMentions(printPrompt)
  if (media.attached.length > 0) {
    process.stderr.write(`\x1b[2m已附加: ${media.attached.map((p) => p.split(/[\\/]/).pop()).join(', ')}\x1b[0m\n`)
  }
  for (const m of media.missing) {
    process.stderr.write(`\x1b[33m⚠ ${m.path}（${m.reason}，已按文本发送）\x1b[0m\n`)
  }
  // @agent 提及解析（与 REPL 同规则，可用清单 = 模板管理器全量 subagent_type）
  const { explicitAgent } = parseAgentMentions(
    media.text,
    new Set(getTemplateManager().getAllTemplates().map(t => t.subagent_type))
  )
  if (explicitAgent && !printAuto) {
    // readonly 档 task 委派必被拦（拦截语义不变）：明确警告，不让用户静默踩空；走 stderr 保 stdout 只有助手正文
    process.stderr.write('\x1b[33m非交互只读模式将拦截 task 委派,点名 agent 需加 --auto\x1b[0m\n')
  }
  try {
    // 引擎内持久化与标题均随 sendMessage await 完成，无需额外等待
    await chatService.chat(media.text, media.contentParts, explicitAgent)
    // 退出前 SessionEnd hooks + 销毁后台 Worker（-p 首轮后 process.exit，不清理会留孤儿进程）
    await fireSessionEndBeforeExit()
    await destroyWorkersBeforeExit()
    process.exit(0)
  } catch (err: any) {
    process.stderr.write(`\n错误: ${err?.message || err}\n`)
    await fireSessionEndBeforeExit()
    await destroyWorkersBeforeExit()
    process.exit(1)
  }
}

// ===== --serve 无界面常驻宿主（实施规划 D1/D2：与 -p 同位点分流；其后交互段永不执行） =====
// 手机遥控后端：审批/ask 推手机（D5——CLI 侧呈现处理器位于本分支之后，结构性不注册）；
// 本地零交互面；stdout 由启动器重定向落 ~/.chill/serve.log（D6，控制面 serve on 已代办）。
if (serveMode) {
  // D10 前置校验：headless 空转会误导（用户以为在服务）——fail fast + 指引
  const serveRelayConfig = await ctx.pairingManager.getRelayConfig()
  const serveDevices = await ctx.pairingManager.listDevices()
  if (!serveRelayConfig || serveDevices.length === 0) {
    process.stderr.write(
      `✗ serve 未就绪：${!serveRelayConfig ? '中继未配置' : '尚无已配对设备'}。\n` +
      '  请先在交互终端运行 chill，经 /pair 完成配置与配对，再启动 serve（或 chill serve on）。\n'
    )
    process.exit(2)
  }
  // D14 身份锚：pidfile（干净退出删除；硬杀遗留由控制面经 pid 存活探测判陈旧）
  const servePidPath = join(ctx.pathProvider.getUserDataPath(), 'serve.pid')
  writeFileSync(servePidPath, String(process.pid), 'utf8')
  // M3 定向路由（D7 停钟退役）：serve 持钟——serveSessions 构造已接管 ctx.scheduler
  // （directed 模式 + 定向路由 + start），此处不再停钟。chatService 退位引擎已零接线
  // （noScheduler），无 ctor 自动 start 需要拦截。存量任务激活的可观测性见状态行 sched 计数。
  // improvementProposer 在本分支之后，天然跳过。
  // D9：版本号入状态行（换版错位诊断：长驻进程持有构建时 bundle）
  const serveVersion = (() => {
    try {
      return String(JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version)
    } catch {
      return '?'
    }
  })()
  // 事务防线⑤（switcher 断言成功改造配套，2026-10-05 事故根治）：启动即实证实际加载的
  // 版本目录（realpath 穿透 junction——「跑的是哪个版本」从此一行可查，不再靠指针推断）
  const serveRealRoot = (() => {
    try {
      return realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'))
    } catch {
      return null
    }
  })()
  const serveRealRootName = serveRealRoot ? basename(serveRealRoot) : '?'
  /** junction 布局下（root 在 chill-versions 内）root 目录名即当前版本名；非该布局返回 null */
  const serveJunctionVersion = (): string | null => {
    if (!serveRealRoot || !serveRealRoot.includes(`${sep}chill-versions${sep}`)) return null
    return serveRealRootName
  }
  process.stdout.write(`[serve] 实际加载: ${serveRealRoot ?? '?（realpath 解析失败）'}\n`)
  // D3 状态心跳：ref'd 计时器=进程保活；状态行即心跳即日志即控制锚点（PID 供 taskkill、rss 供资源观测 R6）
  const serveStatusLine = () => {
    // M3.9：active 定时任务计数入状态行——存量错位任务被定向路由激活时异常可见（增长即自查 cancel）
    const activeTaskCount = ctx.scheduler
      .list()
      .then((ts) => ts.filter((t) => t.status === 'active').length)
      .catch(() => -1)
    void Promise.all([relayClient.status(), activeTaskCount])
      .then(([st, schedN]) => {
        const rssMb = (process.memoryUsage().rss / 1024 / 1024).toFixed(0)
        const lease = st.running ? 'lease=持有' : st.waiting ? `lease=等待(他端:${st.holder ?? '?'})` : 'lease=空闲'
        // M2.2（多会话并行）：引擎计数入状态行——长驻进程的多会话运行态可观测（活跃 id 前 8 位）
        const c = serveSessions?.counts()
        const enginesText = c ? ` engines=${c.engines}(active=${c.active?.slice(0, 8) ?? '-'},busy=${c.busy})` : ''
        const schedText = typeof schedN === 'number' && schedN >= 0 ? ` sched=${schedN}` : ''
        // M1.9：状态行加时间戳（serve.log 多源写入后时间线可排序；换版错位诊断依赖）；
        // 防线⑤配套：实际加载目录名随行自证（包版本号 0.0.1 无区分度）
        const ts = new Date().toTimeString().slice(0, 8)
        process.stdout.write(`[${ts}] [serve] v${serveVersion} [${serveRealRootName}] pid=${process.pid} ${lease} peer=${st.peerDevice ?? '无'}${enginesText}${schedText} rss=${rssMb}MB（后台宿主，Ctrl+C 退出）\n`)
      })
      .catch(() => { /* 状态行失败不致命 */ })
  }
  // 退出口：与既有交互退出口同构（SessionEnd hooks → Worker 销毁/退租 → exit），退出时删 pidfile
  // M1.6（多会话并行）：serve 形态先 sealAll（逐引擎 abort 封口 + endSession + dispose——
  // registry 内全部会话与 chatService 闲置引擎收口对称）再走既有 Worker 销毁链
  let serveShuttingDown = false
  const serveShutdown = (sig: string) => {
    if (serveShuttingDown) return
    serveShuttingDown = true
    process.stdout.write(`\n[serve] 收到 ${sig}，正在退出…\n`)
    try {
      unlinkSync(servePidPath)
    } catch { /* 已删；硬杀场景由控制面存活探测兜底 */ }
    void (serveSessions ? serveSessions.sealAll() : Promise.resolve())
      .then(() => fireSessionEndBeforeExit())
      .then(() => destroyWorkersBeforeExit())
      .then(() => process.exit(0))
  }
  process.on('SIGINT', () => serveShutdown('SIGINT'))
  process.on('SIGTERM', () => serveShutdown('SIGTERM'))
  // M1.3：换版接续出口——事件路径（手机驱动切换，本进程是发起者，订阅器延迟 5s 告别后调用）
  // 与令牌路径（旁观者，本分支下方 watch）共用。顺序：任务注册检查（M1.5）→ 小助手接管
  // （M1.4：等本 pid 消亡后 /Run 拉新版本）→ 优雅退出口（退租/SessionEnd/销毁 Worker/删 pidfile）。
  const serveVersionSwitchExitImpl = (origin: string): void => {
    if (serveShuttingDown) return
    if (!taskExists()) {
      // M1.5：任务未注册 → 不自退（退了无人拉起）：醒目告警 + 告警文件（chill serve status 呈现）
      // + 维持旧版服务。可见性边界（如实）：此场景发起者是桌面 CLI 用户（人就在桌面），
      // 手机侧无需推送；合成消息通道的 kind 是封闭联合（消息契约只增不改），不为边缘路径扩契约。
      const msg = `[serve] 检测到版本切换（${origin}）但常驻任务未注册——不自退、维持当前版本服务；如需自动换版请运行 chill serve on`
      process.stdout.write(msg + '\n')
      writeServeAlarm('检测到版本切换但 serve 任务未注册，换版未接续（维持旧版本服务）')
      return
    }
    process.stdout.write(`[serve] 检测到版本切换（${origin}）——优雅退出，小助手即将以新版本拉起\n`)
    spawnServeRestartHelper(process.pid)
    serveShutdown('version-switch')
  }
  serveVersionSwitchExit = serveVersionSwitchExitImpl
  // M1.3：旁观感知——换版令牌（fs.watch + 5s 兜底轮询；core 助手按文件名过滤 relay.lock 心跳刷屏，
  // 不得用 60s 心跳周期——桌面发起切换而 serve 持约时，手机旧版停留不能超过秒级）
  // 事务防线⑥（2026-10-05 事故根治）：收到令牌先终审——junction 实际指向必须与令牌版本一致
  // （junction 是权威真相；不一致=切换被切歪，退出重启只会原样加载旧版+白白断服——
  // 改为大声告警不退出，等 junction 修复后下一次令牌/人工重启接续）
  const serveTokenPath = join(ctx.pathProvider.getUserDataPath(), 'version-switched.json')
  watchVersionToken(serveTokenPath, (t) => {
    const junctionVer = serveJunctionVersion()
    if (junctionVer && t.version && junctionVer !== t.version) {
      const msg = `[serve] ⚠ 换版终审不一致：令牌 v${t.version} 但 junction 实际指向 v${junctionVer}——切换疑似未真正达成，不自动重启（重启只会原样加载旧版）；请核查 chill junction 与 chill-versions\\current.json 后重试`
      process.stdout.write(msg + '\n')
      writeServeAlarm(`换版终审不一致：token=v${t.version} junction=v${junctionVer}——未自动换版（等 junction 修复）`)
      return
    }
    serveVersionSwitchExitImpl(`换版令牌 v${t.version}`)
  }, 5000)
  // M1.3（中继投递流控规划）：限流风暴告警——429 背压持续 >2 分钟落 serve-alarm.json
  //（"手机为什么显示离线"的现成答案）；5 分钟无事件复位（告警一次即可，重复落盘无益）。
  // Electron/Web 壳本轮不接（core 事件已供给，按需消费——见规划"明确不做"）。
  {
    let throttleAlarmed = false
    let throttleResetTimer: ReturnType<typeof setTimeout> | null = null
    eventBus.on(EVENTS.RELAY_DELIVERY_THROTTLED, (info: { sustainedMs?: number }) => {
      const sustained = typeof info?.sustainedMs === 'number' ? info.sustainedMs : 0
      if (!throttleAlarmed && sustained >= 120_000) {
        throttleAlarmed = true
        writeServeAlarm(
          `中继投递被限流已持续 ${Math.round(sustained / 1000)}s——手机此刻可能显示桌面离线；` +
          '排查方向：批量同步风暴 / 中继服务器限流配置（boxBytesPerMin）',
        )
      }
      if (throttleResetTimer) clearTimeout(throttleResetTimer)
      throttleResetTimer = setTimeout(() => {
        throttleAlarmed = false
        throttleResetTimer = null
      }, 300_000)
      throttleResetTimer.unref?.()
    })
  }
  serveStatusLine()
  setInterval(serveStatusLine, 60_000)
  // 分支永不返回 → 其后交互段（REPL/审批呈现/banner/向导/rl-close/SIGINT/TUI 入口）天然跳过
  await new Promise<never>(() => {})
}

// 改进提议：仅 managed 布局（可自迭代环境）下启动时认领最新未分析会话，后台发现改进点（静默失败）
if (projectPaths.projectPath !== null) {
  improvementProposer.proposeFromLatestSession().catch(() => {})
}

/** 壳侧回答回灌审批通道：归一化在 core（normalizeApprovalAnswer）；迟到回答（已落定）给明确回音 */
function settleApproval(payload: ApprovalRequestPayload, rawAnswer: string): void {
  const ok = getApprovalChannel().resolve(payload.toolCallId, normalizeApprovalAnswer(payload, rawAnswer))
  if (!ok) process.stdout.write('（该审批已落定，回答未生效）\n')
}

// 权限模式变更留痕（M5：唯一变更通告口——本机 /auto-apply、手机 mode.set、将来 UI 同经此处）
eventBus.on(EVENTS.PERMISSION_MODE_CHANGED, (data: { mode: string; by: string }) => {
  const from = data.by === 'phone' ? '（来自手机）' : ''
  if (data.mode === 'fullAccess') {
    notify(`\n⚠ 直写模式已开启${from}：任意路径直接写入，不再询问（建议仅在信任/隔离环境使用）\n`)
  } else if (data.mode === 'boundary') {
    notify(`\n直写模式已关闭${from}：边界内直接写入，边界外当场请你批准\n`)
  } else {
    notify(`\n权限模式已切换为只读${from}：修改性操作一律拦截\n`)
  }
})

// 通用审批通道（圈外写 + 命令执行共用"事件挂起→回答→继续"）：
// TUI 活跃时由 tuiShell 渠道队列呈现（订阅同一事件，此处不重复呈现）；控制台走可撤回 consoleAsk+watch
// （远端落定自动收摊，僵尸提问构造上不可能残留）。呈现文案与归一化在 core（approvalPresentation）。
eventBus.on(EVENTS.APPROVAL_REQUESTED, (data: ApprovalRequestPayload) => {
  if (isTuiActive()) return
  const questionText = approvalQuestionText(data)

  if (data.kind === 'write') {
    // 圈外写：盒子标题 + 问题全文（含归属/路径/选项）+ diff 预览
    let text = '\n╔══════════════════════════════════════╗\n'
    text += '║  边界外写入需要批准                  ║\n'
    text += '╚══════════════════════════════════════╝\n'
    text += `${questionText}\n`
    if (data.diffPreview) text += `变更预览:\n${data.diffPreview}\n`
    const handle = consoleAsk(rl, `${text}\n请输入: `, { channel: 'approval', id: data.toolCallId })
    void handle.promise.then((answer) => {
      if (answer === SURFACE_RETRACTED) return // 已在别处落定（watch 已打印提示）
      settleApproval(data, answer)
    })
    return
  }

  // kind === 'command'：盒子标题 + 问题全文 + 命令详情（全量）
  const actionTitle = data.sessionGrantable === true ? '桌面操作' : 'PowerShell 命令'
  let text = '\n╔══════════════════════════════════════╗\n'
  text += `║  ${actionTitle}需要确认执行         ║\n`
  text += '╚══════════════════════════════════════╝\n'
  text += `${questionText}\n`
  text += `${data.sessionGrantable === true ? '动作' : '命令'}详情: ${data.command ?? ''}\n`
  if (data.workingDirectory) text += `目录: ${data.workingDirectory}\n`
  const handle = consoleAsk(rl, `${text}\n请输入: `, { channel: 'approval', id: data.toolCallId })
  void handle.promise.then((answer) => {
    if (answer === SURFACE_RETRACTED) return
    settleApproval(data, answer)
  })
})

// 通用提问通道（ask_user/submit_plan/propose_goal 等全类别请示；AskChannel 常驻唯一入口）：
// TUI 活跃时由 tuiShell 渠道队列呈现；控制台走 consoleAsk+watch（格式与旧 readline 回退逐字对齐）
eventBus.on(EVENTS.ASK_REQUESTED, (payload: AskRequestPayload) => {
  if (isTuiActive()) return
  const separator = '═'.repeat(50)
  let text = `\n${separator}\n`
  text += `\x1b[93m? \x1b[0m${payload.question}\n`
  if (payload.options && payload.options.length > 0) {
    payload.options.forEach((opt, i) => {
      text += `  [${i + 1}] ${opt.label} — ${opt.description}\n`
    })
    text += `  [0] 跳过 — 不回答此问题\n`
    if (payload.allowFreeText) {
      text += `  ${payload.hint ?? '也可直接输入回答'}\n`
    }
  }
  text += `${separator}\n请输入: `
  const handle = consoleAsk(rl, text, { channel: 'ask', id: payload.id })
  void handle.promise.then((answer) => {
    if (answer === SURFACE_RETRACTED) return
    const ok = getAskChannel().resolve(payload.id, answer, 'local')
    if (!ok) process.stdout.write('（该提问已落定，回答未生效）\n')
  })
})

/** 等待 TUI 提问通道就位（启动窗口：SessionStart 补登记可能抢在 enterTui 挂载前触发信任询问，
    此时 rl.question 会在 TUI 进入 alt-screen 后挂死——轮询等 TUI 激活；超时按无通道处理） */
function waitForTuiAsk(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const poll = () => {
      if (isTuiActive() && hasAskPresenter()) return resolve(true)
      if (Date.now() - startedAt >= timeoutMs) return resolve(false)
      setTimeout(poll, 100)
    }
    poll()
  })
}

// hook 信任询问并发计数：首跑向导条件门用——启动窗口内询问经 waitForTuiAsk 等 TUI 挂载、
// 向导等用户、TUI 等向导返回，三方互锁；向导让路（key 仍为零 → 下次启动向导仍触发）
let pendingHookTrustAsks = 0
const isHookTrustPending = (): boolean => pendingHookTrustAsks > 0

async function askHookTrust(req: HookTrustApprovalRequest): Promise<boolean> {
  pendingHookTrustAsks++
  try {
    return await doAskHookTrust(req)
  } finally {
    pendingHookTrustAsks--
  }
}

/** 项目级 hook 信任询问（阶段 2）：醒目警示（hook 会以你的凭据执行任意命令）+
    [y]信任并执行 / [n]不信任（跳过）两选；非 y 一律按不信任（安全默认）。
    TUI 经消息区提问（rl 已 pause，不能 rl.question）；CLI 走 rl.question（同审批通道范式） */
async function doAskHookTrust(req: HookTrustApprovalRequest): Promise<boolean> {
  const reasonText = req.reason === 'changed' ? '已变更 hook（命令内容与信任记录不符）' : '新 hook（首次出现）'
  const detail =
    `项目 hooks.json 中出现${reasonText}\n` +
    `来源: ${req.sourcePath}\n` +
    `hook: ${req.handlerId}\n` +
    `事件: ${req.event}\n` +
    `命令: ${req.command}`
  const risk = '风险: hook 会以你的凭据执行任意命令，仅在你信任该项目（仓库/作者）时批准。'
  const question = `${detail}\n\n${risk}\n\n信任此 hook? [y]信任并执行 [n]不信任(跳过)`
  const settle = (answer: string): boolean => {
    const a = answer.trim().toLowerCase()
    const trusted = a === 'y' || a === 'yes'
    notify(trusted
      ? `\n✓ 已信任项目 hook "${req.handlerId}"（信任记录已保存，之后不再询问；命令变更时会重新询问）\n`
      : `\n■ 未信任项目 hook "${req.handlerId}"，已跳过不予执行\n`)
    return trusted
  }
  // 启动窗口（TUI 将进未进）：等 TUI 提问通道就位，避免 rl.question 挂死在 alt-screen 之后
  if (wantTui && !isTuiActive()) {
    const ready = await waitForTuiAsk(30_000)
    if (!ready) {
      notify(`\n[hook] 信任询问通道未就位，已跳过项目 hook "${req.handlerId}"（下次启动会重新询问）\n`)
      return false
    }
  }
  if (isTuiActive() && hasAskPresenter()) {
    const p = presentAsk(question, [
      { label: 'y', description: '信任并执行（记录哈希，之后不再询问）' },
      { label: 'n', description: '不信任（跳过此 hook）' },
    ], false)
    if (p) return p.then(settle)
  }
  process.stdout.write('\n╔══════════════════════════════════════╗\n')
  process.stdout.write('║  ⚠ 项目 hook 需要信任批准            ║\n')
  process.stdout.write('╚══════════════════════════════════════╝\n')
  process.stdout.write(`${detail}\n`)
  process.stdout.write(`\x1b[33m${risk}\x1b[0m\n`)
  return new Promise<boolean>((resolve) => {
    rl.question('\n信任此 hook? [y]信任并执行 [n]不信任(跳过): ', (answer: string) => {
      resolve(settle(answer))
    })
  })
}

let isChatting = false
// 交互式选择期间抑制自动 prompt 显示
let suppressPrompt = false

/** rl.prompt 的统一守卫：TUI 激活（suppressPrompt=true）时不输出提示符，防污染 alt-screen 与捕获缓冲 */
function reprompt(): void {
  if (!suppressPrompt) rl.prompt()
}

// ===== CLI↔UI 会话同步（watch 租赁制 + 发送前锚定） =====
// 仅 /ui 租赁存活期间启用 watch，UI 未开启时与现状一致（无 watch、无通知）；
// preview 模式整体不启用（CliSessionService 的 watch/loadIfNewer 已内部拦截）
let uiLeaseCount = 0
/** 当前被 watch 的会话 id（无 watch 活动时为 null） */
let watchedSessionId: string | null = null
/** 聊天/流式期间 watch 命中的对端变更：置脏暂存，本轮结束后补做（undefined=无积压） */
let peerSyncPending: SessionRecord | null | undefined = undefined

/** readline 安全打印一行：清当前行 → 打印 → 重绘提示符（保留已输入内容），防花屏 */
function printSyncLine(text: string, redrawPrompt = true): void {
  readline.cursorTo(process.stdout, 0)
  readline.clearLine(process.stdout, 0)
  process.stdout.write(text + '\n')
  if (redrawPrompt && !suppressPrompt) rl.prompt(true)
}

/** 采纳对端 record：经引擎重载会话（磁盘已是真相）并提示增量；record 为 null 表示文件被对端删除 */
async function applyPeerRecord(record: SessionRecord | null, redrawPrompt = true): Promise<void> {
  // D13 前置：TUI 活跃时 toast 走消息区（printSyncLine 的 readline 重绘会污染 alt-screen——
  // serve/他端写入的实时镜像在 TUI 是常态场景，须 TUI 安全）
  const toast = (text: string): void => {
    if (isTuiActive()) {
      if (!presentPrint(text)) process.stderr.write(text)
    } else {
      printSyncLine(text, redrawPrompt)
    }
  }
  if (record === null) {
    // 对端删除了当前会话文件：提示一句，不崩溃、不重建空记录
    toast('（提示：当前会话的记录已被对端删除）')
    return
  }
  // M1.1（版本切换接续规划）：引擎运行中的重载必然撞 loadSession「生成进行中，请先 abort()」守卫——
  // serve 模式手机轮次不经 REPL，isChatting 恒 false，2026-09-30 该路径曾把整个 serve 进程打死。
  // 运行中一律置脏延后（交互态由轮末 flushPeerSync 收敛；serve 态由 D12 逐轮锚定收敛），
  // reloadSession 再包 try-catch 兜底竞态窗口（不致死进程，降级为日志）。
  if (chatService.getEngine().getSessionState().isRunning) {
    peerSyncPending = record
    return
  }
  const newCount = Math.max(0, record.messages.length - chatService.getMessages().length)
  try {
    await chatService.reloadSession(record.id)
  } catch (err) {
    toast(`（会话重载失败已跳过：${err instanceof Error ? err.message : String(err)}）`)
    return
  }
  toast(`（已同步对端 ${newCount} 条新消息）`)
}

/** watch 命中处理：非聊天中立即采纳；聊天/流式中置脏，本轮结束后由 flushPeerSync 补做 */
function handlePeerRecord(record: SessionRecord | null): void {
  if (isChatting) {
    peerSyncPending = record
    return
  }
  void applyPeerRecord(record)
}

/** 补做聊天期间积压的对端同步（只保留最后一次变更） */
async function flushPeerSync(): Promise<void> {
  if (peerSyncPending === undefined) return
  const record = peerSyncPending
  peerSyncPending = undefined
  await applyPeerRecord(record)
}

/** 让 watch 跟随当前会话 id：外部写入者存在时启用；id 变化时重挂，id 为 null 时停 watch */
function followWatch(id: string | null): void {
  // D13：启用条件放宽为"存在外部写入者"——UI 租赁（/ui 拉起的 electron 存活）∥ relay 可用
  //（serve/他端壳持约时其写入须实时镜像到本端屏幕；回声过滤使无外部写入时零成本）
  if ((uiLeaseCount === 0 && !relaySyncPossible) || sessionService.isPreview) return
  if (id === watchedSessionId) return
  sessionService.unwatch()
  watchedSessionId = id
  if (id !== null) sessionService.watch(id, handlePeerRecord)
}

/** 发送前锚定：磁盘记录比本端新（对端写入）则先采纳，保证发送的上下文是会话当前真相；无更新则直接继续 */
async function anchorFromDisk(): Promise<void> {
  await flushPeerSync()
  const id = chatService.getSessionId()
  if (id === null) return
  const record = await sessionService.loadIfNewer(id)
  if (record) await applyPeerRecord(record, false)
}

function promptForMode(): string {
  if (chatService.mode === 'mcp') return 'mcp> '
  if (chatService.mode === 'workflow') return 'workflow> '
  if (chatService.isGoalMode()) return 'goal> '
  if (chatService.planMode) return 'plan> '
  return '> '
}

function showHelp(): void {
  process.stdout.write('\n命令列表:\n')
  process.stdout.write('  /help      显示帮助\n')
  process.stdout.write('  chill web    启动 Web UI（自动打开浏览器；--no-open 可禁用，与桌面 UI 同一份代码）\n')
  process.stdout.write('  /skill     安装/卸载/更新/导出 Skill，或查看/启用/禁用\n')
  process.stdout.write('  /desktop   桌面能力开关（截屏 + 键鼠操作；/desktop on 开启，建议搭配视觉模型）\n')
  process.stdout.write('  /tools     工具渐进发现开关与状态（/tools mode on|off 开关；/tools status 查看分布）\n')
  process.stdout.write('  /mcp       进入 MCP 管理模式\n')
  process.stdout.write('  /workflow  进入 Workflow 管理模式\n')
  process.stdout.write('  /key       管理 API Key（set/list/delete）\n')
  process.stdout.write('  /setup     重新打开首次配置向导（选模型 + 粘贴 API Key）\n')
  process.stdout.write('  /model     管理模型选择（list/switch/evaluator）\n')
  process.stdout.write('  /front     查看/选择会话前台（裸模型或本地 Agent，/front off 恢复裸模型）\n')
  process.stdout.write('  /auto-apply on/off  直写模式：on=任意路径直接写不问；off=边界内直接写、边界外当场批准（默认）\n')
  process.stdout.write('  /add-dir <路径>  把目录加入本次会话可写范围（无参列出当前边界）\n')
  process.stdout.write('  /auto-switch on/off 开启/关闭自迭代后自动版本切换（默认关闭）\n')
  process.stdout.write('  /switch-version  切换到自迭代后的新版本\n')
  process.stdout.write('  /discard-version 放弃自迭代后的新版本\n')
  process.stdout.write('  /rollback  交互式选择版本回滚；/r <版本> 直接回滚到指定版本\n')
  process.stdout.write('  /improve   改进提案簇级决策（TUI 单键面板；y C26 整簇确认；review=深度审查）\n')
  process.stdout.write('  /idea <一句话>  记闪念点子入改进提案「闪念」簇（流式输出中也可用；手机端经 💡/＋ 菜单同源）\n')
  process.stdout.write('  /delete-version <版本>  删除指定历史版本（当前版本与默认回滚目标不可删）\n')
  process.stdout.write('  /plan      进入/退出规划模式（只读讨论规划，模型提交规划并经你批准后才执行）\n')
  process.stdout.write('  /goal <目标与判据>  进入目标模式（每轮结束自动评估，未达成自动续跑；pause/resume/status/clear 管理）\n')
  process.stdout.write('  /pair      手机配对（出二维码；list 查看设备、revoke <设备> 注销、config 配置中继）\n')
  process.stdout.write('  /relay     中继手动控制（start/stop/status；经租约仲裁，谁在线谁跑）\n')
  process.stdout.write('  /send <路径>  发送文件到手机（端到端加密；手机端点接收才落盘，48 小时内有效）\n')
  process.stdout.write('  /compact [引导语]  压缩历史上下文（原对话全保留；TUI 标记条处 Ctrl+O 查看总结）\n')
  process.stdout.write('  /tasks     列出后台任务（运行中任务带序号；/tasks cancel <序号|taskId> 停单个，Ctrl+K 双击停全部）\n')
  process.stdout.write('  /fetch-source  下载 chill 源码到 ~/.chill/workspace/ 并开启自迭代\n')
  process.stdout.write('  /use-npm   切换回 npm 包版本（/use-self 切回自迭代版本）\n')
  process.stdout.write('  /use-self  切换到自迭代源码版本\n')
  process.stdout.write('  /config    查看和设置模型参数（show/set/unset）\n')
  process.stdout.write('  /limits    委派资源限额（并发/累计；set/unset 调整）\n')
  process.stdout.write('  /team      团队观测（花名册/看板/账本/快照）；/team policy 直达改授权\n')
  process.stdout.write('  /restore [filePath] 恢复备份：带路径=文件级版本选择（含旧散落备份兼容）；无参=按对话轮次整批回滚\n')
  process.stdout.write('  /session   会话管理（list/new/rename/load/delete，对话逐条自动保存）\n')
  process.stdout.write('  /memory    长期记忆管理（list/show/delete，对话中说"记住……"可让模型保存）\n')
  process.stdout.write('  /hooks     生命周期钩子管理（list/enable/disable/log；/hooks add <描述> 自然语言创建）\n')
  process.stdout.write('  /schedule  定时任务管理（list/cancel；创建直接对话说明，如"每天早上 9 点汇总 git 进展"）\n')
  process.stdout.write('  /init      生成项目 AGENTS.md 约束初稿\n')
  process.stdout.write('  /ui        启动 UI 模式（Electron）\n')
  process.stdout.write('  /tui       切换到 TUI 显示（默认入口；/cli 退回）\n')
  process.stdout.write('  /cli       切换到 CLI 显示（当前模式）\n')
  process.stdout.write('  /exit      退出\n')
  process.stdout.write('  直接输入    发送到当前模式\n')
  process.stdout.write('  @<文件路径> 发送图片或视频（如 @./photo.jpg @./video.mp4；路径含空格用 @"路径"）\n')
  process.stdout.write('  @<agent名>  点名委派任务（如 @code-reviewer 审查改动）\n')
  // 小贴士：从提示库中随机显示一条（原启动画面轮转，迁至此处保持启动画面极简）
  process.stdout.write(`  💡 小贴士: ${STARTUP_TIPS[Math.floor(Math.random() * STARTUP_TIPS.length)]}\n\n`)
}

/** /tasks：列出后台委派任务注册表（运行中与近期完成的：状态/类型/描述/耗时） */
function handleTasks(): void {
  const tasks = getTaskRegistry().list()
  if (tasks.length === 0) {
    process.stdout.write('\n暂无后台任务（委派任务默认后台执行，此处列出运行中与近期完成的）\n\n')
    return
  }
  const statusLabel: Record<string, string> = {
    running: '运行中',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
  }
  // 耗时：已落地用 startedAt→settledAt，运行中用 startedAt→现在
  const fmtDuration = (t: { startedAt: number; settledAt?: number }): string =>
    `${(((t.settledAt ?? Date.now()) - t.startedAt) / 1000).toFixed(1)}s`
  // 运行中在前；已落地按落地时间倒序（近期完成的靠前）
  const sorted = [...tasks].sort((a, b) => {
    if (a.status === 'running' && b.status !== 'running') return -1
    if (a.status !== 'running' && b.status === 'running') return 1
    return (b.settledAt ?? b.startedAt) - (a.settledAt ?? a.startedAt)
  })
  process.stdout.write(`\n后台任务（${sorted.length} 个）:\n`)
  // 仅 running 行编号（已落地任务不可取消，编号即 /tasks cancel 的有效目标集）
  let runningIndex = 0
  for (const t of sorted) {
    const seq = t.status === 'running' ? `${++runningIndex}. ` : '   '
    process.stdout.write(`  ${seq}[${statusLabel[t.status] ?? t.status}] ${t.subagentType}: ${t.description}（${t.taskId}，耗时 ${fmtDuration(t)}）\n`)
  }
  // 手势提示（可发现性：用户看后台任务的自然入口就是本清单）
  if (runningIndex > 0) {
    process.stdout.write('停止: /tasks cancel <序号|taskId> 停单个；Ctrl+K 双击 停全部\n')
  }
  process.stdout.write('\n')
}

/** /tasks cancel <序号|taskId>：外科单停（寻址以调用时刻的 running 列表为准） */
async function handleTasksCancel(query: string): Promise<void> {
  const running = getTaskRegistry().listRunning()
  const resolved = resolveTaskCancelTarget(
    running.map((t) => ({ toolCallId: t.toolCallId, taskId: t.taskId, subagentType: t.subagentType, description: t.description })),
    query
  )
  if (!resolved.ok) {
    process.stdout.write(`\n${resolved.error}\n\n`)
    return
  }
  const result = await executeCancelTask({ toolCallId: resolved.toolCallId })
  process.stdout.write(`\n${result.success ? result.content : result.error}\n\n`)
}

async function handleSkillList(): Promise<void> {
  const skills = getSkillRegistry().getAll()
  if (skills.length === 0) {
    process.stdout.write('\n暂无已加载的技能\n')
    process.stdout.write('技能存放位置:\n')
    process.stdout.write('  个人级: ~/.chill/skills/<技能名>/SKILL.md\n')
    process.stdout.write('  项目级: <项目目录>/.agents/skills/<技能名>/SKILL.md\n\n')
    return
  }
  process.stdout.write(`\n已加载 ${skills.length} 个技能:\n\n`)
  for (const s of skills) {
    const disabled = getSkillRegistry().isEnabled(s.name) ? '' : ' (已禁用)'
    process.stdout.write(`  ${s.name}${disabled}\n`)
    process.stdout.write(`    描述: ${s.description}\n`)
    process.stdout.write(`    路径: ${s.sourcePath}\n`)
    if (s.availableDirs && s.availableDirs.length > 0) {
      process.stdout.write(`    资源: ${s.availableDirs.join(', ')}\n`)
    }
    const meta = await readInstallMeta(s.basePath, ctx.fsProvider)
    if (meta) {
      const date = meta.installedAt ? meta.installedAt.slice(0, 10) : ''
      process.stdout.write(`    安装来源: ${meta.sourceType === 'git' ? 'git' : 'local'} (${meta.sourcePath})${date ? ' · ' + date : ''}\n`)
    } else {
      process.stdout.write(`    安装来源: 本地\n`)
    }
    process.stdout.write(`\n`)
  }
}

function handleSkillEnable(input: string): void {
  const name = input.replace('/skill enable ', '').trim()
  if (!name) {
    process.stdout.write('用法: /skill enable <name>\n')
    return
  }
  getSkillRegistry().enable(name)
  process.stdout.write(`已启用 ${name}\n`)
}

function handleSkillDisable(input: string): void {
  const name = input.replace('/skill disable ', '').trim()
  if (!name) {
    process.stdout.write('用法: /skill disable <name>\n')
    return
  }
  getSkillRegistry().disable(name)
  process.stdout.write(`已禁用 ${name}\n`)
}

async function handleSkillReload(): Promise<void> {
  if (!ctx.skillLoader) {
    process.stdout.write('SkillLoader 未初始化\n')
    return
  }
  const { skills, errors } = await reloadSkillRegistry(ctx.skillLoader, { filterSelfIterate: ctx.isNpmMode })
  process.stdout.write(`已重载 ${skills.length} 个技能\n`)
  for (const err of errors) {
    process.stdout.write(`  [警告] ${err}\n`)
  }
}

/** 递归复制目录，返回复制的文件数 */
async function copyDirectoryRecursive(sourceDir: string, destDir: string): Promise<number> {
  let count = 0
  const listResult = await ctx.fsProvider.listDirectory(sourceDir)
  if (!listResult?.success || !listResult?.data?.files) {
    return count
  }

  for (const entry of listResult.data.files) {
    const srcPath = join(sourceDir, entry.name)
    const destPath = join(destDir, entry.name)

    if (entry.type === 'directory') {
      count += await copyDirectoryRecursive(srcPath, destPath)
    } else {
      const readResult = await ctx.fsProvider.readFile(srcPath)
      if (readResult?.success && readResult?.data?.content !== undefined) {
        await ctx.fsProvider.writeFile(destPath, readResult.data.content)
        count++
      }
    }
  }

  return count
}

/** 判断是否为 Git URL */
function isGitUrl(str: string): boolean {
  return /^(github:|gitlab:|https?:\/\/|git@)|\.git$/i.test(str)
}

/** 从 SKILL.md 内容中提取 frontmatter 的 name 字段 */
function extractSkillNameFromContent(content: string): string | null {
  const trimmed = content.trim()
  if (!trimmed.startsWith('---')) return null

  const endIdx = trimmed.indexOf('---', 3)
  if (endIdx === -1) return null

  const frontmatter = trimmed.slice(3, endIdx)
  const match = frontmatter.match(/^name:\s*(.+)$/m)
  return match ? match[1].trim() : null
}

/** 判断是否为压缩包文件（本地或 URL） */
function isArchiveFile(str: string): boolean {
  return /\.(zip|tar\.gz|tgz|tar)$/i.test(str)
}

function showSkillHelp(): void {
  process.stdout.write('\n/skill 命令:\n')
  process.stdout.write('  /skill list  列出已加载的技能（含启用/禁用状态）\n')
  process.stdout.write('  /skill enable <名称>  启用指定技能\n')
  process.stdout.write('  /skill disable <名称>  禁用指定技能\n')
  process.stdout.write('  /skill reload  重新扫描并重载技能\n')
  process.stdout.write('  /skill install <路径>  从本地目录、压缩包或链接安装 skill\n')
  process.stdout.write('                          --path <子目录>  指定 Git 仓库中的子目录\n')
  process.stdout.write('  /skill uninstall <名称>  卸载已安装的外部 skill\n')
  process.stdout.write('  /skill update <名称>  更新已安装的外部 skill\n')
  process.stdout.write('  /skill export <名称> [路径]  导出 skill 为压缩包\n')
}

async function handleSkillInstall(input: string): Promise<void> {
  const parts = input.trim().split(/\s+/)
  if (parts.length < 3 || parts[1] !== 'install') {
    process.stdout.write('用法: /skill install <本地路径 | .zip | .tar.gz>\n')
    process.stdout.write('      /skill install <压缩包下载链接>\n')
    process.stdout.write('      /skill install <Git URL> [--path <子目录>]\n')
    return
  }

  // 解析 --path <子目录>
  let subPath: string | undefined
  const pathIndex = parts.indexOf('--path')
  if (pathIndex !== -1 && pathIndex + 1 < parts.length) {
    subPath = parts[pathIndex + 1]
    parts.splice(pathIndex, 2)
  }

  const source = parts.slice(2).join(' ')

  // 压缩包安装（本地或 URL）
  if (isArchiveFile(source)) {
    let installTmpDir: string | null = null
    try {
      installTmpDir = mkdtempSync(join(tmpdir(), 'skill-install-'))

      let archivePath = source
      if (/^https?:\/\//i.test(source)) {
        const extMatch = source.match(/\.(zip|tar\.gz|tgz|tar)(\?.*)?$/i)
        const ext = extMatch ? `.${extMatch[1]}` : '.zip'
        const tmpFile = join(installTmpDir, `archive${ext}`)
        await downloadFile(source, tmpFile)
        archivePath = tmpFile
      }

      const skillSourceDir = await decompressArchive(archivePath, installTmpDir)

      const contentResult = await ctx.fsProvider.readFile(join(skillSourceDir, 'SKILL.md'))
      if (!contentResult?.success || !contentResult?.data?.content) {
        process.stdout.write('错误: 压缩包中未找到 SKILL.md\n')
        return
      }

      const skillName = extractSkillNameFromContent(contentResult.data.content)
      if (!skillName) {
        process.stdout.write('错误: SKILL.md 中未找到有效的 name 字段\n')
        return
      }

      const destDir = join(ctx.pathProvider.getUserDataPath(), 'skills', skillName)
      const conflictResult = await ctx.fsProvider.fileExists(destDir)
      if (conflictResult?.success && conflictResult?.data === true) {
        process.stdout.write(`技能 "${skillName}" 已存在，请先卸载或删除后再安装\n`)
        return
      }

      const copyCount = await copyDirectoryRecursive(skillSourceDir, destDir)

      await writeInstallMeta(destDir, {
        sourceType: 'archive',
        sourcePath: source,
        installedAt: new Date().toISOString(),
      }, ctx.fsProvider)

      if (!ctx.skillLoader) {
        process.stdout.write('SkillLoader 未初始化\n')
        return
      }
      const { errors } = await reloadSkillRegistry(ctx.skillLoader, { filterSelfIterate: ctx.isNpmMode })

      process.stdout.write(`✓ "${skillName}" 安装成功 (来源: ${source}, ${copyCount} 个文件)\n`)
      for (const err of errors) {
        process.stdout.write(`  [警告] ${err}\n`)
      }
    } catch (err: any) {
      process.stdout.write(`错误: ${err?.message || err}\n`)
    } finally {
      if (installTmpDir) {
        try { await ctx.fsProvider.deleteFile(installTmpDir) } catch { /* ignore */ }
      }
    }
    return
  }

  // HTTP URL 下载安装（非压缩包后缀、非 Git 的 URL）
  if (/^https?:\/\//i.test(source) && !source.endsWith('.git')) {
    let downloadTmpDir: string | null = null
    try {
      downloadTmpDir = mkdtempSync(join(tmpdir(), 'skill-download-'))
      const tmpFile = join(downloadTmpDir, 'download')

      await downloadFile(source, tmpFile)

      let skillSourceDir: string
      try {
        skillSourceDir = await decompressArchive(tmpFile, downloadTmpDir)
      } catch {
        process.stdout.write('错误: 下载的文件不是有效的压缩包\n')
        return
      }

      const contentResult = await ctx.fsProvider.readFile(join(skillSourceDir, 'SKILL.md'))
      if (!contentResult?.success || !contentResult?.data?.content) {
        process.stdout.write('错误: 解压后的目录中未找到 SKILL.md\n')
        return
      }

      const skillName = extractSkillNameFromContent(contentResult.data.content)
      if (!skillName) {
        process.stdout.write('错误: SKILL.md 中未找到有效的 name 字段\n')
        return
      }

      const destDir = join(ctx.pathProvider.getUserDataPath(), 'skills', skillName)
      const conflictResult = await ctx.fsProvider.fileExists(destDir)
      if (conflictResult?.success && conflictResult?.data === true) {
        process.stdout.write(`技能 "${skillName}" 已存在，请先卸载或删除后再安装\n`)
        return
      }

      const copyCount = await copyDirectoryRecursive(skillSourceDir, destDir)

      await writeInstallMeta(destDir, {
        sourceType: 'archive',
        sourcePath: source,
        installedAt: new Date().toISOString(),
      }, ctx.fsProvider)

      if (!ctx.skillLoader) {
        process.stdout.write('SkillLoader 未初始化\n')
        return
      }
      const { errors } = await reloadSkillRegistry(ctx.skillLoader, { filterSelfIterate: ctx.isNpmMode })

      process.stdout.write(`✓ "${skillName}" 安装成功 (来源: ${source}, ${copyCount} 个文件)\n`)
      for (const err of errors) {
        process.stdout.write(`  [警告] ${err}\n`)
      }
    } catch (err: any) {
      process.stdout.write(`错误: ${err?.message || err}\n`)
    } finally {
      if (downloadTmpDir) {
        try { await ctx.fsProvider.deleteFile(downloadTmpDir) } catch { /* ignore */ }
      }
    }
    return
  }

  // Git URL 安装
  if (isGitUrl(source)) {
    let tmpDir: string | null = null
    try {
      // 1. git clone 到临时目录
      tmpDir = await gitClone(source, { subPath })

      // 2. 读取 SKILL.md 并提取 name
      const skillSourceDir = subPath ? join(tmpDir, subPath) : tmpDir
      const contentResult = await ctx.fsProvider.readFile(join(skillSourceDir, 'SKILL.md'))
      if (!contentResult?.success || !contentResult?.data?.content) {
        process.stdout.write('错误: 无法读取 SKILL.md\n')
        return
      }

      const skillName = extractSkillNameFromContent(contentResult.data.content)
      if (!skillName) {
        process.stdout.write('错误: SKILL.md 中未找到有效的 name 字段\n')
        return
      }

      // 3. 检测目标路径同名冲突
      const destDir = join(ctx.pathProvider.getUserDataPath(), 'skills', skillName)
      const conflictResult = await ctx.fsProvider.fileExists(destDir)
      if (conflictResult?.success && conflictResult?.data === true) {
        process.stdout.write(`技能 "${skillName}" 已存在，请先卸载或删除后再安装\n`)
        return
      }

      // 4. 逐文件复制
      const copyCount = await copyDirectoryRecursive(skillSourceDir, destDir)

      // 5. 写入 .install-meta.json
      await writeInstallMeta(destDir, {
        sourceType: 'git',
        sourcePath: source,
        installedAt: new Date().toISOString(),
        subPath,
      }, ctx.fsProvider)

      // 6. 重载 Registry
      if (!ctx.skillLoader) {
        process.stdout.write('SkillLoader 未初始化\n')
        return
      }
      const { errors } = await reloadSkillRegistry(ctx.skillLoader, { filterSelfIterate: ctx.isNpmMode })

      process.stdout.write(`✓ "${skillName}" 安装成功 (来源: ${source}, ${copyCount} 个文件)\n`)
      for (const err of errors) {
        process.stdout.write(`  [警告] ${err}\n`)
      }
    } catch (err: any) {
      process.stdout.write(`错误: ${err?.message || err}\n`)
    } finally {
      // 清理临时目录
      if (tmpDir) {
        try { await ctx.fsProvider.deleteFile(tmpDir) } catch { /* 忽略清理错误 */ }
      }
    }
    return
  }

  // 本地目录安装
  const sourcePath = resolve(source)

  // 1. 检查源 SKILL.md 是否存在
  const skillMdPath = join(sourcePath, 'SKILL.md')
  const existsResult = await ctx.fsProvider.fileExists(skillMdPath)
  if (!existsResult?.success || existsResult?.data !== true) {
    process.stdout.write(`错误: ${resolve(sourcePath)} 中未找到 SKILL.md\n`)
    return
  }

  // 2. 读取并校验 SKILL.md
  const readResult = await ctx.fsProvider.readFile(skillMdPath)
  if (!readResult?.success || !readResult?.data?.content) {
    process.stdout.write(`错误: 无法读取 ${skillMdPath}\n`)
    return
  }

  const parseResult = parseSkillMd(readResult.data.content, resolve(skillMdPath))
  if (!parseResult.success || !parseResult.skill) {
    process.stdout.write(`错误: SKILL.md 校验失败 - ${parseResult.error}\n`)
    return
  }

  const skillName = parseResult.skill.name

  // 3. 检测目标路径同名冲突
  const destDir = join(ctx.pathProvider.getUserDataPath(), 'skills', skillName)
  const conflictResult = await ctx.fsProvider.fileExists(destDir)
  if (conflictResult?.success && conflictResult?.data === true) {
    process.stdout.write(`技能 "${skillName}" 已存在，请先卸载或删除后再安装\n`)
    return
  }

  // 4. 逐文件复制
  const copyCount = await copyDirectoryRecursive(sourcePath, destDir)

  // 5. 写入 .install-meta.json
  await writeInstallMeta(destDir, {
    sourceType: 'local',
    sourcePath: resolve(sourcePath),
    installedAt: new Date().toISOString(),
  }, ctx.fsProvider)

  // 6. 重载 Registry
  if (!ctx.skillLoader) {
    process.stdout.write('SkillLoader 未初始化\n')
    return
  }
  const { errors } = await reloadSkillRegistry(ctx.skillLoader, { filterSelfIterate: ctx.isNpmMode })

  process.stdout.write(`✓ "${skillName}" 安装成功 (${copyCount} 个文件)\n`)
  for (const err of errors) {
    process.stdout.write(`  [警告] ${err}\n`)
  }
}

async function handleSkillUninstall(input: string): Promise<void> {
  const parts = input.trim().split(/\s+/)
  if (parts.length < 3) {
    process.stdout.write('用法: /skill uninstall <技能名>\n')
    return
  }
  const skillName = parts.slice(2).join(' ')

  const result = await ctx.skillInstaller.uninstallSkill(skillName)
  if (result.success) {
    process.stdout.write(`✓ "${skillName}" 已卸载\n`)
  } else {
    process.stdout.write(`错误: ${result.error}\n`)
  }
}

async function handleSkillUpdate(input: string): Promise<void> {
  const parts = input.trim().split(/\s+/)
  if (parts.length < 3) {
    process.stdout.write('用法: /skill update <技能名>\n')
    return
  }
  const skillName = parts.slice(2).join(' ')

  process.stdout.write(`正在更新 "${skillName}"...\n`)
  const result = await ctx.skillInstaller.updateSkill(skillName)
  if (result.success) {
    process.stdout.write(`✓ "${skillName}" 已更新\n`)
  } else {
    process.stdout.write(`错误: ${result.error}\n`)
  }
}

async function handleSkillExport(input: string): Promise<void> {
  const parts = input.trim().split(/\s+/)
  if (parts.length < 3) {
    process.stdout.write('用法: /skill export <技能名> [输出路径]\n')
    return
  }
  const remaining = parts.slice(2)
  const skillName = remaining[0]
  const outputPath = remaining[1] || join(process.cwd(), `${skillName}.zip`)

  process.stdout.write(`正在导出 "${skillName}"...\n`)
  const result = await ctx.skillInstaller.exportSkill(skillName, outputPath)
  if (result.success) {
    process.stdout.write(`✓ 已导出到 ${outputPath}\n`)
  } else {
    process.stdout.write(`错误: ${result.error}\n`)
  }
}

function setPrompt(text: string): void {
  rl.setPrompt(text)
}

/**
 * REPL 启动(恢复读取 + 显示提示符):--cli 默认启动与 TUI /cli 回程共用。
 * rl.on('line') 注册在顶层只执行一次(所有流程在进入 TUI 前均已 armed),此处只管 resume 与 prompt。
 */
function startRepl(): void {
  rl.resume()
  setPrompt(promptForMode())
  reprompt()
}

/** /tui:REPL 内进入 TUI 显示(replStarted=true——REPL 循环已注册,/cli 退回时 rl.resume() 即可) */
async function handleTuiEnter(): Promise<void> {
  if (!process.stdout.isTTY) {
    process.stdout.write('当前终端不支持 TUI 显示，继续使用 CLI 显示。\n')
    return
  }
  suppressPrompt = true
  try {
    const { enterTui } = await import('./tui/tuiShell.js')
    await enterTui(chatService, { rl, startRepl, replStarted: true })
  } catch (err: any) {
    process.stdout.write(`\n进入 TUI 失败: ${err?.message || err}，继续使用 CLI 显示。\n`)
  } finally {
    suppressPrompt = false
    setPrompt(promptForMode())
    reprompt()
  }
}

/**
 * /send <路径>：发送文件到已配对手机（端到端加密；校验单点在桥层 sendFileToMobile——
 * denylist/存在性/空文件/≤100MB/caps 门，此处零重复判定）。
 * 路径解析约定：/send 后的整段余参 trim 后即为路径（天然支持空格/中文；引号包裹剥壳；
 * 不做 shell 式分词）。上传进度：控制台 CLI 单行覆写；TUI 激活时只在开始/完成走 notify
 * 消息区（与 receipt 提示同纪律，不裸打印腐蚀渲染）。
 */
async function handleSend(input: string): Promise<void> {
  let p = input === '/send' ? '' : input.slice('/send'.length).trim()
  if (p.length >= 2 && ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'")))) {
    p = p.slice(1, -1)
  }
  if (!p) {
    notify('\n用法：/send <文件路径>（加密发送到我已配对的手机，手机端点接收才落盘）\n')
    return
  }
  const tui = isTuiActive()
  let lastPaint = 0
  const clearProgressLine = (): void => {
    if (!tui && printPrompt === null) process.stdout.write('\r' + ' '.repeat(60) + '\r')
  }
  const onProgress = (sent: number, total: number): void => {
    if (tui || printPrompt !== null) return
    const now = Date.now()
    if (now - lastPaint < 100 && sent < total) return // 节流 100ms
    lastPaint = now
    const pct = Math.floor((sent / total) * 100)
    process.stdout.write(`\r📱 发送中… ${pct}%（${sent}/${total} 字节）`)
  }
  if (tui) notify(`\n📱 正在发送 ${p} …\n`)
  try {
    const { expiresAt } = await relayClient.sendFileToMobile(p, {
      sessionId: chatService.getSessionId() ?? undefined,
      onProgress,
    })
    clearProgressLine()
    notify(`📱 已发出，等待手机接收（48 小时内有效，${new Date(expiresAt).toLocaleString()} 前）\n`)
  } catch (err) {
    clearProgressLine()
    // 桥层诚实文案原样呈现（手机未上线/版本过旧/文件过大/敏感路径/中继未运行等）
    notify(`📱 发送失败：${err instanceof Error ? err.message : String(err)}\n`)
  }
}

async function handleLine(input: string): Promise<void> {
  if (input === '/exit') {
    console.log('再见！')
    // 退出前先触发 SessionEnd hooks、再销毁后台 Worker（rl.close 触发的 close 回调里同函数幂等）
    void fireSessionEndBeforeExit()
      .then(() => destroyWorkersBeforeExit())
      .then(() => {
        rl.close()
        process.exit(0)
      })
    return
  }

  if (input === '/help') {
    showHelp()
    return
  }

  if (input === '/tasks') {
    handleTasks()
    return
  }

  if (input.startsWith('/tasks cancel ') || input === '/tasks cancel') {
    await handleTasksCancel(input.slice('/tasks cancel'.length).trim())
    return
  }

  if (input === '/skill') {
    showSkillHelp()
    return
  }

  if (input.startsWith('/skill export ')) {
    await handleSkillExport(input)
    return
  }

  if (input.startsWith('/skill update ')) {
    await handleSkillUpdate(input)
    return
  }

  if (input.startsWith('/skill uninstall ')) {
    await handleSkillUninstall(input)
    return
  }

  if (input.startsWith('/skill install ')) {
    await handleSkillInstall(input)
    return
  }

  if (input.startsWith('/skill enable ')) {
    handleSkillEnable(input)
    return
  }

  if (input.startsWith('/skill disable ')) {
    handleSkillDisable(input)
    return
  }

  if (input === '/skill list') {
    await handleSkillList()
    return
  }

  if (input === '/skill reload') {
    await handleSkillReload()
    return
  }

  if (input === '/desktop' || input === '/desktop on' || input === '/desktop off' || input === '/desktop log' || input.startsWith('/desktop audit')) {
    await handleDesktop(input)
    return
  }

  if (input === '/tools' || input.startsWith('/tools ')) {
    handleTools(input)
    return
  }

  if (input === '/mcp') {
    chatService.mode = 'mcp'
    process.stdout.write('已切换到 MCP 管理模式。命令: connect, disconnect <id>, list, tools [id]\n')
    process.stdout.write('输入 /back 返回 Auto 模式\n')
    return
  }

  if (input === '/workflow') {
    chatService.mode = 'workflow'
    process.stdout.write('已切换到 Workflow 管理模式。命令: list, run <name> [输入文本]\n')
    process.stdout.write('输入 /back 返回 Auto 模式\n')
    return
  }

  if (input === '/ui') {
    handleUI()
    return
  }

  if (input === '/tui') {
    handleTuiEnter()
    return
  }

  if (input === '/cli') {
    process.stdout.write('当前已是 CLI 显示模式。\n')
    return
  }

  if (input === '/setup') {
    await handleSetup()
    return
  }

  if (input === '/key' || input.startsWith('/key ')) {
    await handleKey(input)
    return
  }

  if (input === '/model' || input.startsWith('/model ')) {
    await handleModel(input)
    return
  }

  if (input.startsWith('/auto-apply')) {
    handleAutoApply(input)
    return
  }

  if (input === '/add-dir' || input.startsWith('/add-dir ')) {
    handleAddDir(input)
    return
  }

  if (input.startsWith('/config')) {
    handleConfig(input)
    return
  }

  if (input === '/limits' || input.startsWith('/limits ')) {
    handleLimits(input)
    return
  }

  if (input === '/team' || input.startsWith('/team ')) {
    await handleTeam(input)
    return
  }

  if (input.startsWith('/restore')) {
    await handleRestore(input)
    return
  }

  if (input === '/session' || input.startsWith('/session ')) {
    await handleSession(input)
    return
  }

  if (input === '/memory' || input.startsWith('/memory ')) {
    await handleMemory(input)
    return
  }

  if (input === '/hooks' || input.startsWith('/hooks ')) {
    await handleHooks(input)
    return
  }

  if (input === '/schedule' || input.startsWith('/schedule ')) {
    await handleSchedule(input)
    return
  }

  if (input === '/init' || input.startsWith('/init ')) {
    await handleInit(input)
    return
  }

  if (input.startsWith('/auto-switch')) {
    handleAutoSwitch(input)
    return
  }

  if (input === '/fetch-source') {
    handleFetchSource()
    return
  }

  if (input === '/plan' || input === '/plan off') {
    handlePlanToggle()
    return
  }

  if (input === '/goal' || input.startsWith('/goal ')) {
    await handleGoal(input)
    return
  }

  if (input === '/pair' || input.startsWith('/pair ')) {
    await handlePair(input, { rl, pairingManager: ctx.pairingManager, relayClient })
    return
  }

  if (input === '/relay' || input.startsWith('/relay ')) {
    await handleRelay(input, { rl, pairingManager: ctx.pairingManager, relayClient })
    return
  }

  if (input === '/send' || input.startsWith('/send ')) {
    await handleSend(input)
    return
  }

  if (input === '/compact' || input.startsWith('/compact ')) {
    await handleCompact(input)
    return
  }

  if (input === '/front' || input.startsWith('/front ')) {
    handleFront(input)
    return
  }

  if (input === '/use-npm' || input === '/use-self') {
    handlePointerSwitch(input)
    return
  }

  if (input === '/rollback' || input === '/r' || input.startsWith('/rollback ') || input.startsWith('/r ')) {
    await handleRollback(input)
    return
  }

  if (input === '/improve' || input.startsWith('/improve ')) {
    await handleImprove(input)
    return
  }

  if (input === '/idea' || input.startsWith('/idea ')) {
    await handleIdea(input)
    return
  }

  if (input === '/delete-version' || input.startsWith('/delete-version ')) {
    handleDeleteVersion(input)
    return
  }

  if (input === '/switch-version' || input === '/discard-version') {
    return
  }

  if (input === '/back' && chatService.mode !== 'auto') {
    mcpService.cancelConnect()
    chatService.mode = 'auto'
    process.stdout.write('已返回 Auto 模式\n')
    return
  }

  if (input === '') {
    return
  }
}

/** /fetch-source：显式确认后下载源码到 ~/.chill/workspace/ 并构建，成功后写指针（失败可重入） */
function handleFetchSource(): void {
  suppressPrompt = true
  const finish = () => {
    suppressPrompt = false
    isChatting = false
    setPrompt(promptForMode())
    reprompt()
  }
  const start = (onExisting: 'continue' | 'redownload') => {
    isChatting = true
    fetchSource({ log: (m) => process.stdout.write(m + '\n'), onExisting })
      .then((result) => process.stdout.write(result.message + '\n'))
      .catch((e: any) => process.stdout.write(`fetch-source 失败：${e?.message ?? e}\n可重新输入 /fetch-source 重试。\n`))
      .finally(finish)
  }

  if (!existsSync(getWorkspaceProjectDir())) {
    // TUI 活跃时经 TUI 消息区提问(rl 已 pause,直接 rl.question 会挂死)
    if (isTuiActive() && hasAskPresenter()) {
      presentAsk('自迭代需要下载源码（约 2MB）并安装构建到 ~/.chill/workspace/，是否开启?', [
        { label: 'n', description: '取消' },
        { label: 'y', description: '开启' },
      ], false)?.then((answer) => {
        const yes = ['y', 'yes'].includes(answer.trim().toLowerCase())
        if (yes) {
          start('redownload')
        } else {
          process.stdout.write('已取消，未做任何更改。\n')
          finish()
        }
      })
      return
    }
    rl.question('自迭代需要下载源码（约 2MB）并安装构建到 ~/.chill/workspace/，是否开启？(y/n) ', (answer) => {
      const yes = ['y', 'yes'].includes(answer.trim().toLowerCase())
      if (yes) {
        start('redownload')
      } else {
        process.stdout.write('已取消，未做任何更改。\n')
        finish()
      }
    })
    return
  }

  // TUI 活跃时经 TUI 消息区提问
  if (isTuiActive() && hasAskPresenter()) {
    presentAsk('检测到源码目录已存在（~/.chill/workspace/chill）。继续构建、重新下载还是取消?', [
      { label: 'n', description: '取消' },
      { label: 'c', description: '继续构建' },
      { label: 'r', description: '重新下载' },
    ], false)?.then((answer) => {
      const a = answer.trim().toLowerCase()
      if (a === 'c') {
        start('continue')
      } else if (a === 'r') {
        start('redownload')
      } else {
        process.stdout.write('已取消，未做任何更改。\n')
        finish()
      }
    })
    return
  }
  rl.question('检测到源码目录已存在（~/.chill/workspace/chill）。输入 C 继续构建，R 重新下载，其他取消: ', (answer) => {
    const a = answer.trim().toLowerCase()
    if (a === 'c') {
      start('continue')
    } else if (a === 'r') {
      start('redownload')
    } else {
      process.stdout.write('已取消，未做任何更改。\n')
      finish()
    }
  })
}

/** /use-npm、/use-self：改写指针的 active 字段，下次启动生效 */
function handlePointerSwitch(input: string): void {
  if (input === '/use-npm') {
    writePointer('npm', readPointer()?.home ?? null)
    process.stdout.write('已切换为 npm 包版本，下次启动 chill 生效（自迭代文件保留，/use-self 可切回）。\n')
    return
  }
  // /use-self：优先用指针记录的 home，其次探测默认 workspace 落点
  const home = readPointer()?.home ?? getWorkspaceProjectDir()
  if (!isSelfVersionUsable(home)) {
    process.stdout.write('没有可用的自迭代版本（源码未安装或未构建）。请先运行 /fetch-source。\n')
    return
  }
  writePointer('self', home)
  process.stdout.write('已切换为自迭代源码版本，下次启动 chill 生效。\n')
}

/** /front：查看/选择当前会话前台（裸模型或本地 Agent 模板；选择随会话持久化，跨端续聊一致） */
function handleFront(input: string): void {
  const parts = input.trim().split(/\s+/)
  const arg = (parts[1] || '').trim()

  const printCurrent = (): void => {
    const current = chatService.getFrontAgent()
    const display = chatService.getFrontAgentDisplay()
    const modelText = display?.model
      ? `（模型: ${display.model}${display.modelSource === 'template' ? '（模板指定）' : ''}）`
      : ''
    process.stdout.write(`当前前台：${current ? `${display?.name ?? current}（${current}）${modelText}` : '裸模型（默认）'}\n`)
  }

  const printCandidates = (): void => {
    const candidates = chatService.getFrontAgentCandidates()
    if (candidates.length === 0) {
      process.stdout.write('暂无可选的前台 Agent（仅本地模板可选；远程模板只能被 task 委派）\n')
      return
    }
    process.stdout.write('可选前台（/front <subagent_type> 切换，/front off 恢复裸模型）:\n')
    for (const c of candidates) {
      const desc = c.description ? ` — ${c.description}` : ''
      process.stdout.write(`  ${c.type}（${c.name}）${desc}\n`)
    }
  }

  if (!arg) {
    printCurrent()
    printCandidates()
    return
  }

  if (arg === 'off') {
    chatService.setFrontAgent(undefined)
    process.stdout.write('已恢复裸模型前台\n')
    return
  }

  const candidates = chatService.getFrontAgentCandidates()
  const matched = candidates.find((c) => c.type === arg)
  if (!matched) {
    process.stdout.write(`不可选为前台: ${arg}（仅本地模板可选；远程模板只能被 task 委派）\n`)
    printCandidates()
    return
  }
  chatService.setFrontAgent(matched.type)
  const display = chatService.getFrontAgentDisplay()
  const modelText = display?.model
    ? `（模型: ${display.model}${display.modelSource === 'template' ? '（模板指定）' : ''}）`
    : ''
  process.stdout.write(`已切换到「${matched.name}」前台直聊${modelText}，其能力自下一轮对话生效；/front off 恢复裸模型\n`)
}

/** /plan：进入或退出规划模式（批准退出走 submit_plan 通道自动触发，不走这里） */
function handlePlanToggle(): void {
  if (!chatService.planMode) {
    chatService.setPlanMode(true)
    process.stdout.write('已进入规划模式：接下来只读讨论规划，修改性操作将被拦截。模型提交规划并经你批准后自动开始执行；再次输入 /plan 可随时手动退出。\n')
  } else {
    chatService.setPlanMode(false)
    process.stdout.write('已手动退出规划模式（未开始执行）。\n')
  }
}

/**
 * /goal <目标与判据文本>：设定目标进入目标模式；/goal pause|resume|status|clear|off 管理。
 * 单行文本同时承载目标与判据（契约引导用户把"怎么算完"写进同一句话）。
 * 已有激活目标时不静默覆盖（幂等提示）。
 */
async function handleGoal(input: string): Promise<void> {
  // -p 非交互模式拒绝进入（对照 plan 模式先例：无人值守下目标循环会自主消耗 token）
  if (printPrompt !== null) {
    process.stderr.write('非交互模式（chill -p）不支持目标模式。\n')
    return
  }
  const arg = input.slice('/goal'.length).trim()
  if (arg === 'clear' || arg === 'off') {
    if (!chatService.isGoalMode()) {
      process.stdout.write('当前不在目标模式。\n')
      return
    }
    chatService.clearGoal()
    return
  }
  if (arg === 'pause') {
    const goal = chatService.getGoalState()
    if (!goal || goal.status !== 'active') {
      process.stdout.write('当前没有可暂停的激活目标。\n')
      return
    }
    chatService.pauseGoal()
    return
  }
  if (arg === 'resume') {
    const goal = chatService.getGoalState()
    if (!goal) {
      process.stdout.write('当前不在目标模式。\n')
      return
    }
    if (goal.status !== 'paused') {
      process.stdout.write('目标正在推进中，无需恢复。\n')
      return
    }
    // 恢复推进与 chat 同一阻塞语义：isChatting 护栏 + await 至循环跑完（输出走常驻打印通道）
    isChatting = true
    try {
      await chatService.resumeGoal()
    } finally {
      isChatting = false
    }
    return
  }
  if (arg === 'status') {
    const goal = chatService.getGoalState()
    if (!goal) {
      process.stdout.write('当前不在目标模式。\n')
      return
    }
    process.stdout.write(`目标：${goal.objective}\n完成判据：${goal.successCriteria}\n状态：${goal.status === 'active' ? '推进中' : '已暂停'}\n已推进 ${goal.roundCount}/${goal.maxRounds} 轮（剩余 ${goal.maxRounds - goal.roundCount} 轮）；连续无进展 ${goal.noProgressCount}/3 次。\n`)
    return
  }
  if (!arg) {
    const goal = chatService.getGoalState()
    if (goal) {
      process.stdout.write(`当前目标：${goal.objective}\n完成判据：${goal.successCriteria}\n已推进 ${goal.roundCount}/${goal.maxRounds} 轮。\n`)
    } else {
      process.stdout.write('用法：/goal <目标与判据文本>（如 /goal 修复登录模块，npm test 退出码为 0 才算完成）；/goal pause|resume|status|clear 管理。\n')
    }
    return
  }
  if (chatService.isGoalMode()) {
    process.stdout.write(`已有进行中的目标：${chatService.getGoalState()?.objective}\n如需更换，请先 /goal clear 再设定新目标。\n`)
    return
  }
  // 首用提示：未配置评估器模型时提示一次（kvStore 记录防重复打扰；评估器默认同会话模型）
  if (
    !ctx.keyValueStore.getItem('defaultEvaluatorModel') &&
    !ctx.keyValueStore.getItem('goal_evaluator_hint_shown')
  ) {
    ctx.keyValueStore.setItem('goal_evaluator_hint_shown', 'true')
    process.stdout.write('提示：目标评估默认使用当前会话模型，可用 /model evaluator <模型名> 配置更便宜的评估器模型。\n')
  }
  chatService.setGoal(arg)
  // 目标即开工指令：设定后立即以目标文本发起首轮（行业惯例：提交任务即执行，无"二次输入"死步骤）。
  // TUI 下不走此路——首轮须经 runTurn 的流式通道，由 tuiShell 的 GOAL_STARTED 监听发起
  if (!isTuiActive()) {
    await chatService.chat(arg)
  }
}

/**
 * /compact [引导语]：压缩历史上下文（追加式 checkpoint——原对话一条不少全保留，
 * 模型侧改看「总结 + 最近 2 轮原文」）。
 * 用量对比口径：压缩前取引擎重置前的 lastUsage 实测值；压缩后尚无实测（要等下一轮 API
 * 调用才产生），按「总结 + 保留尾部」的字符数粗估（与 core 转录预算同口径 2 字符/token）
 * 并标注"约"，不显示伪精确数字。护栏不满足/失败由引擎抛错，消息已含用户可读原因。
 */
async function handleCompact(input: string): Promise<void> {
  const guidance = input.slice('/compact'.length).trim() || undefined
  // 进度走事件而非 stdout：TUI 命令捕获期 stdout 会被缓冲到命令结束才显示，
  // 事件通道可突破捕获实时呈现（tuiShell 注册突破处理器；纯 CLI 由顶层监听器打印）
  eventBus.emit('chill:command-progress', '正在压缩上下文…')
  let result
  try {
    result = await chatService.compactHistory(guidance)
  } catch (err: any) {
    process.stdout.write(`压缩未完成：${err?.message || err}\n`)
    return
  }
  const { checkpoint } = result
  // 统计口径归 core：checkpoint 落盘前已由 compactCore 写入（唯一计算点，壳侧严禁重算——上下文压缩显示约定）；
  // 旧 checkpoint 无字段时回退"无法对比"文案
  const beforeTokens = checkpoint.usageBeforeTokens
  const afterTokens = checkpoint.usageAfterApproxTokens
  const fmtTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n))
  if (beforeTokens && afterTokens) {
    const freed = beforeTokens > 0 ? Math.max(0, Math.round((1 - afterTokens / beforeTokens) * 100)) : 0
    process.stdout.write(`压缩完成：上下文 ${fmtTokens(beforeTokens)} → 约 ${fmtTokens(afterTokens)}（已释放约 ${freed}%）。\n`)
  } else if (afterTokens) {
    process.stdout.write(`压缩完成：压缩后上下文约 ${fmtTokens(afterTokens)}（无压缩前实测用量，无法对比）。\n`)
  } else {
    process.stdout.write('压缩完成。\n')
  }
  process.stdout.write('原对话全部保留；TUI 中压缩处显示标记条，Ctrl+O 查看总结全文。\n')
}

function handleUI(): void {
  let spawnCommand: string
  let spawnArgs: string[]
  let spawnCwd: string | undefined

  if (projectPaths.projectPath !== null) {
    // 形态 1：managed 布局（源码工作区）——从 packages/electron 启动
    const rootDir = projectPaths.projectPath
    const electronMain = join(rootDir, 'packages', 'electron', 'dist', 'electron-main.js')

    if (!existsSync(electronMain)) {
      process.stdout.write('UI 模块未构建。请先执行 pnpm run build\n')
      return
    }

    const electronCli = join(rootDir, 'packages', 'electron', 'node_modules', 'electron', 'cli.js')

    if (!existsSync(electronCli)) {
      process.stdout.write('未找到 Electron 启动脚本。请先执行 pnpm install\n')
      return
    }

    spawnCommand = process.execPath
    spawnArgs = [electronCli, rootDir]
    spawnCwd = rootDir
  } else {
    // 形态 2：npm 全档（@assistant-ai/chill 壳包自带 electron）——探测壳包并 spawn 其主进程
    const shell = findChillShellPackage()
    if (!shell) {
      process.stdout.write(
        '当前为轻档包（@assistant-ai/chill-cli），不含桌面 UI。\n' +
        '需要独立桌面窗口：npm install -g @assistant-ai/chill（全档，含 Electron 运行时）\n' +
        '浏览器完整界面现在就可用：chill web\n'
      )
      return
    }
    if (!shell.electronCli) {
      process.stdout.write(
        '已安装全档包，但 Electron 运行时缺失（安装期下载可能失败）。\n' +
        '国内网络先设置：ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/\n' +
        '然后重装：npm uninstall -g @assistant-ai/chill && npm install -g @assistant-ai/chill\n'
      )
      return
    }
    spawnCommand = process.execPath
    spawnArgs = [shell.electronCli, shell.root]
  }

  try {
    // handoff：CLI 当前会话 id 经 env 传给 UI。三值契约：'<id>'=接力该会话；
    // ''=接力但 CLI 尚无落盘会话（UI 应开全新空会话，而非回退历史最新）；
    // 未注入（undefined→读取侧 null）=非 /ui 启动（UI 自行回退最近会话）
    const handoffSessionId = chatService.getSessionId()
    const child = spawn(spawnCommand, spawnArgs, {
      cwd: spawnCwd,
      stdio: 'ignore',
      detached: true,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        CHILL_SESSION_ID: handoffSessionId ?? '',
      },
    })
    child.unref()
    // watch 租赁：UI 存活期间监听当前会话的外部变更；electron 关窗即 app.quit → 进程 exit 回收租赁。
    // 多次 /ui 引用计数，全部退出才 unwatch；preview 模式下 followWatch 为空操作
    uiLeaseCount++
    followWatch(chatService.getSessionId())
    let leaseReleased = false
    const releaseLease = () => {
      if (leaseReleased) return
      leaseReleased = true
      uiLeaseCount = Math.max(0, uiLeaseCount - 1)
      if (uiLeaseCount === 0) {
        sessionService.unwatch()
        watchedSessionId = null
      }
    }
    child.on('exit', releaseLease)
    child.on('error', releaseLease)
    process.stdout.write('UI 模式已启动\n')
  } catch (err: any) {
    process.stdout.write(`启动 UI 模式失败: ${err?.message || err}\n`)
  }
}

/**
 * 探测全档壳包 @assistant-ai/chill（npm 布局下与 chill-cli 同层：node_modules/@assistant-ai/chill）。
 * electronCli 双候选：壳包私有 node_modules（嵌套安装）与顶层提升位（npm 扁平布局）。
 * 未装壳包（轻档）返回 null；装了但 electron 缺失返回 electronCli:null（话术区分两种病因）。
 * CHILL_SHELL_ROOT 环境变量显式覆盖（壳包启动器注入，亦便本地验证）。
 */
function findChillShellPackage(): { root: string; electronCli: string | null } | null {
  const distDir = dirname(fileURLToPath(import.meta.url))
  const candidates: string[] = []
  if (process.env['CHILL_SHELL_ROOT']) candidates.push(process.env['CHILL_SHELL_ROOT'])
  candidates.push(join(distDir, '..', '..', 'chill'))
  for (const root of candidates) {
    let pkgName = ''
    try {
      pkgName = String(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name ?? '')
    } catch { continue }
    if (pkgName !== '@assistant-ai/chill') continue
    const electronCli = [
      join(root, 'node_modules', 'electron', 'cli.js'),
      join(root, '..', '..', 'electron', 'cli.js'),
    ].find((p) => existsSync(p)) ?? null
    return { root, electronCli }
  }
  return null
}

async function handleModel(input: string): Promise<void> {
  const parts = input.trim().split(/\s+/)
  const sub = parts[1] || ''

  if (sub === 'list') {
    // 同步设置标志，防止 'line' handler 过早显示 prompt
    suppressPrompt = true
    const all = await modelInfoService.getAllModelsWithApiKeyStatus()
    // 使用面分层：chat 模型可切换（交互选择）；生成模型只读展示（经 generate_* 工具使用）
    const isChat = (m: typeof all[number]['model']) => deriveModelKind(m.adapterConfig?.protocol) === 'chat'
    const entries = all.filter(e => isChat(e.model))
    const genEntries = all.filter(e => !isChat(e.model))
    const printGenSection = () => {
      if (genEntries.length === 0) return
      process.stdout.write('\n生成模型（经 generate_* 工具使用，不可切换）:\n')
      for (const e of genEntries) {
        process.stdout.write(`  ${e.hasApiKey ? '✓' : '✗'} ${(e.model.displayName || e.model.name).padEnd(26)} ${e.model.provider}${e.model.deprecated ? '（已退役）' : ''}\n`)
      }
    }
    const currentName = SelectedModelsService.getInstance().getCurrentModelName()
    if (entries.length === 0) {
      process.stdout.write('暂无可切换的对话模型\n')
      printGenSection()
      suppressPrompt = false
      setPrompt(promptForMode())
      reprompt()
      return
    }

    // TUI 活跃时经 TUI 消息区编号选择(rl 暂停中,按键选择器不可用)
    if (isTuiActive() && hasAskPresenter()) {
      const answer = await presentAsk(
        '选择要切换的模型（回车取消）: ',
        entries.map((e, i) => ({
          label: String(i + 1),
          description: `${e.model.displayName || e.model.name}（${e.model.provider}）${e.model.name === currentName ? ' ← 当前使用' : ''}${e.hasApiKey ? '' : '（未配置 Key）'}${e.model.deprecated ? '（已退役）' : ''}`,
        })),
        true
      )
      const trimmed = (answer ?? '').trim()
      if (trimmed) {
        const idx = Number.parseInt(trimmed, 10)
        if (!Number.isNaN(idx) && idx >= 1 && idx <= entries.length) {
          const selected = entries[idx - 1]
          SelectedModelsService.getInstance().saveCurrentModelName(selected.model.name)
          process.stdout.write(`已切换到 ${selected.model.displayName || selected.model.name}\n`)
          if (!selected.hasApiKey) {
            process.stdout.write(`该模型未配置 API Key，请先设置：/key set ${selected.model.provider} <your-api-key>\n`)
          }
        } else {
          process.stdout.write('无效的选择\n')
        }
      }
      printGenSection()
      suppressPrompt = false
      setPrompt(promptForMode())
      reprompt()
      return
    }

    // 交互式选择：↑↓ 移动光标，回车切换/提示，Esc 取消
    let selectedIdx = Math.max(0, entries.findIndex(e => e.model.name === currentName))

    const totalLines = entries.length + 2  // 模型行 + 表头 + 提示行
    const renderList = () => {
      process.stdout.write('模型列表（✓ 已配置 Key  ✗ 未配置 Key）:\n')
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i]
        const cursor = i === selectedIdx ? '►' : ' '
        const marker = e.model.name === currentName ? '← 当前使用' : ''
        const status = e.hasApiKey ? '✓' : '✗'
        const deprecatedTag = e.model.deprecated ? '（已退役）' : ''
        process.stdout.write(`${cursor} ${status} ${(e.model.displayName || e.model.name).padEnd(26)} ${e.model.provider.padEnd(14)} ${marker}${deprecatedTag}\n`)
      }
      process.stdout.write('↑↓ 选择, 回车切换/查看说明, Esc 取消\n')
    }

    const clearList = () => {
      process.stdout.write(`\x1b[${totalLines}A\x1b[J`)
    }

    renderList()

    // 临时接管键盘输入：保存并移除所有 keypress 监听器（含 readline 自身和粘贴处理器）
    const savedListeners = process.stdin.listeners('keypress')

    return new Promise<void>((resolve) => {
      const onKeypress = (_str: string, key: any) => {
        if (!key) return
        if (key.name === 'up') {
          selectedIdx = (selectedIdx - 1 + entries.length) % entries.length
          clearList()
          renderList()
        } else if (key.name === 'down') {
          selectedIdx = (selectedIdx + 1) % entries.length
          clearList()
          renderList()
        } else if (key.name === 'return') {
          cleanup()
          const selected = entries[selectedIdx]
          clearList()
          if (selected.hasApiKey) {
            SelectedModelsService.getInstance().saveCurrentModelName(selected.model.name)
            process.stdout.write(`已切换到 ${selected.model.displayName || selected.model.name}\n`)
          } else {
            SelectedModelsService.getInstance().saveCurrentModelName(selected.model.name)
            const provider = selected.model.provider
            process.stdout.write(`已切换到 ${selected.model.displayName || selected.model.name}\n`)
            process.stdout.write(`该模型未配置 API Key，请先设置：/key set ${provider} <your-api-key>\n`)
          }
          printGenSection()
          suppressPrompt = false
          setPrompt(promptForMode())
          reprompt()
          resolve()
        } else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
          cleanup()
          clearList()
          process.stdout.write('已取消模型切换\n')
          printGenSection()
          suppressPrompt = false
          setPrompt(promptForMode())
          reprompt()
          resolve()
        }
      }

      function cleanup() {
        process.stdin.removeListener('keypress', onKeypress)
        // 恢复原有的 keypress 监听器
        for (const l of savedListeners) {
          process.stdin.on('keypress', l as (...args: any[]) => void)
        }
      }

      // 移除原有监听器，安装我们的
      for (const l of savedListeners) {
        process.stdin.removeListener('keypress', l as (...args: any[]) => void)
      }
      process.stdin.on('keypress', onKeypress)
    })
  }

  if (sub === 'switch') {
    const modelName = parts[2]
    if (!modelName) {
      process.stdout.write('用法: /model switch <modelName>\n')
      process.stdout.write('使用 /model list 查看可用模型名\n')
      return
    }
    // 使用面分层：生成模型不可切换为对话模型
    const targetInfo = modelInfoService.getModelInfoByName(modelName)
    if (targetInfo && deriveModelKind(targetInfo.adapterConfig?.protocol) !== 'chat') {
      process.stdout.write(`${modelName} 是生成模型，不能切换为对话模型。请通过 generate_* 工具使用它（/model list 查看说明）。\n`)
      return
    }
    SelectedModelsService.getInstance().saveCurrentModelName(modelName)
    process.stdout.write(`已切换到 ${targetInfo?.displayName || modelName}\n`)
    return
  }

  if (sub === 'evaluator') {
    const modelName = parts.slice(2).join(' ').trim()
    if (!modelName) {
      const current = ctx.keyValueStore.getItem('defaultEvaluatorModel')
      process.stdout.write(current
        ? `当前目标模式评估器模型：${current}\n清除配置：/model evaluator off\n`
        : '未配置目标模式评估器模型（默认使用当前会话模型）。配置：/model evaluator <模型名>\n')
      return
    }
    if (modelName === 'off') {
      ctx.keyValueStore.removeItem('defaultEvaluatorModel')
      process.stdout.write('已清除评估器模型配置（恢复默认：使用当前会话模型）。\n')
      return
    }
    // 校验模型已注册且为对话模型（评估是文本判定任务，生成模型无意义；与 /model switch 同一判定）
    const targetInfo = modelInfoService.getModelInfoByName(modelName)
    if (!targetInfo) {
      process.stdout.write(`模型 ${modelName} 不存在。可用 /model list 查看。\n`)
      return
    }
    if (deriveModelKind(targetInfo.adapterConfig?.protocol) !== 'chat') {
      process.stdout.write(`${modelName} 是生成模型，不能用作评估器。请选择对话模型。\n`)
      return
    }
    ctx.keyValueStore.setItem('defaultEvaluatorModel', modelName)
    process.stdout.write(`目标模式评估器模型已设置为 ${targetInfo.displayName || modelName}（下一轮评估起生效）。\n`)
    return
  }

  process.stdout.write('用法:\n')
  process.stdout.write('  /model list              查看可用模型及当前选中\n')
  process.stdout.write('  /model switch <modelName>  切换模型\n')
  process.stdout.write('  /model evaluator <modelName>  配置目标模式评估器模型（off 清除，缺省用当前会话模型）\n')
}

/** 删除历史版本：/delete-version <版本>（精确匹配；当前版本与默认回滚目标拒删；需 y/n 确认） */
function handleDeleteVersion(input: string): void {
  const projectPath = projectPaths.projectPath
  if (projectPath === null) {
    process.stdout.write('当前为 npm 模式（源码未安装），没有可删除的历史版本。输入 /fetch-source 可开启自迭代。\n')
    return
  }
  const versionsDir = join(projectPaths.parentDir, 'chill-versions')
  const arg = input.startsWith('/delete-version ') ? input.slice(16).trim() : ''

  const listNames = (): string[] => {
    if (!existsSync(versionsDir)) return []
    return readdirSync(versionsDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort((a, b) => b.localeCompare(a))
  }

  if (!arg) {
    process.stdout.write('用法: /delete-version <版本名>\n')
    const names = listNames()
    if (names.length === 0) {
      process.stdout.write('当前没有历史版本。\n')
    } else {
      process.stdout.write('可用版本（当前版本与默认回滚目标不可删）:\n')
      for (const n of names) process.stdout.write(`  ${n}\n`)
    }
    return
  }

  if (arg.includes('/') || arg.includes('\\')) {
    process.stdout.write('版本名不能包含路径分隔符。\n')
    return
  }
  const names = listNames()
  if (!names.includes(arg)) {
    process.stdout.write(`版本不存在: ${arg}${names.length > 0 ? '，可用版本: ' + names.join(', ') : '（当前没有历史版本）'}\n`)
    return
  }
  // 当前版本预检（最终判定以 switcher 为准）
  try {
    if (realpathSync(join(versionsDir, arg)).toLowerCase() === realpathSync(projectPath).toLowerCase()) {
      process.stdout.write(`${arg} 是当前正在运行的版本，不能删除。请先 /rollback 切换到其他版本。\n`)
      return
    }
  } catch { /* 判定失败交给 switcher 兜底 */ }

  const guardianPath = join(projectPaths.parentDir, 'chill-guardian', 'switcher.js')
  if (!existsSync(guardianPath)) {
    process.stdout.write('switcher.js 不存在，无法删除版本。\n')
    return
  }
  // TUI 活跃时经 TUI 消息区提问(rl 已 pause,直接 rl.question 会挂死)
  if (isTuiActive() && hasAskPresenter()) {
    presentAsk(`确认删除历史版本 ${arg}？此操作不可恢复`, [
      { label: 'n', description: '取消' },
      { label: 'y', description: '确认删除' },
    ], false)?.then(async (answer) => {
      if (answer.trim().toLowerCase() !== 'y') {
        process.stdout.write('已取消。\n')
        return
      }
      await execDelete(arg)
    })
    return
  }
  rl.question(`确认删除历史版本 ${arg}？此操作不可恢复 (y/n): `, async (answer) => {
    if (answer.trim().toLowerCase() !== 'y') {
      process.stdout.write('已取消。\n')
      setPrompt(promptForMode())
      reprompt()
      return
    }
    await execDelete(arg)
  })
}

/** /delete-version 的执行段（TUI/CLI 两通道共用） */
async function execDelete(arg: string): Promise<void> {
  const guardianPath = join(projectPaths.parentDir, 'chill-guardian', 'switcher.js')
  const switchLogPath = join(projectPaths.parentDir, 'chill-guardian', 'runtime.log')
  const switchLog = (msg: string) => {
    appendFileSync(switchLogPath, `[${new Date().toISOString()}] [/delete-version] ${msg}\n`)
  }
  switchLog(`=== 删除版本 ${arg} ===`)
  process.stdout.write(`正在删除 ${arg} ...\n`)
  isChatting = true
  const result = await runSwitcher(guardianPath, ['--delete', projectPaths.projectPath!, arg], switchLog)
  isChatting = false
  switchLog(`switcher 结果: ${JSON.stringify(result)}`)
  if (result?.timeout) {
    process.stdout.write('switcher 执行超时。请查看 chill-guardian/switcher-debug.log 确认结果。\n')
  } else if (result?.success) {
    process.stdout.write(`✓ 已删除版本 ${arg}\n`)
  } else {
    process.stdout.write(`✗ 删除失败：${result?.reason ?? '未知原因'}\n建议: ${result?.guidance ?? '查看 chill-guardian/switcher-debug.log'}\n`)
  }
  setPrompt(promptForMode())
  reprompt()
}

/** /idea：闪念捕获——一句话直写账本「闪念」簇（不经模型、不碰引擎状态：**流式输出中也可用**，
 *  无 isChatting 门；TUI 侧经 commandMenu streamSafe 豁免同享此性质）。回执一行带账本摘要。 */
async function handleIdea(input: string): Promise<void> {
  const text = input.slice('/idea'.length).trim()
  if (!text) {
    process.stdout.write('用法：/idea 一句话（点子入改进提案「闪念」簇，下次 /improve 决策；流式输出中也可用）\n')
    return
  }
  if (projectPaths.projectPath === null) {
    process.stdout.write('此功能需开启自迭代（输入 /fetch-source 下载源码后可用）。\n')
    return
  }
  if (!improvementLedger.isInitialized()) {
    process.stdout.write('改进提案账本未装配。\n')
    return
  }
  let sessionId: string | undefined
  try {
    sessionId = chatService.getEngine().getSessionState().sessionId ?? undefined
  } catch { /* 引擎不可读时省略会话戳 */ }
  const r = await improvementLedger.capture(text, 'CLI /idea', { sessionId })
  if (!r.ok) {
    process.stdout.write(`✗ ${r.error}\n`)
    return
  }
  if (r.duplicated) {
    process.stdout.write('⚠ 已记录过相同点子（10 秒内防重），未重复入账\n')
    return
  }
  const line = await improvementLedger.getDigestLine()
  process.stdout.write(`✓ 已记入「闪念」簇${r.truncated ? '（超长已截断）' : ''}${line ? ` · ${line}` : ''}（/improve 决策）\n`)
}

/** /improve：改进提案决策——TUI 由 TuiApp 本地拦截打开面板，此处服务纯 CLI 文本循环；
 *  /improve review 走对话触发 self-improve 深度审查（九源收集→归档→决策，TUI/CLI 通用） */
async function handleImprove(input: string): Promise<void> {
  const arg = input.slice('/improve'.length).trim()
  if (arg === 'review') {
    if (isChatting) {
      process.stdout.write('\n⚠ 正在处理中，请等待当前对话完成\n')
      return
    }
    isChatting = true
    suppressPrompt = true
    try {
      await anchorFromDisk()
      await chatService.chat(
        '对本项目做一轮 self-improve 改进审查：按九类输入源收集发现、按影响×难度排出 P0-P3，' +
          '把未被用户关闭的新发现归档到 ~/.chill/improvement-proposals.md 待确认区，' +
          '最后调用 manage_improvements 让我批量决策（支持整簇：y C26）。',
      )
    } catch (err: any) {
      process.stdout.write(`\n错误: ${err?.message || err}\n`)
    } finally {
      isChatting = false
      suppressPrompt = false
      await flushPeerSync()
    }
    setPrompt(promptForMode())
    reprompt()
    return
  }
  if (arg !== '') {
    process.stdout.write('用法：/improve 决策待确认提案 · /improve review 深度审查（九源归档后决策）\n')
    return
  }
  if (isTuiActive()) {
    process.stdout.write('TUI 内请直接输入 /improve 打开决策面板。\n')
    return
  }
  await runImproveCliLoop()
}

/** 纯 CLI 的 /improve 决策循环：打印簇视图 + 语法应答直到 q/空行；打开时执行老化（与 TUI 面板同语义） */
async function runImproveCliLoop(): Promise<void> {
  if (!improvementLedger.isInitialized()) {
    process.stdout.write('改进提案账本未装配（npm 模式下自动攒料不运行，无提案文件）。\n')
    return
  }
  suppressPrompt = true
  try {
    const aging = await improvementLedger.applyAging()
    if (aging.ok && aging.summary) process.stdout.write(`⏳ ${aging.summary}\n`)
    for (;;) {
      const parsed = await improvementLedger.getParsed()
      if (!parsed || parsed.pending.length === 0) {
        process.stdout.write('（暂无待确认改进提案）\n')
        break
      }
      const digestLine = formatDigestLine(summarizeDigest(parsed))
      process.stdout.write(`\n📬 改进提案决策 · ${digestLine}（已按问题簇分组）\n\n`)
      process.stdout.write(formatEntriesGrouped(parsed.pending))
      process.stdout.write('\n\n决策语法：y 1,3（确认）· y C26（整簇确认）· s 2（跳过）· del C26（删除整簇）· all / s all / del all\n未提及的条目默认保留待确认，不会静默删除。\n')
      const handle = consoleAsk(rl, '决策（q 或空行完成）: ')
      const answer = await handle.promise
      if (answer === SURFACE_RETRACTED) break
      const t = (answer || '').trim()
      if (t === '' || t === 'q' || t === 'Q') break
      const result = parseDecisionInput(t, parsed.pending, { onUnmentioned: 'keep' })
      if (result.decisions.length === 0) {
        const invalids = [
          result.invalidNums.length > 0 ? `越界编号 ${result.invalidNums.join('、')}` : '',
          result.invalidTargets.length > 0 ? `无效目标 ${result.invalidTargets.join('、')}` : '',
        ].filter(Boolean)
        process.stdout.write(invalids.length > 0 ? `⚠ ${invalids.join('；')}，未产生决策\n` : '未识别到有效决策（语法见上方提示）\n')
        continue
      }
      const confirmedN = result.decisions.filter(d => d.action === 'confirm').length
      const closedN = result.decisions.filter(d => d.action === 'close').length
      const skippedN = result.decisions.filter(d => d.action === 'skip').length
      const res = await improvementLedger.decide(result.decisions)
      if (res.ok) {
        process.stdout.write(`✓ 已应用决策：确认 ${confirmedN} · 删除 ${closedN} · 跳过 ${skippedN}\n`)
        const after = await improvementLedger.getDigestLine()
        if (after) process.stdout.write(`账本：${after}（对已确认簇说"实施 Cxx 簇"进入自迭代）\n`)
      } else {
        process.stdout.write(`✗ ${res.error}\n`)
        break
      }
    }
  } finally {
    suppressPrompt = false
    setPrompt(promptForMode())
    reprompt()
  }
}

/** 版本回滚：/rollback 交互选择版本，/r <版本> 直接回滚（支持唯一前缀匹配） */
async function handleRollback(input: string): Promise<void> {
  const projectPath = projectPaths.projectPath
  if (projectPath === null) {
    process.stdout.write('当前为 npm 模式（源码未安装），没有可回滚的版本。输入 /fetch-source 可开启自迭代。\n')
    return
  }
  const arg = input.startsWith('/r ') ? input.slice(3).trim()
    : input.startsWith('/rollback ') ? input.slice(9).trim()
    : ''

  const versionsDir = join(projectPaths.parentDir, 'chill-versions')

  interface VersionEntry { name: string; goal: string; isCurrent: boolean }

  const listVersions = (): VersionEntry[] => {
    if (!existsSync(versionsDir)) return []
    let currentReal = ''
    try { currentReal = realpathSync(projectPath).toLowerCase() } catch {}
    const entries: VersionEntry[] = []
    for (const e of readdirSync(versionsDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      let goal = ''
      try {
        const meta = JSON.parse(readFileSync(join(versionsDir, e.name, '.version.json'), 'utf-8'))
        goal = meta.goal || ''
      } catch { /* 无 .version.json（如 v-legacy 初始版本） */ }
      let isCurrent = false
      try { isCurrent = realpathSync(join(versionsDir, e.name)).toLowerCase() === currentReal } catch {}
      entries.push({ name: e.name, goal, isCurrent })
    }
    // 新的在前（v<时间戳> 按名字降序即按时间降序）
    return entries.sort((a, b) => b.name.localeCompare(a.name))
  }

  const execRollback = async (versionName: string): Promise<void> => {
    const guardianPath = join(projectPaths.parentDir, 'chill-guardian', 'switcher.js')
    const switchLogPath = join(projectPaths.parentDir, 'chill-guardian', 'runtime.log')
    const switchLog = (msg: string) => {
      appendFileSync(switchLogPath, `[${new Date().toISOString()}] [/rollback] ${msg}\n`)
    }
    switchLog(`=== 回滚到 ${versionName} ===`)
    if (!existsSync(guardianPath)) {
      switchLog('[FAIL] switcher.js 不存在')
      process.stdout.write('switcher.js 不存在，无法回滚。\n')
      return
    }
    process.stdout.write(`正在回滚到 ${versionName}（通常数秒）...\n`)
    isChatting = true
    const result = await runSwitcher(guardianPath, ['--rollback', projectPath, versionName], switchLog)
    switchLog(`switcher 结果: ${JSON.stringify(result)}`)
    isChatting = false
    if (result?.timeout) {
      process.stdout.write('switcher 执行超时。请查看 chill-guardian/switch-failure.json 确认结果。\n')
      setPrompt(promptForMode())
      reprompt()
      return
    }
    if (result?.success) {
      process.stdout.write(`✓ 已回滚到 ${versionName}。接续窗即将自动打开，本窗口将在 10 秒后自动关闭。\n`)
      switchLog('回滚成功，发换版事件（接续统一收敛：CLI=订阅器开新窗；serve=令牌驱动自退+拉起）')
      // M1.6：回滚路径补发换版事件（历史路径只内联 spawn+bounce，M1.10 退役 bounce 后由事件/令牌补位）
      eventBus.emit('chill:switch-succeeded', { projectPath: projectPaths.projectPath ?? undefined, version: versionName })
      // 退出前显式交接：退租 relay（新窗口经等待态自动接管）+ 销毁后台 Worker
      setTimeout(() => { void destroyWorkersBeforeExit().finally(() => process.exit(0)) }, 10000)
      return
    }
    switchLog(`[FAIL] 回滚失败: ${JSON.stringify(result)}`)
    process.stdout.write(`✗ 回滚失败：${result?.reason ?? '未知原因'}\n建议: ${result?.guidance ?? '查看 chill-guardian/switcher-debug.log'}\n`)
    setPrompt(promptForMode())
    reprompt()
  }

  const entries = listVersions()
  if (entries.length === 0) {
    process.stdout.write('还没有可回滚的版本。完成一次版本切换后，历史版本会保留在 chill-versions/ 中。\n')
    return
  }

  // 直接形式：/r <版本>（精确匹配 → 唯一前缀匹配）
  if (arg) {
    const exact = entries.find(e => e.name === arg)
    const matched = exact ? [exact] : entries.filter(e => e.name.startsWith(arg))
    if (matched.length === 0) {
      process.stdout.write(`版本不存在: ${arg}，输入 /rollback 查看可用版本\n`)
      return
    }
    if (matched.length > 1) {
      process.stdout.write(`版本前缀不唯一，匹配到: ${matched.map(e => e.name).join(', ')}\n`)
      return
    }
    if (matched[0].isCurrent) {
      process.stdout.write(`${matched[0].name} 已是当前版本，无需回滚。\n`)
      return
    }
    execRollback(matched[0].name)
    return
  }

  // 交互形式：/rollback（TUI 经消息区编号选择；CLI ↑↓ 选择，回车回滚，Esc 取消）
  if (isTuiActive() && hasAskPresenter()) {
    const answer = await presentAsk(
      '选择要回滚到的版本（回车取消）: ',
      entries.map((e, i) => ({
        label: String(i + 1),
        description: `${e.name}${e.isCurrent ? ' ← 当前' : ''} ${e.goal || '（初始版本）'}`,
      })),
      true
    )
    const trimmed = (answer ?? '').trim()
    if (trimmed) {
      const idx = Number.parseInt(trimmed, 10)
      if (!Number.isNaN(idx) && idx >= 1 && idx <= entries.length) {
        const selected = entries[idx - 1]
        if (selected.isCurrent) {
          process.stdout.write(`${selected.name} 已是当前版本，无需回滚。\n`)
        } else {
          await execRollback(selected.name)
        }
      } else {
        process.stdout.write('无效的选择\n')
      }
    }
    return
  }

  suppressPrompt = true
  let selectedIdx = Math.max(0, entries.findIndex(e => e.isCurrent))

  const totalLines = entries.length + 2  // 版本行 + 表头 + 提示行
  const renderList = () => {
    process.stdout.write('可用版本:\n')
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      const cursor = i === selectedIdx ? '►' : ' '
      const marker = e.isCurrent ? '← 当前' : ''
      process.stdout.write(`${cursor} ${e.name.padEnd(28)} ${marker.padEnd(8)} ${e.goal || '（初始版本）'}\n`)
    }
    process.stdout.write('↑↓ 选择, 回车回滚, Esc 取消\n')
  }
  const clearList = () => {
    process.stdout.write(`\x1b[${totalLines}A\x1b[J`)
  }

  renderList()

  // 临时接管键盘输入：保存并移除所有 keypress 监听器（含 readline 自身和粘贴处理器）
  const savedListeners = process.stdin.listeners('keypress')

  return new Promise<void>((resolve) => {
    const onKeypress = (_str: string, key: any) => {
      if (!key) return
      if (key.name === 'up') {
        selectedIdx = (selectedIdx - 1 + entries.length) % entries.length
        clearList()
        renderList()
      } else if (key.name === 'down') {
        selectedIdx = (selectedIdx + 1) % entries.length
        clearList()
        renderList()
      } else if (key.name === 'return') {
        cleanup()
        const selected = entries[selectedIdx]
        clearList()
        if (selected.isCurrent) {
          process.stdout.write(`${selected.name} 已是当前版本，无需回滚。\n`)
          suppressPrompt = false
          setPrompt(promptForMode())
          reprompt()
          resolve()
          return
        }
        execRollback(selected.name)
        suppressPrompt = false
        resolve()
      } else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        cleanup()
        clearList()
        process.stdout.write('已取消回滚\n')
        suppressPrompt = false
        setPrompt(promptForMode())
        reprompt()
        resolve()
      }
    }

    function cleanup() {
      process.stdin.removeListener('keypress', onKeypress)
      // 恢复原有的 keypress 监听器
      for (const l of savedListeners) {
        process.stdin.on('keypress', l as (...args: any[]) => void)
      }
    }

    // 移除原有监听器，安装我们的
    for (const l of savedListeners) {
      process.stdin.removeListener('keypress', l as (...args: any[]) => void)
    }
    process.stdin.on('keypress', onKeypress)
  })
}

/** /add-dir：会话级可写目录管理（无参列出当前边界；边界数据在 core 的 writeBoundary 单例，进程内存、会话结束失效） */
function handleAddDir(input: string): void {
  const boundary = getWriteBoundary()
  const arg = input.slice('/add-dir'.length).trim()
  if (!arg) {
    // workDir 可能与 extraRoots 重复（用户 /add-dir 了工作目录本身），展示前去重
    const roots = [...new Set(boundary.listWritableRoots())]
    process.stdout.write('当前可写范围（边界目录集合）:\n')
    for (const r of roots) process.stdout.write(`  ${r}\n`)
    process.stdout.write('圈内直接写入；圈外写入会当场请你批准。\n')
    return
  }
  // 相对路径以会话工作目录为基准解析（与写工具 resolvePath 同一基准），再交给 core 校验/规范化
  const base = ctx.fsProvider.getCurrentDirectory() ?? process.cwd()
  const result = boundary.addWritableRoot(resolve(base, arg))
  if (result.success) {
    process.stdout.write(`已加入本次会话可写范围: ${result.path}\n`)
  } else {
    process.stdout.write(`无法加入: ${result.error}\n`)
  }
}

function handleAutoApply(input: string): void {
  const parts = input.trim().split(/\s+/)
  const action = (parts[1] || '').toLowerCase()
  if (action === 'on' || action === 'off') {
    const target = action === 'on'
    // 同值不发事件（无变更留痕）——命令须自给回音，防"执行了无反馈"
    if (ctx.builtInExecutor.getAutoApply() === target) {
      process.stdout.write(`直写模式已是${target ? '开启' : '关闭'}状态\n`)
      return
    }
    ctx.builtInExecutor.setAutoApply(target) // 变更留痕由 PERMISSION_MODE_CHANGED 订阅统一打印（双端同口径）
    return
  }
  process.stdout.write('用法:\n')
  process.stdout.write('  /auto-apply on   开启直写模式（任意路径直接写不问）\n')
  process.stdout.write('  /auto-apply off  关闭直写模式（边界内直接写、边界外当场批准，默认）\n')
}

function handleAutoSwitch(input: string): void {
  const parts = input.trim().split(/\s+/)
  const action = (parts[1] || '').toLowerCase()
  if (action === 'on') {
    setAutoSwitchFlag({ store: ctx.keyValueStore }, true)
    process.stdout.write('自迭代后自动版本切换已开启\n')
  } else if (action === 'off') {
    setAutoSwitchFlag({ store: ctx.keyValueStore }, false)
    process.stdout.write('自迭代后自动版本切换已关闭\n')
  } else {
    process.stdout.write('用法:\n')
    process.stdout.write('  /auto-switch on   开启自迭代后自动版本切换\n')
    process.stdout.write('  /auto-switch off  关闭自迭代后自动版本切换\n')
  }
}

/** 宿主开关共享核心的 CLI 装配（与命令面执行器同一事实点；engine 现取活动引擎——serve=活跃、交互=单引擎） */
function cliDesktopControlDeps(): DesktopControlDeps {
  return { store: ctx.keyValueStore, engine: activeEngine(), desktop: ctx.desktopController, sessionAllow: ctx.builtInExecutor }
}

/** /desktop：桌面能力开关（截屏 + 键鼠注入；状态存 configStore 键 desktop_control_enabled，默认关）。
 * 薄壳：开关逻辑（写键+合成消息+收回放行+探测+事件）单一事实点在 core desktopControl，此处只做参数解析与 stdout 呈现 */
async function handleDesktop(input: string): Promise<void> {
  const parts = input.trim().split(/\s+/)
  const action = (parts[1] || '').toLowerCase()
  if (action === 'on') {
    const r = await setDesktopControl(cliDesktopControlDeps(), true)
    if (r.ok) {
      if (r.available === true) {
        // 视觉模型推荐现查（首个支持视觉的已注册 chat 模型）；无则不点名（呈现留壳——防 core 反向依赖）
        const visionModel = getRecommendedVisionModelName()
        process.stdout.write(visionModel ? `已开启桌面能力，建议搭配视觉模型（如 ${visionModel}）使用\n` : '已开启桌面能力，建议搭配支持视觉的模型使用\n')
      } else {
        process.stdout.write('已开启但当前环境缺少桌面原生模块（需重新构建或该平台暂无 prebuild）\n')
      }
    }
  } else if (action === 'off') {
    await setDesktopControl(cliDesktopControlDeps(), false)
    process.stdout.write('已关闭桌面能力\n')
  } else if (action === 'log') {
    // /desktop log：今日审计文件最近 20 条摘要（时间 + 描述 + 审批结论 + 结果）
    const filePath = ctx.desktopAuditSink.todayFilePath()
    if (!existsSync(filePath)) {
      process.stdout.write('今日暂无桌面审计记录\n')
      return
    }
    const APPROVAL_LABEL: Record<string, string> = {
      approved: '用户批准', rejected: '用户拒绝', session: '会话放行', passive: '被动免批'
    }
    const lines = readFileSync(filePath, 'utf8').split('\n').filter((l) => l.trim() !== '')
    const recent = lines.slice(-20)
    process.stdout.write(`今日桌面审计记录（共 ${lines.length} 条，显示最近 ${recent.length} 条）：\n`)
    for (const line of recent) {
      try {
        const e = JSON.parse(line) as DesktopAuditEntry
        const time = new Date(e.ts).toLocaleTimeString()
        const approval = APPROVAL_LABEL[e.approval] ?? e.approval
        const result = e.ok ? '成功' : `失败（${e.error ?? '未知原因'}）`
        const batch = e.batch ? ` [批 ${e.batch.step}/${e.batch.total}]` : ''
        process.stdout.write(`  ${time}  ${e.desc}${batch} ｜ ${approval} ｜ ${result}\n`)
      } catch { /* 单行损坏跳过，不影响其余行 */ }
    }
  } else if (action === 'audit') {
    // /desktop audit on|off：审计开关（configStore 键 desktop_audit，读不到/'true'=on）
    const sub = (parts[2] || '').toLowerCase()
    if (sub === 'on') {
      ctx.keyValueStore.setItem('desktop_audit', 'true')
      process.stdout.write('已开启桌面审计（动作留痕 ~/.chill/desktop-audit/）\n')
    } else if (sub === 'off') {
      ctx.keyValueStore.setItem('desktop_audit', 'false')
      process.stdout.write('已关闭桌面审计（新动作不再记录；已有日志保留，超过 7 天自动清理）\n')
    } else {
      process.stdout.write('用法:\n')
      process.stdout.write('  /desktop audit on   开启桌面审计（默认）\n')
      process.stdout.write('  /desktop audit off  关闭桌面审计\n')
    }
  } else {
    const enabled = readDesktopEnabled(ctx.keyValueStore) ?? false
    const available = await ctx.desktopController.isAvailable()
    const auditOn = ctx.keyValueStore.getItem('desktop_audit') !== 'false'
    process.stdout.write(`桌面能力：${enabled ? '已开启' : '已关闭'}（原生模块${available ? '可用' : '不可用'}；审计${auditOn ? '开启' : '关闭'}）\n`)
    process.stdout.write('用法:\n')
    process.stdout.write('  /desktop on   开启桌面能力（截屏 + 键鼠操作）\n')
    process.stdout.write('  /desktop off  关闭桌面能力\n')
    process.stdout.write('  /desktop log  查看今日审计记录（最近 20 条）\n')
    process.stdout.write('  /desktop audit on|off  开关桌面审计\n')
  }
}

/** /tools：工具渐进发现开关与状态（configStore 键 progressive_tools，opt-out：读不到/'true'=开，'false'=关） */
function handleTools(input: string): void {
  const parts = input.trim().split(/\s+/)
  const sub = (parts[1] || '').toLowerCase()
  if (sub === 'mode') {
    const action = (parts[2] || '').toLowerCase()
    if (action === 'on') {
      ctx.keyValueStore.setItem('progressive_tools', 'true')
      process.stdout.write('已开启工具渐进发现（省 token，后续请求生效）\n')
    } else if (action === 'off') {
      ctx.keyValueStore.setItem('progressive_tools', 'false')
      process.stdout.write('已关闭工具渐进发现（恢复全量工具下发，后续请求生效）\n')
    } else {
      process.stdout.write('用法:\n')
      process.stdout.write('  /tools mode on   开启工具渐进发现（默认）\n')
      process.stdout.write('  /tools mode off  关闭工具渐进发现（全量下发）\n')
    }
    return
  }
  if (sub === '' || sub === 'status') {
    const status = chatService.getEngine().getToolsStatus()
    process.stdout.write(`工具下发模式：${status.mode === 'progressive' ? '渐进发现' : '全量下发'}\n`)
    process.stdout.write(`常驻核心工具：${status.coreCount}；已激活：${status.activatedCount}；待发现：${status.deferredCount}\n`)
    if (status.activatedNames.length > 0) {
      process.stdout.write(`已激活工具：${status.activatedNames.join(', ')}\n`)
    }
    return
  }
  process.stdout.write('用法:\n')
  process.stdout.write('  /tools           查看工具下发状态（同 /tools status）\n')
  process.stdout.write('  /tools mode on   开启工具渐进发现（默认）\n')
  process.stdout.write('  /tools mode off  关闭工具渐进发现（全量下发）\n')
  process.stdout.write('  /tools status    查看常驻/已激活/待发现工具分布\n')
}

/** /limits：委派资源限额管理（configStore 键 delegation_max_concurrent/delegation_max_cumulative；每次委派现读即改即生效） */
const LIMIT_KEYS = ['delegation_max_concurrent', 'delegation_max_cumulative', 'team_budget_max_members', 'team_budget_max_tokens', 'team_budget_max_depth'] as const
const LIMIT_LABELS: Record<string, string> = {
  delegation_max_concurrent: '并发上限（同时在跑的后台任务数；默认 6，Codex max_threads 参照）',
  delegation_max_cumulative: '累计上限（进程内累计委派数，含已落地；默认 200，Claude Code 会话累计参照）',
  team_budget_max_members: '团队人数预算上限（新建团队快照的默认人数闸；不设=不限）',
  team_budget_max_tokens: '团队 token 预算上限（扩张闸+告警；不设=不限；Provider 不回用量时按字符估值生效，标注~）',
  team_budget_max_depth: '团队嵌套深度上限（成员拉新=父深度+1；不设=不限）',
}

function handleLimits(input: string): void {
  const parts = input.trim().split(/\s+/)
  const sub = (parts[1] || '').toLowerCase()

  if (sub === '' || sub === 'show') {
    process.stdout.write('\n委派资源限额（每次委派现读，即改即生效）:\n')
    for (const key of LIMIT_KEYS) {
      const current = ctx.keyValueStore.getItem(key)
      process.stdout.write(`  ${key} = ${current ?? '(默认)'}\n    ${LIMIT_LABELS[key]}\n`)
    }
    process.stdout.write('\n设置: /limits set <key> <正整数>；恢复默认: /limits unset <key>\n\n')
    return
  }

  if (sub === 'set') {
    const key = parts[2]
    const value = parts[3]
    if (!key || !LIMIT_KEYS.includes(key as (typeof LIMIT_KEYS)[number])) {
      process.stdout.write(`无效参数名: ${key ?? '(缺省)'}\n可设置: ${LIMIT_KEYS.join(', ')}\n`)
      return
    }
    const n = Number(value)
    if (!value || !Number.isInteger(n) || n <= 0) {
      process.stdout.write(`无效参数值: ${value ?? '(缺省)'}（必须是正整数）\n`)
      return
    }
    ctx.keyValueStore.setItem(key, String(n))
    process.stdout.write(`已设置 ${key} = ${n}（下次委派起生效）\n`)
    return
  }

  if (sub === 'unset') {
    const key = parts[2]
    if (!key || !LIMIT_KEYS.includes(key as (typeof LIMIT_KEYS)[number])) {
      process.stdout.write(`无效参数名: ${key ?? '(缺省)'}\n可设置: ${LIMIT_KEYS.join(', ')}\n`)
      return
    }
    ctx.keyValueStore.removeItem(key)
    process.stdout.write(`已恢复默认: ${key}\n`)
    return
  }

  process.stdout.write('用法:\n  /limits              查看委派资源限额\n  /limits set <key> <正整数>   设置限额\n  /limits unset <key>          恢复默认\n')
}

/** /team:团队观测与直达控制(原子化协作迭代 5;core 供数据,CLI 渲染;policy 子命令 = 用户直达快照的结构通道,不经前台模型)
 *  字符串换行一律用 NL 常量(String.fromCharCode(10)),避免转义层失真 */
const NL = String.fromCharCode(10)
async function handleTeam(input: string): Promise<void> {
  const { getTeamRuntimeService, summarizeSnapshot, LEAD_GATEABLE_TOOLS, formatTokenSpend } = await import('@assistant-ai/core')
  const svc = getTeamRuntimeService()
  const team = svc?.getActiveTeam()
  const write = (t: string) => process.stdout.write(t)
  if (!svc || !team) {
    write(NL + '当前没有活动团队(成队方式:use_team 激活固定团队,或 task/batch_task 带 as_teammate:true 组建临时团队)。' + NL + NL)
    return
  }
  const parts = input.trim().split(/\s+/)
  const sub = (parts[1] || '').toLowerCase()

  // ---------- /team policy:用户直达快照 ----------
  if (sub === 'policy') {
    const action = (parts[2] || '').toLowerCase()
    const snapshot = svc.getSnapshot()
    if (!action || action === 'show') {
      write(NL + summarizeSnapshot(snapshot) + NL + NL)
      return
    }
    if (!snapshot) {
      write(NL + '当前团队没有授权快照(异常状态)。' + NL + NL)
      return
    }
    const note = `/team policy ${parts.slice(2).join(' ')}(用户直达)`
    try {
      if (action === 'lead') {
        const onoff = (parts[3] || '').toLowerCase()
        const current = snapshot.grants.lead ?? []
        if (onoff === 'on') {
          await svc.updateSnapshot({ grants: { ...snapshot.grants, lead: ['*'] } }, 'user-direct', note)
          write(NL + '已恢复 Lead 全权(*)。' + NL + NL)
        } else if (onoff === 'off') {
          const kept = current.filter((g) => g !== '*' && !LEAD_GATEABLE_TOOLS.includes(g))
          const next = [...new Set([...kept, 'team_policy'])]
          await svc.updateSnapshot({ grants: { ...snapshot.grants, lead: next } }, 'user-direct', note)
          write(NL + `已收走 Lead 干预权(${LEAD_GATEABLE_TOOLS.join('/')})。` + NL + NL)
        } else {
          write(NL + '用法: /team policy lead on(恢复全权) | /team policy lead off(收走干预权)' + NL + NL)
        }
        return
      }
      if (action === 'budget') {
        const keyMap: Record<string, 'maxMembers' | 'maxTokens' | 'maxDepth'> = { members: 'maxMembers', tokens: 'maxTokens', depth: 'maxDepth' }
        const key = keyMap[(parts[3] || '').toLowerCase()]
        if (!key) {
          write(NL + '用法: /team policy budget members|tokens|depth <正整数|off>' + NL + NL)
          return
        }
        const raw = parts[4]
        const value = raw === 'off' ? undefined : Number(raw)
        if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
          write(NL + `无效值: ${raw ?? '(缺省)'}(正整数或 off)` + NL + NL)
          return
        }
        await svc.updateSnapshot({ budget: { ...snapshot.budget, [key]: value } }, 'user-direct', note)
        write(NL + `预算已更新:${key} = ${value ?? '不限'}` + NL + NL)
        return
      }
      if (action === 'grant' || action === 'revoke') {
        const member = parts[3]
        const grant = parts[4]
        if (!member || !grant) {
          write(NL + '用法: /team policy grant|revoke <成员名> <授权项>' + NL + NL)
          return
        }
        const base = snapshot.grants[member] ?? snapshot.defaultMemberGrants
        const next = action === 'grant' ? [...new Set([...base, grant])] : base.filter((g) => g !== grant)
        await svc.updateSnapshot({ grants: { ...snapshot.grants, [member]: next } }, 'user-direct', note)
        write(NL + `已${action === 'grant' ? '授予' : '收回'} ${member} 的 ${grant}` + NL + NL)
        return
      }
      write(NL + '用法: /team policy [show] | lead on|off | budget members|tokens|depth <n|off> | grant|revoke <成员> <授权>' + NL + NL)
      return
    } catch (err) {
      write(NL + `快照更新被拒绝: ${err instanceof Error ? err.message : err}` + NL + NL)
      return
    }
  }

  // ---------- /team:总览 ----------
  const snap = svc.getSnapshot()
  const statusLabel: Record<string, string> = { standby: '待命', running: '执行中', idle: '空闲', failed: '失败' }
  const lines: string[] = [
    '',
    `团队${team.name ? `「${team.name}」` : '(临时团队)'}  runId: ${team.runId}`,
    '',
    '花名册:',
    ...(team.roster.length > 0
      ? team.roster.map((e) => {
          const grants = snap ? (snap.grants[e.name] ?? snap.defaultMemberGrants) : []
          return `  ${e.name}(@${e.agent}${e.role ? `,${e.role}` : ''}):${statusLabel[e.status] ?? e.status}  授权: ${grants.join(', ') || '(无)'}`
        })
      : ['  (空)']),
    '',
    `看板(版本 ${team.boardRevision}):`,
    ...(team.board.length > 0
      ? team.board.map((i) => `  [${i.id}] (${i.status}) ${i.title}  认领:${i.assignee ?? '无'}${i.releaseHistory?.length ? `  退回 ${i.releaseHistory.length} 次` : ''}`)
      : ['  (空)']),
    '',
    `账本:人数 ${team.ledger?.memberCount ?? team.roster.length} · token ${formatTokenSpend(team.ledger)}`,
    '',
    summarizeSnapshot(snap),
    '',
  ]
  write(lines.join(NL))
}

function handleConfig(input: string): void {
  const parts = input.trim().split(/\s+/)
  const sub = (parts[1] || '').toLowerCase()

  const currentModelName = SelectedModelsService.getInstance().getCurrentModelName()
  if (!currentModelName) {
    process.stdout.write('请先使用 /model switch 选择一个模型\n')
    return
  }

  if (sub === 'show' || sub === '') {
    // 显示当前模型的参数设置
    const params = SelectedModelsService.getInstance().getModelParameters(currentModelName)
    process.stdout.write(`当前模型: ${currentModelName}\n`)
    if (!params || Object.keys(params).length === 0) {
      process.stdout.write('  暂无自定义参数设置（使用默认值）\n')
    } else {
      for (const [key, value] of Object.entries(params)) {
        process.stdout.write(`  ${key} = ${value}\n`)
      }
    }
    process.stdout.write('\n设置参数: /config set <参数名> <值>\n')
    process.stdout.write('常用参数: max_tokens, temperature, top_p, thinking, reasoning_effort\n')
    process.stdout.write('示例: /config set max_tokens 16000\n')
    return
  }

  if (sub === 'set') {
    const paramKey = parts[2]
    const paramValue = parts[3]
    if (!paramKey || paramValue === undefined) {
      process.stdout.write('用法: /config set <参数名> <参数值>\n')
      process.stdout.write('可设置参数: max_tokens, temperature, top_p, stream, thinking, reasoning_effort, enable_thinking\n')
      process.stdout.write('示例: /config set max_tokens 16000\n')
      return
    }
    // 校验参数名是否有效（下划线格式会被 normalizeConfigKeys 转为驼峰）
    const VALID_PARAMS = ['temperature', 'max_tokens', 'top_p', 'stream', 'thinking', 'reasoning_effort', 'enable_thinking']
    if (!VALID_PARAMS.includes(paramKey.toLowerCase())) {
      process.stdout.write(`无效参数名: ${paramKey}\n`)
      process.stdout.write('可设置参数: max_tokens, temperature, top_p, stream, thinking, reasoning_effort, enable_thinking\n')
      return
    }
    // 数值参数转换
    let parsedValue: any = paramValue
    if (paramValue === 'true') parsedValue = true
    else if (paramValue === 'false') parsedValue = false
    else if (!isNaN(Number(paramValue)) && paramValue !== '') parsedValue = Number(paramValue)

    // 声明即事实：reasoning_effort / enable_thinking 按当前模型卡声明校验（未声明/取值越界都拒绝）
    if (paramKey.toLowerCase() === 'reasoning_effort' || paramKey.toLowerCase() === 'enable_thinking') {
      const info = modelInfoService.getModelInfoByName(currentModelName)
      const declared = (info?.supportedParameters ?? []).find(p => p.name === paramKey.toLowerCase())
      if (!declared) {
        process.stdout.write(`当前模型 ${currentModelName} 不支持参数 ${paramKey}（卡片未声明）\n`)
        return
      }
      if (declared.name === 'reasoning_effort') {
        const enumValues = declared.enumValues ?? []
        if (!enumValues.includes(paramValue)) {
          process.stdout.write(`无效取值: ${paramValue}\n`)
          process.stdout.write(`合法档位: ${enumValues.join(' / ')}\n`)
          return
        }
        parsedValue = paramValue
      } else if (typeof parsedValue !== 'boolean') {
        process.stdout.write('enable_thinking 只接受 true / false\n')
        return
      }
    }

    const currentParams = SelectedModelsService.getInstance().getModelParameters(currentModelName) || {}
    currentParams[paramKey] = parsedValue
    SelectedModelsService.getInstance().saveModelParameterSettings({
      modelName: currentModelName,
      parameters: currentParams
    })
    process.stdout.write(`已设置 ${paramKey} = ${parsedValue}（模型: ${currentModelName}）\n`)
    return
  }

  if (sub === 'unset') {
    const paramKey = parts[2]
    if (!paramKey) {
      process.stdout.write('用法: /config unset <参数名>\n')
      return
    }
    const currentParams = SelectedModelsService.getInstance().getModelParameters(currentModelName)
    if (currentParams && paramKey in currentParams) {
      delete currentParams[paramKey]
      SelectedModelsService.getInstance().saveModelParameterSettings({
        modelName: currentModelName,
        parameters: currentParams
      })
      process.stdout.write(`已移除 ${paramKey}（模型: ${currentModelName}）\n`)
    } else {
      process.stdout.write(`参数 ${paramKey} 不存在\n`)
    }
    return
  }

  process.stdout.write('用法:\n')
  process.stdout.write('  /config                    查看当前模型参数\n')
  process.stdout.write('  /config show               查看当前模型参数\n')
  process.stdout.write('  /config set <参数名> <值>   设置参数\n')
  process.stdout.write('  /config unset <参数名>      移除参数\n')
  process.stdout.write('常用参数: max_tokens, temperature, top_p, thinking, reasoning_effort\n')
}

/** 双轨提问：TUI 活跃时经 TUI 消息区 presentAsk（rl 已 pause，直接 rl.question 会挂死），否则 rl.question */
async function askUser(
  question: string,
  options: { label: string; description: string }[],
  allowFreeText: boolean,
  cliPrompt: string
): Promise<string> {
  if (isTuiActive() && hasAskPresenter()) {
    const answer = await presentAsk(question, options, allowFreeText)
    return answer ?? ''
  }
  return new Promise<string>((resolve) => {
    rl.question(cliPrompt, resolve)
  })
}

/**
 * 恢复写回后使 executor 的文档快照缓存失效（否则下次 insert/replace 会拿过期快照做锚点匹配）。
 * core executor.invalidateSnapshot 为公开方法，直调。
 */
function invalidateDocSnapshot(absPath: string): void {
  try {
    ctx.builtInExecutor.invalidateSnapshot(absPath)
  } catch { /* 缓存失效失败不阻断恢复结果 */ }
}

/** 集中备份条目显示行：时间 · 工具名 · 大小（existed=false 为撤销创建语义：恢复到该条 = 文件移回收站） */
function formatBackupEntry(entry: BackupEntry, index: number): string {
  const time = new Date(entry.ts).toLocaleString()
  const size = entry.existed ? ` · ${(entry.sizeBytes / 1024).toFixed(1)}KB` : ''
  const undoCreate = entry.existed ? '' : ' ·（创建前状态：恢复 = 文件移回收站）'
  return `  [${index + 1}] ${time} · ${entry.toolName}${size}${undoCreate}`
}

async function handleRestore(input: string): Promise<void> {
  const parts = input.trim().split(/\s+/)
  const filePath = parts[1]

  // 无参 → 轮次级模式：列出本会话最近写入轮次，整轮回滚
  if (!filePath) {
    await handleRestoreTurns()
    return
  }

  const absolutePath = resolve(filePath)

  // 数据源 1：集中备份库（~/.chill/backups/，倒序）
  let entries: BackupEntry[] = []
  try {
    entries = await ctx.backupStore.list(absolutePath)
  } catch { /* 集中存储读取异常时回退旧格式扫描 */ }

  // 数据源 2（只读兼容）：集中存储无记录时回退扫同目录旧散落 .backup-*，不迁移不删除用户文件
  if (entries.length === 0) {
    await handleRestoreLegacy(filePath, absolutePath)
    return
  }

  process.stdout.write(`\n${filePath} 的备份版本:\n`)
  for (let i = 0; i < entries.length; i++) {
    process.stdout.write(formatBackupEntry(entries[i], i) + '\n')
  }
  process.stdout.write('\n')

  const choice = await askUser(
    '选择要恢复的版本（回车取消）: ',
    entries.map((e, i) => ({ label: String(i + 1), description: formatBackupEntry(e, i).trim() })),
    true,
    '选择要恢复的版本编号 (或回车取消): '
  )
  const trimmed = choice.trim()
  if (trimmed === '') {
    return
  }
  const idx = parseInt(trimmed, 10)
  if (isNaN(idx) || idx < 1 || idx > entries.length) {
    process.stdout.write('无效的选择\n')
    return
  }
  const selected = entries[idx - 1]

  process.stdout.write(`\n将用 ${new Date(selected.ts).toLocaleString()} 的备份覆盖 ${filePath}（覆盖前会自动留存现状快照）\n`)
  const confirm = await askUser(
    '确认覆盖? ',
    [
      { label: 'N', description: '取消' },
      { label: 'y', description: '确认覆盖（覆盖前会自动留存现状快照）' },
    ],
    false,
    '确认覆盖? [y/N]: '
  )
  if (confirm.trim().toLowerCase() !== 'y') {
    return
  }

  // core restore 内部已先对当前文件再拍一份 pre-image（回滚可再回滚）
  const result = await ctx.backupStore.restore(absolutePath, selected.ts)
  if (result.restored) {
    invalidateDocSnapshot(absolutePath)
    process.stdout.write(`✓ 已恢复 ${filePath}\n`)
    if (result.warning) process.stdout.write(`⚠ ${result.warning}\n`)
  } else {
    process.stdout.write(`恢复失败: ${result.error || '未知错误'}\n`)
  }
}

/** 轮次级恢复（/restore 无参）：本会话最近写入轮次 → 编号选择 → 确认 → 整轮回滚 */
async function handleRestoreTurns(): Promise<void> {
  const sessionId = chatService.getSessionId()
  if (!sessionId) {
    process.stdout.write('当前会话尚无备份记录（会话未落盘或本轮无文件写入）\n')
    return
  }

  let turns: TurnGroup[] = []
  try {
    turns = await ctx.backupStore.listTurns(sessionId)
  } catch { /* 读取异常按无记录处理 */ }

  if (turns.length === 0) {
    process.stdout.write('本会话暂无备份记录\n')
    return
  }

  const describe = (t: TurnGroup): string => {
    const time = new Date(t.lastTs).toLocaleString()
    const tools = t.toolNames.length > 0 ? t.toolNames.join('/') : '未知工具'
    const taskMark = t.taskId ? ' ·（后台任务）' : ''
    return `${time} · ${t.files.length} 个文件 · ${tools}${taskMark}`
  }
  process.stdout.write('\n本会话最近的写入轮次（整轮回滚到写前状态）:\n')
  turns.forEach((t, i) => {
    process.stdout.write(`  [${i + 1}] ${describe(t)}\n`)
  })
  process.stdout.write('\n')

  const choice = await askUser(
    '选择要回滚的轮次（回车取消）: ',
    turns.map((t, i) => ({ label: String(i + 1), description: describe(t) })),
    true,
    '选择要回滚的轮次编号 (或回车取消): '
  )
  const trimmed = choice.trim()
  if (trimmed === '') {
    return
  }
  const idx = parseInt(trimmed, 10)
  if (isNaN(idx) || idx < 1 || idx > turns.length) {
    process.stdout.write('无效的选择\n')
    return
  }
  const selected = turns[idx - 1]

  const confirm = await askUser(
    `将恢复该轮 ${selected.files.length} 个文件到写前状态，确认? `,
    [
      { label: 'N', description: '取消' },
      { label: 'y', description: '确认回滚（恢复前会自动留存各文件现状快照）' },
    ],
    false,
    `将恢复该轮 ${selected.files.length} 个文件，确认? [y/N]: `
  )
  if (confirm.trim().toLowerCase() !== 'y') {
    return
  }

  // restoreTurn 内部对每个文件仍先拍现状快照（整轮回滚同样可再回滚）
  const result = await ctx.backupStore.restoreTurn(sessionId, selected.turnId ?? '', selected.taskId)
  for (const f of result.restored) {
    invalidateDocSnapshot(f)
    process.stdout.write(`✓ 已恢复 ${f}\n`)
  }
  for (const e of result.errors) {
    process.stdout.write(`✗ ${e}\n`)
  }
  if (result.restored.length === 0 && result.errors.length === 0) {
    process.stdout.write('该轮次没有可恢复的文件\n')
  }
  // 回滚后模型感知对齐（合成消息约定：数据层 synthetic 标记、内容对模型一字不动）——
  // 否则对话历史里 AI「我改了这些文件」的陈述会让模型基于错误认知继续操作
  if (result.restored.length > 0) {
    const label = selected.taskId ? `后台任务（${selected.files.length} 个文件）` : `该轮（${selected.files.length} 个文件）`
    chatService.getEngine().appendSyntheticMessage(
      `（用户已将${label}恢复为写前状态，涉及文件：${result.restored.join('、')}。此后这些文件的磁盘内容以恢复后的版本为准，此前的修改已不存在。）`,
      'backupRestore'
    )
  }
}

/** 旧散落 .backup-* 只读兼容恢复（集中存储无记录时的回退路径；保持原有"读出→写回"语义） */
async function handleRestoreLegacy(filePath: string, absolutePath: string): Promise<void> {
  const dir = dirname(absolutePath)
  const baseName = basename(absolutePath)

  const listResult = await ctx.fsProvider.listDirectory(dir)
  if (!listResult.success || !listResult.data?.files) {
    process.stdout.write('无法读取目录\n')
    return
  }

  const backups = listResult.data.files
    .filter((f: any) => f.type === 'file' && f.name.startsWith(`${baseName}.backup-`))
    .sort((a: any, b: any) => (b.name || '').localeCompare(a.name || ''))

  if (backups.length === 0) {
    process.stdout.write(`未找到 ${filePath} 的备份文件\n`)
    return
  }

  process.stdout.write(`\n${filePath} 的备份版本（旧格式，同目录散落文件）:\n`)
  for (let i = 0; i < backups.length; i++) {
    process.stdout.write(`  [${i + 1}] ${backups[i].name}\n`)
  }

  process.stdout.write('\n')
  const choice = await askUser(
    '选择要恢复的版本（回车取消）: ',
    backups.map((b: any, i: number) => ({ label: String(i + 1), description: b.name })),
    true,
    '选择要恢复的版本编号 (或回车取消): '
  )
  const trimmed = choice.trim()
  if (trimmed === '') {
    return
  }
  const idx = parseInt(trimmed, 10)
  if (isNaN(idx) || idx < 1 || idx > backups.length) {
    process.stdout.write('无效的选择\n')
    return
  }
  const selected = backups[idx - 1]
  const backupPath = join(dir, selected.name)

  process.stdout.write(`\n将用 ${selected.name} 覆盖 ${filePath}\n`)
  const confirm = await askUser(
    '确认覆盖? ',
    [
      { label: 'N', description: '取消' },
      { label: 'y', description: '确认覆盖' },
    ],
    false,
    '确认覆盖? [y/N]: '
  )
  if (confirm.trim().toLowerCase() !== 'y') {
    return
  }

  const readResult = await ctx.fsProvider.readFile(backupPath)
  if (!readResult.success || readResult.data?.content == null) {
    process.stdout.write('读取备份文件失败\n')
    return
  }

  const writeResult = await ctx.fsProvider.writeFile(absolutePath, readResult.data.content)
  if (writeResult.success) {
    invalidateDocSnapshot(absolutePath)
    process.stdout.write(`✓ 已恢复 ${filePath}\n`)
  } else {
    process.stdout.write(`恢复失败: ${writeResult.error}\n`)
  }
}

function printSessionUsage(): void {
  process.stdout.write('用法:\n')
  process.stdout.write('  /session [list]        列出会话（序号、标题、更新时间、消息数，按更新时间倒序）\n')
  process.stdout.write('  /session new           开始新会话（旧会话已自动保存）\n')
  process.stdout.write('  /session rename <标题> 重命名当前会话\n')
  process.stdout.write('  /session load <序号>   恢复指定会话到当前上下文\n')
  process.stdout.write('  /session delete <序号> 删除指定会话\n')
}

async function handleSession(input: string): Promise<void> {
  const parts = input.trim().split(/\s+/)
  const sub = (parts[1] || '').toLowerCase()

  if (sub === '' || sub === 'list') {
    const result = await sessionService.list()
    if (!result.success || !result.records) {
      process.stdout.write(`读取会话列表失败: ${result.error || '未知错误'}\n`)
      return
    }
    if (result.records.length === 0) {
      process.stdout.write('暂无会话记录\n')
      return
    }
    const currentId = chatService.getSessionId()
    // 无数量上限配套：只显示最近 20 条，序号仍按全量排序编号
    const MAX_DISPLAY = 20
    process.stdout.write('\n会话列表:\n')
    if (sessionService.isPreview) {
      process.stdout.write('（体验窗口：会话保存在 workcopy 内，随版本切换/放弃自动清理，不进正式版列表）\n')
    }
    process.stdout.write('\n')
    result.records.slice(0, MAX_DISPLAY).forEach((record, i) => {
      const date = new Date(record.updatedAt).toLocaleString()
      const current = record.id === currentId ? '（当前）' : ''
      process.stdout.write(`  ${i + 1}. ${record.title}${current}\n`)
      process.stdout.write(`     ${date} · ${record.messages.length} 条消息\n`)
    })
    if (result.records.length > MAX_DISPLAY) {
      process.stdout.write(`\n  …还有 ${result.records.length - MAX_DISPLAY} 条更早的会话\n`)
    }
    process.stdout.write('\n')
    return
  }

  if (sub === 'new') {
    if (isChatting) {
      process.stdout.write('当前对话进行中，请完成后再操作\n')
      return
    }
    chatService.startNewSession()
    // 任务清单随会话切换清空（跟踪器 + TUI 活动区，不入史）
    clearTodoList()
    // watch 跟随：旧 id 已失效，先停 watch；新 id 待首次落盘生成后由 onMessagesChanged 接线重挂
    followWatch(chatService.getSessionId())
    process.stdout.write('已开始新会话（旧会话已自动保存，可用 /session 查看）\n')
    return
  }

  if (sub === 'rename') {
    const title = input.trim().slice('/session rename'.length).trim()
    if (!title) {
      process.stdout.write('用法: /session rename <标题>\n')
      return
    }
    const currentId = chatService.getSessionId()
    if (!currentId) {
      process.stdout.write('当前没有进行中的会话\n')
      return
    }
    const result = await sessionService.rename(currentId, title)
    if (!result.success) {
      process.stdout.write(`${result.error}\n`)
      return
    }
    process.stdout.write(`已命名为「${title}」\n`)
    return
  }

  if (sub === 'load') {
    if (isChatting) {
      process.stdout.write('当前对话进行中，请完成后再操作\n')
      return
    }
    const n = Number(parts[2])
    if (!parts[2] || !Number.isInteger(n) || n < 1) {
      printSessionUsage()
      return
    }
    const record = await sessionService.resolveByIndex(n)
    if (!record) {
      const listed = await sessionService.list()
      process.stdout.write(`无效序号: ${n}（共 ${listed.records?.length ?? 0} 条会话）\n`)
      printSessionUsage()
      return
    }
    await chatService.reloadSession(record.id)
    // 任务清单随会话切换清空（跟踪器 + TUI 活动区，不入史）
    clearTodoList()
    // watch 跟随新会话 id（UI 租赁未启用时为空操作）
    followWatch(chatService.getSessionId())
    process.stdout.write(`已恢复会话「${record.title}」（${record.messages.length} 条消息）\n`)
    return
  }

  if (sub === 'delete') {
    const n = Number(parts[2])
    if (!parts[2] || !Number.isInteger(n) || n < 1) {
      printSessionUsage()
      return
    }
    const result = await sessionService.deleteByIndex(n)
    if (!result.success) {
      process.stdout.write(`${result.error || '删除失败'}\n`)
      printSessionUsage()
      return
    }
    // 删的是当前会话：引擎 detachSession（清记录 id、保留历史），继续对话将作为新会话记录保存
    if (result.deletedId && result.deletedId === chatService.getSessionId()) {
      chatService.detachSession()
      process.stdout.write('（删除的是当前会话，继续对话将开始新的会话记录）\n')
    }
    // 停掉失效 id 的 watch，避免把自己的删除误报为对端删除
    followWatch(chatService.getSessionId())
    process.stdout.write(`已删除会话「${result.title}」\n`)
    return
  }

  printSessionUsage()
}

async function handleMemory(input: string): Promise<void> {
  const parts = input.trim().split(/\s+/)
  const sub = parts[1] || 'list'

  const printUsage = () => {
    process.stdout.write('用法: /memory [list] | /memory show <标题> | /memory delete <标题>\n')
  }

  if (sub === 'list') {
    const entries = await memoryStore.list()
    if (entries.length === 0) {
      process.stdout.write('暂无长期记忆（对话中说"记住……"可让模型保存，或经 save_memory 工具写入）\n')
      return
    }
    const sorted = entries
      .map(e => ({ e, score: memoryDecayScore(e) }))
      .sort((a, b) => b.score - a.score)
    process.stdout.write(`长期记忆（${sorted.length} 条，按相关度排序，目录: ${memoryStore.memoryDir()}）:\n`)
    sorted.forEach(({ e }, i) => {
      const hook = e.hook ? ` — ${e.hook.slice(0, 50)}` : ''
      process.stdout.write(`  ${i + 1}. [${e.type}] ${e.name}${hook}（更新于 ${e.updated_at.slice(0, 10)}，重要度 ${e.importance}，被引用 ${e.usage_count} 次）\n`)
    })
    return
  }

  if (sub === 'show') {
    const title = parts.slice(2).join(' ')
    if (!title) {
      printUsage()
      return
    }
    const entries = await memoryStore.list()
    const target = entries.find(e => e.name.toLowerCase() === title.toLowerCase())
    if (!target) {
      process.stdout.write(`未找到记忆: ${title}\n`)
      return
    }
    process.stdout.write(`【${target.type}】${target.name}\n文件: ${target.filePath}\n创建: ${target.created_at} | 更新: ${target.updated_at} | 最近使用: ${target.last_used_at} | 被引用 ${target.usage_count} 次 | 重要度 ${target.importance}\n\n${target.body}\n`)
    return
  }

  if (sub === 'delete') {
    const title = parts.slice(2).join(' ')
    if (!title) {
      printUsage()
      return
    }
    const result = await memoryStore.remove(title)
    process.stdout.write(result.success ? `已删除记忆「${title}」\n` : `${result.error}\n`)
    return
  }

  printUsage()
}

/** /hooks 命令族：生命周期 hook 的查看/启停/触发记录/自然语言创建。
    判定与状态全部在 core 的 HookRunner/HookConfigLoader（此处纯文本展示，显示分离） */
async function handleHooks(input: string): Promise<void> {
  const runner = ctx.hookRunner
  const loader = ctx.hookConfigLoader

  const printUsage = () => {
    process.stdout.write('用法:\n')
    process.stdout.write('  /hooks [list]        列出已配置的 hook（事件/matcher/命令/启用状态/来源/信任状态）\n')
    process.stdout.write('  /hooks enable <id>   启用指定 hook（id 见 /hooks list；只写 name 且唯一匹配也可）\n')
    process.stdout.write('  /hooks disable <id>  禁用指定 hook（状态存 ~/.chill/state.json，不改 hooks.json）\n')
    process.stdout.write('  /hooks log           最近 50 次触发记录（事件/handler/耗时/exit code/决策）\n')
    process.stdout.write('  /hooks add <描述>    自然语言描述需求，由 hook-author 技能生成并安装 hook\n')
  }

  // 子命令之后的参数整体按原文取（id 可能是 "事件:命令" 整串、add 的描述含空格，不能按空白切）
  const trimmed = input.trim()
  const sub = trimmed === '/hooks' ? 'list' : (trimmed.split(/\s+/)[1] || '')
  const rest = trimmed === '/hooks' ? '' : trimmed.slice('/hooks'.length).trim().slice(sub.length).trim()

  if (sub === 'list') {
    const config = await loader.checkReload()
    for (const err of loader.getErrors()) {
      process.stdout.write(`  [配置警告] ${err}\n`)
    }
    // 来源与信任状态（阶段 2）：loader 为每个 handler 标注 source（user/project + 路径），
    // 项目级另标 trust（trusted/new/changed；用户级恒 undefined = 默认可信）
    const describeSource = (h: { source?: { kind: 'user' | 'project'; path: string }; trust?: 'trusted' | 'new' | 'changed' }): string => {
      if (!h.source || h.source.kind === 'user') return `用户级 ${h.source?.path ?? ctx.hooksConfigPath}（可信）`
      if (h.trust === 'trusted') return `项目级 ${h.source.path}（可信）`
      if (h.trust === 'changed') return `项目级 ${h.source.path}（未信任：定义已变更，批准后才会执行）`
      return `项目级 ${h.source.path}（未信任：首见，批准后才会执行）`
    }
    const rows: Array<{ id: string; event: string; matcher?: string; name?: string; command: string; timeout?: number; failClosed?: boolean; enabled: boolean; sourceText: string }> = []
    for (const [event, groups] of Object.entries(config)) {
      for (const group of groups ?? []) {
        for (const handler of group.hooks) {
          const id = runner.handlerId(event as HookEvent, handler)
          rows.push({ id, event, matcher: group.matcher, name: handler.name, command: handler.command, timeout: handler.timeout, failClosed: handler.failClosed, enabled: runner.isEnabled(id), sourceText: describeSource(handler) })
        }
      }
    }
    if (rows.length === 0) {
      process.stdout.write(`\n暂无已配置的 hook（配置文件: ${ctx.hooksConfigPath}）\n`)
      process.stdout.write('创建方式: /hooks add <自然语言描述>（如 /hooks add 每次写完文件跑一遍 eslint --fix）\n\n')
      return
    }
    process.stdout.write(`\n已配置 ${rows.length} 个 hook:\n\n`)
    for (const r of rows) {
      process.stdout.write(`  [${r.enabled ? '启用' : '禁用'}] ${r.id}\n`)
      process.stdout.write(`    来源: ${r.sourceText}\n`)
      process.stdout.write(`    matcher: ${r.matcher === undefined || r.matcher === '' ? '（全匹配）' : r.matcher}\n`)
      process.stdout.write(`    command: ${r.command}（timeout ${r.timeout ?? 30}s，${r.failClosed ? 'failClosed' : 'fail-open'}）\n\n`)
    }
    return
  }

  if (sub === 'enable' || sub === 'disable') {
    if (!rest) {
      process.stdout.write(`用法: /hooks ${sub} <id>（id 见 /hooks list）\n`)
      return
    }
    const id = await resolveHookId(rest)
    if (!id) return
    if (sub === 'enable') {
      runner.enable(id)
      process.stdout.write(`已启用 ${id}\n`)
    } else {
      runner.disable(id)
      process.stdout.write(`已禁用 ${id}\n`)
    }
    return
  }

  if (sub === 'log') {
    const invocations = runner.getRecentInvocations()
    if (invocations.length === 0) {
      process.stdout.write('\n暂无 hook 触发记录（hook 触发后此处保留最近 50 条）\n\n')
      return
    }
    process.stdout.write(`\n最近 ${invocations.length} 次 hook 触发（最新在前）:\n\n`)
    for (const inv of invocations) {
      const time = inv.at.slice(11, 19)
      const matcher = inv.matcher ? ` matcher=${inv.matcher}` : ''
      const error = inv.error ? ` 错误: ${inv.error}` : ''
      process.stdout.write(`  ${time} [${inv.event}] ${inv.handlerName}${matcher}\n`)
      process.stdout.write(`    决策: ${inv.decision ?? '-'}，exit=${inv.exitCode ?? 'null'}，耗时 ${inv.durationMs}ms${error}\n`)
    }
    process.stdout.write('\n')
    return
  }

  if (sub === 'add') {
    if (!rest) {
      process.stdout.write('用法: /hooks add <自然语言描述>（如 /hooks add 每次写完文件跑一遍 eslint --fix）\n')
      return
    }
    await handleHooksAdd(rest)
    return
  }

  printUsage()
}

/** 把 /hooks enable|disable 的参数解析为 HookRunner 的禁用标识（id = `事件:name（缺省 command)`）：
    全 id 精确命中优先；否则按 name/command 唯一匹配（list 里抄 id 太长时的便捷路径） */
async function resolveHookId(arg: string): Promise<string | null> {
  const runner = ctx.hookRunner
  const config = await ctx.hookConfigLoader.checkReload()
  const candidates: string[] = []
  for (const [event, groups] of Object.entries(config)) {
    for (const group of groups ?? []) {
      for (const handler of group.hooks) {
        candidates.push(runner.handlerId(event as HookEvent, handler))
      }
    }
  }
  if (candidates.includes(arg)) return arg
  const matched = candidates.filter((id) => id.slice(id.indexOf(':') + 1) === arg)
  if (matched.length === 1) return matched[0]
  if (matched.length > 1) {
    process.stdout.write(`"${arg}" 匹配到多个 hook，请使用完整 id:\n`)
    for (const id of matched) process.stdout.write(`  ${id}\n`)
    return null
  }
  process.stdout.write(`未找到 hook: ${arg}（/hooks list 查看已配置 hook 的 id）\n`)
  return null
}

/** /schedule 命令族：定时任务的查看与取消（仿 /hooks 命令族模式）。
    调度与持久化全部在 core 的 SchedulerService/TaskStore（此处纯文本展示，显示分离） */
async function handleSchedule(input: string): Promise<void> {
  const scheduler = ctx.scheduler
  const store = ctx.taskStore

  const printUsage = () => {
    process.stdout.write('用法:\n')
    process.stdout.write('  /schedule [list]      列出全部定时任务（id/cron/at/prompt/归属/下次触发/状态）\n')
    process.stdout.write('  /schedule cancel <id> 取消指定任务（id 见 /schedule list；唯一前缀匹配即可）\n')
    process.stdout.write('  创建方式: 直接对 chill 说（如"20 分钟后提醒我起来活动"），由 schedule_task 工具创建\n')
  }

  // 子命令之后的参数整体按原文取（id 唯一前缀，不能按空白切）
  const trimmed = input.trim()
  const sub = trimmed === '/schedule' ? 'list' : (trimmed.split(/\s+/)[1] || '')
  const rest = trimmed === '/schedule' ? '' : trimmed.slice('/schedule'.length).trim().slice(sub.length).trim()

  if (sub === 'list') {
    const tasks = await scheduler.list()
    for (const err of store.getErrors()) {
      process.stdout.write(`  [清单警告] ${err}\n`)
    }
    if (tasks.length === 0) {
      process.stdout.write(`\n暂无定时任务（清单文件: ${ctx.scheduledTasksPath}）\n`)
      process.stdout.write('创建方式: 直接对 chill 说（如"每天早上 9 点汇总昨天的 git 进展"）\n\n')
      return
    }
    process.stdout.write(`\n共 ${tasks.length} 个定时任务:\n\n`)
    for (const t of tasks) {
      const statusText = t.status === 'active' ? '调度中' : t.status === 'done' ? '已完结' : '调度中（orphaned：归属会话已删除，不再触发）'
      const scheduleText = t.recurring ? `cron: ${t.cron}` : `at: ${t.at}`
      const scopeText = t.scope === 'project' ? `项目级 ${t.workDir ?? ''}` : `会话级 ${t.sessionId ?? ''}`
      const promptSummary = t.prompt.length > 40 ? `${t.prompt.slice(0, 40)}…` : t.prompt
      const untilText = t.until ? `，截止 ${t.until}` : ''
      const lastRunText = t.lastRun
        ? `\n    最近执行: ${t.lastRun.outcome === 'completed' ? '完成' : '失败'} @ ${t.lastRun.firedAt}${t.lastRun.coalescedCount && t.lastRun.coalescedCount > 1 ? `（合并 ${t.lastRun.coalescedCount} 次）` : ''}`
        : ''
      process.stdout.write(`  [${statusText}] ${t.id}\n`)
      process.stdout.write(`    ${scheduleText}（下次触发: ${nextFireText(t)}，已触发 ${t.fireCount} 次${untilText}）${lastRunText}\n`)
      process.stdout.write(`    归属: ${scopeText}\n`)
      process.stdout.write(`    prompt: ${promptSummary}\n\n`)
    }
    return
  }

  if (sub === 'cancel') {
    if (!rest) {
      process.stdout.write('用法: /schedule cancel <id>（id 见 /schedule list；唯一前缀匹配即可）\n')
      return
    }
    const id = await resolveScheduleTaskId(rest)
    if (!id) return
    const ok = await scheduler.cancel(id)
    process.stdout.write(ok ? `已取消定时任务 ${id}\n` : `取消失败（/schedule list 查看 [清单警告] 明细）\n`)
    return
  }

  printUsage()
}

/** 下次触发时间显示：core previewNextFireMs 现算（含确定性 jitter，与调度判定同源） */
function nextFireText(task: ScheduledTask): string {
  if (task.status !== 'active') return '—'
  try {
    const ms = ctx.scheduler.previewNextFireMs(task)
    if (ms === null) return '（规则非法或已越过截止）'
    return `${new Date(ms).toLocaleString()}（约）`
  } catch {
    return '（规则非法）'
  }
}

/** 把 /schedule cancel 的参数解析为任务 id：全 id 精确命中优先；否则唯一前缀匹配，多义列候选 */
async function resolveScheduleTaskId(arg: string): Promise<string | null> {
  const tasks = await ctx.scheduler.list()
  const ids = tasks.map((t) => t.id)
  if (ids.includes(arg)) return arg
  const matched = ids.filter((id) => id.startsWith(arg))
  if (matched.length === 1) return matched[0]
  if (matched.length > 1) {
    process.stdout.write(`"${arg}" 匹配到多个任务，请使用更长的前缀或完整 id:\n`)
    for (const id of matched) process.stdout.write(`  ${id}\n`)
    return null
  }
  process.stdout.write(`未找到定时任务: ${arg}（/schedule list 查看任务 id）\n`)
  return null
}

/** /hooks add <描述>：与 /init 同法——把自然语言描述作为用户消息走普通对话路径，
    hook-author skill 接管生成与安装（脚本全文 + 挂载事件 + matcher 安装前经审批展示） */
async function handleHooksAdd(description: string): Promise<void> {
  // 同步设置标志，防止 'line' handler 过早显示 prompt
  suppressPrompt = true
  if (isChatting) {
    process.stdout.write('\n⚠ 正在处理中，请等待当前对话完成\n')
    suppressPrompt = false
    setPrompt(promptForMode())
    reprompt()
    return
  }
  isChatting = true
  try {
    // 与普通文本输入同一路径：发送前锚定磁盘记录，再交给 chatService.chat（无多媒体附件）
    await anchorFromDisk()
    await chatService.chat(
      `【创建 hook】${description}\n\n` +
      '（以上是用户的 hook 需求描述。请使用 hook-author skill 完成创建：理解意图 → 生成单文件 .mjs 脚本 → ' +
      '读-合并-写 hooks.json 配置；落盘前向我展示脚本全文、挂载事件与 matcher，经我确认后再写入。）'
    )
  } catch (err: any) {
    process.stdout.write(`\n错误: ${err?.message || err}\n`)
  } finally {
    isChatting = false
    suppressPrompt = false
    // 聊天/流式期间 watch 命中积压的对端同步，本轮结束后补做
    await flushPeerSync()
  }
  setPrompt(promptForMode())
  reprompt()
}

/** /init：把 INIT_AGENTS_MD_PROMPT 作为一条用户消息走普通对话路径提交，生成项目 AGENTS.md 初稿 */
async function handleInit(input: string): Promise<void> {
  if (input !== '/init') {
    process.stdout.write('用法: /init（不接受参数）\n')
    return
  }
  // 同步设置标志，防止 'line' handler 过早显示 prompt
  suppressPrompt = true
  if (isChatting) {
    process.stdout.write('\n⚠ 正在处理中，请等待当前对话完成\n')
    suppressPrompt = false
    setPrompt(promptForMode())
    reprompt()
    return
  }
  isChatting = true
  try {
    // 与普通文本输入同一路径：发送前锚定磁盘记录，再交给 chatService.chat（无多媒体附件）
    await anchorFromDisk()
    await chatService.chat(INIT_AGENTS_MD_PROMPT)
  } catch (err: any) {
    process.stdout.write(`\n错误: ${err?.message || err}\n`)
  } finally {
    isChatting = false
    suppressPrompt = false
    // 聊天/流式期间 watch 命中积压的对端同步，本轮结束后补做
    await flushPeerSync()
  }
  setPrompt(promptForMode())
  reprompt()
}

/** /setup：手动重开首次配置向导（force 绕过首用检测与跳过标记；输出直写，TUI 内由消息区捕获） */
async function handleSetup(): Promise<void> {
  suppressPrompt = true
  try {
    await runFirstRunWizard({ rl, kv: ctx.keyValueStore, printFinal: (t) => process.stdout.write(t), force: true })
  } finally {
    suppressPrompt = false
    setPrompt(promptForMode())
    reprompt()
  }
}

async function handleKey(input: string): Promise<void> {
  const parts = input.trim().split(/\s+/)
  const sub = parts[1] || ''

  const allProviders = providerManager.getAllProviders()

  if (sub === 'list') {
    const providers = await SecureStorageService.getAllProviders()
    if (providers.length === 0) {
      process.stdout.write('暂无已配置的 API Key\n')
      process.stdout.write('\n支持的模型提供商:\n')
      for (const p of allProviders) {
        const has = await SecureStorageService.hasApiKey(p.id)
        process.stdout.write(`  ${p.name} (${p.id})${' '.repeat(Math.max(1, 16 - p.name.length - p.id.length - 3))}${has ? '✓ 已配置' : '○ 未配置'}\n`)
        // 注册链接仅种子提供商有（单一事实源 = 种子卡 documentation）；自定义 provider 无链接不追加行
        const docUrl = getProviderDocUrl(p.name)
        if (docUrl) {
          process.stdout.write(`      获取 Key: ${docUrl}\n`)
        }
      }
      return
    }
    process.stdout.write('已配置的 API Key:\n')
    for (const p of providers) {
      process.stdout.write(`  ${providerManager.getDisplayName(p)} (${p})\n`)
    }
    return
  }

  if (sub === 'set') {
    // 定域语义（与 add_model 同槽位）：--url 显式定域；未给 --url 时域唯一才直写，
    // 多域列清单让用户选——禁止静默缺省到模板域（防多域写错地方）
    const rest = input.trim().split(/\s+/).slice(2)
    const urlIdx = rest.indexOf('--url')
    const url = urlIdx >= 0 ? rest[urlIdx + 1] : undefined
    const positional = rest.filter((_, i) => i !== urlIdx && i !== urlIdx + 1)
    const provider = positional[0]
    const apiKey = positional[1]
    if (!provider) {
      process.stdout.write('用法: /key set <provider> <apiKey> [--url <端点>]\n')
      process.stdout.write('支持的 provider（显示名或 id 均可）:\n')
      for (const p of allProviders) {
        process.stdout.write(`  ${p.name} (${p.id})\n`)
      }
      return
    }
    if (!apiKey) {
      process.stdout.write('请输入 API Key: /key set <provider> <apiKey> [--url <端点>]\n')
      return
    }
    const domains = url
      ? [resolveKeySlotId(provider, url)]
      : listKeySlotDomains(provider, modelInfoService.getAllModelInfos())
    if (domains.length > 1) {
      process.stdout.write(`${provider} 存在多个凭证域（通道），请用 --url 指定端点后重试:\n`)
      for (const d of domains) process.stdout.write(`  ${d}\n`)
      process.stdout.write(`例: /key set ${provider} <apiKey> --url <该通道端点>\n`)
      return
    }
    const slotId = domains[0]
    const existed = await SecureStorageService.hasApiKey(slotId)
    const ok = await SecureStorageService.storeApiKey(slotId, apiKey)
    if (ok) {
      const verb = existed ? '已更新' : '已保存'
      process.stdout.write(`${providerManager.getDisplayName(provider)} API Key ${verb}（域 ${slotId}）\n`)
    } else {
      process.stdout.write('API Key 保存失败\n')
    }
    return
  }

  if (sub === 'delete') {
    // 同 /key set 定域语义：唯一域直删，多域必须 --url 显式（通道 key 不再删不掉）
    const rest = input.trim().split(/\s+/).slice(2)
    const urlIdx = rest.indexOf('--url')
    const url = urlIdx >= 0 ? rest[urlIdx + 1] : undefined
    const positional = rest.filter((_, i) => i !== urlIdx && i !== urlIdx + 1)
    const provider = positional[0]
    if (!provider) {
      process.stdout.write('用法: /key delete <provider> [--url <端点>]\n')
      return
    }
    const domains = url
      ? [resolveKeySlotId(provider, url)]
      : listKeySlotDomains(provider, modelInfoService.getAllModelInfos())
    if (domains.length > 1) {
      process.stdout.write(`${provider} 存在多个凭证域（通道），请用 --url 指定端点后重试:\n`)
      for (const d of domains) process.stdout.write(`  ${d}\n`)
      return
    }
    const ok = await SecureStorageService.deleteApiKey(domains[0])
    if (ok) {
      process.stdout.write(`${providerManager.getDisplayName(provider)} API Key 已删除（域 ${domains[0]}）\n`)
    } else {
      process.stdout.write('API Key 删除失败（可能不存在）\n')
    }
    return
  }

  process.stdout.write('用法:\n')
  process.stdout.write('  /key list              查看已配置的 API Key\n')
  process.stdout.write('  /key set <provider> <key> [--url <端点>]  设置 API Key（多域通道需 --url 定域）\n')
  process.stdout.write('  /key delete <provider> [--url <端点>]  删除 API Key\n')
  process.stdout.write('\n支持的 provider:\n')
  for (const p of allProviders) {
    process.stdout.write(`  ${p.name} (${p.id})\n`)
  }
}

// 启动时检测自身位置和待切换状态（npm 模式 projectPath 为 null 时跳过）
{
  const __dirname = dirname(fileURLToPath(import.meta.url))

  if (__dirname.includes('chill-workcopy')) {
    startupOut('这是自迭代后的体验版本，在原版本中输入 /switch-version 切换，或 /discard-version 放弃。\n')
    // 自毁检测（M2.2，版本切换接续规划）：切换收尾会删除 workcopy——检测到即优雅退出本体验窗
    // （体验窗无 relay 可退——M2.1 不连；只需销毁后台 Worker 后退出，给 3s 让提示先落屏）
    const workcopyPath = join(projectPaths.parentDir, 'chill-workcopy')
    const previewCheckTimer = setInterval(() => {
      if (!existsSync(workcopyPath)) {
        clearInterval(previewCheckTimer)
        notify('\n⚠ 体验窗口对应的源码已被删除或切换（版本已切换/已放弃），本窗口将自动关闭。\n')
        setTimeout(() => { void destroyWorkersBeforeExit().finally(() => process.exit(0)) }, 3000)
      }
    }, 30000)
  } else if (projectPaths.projectPath !== null) {
    const readyForSwitchPath = join(projectPaths.parentDir, 'chill-workcopy', '.ready-for-switch')

    if (existsSync(readyForSwitchPath)) {
      try {
        const summary = readFileSync(readyForSwitchPath, 'utf-8')
        startupOut(`检测到已完成的自迭代（目标：${summary.split('\n')[0]}），输入 /switch-version 切换，或 /discard-version 放弃。\n`)
      } catch {}
    }

    // 上次版本切换失败/遗留通知（switcher 写入的诊断报告；severity:'warning' 表示切换成功但收尾清理未彻底）
    const failurePath = join(projectPaths.parentDir, 'chill-guardian', 'switch-failure.json')
    if (existsSync(failurePath)) {
      try {
        const f = JSON.parse(readFileSync(failurePath, 'utf-8'))
        if (f.severity === 'warning') {
          startupOut(`⚠ 上次版本切换已生效，但收尾清理有遗留（${f.time}）\n  步骤: ${f.step}\n  诊断: ${f.reason}\n  建议: ${f.guidance}\n`)
        } else {
          startupOut(`⚠ 上次版本切换失败（${f.time}）\n  步骤: ${f.step}\n  诊断: ${f.reason}\n  建议: ${f.guidance}\n`)
        }
      } catch {}
    }
  }
}

// Banner — 5×5 纯 █ 像素字体，莫兰迪单色（低饱和青灰），6 列等宽栅格
const R = '\x1b[0m'
const D = '\x1b[2m'
const BANNER_COLOR = '\x1b[38;5;67m'
const chars = {
  C: [' ███ ','█   █','█    ','█   █',' ███ '],
  H: ['█   █','█   █','█████','█   █','█   █'],
  I: [' ███ ','  █  ','  █  ','  █  ',' ███ '],
  L: ['█    ','█    ','█    ','█    ','████ '],
}
const bannerLetters = ['C', 'H', 'I', 'L', 'L'] as const
for (let r = 0; r < 5; r++) {
  const row = bannerLetters.map(ch => chars[ch][r].padEnd(6)).join('').trimEnd()
  startupOut(`  ${BANNER_COLOR}${row}${R}\n`)
}
startupOut(`\n${D}  直接输入开始 · /help 查看全部命令${R}\n`)
// AGENTS.md 约束加载提示：全局（~/.chill）+ 当前工作目录，存在才打印（与 /session load 一行摘要同范式）
try {
  const activeFiles = await agentInstructions.listActiveFiles(process.cwd())
  if (activeFiles.length > 0) {
    startupOut(`${D}  约束: ${activeFiles.join(', ')}${R}\n`)
  }
} catch { /* 检测失败不影响启动 */ }
startupOut('\n')

/**
 * REPL 行处理（命令分发 + 聊天）：rl.on('line') 与 TUI 命令分发共用。
 * 自原 rl.on('line') 回调原样提取，逻辑不变；TUI 经 tuiState 注册复用，
 * 输出由 tuiShell 捕获进消息区。
 */
async function handleReplInput(rawLine: string): Promise<void> {
  const input = rawLine.trim()

  await handleLine(input)

  if (input === '/exit') {
    return
  }

  if (input === '/switch-version') {
    const projectPath = projectPaths.projectPath
    if (projectPath === null) {
      process.stdout.write('当前为 npm 模式（源码未安装），无法切换版本。输入 /fetch-source 可开启自迭代。\n')
      setPrompt(promptForMode())
      reprompt()
      return
    }
    const parentDir = projectPaths.parentDir
    const guardianPath = join(parentDir, 'chill-guardian', 'switcher.js')
    const workcopyPath = join(parentDir, 'chill-workcopy')
    const readyForSwitchPath = join(workcopyPath, '.ready-for-switch')

    // === 调试日志 ===
    const switchLogPath = join(parentDir, 'chill-guardian', 'runtime.log')
    const switchLog = (msg: string) => {
      const ts = new Date().toISOString()
      appendFileSync(switchLogPath, `[${ts}] [/switch-version] ${msg}\n`)
    }
    switchLog('=== /switch-version 命令触发 ===')
    switchLog(`guardianPath: ${guardianPath}`)
    switchLog(`projectPath: ${projectPath}`)
    switchLog(`workcopyPath: ${workcopyPath}`)
    switchLog(`workcopy 是否存在: ${existsSync(workcopyPath)}`)
    switchLog(`.ready-for-switch 是否存在: ${existsSync(readyForSwitchPath)}`)
    switchLog(`switcher.js 是否存在: ${existsSync(guardianPath)}`)

    if (!existsSync(workcopyPath) || !existsSync(readyForSwitchPath)) {
      switchLog('[FAIL] workcopy 或 .ready-for-switch 不存在，取消切换')
      eventBus.emit('chill:switch-progress', '未检测到待切换的版本。请先完成自迭代。')
      setPrompt(promptForMode())
      reprompt()
      return
    }

    let summary = ''
    try {
      summary = readFileSync(readyForSwitchPath, 'utf-8')
      switchLog(`.ready-for-switch 内容: ${summary.substring(0, 200)}`)
    } catch {
      switchLog('[FAIL] 读取 .ready-for-switch 失败')
      eventBus.emit('chill:switch-progress', '读取版本信息失败。')
      setPrompt(promptForMode())
      reprompt()
      return
    }

    eventBus.emit('chill:switch-progress', `待切换版本信息：\n${summary}\n正在执行版本切换（通常 10~30 秒）...`)

    switchLog('同步执行 switcher...')
    isChatting = true
    const switchResult = await runSwitcher(guardianPath, [projectPath], switchLog)
    switchLog(`switcher 结果: ${JSON.stringify(switchResult)}`)
    isChatting = false

    if (switchResult?.timeout) {
      eventBus.emit('chill:switch-progress', 'switcher 执行超过 300 秒仍未完成（可能 pnpm install 较慢）。稍后请查看 chill-guardian/switch-failure.json 确认结果。')
      setPrompt(promptForMode())
      reprompt()
      return
    }

    if (switchResult?.success) {
      // 清理本轮 workcopy 的过程性快照（最终态已由版本树承接；purgePrefix 是通用原语，
      // 备份系统对版本概念零感知——谁删除真相源目录树，谁负责清理其衍生快照）
      try {
        const purge = await ctx.backupStore.purgePrefix(join(projectPaths.parentDir, 'chill-workcopy'))
        if (purge.removed > 0) {
          eventBus.emit('chill:switch-progress', `已清理 workcopy 的 ${purge.removed} 份过程性备份快照`)
        }
      } catch { /* 快照清理失败不影响切换结果 */ }
      eventBus.emit('chill:switch-progress', `✓ 切换成功，新版本 ${switchResult.version ?? ''} 已就位。新窗口已打开。`)
      if (switchResult.warning) {
        eventBus.emit('chill:switch-progress', `⚠ 收尾清理未彻底：${switchResult.warning}。可手动处理，下次启动会再次提示。`)
      }
      switchLog('切换成功，发换版事件（接续统一收敛：CLI=订阅器先开新窗；serve=自退+小助手拉起）')
      // M1.6：无条件发事件——订阅器统一开接续窗；TUI 复用同事件走 exitTui；M1.10 后无 bounce
      eventBus.emit('chill:switch-succeeded', { projectPath, version: switchResult.version })

      if (!isTuiActive()) {
        // CLI 模式：直接退出（无 alt-screen 问题）
        eventBus.emit('chill:switch-progress', '本窗口将在 5 秒后自动关闭...')
        setTimeout(() => {
          switchLog('CLI 进程即将退出（5秒定时器触发）')
          // 退出前显式交接：退租 relay（新窗口经等待态自动接管）+ 销毁后台 Worker
          void destroyWorkersBeforeExit().finally(() => process.exit(0))
        }, 5000)
      }
      return
    }

    switchLog(`[FAIL] 切换失败: ${JSON.stringify(switchResult)}`)
    eventBus.emit('chill:switch-progress', `✗ 版本切换失败。\n失败步骤: ${switchResult?.step ?? '未知'}\n诊断: ${switchResult?.reason ?? '未知原因'}\n建议: ${switchResult?.guidance ?? '查看 chill-guardian/switcher-debug.log'}\n处理后可重新输入 /switch-version 重试。`)
    setPrompt(promptForMode())
    reprompt()
    return
  }

  if (input === '/discard-version') {
    if (projectPaths.projectPath === null) {
      process.stdout.write('当前为 npm 模式（源码未安装），没有可放弃的自迭代版本。\n')
      setPrompt(promptForMode())
      reprompt()
      return
    }
    const workcopyPath = join(projectPaths.parentDir, 'chill-workcopy')

    if (!existsSync(workcopyPath)) {
      process.stdout.write('未检测到待切换的版本。\n')
      setPrompt(promptForMode())
      reprompt()
      return
    }

    try {
      // 预摘 target junction（自迭代共享编译缓存链接）：rmdirSync 对 junction 只删链接不进目标，
      // 防止下方 PowerShell 5.1 的 Remove-Item -Recurse 遍历进共享缓存误删（非 junction/不存在则忽略）
      const targetJunction = join(workcopyPath, 'packages', 'native-desktop', 'target')
      try { rmdirSync(targetJunction) } catch { /* 非 junction 或不存在，忽略 */ }
      execSync(`powershell -Command "Remove-Item -Path '${workcopyPath}' -Recurse -Force"`, {
        stdio: 'pipe',
        timeout: 30000,
      })
      // 同步清理 workcopy 前缀的过程性备份快照（备份系统对版本零感知，由删除者清理衍生快照）
      try {
        await ctx.backupStore.purgePrefix(workcopyPath)
      } catch { /* 快照清理失败不影响放弃结果 */ }
      process.stdout.write('已放弃版本切换，workcopy 已清理。\n')
    } catch (err: any) {
      process.stdout.write(`✗ 删除失败：${err.stderr?.toString() || err.message}\n`)
      process.stdout.write('  请关闭体验窗口后重试。\n')
    }
    setPrompt(promptForMode())
    reprompt()
    return
  }

  if (input === '/help' || input === '/tasks' || input.startsWith('/tasks cancel') || input === '/skill' || input === '/skill list' || input === '/skill reload' || input.startsWith('/skill enable ') || input.startsWith('/skill disable ') || input.startsWith('/skill export ') || input.startsWith('/skill update ') || input.startsWith('/skill uninstall ') || input.startsWith('/skill install ') || input === '/desktop' || input === '/desktop on' || input === '/desktop off' || input === '/desktop log' || input.startsWith('/desktop audit') || input === '/tools' || input.startsWith('/tools ') || input === '/mcp' || input === '/workflow' || input === '/ui' || input === '/setup' || input === '/key' || input.startsWith('/key ') || input === '/model' || input.startsWith('/model ') || input.startsWith('/auto-apply') || input === '/add-dir' || input.startsWith('/add-dir ') || input.startsWith('/auto-switch') || input.startsWith('/config') || input === '/limits' || input.startsWith('/limits ') || input === '/team' || input.startsWith('/team ') || input.startsWith('/restore') || input === '/session' || input.startsWith('/session ') || input === '/memory' || input.startsWith('/memory ') || input === '/hooks' || input.startsWith('/hooks ') || input === '/schedule' || input.startsWith('/schedule ') || input === '/init' || input.startsWith('/init ') || input === '/tui' || input === '/cli' || input === '/switch-version' || input === '/discard-version' || input === '/fetch-source' || input === '/use-npm' || input === '/use-self' || input === '/plan' || input === '/plan off' || input === '/goal' || input.startsWith('/goal ') || input === '/pair' || input.startsWith('/pair ') || input === '/relay' || input.startsWith('/relay ') || input === '/send' || input.startsWith('/send ') || input === '/compact' || input.startsWith('/compact ') || input === '/front' || input.startsWith('/front ') || input === '/rollback' || input === '/r' || input.startsWith('/rollback ') || input.startsWith('/r ') || input === '/delete-version' || input.startsWith('/delete-version ') || (input === '/back' && chatService.mode === 'auto')) {
    if (!suppressPrompt) {
      setPrompt(promptForMode())
      reprompt()
    }
    return
  }

  if (input === '' && chatService.mode !== 'mcp') {
    setPrompt(promptForMode())
    reprompt()
    return
  }

  if (isChatting) {
    process.stdout.write('\n⚠ 正在处理中，请等待当前对话完成\n')
    setPrompt(promptForMode())
    reprompt()
    return
  }

  isChatting = true
  try {
    if (chatService.mode === 'mcp') {
      try {
        const customPrompt = await mcpService.handleCommand(input)
        setPrompt(customPrompt || promptForMode())
      } catch (err: any) {
        process.stdout.write(`\n错误: ${err?.message || err}\n`)
        setPrompt(promptForMode())
      }
    } else if (chatService.mode === 'workflow') {
      try {
        await workflowService.handleCommand(input)
        setPrompt(promptForMode())
      } catch (err: any) {
        process.stdout.write(`\n错误: ${err?.message || err}\n`)
        setPrompt(promptForMode())
      }
    } else {
      try {
        // @文件路径 媒体提及解析（先文件后 agent；core 词法 + 壳侧校验/读字节，三入口共用）
        const media = await resolveMediaMentions(input)
        if (media.attached.length > 0) {
          process.stdout.write(`${D}已附加: ${media.attached.map((p) => p.split(/[\\/]/).pop()).join(', ')}${R}\n`)
        }
        for (const m of media.missing) {
          process.stdout.write(`\n⚠ ${m.path}（${m.reason}，已按文本发送）\n`)
        }
        const text = media.text

        // @agent 提及解析（媒体提取之后；精确匹配模板 subagent_type，不匹配按普通文本）
        const allAgentTypes = new Set(getTemplateManager().getAllTemplates().map(t => t.subagent_type))
        // 裸提及（只喊名字不带任务）= 切换前台直聊：复用 /front 通道，不发起模型轮；
        // 远程模板由 handleFront 既有分支给出"仅支持委派"指引
        const bareAgent = parseBareAgentMention(text, allAgentTypes)
        if (bareAgent) {
          handleFront(`/front ${bareAgent}`)
          setPrompt(promptForMode())
          return
        }
        const { explicitAgent } = parseAgentMentions(text, allAgentTypes)
        if (explicitAgent) {
          process.stdout.write(`${D}已指定 agent: ${explicitAgent}${R}\n`)
        }

        // 发送前锚定：磁盘记录比本端新（对端写入）则先采纳，保证上下文是会话当前真相；无更新直接继续
        await anchorFromDisk()

        await chatService.chat(text, media.contentParts, explicitAgent)
        setPrompt(promptForMode())
      } catch (err: any) {
        process.stdout.write(`\n错误: ${err?.message || err}\n`)
        setPrompt(promptForMode())
      }
    }
  } finally {
    isChatting = false
    // 聊天/流式期间 watch 命中积压的对端同步，本轮结束后补做
    await flushPeerSync()
    // 版本切换已成功且本轮对话（告别语）完成 → 旧窗口自行退出（新窗口早已打开）
    if (pendingSwitchExit) {
      // M1.10：D9 bounce 已退役——serve 接续由事件/令牌驱动（serveVersionSwitchExit），
      // CLI 接续窗已在 chill:switch-succeeded 订阅器统一打开
      process.stdout.write('\n版本切换已完成，本窗口将在 5 秒后自动关闭...\n')
      // 退出前显式交接：退租 relay（新窗口经等待态自动接管）+ 销毁后台 Worker
      setTimeout(() => { void destroyWorkersBeforeExit().finally(() => process.exit(0)) }, 5000)
    }
  }

  reprompt()
}

// ===== 首次使用向导（bootstrap loader）：零 Key 用户首启引导 =====
// 插入点：banner 已收集、rl.on('line') 尚未注册（REPL 未接管输入）。
// 条件门求值顺序 = 廉价标志在前、IO 检测在后：交互式 + 非 -p + 无待决 hook 信任询问
// （向导让路：hook 询问等 TUI、向导等用户、TUI 等向导会三方互锁）+ 未跳过 + 首用（零 Key）。
// 交互提示由向导直写 stdout（经 startupOut 会被收集进 startupLines 当场不显示）；
// 最终确认经 startupOut（TUI 消息区持久渲染，--cli 照常打印）。
if (!printMode && process.stdout.isTTY && !isHookTrustPending() && ctx.keyValueStore.getItem(WIZARD_DISMISSED_KEY) !== 'true') {
  if (await detectFirstRun()) {
    await runFirstRunWizard({ rl, kv: ctx.keyValueStore, printFinal: startupOut })
    // M5.5：首启横幅提示 serve 入口（CLI→Web 主路径的可发现性验收项）
    startupOut('提示：想要图形界面？运行 chill web，浏览器打开终端打印的地址即可。\n')
  }
}

rl.on('line', (line) => {
  void handleReplInput(line)
})

// TUI 命令分发注册：/ 命令在 TUI 内复用同一处理器（输出由 tuiShell 捕获进消息区）
registerCommandDispatcher(handleReplInput)

rl.on('close', () => {
  // 退出前 SessionEnd hooks + 销毁后台 Worker（均幂等；须显式 await，process.on('exit') 无法完成 async）
  void fireSessionEndBeforeExit()
    .then(() => destroyWorkersBeforeExit())
    .then(() => process.exit(0))
})

process.on('SIGINT', () => {
  console.log('\n再见！')
  void fireSessionEndBeforeExit()
    .then(() => destroyWorkersBeforeExit())
    .then(() => {
      rl.close()
      process.exit(0)
    })
})

// ===== 默认入口翻转（TUI 原则 2）=====
// TTY 且非 -p/--cli 时直进 TUI（wantTui 已在 argv 解析后早定，欢迎内容经 startupLines
// 交 TUI 原生渲染，主屏零输出无闪屏；/cli 退出时由 tuiShell 补打回 scrollback 衔接）;
// 非 TTY/--cli 走 CLI 显示。rl.on('line') 也已注册（armed）,exitTui 经 startRepl() 恢复读取与提示符。
if (wantTui) {
  const { enterTui } = await import('./tui/tuiShell.js')
  // 与 handleTuiEnter 一致：TUI 期间抑制 REPL 提示符（reprompt 守卫生效的前提）
  suppressPrompt = true
  try {
    await enterTui(chatService, { rl, startRepl, replStarted: false, startupLines: startupLines.join('') })
  } finally {
    suppressPrompt = false
    setPrompt(promptForMode())
    reprompt()
  }
} else {
  startRepl()
}
