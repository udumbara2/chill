import { exec } from 'child_process'
import { promisify, TextDecoder } from 'util'
import * as fs from 'fs'
import * as os from 'os'
import { isDangerousCommand } from './commandSafety'

const execAsync = promisify(exec)

// ==================== 共享双轨解码器（子进程输出字节→文本的唯一解码器） ====================
//
// 字节来源矩阵（同一根管道里编码异质，整段单一编码解码必然顾此失彼）：
//   - PowerShell cmdlet 输出：由本文件包装前缀强制为 UTF-8
//   - 原生 exe（robocopy/xcopy/cmd 内部命令等）：系统 ANSI 代码页（GetACP，chcp 改不动）
//   - Python（PYTHONIOENCODING=utf-8）/ Node / git 等现代工具：UTF-8
// 解码策略：整段 strict UTF-8 快速通道 → 失败则按 0x0A 切分逐行判定，失败行回退到测量出的
// 系统 ACP。按行切分可证安全：0x0A 在 UTF-8（后续字节 0x80–0xBF）与 GBK/Big5/SJIS/EUC-KR
// （尾字节范围均不含 0x0A）的多字节序列内部都不存在，切分永不切断字符。

/** Windows ANSI 代码页 → WHATWG 编码标签映射（65001 无需回退，返回 null） */
const CODEPAGE_TO_LABEL: Record<number, string> = {
  936: 'gbk', 950: 'big5', 932: 'shift_jis', 949: 'euc-kr',
  1250: 'windows-1250', 1251: 'windows-1251', 1252: 'windows-1252', 1253: 'windows-1253',
  1254: 'windows-1254', 1255: 'windows-1255', 1256: 'windows-1256', 1257: 'windows-1257',
  1258: 'windows-1258',
}

let ansiCodePagePromise: Promise<string | null> | null = null

/**
 * 惰性检测系统 ANSI 代码页对应的 TextDecoder 标签，Promise 缓存（每进程最多一次）。
 * 调用方应在发起子进程的同时调用本函数以实现并发（检测自身是独立进程，墙钟开销≈0）。
 * 检测失败/未识别/系统已是 UTF-8 → null（调用方退化为纯 UTF-8 解码，即历史行为）。
 */
export function getAnsiCodePageLabel(): Promise<string | null> {
  if (!ansiCodePagePromise) {
    ansiCodePagePromise = (async () => {
      try {
        const { stdout } = await execAsync(
          'powershell.exe -NoProfile -Command "[System.Text.Encoding]::Default.CodePage"',
          { timeout: 10000, windowsHide: true }
        )
        const cp = parseInt(String(stdout).trim(), 10)
        if (cp === 65001) return null
        return CODEPAGE_TO_LABEL[cp] ?? null
      } catch {
        return null
      }
    })()
  }
  return ansiCodePagePromise
}

const utf8StrictDecoder = new TextDecoder('utf-8', { fatal: true })

/**
 * 双轨解码：整段 strict UTF-8 快速通道；失败则按行判定，非法 UTF-8 的行用回退编码解码。
 * fallbackLabel 为 null 时退化为纯 UTF-8（历史行为）。
 */
export function decodeOutput(buf: Buffer, fallbackLabel: string | null): string {
  if (!fallbackLabel) return buf.toString('utf8')
  try {
    return utf8StrictDecoder.decode(buf)
  } catch {
    // 含非 UTF-8 字节，进入按行回退
  }
  const lines: Buffer[] = []
  let start = 0
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0A) {
      lines.push(buf.subarray(start, i + 1))
      start = i + 1
    }
  }
  if (start < buf.length) lines.push(buf.subarray(start))
  const fallbackDecoder = new TextDecoder(fallbackLabel)
  return lines
    .map((line) => {
      try {
        return utf8StrictDecoder.decode(line)
      } catch {
        return fallbackDecoder.decode(line)
      }
    })
    .join('')
}

/**
 * 流式双轨解码器（executeInteractive 等按块输出场景）。
 * 有状态 UTF-8 流式解码（{stream:true} 处理跨块的多字节字符）；
 * 某块解码失败则切换到回退编码并解码后续全部块。
 * 已知边界：切换瞬间 UTF-8 解码器内部可能滞留的不足一字节的尾部序列会丢失（极端罕见）。
 */
