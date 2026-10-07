import { execSync, spawn } from 'child_process'
if (process.platform === 'win32') {
  try { execSync('chcp 65001 >nul 2>&1', { stdio: 'ignore' }) } catch {}
}

// 全局设置 Python 子进程 UTF-8 编码，防止 emoji/中文等在 GBK 系统代码页下崩溃或乱码
process.env.PYTHONIOENCODING = 'utf-8'

import { webcrypto } from 'crypto'
if (!globalThis.crypto) {
  (globalThis as any).crypto = webcrypto
}

// ========== 进程级全局兜底（最后防线，须早于一切业务初始化） ==========
// 红线：长寿桌面主进程严禁被未捕获异步错误弹窗杀死（历史教训：chokidar watcher 的
// EBUSY error 事件无监听 → uncaught → Electron 默认崩溃对话框）。
// 分阶段：启动期（app ready 前）半初始化运行比 fail-fast 更糟，记日志后退出；
// 运行期记录到 ~/.chill/main-error.log 不退出。处理器自身零抛出（写日志失败也吞）。
let appReady = false
const mainErrorLogPath = (): string => join(os.homedir(), '.chill', 'main-error.log')
const uncaughtLogTimestamps: number[] = []
const writeUncaughtLog = (kind: string, error: unknown): void => {
  try {
    // 节流：60 秒内最多记 5 条，防相同错误洪泛刷爆日志
    const now = Date.now()
    while (uncaughtLogTimestamps.length > 0 && now - uncaughtLogTimestamps[0] > 60_000) uncaughtLogTimestamps.shift()
    if (uncaughtLogTimestamps.length >= 5) return
    uncaughtLogTimestamps.push(now)
    const stack = error instanceof Error ? (error.stack ?? error.message) : String(error)
    fs.appendFileSync(mainErrorLogPath(), `[${new Date().toISOString()}] [${kind}] ${stack}\n\n`)
    console.error(`【全局兜底】${kind}:`, error)
  } catch { /* 兜底处理器自身严禁抛出 */ }
}
process.on('uncaughtException', (error) => {
  writeUncaughtLog('uncaughtException', error)
  if (!appReady) process.exit(1) // 启动期 fail-fast：半初始化状态不可继续
})
process.on('unhandledRejection', (reason) => {
  writeUncaughtLog('unhandledRejection', reason)
  if (!appReady) process.exit(1)
})

import { app, BrowserWindow, Menu, ipcMain, dialog, protocol as electronProtocol, shell } from 'electron'
import { join, resolve as pathResolve, extname, dirname, normalize as pathNormalize } from 'path'
import * as fs from 'fs'
import { readdir, writeFile, unlink } from 'fs/promises'
import * as os from 'os'
import express from 'express'
import chokidar from 'chokidar'
import * as iconv from 'iconv-lite'
import * as jschardet from 'jschardet'

// 导入MCP相关模块

import type { MCPServerConfig } from '@assistant-ai/core'
import { MCPService, SubagentExecutor, AESGCMCrypto, FileKeyValueStore, MCPConnectionManager, modelInfoService, providerManager, runProviderKeyMigration, ModelType, RemoteAgentRegistrar, SessionPersistence, ProjectPersistence, getOwnProjectPaths, BuiltInToolExecutor, eventBus, EVENTS, saveCurrentGoal, archiveCurrentGoal, clearCurrentGoal, searchSessionRecords, listSessionSummaries, registerInstance, getLiveInstancePids, BoardStore, buildCatalogStateBody, wireSessionCatalogWatch, watchVersionToken, TaskStore, SchedulerService, setSessionTaskCleaner } from '@assistant-ai/core'
import type { IConfirmationHandler, IPositionCalculator, ICodeExecutor, BuiltInToolResult } from '@assistant-ai/core'
import type { SessionRecord, SaveMode, ProjectRecord } from '@assistant-ai/core'
import type { IMCPClient } from '@assistant-ai/core'
import type { ISecureStorage } from '@assistant-ai/core'
import { SecureStorageService } from '@assistant-ai/core'
import { storageKeyFor, loadCredentialIndex, saveCredentialIndex, upsertCredentialEntry, logicalNameForStorageStem, runKeyStorageMigration, type KeyDirTextOps } from '@assistant-ai/core'
import { readLinesBounded } from '@assistant-ai/core'

// 导入IPC通道常量（T7：自 core/workflow 移入本包，electron 是唯一消费者）
import { IPC_CHANNELS } from './ipcChannels'
import { registerRelayIpc, stopRelayForQuit } from './relay/relayMain'
import { recordDesktopAudit, type DesktopAuditEntry } from './DesktopAuditMainSink'

// 导入 core 中的执行模块
import { executePowerShell } from '@assistant-ai/core'
import { CodeExecutor } from '@assistant-ai/core'
import type { SupportedLanguage } from '@assistant-ai/core'
import type { OutputCallback, ExitCallback } from '@assistant-ai/core'
import { DraftPersistence } from '@assistant-ai/core'
import { setExecutor as setCodeServiceExecutor } from '@assistant-ai/core'

import { DesktopMainController } from './DesktopMainController'
import { runHookProcess } from './main/HookProcessRunner'
import { createSafeChokidar } from './main/safeWatcher'
import type { RemoteAgentConfig, SubagentTemplate } from '@assistant-ai/core'

// 命名工作流旧资产迁移器（SavedWorkflow/多节点 SavedAgent → YAML 命名工作流）
import { migrateLegacyWorkflowAssets } from '@assistant-ai/core'
import { FileSystemTemplateLoader, createTemplateManager, getTemplateManager } from '@assistant-ai/core'
import { CozeTemplateGenerator, A2ATemplateGenerator } from '@assistant-ai/core'
import { BaseModelService, openAIChatHandler, anthropicChatHandler, registerAsyncTaskFamilies } from '@assistant-ai/core'

// 导入附件管理器
import { AttachmentManager } from '@assistant-ai/core'
import { ElectronPathProvider } from './adapters/ElectronPathProvider'
import { NodeFileSystemProvider } from './adapters/NodeFileSystemProvider'

// 步骤10：导入 Subagent Fork 管理器，用于应用退出时清理
import { getForkManager, StandardSubagentExecutor, setWorkerScriptPath, getTaskRegistry, setWorkerMcpHookDispatcher } from '@assistant-ai/core'
import type { WorkerMcpHookOutcome, WorkerMcpHookCall } from '@assistant-ai/core'
import { SkillInstaller, SkillLoader, getSkillRegistry } from '@assistant-ai/core'

// ========== 文件扫描工具（Orchestrator模板系统） ==========

/**
 * 确保目录存在，如果不存在则自动创建
 * @param dirPath - 要检查的目录路径
 * @returns 是否成功（目录已存在或创建成功）
 */
async function ensureDirectoryExists(dirPath: string): Promise<boolean> {
  try {
    // 检查目录是否存在
    await fs.promises.access(dirPath, fs.constants.F_OK)
    return true
  } catch (error: any) {
    // 目录不存在，尝试创建
    if (error.code === 'ENOENT') {
      try {
        await fs.promises.mkdir(dirPath, { recursive: true })
        console.log(`[ensureDirectoryExists] 自动创建目录: ${dirPath}`)
        return true
      } catch (mkdirError: any) {
        console.error(`[ensureDirectoryExists] 创建目录失败: ${dirPath}`, mkdirError)
        return false
      }
    }
    // 其他错误（如权限问题）
    console.error(`[ensureDirectoryExists] 检查目录失败: ${dirPath}`, error)
    return false
  }
}

// 设置Node.js进程的默认编码为UTF-8
process.env.LANG = 'zh_CN.UTF-8'
process.env.LC_ALL = 'zh_CN.UTF-8'
if (process.platform === 'win32') {
  // Windows平台特殊处理
  process.env.CHcp = 'utf8'
}

const isDev = process.env.NODE_ENV === 'development'
// 内置模板目录：开发=源码树；生产候选=electron-builder resources（打包形态）→
// npm 全档壳包（@assistant-ai/chill 的 dist 与 cli dist 同构携带 templates/builtin）
const builtinTemplatesDir = (() => {
  if (isDev) return pathResolve(process.cwd(), 'packages/core/src/orchestrator/templates/builtin')
  const candidates = [
    pathResolve(process.resourcesPath, 'templates/builtin'),
    pathResolve(__dirname, 'templates/builtin'),
  ]
  for (const p of candidates) { try { if (fs.existsSync(p)) return p } catch { /* 继续 */ } }
  return candidates[0]
})()

function createWindow(): void {
  // 确保控制台输出支持UTF-8编码
  if (process.platform === 'win32') {
    // Windows下配置控制台为UTF-8编码
    try {
      const execSync = require('child_process').execSync
      // 设置控制台代码页为UTF-8
      execSync('chcp 65001', { encoding: 'utf-8', stdio: 'ignore' })
    } catch (error) {
      // 如果chcp命令失败，忽略错误
      console.log('控制台编码设置失败，但不影响程序运行')
    }
  }

  // 创建浏览器窗口，配置UTF-8编码支持
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: join(__dirname, 'preload.js'),
      // 工作对象视窗 html 轻量视图（HtmlLightView）经 <webview> 渲染本地网页预览
      webviewTag: true,
      // 确保渲染进程支持UTF-8编码
      webSecurity: false // 允许跨域资源加载
    },
    titleBarStyle: 'hiddenInset', // macOS风格标题栏
    show: false // 先不显示，等ready-to-show事件
  })

  // 设置窗口标题和编码信息
  mainWindow.setTitle('AI助手 - UTF-8编码')

  // relay IPC 装配（M2a：传输驻主进程，解密/bridge 在渲染进程；事件经 webContents.send 推送）
  registerRelayIpc(() => (mainWindow.isDestroyed() ? null : mainWindow))

  // 当窗口准备好显示时再显示
  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
    console.log(isDev ? '✓ 开发环境已加载 (localhost:5173)' : '✓ 生产环境已加载 (dist/index.html)')
  })

  // 窗口重新聚焦即停止任务栏闪烁（回合完成提醒 window:notify-turn-completed 的复位点）；
  // 同机推送到渲染层：focus 是用户注意力边界，UI 借此全量刷新会话列表（覆盖对端改动非当前会话）
  mainWindow.on('focus', () => {
    mainWindow.flashFrame(false)
    mainWindow.webContents.send('window:focused')
  })

  // 桌面能力开启期间的 close veto（防崩溃体系）：任务栏右键/窗口切换器等间接关闭路径的
  // 属主是 explorer，注入侧拦截不到，故在 close 事件收口——转为用户确认对话框；
  // 自动化注入与用户自己点 X 同经此门，确认即可退出（可用性不损）。configStore 键现读现生效。
  mainWindow.on('close', (e) => {
    if (kvStore.getItem('desktop_control_enabled') !== 'true') return
    e.preventDefault()
    void dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['退出 chill', '取消'],
      defaultId: 1,
      cancelId: 1,
      title: '确认关闭',
      message: '桌面能力开启期间，关闭 chill 需要确认（防止桌面自动化误关宿主）。',
    }).then((r) => {
      if (r.response === 0) mainWindow.destroy()
    })
  })

  // 加载应用
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    // 渲染器候选：managed/打包布局（packages/dist 于 __dirname 上两级）→
    // npm 全档壳包（web/web-dist 与 cli dist 同构）
    const distPath = [
      join(__dirname, '../../dist'),
      join(__dirname, 'web', 'web-dist'),
    ].find((p) => fs.existsSync(join(p, 'index.html'))) ?? join(__dirname, '../../dist')
    const staticServer = express()
    staticServer.use(express.static(distPath))
    staticServer.get('/*splat', (_req, res) => {
      res.sendFile(join(distPath, 'index.html'))
    })
    // 端口冲突顺延(实测教训:旧实例/无关进程占 5174 时,listen 失败导致窗口静默加载
    // 占用者服务上的旧 bundle)。5174 起最多顺延 10 个端口,只在"自己的"服务监听成功后才
    // loadURL;全部失败则响亮弹窗——绝不把窗口送进别人的服务器。
    const basePort = Number(process.env.CHILL_STATIC_PORT) || 5174
    const tryListen = (port: number, attemptsLeft: number): void => {
      const srv = staticServer.listen(port, '127.0.0.1', () => {
        if (port !== basePort) console.warn(`【UI】静态端口 ${basePort} 被占用,顺延至 ${port}`)
        mainWindow.loadURL(`http://127.0.0.1:${port}`)
        app.on('before-quit', () => {
          srv.close()
        })
      })
      srv.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && attemptsLeft > 1) {
          tryListen(port + 1, attemptsLeft - 1)
        } else {
          dialog.showErrorBox('UI 启动失败', `本地静态服务端口不可用(${basePort}~${port} 均被占用):${err.message}`)
        }
      })
    }
    tryListen(basePort, 10)
  }

  // 移除默认菜单栏，显示干净的应用界面
  Menu.setApplicationMenu(null)
}

