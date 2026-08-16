import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'
import type { IFileSystemProvider, FileSystemResult, FileReadOptions } from '@assistant-ai/core'

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
      // 提前停止不统计全文件行数（totalLines 缺省，executor 以文件大小描述兼容）
      const size = fs.statSync(filePath).size
      if (size > 20 * 1024 * 1024) {
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

  watch(pathToWatch: string, callback: (event: string, filename: string) => void): () => void {
    // fs.watch回调的filename实际为string|null，此处做适配
    const watcher = fs.watch(pathToWatch, { recursive: true } as any, (event, filename) => {
      callback(event, (filename ?? '') as string)
    })
    return () => watcher.close()
  }
}
