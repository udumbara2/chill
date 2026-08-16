import { execSync } from 'child_process'
if (process.platform === 'win32') {
  try { execSync('chcp 65001 >nul 2>&1', { stdio: 'ignore' }) } catch {}
}

// 全局设置 Python 子进程 UTF-8 编码，防止 emoji/中文等在 GBK 系统代码页下崩溃或乱码
process.env.PYTHONIOENCODING = 'utf-8'

import { webcrypto } from 'crypto'
if (!globalThis.crypto) {
  (globalThis as any).crypto = webcrypto
}

import { app, BrowserWindow, Menu, ipcMain, dialog, protocol as electronProtocol, shell } from 'electron'
import { join, resolve as pathResolve, extname, dirname } from 'path'
import * as fs from 'fs'
import { readdir, writeFile, unlink } from 'fs/promises'
import * as os from 'os'
import express from 'express'
import cors from 'cors'
import type { Server } from 'http'
import chokidar from 'chokidar'
import * as iconv from 'iconv-lite'
import * as jschardet from 'jschardet'

// 导入MCP相关模块

import type { MCPServerConfig } from '@assistant-ai/core'
import { MCPService, SubagentExecutor, AESGCMCrypto, FileKeyValueStore, MCPConnectionManager, modelInfoService, providerManager, runProviderKeyMigration, ModelType, RemoteAgentRegistrar, SessionPersistence, ProjectPersistence, getOwnProjectPaths, BuiltInToolExecutor, eventBus, EVENTS, saveCurrentGoal, archiveCurrentGoal, clearCurrentGoal } from '@assistant-ai/core'
import type { IConfirmationHandler, IPositionCalculator, ICodeExecutor, BuiltInToolResult } from '@assistant-ai/core'
import type { SessionRecord, SaveMode, ProjectRecord } from '@assistant-ai/core'
import type { IMCPClient } from '@assistant-ai/core'
import type { ISecureStorage } from '@assistant-ai/core'
import { SecureStorageService } from '@assistant-ai/core'

// 导入IPC通道常量（T7：自 core/workflow 移入本包，electron 是唯一消费者）
import { IPC_CHANNELS } from './ipcChannels'

// 导入 core 中的执行模块
import { executePowerShell } from '@assistant-ai/core'
import { CodeExecutor } from '@assistant-ai/core'
import type { SupportedLanguage } from '@assistant-ai/core'
import type { OutputCallback, ExitCallback } from '@assistant-ai/core'
import { DraftPersistence } from '@assistant-ai/core'
import { WorkflowPersistence } from '@assistant-ai/core'
import { AgentFileManager } from '@assistant-ai/core'
import { setExecutor as setCodeServiceExecutor } from '@assistant-ai/core'

// 导入A2A工作流执行器
import {
  clearAllAbortControllers,
  setA2ASecureStorage,
  type A2ATaskParams,
  type TaskExecutionState,
  type TaskStatusUpdateEvent
} from '@assistant-ai/core'
import { LocalA2AExecutor } from './main/LocalA2AExecutor'
import { DesktopMainController } from './DesktopMainController'
import { runHookProcess, hooksWatchPaths } from './main/HookProcessRunner'
import type { SavedAgent, RemoteAgentConfig, SubagentTemplate } from '@assistant-ai/core'

// 导入工作流执行器
import {
  compileWorkflow,
  executeWorkflow,
  streamWorkflow,
  type WorkflowState,
  type WorkflowNodeConfig,
  type DefaultEdgeConfig,
  type AnyCompiledGraph,
  createCheckpointer,
  getWorkflowState,
  updateWorkflowState,
  createWorkflowState,
  clearWorkflowState,
  type WorkflowExecutionState
} from '@assistant-ai/core'
import { Command } from '@langchain/langgraph'
import { LocalAgentTemplateGenerator } from '@assistant-ai/core'
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

// ========== A2A HTTP服务器相关 ==========
let a2aServer: Server | null = null
const A2A_PORT = process.env.A2A_PORT ? parseInt(process.env.A2A_PORT, 10) : 3000
const A2A_HOST = '127.0.0.1'

// 设置Node.js进程的默认编码为UTF-8
process.env.LANG = 'zh_CN.UTF-8'
process.env.LC_ALL = 'zh_CN.UTF-8'
if (process.platform === 'win32') {
  // Windows平台特殊处理
  process.env.CHcp = 'utf8'
}

const isDev = process.env.NODE_ENV === 'development'
const builtinTemplatesDir = isDev
  ? pathResolve(process.cwd(), 'packages/core/src/orchestrator/templates/builtin')
  : pathResolve(process.resourcesPath, 'templates/builtin')

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

  // 当窗口准备好显示时再显示
  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
    console.log(isDev ? '✓ 开发环境已加载 (localhost:5173)' : '✓ 生产环境已加载 (dist/index.html)')
  })

  // 加载应用
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    const distPath = join(__dirname, '../../dist')
    const staticServer = express()
    staticServer.use(express.static(distPath))
    staticServer.get('/*splat', (_req, res) => {
      res.sendFile(join(distPath, 'index.html'))
    })
    const staticPort = 5174
    const staticHttpServer = staticServer.listen(staticPort, '127.0.0.1', () => {
      mainWindow.loadURL(`http://127.0.0.1:${staticPort}`)
    })
    app.on('before-quit', () => {
      staticHttpServer.close()
    })
  }

  // 移除默认菜单栏，显示干净的应用界面
  Menu.setApplicationMenu(null)
}

