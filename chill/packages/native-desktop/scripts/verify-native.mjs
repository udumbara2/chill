// verify-native.mjs —— 原生二进制隐私守卫（共享校验器，native-desktop 与 cli 两包复用）
//
// 职责：阻断含构建机路径信息（用户主目录 / CARGO_HOME / 项目树根）的 .node 进入
//       任何发布边界。三种用法：
//   A. node verify-native.mjs <目录或文件...>   —— 扫描给定目标（目录取全部 *.node），脏即失败
//   B. node verify-native.mjs --prepack        —— npm pack/publish 必经钩子：包根 ≥1 颗且全部干净
//                                                  + 清单不变量（files 白名单/LICENSE/publishConfig）
//   C. node verify-native.mjs --require <目录>  —— 断言目录 ≥1 颗且全部干净（cli 的 dist 用）
//
// 失败输出：闸名（MANIFEST / EXISTS / DIRTY）+ 命中数 + 首个样例上下文 + 修复指引。
// 扫描集用「尾随分隔符」形态（如 C:\Users\<name>\），防止前缀共享用户名的误杀
// （例：用户 alice2 的路径包含裸 alice 子串，但不带分隔符——不阻断）。
//
// 路径安全：Buffer.indexOf（UTF-8），中文路径安全；不使用 fs.rmSync（本机 Node 24
// 在含非 ASCII 路径下静默失败，见 guardian/switcher.js 的实证注释）。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const pkgDir = path.resolve(__dirname, '..')            // packages/native-desktop
export const treeRoot = path.resolve(pkgDir, '../..')          // 仓库根（scripts 上溯三级）

// ---------- 阻断扫描集 ----------

function buildPatterns() {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  const cargoHome = process.env.CARGO_HOME || (home ? path.join(home, '.cargo') : '')
  const roots = [home, cargoHome, treeRoot]
  // junction 树：__dirname 可能经 junction 进入，真实路径形态不同——两种都扫
  for (const r of [home, treeRoot]) {
    try {
      const real = fs.realpathSync(r)
      if (!roots.includes(real)) roots.push(real)
    } catch { /* 不存在则跳过 */ }
  }
  const patterns = []
  for (const r of roots) {
    if (!r || r.length < 4) continue
    if (r.endsWith('\\') || r.endsWith('/')) {
      patterns.push(r)
    } else {
      patterns.push(r + '\\', r + '/')
    }
  }
  // 去重（如默认 CARGO_HOME 已在 home 之下时会生成重复前缀）
  return [...new Set(patterns)]
}

// ---------- 扫描实现 ----------

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function readWithRetry(filePath) {
  try {
    return fs.readFileSync(filePath)
  } catch (err) {
    if (err && (err.code === 'EBUSY' || err.code === 'EPERM')) {
      sleepSync(500) // 杀软/索引器短暂锁文件的兜底重试
      return fs.readFileSync(filePath)
    }
    throw err
  }
}

function scanBuffer(buf, patterns) {
  let hits = 0
  let firstSample = null
  for (const p of patterns) {
    let idx = 0
    for (;;) {
      idx = buf.indexOf(p, idx)
      if (idx === -1) break
      hits++
      if (firstSample === null) {
        const start = Math.max(0, idx - 60)
        const end = Math.min(buf.length, idx + p.length + 80)
        firstSample = { pattern: p, context: buf.subarray(start, end).toString('utf8') }
      }
      idx += 1
    }
  }
  return { hits, firstSample }
}

export function scanFile(filePath, patterns) {
  return scanBuffer(readWithRetry(filePath), patterns)
}

function listNodeFiles(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.node')).map((f) => path.join(dir, f))
}

function failDirty(results) {
  const total = results.reduce((n, r) => n + r.result.hits, 0)
  const first = results.find((r) => r.result.hits > 0)
  console.error('════ [DIRTY] 原生二进制含构建机路径信息，已阻断 ════')
  console.error(`  命中总数: ${total}`)
  for (const r of results) {
    if (r.result.hits > 0) console.error(`  - ${r.file}: ${r.result.hits} 处`)
  }
  if (first && first.result.firstSample) {
    console.error(`  首个样例（模式 ${JSON.stringify(first.result.firstSample.pattern)}）:`)
    console.error(`    ...${first.result.firstSample.context}...`)
  }
  console.error('  修复：pnpm --filter @assistant-ai/native-desktop build（构建包装会注入')
  console.error('  remap-path-prefix 并自检；本守卫挂在 prepack，此失败说明绕过了正常构建入口）。')
  process.exit(1)
}