// 当Electron完成初始化并准备创建浏览器窗口时调用此方法
app.whenReady().then(async () => {
  appReady = true // 全局兜底进入运行期策略：此后未捕获错误只记录不退出
  // M3.1（版本切换接续规划）：换版接续——主进程订阅换版令牌，发现即以 junction 形态重启自身
  // （node electron-cli <junction根>：路径在 spawn 时刻解析、必穿当前 junction；参照 cli.ts /ui 形态 1）。
  // **禁用 app.relaunch()**：Electron 启动时把应用路径 realpath 化（junction 透明），relaunch 复用旧
  // argv 会精准重启回旧版本目录——机制看似工作、不变量默默失效。
  // 体验形态（workcopy 内运行）不接续：验收使命随 workcopy 清理结束（自毁定时器负责关窗）。
  // 退出走 app.quit()——before-quit 既有接线会 stopRelayForQuit 优雅退租，新实例经等待态接管。
  try {
    const inWorkcopy = typeof __dirname === 'string' && __dirname.includes('chill-workcopy')
    const ownPaths = getOwnProjectPaths()
    if (ownPaths.projectPath !== null && !inWorkcopy) {
      const electronCli = join(ownPaths.projectPath, 'packages', 'electron', 'node_modules', 'electron', 'cli.js')
      if (fs.existsSync(electronCli)) {
        watchVersionToken(join(os.homedir(), '.chill', 'version-switched.json'), (t) => {
          console.log(`[version-switch] 检测到换版令牌 v${t.version}——以 junction 形态重启 Electron`)
          try {
            spawn(process.execPath, [electronCli, ownPaths.projectPath!], {
              cwd: ownPaths.projectPath!,
              detached: true,
              stdio: 'ignore',
              windowsHide: true,
              env: { ...process.env, NODE_ENV: 'production' },
            }).unref()
          } catch (err) {
            console.warn('[version-switch] 接替实例 spawn 失败，保持当前版本运行:', err)
            return
          }
          setTimeout(() => app.quit(), 1000)
        }, 5000)
      }
    }
  } catch (err) {
    console.warn('[version-switch] 令牌订阅装配失败（不影响其余功能）:', err)
  }
  try {
    AttachmentManager.initialize(new ElectronPathProvider())
  } catch (err) {
    console.warn('[AttachmentManager] 初始化失败，继续启动应用:', err)
  }

  // 硬性顺序：provider Map 先就位（含种子合并与旧格式兼容）；
  // 备份先于一切改名（版本回滚是一等旅程）；key 文件命名迁移先于 loadAllModels——否则其内部
  // migrateKeys 会把更旧的 ModelType key 抢在显示名 key 前面迁到同一 id（显示名 key 是较新约定，必须赢）；
  // 存储键编码改名与 key 归位在 loadAllModels 之后（须先完成两级旧名归一）
  await providerManager.loadProviders()
  mainSecureStorage.backupKeysDir?.()
  await runProviderKeyMigration(mainSecureStorage)
  await modelInfoService.loadAllModels()
  await runKeyStorageMigration(mainSecureStorage)

  // 注册自定义协议 'app'
  electronProtocol.handle('app', (request) => {
    try {
      const url = new URL(request.url)

      // 只处理 -attachments hostname 的请求
      if (url.hostname !== '-attachments') {
        return new Response('Not Found', { status: 404 })
      }

      // 解析 fileId（pathname 包含前导 /）
      const fileId = url.pathname.substring(1) // 去掉开头的 /
      if (!fileId) {
        return new Response('Bad Request: missing fileId', { status: 400 })
      }

      // 获取文件路径
      const filePath = AttachmentManager.getAttachmentPath(fileId)

      // 步骤9：安全检查 - 确保路径在允许目录内
      const resolvedPath = pathResolve(filePath)
      const attachmentsRoot = pathResolve(AttachmentManager.getAttachmentsRootDir())
      if (!resolvedPath.startsWith(attachmentsRoot)) {
        console.error('Security check failed: path outside attachments directory', resolvedPath)
        return new Response('Forbidden', { status: 403 })
      }

      // 步骤9：检查文件是否存在
      if (!fs.existsSync(filePath)) {
        console.error('File not found:', filePath)
        return new Response('Not Found', { status: 404 })
      }

      // 根据文件扩展名设置 Content-Type
      const ext = extname(filePath).toLowerCase()
      const mimeTypes: Record<string, string> = {
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.mov': 'video/quicktime',
        '.avi': 'video/x-msvideo',
        '.mkv': 'video/x-matroska'
      }
      const contentType = mimeTypes[ext] || 'application/octet-stream'

      // 获取文件大小
      const stats = fs.statSync(filePath)
      const fileSize = stats.size

      // 处理 HTTP Range 请求（视频播放需要）
      const rangeHeader = request.headers.get('Range')
      if (rangeHeader) {
        const rangeMatch = rangeHeader.match(/bytes=(\d+)-(\d*)/)
        if (rangeMatch) {
          const start = parseInt(rangeMatch[1], 10)
          const end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : fileSize - 1
          const chunkSize = end - start + 1

          // 创建指定范围的文件流
          const stream = fs.createReadStream(filePath, { start, end })

          return new Response(stream as any, {
            status: 206, // Partial Content
            headers: {
              'Content-Type': contentType,
              'Content-Length': chunkSize.toString(),
              'Content-Range': `bytes ${start}-${end}/${fileSize}`,
              'Accept-Ranges': 'bytes'
            }
          })
        }
      }

      // 非 Range 请求：返回完整文件
      const stream = fs.createReadStream(filePath)

      return new Response(stream as any, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Content-Length': fileSize.toString(),
          'Accept-Ranges': 'bytes' // 告诉客户端支持 Range 请求
        }
      })
    } catch (error) {
      console.error('Protocol handler error:', error)
      return new Response('Internal Server Error', { status: 500 })
    }
  })
  console.log('Custom protocol "app" registered')

  // 设置 Worker 脚本路径（非 dev 模式下 process.cwd() 可能不在项目根目录）
  // 候选：managed 布局（core dist）→ npm 全档壳包（workers/ 与 cli dist 同构，自包含 bundle）
  const workerScriptPath = [
    join(__dirname, '../../core/dist/orchestrator/isolation/workers/GenericSubagentWorker.js'),
    join(__dirname, 'workers', 'GenericSubagentWorker.js'),
  ].find((p) => fs.existsSync(p))
  if (workerScriptPath) {
    setWorkerScriptPath(workerScriptPath)
  }

  createWindow()
})

// 在应用启动时设置全局编码
app.on('ready', () => {
  if (process.platform === 'win32') {
    try {
      const execSync = require('child_process').execSync
      // 设置全局编码为UTF-8
      execSync('chcp 65001 >nul 2>&1', { encoding: 'utf-8', stdio: 'ignore' })
      console.log('✓ 全局UTF-8编码设置成功')
    } catch (error) {
      console.log('警告: 无法设置全局UTF-8编码')
    }
  }
})

// 当所有窗口都关闭时退出应用
app.on('window-all-closed', () => {
  // 在macOS上，应用和菜单栏通常会保持活动状态，直到用户明确退出
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// 应用退出前清理：SessionEnd hooks + Subagent Worker 环境销毁
// 步骤10：添加应用退出时的清理逻辑，调用 destroyAllEnvironments
app.on('before-quit', async () => {

  // SessionEnd hooks（阶段 4）：渲染进程持有引擎，主进程经 session:end-request 通知其执行
  // endSession（core 共享 1.5s 预算、幂等），session:end-done 回包或 3s 兜底超时后放行退出；
  // 窗口已销毁（如 window-all-closed 先关窗）时跳过
  const sessionEndWindow = BrowserWindow.getAllWindows()[0]
  if (sessionEndWindow && !sessionEndWindow.isDestroyed()) {
    try {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3000)
        ipcMain.once('session:end-done', () => {
          clearTimeout(timer)
          resolve()
        })
        sessionEndWindow.webContents.send('session:end-request')
      })
    } catch (error) {
      console.error('[electron-main] SessionEnd hooks 执行失败:', error)
    }
  }

  // 步骤10：销毁所有 Subagent 隔离环境
  try {
    const forkManager = getForkManager()
    await forkManager.destroyAllEnvironments()
    console.log('[electron-main] 步骤10：所有 Subagent 隔离环境已清理')
  } catch (error) {
    console.error('[electron-main] 步骤10：清理 Subagent 隔离环境失败:', error)
  }
})

