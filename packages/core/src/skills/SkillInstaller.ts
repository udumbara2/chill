import { join } from 'path'
import { exec } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { IFileSystemProvider } from '../interfaces/IFileSystemProvider'
import type { IPathProvider } from '../interfaces/IPathProvider'
import type { SkillLoader } from './SkillLoader'
import type { SkillRegistry } from './SkillRegistry'
import { readInstallMeta, writeInstallMeta } from './installMeta'
import { parseSkillMd } from './SkillParser'
import { gitClone } from '../utils/gitClone'
import { decompressArchive } from '../utils/decompressArchive'
import { downloadFile } from '../utils/downloadFile'

export interface UninstallResult {
  success: boolean
  error?: string
}

export interface UpdateResult {
  success: boolean
  error?: string
}

export interface ExportResult {
  success: boolean
  error?: string
}

export interface InstallResult {
  success: boolean
  skillName?: string
  error?: string
}

export class SkillInstaller {
  constructor(
    private fsProvider: IFileSystemProvider,
    private pathProvider: IPathProvider,
    private skillLoader: SkillLoader,
    private skillRegistry: SkillRegistry,
  ) {}

  async installSkill(source: string, subPath?: string): Promise<InstallResult> {
    try {
      // 归档后缀
      if (isArchiveFile(source)) {
        const installTmpDir = mkdtempSync(join(tmpdir(), 'skill-install-'))
        try {
          let archivePath = source
          if (/^https?:\/\//i.test(source)) {
            const extMatch = source.match(/\.(zip|tar\.gz|tgz|tar)(\?.*)?$/i)
            const ext = extMatch ? `.${extMatch[1]}` : '.zip'
            const tmpFile = join(installTmpDir, `archive${ext}`)
            await downloadFile(source, tmpFile)
            archivePath = tmpFile
          }
          const skillSourceDir = await decompressArchive(archivePath, installTmpDir)
          return await this.finishInstall(skillSourceDir, { sourceType: 'archive', sourcePath: source })
        } finally {
          try { rmSync(installTmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
        }
      }

      // HTTP URL（非归档后缀、非 .git 结尾）
      if (/^https?:\/\//i.test(source) && !source.endsWith('.git')) {
        const downloadTmpDir = mkdtempSync(join(tmpdir(), 'skill-download-'))
        try {
          const tmpFile = join(downloadTmpDir, 'download')
          await downloadFile(source, tmpFile)
          const skillSourceDir = await decompressArchive(tmpFile, downloadTmpDir)
          return await this.finishInstall(skillSourceDir, { sourceType: 'archive', sourcePath: source })
        } finally {
          try { rmSync(downloadTmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
        }
      }

      // Git URL
      if (isGitUrl(source)) {
        const tmpDir = await gitClone(source, { subPath })
        try {
          const skillSourceDir = subPath ? join(tmpDir, subPath) : tmpDir
          return await this.finishInstall(skillSourceDir, { sourceType: 'git', sourcePath: source, subPath })
        } finally {
          try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
        }
      }

      // 本地目录
      return await this.finishInstall(source, { sourceType: 'local', sourcePath: source })
    } catch (err: any) {
      return { success: false, error: err?.message || `安装失败: ${source}` }
    }
  }

  async uninstallSkill(name: string): Promise<UninstallResult> {
    const skillDir = join(this.pathProvider.getUserDataPath(), 'skills', name)

    const meta = await readInstallMeta(skillDir, this.fsProvider)
    if (!meta) {
      return { success: false, error: `"${name}" 不是外部安装的技能，无法卸载` }
    }

    const deleteResult = await this.fsProvider.deleteFile(skillDir)
    if (!deleteResult.success) {
      return { success: false, error: deleteResult.error || `删除 "${name}" 失败` }
    }

    const result = await this.skillLoader.reload()
    this.skillRegistry.setSkills(result.skills)

    return { success: true }
  }

  async updateSkill(name: string): Promise<UpdateResult> {
    const skillDir = join(this.pathProvider.getUserDataPath(), 'skills', name)

    const meta = await readInstallMeta(skillDir, this.fsProvider)
    if (!meta) {
      return { success: false, error: `"${name}" 不是外部安装的技能，无法更新` }
    }

    try {
      if (meta.sourceType === 'git') {
        const tmpDir = await gitClone(meta.sourcePath, { subPath: meta.subPath })
        try {
          const skillSourceDir = meta.subPath ? join(tmpDir, meta.subPath) : tmpDir
          await this.fsProvider.deleteFile(skillDir)
          await this.copyDirectoryRecursive(skillSourceDir, skillDir)
        } finally {
          try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
        }
      } else if (meta.sourceType === 'archive') {
        const deployTmpDir = mkdtempSync(join(tmpdir(), 'skill-update-'))
        try {
          if (/^https?:\/\//i.test(meta.sourcePath)) {
            const extMatch = meta.sourcePath.match(/\.(zip|tar\.gz|tgz|tar)(\?.*)?$/i)
            const ext = extMatch ? `.${extMatch[1]}` : '.zip'
            const tmpFile = join(deployTmpDir, `archive${ext}`)
            await downloadFile(meta.sourcePath, tmpFile)
            const skillSourceDir = await decompressArchive(tmpFile, deployTmpDir)
            await this.fsProvider.deleteFile(skillDir)
            await this.copyDirectoryRecursive(skillSourceDir, skillDir)
          } else {
            const skillSourceDir = await decompressArchive(meta.sourcePath, deployTmpDir)
            await this.fsProvider.deleteFile(skillDir)
            await this.copyDirectoryRecursive(skillSourceDir, skillDir)
          }
        } finally {
          try { rmSync(deployTmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
        }
      } else {
        await this.fsProvider.deleteFile(skillDir)
        await this.copyDirectoryRecursive(meta.sourcePath, skillDir)
      }

      const result = await this.skillLoader.reload()
      this.skillRegistry.setSkills(result.skills)

      return { success: true }
    } catch (err: any) {
      return { success: false, error: err?.message || `更新 "${name}" 失败` }
    }
  }

  async exportSkill(name: string, outputPath: string): Promise<ExportResult> {
    const skillDir = join(this.pathProvider.getUserDataPath(), 'skills', name)

    const existsResult = await this.fsProvider.fileExists(skillDir)
    if (!existsResult?.success || existsResult?.data !== true) {
      return { success: false, error: `"${name}" 不存在` }
    }

    const tmpDir = mkdtempSync(join(tmpdir(), 'skill-export-'))

    try {
      await this.copyDirectoryRecursive(skillDir, tmpDir)

      // 删除临时目录中的 .install-meta.json
      try { await this.fsProvider.deleteFile(join(tmpDir, '.install-meta.json')) } catch { /* ignore */ }

      const isWindows = process.platform === 'win32'
      const escapedTmpDir = tmpDir.replace(/"/g, '\\"')
      const escapedOutput = outputPath.replace(/"/g, '\\"')

      const cmd = isWindows
        ? `powershell -Command "Compress-Archive -Path '${escapedTmpDir}\\*' -DestinationPath '${escapedOutput}'"`
        : `tar -czf "${escapedOutput}" -C "${escapedTmpDir}" .`

      await new Promise<void>((resolve, reject) => {
        exec(cmd, (error, _stdout, stderr) => {
          if (error) {
            reject(new Error(stderr?.trim() || error.message))
          } else {
            resolve()
          }
        })
      })

      return { success: true }
    } catch (err: any) {
      return { success: false, error: err?.message || `导出 "${name}" 失败` }
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }

  private async copyDirectoryRecursive(sourceDir: string, destDir: string): Promise<void> {
    const listResult = await this.fsProvider.listDirectory(sourceDir)
    if (!listResult?.success || !listResult?.data?.files) {
      return
    }

    for (const entry of listResult.data.files) {
      const srcPath = join(sourceDir, entry.name)
      const destPath = join(destDir, entry.name)

      if (entry.type === 'directory') {
        await this.copyDirectoryRecursive(srcPath, destPath)
      } else {
        const readResult = await this.fsProvider.readFile(srcPath)
        if (readResult?.success && readResult?.data?.content !== undefined) {
          await this.fsProvider.writeFile(destPath, readResult.data.content)
        }
      }
    }
  }

  /** 校验 SKILL.md → 冲突检测 → 复制 → 写 meta → reload */
  private async finishInstall(
    skillSourceDir: string,
    meta: Omit<import('./installTypes').InstallMeta, 'installedAt'>,
  ): Promise<InstallResult> {
    const contentResult = await this.fsProvider.readFile(join(skillSourceDir, 'SKILL.md'))
    if (!contentResult?.success || !contentResult?.data?.content) {
      return { success: false, error: '未找到 SKILL.md' }
    }

    const parseResult = parseSkillMd(contentResult.data.content, join(skillSourceDir, 'SKILL.md'))
    if (!parseResult.success || !parseResult.skill) {
      return { success: false, error: parseResult.error || 'SKILL.md 校验失败' }
    }

    const skillName = parseResult.skill.name
    const destDir = join(this.pathProvider.getUserDataPath(), 'skills', skillName)

    const conflictResult = await this.fsProvider.fileExists(destDir)
    if (conflictResult?.success && conflictResult?.data === true) {
      return { success: false, error: `技能 "${skillName}" 已存在` }
    }

    await this.copyDirectoryRecursive(skillSourceDir, destDir)

    await writeInstallMeta(destDir, {
      ...meta,
      installedAt: new Date().toISOString(),
    }, this.fsProvider)

    const result = await this.skillLoader.reload()
    this.skillRegistry.setSkills(result.skills)

    return { success: true, skillName }
  }
}

function isArchiveFile(str: string): boolean {
  return /\.(zip|tar\.gz|tgz|tar)$/i.test(str)
}

function isGitUrl(str: string): boolean {
  return /^(github:|gitlab:|https?:\/\/|git@)|\.git$/i.test(str)
}
