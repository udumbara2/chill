/**
 * dist 清场（构建第一步）。
 * 手写递归删除（lstat+unlink+rmdir）——禁用 fs.rmSync：Node 24 在含非 ASCII 字符的
 * 路径下静默失败（tmp 探针实测复现；packages/cli build.mjs / guardian/freeze.js 同款
 * 既定规避）。不清场会让旧布局时代的产物（如 dist/demo）滞留并被打包带走。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist')

function removeRecursive(p) {
  let stat
  try { stat = fs.lstatSync(p) } catch { return }
  if (stat.isSymbolicLink()) { fs.rmdirSync(p); return }
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(p)) removeRecursive(path.join(p, name))
    fs.rmdirSync(p)
  } else {
    fs.unlinkSync(p)
  }
}

removeRecursive(distDir)
console.log('[clean] dist 已清场')