app.on('activate', () => {
  // 在macOS上，当点击dock图标且没有其他窗口打开时，通常会重新创建一个窗口
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

// 安全存储相关功能
const masterStorageDir = join(os.homedir(), '.chill')
const secureStoragePath = join(masterStorageDir, 'keys')
const masterKey = AESGCMCrypto.initMasterKey(masterStorageDir)

fs.mkdirSync(secureStoragePath, { recursive: true })

/**
 * 分层语义（V2/V3，与 CLISecureStorage 同构）：逻辑 API 收逻辑 ID（文件名经 storageKeyFor 编码、
 * 迁移期裸名回退）；文件原语（listKeyFiles/renameKey）保持物理文件名语义（迁移器契约）。
 */
class MainProcessSecureStorage implements ISecureStorage {
  /** 物理 stem 路径（文件原语/迁移用；不编码） */
  private rawFilePath(stem: string): string {
    return join(secureStoragePath, `${stem}.key`)
  }

  /** 逻辑 ID 路径（经存储键编码） */
  private keyFilePath(logicalId: string): string {
    return this.rawFilePath(storageKeyFor(logicalId))
  }

  /** 迁移期兼容查找：编码名优先、存量裸名回退 */
  private existingPathFor(logicalId: string): string | null {
    const encoded = this.keyFilePath(logicalId)
    if (fs.existsSync(encoded)) return encoded
    const legacy = this.rawFilePath(logicalId)
    if (fs.existsSync(legacy)) return legacy
    return null
  }

  private indexOps(): KeyDirTextOps {
    return {
      readText: (name) => {
        try {
          return fs.readFileSync(join(secureStoragePath, name), 'utf-8')
        } catch {
          return null
        }
      },
      writeText: (name, content) => {
        try {
          fs.writeFileSync(join(secureStoragePath, name), content)
          return true
        } catch {
          return false
        }
      },
      rename: (from, to) => {
        try {
          fs.renameSync(join(secureStoragePath, from), join(secureStoragePath, to))
          return true
        } catch {
          return false
        }
      },
      remove: (name) => {
        try {
          fs.unlinkSync(join(secureStoragePath, name))
        } catch {
          /* 幂等 */
        }
      },
    }
  }

  async storeApiKey(provider: string, apiKey: string): Promise<boolean> {
    try {
      const encrypted = AESGCMCrypto.encrypt(masterKey, apiKey)
      fs.writeFileSync(this.keyFilePath(provider), encrypted)
      const ops = this.indexOps()
      const idx = loadCredentialIndex(ops)
      upsertCredentialEntry(idx, provider, storageKeyFor(provider))
      saveCredentialIndex(ops, idx)
      return true
    } catch (error) {
      console.error('Failed to store API key:', error)
      return false
    }
  }

  async getApiKey(provider: string): Promise<string | null> {
    try {
      const filePath = this.existingPathFor(provider)
      if (!filePath) return null
      return AESGCMCrypto.decrypt(masterKey, fs.readFileSync(filePath))
    } catch (error) {
      console.error(`Failed to get API key for ${provider}:`, error)
      return null
    }
  }

  async hasApiKey(provider: string): Promise<boolean> {
    return this.existingPathFor(provider) !== null
  }

  async deleteApiKey(provider: string): Promise<boolean> {
    try {
      for (const p of [this.keyFilePath(provider), this.rawFilePath(provider)]) {
        if (fs.existsSync(p)) fs.unlinkSync(p)
      }
      return true
    } catch (error) {
      console.error(`Failed to delete API key for ${provider}:`, error)
      return false
    }
  }

  async getAllProviders(): Promise<string[]> {
    try {
      if (!fs.existsSync(secureStoragePath)) return []
      const ops = this.indexOps()
      const idx = loadCredentialIndex(ops)
      return fs.readdirSync(secureStoragePath)
        .filter(f => f.endsWith('.key'))
        .map(f => f.slice(0, -4))
        .map(stem => logicalNameForStorageStem(stem, idx))
    } catch {
      return []
    }
  }

  /** 列出 keys 目录下全部 .key 文件名（物理名；供 providerKeyMigration / keyStorageMigration 使用） */
  listKeyFiles(): string[] {
    try {
      if (!fs.existsSync(secureStoragePath)) return []
      return fs.readdirSync(secureStoragePath).filter(f => f.endsWith('.key'))
    } catch {
      return []
    }
  }

  /** 重命名 key 文件（物理 stem → 物理 stem；目标已存在或源不存在时返回 false，不覆盖） */
  renameKey(oldName: string, newName: string): boolean {
    try {
      const oldPath = this.rawFilePath(oldName)
      const newPath = this.rawFilePath(newName)
      if (!fs.existsSync(oldPath) || fs.existsSync(newPath)) return false
      fs.writeFileSync(newPath, fs.readFileSync(oldPath))
      fs.unlinkSync(oldPath)
      return true
    } catch (error) {
      console.error(`Failed to rename API key (${oldName} -> ${newName}):`, error)
      return false
    }
  }

  /** 迁移前置备份（4a 幂等据点）：keys/ → keys.backup-<ts>/，已有备份复用（created=false 静默） */
  backupKeysDir(): { name: string; created: boolean } | null {
    try {
      const existing = fs.readdirSync(masterStorageDir).find(n => n.startsWith('keys.backup-'))
      if (existing) return { name: existing, created: false }
      const name = `keys.backup-${Date.now()}`
      fs.cpSync(secureStoragePath, join(masterStorageDir, name), { recursive: true })
      return { name, created: true }
    } catch (error) {
      console.error('Failed to backup keys dir:', error)
      return null
    }
  }
}

// IPC 委托同一实现（消除 resolveId 包裹与双份逻辑——逻辑 ID 语义由 storageKeyFor 统一）
ipcMain.handle('store-api-key', async (event, provider, apiKey) => {
  const ok = await mainSecureStorage.storeApiKey(provider, apiKey)
  return ok ? { success: true } : { success: false, error: 'API Key 保存失败' }
})

ipcMain.handle('get-api-key', (event, provider) => mainSecureStorage.getApiKey(provider))

ipcMain.handle('delete-api-key', (event, provider) => mainSecureStorage.deleteApiKey(provider))

ipcMain.handle('get-all-providers', () => mainSecureStorage.getAllProviders())

const kvStore = new FileKeyValueStore(join(os.homedir(), '.chill', 'state.json'))

ipcMain.on('kv:get', (event, key: string) => {
  event.returnValue = kvStore.getItem(key)
})

ipcMain.on('kv:set', (event, key: string, value: string) => {
  kvStore.setItem(key, value)
  event.returnValue = undefined
})

ipcMain.on('kv:remove', (event, key: string) => {
  kvStore.removeItem(key)
  event.returnValue = undefined
})

// ========== 生命周期 hooks IPC（阶段 3：桌面 UI 支持） ==========
// 渲染进程无 child_process / fs.stat：hook 命令执行与 mtime 探测由主进程承担，
// 语义与 CLI 的 NodeHookProcessRunner / NodeFileMtimeProvider 完全一致（见 main/HookProcessRunner.ts）

// hooks:run —— 执行一条 hook 命令（stdin 写入 inputJson，收集 stdout/stderr/exit code，超时杀进程树）。
// cwd 由渲染进程随调用传入（引擎会话 workDir），注入 CHILL_PROJECT_DIR / CLAUDE_PROJECT_DIR 别名
ipcMain.handle('hooks:run', async (_event, payload: { command?: string; inputJson?: string; timeoutMs?: number; cwd?: string }) => {
  try {
    if (!payload || typeof payload.command !== 'string' || typeof payload.inputJson !== 'string') {
      return { exitCode: null, stdout: '', stderr: 'hooks:run 参数非法', timedOut: false }
    }
    const timeoutMs = typeof payload.timeoutMs === 'number' && payload.timeoutMs > 0 ? payload.timeoutMs : 30_000
    return await runHookProcess(payload.command, payload.inputJson, timeoutMs, payload.cwd)
  } catch (error: any) {
    // 执行通道自身异常：视同进程未能正常退出（core 按 fail-open/failClosed 语义处理）
    return { exitCode: null, stdout: '', stderr: error?.message ?? String(error), timedOut: false }
  }
})

// hooks:mtime —— core IFileMtimeProvider 的主进程实现（loader 的 mtime 惰性重载依赖此窄接口）
ipcMain.handle('hooks:mtime', async (_event, filePath: string) => {
  try {
    return (await fs.promises.stat(filePath)).mtimeMs
  } catch {
    return null
  }
})

// board:* —— core SessionBoardStore 的主进程实现（渲染进程 fs 是空 shim，经 IPC 桥到主进程 fs；
// 照 hooks:mtime 先例。落盘 ~/.chill/boards/<boardId>.json，BoardStore 内部 tmp+rename 原子写）
const mainBoardStore = new BoardStore()
ipcMain.handle('board:load', (_event, boardId: string) => mainBoardStore.load(boardId))
ipcMain.handle('board:save', (_event, state: Parameters<BoardStore['save']>[0]) => mainBoardStore.save(state))
ipcMain.handle('board:exists', (_event, boardId: string) => mainBoardStore.exists(boardId))
ipcMain.handle('board:archive', (_event, boardId: string, reason: string) => mainBoardStore.archiveBoard(boardId, reason))

// hooks 配置生效 = 派发时惰性重载单通道（core HookRunner.dispatch → HookConfigLoader.checkReload
// 现扫目录链 + mtime 签名；与 CLI 对齐）。历史上主进程另有 hooks.json watcher 做"提前重载"推送，
// 其对新建文件不生效（chokidar watch 不存在文件不建 watcher）且每个效果都被惰性重载覆盖——纯冗余，已删除。

// ========== 附件管理相关IPC处理程序 ==========

// 保存附件
ipcMain.handle('attachment:save', async (event, buffer: ArrayBuffer, fileName: string) => {
  try {
    const nodeBuffer = Buffer.from(buffer)
    const fileId = await AttachmentManager.saveAttachment(nodeBuffer, fileName)
    // filePath 供文件引用管线（T2 路径兜底链）引用落盘路径；视频通道沿用 fileId 不受影响
    const filePath = AttachmentManager.getAttachmentPath(fileId)
    return { success: true, fileId, filePath }
  } catch (error) {
    console.error('Failed to save attachment:', error)
    return { success: false, error: String(error) }
  }
})

// 删除附件
ipcMain.handle('attachment:delete', async (event, fileId: string) => {
  try {
    const success = await AttachmentManager.deleteAttachment(fileId)
    return { success }
  } catch (error) {
    console.error('Failed to delete attachment:', error)
    return { success: false, error: String(error) }
  }
})

// 读取附件为base64
ipcMain.handle('attachment:read-as-base64', async (event, fileId: string) => {
  try {
    const base64 = await AttachmentManager.readAsBase64(fileId)
    return { success: true, base64 }
  } catch (error) {
    console.error('Failed to read attachment as base64:', error)
    return { success: false, error: String(error) }
  }
})

// ========== MCP服务相关功能 ==========

/**
 * Electron环境下的MCP服务管理器 - 支持多Client架构
 * 负责在主进程中管理多个MCP连接和IPC通信
 */
class ElectronMCPService {
  private manager = new MCPConnectionManager()

  constructor() {
    this.manager.onStatusChange(({ connectionId, status, transportType }) => {
      const mainWindow = BrowserWindow.getAllWindows()[0]
      if (mainWindow) {
        // 从 manager 中查找对应的连接以获取 serverName
        const connections = this.manager.listConnections()
        const conn = connections.find(c => c.connectionId === connectionId)
        const serverName = conn?.name || undefined
        mainWindow.webContents.send('mcp-status-update', {
          connectionId,
          status,
          serverName,
          timestamp: Date.now()
        })
      }
    })
  }

  private getActiveConnections(): Array<{id: string, status: string, transportType: string}> {
    return this.manager.listConnections().map(c => ({
      id: c.connectionId,
      status: c.status,
      transportType: c.transportType
    }))
  }

  private hasConnection(connectionId: string): boolean {
    return this.manager.getStatus(connectionId) !== 'disconnected'
  }

  private async findConnectionForTool(toolName: string): Promise<string | undefined> {
    for (const conn of this.getActiveConnections()) {
      if (conn.status !== 'connected') continue
      const result = await this.manager.listTools(conn.id)
      if (result.success && result.tools && result.tools.some((t: any) => t.name === toolName)) {
        return conn.id
      }
    }
    return undefined
  }

  /**
   * 调用 MCP 工具
   * 供其他模块（如 ForkManager）直接调用
   * @param toolName 工具名称
   * @param args 工具参数
   * @param connectionId 可选的连接ID
   * @returns 工具调用结果
   */
  async callTool(
    toolName: string,
    args?: Record<string, any>,
    connectionId?: string
  ): Promise<{ success: boolean; result?: any; error?: string }> {
    try {
      let actualConnectionId = connectionId

      if (!actualConnectionId) {
        const toolConnectionId = await this.findConnectionForTool(toolName)
        if (toolConnectionId) {
          actualConnectionId = toolConnectionId
        } else {
          const connected = this.getActiveConnections().filter(c => c.status === 'connected')
          if (connected.length === 0) throw new Error('没有活跃的MCP连接')
          actualConnectionId = connected[0]?.id
        }
      }

      if (!actualConnectionId) throw new Error('无法确定要使用的连接ID')
      if (!this.hasConnection(actualConnectionId)) throw new Error(`连接ID ${actualConnectionId} 不存在`)

      return await this.manager.callTool(toolName, args || {}, actualConnectionId)
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : '工具调用失败'
      }
    }
  }

  /**
   * 设置所有MCP相关的IPC处理程序
   */
  setupIPCHandlers() {




    // 获取MCP工具列表
    ipcMain.handle('mcp-list-tools', async (event, connectionId?: string) => {
      try {
        if (!connectionId) {
          const active = this.getActiveConnections()
          const connected = active.filter(c => c.status === 'connected')
          if (connected.length === 0) throw new Error('没有活跃的MCP连接')
          if (connected.length > 1) throw new Error('存在多个活跃连接，请指定要查询的连接ID')
          connectionId = connected[0]?.id
        }
        if (!connectionId) throw new Error('无法确定要使用的连接ID')

        const result = await this.manager.listTools(connectionId)
        return { success: result.success, tools: result.tools, error: result.error, connectionId }
      } catch (error) {
        console.error('获取MCP工具列表失败:', error)
        return { success: false, error: error instanceof Error ? error.message : '获取工具列表失败' }
      }
    })

    // 获取MCP连接状态
    ipcMain.handle('mcp-connection-status', async (event, connectionId?: string) => {
      try {
        if (!connectionId) {
          const allConnections = this.manager.listConnections().map(c => ({
            id: c.connectionId,
            status: c.status,
            isConnected: c.status === 'connected'
          }))
          const connectedCount = allConnections.filter(c => c.isConnected).length
          return { success: true, connections: allConnections, totalConnections: allConnections.length, connectedCount, hasConnections: allConnections.length > 0 }
        } else {
          const status = this.manager.getStatus(connectionId)
          return { success: true, connectionId, status, isConnected: status === 'connected' }
        }
      } catch (error) {
        console.error('获取MCP连接状态失败:', error)
        return { success: false, error: error instanceof Error ? error.message : '获取连接状态失败' }
      }
    })

    // ========== 新增支持连接ID的IPC处理程序 ==========
    
    // 支持连接ID的连接（明确要求提供connectionId参数）
    ipcMain.handle('mcp-connect-id', async (event, config: MCPServerConfig, connectionId?: string) => {
      try {
        if (!connectionId) {
          throw new Error('连接ID是必需的')
        }
        return await this.manager.connect(config, connectionId)
      } catch (error) {
        console.error('MCP连接失败:', error)
        return { 
          success: false, 
          error: error instanceof Error ? error.message : '未知错误' 
        }
      }
    })

    // 断开指定连接（明确支持connectionId参数）
    ipcMain.handle('mcp-disconnect-id', async (event, connectionId: string) => {
      try {
        return await this.manager.disconnect(connectionId)
      } catch (error) {
        console.error('断开MCP连接失败:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : '断开连接失败'
        }
      }
    })

    // 获取所有连接列表
    ipcMain.handle('mcp-list-connections', async (event) => {
      try {
        const connections = this.manager.listConnections().map(c => ({
          connectionId: c.connectionId,
          name: c.name,
          serverName: c.name,
          connected: c.status === 'connected',
          status: c.status,
          transportType: c.transportType
        }))
        return {
          success: true,
          connections,
          totalConnections: connections.length,
          connectedCount: connections.filter(c => c.connected).length
        }
      } catch (error) {
        console.error('获取连接列表失败:', error)
        return { success: false, error: error instanceof Error ? error.message : '获取连接列表失败' }
      }
    })

    // 获取MCP资源列表
    ipcMain.handle('mcp-list-resources', async (event, connectionId?: string) => {
      try {
        if (!connectionId) {
          const active = this.getActiveConnections()
          const connected = active.filter(c => c.status === 'connected')
          if (connected.length === 0) throw new Error('没有活跃的MCP连接')
          if (connected.length > 1) throw new Error('存在多个活跃连接，请指定要查询的连接ID')
          connectionId = connected[0]?.id
        }
        if (!connectionId) throw new Error('无法确定要使用的连接ID')
        const result = await this.manager.listResources(connectionId)
        return { success: result.success, resources: result.resources, error: result.error, connectionId }
      } catch (error) {
        console.error('获取MCP资源列表失败:', error)
        return { success: false, error: error instanceof Error ? error.message : '获取资源列表失败' }
      }
    })

    // 获取MCP提示词列表
    ipcMain.handle('mcp-list-prompts', async (event, connectionId?: string) => {
      try {
        if (!connectionId) {
          const active = this.getActiveConnections()
          const connected = active.filter(c => c.status === 'connected')
          if (connected.length === 0) throw new Error('没有活跃的MCP连接')
          if (connected.length > 1) throw new Error('存在多个活跃连接，请指定要查询的连接ID')
          connectionId = connected[0]?.id
        }
        if (!connectionId) throw new Error('无法确定要使用的连接ID')
        const result = await this.manager.listPrompts(connectionId)
        return { success: result.success, prompts: result.prompts, error: result.error, connectionId }
      } catch (error) {
        console.error('获取MCP提示词列表失败:', error)
        return { success: false, error: error instanceof Error ? error.message : '获取提示词列表失败' }
      }
    })

    // 读取MCP资源内容
    ipcMain.handle('mcp-read-resource', async (event, uri: string, connectionId?: string) => {
      try {
        if (!uri) throw new Error('资源URI不能为空')
        if (!connectionId) {
          const active = this.getActiveConnections()
          const connected = active.filter(c => c.status === 'connected')
          if (connected.length === 0) throw new Error('没有活跃的MCP连接')
          if (connected.length > 1) throw new Error('存在多个活跃连接，请指定要使用的连接ID')
          connectionId = connected[0]?.id
        }
        if (!connectionId) throw new Error('无法确定要使用的连接ID')
        const result = await this.manager.readResource(uri, connectionId)
        return { success: result.success, content: result.content, error: result.error, connectionId }
      } catch (error: any) {
        return { success: false, error: error.message || '读取资源时发生未知错误' }
      }
    })

    // 获取MCP提示词内容
    ipcMain.handle('mcp-get-prompt', async (event, name: string, args?: { [key: string]: string }, connectionId?: string) => {
      try {
        if (!name) throw new Error('提示词名称不能为空')
        if (!connectionId) {
          const active = this.getActiveConnections()
          const connected = active.filter(c => c.status === 'connected')
          if (connected.length === 0) throw new Error('没有活跃的MCP连接')
          if (connected.length > 1) throw new Error('存在多个活跃连接，请指定要使用的连接ID')
          connectionId = connected[0]?.id
        }
        if (!connectionId) throw new Error('无法确定要使用的连接ID')
        const result = await this.manager.getPrompt(name, args || {}, connectionId)
        return { success: result.success, prompt: result.prompt, error: result.error, connectionId }
      } catch (error: any) {
        return { success: false, error: error.message || '获取提示词时发生未知错误' }
      }
    })

    // ========== 使用MCPConnectionManager处理工具调用 ==========
    
    ipcMain.handle('mcpCallToolWithId', async (event, toolName: string, args?: Record<string, any>, connectionId?: string) => {
      try {
        if (!connectionId) {
          const active = this.getActiveConnections()
          const connected = active.filter(c => c.status === 'connected')
          if (connected.length === 0) throw new Error('没有活跃的MCP连接')
          if (connected.length > 1) throw new Error('存在多个活跃连接，请指定要查询的连接ID')
          connectionId = connected[0]?.id
        }
        if (!connectionId) throw new Error('无法确定要使用的连接ID')
        const result = await this.manager.callTool(toolName, args || {}, connectionId)
        return { success: result.success, result: result.result, error: result.error, connectionId }
      } catch (error) {
        console.error('MCP工具调用失败:', toolName, error)
        return { success: false, error: error instanceof Error ? error.message : '工具调用失败' }
      }
    })
  }
}

// 初始化主进程MCP服务
const mcpService = new ElectronMCPService()
mcpService.setupIPCHandlers()
console.log('✓ MCP主进程服务已初始化')

// 创建 IMCPClient 适配器，桥接主进程 MCP 服务到 core 的 MCPService
// 使得 Agent 模式执行工作流时能访问已连接的 MCP 工具
function createMainProcessMCPClientAdaptor(service: ElectronMCPService): IMCPClient {
  const m = (service as any).manager
  return {
    connectWithId: (config, connectionId) =>
      m.connect(config, connectionId || `conn_${Date.now()}`),

    disconnectWithId: (connectionId) =>
      m.disconnect(connectionId),

    listTools: async (connectionId) => {
      try {
        const connId = connectionId || (m.listConnections() as any[]).find((c: any) => c.status === 'connected')?.connectionId
        if (!connId) return { success: true, tools: [] }
        const result = await m.listTools(connId)
        return { success: result.success, tools: result.tools || [], error: result.error, connectionId: connId }
      } catch (e: any) {
        return { success: false, error: e.message }
      }
    },

    listResources: async (connectionId) => {
      try {
        const connId = connectionId || (m.listConnections() as any[]).find((c: any) => c.status === 'connected')?.connectionId
        if (!connId) return { success: true, resources: [] }
        const result = await m.listResources(connId)
        return { success: result.success, resources: result.resources || [], error: result.error, connectionId: connId }
      } catch (e: any) {
        return { success: false, error: e.message }
      }
    },

    listPrompts: async (connectionId) => {
      try {
        const connId = connectionId || (m.listConnections() as any[]).find((c: any) => c.status === 'connected')?.connectionId
        if (!connId) return { success: true, prompts: [] }
        const result = await m.listPrompts(connId)
        return { success: result.success, prompts: result.prompts || [], error: result.error, connectionId: connId }
      } catch (e: any) {
        return { success: false, error: e.message }
      }
    },

    callTool: async (toolName, args, connectionId) =>
      service.callTool(toolName, args as any, connectionId),

    readResource: async (params, connectionId) => {
      try {
        const connId = connectionId || (m.listConnections() as any[]).find((c: any) => c.status === 'connected')?.connectionId
        if (!connId) return { success: false, error: '没有活跃的MCP连接' }
        const result = await m.readResource(params.uri, connId)
        return { success: result.success, content: result.content, error: result.error, connectionId: connId }
      } catch (e: any) {
        return { success: false, error: e.message }
      }
    },

    getPrompt: async (params, connectionId) => {
      try {
        const connId = connectionId || (m.listConnections() as any[]).find((c: any) => c.status === 'connected')?.connectionId
        if (!connId) return { success: false, error: '没有活跃的MCP连接' }
        const result = await m.getPrompt(params.name, params.arguments || {}, connId)
        return { success: result.success, prompt: result.prompt, error: result.error, connectionId: connId }
      } catch (e: any) {
        return { success: false, error: e.message }
      }
    },

    getConnectionStatus: async () => {
      const connections = m.listConnections()
      const connected = (connections as any[]).filter((c: any) => c.status === 'connected')
      return { success: true, status: connected.length > 0 ? 'connected' as const : 'disconnected' as const, isConnected: connected.length > 0 }
    },

    listConnections: async () => {
      const connections = (m.listConnections() as any[]).map((c: any) => ({ ...c, connected: c.status === 'connected', connectionId: c.connectionId }))
      return { success: true, connections }
    },

    getActiveConnectionId: async () => {
      return (m.listConnections() as any[]).find((c: any) => c.status === 'connected')?.connectionId
    },

    isConnected: () => (m.listConnections() as any[]).some((c: any) => c.status === 'connected'),

    getStatus: () => (m.listConnections() as any[]).some((c: any) => c.status === 'connected') ? 'connected' : 'disconnected',

    reset: () => { m.disconnectAll() }
  }
}

MCPService.setDefaultClient(createMainProcessMCPClientAdaptor(mcpService))
console.log('✓ MCP客户端适配器已注册到 MCPService')

// 导出 MCP 服务实例，供其他模块使用
export { mcpService }


// ========== Skill 安装管理 IPC ==========
// 实例在下方 nodeFsProvider/pathProvider 定义后创建，此处仅注册回调

ipcMain.handle(IPC_CHANNELS.SKILL_INSTALL, async (_event, source: string, subPath?: string) => {
  return await mainSkillInstaller.installSkill(source, subPath)
})

ipcMain.handle(IPC_CHANNELS.SKILL_UNINSTALL, async (_event, name: string) => {
  return await mainSkillInstaller.uninstallSkill(name)
})

ipcMain.handle(IPC_CHANNELS.SKILL_UPDATE, async (_event, name: string) => {
  return await mainSkillInstaller.updateSkill(name)
})





/**
 * 获取用户数据目录
 * 供渲染进程调用，获取 Electron 的 userData 路径
 */
ipcMain.handle('app:get-user-data-path', async () => {
  try {
    const userDataPath = join(os.homedir(), '.chill')
    return { success: true, path: userDataPath }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '获取用户数据目录失败',
    }
  }
})