// 当Electron完成初始化并准备创建浏览器窗口时调用此方法
app.whenReady().then(async () => {
  try {
    AttachmentManager.initialize(new ElectronPathProvider())
  } catch (err) {
    console.warn('[AttachmentManager] 初始化失败，继续启动应用:', err)
  }

  // 硬性顺序：provider Map 先就位（含种子合并与旧格式兼容）；
  // key 文件命名迁移先于 loadAllModels——否则其内部 migrateKeys 会把更旧的 ModelType key
  // 抢在显示名 key 前面迁到同一 id（显示名 key 是较新约定，必须赢）
  await providerManager.loadProviders()
  await runProviderKeyMigration(mainSecureStorage)
  await modelInfoService.loadAllModels()

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
  const workerScriptPath = join(__dirname, '../../core/dist/orchestrator/isolation/workers/GenericSubagentWorker.js')
  if (fs.existsSync(workerScriptPath)) {
    setWorkerScriptPath(workerScriptPath)
  }

  createWindow()

  // 启动A2A HTTP服务器
  startA2AServer()
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

// 在应用退出前关闭A2A HTTP服务器并清理AbortController
// 步骤10：添加应用退出时的清理逻辑，调用 destroyAllEnvironments
app.on('before-quit', async () => {
  // 2.22.7 清理所有AbortController
  clearAllAbortControllers()
  stopA2AServer()

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

class MainProcessSecureStorage implements ISecureStorage {
  async storeApiKey(provider: string, apiKey: string): Promise<boolean> {
    try {
      const encrypted = AESGCMCrypto.encrypt(masterKey, apiKey)
      fs.writeFileSync(join(secureStoragePath, `${provider}.key`), encrypted)
      return true
    } catch (error) {
      console.error('Failed to store API key:', error)
      return false
    }
  }
  async getApiKey(provider: string): Promise<string | null> {
    try {
      const filePath = join(secureStoragePath, `${provider}.key`)
      if (!fs.existsSync(filePath)) return null
      return AESGCMCrypto.decrypt(masterKey, fs.readFileSync(filePath))
    } catch (error) {
      console.error(`Failed to get API key for ${provider}:`, error)
      return null
    }
  }
  async hasApiKey(provider: string): Promise<boolean> {
    return fs.existsSync(join(secureStoragePath, `${provider}.key`))
  }
  async deleteApiKey(provider: string): Promise<boolean> {
    try {
      const filePath = join(secureStoragePath, `${provider}.key`)
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
      return true
    } catch (error) {
      console.error(`Failed to delete API key for ${provider}:`, error)
      return false
    }
  }
  async getAllProviders(): Promise<string[]> {
    try {
      if (!fs.existsSync(secureStoragePath)) return []
      return fs.readdirSync(secureStoragePath)
        .filter(f => f.endsWith('.key'))
        .map(f => f.replace('.key', ''))
    } catch {
      return []
    }
  }

  /** 列出 keys 目录下全部 .key 文件名（供 providerKeyMigration 使用） */
  listKeyFiles(): string[] {
    try {
      if (!fs.existsSync(secureStoragePath)) return []
      return fs.readdirSync(secureStoragePath).filter(f => f.endsWith('.key'))
    } catch {
      return []
    }
  }

  /** 重命名 key 文件（目标已存在或源不存在时返回 false，不覆盖） */
  renameKey(oldName: string, newName: string): boolean {
    try {
      const oldPath = join(secureStoragePath, `${oldName}.key`)
      const newPath = join(secureStoragePath, `${newName}.key`)
      if (!fs.existsSync(oldPath) || fs.existsSync(newPath)) return false
      fs.writeFileSync(newPath, fs.readFileSync(oldPath))
      fs.unlinkSync(oldPath)
      return true
    } catch (error) {
      console.error(`Failed to rename API key (${oldName} -> ${newName}):`, error)
      return false
    }
  }
}

ipcMain.handle('store-api-key', (event, provider, apiKey) => {
  try {
    // 统一经 resolveId 落到稳定 id 命名空间
    const encrypted = AESGCMCrypto.encrypt(masterKey, apiKey)
    fs.writeFileSync(join(secureStoragePath, `${providerManager.resolveId(provider)}.key`), encrypted)
    return { success: true }
  } catch (error: unknown) {
    console.error('Failed to store API key:', error)
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

ipcMain.handle('get-api-key', (event, provider) => {
  try {
    const filePath = join(secureStoragePath, `${providerManager.resolveId(provider)}.key`)
    if (!fs.existsSync(filePath)) return null
    return AESGCMCrypto.decrypt(masterKey, fs.readFileSync(filePath))
  } catch (error: unknown) {
    console.error('Failed to get API key:', error)
    return null
  }
})

ipcMain.handle('delete-api-key', (event, provider) => {
  try {
    const filePath = join(secureStoragePath, `${providerManager.resolveId(provider)}.key`)
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    return true
  } catch (error: unknown) {
    console.error('Failed to delete API key:', error)
    return false
  }
})

ipcMain.handle('get-all-providers', () => {
  try {
    return fs.readdirSync(secureStoragePath)
      .filter(file => file.endsWith('.key'))
      .map(file => file.replace('.key', ''))
  } catch (error: unknown) {
    console.error('Failed to get all providers:', error)
    return []
  }
})

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

// hooks.json 热更新 watch（仿模板 watcher 的组织方式）：用户级 + workDir 向上各级 .agents/hooks.json，
// 变化经 hooks:changed 推渲染进程触发 loader 重载；workDir 变化（hooks:set-workdir）时重挂。
// chokidar 可 watch 尚不存在的文件（新建 .agents/hooks.json 同样触发），无需预先判存
let hooksWatcher: ReturnType<typeof chokidar.watch> | null = null
let hooksNotifyTimer: NodeJS.Timeout | null = null
const rewatchHooks = (workDir?: string | null): void => {
  const paths = hooksWatchPaths(workDir, join(os.homedir(), '.chill', 'hooks.json'))
  if (hooksWatcher) {
    void hooksWatcher.close()
    hooksWatcher = null
  }
  hooksWatcher = chokidar.watch(paths, { ignoreInitial: true })
  hooksWatcher.on('all', () => {
    // 防抖：500ms 内的连续变更合并为一次推送（编辑器保存常产生多个事件）
    if (hooksNotifyTimer) clearTimeout(hooksNotifyTimer)
    hooksNotifyTimer = setTimeout(() => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('hooks:changed', { paths })
    }, 500)
  })
}

// hooks:set-workdir —— 渲染进程 workDir 变化时重挂 watch（初始装配以 undefined 调用亦可）
ipcMain.handle('hooks:set-workdir', (_event, dir?: string | null) => {
  try {
    rewatchHooks(dir ?? undefined)
    return { success: true }
  } catch (error: any) {
    return { success: false, error: error?.message ?? String(error) }
  }
})
rewatchHooks(undefined)

// ========== 附件管理相关IPC处理程序 ==========

// 保存附件
ipcMain.handle('attachment:save', async (event, buffer: ArrayBuffer, fileName: string) => {
  try {
    const nodeBuffer = Buffer.from(buffer)
    const fileId = await AttachmentManager.saveAttachment(nodeBuffer, fileName)
    return { success: true, fileId }
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

// ========== 工作流持久化相关 IPC ==========

ipcMain.handle(IPC_CHANNELS.WORKFLOW_SAVE, async (_event, workflow) => {
  return workflowPersistence.saveWorkflow(workflow)
})

ipcMain.handle(IPC_CHANNELS.WORKFLOW_LOAD, async (_event, id) => {
  return workflowPersistence.loadWorkflow(id)
})

ipcMain.handle(IPC_CHANNELS.WORKFLOW_LIST, async () => {
  return workflowPersistence.listWorkflows()
})

ipcMain.handle(IPC_CHANNELS.WORKFLOW_DELETE, async (_event, id) => {
  return workflowPersistence.deleteWorkflow(id)
})

// ========== A2A HTTP服务器启动函数 ==========
function startA2AServer(): void {
  const expressApp = express()

  // 启用CORS
  expressApp.use(cors())

  // 解析JSON请求体
  expressApp.use(express.json())

  // 基础健康检查端点
  expressApp.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() })
  })

  // GET /.well-known/agent.json 端点 - A2A Agent Card
  expressApp.get('/.well-known/agent.json', async (_req, res) => {
    try {
      const agentCards: any[] = []

      const listResult = await agentFileManager.listAgents()
      if (listResult.success && listResult.agents) {
        for (const summary of listResult.agents) {
          try {
            const loadResult = await agentFileManager.loadAgent(summary.id)
            if (!loadResult.success || !loadResult.agent) continue
            const agent = loadResult.agent as Record<string, unknown>
            const metadata = agent.metadata as Record<string, unknown> | undefined
            const card = metadata?.agentCard as Record<string, unknown> | undefined

            if (card) {
              agentCards.push({
                name: card.name,
                description: card.description || '',
                version: card.version || '1.0.0',
                protocolVersion: 'v0.3.0',
                url: `http://${A2A_HOST}:${A2A_PORT}`,
                capabilities: card.capabilities || {
                  streaming: false,
                  pushNotifications: false,
                  stateTransitionHistory: false
                },
                defaultInputModes: ['text'],
                defaultOutputModes: ['text'],
                skills: ((card.skills as any[]) || []).map((skill: any) => ({
                  id: skill.id,
                  name: skill.name,
                  description: skill.description || ''
                }))
              })
            }
          } catch (error) {
            console.error(`Failed to load agent ${summary.id}:`, error)
          }
        }
      }

      res.json({
        agents: agentCards,
        timestamp: new Date().toISOString()
      })
    } catch (error) {
      console.error('Failed to get agent cards:', error)
      res.status(500).json({
        error: 'Failed to get agent cards',
        timestamp: new Date().toISOString()
      })
    }
  })

  // POST /tasks/send 端点 - A2A任务发送（JSON-RPC）
  expressApp.post('/tasks/send', async (req, res) => {
    try {
      const { jsonrpc, id, method, params } = req.body

      // 验证JSON-RPC格式
      if (jsonrpc !== '2.0' || method !== 'tasks/send') {
        return res.status(400).json({
          jsonrpc: '2.0',
          id: id || null,
          error: {
            code: -32600,
            message: 'Invalid Request'
          }
        })
      }

      // 验证params参数
      const taskParams = params as A2ATaskParams
      if (!taskParams.id || !taskParams.message) {
        return res.status(400).json({
          jsonrpc: '2.0',
          id: id || null,
          error: {
            code: -32602,
            message: 'Invalid params: id and message are required'
          }
        })
      }

      // 从请求头或params中获取agentId
      const agentId = req.headers['x-agent-id'] as string || taskParams.sessionId
      if (!agentId) {
        return res.status(400).json({
          jsonrpc: '2.0',
          id: id || null,
          error: {
            code: -32602,
            message: 'Invalid params: agentId is required (provide via x-agent-id header or sessionId)'
          }
        })
      }

      // 加载AGENT配置
      const loadResult = await agentFileManager.loadAgent(agentId)
      if (!loadResult.success || !loadResult.agent) {
        return res.status(404).json({
          jsonrpc: '2.0',
          id: id || null,
          error: {
            code: -32000,
            message: `Agent not found: ${agentId}`
          }
        })
      }

      const agent = loadResult.agent as unknown as SavedAgent

      // 调用A2A任务执行器
      const result = await localA2AExecutor.executeTask(
        agent as unknown as Record<string, unknown>,
        taskParams as unknown as Record<string, unknown>
      )

      // 返回JSON-RPC响应
      res.json({
        jsonrpc: '2.0',
        id: id,
        result: result
      })
    } catch (error) {
      console.error('Failed to process tasks/send:', error)
      res.status(500).json({
        jsonrpc: '2.0',
        id: req.body?.id || null,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : 'Internal error'
        }
      })
    }
  })

  // POST /tasks/get 端点 - 查询任务状态（JSON-RPC）
  expressApp.post('/tasks/get', async (req, res) => {
    try {
      const { jsonrpc, id, method, params } = req.body

      // 验证JSON-RPC格式
      if (jsonrpc !== '2.0' || method !== 'tasks/get') {
        return res.status(400).json({
          jsonrpc: '2.0',
          id: id || null,
          error: {
            code: -32600,
            message: 'Invalid Request'
          }
        })
      }

      // 验证params参数
      if (!params || !params.id) {
        return res.status(400).json({
          jsonrpc: '2.0',
          id: id || null,
          error: {
            code: -32602,
            message: 'Invalid params: id is required'
          }
        })
      }

      const taskId = params.id as string
      const historyLength = params.historyLength as number | undefined

      // 查询任务状态
      const taskState = localA2AExecutor.getTaskState(taskId)

      if (!taskState) {
        return res.status(404).json({
          jsonrpc: '2.0',
          id: id || null,
          error: {
            code: -32000,
            message: `Task not found: ${taskId}`
          }
        })
      }

      // 构建响应
      let result: Record<string, unknown>

      if (taskState.state === 'completed' && taskState.result) {
        // 任务已完成，返回完整结果
        result = { ...(taskState.result as Record<string, unknown>) }

        // 处理historyLength参数
        if (historyLength !== undefined && result.history && Array.isArray(result.history)) {
          const history = result.history as Array<unknown>
          if (historyLength > 0) {
            result.history = history.slice(-historyLength)
          } else if (historyLength === 0) {
            delete result.history
          }
        }
      } else if (taskState.state === 'failed') {
        // 任务失败，返回错误信息
        result = {
          id: taskState.taskId,
          sessionId: taskState.sessionId,
          status: {
            state: taskState.state,
            message: {
              role: 'agent',
              parts: [
                {
                  type: 'text',
                  text: taskState.error || 'Task execution failed'
                }
              ]
            }
          }
        }
      } else {
        // 任务进行中或已提交，返回当前状态
        result = {
          id: taskState.taskId,
          sessionId: taskState.sessionId,
          status: {
            state: taskState.state
          }
        }
      }

      // 返回JSON-RPC响应
      res.json({
        jsonrpc: '2.0',
        id: id,
        result: result
      })
    } catch (error) {
      console.error('Failed to process tasks/get:', error)
      res.status(500).json({
        jsonrpc: '2.0',
        id: req.body?.id || null,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : 'Internal error'
        }
      })
    }
  })

  // POST /tasks/sendSubscribe 端点 - A2A任务发送并订阅SSE更新（JSON-RPC）
  expressApp.post('/tasks/sendSubscribe', async (req, res) => {
    try {
      const { jsonrpc, id, method, params } = req.body

      // 验证JSON-RPC格式
      if (jsonrpc !== '2.0' || method !== 'tasks/sendSubscribe') {
        return res.status(400).json({
          jsonrpc: '2.0',
          id: id || null,
          error: {
            code: -32600,
            message: 'Invalid Request'
          }
        })
      }

      // 验证params参数
      const taskParams = params as A2ATaskParams
      if (!taskParams.id || !taskParams.message) {
        return res.status(400).json({
          jsonrpc: '2.0',
          id: id || null,
          error: {
            code: -32602,
            message: 'Invalid params: id and message are required'
          }
        })
      }

      // 从请求头或params中获取agentId
      const agentId = req.headers['x-agent-id'] as string || taskParams.sessionId
      if (!agentId) {
        return res.status(400).json({
          jsonrpc: '2.0',
          id: id || null,
          error: {
            code: -32602,
            message: 'Invalid params: agentId is required (provide via x-agent-id header or sessionId)'
          }
        })
      }

      // 加载AGENT配置
      const loadResult = await agentFileManager.loadAgent(agentId)
      if (!loadResult.success || !loadResult.agent) {
        return res.status(404).json({
          jsonrpc: '2.0',
          id: id || null,
          error: {
            code: -32000,
            message: `Agent not found: ${agentId}`
          }
        })
      }

      const agent = loadResult.agent as unknown as SavedAgent

      // 设置SSE响应头
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')

      // 发送初始状态事件
      const initialEvent = {
        jsonrpc: '2.0',
        id: id,
        result: {
          id: taskParams.id,
          status: {
            state: 'submitted'
          },
          final: false
        }
      }
      res.write(`data: ${JSON.stringify(initialEvent)}\n\n`)

      // 使用 localA2AExecutor 执行流式任务
      try {
        await localA2AExecutor.executeTaskStream(
          agent as unknown as Record<string, unknown>,
          taskParams as unknown as Record<string, unknown>,
          (event: Record<string, unknown>) => {
            const sseEvent = {
              jsonrpc: '2.0',
              id: id,
              result: {
                id: event.id,
                status: event.status,
                final: event.final
              }
            }
            res.write(`data: ${JSON.stringify(sseEvent)}\n\n`)

            if (event.final) {
              res.end()
            }
          }
        )
      } catch (error) {
        console.error('Stream execution error:', error)
        const errorEvent = {
          jsonrpc: '2.0',
          id: id,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : 'Internal error'
          }
        }
        res.write(`data: ${JSON.stringify(errorEvent)}\n\n`)
        res.end()
      }
    } catch (error) {
      console.error('Failed to process tasks/sendSubscribe:', error)
      // 如果已经开始SSE，通过SSE发送错误
      if (!res.writableEnded) {
        const errorEvent = {
          jsonrpc: '2.0',
          id: req.body?.id || null,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : 'Internal error'
          }
        }
        res.write(`data: ${JSON.stringify(errorEvent)}\n\n`)
        res.end()
      } else {
        res.status(500).json({
          jsonrpc: '2.0',
          id: req.body?.id || null,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : 'Internal error'
          }
        })
      }
    }
  })

  // POST /tasks/cancel 端点 - A2A任务取消（JSON-RPC）
  // 注：2.21 注册端点路由，2.22实现具体逻辑
  expressApp.post('/tasks/cancel', async (req, res) => {
    try {
      const { jsonrpc, id, method, params } = req.body

      // 验证JSON-RPC格式
      if (jsonrpc !== '2.0' || method !== 'tasks/cancel') {
        return res.status(400).json({
          jsonrpc: '2.0',
          id: id || null,
          error: {
            code: -32600,
            message: 'Invalid Request'
          }
        })
      }

      // 验证params参数
      const { id: taskId } = params || {}
      if (!taskId) {
        return res.status(400).json({
          jsonrpc: '2.0',
          id: id || null,
          error: {
            code: -32602,
            message: 'Invalid params: id is required'
          }
        })
      }

      // 2.22.6 调用cancelTask函数实现任务取消
      const result = localA2AExecutor.cancelTask(taskId)

      if (result.success && result.task) {
        // 取消成功，返回完整的Task对象
        return res.json({
          jsonrpc: '2.0',
          id: id,
          result: result.task
        })
      } else {
        // 取消失败，返回错误
        return res.status(400).json({
          jsonrpc: '2.0',
          id: id,
          error: result.error || {
            code: -32000,
            message: 'Task cancellation failed'
          }
        })
      }
    } catch (error) {
      console.error('Failed to process tasks/cancel:', error)
      res.status(500).json({
        jsonrpc: '2.0',
        id: req.body?.id || null,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : 'Internal error'
        }
      })
    }
  })

  // JSON-RPC错误处理中间件 - 统一返回标准错误格式
  // 注：错误格式遵循A2A协议v0.3.0规范 {jsonrpc: "2.0", id: null, error: {code, message, data?}}
  expressApp.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('JSON-RPC Error:', err)

    // 检查是否是JSON-RPC端点的请求（根据Content-Type或请求路径判断）
    const isJsonRpcEndpoint = req.path === '/tasks/send' || req.path === '/tasks/get' || req.path === '/tasks/sendSubscribe' || req.path === '/tasks/cancel'

    if (!isJsonRpcEndpoint) {
      // 非JSON-RPC端点，返回普通错误
      return res.status(500).json({
        error: err.message || 'Internal Server Error'
      })
    }

    // 解析请求体获取id（如果可能）
    let requestId: string | number | null = null
    try {
      if (req.body && req.body.id !== undefined) {
        requestId = req.body.id
      }
    } catch {
      // 忽略解析错误
    }

    // 判断错误类型并返回相应的JSON-RPC错误码
    let errorCode = -32603 // 默认内部错误
    let errorMessage = err.message || 'Internal error'
    let errorData: any = undefined

    // 根据错误消息或类型判断错误码
    if (err.message?.includes('Invalid Request') || err.name === 'SyntaxError') {
      errorCode = -32600 // Invalid Request
      errorMessage = 'Invalid Request'
    } else if (err.message?.includes('Invalid params') || err.message?.includes('required')) {
      errorCode = -32602 // Invalid params
      errorMessage = err.message || 'Invalid params'
    } else if (err.message?.includes('not found') || err.message?.includes('Not found')) {
      errorCode = -32000 // Server error (自定义)
      errorMessage = err.message
    }

    // 如果错误包含额外数据
    if ((err as any).data) {
      errorData = (err as any).data
    }

    // 构建标准JSON-RPC错误响应
    const errorResponse: {
      jsonrpc: string
      id: string | number | null
      error: {
        code: number
        message: string
        data?: any
      }
    } = {
      jsonrpc: '2.0',
      id: requestId,
      error: {
        code: errorCode,
        message: errorMessage
      }
    }

    // 如果有额外数据，添加到错误响应
    if (errorData !== undefined) {
      errorResponse.error.data = errorData
    }

    res.status(500).json(errorResponse)
  })

  // 启动服务器
  a2aServer = expressApp.listen(A2A_PORT, A2A_HOST, () => {
    console.log(`A2A HTTP server started at http://${A2A_HOST}:${A2A_PORT}`)
  })

  // 错误处理
  a2aServer.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${A2A_PORT} is already in use`)
    } else {
      console.error('A2A server error:', error)
    }
  })
}

// ========== A2A HTTP服务器关闭函数 ==========
function stopA2AServer(): void {
  if (a2aServer) {
    a2aServer.close(() => {
      console.log('A2A HTTP server stopped')
    })
    a2aServer = null
  }
}

// ========== AGENT持久化相关 IPC ==========

ipcMain.handle(IPC_CHANNELS.AGENT_SAVE, async (_event, agent) => {
  return agentFileManager.saveAgent(agent)
})

ipcMain.handle(IPC_CHANNELS.AGENT_LOAD, async (_event, id) => {
  return agentFileManager.loadAgent(id)
})

ipcMain.handle(IPC_CHANNELS.AGENT_LIST, async () => {
  return agentFileManager.listAgents()
})

ipcMain.handle(IPC_CHANNELS.AGENT_DELETE, async (_event, id) => {
  return agentFileManager.deleteAgent(id)
})

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

// ========== A2A 执行相关 IPC 通道 ==========

ipcMain.handle(IPC_CHANNELS.A2A_EXECUTE_TASK, async (_event, { agent, params }: { agent: SavedAgent; params: A2ATaskParams }) => {
  try {
    console.log('【A2A IPC】执行同步任务:', params.id)
    const result = await localA2AExecutor.executeTaskSync(
      agent as unknown as Record<string, unknown>,
      params as unknown as Record<string, unknown>
    )
    return { success: true, result }
  } catch (error) {
    console.error('【A2A IPC】执行任务失败:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : '任务执行失败'
    }
  }
})

ipcMain.handle(IPC_CHANNELS.A2A_EXECUTE_TASK_STREAM, async (event, { agent, params }: { agent: SavedAgent; params: A2ATaskParams }) => {
  try {
    console.log('【A2A IPC】执行流式任务:', params.id)

    const result = await localA2AExecutor.executeTaskStream(
      agent as unknown as Record<string, unknown>,
      params as unknown as Record<string, unknown>,
      (statusEvent: Record<string, unknown>) => {
        event.sender.send('a2a:status-update', statusEvent)
      }
    )
    return { success: true, result }
  } catch (error) {
    console.error('【A2A IPC】执行流式任务失败:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : '流式任务执行失败'
    }
  }
})

// ========== 工作流执行相关 IPC 通道 ==========

/**
 * 执行工作流
 * 供渲染进程调用，在主进程中执行工作流
 */
ipcMain.handle(IPC_CHANNELS.WORKFLOW_EXECUTE, async (event, { nodes, edges, input, workflowId }: {
  nodes: WorkflowNodeConfig[]
  edges: DefaultEdgeConfig[]
  input: Partial<WorkflowState>
  workflowId: string
}) => {
  try {
    console.log('【Workflow IPC】执行工作流:', workflowId)

    const threadId = workflowId

    createWorkflowState(workflowId, threadId)

    const { graph } = compileWorkflow(nodes, edges)

    updateWorkflowState(workflowId, {
      state: 'running',
      graph,
      savedConfig: { configurable: { thread_id: threadId } }
    })

    const result = await executeWorkflow(graph, input, threadId)

    updateWorkflowState(workflowId, { state: 'completed' })

    return { success: true, result }
  } catch (error) {
    console.error('【Workflow IPC】执行工作流失败:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : '工作流执行失败'
    }
  }
})

/**
 * 恢复工作流执行
 * 供渲染进程调用，用于恢复被中断的工作流（HITL）
 */
ipcMain.handle(IPC_CHANNELS.WORKFLOW_RESUME, async (event, { resumeData, workflowId }: {
  resumeData: { completed: boolean; output: string; exitCode: number }
  workflowId: string
}) => {
  try {
    console.log('【Workflow IPC】恢复工作流:', workflowId)

    const workflowState = getWorkflowState(workflowId)
    if (!workflowState || !workflowState.graph) {
      return {
        success: false,
        error: '工作流状态不存在或未初始化'
      }
    }

    updateWorkflowState(workflowId, { state: 'running' })

    const result = await workflowState.graph.invoke(
      new Command({ resume: resumeData }),
      workflowState.savedConfig
    )

    updateWorkflowState(workflowId, { state: 'completed' })

    return { success: true, result }
  } catch (error) {
    console.error('【Workflow IPC】恢复工作流失败:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : '工作流恢复失败'
    }
  }
})

// ========== CodeExecutor 实例 ==========

const codeExecutor = new CodeExecutor()
setCodeServiceExecutor(codeExecutor)

// ========== 持久化实例 ==========

const pathProvider = new ElectronPathProvider()
const draftPersistence = new DraftPersistence(pathProvider)
const workflowPersistence = new WorkflowPersistence(pathProvider)
// 会话管理：与 CLI 共用 core 的 SessionPersistence（同落 ~/.chill/sessions/）
const sessionPersistence = new SessionPersistence(pathProvider)
// 项目管理：core ProjectPersistence 单文件存整个项目数组（~/.chill/projects.json）
const projectPersistence = new ProjectPersistence(pathProvider)

// ========== 会话管理 IPC ==========
ipcMain.handle('session:list', async () => sessionPersistence.list())
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
app.on('before-quit', () => sessionPersistence.unwatch())

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
setA2ASecureStorage(mainSecureStorage)
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
providerManager.setFileSystemProvider(nodeFsProvider)
providerManager.setProvidersDir(modelsDir)
const localA2AExecutor = new LocalA2AExecutor()
const agentFileManager = new AgentFileManager(pathProvider)
// 内置技能目录（打包优先 resources，开发回退 monorepo 源码目录；UI 经 skill:builtin-dir 获取）
const builtinSkillsDir = (() => {
  const candidates = [
    join(process.resourcesPath ?? '', 'skills', 'builtin'),
    join(__dirname, '../../core/src/skills/builtin'),
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

// ========== 启动扫描注入 local/remote Agent 模板（步骤 11b） ==========
try {
  const localDir = join(userDataPath, 'agents', 'local')
  const remoteDir = join(userDataPath, 'agents', 'remote')
  const allTemplates: SubagentTemplate[] = []

  // 1. 扫描 agents/local/*.json → LocalAgentTemplateGenerator.generateTemplateObject()
  try {
    const localGenerator = new LocalAgentTemplateGenerator()
    const localEntries = await readdir(localDir).catch(() => [] as string[])
    for (const file of localEntries) {
      if (!file.endsWith('.json')) continue
      const content = await fs.promises.readFile(join(localDir, file), 'utf-8')
      const agent = JSON.parse(content) as SavedAgent
      const template = localGenerator.generateTemplateObject(agent)
      allTemplates.push(template)
    }
  } catch (err) {
    console.warn('【启动扫描】读取本地 Agent 失败:', err)
  }

  // 2. 扫描 agents/remote/*.json → Coze/A2A generateTemplateObject()
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
const printTemplateErrors = (errs: string[]) =>
  console.warn(`【自定义模板】${errs.length} 个模板加载失败:\n${errs.map((e) => `  - ${e}`).join('\n')}`)
const userTemplates = await templateLoader.loadTemplatesFromDirectory(userTemplatesDir, printTemplateErrors)
templateManager.setCustomTemplates(userTemplates, [])
console.log(`【自定义模板】已加载 ${userTemplates.length} 个用户级模板`)

// 监听用户模板目录变更，500ms 防抖重扫并推送渲染进程（参照 CLI startSkillsWatcher 范式）
let templateReloadTimer: NodeJS.Timeout | null = null
fs.watch(userTemplatesDir, (_event, filename) => {
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

// ========== Agent 变更回调（步骤 12c） ==========
agentFileManager.setOnAgentSaved(async (agent: Record<string, unknown>) => {
  try {
    const metadata = agent.metadata as Record<string, unknown> | undefined
    const id = metadata?.id
    if (!id) return

    const templateGenerator = new LocalAgentTemplateGenerator()
    const template = templateGenerator.generateTemplateObject(agent as any)
    templateManager.registerRemoteTemplate(template)
    pushTemplateUpdate()
  } catch {
    // 模板生成失败不影响 Agent 保存
  }
})

// ========== Agent 删除回调（步骤 12d） ==========
agentFileManager.setOnAgentDeleted((id: string) => {
  templateManager.unregisterRemoteTemplate('local-' + id)
  pushTemplateUpdate()
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
      request.environmentKey
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
// 方法白名单：只放行 IDesktopController 的契约方法，防泛化 invoke 桥被滥用
const DESKTOP_METHODS = new Set(['isAvailable', 'capture', 'input', 'snapshot', 'invokeElement', 'setElementValue', 'focusWindow'])
ipcMain.handle(IPC_CHANNELS.DESKTOP_CALL, async (_event, { method, args }: { method: string; args: unknown[] }) => {
  if (!DESKTOP_METHODS.has(method)) {
    return { success: false, error: `未知的桌面方法: ${method}` }
  }
  return await (desktopMainController as any)[method](...(args ?? []))
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

    // 手动递归读取目录
    const readDirRecursive = async (currentPath: string, parentId: string | null) => {
      const entries = await readdir(currentPath, { withFileTypes: true })
      
      for (const entry of entries) {
        if (!includeHidden && entry.name.startsWith('.')) {
          continue
        }

        const fullPath = join(currentPath, entry.name)
        const itemId = fullPath

        files.push({
          id: itemId,
          name: entry.name,
          path: fullPath,
          type: entry.isDirectory() ? 'directory' : 'file',
          parentId: parentId,
        })

        // 如果是目录，递归读取
        if (entry.isDirectory()) {
          await readDirRecursive(fullPath, itemId)
        }
      }
    }

    await readDirRecursive(dirPath, null)

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
      const readline = await import('readline')
      const rl = readline.createInterface({
        input: fs.createReadStream(filePath, { encoding: 'utf-8' }),
        crlfDelay: Infinity
      })
      const offset = options?.offset ?? 0
      const limit = options?.limit && options?.limit > 0 ? options.limit : Infinity
      const selected: string[] = []
      let lineNo = 0
      try {
        for await (const line of rl) {
          lineNo++
          if (lineNo <= offset) continue
          selected.push(line)
          if (selected.length >= limit) break
        }
      } finally {
        rl.close()
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
    await shell.trashItem(filePath)
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
    await shell.openPath(filePath)
    return { success: true }
  } catch (error: unknown) {
    console.error('Failed to open file:', error)
    const errorMessage = error instanceof Error ? error.message : String(error)
    return { success: false, error: errorMessage }
  }
})

let fileWatcher: chokidar.FSWatcher | null = null

ipcMain.handle('file:watch-start', async (event, dirPath: string) => {
  try {
    if (fileWatcher) {
      await fileWatcher.close()
    }

    fileWatcher = chokidar.watch(dirPath, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100
      }
    })

    fileWatcher.on('all', (eventName, filePath) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (win && !win.isDestroyed()) {
        win.webContents.send('file:changed', { eventName, filePath })
      }
    })

    return { success: true }
  } catch (error: unknown) {
    console.error('Failed to start file watcher:', error)
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
    return { success: true }
  } catch (error: unknown) {
    console.error('Failed to stop file watcher:', error)
    const errorMessage = error instanceof Error ? error.message : String(error)
    return { success: false, error: errorMessage }
  }
})

const workflowsPath = join(pathProvider.getUserDataPath(), 'workflows')

// 导出工作流
ipcMain.handle('workflow:export', async (event, { id, filePath }) => {
  try {
    // 复用 workflow:load 的逻辑读取工作流
    const workflowFilePath = join(workflowsPath, `${id}.json`)
    if (!fs.existsSync(workflowFilePath)) {
      return { success: false, error: 'Workflow not found' }
    }
    const content = fs.readFileSync(workflowFilePath, 'utf-8')
    const workflow = JSON.parse(content)

    // 清理节点数据，移除执行结果等临时数据
    const sanitizedNodes = (workflow.nodes || []).map((node: any) => {
      if (node.data && node.data.executionResult) {
        const { executionResult, ...restData } = node.data
        return {
          ...node,
          data: restData
        }
      }
      return node
    })

    // 构造导出格式
    const exportedWorkflow = {
      version: '1.0.0',
      metadata: {
        name: workflow.metadata?.name || '',
        exportedAt: Date.now(),
        appVersion: app.getVersion()
      },
      workflow: {
        nodes: sanitizedNodes,
        edges: workflow.edges || []
      }
    }

    // 写入用户选择的文件路径
    fs.writeFileSync(filePath, JSON.stringify(exportedWorkflow, null, 2), 'utf-8')
    return { success: true }
  } catch (error: unknown) {
    console.error('Failed to export workflow:', error)
    const errorMessage = error instanceof Error ? error.message : String(error)
    return { success: false, error: errorMessage }
  }
})

// 导入工作流
ipcMain.handle('workflow:import', async (event, { filePath }) => {
  try {
    // 读取文件
    const content = fs.readFileSync(filePath, 'utf-8')
    const data = JSON.parse(content)

    // 验证格式
    if (!data.version) {
      return { success: false, error: '缺少版本号' }
    }
    if (!data.workflow?.nodes) {
      return { success: false, error: '缺少节点数据' }
    }
    if (!data.workflow?.edges) {
      return { success: false, error: '缺少边数据' }
    }

    // 获取原始名称
    let originalName = data.metadata?.name || '导入的工作流'
    let newName = originalName

    // 检查是否同名，如果同名则自动重命名
    const existingFiles = fs.readdirSync(workflowsPath)
    const existingNames = existingFiles
      .filter(file => file.endsWith('.json'))
      .map(file => {
        try {
          const fileContent = fs.readFileSync(join(workflowsPath, file), 'utf-8')
          const workflow = JSON.parse(fileContent)
          return workflow.metadata?.name
        } catch {
          return null
        }
      })
      .filter(Boolean)

    // 如果同名，添加序号
    let counter = 1
    while (existingNames.includes(newName)) {
      newName = `${originalName} (${counter})`
      counter++
    }

    // 生成新ID
    const newId = Date.now().toString()

    // 构造新的工作流对象
    const newWorkflow = {
      metadata: {
        id: newId,
        name: newName,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        version: 1
      },
      nodes: data.workflow.nodes,
      edges: data.workflow.edges
    }

    // 保存工作流（复用 workflow:save 的逻辑）
    const workflowFilePath = join(workflowsPath, `${newId}.json`)
    fs.writeFileSync(workflowFilePath, JSON.stringify(newWorkflow, null, 2), 'utf-8')

    // 返回成功结果
    return {
      success: true,
      workflow: {
        id: newId,
        name: newName,
        updatedAt: newWorkflow.metadata.updatedAt
      }
    }
  } catch (error: unknown) {
    console.error('Failed to import workflow:', error)
    const errorMessage = error instanceof Error ? error.message : String(error)
    return { success: false, error: errorMessage }
  }
})