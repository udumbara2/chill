/**
 * chill-relay bin 入口（npm 包 `chill-relay` 命令）。
 *
 * - `chill-relay`            启动服务（env 来源：进程环境 > ./chill-relay.env > /etc/chill-relay/env）
 * - `chill-relay --init`     最小部署向导：生成运营者密钥、写 env 文件、打印 systemd 单元与清单
 *
 * env 文件仅作为缺省补充（已存在的进程环境变量优先），格式为 KEY=VALUE 行（# 注释）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { main } from './server.js'
import { runInit } from './init.js'

function loadEnvFile(path: string): void {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if (!key || key in process.env) continue
    process.env[key] = value
  }
}

function loadEnvDefaults(): void {
  const candidates = [join(process.cwd(), 'chill-relay.env'), '/etc/chill-relay/env']
  for (const p of candidates) {
    if (existsSync(p)) loadEnvFile(p)
  }
}

if (process.argv.includes('--init')) {
  runInit()
} else {
  loadEnvDefaults()
  main()
}