/**
 * 本实例主进程 PID(UI 三层显示统一:渲染进程的 process 是 vite polyfill 无 pid,
 * 团队运行态的 hostPid 存活锚点=实例主进程 pid,与 instanceRegistry 登记口径一致)
 */
ipcMain.handle('app:main-pid', () => ({ success: true, pid: process.pid }))

// ========== 窗口提醒 IPC（助手回合完成 → 任务栏闪烁） ==========
// 渲染进程每次回合落定都调用；是否闪烁由主进程按窗口聚焦态判定（聚焦则不动，保持渲染侧简单）。
// 闪烁的复位点在 createWindow 的 'focus' 监听（窗口重新聚焦即 flashFrame(false)）
ipcMain.handle(IPC_CHANNELS.WINDOW_NOTIFY_TURN_COMPLETED, async () => {
  const win = BrowserWindow.getAllWindows()[0]
  if (win && (!win.isFocused() || win.isMinimized())) {
    win.flashFrame(true)
  }
})



// ========== Orchestrator 远程配置持久化 IPC 通道（新增） ==========

/**
 * 读取远程配置
 * 扫描 agents/remote/*.json，返回 RemoteAgentConfig[]
 */
ipcMain.handle('orchestrator:read-remote-configs', async () => {
  try {
    const remoteDir = join(os.homedir(), '.chill', 'agents', 'remote')
    await ensureDirectoryExists(remoteDir)

    const files = await readdir(remoteDir)
    const configs = await Promise.all(
      files
        .filter((f) => f.endsWith('.json'))
        .map(async (f) => {
          const content = await fs.promises.readFile(join(remoteDir, f), 'utf-8')
          return JSON.parse(content)
        })
    )

    return { success: true, configs }
  } catch (error) {
    console.error('【Orchestrator IPC】读取远程配置失败:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : '读取远程配置失败',
    }
  }
})

/**
 * 写入远程配置
 * 接收 key 和 config，写 remote/{key}.json
 */
ipcMain.handle('orchestrator:write-remote-config', async (event, key: string, config: unknown) => {
  try {
    const remoteDir = join(os.homedir(), '.chill', 'agents', 'remote')
    await ensureDirectoryExists(remoteDir)

    const filePath = join(remoteDir, `${key}.json`)
    await writeFile(filePath, JSON.stringify(config, null, 2), 'utf-8')

    return { success: true }
  } catch (error) {
    console.error('【Orchestrator IPC】写入远程配置失败:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : '写入远程配置失败',
    }
  }
})

/**
 * 删除远程配置
 * 接收 key，删 remote/{key}.json
 */
ipcMain.handle('orchestrator:delete-remote-config', async (event, key: string) => {
  try {
    const remoteDir = join(os.homedir(), '.chill', 'agents', 'remote')
    const filePath = join(remoteDir, `${key}.json`)

    await unlink(filePath)
    return { success: true }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { success: true }
    }
    console.error('【Orchestrator IPC】删除远程配置失败:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : '删除远程配置失败',
    }
  }
})


