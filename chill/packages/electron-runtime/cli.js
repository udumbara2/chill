#!/usr/bin/env node
// electron-win32-x64 启动引导（node cli.js <app目录> [参数…] → 直连 dist/electron.exe）
const { spawn } = require('node:child_process')
const path = require('node:path')
const args = process.argv.slice(2)
const electronExe = path.join(__dirname, 'dist', 'electron.exe')
const child = spawn(electronExe, args, { stdio: 'inherit' })
child.on('error', (err) => { console.error(err.message); process.exit(1) })
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code == null ? 0 : code)
})
