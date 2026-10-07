/**
 * 对话框与附件网关（M3.6）
 *
 * Electron dialog 不可用——daemon 侧原生选择器用 PowerShell + Windows Forms
 * （FolderBrowserDialog / OpenFileDialog；-STA 单元是 Forms 硬要求）。
 * 附件：saveAttachment 落盘 userData/attachments/ 回填路径（Web 无 File.path 的替代）。
 */
import { spawn } from 'node:child_process'
import { promises as fsp, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** 运行 PowerShell 脚本取单行结果（ trimmed stdout；失败返回 null） */
function psOneLine(script: string, timeoutMs = 120_000): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script], { windowsHide: true })
    let out = ''
    let settled = false
    const done = (v: string | null): void => { if (!settled) { settled = true; clearTimeout(timer); resolve(v) } }
    const timer = setTimeout(() => { try { child.kill() } catch { /* */ } done(null) }, timeoutMs)
    child.stdout?.on('data', (c: Buffer) => { out += c.toString('utf8') })
    child.stderr?.on('data', () => { /* Forms 初始化噪声忽略 */ })
    child.on('exit', (code) => done(code === 0 ? out.trim() : null))
    child.on('error', () => done(null))
  })
}

function psEscape(s: string): string {
  return s.replace(/'/g, "''")
}

export class DialogsGateway {
  private attachmentsDir: string

  constructor(userDataPath: string) {
    this.attachmentsDir = join(userDataPath, 'attachments')
  }

  /** 目录选择器（PowerShell FolderBrowserDialog；取消/失败返回 canceled 形状） */
  async pickFolder(title: string): Promise<unknown> {
    const script = [
      `Add-Type -AssemblyName System.Windows.Forms | Out-Null`,
      `$d = New-Object System.Windows.Forms.FolderBrowserDialog`,
      `$d.Description = '${psEscape(title)}'`,
      `if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath } else { Write-Output '' }`,
    ].join('; ')
    const path = await psOneLine(script)
    if (path === null) return { success: false, error: '目录选择器不可用' }
    if (!path) return { success: true, result: { canceled: true, filePaths: [] } }
    return { success: true, result: { canceled: false, filePaths: [path] } }
  }

  /** 文件选择器（多选；filterTitle/filterExt 简化为常用扩展集） */
  async pickFiles(title: string, multi: boolean, extensions?: string[]): Promise<unknown> {
    const filter = extensions?.length
      ? `@(${extensions.map((e) => `"*.${psEscape(e)}"|*.${psEscape(e)}`).join(',').replace(/"[^"]*\|/g, '"')})`
      : '$null'
    void filter // OpenFileDialog.Filter 复杂度不值得——全文件类型，浏览器侧已按类型分派
    const script = [
      `Add-Type -AssemblyName System.Windows.Forms | Out-Null`,
      `$d = New-Object System.Windows.Forms.OpenFileDialog`,
      `$d.Title = '${psEscape(title)}'`,
      `$d.Multiselect = $${multi}`,
      `if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output ($d.FileNames -join [char]10) } else { Write-Output '' }`,
    ].join('; ')
    const out = await psOneLine(script)
    if (out === null) return { success: false, error: '文件选择器不可用' }
    if (!out) return { success: true, result: { canceled: true, filePaths: [] } }
    const files = out.split('\n').map((s) => s.trim()).filter(Boolean)
    return { success: true, result: { canceled: false, filePaths: files } }
  }

  /** Electron showOpenDialog 兼容入口（按 properties 分派到上面两个原语） */
  async showOpenDialog(options: { title?: string; properties?: string[]; filters?: Array<{ extensions?: string[] }> }): Promise<unknown> {
    const props = options.properties ?? []
    const exts = options.filters?.[0]?.extensions
    if (props.includes('openDirectory')) return this.pickFolder(options.title ?? '选择目录')
    return this.pickFiles(options.title ?? '选择文件', props.includes('multiSelections'), exts)
  }

  /** showSaveDialog：Web 端文件保存由引擎写工具落盘，此入口返回错误如实降级 */
  async showSaveDialog(): Promise<unknown> {
    return { success: false, error: 'Web 端保存对话框暂以写工具落盘替代（路径由对话指定）' }
  }

  // ---------- 附件（File.path 缺失的替代通道） ----------
  async saveAttachment(buffer: ArrayBuffer, fileName: string): Promise<unknown> {
    try {
      if (!existsSync(this.attachmentsDir)) mkdirSync(this.attachmentsDir, { recursive: true })
      const safe = fileName.replace(/[\\/:*?"<>|]/g, '_')
      const fileId = `${Date.now()}-${randomUUID().slice(0, 8)}-${safe}`
      const filePath = join(this.attachmentsDir, fileId)
      await fsp.writeFile(filePath, Buffer.from(buffer))
      return { success: true, fileId, filePath }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : '附件保存失败' }
    }
  }

  async deleteAttachment(fileId: string): Promise<unknown> {
    try {
      await fsp.unlink(join(this.attachmentsDir, fileId))
      return { success: true }
    } catch {
      return { success: true } // 幂等：不存在即成功
    }
  }

  async readAttachmentAsBase64(fileId: string): Promise<unknown> {
    try {
      const buf = await fsp.readFile(join(this.attachmentsDir, fileId))
      return { success: true, base64: buf.toString('base64') }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : '附件读取失败' }
    }
  }
}