export class StreamOutputDecoder {
  private utf8 = new TextDecoder('utf-8', { fatal: true })
  private fallback: TextDecoder | null = null
  private fallbackLabel: string | null

  constructor(fallbackLabel: string | null) {
    this.fallbackLabel = fallbackLabel
  }

  /** 允许在发生回退切换前迟到绑定标签（ACP 检测是异步的，流式回调无法 await） */
  setFallbackLabel(label: string | null): void {
    if (!this.fallback) this.fallbackLabel = label
  }

  push(chunk: Buffer): string {
    if (this.fallback) return this.fallback.decode(chunk, { stream: true })
    try {
      return this.utf8.decode(chunk, { stream: true })
    } catch {
      this.fallback = new TextDecoder(this.fallbackLabel ?? 'utf-8')
      return this.fallback.decode(chunk, { stream: true })
    }
  }

  flush(): string {
    return (this.fallback ?? this.utf8).decode()
  }
}

/**
 * 检测命令执行失败是否属于"命令未找到"模式
 * 特征：exit code 非0 + stdout和stderr都为空
 */
function isCommandNotFound(error: any, stdout: string, stderr: string): boolean {
  return error.code === 1 && !stdout && !stderr
}

/**
 * 从命令字符串中提取第一个可执行文件名
 * 例如 "python script.py" → "python"
 *      "C:\tools\node.exe index.js" → "node.exe"
 */
function extractCommandName(command: string): string {
  const trimmed = command.trim()
  const firstToken = trimmed.split(/\s+/)[0]
  // 如果第一个token看起来像路径，提取文件名
  if (firstToken.includes('/') || firstToken.includes('\\')) {
    const parts = firstToken.replace(/\\/g, '/').split('/')
    return parts[parts.length - 1]
  }
  return firstToken
}

/**
 * 判断命令是否为删除类命令
 * PowerShell 中 del/rd/rmdir/rm/erase 都是 Remove-Item 的别名
 */
function isDeletionCommand(command: string): boolean {
  const lower = command.trim().toLowerCase()
  return /^(remove-item|del\b|rd\b|rmdir\b|rm\b|erase\b)/i.test(lower)
}

/**
 * PowerShell 函数：劫持 Remove-Item，将文件/目录移入回收站而非永久删除
 * 仅影响文件系统路径，不影响 Remove-Item 对注册表、变量等非文件的操作
 */
const SAFE_RECYCLE_OVERRIDE = `
function global:Remove-Item {
  [CmdletBinding(DefaultParameterSetName='Path', SupportsShouldProcess=$true)]
  param(
    [Parameter(ParameterSetName='Path', Position=0, ValueFromPipeline=$true)]
    [string[]]$Path,
    [Parameter(ParameterSetName='LiteralPath', Mandatory=$true)]
    [string[]]$LiteralPath,
    [switch]$Recurse,
    [switch]$Force
  )
  
  $targets = if ($PSCmdlet.ParameterSetName -eq 'LiteralPath') { $LiteralPath } else { $Path }
  if (-not $targets) { return }
  
  $shell = New-Object -ComObject Shell.Application
  foreach ($t in $targets) {
    $resolved = if ($PSCmdlet.ParameterSetName -eq 'LiteralPath') {
      Resolve-Path -LiteralPath $t -ErrorAction SilentlyContinue
    } else {
      Resolve-Path $t -ErrorAction SilentlyContinue
    }
    if ($resolved) {
      foreach ($r in $resolved) {
        if (Test-Path -LiteralPath $r.Path) {
          $shell.Namespace(0).ParseName($r.Path).InvokeVerb('delete')
        }
      }
    }
  }
}
`

/** 已知的命令别名映射 */
const COMMAND_ALIASES: Record<string, string[]> = {
  'python': ['py', 'python3'],
  'python3': ['python', 'py'],
  'pip': ['pip3', 'py -m pip'],
  'pip3': ['pip', 'py -m pip'],
  'node': ['nodejs'],
  'nodejs': ['node'],
}

/**
 * 为命令未找到的错误构建诊断信息
 */
