import { exec } from 'node:child_process'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export interface GitCloneOptions {
  /** Git 仓库中的子目录路径 */
  subPath?: string
}

/**
 * 将简写 URL 转换为标准 Git 克隆地址
 * 支持: github:user/repo → https://github.com/user/repo.git
 */
function normalizeGitUrl(url: string): string {
  if (url.startsWith('github:')) {
    const repo = url.slice('github:'.length)
    return `https://github.com/${repo}.git`
  }
  if (url.startsWith('gitlab:')) {
    const repo = url.slice('gitlab:'.length)
    return `https://gitlab.com/${repo}.git`
  }
  return url
}

/**
 * 执行 git clone 到临时目录
 * @param url - Git 仓库地址（支持 github:user/repo 简写）
 * @param options - 可选参数，支持 subPath 指定子目录
 * @returns 克隆的根临时目录路径
 */
export async function gitClone(url: string, options?: GitCloneOptions): Promise<string> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'skill-install-'))

  try {
    await new Promise<void>((resolve, reject) => {
      const gitUrl = normalizeGitUrl(url)
      exec(`git clone --depth 1 "${gitUrl}" "${tmpDir}"`, (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(`git clone 失败: ${stderr?.trim() || error.message}`))
          return
        }

        const skillRoot = options?.subPath ? join(tmpDir, options.subPath) : tmpDir
        const skillMd = join(skillRoot, 'SKILL.md')
        if (!existsSync(skillMd)) {
          reject(new Error(options?.subPath
            ? `仓库子目录 "${options.subPath}" 中未找到 SKILL.md`
            : '仓库中未找到 SKILL.md'))
          return
        }

        resolve()
      })
    })
    return tmpDir
  } catch (err) {
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
    throw err
  }
}
