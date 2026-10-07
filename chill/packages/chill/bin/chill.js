#!/usr/bin/env node
/**
 * 全档 chill 启动器。
 *
 * npm 全局安装不链接依赖包的 bin——壳包必须自己声明 bin 并转发到 chill-cli 的
 * bootstrap（该文件为 ESM bundle，不能 require，故以子进程透传 argv/退出码）。
 * 注入 CHILL_SHELL_ROOT 供 CLI 侧 /ui 探测壳包根（探测另有同层候选兜底，双保险）。
 */
const { spawn } = require('node:child_process')
const path = require('node:path')
const { createRequire } = require('node:module')

const req = createRequire(__filename)
let bootstrap
try {
  bootstrap = req.resolve('@assistant-ai/chill-cli/dist/bootstrap.js')
} catch {
  console.error('未找到 @assistant-ai/chill-cli（依赖安装不完整）。')
  console.error('请重装全档包：npm install -g @assistant-ai/chill')
  process.exit(1)
}

const child = spawn(process.execPath, [bootstrap, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, CHILL_SHELL_ROOT: path.resolve(__dirname, '..') },
})
child.on('error', (err) => {
  console.error(`启动 chill 失败: ${err && err.message ? err.message : err}`)
  process.exit(1)
})
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code == null ? 0 : code)
})
