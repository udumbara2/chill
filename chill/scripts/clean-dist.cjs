/**
 * 构建前清空 packages/dist（UI 构建产物目录）。
 *
 * 为什么不用 vite 的 emptyOutDir / Node 的 fs.rmSync：
 * 本项目工作区路径含非 ASCII 字符（助手），实测本机 Node 24 的
 * fs.rmSync / fs.rmdirSync(recursive) 在该路径下会"静默失败"
 * （正常返回但目录纹丝不动，导致 vite emptyOutDir 形同虚设、
 * 带哈希的旧 bundle 无限累积）。手工遍历 unlink/rmdir 不受影响。
 * vite.config 中的 emptyOutDir: true 保留作为常规环境下的双保险。
 */
const fs = require('fs')
const path = require('path')

const target = path.join(__dirname, '..', 'packages', 'dist')

if (!fs.existsSync(target)) {
  process.exit(0)
}

function removeRecursive(p) {
  for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
    const child = path.join(p, entry.name)
    if (entry.isDirectory()) {
      removeRecursive(child)
    } else {
      fs.unlinkSync(child)
    }
  }
  fs.rmdirSync(p)
}

removeRecursive(target)
console.log(`[clean-dist] 已清空 ${target}`)
