import { exec } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { decodeOutput, getAnsiCodePageLabel } from '../execution/PowerShellExecutor'

/**
 * 解压压缩包到目标目录。
 * 支持 .zip / .tar.gz / .tgz / .tar。
 * 解压后自动检测穿透：若顶层只有一个子目录且无 SKILL.md，进入该子目录。
 * @param archivePath 压缩包路径
 * @param destDir 目标目录（需已存在）
 * @returns 解压后 SKILL.md 所在的有效根目录
 */
export async function decompressArchive(archivePath: string, destDir: string): Promise<string> {
  const isWindows = process.platform === 'win32'
  const lower = archivePath.toLowerCase()

  const escapedArchive = archivePath.replace(/"/g, '\\"')
  const escapedDest = destDir.replace(/"/g, '\\"')

  let cmd: string
  if (lower.endsWith('.zip')) {
    cmd = isWindows
      ? `powershell -Command "Expand-Archive -Path '${escapedArchive}' -DestinationPath '${escapedDest}' -Force"`
      : `unzip -o "${escapedArchive}" -d "${escapedDest}"`
  } else if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    // 经 stdin 输入（-f -）而非 -f <路径>：GNU tar 会把 Windows 盘符路径（C:\...）误判为远程主机
    cmd = `tar -xzf - -C "${escapedDest}" < "${escapedArchive}"`
  } else if (lower.endsWith('.tar')) {
    cmd = `tar -xf - -C "${escapedDest}" < "${escapedArchive}"`
  } else {
    throw new Error(`不支持的压缩包格式: ${archivePath}`)
  }

  await new Promise<void>((resolve, reject) => {
    exec(cmd, { encoding: 'buffer' }, async (error, _stdout, stderr) => {
      if (error) {
        // stderr 为原始字节（中文系统上本地化错误信息是 GBK），经共享双轨解码器解码
        const label = await getAnsiCodePageLabel()
        const stderrText = stderr ? decodeOutput(Buffer.from(stderr), label).trim() : ''
        reject(new Error(`解压失败: ${stderrText || error.message}`))
      } else {
        resolve()
      }
    })
  })

  // 自动穿透：若顶层只有一个子目录且无 SKILL.md
  const entries = readdirSync(destDir)
  if (entries.length === 1) {
    const singleEntry = join(destDir, entries[0])
    if (statSync(singleEntry).isDirectory() && !existsSync(join(destDir, 'SKILL.md'))) {
      return singleEntry
    }
  }

  return destDir
}
