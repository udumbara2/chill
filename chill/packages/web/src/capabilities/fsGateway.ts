/**
 * 能力网关：文件系统（M1.5 四件套之三）
 *
 * M1 白名单 = ~/.chill 子树（配置/模型目录/资产——启动与设置页所需）。
 * 会话工作目录白名单随 M3 写链启用（写边界门在浏览器引擎，fs 通道只认白名单）。
 * 返回形状逐字段对齐 hostApi.ts 合同（= electron-main 既有 handler 的线缆形状）。
 *
 * 已知债（规划七.1）：file:read 的流式编码探测（20MB 窗口 + jschardet）仍在
 * electron-main 的胖 handler 里——M3 文件写链落地时按 rule of three 下沉 core，
 * 届时本类与 electron-main 共用同一实现；M1 只读场景走朴素实现（配置文件皆小文本）。
 */
import { promises as fsp } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

const MAX_READ_BYTES = 20 * 1024 * 1024

type Ok = { success: true } & Record<string, unknown>
type Err = { success: false; error: string }

export class FsGateway {
  /** 白名单根（M1：userData 子树；M3 起并入会话工作目录） */
  private roots: string[]
  /** userData 自留地根（只读降级时仍保持可写） */
  private readonly userRoot: string
  /** 只读降级：extraRoots（启动目录）只读、写族全拒（对齐 Codex 高风险目录降级先例） */
  private readOnlyExtra: boolean

  constructor(userDataPath: string, extraRoots: string[] = [], opts?: { readOnlyExtraRoots?: boolean }) {
    this.userRoot = resolve(userDataPath)
    this.roots = [this.userRoot, ...extraRoots.map((r) => resolve(r))]
    this.readOnlyExtra = opts?.readOnlyExtraRoots ?? false
  }

  /** 只读闸运行时读写（Web UI 权限选择器联动：会话级、不落盘、重启复位） */
  getReadOnlyExtra(): boolean {
    return this.readOnlyExtra
  }

  setReadOnlyExtra(v: boolean): void {
    this.readOnlyExtra = v
  }

  /** 白名单判定：目标路径必须落在某根之下（含根本身；防 .. 与 symlink 出圈的规范化前置） */
  isAllowed(target: string): boolean {
    const abs = resolve(target)
    return this.roots.some(root => abs === root || abs.startsWith(root + sep))
  }

  private guard(target: string): Err | null {
    if (!this.isAllowed(target)) {
      return { success: false, error: `路径在宿主白名单之外（M1 限 ~/.chill 子树）：${target}` }
    }
    return null
  }

  /** 写族闸：只读降级时仅 userData 自留地可写，其余根写族全拒并给出提升路径 */
  private guardWrite(target: string): Err | null {
    if (this.readOnlyExtra) {
      const abs = resolve(target)
      const inUserRoot = abs === this.userRoot || abs.startsWith(this.userRoot + sep)
      if (!inUserRoot) {
        return { success: false, error: `只读模式（家目录启动默认降级；--allow-home 重启提升为可写）：${target}` }
      }
    }
    return this.guard(target)
  }

  async listDirectory(dirPath: string, options?: { includeHidden?: boolean }): Promise<Ok | Err> {
    const g = this.guard(dirPath)
    if (g) return g
    try {
      const entries = await fsp.readdir(dirPath, { withFileTypes: true })
      const files = entries
        .filter(e => options?.includeHidden ? true : !e.name.startsWith('.'))
        .map(e => ({
          id: join(dirPath, e.name),
          name: e.name,
          path: join(dirPath, e.name),
          type: e.isDirectory() ? 'directory' as const : 'file' as const,
          parentId: dirPath,
        }))
      return { success: true, files }
    } catch (err) {
      return { success: false, error: this.msg(err, '读取目录失败') }
    }
  }

  async readFile(filePath: string, options?: { limit?: number; offset?: number }): Promise<Ok | Err> {
    const g = this.guard(filePath)
    if (g) return g
    try {
      const stat = await fsp.stat(filePath)
      if (stat.size > MAX_READ_BYTES) {
        return { success: false, error: `文件过大（${Math.round(stat.size / 1024 / 1024)}MB > 20MB 上限）` }
      }
      const content = await fsp.readFile(filePath, 'utf-8')
      const lines = content.split('\n')
      const offset = options?.offset ?? 0
      const limit = options?.limit && options.limit > 0 ? options.limit : lines.length
      const selected = lines.slice(offset, offset + limit)
      return {
        success: true,
        content: selected.join('\n'),
        startLine: offset + 1,
        endLine: offset + selected.length,
        totalLines: lines.length,
        encoding: 'utf-8',
      }
    } catch (err) {
      return { success: false, error: this.msg(err, '读取文件失败') }
    }
  }

