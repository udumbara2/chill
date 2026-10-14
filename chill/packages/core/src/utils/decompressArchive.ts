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
    if (isWindows) {
      // Windows 优先 bsdtar 文件参数模式解压（System32 自带，tar.gz 分支既有硬依赖，零新增依赖）——
      // Expand-Archive 逐文件 .NET+PS 管道+进度条开销 ~50ms/文件：1401 文件实测 69.9s vs tar 1.6s
      // （2026-10-14 用户 Gitee 手动包"解压非常慢"实测病灶；Gitee 手动兜底交付的正是 .zip）。
      // ⚠ 必须文件参数（-xf <path>），严禁 stdin 管道喂 zip：zip 目录区（central directory）在文件尾，
      // 管道=不可 seek → libarchive 走本地头流式模式会【静默丢条目】（实测丢 zip 序前 25 条、
      // 退出码 0、stderr 空——2026-10-14 复核抓获；tar.gz 无尾部目录区结构，管道流式不受影响）。
      // spawn 参数数组不经 shell，cmd.exe 引号雷区不适用；GNU tar 若被用户排到 PATH 前排（罕见）
      // 会因盘符路径报错（响亮失败）→ 走下方回落。完整性闸把任何静默丢条目变成大声错误（闸失败同样走回落重解）。
      try {
        await runTarFileArg(archivePath, destDir)
        await assertZipEntryCount(archivePath, destDir)
      } catch {
        // 回落 Expand-Archive（无 tar.exe 的老系统 / tar 路径失败）。EAP=Stop 必须保留：Expand-Archive
        // 对非 zip 报的是非终止错误，powershell.exe 仍退出码 0——不加此前缀会把「解压失败+零产出」
        // 洗白成成功（2026-10-13 fetch-source 事故根因环 #3，实测验证）
        await execDecoded(`powershell -Command "$ErrorActionPreference='Stop'; Expand-Archive -Path '${escapedArchive}' -DestinationPath '${escapedDest}' -Force"`)
      }
    } else {
      await execDecoded(`unzip -o "${escapedArchive}" -d "${escapedDest}"`)
    }
  } else if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz') || lower.endsWith('.tar')) {
    await extractViaTarPipe(archivePath, destDir, lower.endsWith('.tar') ? '-xf' : '-xzf')
  } else {
    throw new Error(`不支持的压缩包格式: ${archivePath}`)
  }

  // 空结果即抛：合法归档必产出 ≥1 个条目。空 destDir 若被穿透逻辑当有效根返回，
  // 下游会把「什么都没解出来」洗白成「解压成功」（2026-10-13 fetch-source 事故根因环 #4）
  const entries = readdirSync(destDir)
  if (entries.length === 0) {
    throw new Error('解压结果为空（源文件可能不是有效压缩包）')
  }

  // 自动穿透：若顶层只有一个子目录且无 SKILL.md
  if (entries.length === 1) {
    const singleEntry = join(destDir, entries[0])
    if (statSync(singleEntry).isDirectory() && !existsSync(join(destDir, 'SKILL.md'))) {
      return singleEntry
    }
  }

  return destDir
}

/** tar 流式解压（归档走 stdin 管）。spawn 参数数组 + 归档走 stdin 管（不经 shell）：三重雷区全规避——
 *  ① cmd.exe 引号插值会把 Windows 路径搅坏（实测 e2e 抓获）；
 *  ② GNU tar 把 -f 的盘符路径（C:\）误判为远程主机（stdin 管无 -f 路径）；
 *  ③ GNU tar 对 -C 参数做反斜杠转义（win32 下正斜杠化；bsdtar 同样接受，探针双测通过） */
async function extractViaTarPipe(archivePath: string, destDir: string, flag: string): Promise<void> {
  const dest = process.platform === 'win32' ? destDir.replace(/\\/g, '/') : destDir
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
}

/** tar 文件参数模式解压（zip 专用——目录区在文件尾，必须给 tar 可 seek 的文件句柄走中央目录） */
async function runTarFileArg(archivePath: string, destDir: string): Promise<void> {
  const dest = process.platform === 'win32' ? destDir.replace(/\\/g, '/') : destDir
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', ['-xf', archivePath, '-C', dest], { stdio: ['ignore', 'ignore', 'pipe'] })
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
  })
}

/** zip 完整性闸：tar -tf 条目数（文件类）vs 落盘文件数对账——静默丢条目在这里变大声。
 *  背书：2026-10-14 实测 stdin 管道模式静默丢 zip 序前 25 条（退出码 0、stderr 空），
 *  「解压假成功」与 2026-10-13 fetch-source 事故环 #3/#4 同族，闸失败由调用方回落重解。
 *  tar -tf 自身失败（极老系统无 tar 但 -xf 却成功的不自洽形态）时跳过闸——不强拦罕见环境。 */
async function assertZipEntryCount(archivePath: string, destDir: string): Promise<void> {
  const list = await new Promise<Buffer | null>((resolve) => {
    const child = spawn('tar', ['-tf', archivePath], { stdio: ['ignore', 'pipe', 'ignore'] })
    const chunks: Buffer[] = []
    child.stdout.on('data', (d: Buffer) => { chunks.push(d) })
    child.on('error', () => resolve(null))
    child.on('close', (code) => resolve(code === 0 ? Buffer.concat(chunks) : null))
  })
  if (list === null) return
  const entryCount = list.toString('utf8').split(/\r?\n/).filter((l) => l !== '' && !l.endsWith('/')).length
  const diskCount = countFilesRecursive(destDir)
  if (entryCount !== diskCount) {
    throw new Error(`解压不完整：归档含 ${entryCount} 个文件，实际落盘 ${diskCount} 个（tar 静默丢条目防御闸触发）`)
  }
}

/** 递归数文件（不用 readdirSync recursive 选项——兼容老 Node 运行时，照 removeRecursive 手写先例） */
function countFilesRecursive(dir: string): number {
  let n = 0
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) n += countFilesRecursive(p)
    else n++
  }
  return n
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
