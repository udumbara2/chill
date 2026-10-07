/**
 * [M3 下沉] Node 侧 IFileSystemProvider 实现（rule of three：CLI/Electron/daemon 三消费者）
 * 自 cli/src/adapters/NodeFileSystemProvider.ts 迁入（CLI 版为超集：含 renameFile/watch，
 * Electron 版缺的两方法为纯增量——两壳原文件改为 re-export 本实现）。
 * 仅经 core 主入口导出（node:fs 不进渲染层产物）。
 */
import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'
import { readLinesBounded } from '../utils/boundedLineReader'
import type { IFileSystemProvider, FileSystemResult, FileReadOptions } from '../interfaces/IFileSystemProvider'

/**
 * 将文件/目录移到回收站（而非永久删除）
 * 通过 Shell.Application COM 对象实现，跨 Windows 版本兼容
 */
function moveToRecycleBin(filePath: string): void {
  const psCommand = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; (New-Object -ComObject Shell.Application).Namespace(0).ParseName('${filePath.replace(/'/g, "''")}').InvokeVerb('delete')`
  const commandBytes = Buffer.from(psCommand, 'utf16le')
  const encodedCommand = commandBytes.toString('base64')
  execSync(`powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodedCommand}`, {
    encoding: 'utf8',
    stdio: 'pipe',
    windowsHide: true,
  })
}

export class NodeFileSystemProvider implements IFileSystemProvider {
  private currentDirectory: string

  constructor(initialDir?: string) {
    this.currentDirectory = initialDir || process.cwd()
  }

  getCurrentDirectory(): string | null {
    return this.currentDirectory
  }

  setCurrentDirectory(dir: string): void {
    this.currentDirectory = dir
  }

  async readFile(filePath: string, options?: FileReadOptions): Promise<FileSystemResult> {
    try {
      // 超大文件（>20MB）走流式行窗口——工作集 O(请求窗口)，与文件总大小无关；
      // 提前停止不统计全文件行数（totalLines 缺省，executor 以文件大小描述兼容）。
      // 有界行读取（2026-10-04 根治）：裸 readline 遇"单行 ≥ V8 字符串上限(~536M 字符)"
      // 的文件会在 data 事件上下文抛 RangeError 杀死宿主进程（serve 实测崩溃+本地复现）；
      // 行长上限内语义不变，超限行截断并如实标注。
      const size = fs.statSync(filePath).size
      if (size > 20 * 1024 * 1024) {
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
          data: {
            content: selected.join('\n'),
            totalLines: undefined,
            startLine: offset + 1,
            endLine: offset + selected.length
          }
        }
      }

      const content = fs.readFileSync(filePath, 'utf-8')
      const lines = content.split('\n')

      const totalLines = lines.length
      const offset = options?.offset ?? 0
      let limit = options?.limit

      if (limit === undefined || limit === 0) {
        limit = totalLines - offset
      }

      const startLine = offset
      const endLine = Math.min(offset + limit, totalLines)

      const selectedLines = lines.slice(startLine, endLine)
      const selectedContent = selectedLines.join('\n')

      return {
        success: true,
        data: {
          content: selectedContent,
          totalLines,
          startLine: startLine + 1,
          endLine,
        }
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : '读取文件失败'
      }
    }
  }

  async writeFile(filePath: string, content: string): Promise<FileSystemResult> {
    try {
      const dir = path.dirname(filePath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      fs.writeFileSync(filePath, content, 'utf-8')
      return {
        success: true,
        data: { path: filePath }
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : '写入文件失败'
      }
    }
  }

  /**
   * 独占创建（core IFileSystemProvider.createFileExclusive 契约实现，M6）：
   * 'wx' 标志=O_CREAT|O_EXCL——路径已存在时抛 EEXIST，跨进程原子抢占唯一胜者。
   * data=true=创建成功；data=false=已存在；其余失败走 success=false（消费方 fail-closed 跳过本轮）。
   */
  async createFileExclusive(filePath: string, content: string): Promise<FileSystemResult<boolean>> {
    try {
      const dir = path.dirname(filePath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      const fd = fs.openSync(filePath, 'wx')
      try {
        fs.writeFileSync(fd, content, 'utf-8')
      } finally {
        fs.closeSync(fd)
      }
      return { success: true, data: true }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (code === 'EEXIST') return { success: true, data: false }
      return { success: false, error: error instanceof Error ? error.message : '独占创建失败' }
    }
  }

  /**
   * 重命名/移动（core IFileSystemProvider.renameFile 契约实现）：
   * 原子写 tmp+rename 的 rename 一环（定时任务清单 TaskStore 等使用），形状与既有方法一致
   */
  async renameFile(from: string, to: string): Promise<FileSystemResult> {
    try {
      const dir = path.dirname(to)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      fs.renameSync(from, to)
      return {
        success: true,
        data: { path: to }
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : '重命名文件失败'
      }
    }
  }

  async deleteFile(filePath: string): Promise<FileSystemResult> {
    try {
      const stat = fs.statSync(filePath)
      const type = stat.isDirectory() ? 'directory' as const : 'file' as const
      moveToRecycleBin(filePath)
      return {
        success: true,
        data: { path: filePath, type }
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : '删除文件失败'
      }
    }
  }

  async listDirectory(dirPath: string, _options?: Record<string, any>): Promise<FileSystemResult> {
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true })
      const files = entries.map(entry => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' as const : 'file' as const
      }))

      return {
        success: true,
        data: {
          success: true,
          files,
          path: dirPath
        }
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : '读取目录失败'
      }
    }
  }

  async fileExists(filePath: string): Promise<FileSystemResult<boolean>> {
    try {
      // 契约:data 一律为 boolean(见 IFileSystemProvider)
      return {
        success: true,
        data: fs.existsSync(filePath)
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : '检查文件存在性失败'
      }
    }
  }

  async getPathType(filePath: string): Promise<FileSystemResult> {
    try {
      if (!fs.existsSync(filePath)) {
        return {
          success: true,
          data: { type: 'not_found' as const }
        }
      }
      const stat = fs.statSync(filePath)
      return {
        success: true,
        data: { type: stat.isDirectory() ? 'directory' as const : 'file' as const }
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : '获取路径类型失败'
      }
    }
  }

  /** 二进制读取（base64）：知识库 PDF 摄入等场景使用 */
  async readFileBase64(filePath: string): Promise<FileSystemResult<{ base64: string }>> {
    try {
      return { success: true, data: { base64: fs.readFileSync(filePath).toString('base64') } }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : '读取文件失败'
      }
    }
  }

  /** 文件元信息（core IFileSystemProvider.statFile 契约：快照时效对账用） */
  async statFile(filePath: string): Promise<FileSystemResult<{ mtimeMs: number; size: number }>> {
    try {
      const stat = fs.statSync(filePath)
      return { success: true, data: { mtimeMs: stat.mtimeMs, size: stat.size } }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : '获取文件信息失败'
      }
    }
  }

  watch(pathToWatch: string, callback: (event: string, filename: string) => void): () => void {
    // fs.watch回调的filename实际为string|null，此处做适配
    const watcher = fs.watch(pathToWatch, { recursive: true } as any, (event, filename) => {
      callback(event, (filename ?? '') as string)
    })
    // 目录 watch 失败（如目录被删）不抛出：监视错误是常态数据，严禁上抛杀进程
    // （对齐 core persistence 既有范式 SessionPersistence/ProjectPersistence）
    watcher.on('error', (err) => console.warn('【文件监视】目录 watch 错误（已忽略）:', err))
    return () => watcher.close()
  }
}

