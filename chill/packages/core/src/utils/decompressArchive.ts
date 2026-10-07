import { exec, spawn } from 'node:child_process'
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs'
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

  if (lower.endsWith('.zip')) {
    const cmd = isWindows
      ? `powershell -Command "Expand-Archive -Path '${escapedArchive}' -DestinationPath '${escapedDest}' -Force"`
      : `unzip -o "${escapedArchive}" -d "${escapedDest}"`
    await execDecoded(cmd)
  } else if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz') || lower.endsWith('.tar')) {
    // spawn 参数数组 + 归档走 stdin 管（不经 shell）：三重雷区全规避——
    // ① cmd.exe 引号插值会把 Windows 路径搅坏（实测 e2e 抓获）；
    // ② GNU tar 把 -f 的盘符路径（C:\）误判为远程主机（stdin 管无 -f 路径）；
    // ③ GNU tar 对 -C 参数做反斜杠转义（win32 下正斜杠化；bsdtar 同样接受，探针双测通过）
    const flag = lower.endsWith('.tar') ? '-xf' : '-xzf'
    const dest = isWindows ? destDir.replace(/\\/g, '/') : destDir
    await new Promise<void>((resolve, reject) => {
      const child = spawn('tar', [flag, '-', '-C', dest], { stdio: ['pipe', 'ignore', 'pipe'] })
      const stderrChunks: Buffer[] = []
      child.stderr.on('data', (d: Buffer) => { stderrChunks.push(d) })
      child.on('error', (err) => reject(new Error(`解压失败: ${err.message}`)))
      child.on('close', (code) => {
        if (code === 0) { resolve(); return }
        void (async () => {
          const label = await getAnsiCodePageLabel()
          const stderrText = stderrChunks.length > 0 ? decodeOutput(Buffer.concat(stderrChunks), label).trim() : ''
          reject(new Error(`解压失败: ${stderrText || `tar 退出码 ${code}`}`))
        })()
      })
      createReadStream(archivePath).pipe(child.stdin)
    })
  } else {
    throw new Error(`不支持的压缩包格式: ${archivePath}`)
  }

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

/** exec 执行命令串，stderr 按系统代码页解码（中文系统本地化错误信息是 GBK） */
async function execDecoded(cmd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    exec(cmd, { encoding: 'buffer' }, async (error, _stdout, stderr) => {
      if (error) {
        const label = await getAnsiCodePageLabel()
        const stderrText = stderr ? decodeOutput(Buffer.from(stderr), label).trim() : ''
        reject(new Error(`解压失败: ${stderrText || error.message}`))
      } else {
        resolve()
      }
    })
  })
}