// ========== CodeExecutor 实例 ==========

const codeExecutor = new CodeExecutor()
setCodeServiceExecutor(codeExecutor)

// ========== 持久化实例 ==========

const pathProvider = new ElectronPathProvider()
const draftPersistence = new DraftPersistence(pathProvider)
// 会话管理：与 CLI 共用 core 的 SessionPersistence（同落 ~/.chill/sessions/）
const sessionPersistence = new SessionPersistence(pathProvider)
// M5 会话删除清账（headless：仅取数不持钟——渲染进程的 sharedScheduler 是时钟持有者，
// 清账写共享任务清单文件，mtime 惰性重载使两端收敛）：绑定被删会话的 session 任务转 orphaned
{
  const cleanerScheduler = new SchedulerService({
    store: new TaskStore(new NodeFileSystemProvider(), join(pathProvider.getUserDataPath(), 'scheduled-tasks.json')),
  })
  setSessionTaskCleaner(async (sessionId) => {
    await cleanerScheduler.markSessionDeleted(sessionId)
  })
}
// 项目管理：core ProjectPersistence 单文件存整个项目数组（~/.chill/projects.json）
const projectPersistence = new ProjectPersistence(pathProvider)

// ========== 会话管理 IPC ==========
// 会话元数据列表（UI 侧边栏面板）：复用 sessionIndex 对账（无变化零 parse），返回按 updatedAt 降序的 SessionSummary[]
ipcMain.handle('session:list-meta', async () => {
  try {
    return { success: true, records: await listSessionSummaries(sessionPersistence.getSessionsDir()) }
  } catch (error) {
    return { success: false, records: [], error: error instanceof Error ? error.message : '会话列表读取失败' }
  }
})
// 单会话直读（切换会话/打开搜索结果/自动标题）：只读一个文件，替代全量 list+find
ipcMain.handle('session:load', async (_event, id: string) => sessionPersistence.load(id))
// 项目归属单字段补丁（移动/清除/归组）：projectId 传 null 时转 undefined（清除归属）
ipcMain.handle('session:patch-project', async (_event, id: string, projectId: string | null) =>
  sessionPersistence.patchProjectId(id, projectId ?? undefined))
// 会话标题单字段补丁（UI 行内重命名）：core patchTitle 同次原子写 title + titleSource='manual'，不动 updatedAt
ipcMain.handle('session:patch-title', async (_event, id: string, title: string) =>
  sessionPersistence.patchTitle(id, title))
// 会话内容搜索（UI 侧边栏搜索框）：检索语义在 core sessionSearch（与 search_sessions 工具共用 sessionIndex 原语）
ipcMain.handle('session:search', async (_event, query: string) => {
  try {
    return { success: true, hits: searchSessionRecords(sessionPersistence.getSessionsDir(), String(query ?? '')) }
  } catch (error) {
    return { success: false, hits: [], error: error instanceof Error ? error.message : '搜索失败' }
  }
})
// mode 透传（T5 ChatEngine：regenerate 删消息后需 replace 整盘覆写，merge 会按消息键复活已删消息）
ipcMain.handle('session:save', async (_event, record: SessionRecord, mode?: SaveMode) => sessionPersistence.save(record, mode))
ipcMain.handle('session:delete', async (_event, id: string) => sessionPersistence.delete(id))
// 会话跨端同步：渲染进程经 session:watch 报告当前会话 id，主进程重定向 watch（同一时刻只 watch 当前会话）；
// 对端（CLI）写入经 watch 命中后转发 session:changed（record 为 null 表示文件已被删除；自身写入已内部过滤）
let watchedSessionId: string | null = null
ipcMain.handle('session:watch', async (_event, id: string) => {
  if (watchedSessionId && watchedSessionId !== id) sessionPersistence.unwatch(watchedSessionId)
  watchedSessionId = id
  sessionPersistence.watch(id, (record) => {
    const win = BrowserWindow.getAllWindows()[0]
    win?.webContents.send('session:changed', record)
  })
  return { success: true }
})
// 发送前锚定：仅当磁盘记录比本端最后一次写入/采纳更新时才返回整 record（否则 record 为 null）
ipcMain.handle('session:loadIfNewer', async (_event, id: string) => sessionPersistence.loadIfNewer(id))
// CLI /ui handoff（三值契约）：'<id>'=接力该会话；''=接力但 CLI 无落盘会话（UI 开全新空会话）；
// null=非 /ui 启动（env 未注入，UI 回退"最新者"）
ipcMain.handle('session:handoff-id', async () => process.env.CHILL_SESSION_ID ?? null)
// ========== relay 会话同步（M6 渲染端无 fs：组包/目录监听只在主进程跑，逻辑在 core 单一事实点） ==========
// catalog 组包：渲染端 buildCatalogState 覆写为本 IPC（buildCatalogStateBody=与 makeSessionSyncBridgeDeps 同一函数）
ipcMain.handle('relay:catalog-state', async (_event, payload: { known: unknown; activeSessionId: string | null }) =>
  buildCatalogStateBody(
    {
      sessionsDir: sessionPersistence.getSessionsDir(),
      listProjects: async () => (await projectPersistence.list()).records ?? [],
      getActiveSessionId: () => payload?.activeSessionId ?? null,
    },
    payload?.known as never,
  ),
)
// 目录元数据监听（wireSessionCatalogWatch 原样在主进程装配，fs.watch 只能在 Node 域）：
// bridge 鸭子=只触 pushSessionEvent（core 已放宽为 Pick）→ webContents.send 推渲染端转发当前桥。
// 进程级常驻（同 SUBAGENT_TOOL_CALL 转发先例）；窗口未建/已毁时丢信号，桥侧 catalog.sync 按需拉兜底
{
  const sendCatalogEvent = (body: unknown): void => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win && !win.isDestroyed()) win.webContents.send('relay:session-event', body)
  }
  wireSessionCatalogWatch(
    { pushSessionEvent: sendCatalogEvent } as never,
    {
      sessionsDir: sessionPersistence.getSessionsDir(),
      listProjects: async () => (await projectPersistence.list()).records ?? [],
    },
  )
}
app.on('before-quit', () => sessionPersistence.unwatch())
// relay 清理（M2a）：停传输 + 清心跳 + 退租（幂等）
app.on('before-quit', () => {
  void stopRelayForQuit()
})

// ========== 项目管理 IPC ==========
ipcMain.handle('project:list', async () => projectPersistence.list())
ipcMain.handle('project:save', async (_event, record: ProjectRecord) => projectPersistence.save(record))
ipcMain.handle('project:delete', async (_event, id: string) => projectPersistence.delete(id))
const mainSecureStorage = new MainProcessSecureStorage()
// Subagent Worker 网关注入：core MCP 服务（默认 client 已于 L928 桥接 ElectronMCPService）
// + 渲染进程转发器（渲染进程 core 单例拥有真实确认流 PiniaConfirmationHandler 与 fs 桥，
// Worker 内置工具经此继承宿主确认/autoApply 语义；挂起配对模式同 plan:ask-user）
const forkMcpService = new MCPService()
const pendingSubagentBuiltinCalls = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>()
let subagentBuiltinSeq = 0
const rendererBuiltinForwarder = (toolName: string, args: string, toolCallId?: string) =>
  new Promise<any>((resolve, reject) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) {
      reject(new Error('没有可用的窗口，无法执行 Subagent 内置工具'))
      return
    }
    const requestId = `sbi-${Date.now()}-${++subagentBuiltinSeq}`
    pendingSubagentBuiltinCalls.set(requestId, { resolve, reject })
    // __origin 同名字段透传（Worker 归属，网关于 args 保留字段注入；args 字符串原样携带，
    // 此处再解析为载荷独立字段供渲染进程直接消费；解析失败静默缺省）
    let origin: unknown
    try {
      origin = JSON.parse(args)?.__origin
    } catch {
      // args 非 JSON 时不带归属（宿主 executor 按主会话缺省）
    }
    win.webContents.send(IPC_CHANNELS.SUBAGENT_BUILTIN_REQUEST, { requestId, toolName, args, toolCallId, __origin: origin })
  })
ipcMain.handle(IPC_CHANNELS.SUBAGENT_BUILTIN_RESPONSE, (_event, payload: { requestId: string; result?: any; error?: string }) => {
  const pending = pendingSubagentBuiltinCalls.get(payload?.requestId)
  if (!pending) return { success: false, error: `未找到挂起的请求: ${payload?.requestId}` }
  pendingSubagentBuiltinCalls.delete(payload.requestId)
  if (payload.error) pending.reject(new Error(payload.error))
  else pending.resolve(payload.result)
  return { success: true }
})
// 预热注入（getForkManager 单例"首个调用者定参"；before-quit 清理路径为无参调用，须保证注入在先）
getForkManager(forkMcpService, rendererBuiltinForwarder)

// Worker MCP hooks 派发通道（阶段 4）：Worker 的 MCP 调用经 IPC 抵达主进程网关
// （TemplateSubagentForkManager mcp 分支），但 HookRunner 在渲染进程——core 派发通道是进程内
// 单例，故在主进程注册"转发器"：挂起配对模式同上面的 subagent:builtin-request，请求推渲染进程、
// 由渲染进程 core 单例 dispatcher（ChatEngine 构造时注册，含 ask 升级审批/systemMessage 全套语义）
// 过管线后回包。无窗口或回包异常时 resolve(null)=跳过 hooks（与未注册行为一致，fail-open）。
const pendingWorkerMcpHookCalls = new Map<string, { resolve: (v: WorkerMcpHookOutcome | null) => void }>()
let workerMcpHookSeq = 0
setWorkerMcpHookDispatcher((event: 'PreToolUse' | 'PostToolUse', call: WorkerMcpHookCall) =>
  new Promise<WorkerMcpHookOutcome | null>((resolve) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) {
      resolve(null)
      return
    }
    const requestId = `wmh-${Date.now()}-${++workerMcpHookSeq}`
    pendingWorkerMcpHookCalls.set(requestId, { resolve })
    win.webContents.send(IPC_CHANNELS.WORKER_MCP_HOOK_REQUEST, { requestId, event, call })
  })
)
ipcMain.handle(IPC_CHANNELS.WORKER_MCP_HOOK_RESPONSE, (_event, payload: { requestId: string; outcome?: WorkerMcpHookOutcome | null; error?: string }) => {
  const pending = pendingWorkerMcpHookCalls.get(payload?.requestId)
  if (!pending) return { success: false, error: `未找到挂起的请求: ${payload?.requestId}` }
  pendingWorkerMcpHookCalls.delete(payload.requestId)
  // 渲染进程派发异常按 fail-open 处理（hooks 默认语义），不升级为 Worker 工具错误
  if (payload.error) console.warn('[hooks] Worker MCP hook 派发失败:', payload.error)
  pending.resolve(payload.error ? null : (payload.outcome ?? null))
  return { success: true }
})
const subagentExecutor = new SubagentExecutor()
SubagentExecutor.setExecutor((...args) => new StandardSubagentExecutor(mainSecureStorage, () => getForkManager()).execute(...args))
SecureStorageService.initialize(mainSecureStorage)
const nodeFsProvider = new NodeFileSystemProvider()

// Node-only 工具路由执行端：渲染进程经 builtin:execute-node-tool 转发 requiresNodeFs 的工具到此执行。
// 这些工具（search_sessions/search_content/write_plan/read_plan/submit_plan/trigger_guardian）
// 已实证不使用 _deps 四个依赖，故确认/定位/代码执行三个依赖用 no-op stub。
const noopConfirmationHandler: IConfirmationHandler = {
  addPendingOperation: () => {},
  getPendingOperations: () => [],
  getDocumentSnapshot: () => null,
  setDocumentSnapshot: () => {},
  clearAll: () => {},
}
const noopPositionCalculator: IPositionCalculator = {
  getSnapshot: async () => null,
  calculateInsertPosition: () => ({ success: false, error: 'noop' } as any),
  calculatePosition: async () => ({ success: false, error: 'noop' } as any),
}
const noopCodeExecutor: ICodeExecutor = {
  executeChildProcess: async () => ({ success: false, error: 'noop' } as any),
  executeInteractive: async () => ({ success: false, error: 'noop' }),
  sendInput: async () => ({ success: false, error: 'noop' }),
  terminateProcess: async () => ({ success: false, error: 'noop' }),
  executePowerShell: async () => ({ success: false, error: 'noop' } as any),
}
const mainBuiltInExecutor = new BuiltInToolExecutor(nodeFsProvider, noopConfirmationHandler, noopPositionCalculator, noopCodeExecutor)
ipcMain.handle('builtin:execute-node-tool', async (_event, toolName: string, args: string): Promise<BuiltInToolResult> => {
  return mainBuiltInExecutor.executeAsync(toolName, args)
})

