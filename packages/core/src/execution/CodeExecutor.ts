import { join } from 'path'
import * as os from 'os'
import * as fs from 'fs'
import { spawn, type ChildProcess } from 'child_process'
import type { SupportedLanguage } from './types'
import type { ExecutionOptions, ExecutionResult } from './types'
import type { ICodeExecutor, InteractiveCallbacks, InteractiveResult, ProcessOperationResult } from './ICodeExecutor'
import { executePowerShell as executePowerShellFn, decodeOutput, getAnsiCodePageLabel, StreamOutputDecoder, type PowerShellOptions, type PowerShellResult } from './PowerShellExecutor'

const fileExtensions: Record<SupportedLanguage, string> = {
  javascript: 'js',
  python: 'py',
  typescript: 'ts',
  shell: 'sh',
  powershell: 'ps1'
}

const commands: Record<SupportedLanguage, { cmd: string; args: string[] }> = {
  javascript: { cmd: 'node', args: [] },
  python: { cmd: 'py', args: [] },
  typescript: { cmd: 'npx', args: ['tsx'] },
  shell: { cmd: 'bash', args: ['-c'] },
  powershell: { cmd: 'powershell', args: ['-ExecutionPolicy', 'Bypass', '-File'] }
}

interface ProcessInfo {
  process: ChildProcess
  language: SupportedLanguage
  callbacks: InteractiveCallbacks
  workspacePath?: string
}

export class CodeExecutor implements ICodeExecutor {
  private tempWorkspaceCounter = 0
  private activeProcesses = new Map<string, ProcessInfo>()
  // python 解释器候选链探测缓存：undefined=未探测、string=可用命令、null=全部候选不可用
  private pythonCmdCache: string | null | undefined