  async readFileBase64(filePath: string): Promise<Ok | Err> {
    const g = this.guard(filePath)
    if (g) return g
    try {
      const buf = await fsp.readFile(filePath)
      return { success: true, base64: buf.toString('base64') }
    } catch (err) {
      return { success: false, error: this.msg(err, '读取文件失败') }
    }
  }

  /** M3.4 写族：写前不留快照（备份在渲染层引擎的 BackupStore 经 fsProvider 落 ~/.chill/backups，
   *  与桌面同层——daemon 只是朴素写端）。编码：utf-8（content 字符串）/ base64 显式。 */
  async writeFile(filePath: string, content: string, encoding?: string): Promise<Ok | Err> {
    const g = this.guardWrite(filePath)
    if (g) return g
    try {
      await fsp.mkdir(dirname(filePath), { recursive: true })
      const buf = encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf-8')
      await fsp.writeFile(filePath, buf)
      return { success: true }
    } catch (err) {
      return { success: false, error: this.msg(err, '写入文件失败') }
    }
  }

  /** 删除走系统回收站（README 承诺；Windows 经 PowerShell VisualBasic SendToRecycleBin） */
  async deleteFile(filePath: string): Promise<Ok | Err> {
    const g = this.guardWrite(filePath)
    if (g) return g
    try {
      const { execFile } = await import('node:child_process')
      const norm = filePath.replace(/\//g, '\\')
      await new Promise<void>((resolve, reject) => {
        execFile('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-STA', '-Command',
          `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${norm.replace(/'/g, "''")}', 'OnlyErrorDialogs', 'SendToRecycleBin')`,
        ], { windowsHide: true, timeout: 60_000 }, (err2) => { if (err2) reject(err2); else resolve() })
      })
      return { success: true }
    } catch (err) {
      return { success: false, error: this.msg(err, '删除失败') }
    }
  }

  async renameFile(oldPath: string, newPath: string): Promise<Ok | Err> {
    const g1 = this.guardWrite(oldPath) ?? this.guardWrite(newPath)
    if (g1) return g1
    try {
      await fsp.mkdir(dirname(newPath), { recursive: true })
      await fsp.rename(oldPath, newPath)
      return { success: true }
    } catch (err) {
      return { success: false, error: this.msg(err, '重命名失败') }
    }
  }

  async createFile(filePath: string, content?: string): Promise<Ok | Err> {
    return this.writeFile(filePath, content ?? '')
  }

  async mkdir(dirPath: string): Promise<Ok | Err> {
    const g = this.guardWrite(dirPath)
    if (g) return g
    try {
      await fsp.mkdir(dirPath, { recursive: true })
      return { success: true }
    } catch (err) {
      return { success: false, error: this.msg(err, '创建目录失败') }
    }
  }

  /** M1 只读里程碑的占位已由上面真实现取代 */

  async exists(filePath: string): Promise<Ok | Err> {
    const g = this.guard(filePath)
    if (g) return g
    try {
      await fsp.access(filePath)
      return { success: true, exists: true }
    } catch {
      return { success: true, exists: false }
    }
  }

  async getPathType(filePath: string): Promise<Ok | Err> {
    const g = this.guard(filePath)
    if (g) return g
    try {
      const stat = await fsp.stat(filePath)
      return { success: true, type: stat.isDirectory() ? 'directory' : 'file' }
    } catch {
      return { success: true, type: 'not_found' }
    }
  }

  async statFile(filePath: string): Promise<Ok | Err> {
    const g = this.guard(filePath)
    if (g) return g
    try {
      const stat = await fsp.stat(filePath)
      return { success: true, mtimeMs: stat.mtimeMs, size: stat.size }
    } catch (err) {
      return { success: false, error: this.msg(err, '获取文件信息失败') }
    }
  }

  async realpath(filePath: string): Promise<Ok | Err> {
    const g = this.guard(filePath)
    if (g) return g
    try {
      return { success: true, path: await fsp.realpath(filePath) }
    } catch (err) {
      return { success: false, error: this.msg(err, '解析路径失败') }
    }
  }

  /** 相对白名单根的显示用路径（诊断辅助） */
  describe(): string {
    return this.roots.map(r => relative(process.cwd(), r) || '.').join(', ')
  }

  private msg(err: unknown, fallback: string): string {
    return err instanceof Error ? err.message : fallback
  }
}