// ========== 规划模式 IPC（UI 侧 planModeStore 经此同步主进程 executor 状态） ==========
// 挂起的用户提问：submit_plan/ask_user 经 userInputProvider.ask 发起并挂起，渲染进程作答后按 id 兑现
const pendingPlanAsks = new Map<string, (answer: string) => void>()
let planAskSeq = 0
mainBuiltInExecutor.setUserInputProvider({
  ask: (question, options, allowFreeText) => new Promise<string>((resolve, reject) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) {
      reject(new Error('没有可用的窗口，无法向用户提问'))
      return
    }
    const id = `plan-ask-${Date.now()}-${++planAskSeq}`
    pendingPlanAsks.set(id, resolve)
    win.webContents.send('plan:ask-user-request', { id, question, options, allowFreeText })
  }),
})
ipcMain.handle('plan:set-mode', async (_event, on: boolean) => {
  mainBuiltInExecutor.setPlanMode(!!on)
  return { success: true }
})
ipcMain.handle('plan:ask-user-response', async (_event, id: string, answer: string) => {
  const resolve = pendingPlanAsks.get(id)
  if (!resolve) return { success: false, error: `未找到挂起的提问: ${id}` }
  pendingPlanAsks.delete(id)
  resolve(answer)
  return { success: true }
})
// 规划被批准（submit_plan 经 Node 工具路由在本进程执行，eventBus 同步可达）：退出规划模式并通知渲染进程
eventBus.on(EVENTS.PLAN_APPROVED, () => {
  mainBuiltInExecutor.setPlanMode(false)
  BrowserWindow.getAllWindows()[0]?.webContents.send('plan:mode-changed', false)
})

// ========== 目标模式 IPC（对照规划模式；UI 侧 goalModeStore 经此同步主进程 executor 状态） ==========
// read_goal 是 Node-only 工具、经 builtin:execute-node-tool 路由在本进程执行，"仅目标模式"门需两端一致。
// 其余 goal 工具（propose_goal/write_goal/request_goal_review/report_goal_blocked）在渲染进程 executor
// 执行（纯事件/回调中继，无 fs 依赖），引擎回调已注册在渲染进程 executor 上，主进程无需挂起问答配对。
ipcMain.handle('goal:set-mode', async (_event, on: boolean) => {
  mainBuiltInExecutor.setGoalMode(!!on)
  return { success: true }
})

// 目标文档落盘（渲染进程引擎的 goalStore 适配器经此桥到 core goalPersistence；~/.chill/goals/）
ipcMain.handle('goal:save', async (_event, state: any) => {
  try {
    saveCurrentGoal(state)
    return { success: true }
  } catch (error: any) {
    return { success: false, error: error?.message ?? String(error) }
  }
})
ipcMain.handle('goal:archive', async (_event, state: any) => {
  try {
    archiveCurrentGoal(state)
    return { success: true }
  } catch (error: any) {
    return { success: false, error: error?.message ?? String(error) }
  }
})
ipcMain.handle('goal:clear', async () => {
  try {
    clearCurrentGoal()
    return { success: true }
  } catch (error: any) {
    return { success: false, error: error?.message ?? String(error) }
  }
})
const modelsDir = join(pathProvider.getUserDataPath(), 'models')
modelInfoService.setFileSystemProvider(nodeFsProvider)
modelInfoService.setSecureStorage(mainSecureStorage)
modelInfoService.setModelsDir(modelsDir)
modelInfoService.setKeyValueStore(kvStore)
providerManager.setFileSystemProvider(nodeFsProvider)
providerManager.setProvidersDir(modelsDir)
// 内置技能目录（打包优先 resources，开发回退 monorepo 源码目录，npm 全档壳包兜底
// （skills/builtin 与 cli dist 同构）；UI 经 skill:builtin-dir 获取）
const builtinSkillsDir = (() => {
  const candidates = [
    join(process.resourcesPath ?? '', 'skills', 'builtin'),
    join(__dirname, '../../core/src/skills/builtin'),
    join(__dirname, 'skills', 'builtin'),
  ]
  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p } catch { /* 继续找 */ }
  }
  return null
})()
const mainSkillLoader = new SkillLoader(nodeFsProvider, pathProvider, '', builtinSkillsDir ?? undefined)
// managed 布局（有 chill 源码环境）判定：与 CLI 的 npm 模式过滤同一语义，UI 据此过滤 self-iterate
const isManagedLayout = getOwnProjectPaths().projectPath !== null
ipcMain.handle('skill:builtin-dir', async () => ({ success: true, path: builtinSkillsDir, managed: isManagedLayout }))
const mainSkillInstaller = new SkillInstaller(nodeFsProvider, pathProvider, mainSkillLoader, getSkillRegistry())

// ========== 模块级 TemplateManager 引用（供 12a-d 使用） ==========
let templateManager: ReturnType<typeof getTemplateManager>
let userDataPath: string

// ========== 异步初始化：TemplateManager + 清理 + 扫描注入（步骤 11a/b） ==========
;(async () => {

const templateLoader = new FileSystemTemplateLoader(nodeFsProvider, builtinTemplatesDir)
createTemplateManager(templateLoader)
await getTemplateManager().initialize()
console.log('【SubagentTemplateManager】初始化完成')

// 注册协议处理器（主进程执行 workflow 时需要）
BaseModelService.registerProtocolHandler('openai-chat', openAIChatHandler)
registerAsyncTaskFamilies((p, h) => BaseModelService.registerProtocolHandler(p, h))
    BaseModelService.registerProtocolHandler('anthropic-messages', anthropicChatHandler)

  // 清理旧的 .orchestrator 目录
  try {
    const oldOrchDir = join(os.homedir(), '.orchestrator', 'agents')
    if (fs.existsSync(oldOrchDir)) {
      await fs.promises.rm(oldOrchDir, { recursive: true, force: true })
      console.log('[Cleanup] 已删除旧 .orchestrator/agents/ 目录')
    }
  } catch (cleanupErr) {
    console.warn('[Cleanup] 清理旧目录失败（可忽略）:', cleanupErr)
  }

templateManager = getTemplateManager()
userDataPath = pathProvider.getUserDataPath()

// ========== 启动扫描注入远程 Agent 模板（步骤 11b；本地 SavedAgent 体系已退役） ==========
try {
  const remoteDir = join(userDataPath, 'agents', 'remote')
  const allTemplates: SubagentTemplate[] = []

  // 扫描 agents/remote/*.json → Coze/A2A generateTemplateObject()
  try {
    const cozeGenerator = new CozeTemplateGenerator()
    const a2aGenerator = new A2ATemplateGenerator()
    const remoteEntries = await readdir(remoteDir).catch(() => [] as string[])
    for (const file of remoteEntries) {
      if (!file.endsWith('.json')) continue
      const content = await fs.promises.readFile(join(remoteDir, file), 'utf-8')
      const config = JSON.parse(content) as RemoteAgentConfig
      const template = config.type === 'coze'
        ? await cozeGenerator.generateTemplateObject(config)
        : await a2aGenerator.generateTemplateObject(config)
      allTemplates.push(template)
    }
  } catch (err) {
    console.warn('【启动扫描】读取远程 Agent 失败:', err)
  }

  // 3. 整体替换 remoteTemplates
  templateManager.resetRemoteTemplates(allTemplates)
  console.log(`【启动扫描】已注入 ${allTemplates.length} 个 Agent 模板`)
} catch (err) {
  console.error('【启动扫描】注入模板失败:', err)
}

// ========== 用户级自定义模板装配（仅用户级；主进程不持有 workDir，项目级归 UI 渲染进程） ==========
const userTemplatesDir = join(userDataPath, 'agents', 'templates')
// 目录不存在时先创建，否则 fs.watch 会抛 ENOENT（与 CLI 的 mkdir 范式一致）
if (!fs.existsSync(userTemplatesDir)) {
  fs.mkdirSync(userTemplatesDir, { recursive: true })
}

// 初始扫描用户目录 → setCustomTemplates（主进程不加载项目级，传空数组）
// onErrors：解析/读取失败打印可见（此前静默丢弃，写错的模板无人察觉）
const printTemplateErrors = (errs: string[], warns: string[] = [], infos: string[] = []) => {
  if (errs.length > 0)
    console.warn(`【自定义模板】${errs.length} 个模板加载失败:\n${errs.map((e) => `  - ${e}`).join('\n')}`)
  if (warns.length > 0)
    console.warn(`【自定义模板】${warns.length} 条警告:\n${warns.map((w) => `  - ${w}`).join('\n')}`)
  if (infos.length > 0)
    console.log(`【自定义模板】${infos.length} 条提示:\n${infos.map((i) => `  - ${i}`).join('\n')}`)
}
const userTemplates = await templateLoader.loadTemplatesFromDirectory(userTemplatesDir, printTemplateErrors)
templateManager.setCustomTemplates(userTemplates, [])
console.log(`【自定义模板】已加载 ${userTemplates.length} 个用户级模板`)

// 监听用户模板目录变更，500ms 防抖重扫并推送渲染进程（参照 CLI startSkillsWatcher 范式）
let templateReloadTimer: NodeJS.Timeout | null = null
const templateWatcher = fs.watch(userTemplatesDir, (_event, filename) => {
  if (!filename || !filename.endsWith('.md')) return
  // 防抖：500ms内的变更合并为一次重载
  if (templateReloadTimer) clearTimeout(templateReloadTimer)
  templateReloadTimer = setTimeout(async () => {
    try {
      const reloaded = await templateLoader.loadTemplatesFromDirectory(userTemplatesDir, printTemplateErrors)
      templateManager.setCustomTemplates(reloaded, [])
      console.log(`【自定义模板】热重载完成，${reloaded.length} 个用户级模板`)
      pushTemplateUpdate()
    } catch (err) {
      console.warn('【自定义模板】热重载失败:', err)
    }
  }, 500)
})
// 目录 watch 失败（如目录被删）不抛出：监视错误是常态数据，模板变更下次启动重扫即可
templateWatcher.on('error', (err) => console.warn('【自定义模板】目录 watch 错误（已忽略）:', err))

// ========== 命名工作流目录监听(M2):用户级 ~/.chill/workflows/ + 渲染进程登记的项目级目录 ==========
const userWorkflowsDir = join(userDataPath, 'workflows')
// 目录不存在时先创建,否则 fs.watch 抛 ENOENT(与模板目录同范式)
if (!fs.existsSync(userWorkflowsDir)) {
  fs.mkdirSync(userWorkflowsDir, { recursive: true })
}
// 运行记录目录(M6;CLI/渲染进程写,主进程确保存在)
const workflowRunsDir = join(userDataPath, 'workflow-runs')
if (!fs.existsSync(workflowRunsDir)) {
  fs.mkdirSync(workflowRunsDir, { recursive: true })
}
const workflowWatchers = new Map<string, fs.FSWatcher>()
let workflowNotifyTimer: NodeJS.Timeout | null = null
const notifyWorkflowsChanged = () => {
  // 防抖:500ms 内变更合并为一次推送(与模板热重载同范式)
  if (workflowNotifyTimer) clearTimeout(workflowNotifyTimer)
  workflowNotifyTimer = setTimeout(() => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) win.webContents.send('workflows:changed')
  }, 500)
}
const watchWorkflowDir = (dir: string) => {
  if (workflowWatchers.has(dir)) return
  try {
    if (!fs.existsSync(dir)) return
    const watcher = fs.watch(dir, (_event, filename) => {
      if (!filename || !filename.endsWith('.yaml')) return
      notifyWorkflowsChanged()
    })
    watcher.on('error', (err) => console.warn('【工作流】目录 watch 错误（已忽略）:', err))
    workflowWatchers.set(dir, watcher)
  } catch (err) {
    console.warn('【工作流】目录监听失败（已忽略）:', dir, err)
  }
}
watchWorkflowDir(userWorkflowsDir)