  private generateProcessId(): string {
    return `proc_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
  }

  private async createTempWorkspace(): Promise<string> {
    const baseDir = join(os.tmpdir(), 'code-executor-sandbox')
    const workspaceId = `workspace-${Date.now()}-${++this.tempWorkspaceCounter}-${Math.random().toString(36).substring(2, 9)}`
    const workspacePath = join(baseDir, workspaceId)

    await fs.promises.mkdir(workspacePath, { recursive: true })
    console.log(`[createTempWorkspace] 创建临时工作目录: ${workspacePath}`)

    return workspacePath
  }

  private async cleanupTempWorkspace(workspacePath: string): Promise<void> {
    try {
      await fs.promises.rm(workspacePath, { recursive: true, force: true })
      console.log(`[cleanupTempWorkspace] 清理临时工作目录: ${workspacePath}`)
    } catch (error: any) {
      console.error(`[cleanupTempWorkspace] 清理临时工作目录失败: ${workspacePath}`, error.message)
    }
  }

  private getSafeEnv(tempDir: string): NodeJS.ProcessEnv {
    const allowedEnvVars = ['PATH', 'NODE_ENV', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'COMSPEC']
    const safeEnv: NodeJS.ProcessEnv = {}

    for (const key of allowedEnvVars) {
      if (process.env[key]) {
        safeEnv[key] = process.env[key]
      }
    }

    safeEnv.TEMP = tempDir
    safeEnv.TMP = tempDir
    safeEnv.PYTHONIOENCODING = 'utf-8'


    return safeEnv
  }

  /** spawn 解释器进程并收集输出（close 时共享双轨解码），沙箱/本地两模式共用的执行核心 */
  private runInterpreterProcess(
    cmd: string,
    args: string[],
    spawnOptions: { cwd?: string; env: NodeJS.ProcessEnv; timeout: number; shell: boolean },
    startTime: number
  ): Promise<ExecutionResult> {
    return new Promise<ExecutionResult>((resolve) => {
      // 收集原始字节，close 时经共享双轨解码器解码（严禁逐块 toString 裸解码）
      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      // ACP 检测与子进程并发
      const codePagePromise = getAnsiCodePageLabel()

      const child = spawn(cmd, args, spawnOptions)

      if (child.stdout) {
        child.stdout.on('data', (data: Buffer) => {
          stdoutChunks.push(data)
        })
      }

      if (child.stderr) {
        child.stderr.on('data', (data: Buffer) => {
          stderrChunks.push(data)
        })
      }

      child.on('close', async (code) => {
        const duration = Date.now() - startTime
        const fallbackLabel = await codePagePromise
        const stdout = decodeOutput(Buffer.concat(stdoutChunks), fallbackLabel)
        const stderr = decodeOutput(Buffer.concat(stderrChunks), fallbackLabel)

        if (code === 0) {
          resolve({
            success: true,
            output: stdout.trim(),
            logs: stdout ? [stdout.trim()] : undefined,
            duration
          })
        } else {
          resolve({
            success: false,
            error: stderr.trim() || `进程退出码: ${code}`,
            logs: stderr ? [stderr.trim()] : undefined,
            duration
          })
        }
      })

      child.on('error', (error) => {
        const duration = Date.now() - startTime
        resolve({
          success: false,
          error: error.message,
          duration
        })
      })
    })
  }

  /**
   * 解析本地模式解释器命令。
   * node 跨平台统一直接返回；python 走候选链探测（跨平台 + 覆盖无 py launcher 的安装形态）：
   * Windows 优先 py（官方安装器默认装 launcher，且可绕开 Store stub 假别名），
   * 再退 python、python3；POSIX 平台优先 python3（标准名，macOS 现代版无 python 命令）。
   * 探测以 `--version` 退出码 0 为准（Store stub / 损坏安装退出非 0 被正确跳过），结果缓存实例级。
   */
  private async resolveInterpreterCmd(language: SupportedLanguage): Promise<string | null> {
    if (language !== 'python') {
      return commands[language].cmd
    }
    if (this.pythonCmdCache !== undefined) {
      return this.pythonCmdCache
    }
    const candidates = process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python']
    for (const cmd of candidates) {
      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(cmd, ['--version'], { shell: false, windowsHide: true })
          child.on('error', reject)
          child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))))
        })
        this.pythonCmdCache = cmd
        return cmd
      } catch {
        /* 该候选不可用，试下一个 */
      }
    }
    this.pythonCmdCache = null
    return null
  }

  /**
   * 本地模式（execute_code 工具暴露）：代码写临时文件到指定工作目录执行。
   * 与沙箱模式的差异：文件在用户工作目录（require 相对路径按该目录解析——验证脚本最常见的依赖形态）、
   * 完整继承 process.env（本地执行需要用户环境）、全程 shell:false（直调解释器，代码不经任何
   * shell 解析器——根治 PowerShell 双引号解析器劫持反引号/${} 的问题）。
   * 清理只 unlink 本轮创建的单个临时文件——绝不 cleanupTempWorkspace（会误删用户工作目录）。
   */
  private async executeChildProcessLocal(
    language: SupportedLanguage,
    code: string,
    options: ExecutionOptions & { cwd: string }
  ): Promise<ExecutionResult> {
    if (language !== 'javascript' && language !== 'python') {
      return { success: false, error: `本地模式仅支持 javascript/python（收到 ${language}），其他语言请经 PowerShell 执行` }
    }

    const startTime = Date.now()
    const ext = fileExtensions[language]
    // 时间戳+随机后缀防并发冲突；chill_exec_ 前缀便于识别与排查
    const scriptPath = join(options.cwd, `chill_exec_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${ext}`)
    await fs.promises.writeFile(scriptPath, code, 'utf-8')
    try {
      const cmd = await this.resolveInterpreterCmd(language)
      if (!cmd) {
        const tried = process.platform === 'win32' ? 'py/python/python3' : 'python3/python'
        return { success: false, error: `未找到可用的 Python 解释器（已尝试 ${tried}）。请安装 Python 并确认其在 PATH 中，或改用 javascript。` }
      }
      const cmdConfig = { cmd, args: commands[language].args }
      return await this.runInterpreterProcess(cmd, [...cmdConfig.args, scriptPath], {
        cwd: options.cwd,
        env: process.env,
        timeout: options.timeout || 60000,
        shell: false
      }, startTime)
    } finally {
      // 进程被强杀等极端情况下 finally 不保证执行，可能残留 chill_exec_* 临时文件（随机名不冲突、不累积影响）
      try { await fs.promises.unlink(scriptPath) } catch { /* 清理失败不掩盖执行结果 */ }
    }
  }

  async executeChildProcess(
    language: SupportedLanguage,
    code: string,
    options?: ExecutionOptions
  ): Promise<ExecutionResult> {
    // 本地模式（execute_code 工具）：在指定工作目录写临时文件执行
    if (options?.cwd) {
      return this.executeChildProcessLocal(language, code, { ...options, cwd: options.cwd })
    }

    const startTime = Date.now()
    const timeout = options?.timeout || 10000
    let workspacePath: string | undefined

    try {
      workspacePath = await this.createTempWorkspace()
      const safeEnv = this.getSafeEnv(workspacePath)

      const ext = fileExtensions[language]
      const scriptPath = join(workspacePath, `script.${ext}`)
      await fs.promises.writeFile(scriptPath, code, 'utf-8')

      const cmdConfig = commands[language]
      const args = language === 'shell'
        ? [...cmdConfig.args, code]
        : [...cmdConfig.args, scriptPath]

      // shell 模式整段代码作为参数、其余语言传脚本文件路径（沙箱语义不变）
      return await this.runInterpreterProcess(cmdConfig.cmd, args, {
        cwd: workspacePath,
        env: safeEnv,
        timeout,
        shell: language === 'typescript' || language === 'python'
      }, startTime)
    } catch (error: any) {
      const duration = Date.now() - startTime
      return {
        success: false,
        error: error.message || '代码执行失败',
        duration
      }
    } finally {
      if (workspacePath) {
        await this.cleanupTempWorkspace(workspacePath)
      }
    }
  }

  async executeInteractive(
    language: SupportedLanguage,
    code: string,
    callbacks: InteractiveCallbacks
  ): Promise<InteractiveResult> {
    let workspacePath: string | undefined

    try {
      workspacePath = await this.createTempWorkspace()
      const safeEnv = this.getSafeEnv(workspacePath)

      const ext = fileExtensions[language]
      const scriptPath = join(workspacePath, `script.${ext}`)
      await fs.promises.writeFile(scriptPath, code, 'utf-8')

      const cmdConfig = commands[language]
      const args = language === 'shell'
        ? [...cmdConfig.args, code]
        : [...cmdConfig.args, scriptPath]

      const child = spawn(cmdConfig.cmd, args, {
        cwd: workspacePath,
        env: safeEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: language === 'typescript' || language === 'python'
      })

      const processId = this.generateProcessId()
      this.activeProcesses.set(processId, {
        process: child,
        language,
        callbacks,
        workspacePath
      })

      // 流式双轨解码器：跨块多字节字符由 {stream:true} 处理；ACP 标签异步就绪后迟到绑定
      const stdoutDecoder = new StreamOutputDecoder(null)
      const stderrDecoder = new StreamOutputDecoder(null)
      getAnsiCodePageLabel().then((label) => {
        stdoutDecoder.setFallbackLabel(label)
        stderrDecoder.setFallbackLabel(label)
      })

      if (child.stdout) {
        child.stdout.on('data', (data: Buffer) => {
          const info = this.activeProcesses.get(processId)
          if (info) {
            info.callbacks.onOutput(processId, stdoutDecoder.push(data), 'stdout')
          }
        })
      }

      if (child.stderr) {
        child.stderr.on('data', (data: Buffer) => {
          const info = this.activeProcesses.get(processId)
          if (info) {
            info.callbacks.onOutput(processId, stderrDecoder.push(data), 'stderr')
          }
        })
      }

      child.on('close', (code) => {
        const info = this.activeProcesses.get(processId)
        if (info) {
          const tailStdout = stdoutDecoder.flush()
          if (tailStdout) info.callbacks.onOutput(processId, tailStdout, 'stdout')
          const tailStderr = stderrDecoder.flush()
          if (tailStderr) info.callbacks.onOutput(processId, tailStderr, 'stderr')
          info.callbacks.onExit(processId, code ?? -1, 'exit')
        }
        this.activeProcesses.delete(processId)
      })

      child.on('error', (error) => {
        const info = this.activeProcesses.get(processId)
        if (info) {
          info.callbacks.onExit(processId, -1, 'error', error.message)
        }
        this.activeProcesses.delete(processId)
      })

      return { success: true, processId }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  }

  async sendInput(processId: string, input: string): Promise<ProcessOperationResult> {
    const info = this.activeProcesses.get(processId)
    if (!info) {
      return { success: false, error: '进程不存在或已退出' }
    }

    try {
      if (info.process.stdin && info.process.stdin.writable) {
        info.process.stdin.write(input)
        return { success: true }
      } else {
        return { success: false, error: '进程输入流不可用' }
      }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  }

  async terminateProcess(processId: string): Promise<ProcessOperationResult> {
    const info = this.activeProcesses.get(processId)
    if (!info) {
      return { success: false, error: '进程不存在或已退出' }
    }

    try {
      info.process.kill()
      this.activeProcesses.delete(processId)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  }

  async executePowerShell(command: string, options?: PowerShellOptions): Promise<PowerShellResult> {
    return executePowerShellFn(command, options)
  }
}
