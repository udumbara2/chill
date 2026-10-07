#!/usr/bin/env node
/**
 * chill 薄启动器：读指针（~/.chill/current.json）决定运行哪个版本
 * - active=self 且 home 有效 → 委托给源码版本（透传参数/stdio/退出码；模式判定由子进程自锚定完成，无需注入）
 * - 其余情况（指针缺失/损坏/active=npm/home 失效）→ 运行包内 cli.js（npm 模式）
 * 委托目标是 workspace 的 cli.js 而非 bootstrap 自身，避免递归。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 读取指针并校验 home 有效；任何异常都返回 null（按 npm 模式处理） */
function resolveDelegation(): { home: string; target: string } | null {
  try {
    const pointer = JSON.parse(readFileSync(join(homedir(), '.chill', 'current.json'), 'utf-8'))
    if (pointer?.active !== 'self' || typeof pointer.home !== 'string') return null
    const target = join(pointer.home, 'packages', 'cli', 'dist', 'cli.js')
    return existsSync(target) ? { home: pointer.home, target } : null
  } catch {
    return null
  }
}

/** 官方包升级后若与自迭代基础版本不一致，打印一行提示（不阻断） */
function printVersionDriftNotice(home: string): void {
  try {
    const selfVersion = JSON.parse(readFileSync(join(home, 'packages', 'cli', 'package.json'), 'utf-8')).version
    const npmVersion = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf-8')).version
    if (selfVersion && npmVersion && selfVersion !== npmVersion) {
      process.stdout.write(`提示：官方包已更新至 v${npmVersion}，当前运行基于 v${selfVersion} 的自迭代版本（/use-npm 切换官方版；升级自迭代基版：/use-npm 切换并重启后执行 /fetch-source）。\n`)
    }
  } catch { /* 版本信息不可读时静默 */ }
}

const delegated = resolveDelegation()

// chill web 子命令（M5.5：Web 宿主 daemon 的启动别名——lazy 派发，纯 CLI 路径零 web/ui 导入；
// 原则 1/11 的机械化保障：web 不在时本文件不加载任何 web 产物）
// 命名空间约定：web=WebUI daemon；serve=手机遥控常驻宿主控制面（on|off|status，委托后由 cli.ts 门控至 serveControl）
function isWebCommand(argv: string[]): boolean {
  return argv[0] === 'web'
}

function findServeScript(): string | null {
  const candidates: string[] = [
    join(dirname(fileURLToPath(import.meta.url)), 'web', 'serve.js'), // npm 包内
  ]
  if (delegated) candidates.push(join(delegated.home, 'packages', 'web', 'dist', 'serve.js')) // 自迭代布局
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

if (isWebCommand(process.argv.slice(2))) {
  const script = findServeScript()
  if (!script) {
    process.stderr.write('✗ chill web 不可用：web daemon 未构建（npm 包版本不含或 packages/web/dist 缺失）。\n')
    process.exit(1)
  }
  const child = spawn(process.execPath, [script, ...process.argv.slice(3)], { stdio: 'inherit' })
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal)
    else process.exit(code ?? 0)
  })
} else if (delegated) {
  printVersionDriftNotice(delegated.home)
  const child = spawn(process.execPath, [delegated.target, ...process.argv.slice(2)], {
    stdio: 'inherit',
  })
  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal)
    } else {
      process.exit(code ?? 0)
    }
  })
} else {
  // 指针缺失/损坏/home 失效 → 回退包内版本；仅在想用 self 时提示一句
  try {
    const pointer = JSON.parse(readFileSync(join(homedir(), '.chill', 'current.json'), 'utf-8'))
    if (pointer?.active === 'self') {
      process.stdout.write('提示：自迭代版本目录已失效，回退到 npm 包版本（可 /fetch-source 重新获取源码）。\n')
    }
  } catch { /* 指针缺失或损坏：静默按 npm 模式 */ }
  await import('./cli.js')
}