// ========== 旧资产一次性迁移(M3):SavedWorkflow + 多节点 SavedAgent → YAML 命名工作流 ==========
// 注:旧 SavedWorkflow 目录与 YAML 目录同为 <userData>/workflows(扩展名分治,.json 迁移后删除)
try {
  const migrationReport = await migrateLegacyWorkflowAssets(nodeFsProvider, {
    legacyWorkflowsDir: join(userDataPath, 'workflows'),
    legacyAgentsDir: join(userDataPath, 'agents', 'local'),
    targetDir: userWorkflowsDir,
    templatesDir: join(userDataPath, 'agents', 'templates'),
  })
  if (migrationReport.migrated.length > 0) {
    console.log(`【工作流迁移】成功 ${migrationReport.migrated.length} 项:`, migrationReport.migrated)
  }
  if (migrationReport.skipped.length > 0) {
    console.log('【工作流迁移】跳过:', migrationReport.skipped)
  }
  if (migrationReport.errors.length > 0) {
    console.warn('【工作流迁移】错误:', migrationReport.errors)
  }
} catch (err) {
  console.warn('【工作流迁移】执行失败(不影响启动):', err)
}

// ========== 固定团队(班底)目录监听(与工作流 watcher 同范式;热生效推送) ==========
const userTeamsDir = join(userDataPath, 'teams')
if (!fs.existsSync(userTeamsDir)) {
  fs.mkdirSync(userTeamsDir, { recursive: true })
}
const teamWatchers = new Map<string, fs.FSWatcher>()
let teamNotifyTimer: NodeJS.Timeout | null = null
const notifyTeamsChanged = () => {
  if (teamNotifyTimer) clearTimeout(teamNotifyTimer)
  teamNotifyTimer = setTimeout(() => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) win.webContents.send('teams:changed')
  }, 500)
}
const watchTeamDir = (dir: string) => {
  if (teamWatchers.has(dir)) return
  try {
    if (!fs.existsSync(dir)) return
    const watcher = fs.watch(dir, (_event, filename) => {
      if (!filename || !filename.endsWith('.yaml')) return
      notifyTeamsChanged()
    })
    watcher.on('error', (err) => console.warn('【团队】目录 watch 错误（已忽略）:', err))
    teamWatchers.set(dir, watcher)
  } catch (err) {
    console.warn('【团队】目录监听失败（已忽略）:', dir, err)
  }
}
watchTeamDir(userTeamsDir)

ipcMain.handle('teams:watch-dirs', async (_event, dirs: string[]) => {
  try {
    for (const dir of Array.isArray(dirs) ? dirs : []) {
      if (typeof dir === 'string' && dir) watchTeamDir(dir)
    }
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : '登记团队监听失败' }
  }
})

ipcMain.handle('workflows:watch-dirs', async (_event, dirs: string[]) => {
  try {
    for (const dir of Array.isArray(dirs) ? dirs : []) {
      if (typeof dir === 'string' && dir) watchWorkflowDir(dir)
    }
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : '登记工作流监听失败' }
  }
})

// ========== 跨进程团队运行快照目录监听(UI 三层显示统一 · 迭代 2;teams:changed 同款 500ms 防抖推送) ==========
// team-runs 是首个团队诞生时才建的——装配时先 ensureDir,避免 watchTeamDir"目录缺失直接 return、后建即漏听"的漏听窗
const teamRunsDir = join(userDataPath, 'team-runs')
if (!fs.existsSync(teamRunsDir)) {
  try {
    fs.mkdirSync(teamRunsDir, { recursive: true })
  } catch (err) {
    console.warn('【团队】team-runs 目录创建失败(本轮不挂快照监听):', err)
  }
}
let teamRunsNotifyTimer: NodeJS.Timeout | null = null
const notifyTeamRunsChanged = () => {
  if (teamRunsNotifyTimer) clearTimeout(teamRunsNotifyTimer)
  teamRunsNotifyTimer = setTimeout(() => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) win.webContents.send('team-runs:changed')
  }, 500)
}
try {
  // 快照文件在 run 子目录内(roster/board/snapshot.json),safeWatcher(chokidar)递归监听;error 由 safeWatcher 就地消化
  const teamRunsWatcher = createSafeChokidar(teamRunsDir, { ignoreInitial: true, depth: 1 })
  teamRunsWatcher.on('all', (_event, filePath) => {
    if (!filePath.endsWith('.json')) return // 只关心 *.json(顺带滤掉 atomicWrite 的 .tmp 中间件)
    notifyTeamRunsChanged()
  })
} catch (err) {
  console.warn('【团队】team-runs 目录监听失败(已忽略):', teamRunsDir, err)
}

// 快照区存活探测:存活兄弟实例 PID 清单(instanceRegistry 现成函数,不新造机制)
ipcMain.handle('instances:live-pids', async () => {
  try {
    return { success: true, pids: getLiveInstancePids(userDataPath) }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : '查询存活实例失败' }
  }
})

// 执行过程面板(迭代 2):Worker 工具调用事件桥——委派执行(StandardSubagentExecutor/网关)在主进程,
// 事件本只活在主进程 eventBus;转发给渲染进程药丸 store(与 teams:changed 同款推送范式)
eventBus.on(EVENTS.SUBAGENT_TOOL_CALL, (payload) => {
  const win = BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed()) win.webContents.send('subagent-tool-call', payload)
})

})()

// ========== 注册延后的 IPC handler（步骤 11c） ==========
/**
 * 渲染进程请求获取全部模板（templateManager 已就绪后注册）
 */
ipcMain.handle('orchestrator:get-all-templates', async () => {
  try {
    const tm = getTemplateManager()
    const templates = tm.getAllTemplates()
    return { success: true, templates }
  } catch (error) {
    console.error('【Orchestrator IPC】获取全部模板失败:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : '获取模板失败',
    }
  }
})

// ========== 推送模板更新到渲染进程（步骤 12a） ==========
/**
 * 向渲染进程推送模板更新通知
 * 在 templateManager 变更（新增/删除 Agent）后调用
 */
function pushTemplateUpdate() {
  const win = BrowserWindow.getAllWindows()[0]
  if (win) {
    win.webContents.send('orchestrator:templates-reloaded', {
      remoteTemplates: templateManager.getRemoteTemplates(),
      allTemplates: templateManager.getAllTemplates(),
    })
  }
}

// ========== 创建 RemoteAgentRegistrar + 注册 NOTIFY_AGENTS_CHANGED handler（步骤 12b） ==========
const registrar = new RemoteAgentRegistrar(templateManager, pushTemplateUpdate)

ipcMain.handle('orchestrator:notify-agents-changed', async (_event, agents: RemoteAgentConfig[]) => {
  try {
    await registrar.handleAgentsChanged(agents)
    return { success: true }
  } catch (error) {
    console.error('【Orchestrator IPC】处理 Agents 变更失败:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : '处理 Agents 变更失败',
    }
  }
})


// ========== Subagent 执行相关 IPC ==========

ipcMain.handle(IPC_CHANNELS.SUBAGENT_EXECUTE, async (_event, request) => {
  try {
    const result = await subagentExecutor.execute(
      request.template,
      request.taskDescription,
      request.mergedParams,
      request.startTime,
      request.tools,
      request.availableTools,
      request.apiKey,
      request.baseURL,
      // 环境绑定键（toolCall.id）透传：Worker 环境以此键登记进主进程任务注册表，
      // 渲染进程 cancel_task 经 SUBAGENT_CANCEL 按同键找回并销毁
      request.environmentKey,
      // 下行附加信息（成功标准/评审标记/resume 种子）透传
      request.extras
    )
    return { success: true, result }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Subagent 任务执行失败'
    }
  }
})

// 取消后台任务：渲染进程的任务注册表无本地环境绑定（Worker 在主进程 fork），
// cancel_task 经此通道按环境绑定键找回主进程注册表里的 Worker 环境并销毁
ipcMain.handle(IPC_CHANNELS.SUBAGENT_CANCEL, async (_event, request: { environmentKey?: string }) => {
  try {
    const key = request?.environmentKey
    if (!key) {
      return { success: false, error: '缺少 environmentKey 参数' }
    }
    const environment = getTaskRegistry().getEnvironment(key)
    if (!environment) {
      return { success: false, error: '未找到对应的后台任务环境（可能已结束）' }
    }
    await environment.destroy()
    getTaskRegistry().unbindEnvironment(key)
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '取消 Subagent 任务失败'
    }
  }
})

// ========== PowerShell 执行相关 IPC ==========

ipcMain.handle(IPC_CHANNELS.POWERSHELL_EXECUTE, async (_event, { command, options }) => {
  return executePowerShell(command, options)
})

// ========== 桌面能力 IPC（迭代 4.1） ==========
// 单通道多路复用：渲染进程 ElectronDesktopController（IDesktopController 的 IPC 桥）经此
// 调主进程原生实现；napi 模块只能在主进程加载，DesktopMainController 内部懒加载 + 可控降级
const desktopMainController = new DesktopMainController()
// 实例注册表（多实例互攻防护）：登记本实例 + 周期性把兄弟 chill 实例根 PID 推给原生保护集
// （CLI+UI 同时运行时彼此的窗口互为宿主禁区；pathProvider.getUserDataPath() = ~/.chill）
const unregisterDesktopInstance = registerInstance(pathProvider.getUserDataPath(), 'ui')
const pushSiblingPids = () => {
  void desktopMainController.setProtectedExtraPids(getLiveInstancePids(pathProvider.getUserDataPath())).catch(() => { /* 防护增强失败不阻断主流程 */ })
}
pushSiblingPids()
const siblingPidsTimer = setInterval(pushSiblingPids, 30_000)
siblingPidsTimer.unref()
app.on('will-quit', () => {
  clearInterval(siblingPidsTimer)
  unregisterDesktopInstance()
})
// 方法白名单：只放行 IDesktopController 的契约方法，防泛化 invoke 桥被滥用
const DESKTOP_METHODS = new Set(['isAvailable', 'listDisplays', 'capture', 'input', 'snapshot', 'invokeElement', 'setElementValue', 'focusWindow', 'preflight', 'releaseAllInputs', 'setProtectedExtraPids', 'setApprovalPending', 'manageWindow'])
ipcMain.handle(IPC_CHANNELS.DESKTOP_CALL, async (_event, { method, args }: { method: string; args: unknown[] }) => {
  if (!DESKTOP_METHODS.has(method)) {
    return { success: false, error: `未知的桌面方法: ${method}` }
  }
  return await (desktopMainController as any)[method](...(args ?? []))
})

// 桌面审计（单工 send，不等回包）：渲染进程 ElectronDesktopAuditSink 投递条目，主进程落盘
ipcMain.on(IPC_CHANNELS.DESKTOP_AUDIT, (_event, entry: DesktopAuditEntry, imageDataUri?: string) => {
  recordDesktopAudit(entry, imageDataUri)
})

// ========== 代码执行相关 IPC ==========

ipcMain.handle(IPC_CHANNELS.CODE_EXECUTE_JS, async (_event, { code, options, language }) => {
  const lang = (language || 'javascript') as SupportedLanguage
  console.log(`[Code Executor] 执行 ${lang} 代码`)
  return codeExecutor.executeChildProcess(lang, code, options)
})

ipcMain.handle(IPC_CHANNELS.CODE_START_INTERACTIVE, async (event, { code, language }) => {
  const lang = (language || 'python') as SupportedLanguage
  console.log(`[Interactive Executor] 启动交互式 ${lang} 进程`)
  return codeExecutor.executeInteractive(lang, code, {
    onOutput: ((processId: string, data: string, type: 'stdout' | 'stderr') => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(IPC_CHANNELS.CODE_OUTPUT, { processId, data, type })
      }
    }) as OutputCallback,
    onExit: ((processId: string, code: number, reason: string, error?: string) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(IPC_CHANNELS.CODE_EXIT, { processId, code, reason, error })
      }
    }) as ExitCallback
  })
})

ipcMain.handle(IPC_CHANNELS.CODE_INPUT, async (_event, { processId, input }) => {
  return codeExecutor.sendInput(processId, input)
})

ipcMain.handle(IPC_CHANNELS.CODE_TERMINATE, async (_event, { processId }) => {
  return codeExecutor.terminateProcess(processId)
})

// ========== 草稿相关 IPC ==========

ipcMain.handle(IPC_CHANNELS.DRAFT_SAVE, async (_event, draft) => {
  return draftPersistence.saveDraft(draft)
})

ipcMain.handle(IPC_CHANNELS.DRAFT_LOAD, async () => {
  return draftPersistence.loadDraft()
})

ipcMain.handle(IPC_CHANNELS.DRAFT_EXISTS, async () => {
  return draftPersistence.existsDraft()
})

ipcMain.handle(IPC_CHANNELS.DRAFT_CLEAR, async () => {
  return draftPersistence.clearDraft()
})

// ========== 对话框相关功能 ==========

// 显示保存对话框
ipcMain.handle('dialog:showSaveDialog', async (event, options) => {
  try {
    const result = await dialog.showSaveDialog(options)
    return { success: true, result }
  } catch (error: unknown) {
    console.error('Failed to show save dialog:', error)
    const errorMessage = error instanceof Error ? error.message : String(error)
    return { success: false, error: errorMessage }
  }
})

