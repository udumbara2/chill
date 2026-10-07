// build.mjs —— native-desktop 构建包装（隐私 remap 注入 + 构建后自检）
//
// 为什么存在：rustc 默认把编译期源码路径（依赖 crate 的 panic 元数据里是
// C:\Users\<用户名>\.cargo\registry\...）硬编码进 .node 二进制。曾经的静态
// .cargo/config.toml 方案有两个致命弱点：文件自身含明文用户名；且任何一棵
// 构建树缺了它，保护就静默消失（历史上因此产出过 410 处命中的脏二进制）。
// 本包装在构建命令外层动态注入 --remap-path-prefix（任何机器/任何树自动生效），
// 并在构建后立即自检——抹除失效从「静默」变「响亮失败」。
//
// 运行方式：经 pnpm 触发（package.json 的 build 脚本），pnpm 会把 node_modules/.bin
// 注入 PATH 使 napi 可寻。裸 `node scripts/build.mjs` 不在支持范围（spawn ENOENT
// 即响亮失败，符合本守卫哲学）。

import { spawn, spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pkgDir = path.resolve(__dirname, '..')
const SEP = '\x1f' // CARGO_ENCODED_RUSTFLAGS 的参数分隔符（规避空格/中文路径问题）

const home = os.homedir()
const cargoHome = process.env.CARGO_HOME || path.join(home, '.cargo')

const flags = [`--remap-path-prefix=${home}=/build`]
// cargoHome 默认在 home 之下（已被上面的 home 前缀覆盖）；仅当迁出时才单独 remap
const underHome =
  process.platform === 'win32'
    ? cargoHome.toLowerCase().startsWith(home.toLowerCase())
    : cargoHome.startsWith(home)
if (!underHome) flags.push(`--remap-path-prefix=${cargoHome}=/cargo`)

const prev = process.env.CARGO_ENCODED_RUSTFLAGS
process.env.CARGO_ENCODED_RUSTFLAGS = prev ? prev + SEP + flags.join(SEP) : flags.join(SEP)

console.log('[build] remap 注入:')
for (const f of flags) console.log(`  ${f}`)

// Windows 下 napi 是 .cmd，CreateProcess 不能直接执行；经 cmd.exe 传单字符串命令
// （不经 args 数组拼接——规避 shell 参数注入面与 DEP0190）
const isWin = process.platform === 'win32'
const child = isWin
  ? spawn(process.env.comspec || 'cmd.exe', ['/d', '/s', '/c', 'napi build --release --platform'], {
      cwd: pkgDir,
      stdio: 'inherit',
      env: process.env,
    })
  : spawn('napi', ['build', '--release', '--platform'], {
      cwd: pkgDir,
      stdio: 'inherit',
      env: process.env,
    })
child.on('error', (err) => {
  console.error('[build] spawn napi 失败（应经 pnpm 运行以获得 PATH 注入）:', err.message)
  process.exit(1)
})
child.on('close', (code) => {
  if (code !== 0) process.exit(code)
  // 构建后自检：脏即响亮失败（同时是 prepack 守卫的前置保障）
  const verify = spawnSync(process.execPath, [path.join(__dirname, 'verify-native.mjs'), pkgDir], {
    stdio: 'inherit',
  })
  process.exit(verify.status ?? 1)
})