function buildCommandNotFoundError(commandName: string, command: string, platform: string): string {
  const aliases = COMMAND_ALIASES[commandName] || []
  let msg = `命令执行失败（exit code 1）：${commandName}`
  
  if (platform === 'win32') {
    msg += ` 可能不在当前 PATH 中。`
    if (aliases.length > 0) {
      msg += ` 可尝试：${aliases.join('、')}。`
    }
  }

  msg += `\n完整命令: ${command}`
  
  return msg
}

function extractStdio(error: any, fallbackLabel: string | null): { stdout: string; stderr: string } {
  // buffer 模式下 error.stdout/stderr 为 Buffer；Buffer.from 对两种类型均安全
  return {
    stdout: decodeOutput(Buffer.from(error.stdout || ''), fallbackLabel),
    stderr: decodeOutput(Buffer.from(error.stderr || ''), fallbackLabel)
  }
}

export interface PowerShellOptions {
  timeout?: number
  workingDirectory?: string
}

export interface PowerShellResult {
  success: boolean
  stdout?: string
  stderr?: string
  output?: string
  error?: string
  blocked?: boolean
  timeout?: boolean
}

export async function executePowerShell(command: string, options?: PowerShellOptions): Promise<PowerShellResult> {
  // ACP 检测与命令执行并发：检测是独立进程，命令跑完时标签早已就绪，墙钟开销≈0
  // 提到 try 外声明，使 catch 路径（extractStdio）同样可用
  const codePagePromise = getAnsiCodePageLabel()

  try {
    console.log('【PowerShell】执行命令:', command)

    if (isDangerousCommand(command)) {
      console.error('【PowerShell】检测到危险命令，拒绝执行:', command)
      return {
        success: false,
        error: '检测到危险命令，已阻止执行。如果这是误报，请联系管理员。',
        blocked: true
      }
    }

    const execOptions: any = {
      timeout: options?.timeout || 30000,
      windowsHide: true,
      // 拿原始字节，编码判定交由共享双轨解码器（decodeOutput），不让 Node 预先按 UTF-8 解码
      encoding: 'buffer',
      env: {
        ...process.env,
        // 强制子进程使用 UTF-8，解决 Python/Node 等子进程在 GBK 系统代码页下输出乱码或崩溃的问题
        PYTHONIOENCODING: 'utf-8',
      }
    }

    if (options?.workingDirectory && fs.existsSync(options.workingDirectory)) {
      execOptions.cwd = options.workingDirectory
    }

    // 删除类命令：注入 Remove-Item 劫持函数，将删除改为移入回收站
    const prefix = isDeletionCommand(command) ? SAFE_RECYCLE_OVERRIDE : ''

    const wrappedCommand = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; ${prefix}${command}`
    
    const commandBytes = Buffer.from(wrappedCommand, 'utf16le')
    const encodedCommand = commandBytes.toString('base64')
    
    const { stdout, stderr } = await execAsync(
      `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodedCommand}`,
      execOptions
    )

    console.log('【PowerShell】命令执行完成')

    const fallbackLabel = await codePagePromise
    const stdoutText = decodeOutput(Buffer.from(stdout || ''), fallbackLabel)
    const stderrText = decodeOutput(Buffer.from(stderr || ''), fallbackLabel)

    return {
      success: true,
      stdout: stdoutText,
      stderr: stderrText,
      output: stdoutText
    }
  } catch (error: any) {
    console.error('【PowerShell】命令执行失败:', error)

    if (error.killed && error.signal === 'SIGTERM') {
      return {
        success: false,
        error: '命令执行超时（超过30秒）',
        timeout: true
      }
    }

    const { stdout: capturedStdout, stderr: capturedStderr } = extractStdio(error, await codePagePromise)

    // 检测命令未找到模式，返回诊断信息帮助 AI 自适应
    if (isCommandNotFound(error, capturedStdout, capturedStderr)) {
      const cmdName = extractCommandName(command)
      return {
        success: false,
        error: buildCommandNotFoundError(cmdName, command, os.platform()),
        stdout: capturedStdout,
        stderr: capturedStderr
      }
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : '命令执行失败',
      stderr: capturedStderr,
      stdout: capturedStdout
    }
  }
}