// 显示打开对话框
ipcMain.handle('dialog:showOpenDialog', async (event, options) => {
  try {
    const result = await dialog.showOpenDialog(options)
    return { success: true, result }
  } catch (error: unknown) {
    console.error('Failed to show open dialog:', error)
    const errorMessage = error instanceof Error ? error.message : String(error)
    return { success: false, error: errorMessage }
  }
})

ipcMain.handle(IPC_CHANNELS.FILE_LIST_DIRECTORY, async (event, dirPath: string, options?: { includeHidden?: boolean }) => {
  try {
    const includeHidden = options?.includeHidden ?? false
    
    const files: Array<{
      id: string
      name: string
      path: string
      type: 'file' | 'directory'
      parentId: string | null
    }> = []

    // 单层列目录（显示多少取多少：子目录内容由渲染层展开时再发新请求）；
    // 目标目录读失败（EPERM 等）整请求返回 error，由调用方决定降级展示
    const entries = await readdir(dirPath, { withFileTypes: true })

    for (const entry of entries) {
      if (!includeHidden && entry.name.startsWith('.')) {
        continue
      }

      const fullPath = join(dirPath, entry.name)

      files.push({
        id: fullPath,
        name: entry.name,
        path: fullPath,
        type: entry.isDirectory() ? 'directory' : 'file',
        parentId: dirPath,
      })
    }

    return { success: true, files }
  } catch (error: unknown) {
    console.error('Failed to list directory:', error)
    const errorMessage = error instanceof Error ? error.message : String(error)
    return { success: false, error: errorMessage }
  }
})

ipcMain.handle('file:read', async (event, filePath: string, options?: { limit?: number; offset?: number }) => {
  try {
    // 超大文件（>20MB）走流式行窗口：前 64KB 检测编码，utf-8 系流式；否则提示分段（非 utf-8 超大文件极罕见）
    const size = fs.statSync(filePath).size
    if (size > 20 * 1024 * 1024) {
      const headBuf = Buffer.alloc(64 * 1024)
      const fd = fs.openSync(filePath, 'r')
      try {
        fs.readSync(fd, headBuf, 0, headBuf.length, 0)
      } finally {
        fs.closeSync(fd)
      }
      const encoding = (jschardet.detect(headBuf).encoding || 'utf-8').toLowerCase()
      if (!encoding.includes('utf') && !encoding.includes('ascii')) {
        return { success: false, error: `超大文件（${Math.round(size / 1024 / 1024)}MB）仅支持 UTF-8 流式读取（检测到 ${encoding}）；请用 execute_code 写流式脚本处理。` }
      }
      // 有界行读取（2026-10-04 根治）：裸 readline 遇"单行 ≥ V8 字符串上限(~536M 字符)"
      // 的文件会在 data 事件上下文抛 RangeError 杀死主进程（serve 实测崩溃+本地复现）；
      // 行长上限内语义不变，超限行截断并如实标注。
      const stream = fs.createReadStream(filePath, { encoding: 'utf-8' })
      const offset = options?.offset ?? 0
      const limit = options?.limit && options?.limit > 0 ? options.limit : Infinity
      const selected: string[] = []
      let lineNo = 0
      try {
        for await (const line of readLinesBounded(stream)) {
          lineNo++
          if (lineNo <= offset) continue
          selected.push(
            line.truncated ? line.text + `…[超长行已截断：原始 ${line.originalLength} 字符]` : line.text
          )
          if (selected.length >= limit) break
        }
      } finally {
        stream.destroy()
      }
      return {
        success: true,
        content: selected.join('\n'),
        totalLines: undefined,
        startLine: offset + 1,
        endLine: offset + selected.length
      }
    }

    // 先读取原始 Buffer 以检测编码
    const buffer = await fs.promises.readFile(filePath)
    
    // 检测编码
    const detection = jschardet.detect(buffer)
    const encoding = detection.encoding || 'utf-8'
    
    // 使用检测到的编码解码
    const content = iconv.decode(buffer, encoding)
    const lines = content.split('\n')
    const totalLines = lines.length
    const offset = options?.offset ?? 0
    const limit = options?.limit ?? lines.length
    
    const selectedLines = lines.slice(offset, offset + limit)
    const resultContent = selectedLines.join('\n')
    
    return { 
      success: true, 
      content: resultContent,
      totalLines,
      startLine: offset + 1,
      endLine: Math.min(offset + limit, totalLines),
      encoding: encoding.toLowerCase()
    }
  } catch (error: unknown) {
    console.error('Failed to read file:', error)
    const errorMessage = error instanceof Error ? error.message : String(error)
    return { success: false, error: errorMessage }
  }
})

ipcMain.handle('file:read-base64', async (event, filePath: string) => {
  try {
    // 二进制读取（知识库 PDF 摄入等场景），base64 编码跨 IPC 传输
    const buffer = await fs.promises.readFile(filePath)
    return { success: true, base64: buffer.toString('base64') }
  } catch (error: unknown) {
    console.error('Failed to read file as base64:', error)
    const errorMessage = error instanceof Error ? error.message : String(error)
    return { success: false, error: errorMessage }
  }
})

ipcMain.handle('file:write', async (event, filePath: string, content: string, encoding?: string) => {
  try {
    // 如果没有指定编码，尝试检测原文件编码
    let targetEncoding = encoding
    if (!targetEncoding) {
      try {
        const buffer = await fs.promises.readFile(filePath)
        const detection = jschardet.detect(buffer)
        targetEncoding = detection.encoding || 'utf-8'
      } catch {
        targetEncoding = 'utf-8'
      }
    }
    
    // 使用指定编码写入
    await fs.promises.mkdir(dirname(filePath), { recursive: true })
    const buffer = iconv.encode(content, targetEncoding)
    await fs.promises.writeFile(filePath, buffer as unknown as Uint8Array)
    return { success: true }
  } catch (error: unknown) {
    console.error('Failed to write file:', error)
    const errorMessage = error instanceof Error ? error.message : String(error)
    return { success: false, error: errorMessage }
  }
})

ipcMain.handle('file:delete', async (event, filePath: string) => {
  try {
    // Windows 的 shell.trashItem 拒绝任何含正斜杠的路径(报 "Failed to parse path",已实测验证);
    // core 资产扫描用 `${dir}/${name}` 拼路径,必然产生混合分隔符。在系统 API 边界统一规范化,
    // 所有渲染层调用方(工作流/模板/文件树删除)一并受益。
    await shell.trashItem(pathNormalize(filePath))
    return { success: true }
  } catch (error: unknown) {
    console.error('Failed to delete file:', error)
    const errorMessage = error instanceof Error ? error.message : String(error)
    return { success: false, error: errorMessage }
  }
})

ipcMain.handle('file:rename', async (event, oldPath: string, newPath: string) => {
  try {
    await fs.promises.rename(oldPath, newPath)
    return { success: true }
  } catch (error: unknown) {
    console.error('Failed to rename file:', error)
    const errorMessage = error instanceof Error ? error.message : String(error)
    return { success: false, error: errorMessage }
  }
})

ipcMain.handle('file:create', async (event, filePath: string, content?: string) => {
  try {
    await fs.promises.writeFile(filePath, content || '')
    return { success: true }
  } catch (error: unknown) {
    console.error('Failed to create file:', error)
    const errorMessage = error instanceof Error ? error.message : String(error)
    return { success: false, error: errorMessage }
  }
})

ipcMain.handle('file:mkdir', async (event, dirPath: string) => {
  try {
    await fs.promises.mkdir(dirPath, { recursive: true })
    return { success: true }
  } catch (error: unknown) {
    console.error('Failed to create directory:', error)
    const errorMessage = error instanceof Error ? error.message : String(error)
    return { success: false, error: errorMessage }
  }
})

ipcMain.handle('file:exists', async (event, filePath: string) => {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK)
    return { success: true, exists: true }
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException
    if (err.code === 'ENOENT') {
      return { success: true, exists: false }
    }
    console.error('Failed to check file exists:', error)
    const errorMessage = error instanceof Error ? error.message : String(error)
    return { success: false, error: errorMessage }
  }
})

ipcMain.handle('file:get-path-type', async (event, filePath: string) => {
  try {
    const stats = await fs.promises.stat(filePath)
    return { success: true, type: stats.isDirectory() ? 'directory' : 'file' }
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException
    if (err.code === 'ENOENT') {
      return { success: true, type: 'not_found' as const }
    }
    console.error('Failed to get path type:', error)
    const errorMessage = error instanceof Error ? error.message : String(error)
    return { success: false, error: errorMessage }
  }
})

// 快照时效对账（core ensureSnapshot）：渲染进程 statFile 契约的 IPC 桥
ipcMain.handle('file:stat', async (event, filePath: string) => {
  try {
    const stats = await fs.promises.stat(filePath)
    return { success: true, mtimeMs: stats.mtimeMs, size: stats.size }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    return { success: false, error: errorMessage }
  }
})

// 独占创建（M6 定时任务触发 claim）：O_EXCL 语义（'wx'）——渲染进程
// IFileSystemProvider.createFileExclusive 契约的 IPC 桥；created=false=已存在（EEXIST）
ipcMain.handle('file:create-exclusive', async (event, filePath: string, content: string) => {
  try {
    await fs.promises.mkdir(dirname(filePath), { recursive: true })
    const handle = await fs.promises.open(filePath, 'wx')
    try {
      await handle.writeFile(content, 'utf-8')
    } finally {
      await handle.close()
    }
    return { success: true, created: true }
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === 'EEXIST') return { success: true, created: false }
    const errorMessage = error instanceof Error ? error.message : String(error)
    return { success: false, error: errorMessage }
  }
})

// 项目绑定文件夹的路径规范化：realpath 只能在有真 fs 的主进程做（渲染进程 fs 是空 shim）
ipcMain.handle('file:realpath', async (event, filePath: string) => {
  try {
    const real = await fs.promises.realpath(filePath, { strict: true } as any)
    return { success: true, path: real }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    return { success: false, error: errorMessage }
  }
})

ipcMain.handle('file:open', async (event, filePath: string) => {
  try {
    await shell.openPath(pathNormalize(filePath))
    return { success: true }
  } catch (error: unknown) {
    console.error('Failed to open file:', error)
    const errorMessage = error instanceof Error ? error.message : String(error)
    return { success: false, error: errorMessage }
  }
})

// 文件树 watch 集合制：单个 watcher，watch 范围 = 渲染层当前关心的路径集合
//（根 + 已展开目录，各 depth 0）；file:watch-set 按新旧集合 diff 增量 add/unwatch。
// 事件转发取最后一次调用的 sender（watcher 与窗口均只有一个，沿用现状语义）。
let fileWatcher: chokidar.FSWatcher | null = null
let fileWatchedPaths = new Set<string>()
let fileWatchSender: Electron.WebContents | null = null

const ensureFileWatcher = (): chokidar.FSWatcher => {
  if (fileWatcher) return fileWatcher

  fileWatcher = createSafeChokidar([], {
    persistent: true,
    ignoreInitial: true,
    depth: 0,
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100
    }
  })

  fileWatcher.on('all', (eventName, filePath) => {
    if (!fileWatchSender) return
    const win = BrowserWindow.fromWebContents(fileWatchSender)
    if (win && !win.isDestroyed()) {
      win.webContents.send('file:changed', { eventName, filePath })
    }
  })

  return fileWatcher
}

ipcMain.handle('file:watch-set', async (event, paths: string[]) => {
  try {
    const watcher = ensureFileWatcher()
    fileWatchSender = event.sender

    const next = new Set(paths)
    for (const p of next) {
      if (!fileWatchedPaths.has(p)) {
        watcher.add(p)
      }
    }
    for (const p of fileWatchedPaths) {
      if (!next.has(p)) {
        watcher.unwatch(p)
      }
    }
    fileWatchedPaths = next

    return { success: true }
  } catch (error: unknown) {
    console.error('Failed to set file watcher paths:', error)
    const errorMessage = error instanceof Error ? error.message : String(error)
    return { success: false, error: errorMessage }
  }
})

ipcMain.handle('file:watch-stop', async () => {
  try {
    if (fileWatcher) {
      await fileWatcher.close()
      fileWatcher = null
    }
    fileWatchedPaths = new Set()
    fileWatchSender = null
    return { success: true }
  } catch (error: unknown) {
    console.error('Failed to stop file watcher:', error)
    const errorMessage = error instanceof Error ? error.message : String(error)
    return { success: false, error: errorMessage }
  }
})
