/**
 * 递归删除 helper（测试专用）：手工遍历替代 fs.rmSync。
 *
 * 为何存在：本机 Node 24 的 fs.rmSync 对含 CJK 字符的目录有环境 bug
 * （静默不删却返回成功，偶发进程 exit 127 崩溃），knowledge 测试的中文名
 * 知识库（技术笔记/前端笔记）与含 CJK 子目录的临时 home 因此删不干净。
 * 经典 readdirSync 递归 + unlinkSync/rmdirSync 单层调用无此问题。
 *
 * 语义仿 chill-guardian/switcher.js 的 removeRecursive：
 * - 路径不存在静默返回（等价 rmSync 的 force: true）；
 * - junction/符号链接只删链接本身（rmdirSync），不递归进目标；
 * - 探测用 lstatSync 而非 existsSync（悬空符号链接也会被正确删除）。
 */
import * as fs from 'fs'
import * as path from 'path'

export function removeRecursive(targetPath: string): void {
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(targetPath)
  } catch {
    return // 路径不存在
  }
  if (stat.isSymbolicLink()) {
    fs.rmdirSync(targetPath)
    return
  }
  if (!stat.isDirectory()) {
    fs.unlinkSync(targetPath)
    return
  }
  for (const name of fs.readdirSync(targetPath)) {
    removeRecursive(path.join(targetPath, name))
  }
  fs.rmdirSync(targetPath)
}