function failExists(dir) {
  console.error(`════ [EXISTS] 目录无任何 .node：${dir} ════`)
  console.error('  发布态的该目录必须携带原生模块（workspace 布局下应存在兄弟包产物）。')
  process.exit(1)
}

function scanTargets(targets) {
  const patterns = buildPatterns()
  const results = []
  for (const t of targets) {
    let files
    if (fs.existsSync(t) && fs.statSync(t).isDirectory()) {
      files = listNodeFiles(t)
    } else {
      files = [t]
    }
    for (const f of files) results.push({ file: f, result: scanFile(f, patterns) })
  }
  return results
}

// ---------- 三种模式 ----------

function runPrepack() {
  // 清单闸（MANIFEST）：这次事故（files/LICENSE/publishConfig 被无声删除）固化的不变量
  const manifestErrors = []
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  const expectedFiles = ['index.js', 'index.d.ts', '*.node']
  const filesOk =
    Array.isArray(pkg.files) &&
    pkg.files.length === expectedFiles.length &&
    pkg.files.every((v, i) => v === expectedFiles[i])
  if (!filesOk) manifestErrors.push(`files 必须恰为 ${JSON.stringify(expectedFiles)}，现为 ${JSON.stringify(pkg.files)}`)
  if (!fs.existsSync(path.join(pkgDir, 'LICENSE'))) manifestErrors.push('LICENSE 文件缺失')
  if (!pkg.publishConfig || pkg.publishConfig.access !== 'public') {
    manifestErrors.push('publishConfig.access 必须为 "public"')
  }
  if (manifestErrors.length > 0) {
    console.error('════ [MANIFEST] 发布清单不变量被破坏 ════')
    for (const e of manifestErrors) console.error(`  - ${e}`)
    process.exit(1)
  }

  // 存在闸（EXISTS）+ 脏物闸（DIRTY）
  const nodes = listNodeFiles(pkgDir)
  if (nodes.length === 0) failExists(pkgDir)
  const results = nodes.map((f) => ({ file: f, result: scanFile(f, buildPatterns()) }))
  if (results.some((r) => r.result.hits > 0)) failDirty(results)
  console.log(`[verify-native] --prepack 通过：${nodes.length} 颗 .node 干净，清单不变量完好`)
}

function runRequire(dir) {
  if (!dir) {
    console.error('用法：verify-native.mjs --require <目录>')
    process.exit(2)
  }
  const nodes = listNodeFiles(dir)
  if (nodes.length === 0) failExists(dir)
  const results = nodes.map((f) => ({ file: f, result: scanFile(f, buildPatterns()) }))
  if (results.some((r) => r.result.hits > 0)) failDirty(results)
  console.log(`[verify-native] --require 通过：${nodes.length} 颗 .node 干净（${dir}）`)
}

function runScan(targets) {
  if (targets.length === 0) {
    console.error('用法：verify-native.mjs <目录或文件...> | --prepack | --require <目录>')
    process.exit(2)
  }
  const results = scanTargets(targets)
  if (results.some((r) => r.result.hits > 0)) failDirty(results)
  const scanned = results.length
  console.log(`[verify-native] 扫描通过：${scanned} 个目标干净`)
}

// ---------- 入口（被 import 时不自动执行） ----------
// 注意：chill/ 可能是指向 chill-versions/vX 的 junction——Node 主入口默认 realpath 化，
// argv[1] 与 import.meta.url 可能一个是真实路径形态、一个是 junction 形态，
// 直接字符串比对会静默判否（主逻辑不执行、exit 0）。必须 realpath 两侧后再比对。
const isMain = (() => {
  try {
    return process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()
if (isMain) {
  const args = process.argv.slice(2)
  if (args.includes('--prepack')) {
    runPrepack()
  } else if (args.includes('--require')) {
    // 兼容两种顺序：--require <dir> 与 <dir> --require（后者取首个非旗标参数）
    const idx = args.indexOf('--require')
    const dir = args[idx + 1] || args.find((a, i) => i !== idx && !a.startsWith('--'))
    runRequire(dir)
  } else {
    runScan(args)
  }
}
