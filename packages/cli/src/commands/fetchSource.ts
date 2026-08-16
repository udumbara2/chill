import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decompressArchive, downloadFile, getOwnProjectPaths } from '@assistant-ai/core'

/**
 * fetch-source：把 chill 源码按需下载到受管位置（~/.chill/workspace/），
 * 构建完成后写指针（~/.chill/current.json）使 bootstrap 委托到源码版本。
 * 仅在 npm 模式（无源码环境）下可用；源码仓库地址下一轮建仓后填真实值。
 */

// 源码仓库地址（Gitee 优先，GitHub 兜底；CHILL_SOURCE_URL 环境变量可显式覆盖）
const GITHUB_REPO = 'https://github.com/udumbara2/chill'
const GITEE_REPO = 'https://gitee.com/udumbara2/chill'

export interface Pointer {
  active: 'npm' | 'self'
  home: string | null
  updatedAt: string
}

export function getChillHome(): string {
  return join(homedir(), '.chill')
}

export function getPointerPath(): string {
  return join(getChillHome(), 'current.json')
}

export function getWorkspaceDir(): string {
  return join(getChillHome(), 'workspace')
}

export function getWorkspaceProjectDir(): string {
  return join(getWorkspaceDir(), 'chill')
}

/** 读取指针；缺失或损坏返回 null（调用方按 npm 模式处理） */
export function readPointer(): Pointer | null {
  try {
    const p = JSON.parse(readFileSync(getPointerPath(), 'utf-8'))
    if (p && (p.active === 'npm' || p.active === 'self')) {
      return { active: p.active, home: typeof p.home === 'string' ? p.home : null, updatedAt: p.updatedAt ?? '' }
    }
    return null
  } catch {
    return null
  }
}

export function writePointer(active: 'npm' | 'self', home: string | null): void {
  mkdirSync(getChillHome(), { recursive: true })
  const pointer: Pointer = { active, home, updatedAt: new Date().toISOString() }
  writeFileSync(getPointerPath(), JSON.stringify(pointer, null, 2), 'utf-8')
}

/** 自迭代活版本是否可用（home 有效且 cli 产物存在） */
export function isSelfVersionUsable(home: string | null): boolean {
  return !!home && existsSync(join(home, 'packages', 'cli', 'dist', 'cli.js'))
}

function getOwnPackageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..')
}

function getOwnVersion(): string {
  try {
    return JSON.parse(readFileSync(join(getOwnPackageRoot(), 'package.json'), 'utf-8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** 按序生成候选下载地址（CHILL_SOURCE_URL 显式覆盖优先，用于本地验证） */
function candidateUrls(version: string): string[] {
  const override = process.env.CHILL_SOURCE_URL
  if (override) return [override]
  return [
    `${GITEE_REPO}/repository/archive/v${version}.zip`,
    `${GITHUB_REPO}/archive/refs/tags/v${version}.tar.gz`,
  ]
}

function hasPnpm(): boolean {
  const r = spawnSync('pnpm --version', { shell: true, stdio: 'ignore' })
  return r.status === 0
}

function runIn(cwd: string, command: string): void {
  const r = spawnSync(command, { cwd, shell: true, stdio: 'inherit' })
  if (r.status !== 0) throw new Error(`命令失败（退出码 ${r.status}）：${command}`)
}

export interface FetchSourceOptions {
  log: (msg: string) => void
  /** workspace/chill 已存在时的处置：继续构建（复用现有源码）或重新下载 */
  onExisting: 'continue' | 'redownload'
}

export interface FetchSourceResult {
  ok: boolean
  message: string
}

export async function fetchSource(opts: FetchSourceOptions): Promise<FetchSourceResult> {
  const { log } = opts

  // 幂等：已处于源码环境（开发机 / 已委托的 self 会话）
  if (getOwnProjectPaths().projectPath !== null) {
    return { ok: false, message: '源码环境已存在（当前就在 chill 项目中运行），无需下载。' }
  }

  // 前置检查 pnpm（workspace 构建依赖）
  if (!hasPnpm()) {
    return { ok: false, message: '未检测到 pnpm。请先执行 corepack enable（Node 自带）或 npm i -g pnpm，然后重试 /fetch-source。' }
  }

  const workspaceDir = getWorkspaceDir()
  const projectDir = getWorkspaceProjectDir()
  mkdirSync(workspaceDir, { recursive: true })

  // 下载 + 解压（已存在时按用户选择处理）
  if (existsSync(projectDir) && opts.onExisting === 'continue') {
    log('复用已存在的源码目录，跳过下载。')
  } else {
    if (existsSync(projectDir)) {
      rmSync(projectDir, { recursive: true, force: true })
    }
    const version = getOwnVersion()
    const tmp = mkdtempSync(join(tmpdir(), 'chill-source-'))
    let extractedRoot: string | null = null
    const errors: string[] = []
    for (const url of candidateUrls(version)) {
      try {
        const archivePath = join(tmp, url.endsWith('.zip') ? 'source.zip' : 'source.tar.gz')
        log(`下载源码：${url}`)
        await downloadFile(url, archivePath)
        const extractDir = join(tmp, 'extract')
        mkdirSync(extractDir, { recursive: true })
        extractedRoot = await decompressArchive(archivePath, extractDir)
        break
      } catch (e: any) {
        errors.push(`${url} → ${e?.message ?? e}`)
      }
    }
    if (!extractedRoot) {
      rmSync(tmp, { recursive: true, force: true })
      return { ok: false, message: `源码下载失败：\n${errors.join('\n')}\n可用 CHILL_SOURCE_URL 环境变量指定下载地址后重试。` }
    }
    renameSync(extractedRoot, projectDir)
    rmSync(tmp, { recursive: true, force: true })
    log(`源码已就位：${projectDir}`)
  }

  // switcher.js 随包携带 → 复制到 workspace/chill-guardian/
  const bundledSwitcher = join(getOwnPackageRoot(), 'guardian', 'switcher.js')
  const guardianDir = join(workspaceDir, 'chill-guardian')
  mkdirSync(guardianDir, { recursive: true })
  if (existsSync(bundledSwitcher)) {
    writeFileSync(join(guardianDir, 'switcher.js'), readFileSync(bundledSwitcher))
    log('switcher.js 已就位。')
  } else {
    log('警告：包内未找到 switcher.js，版本切换功能将不可用。')
  }

  // 构建 workspace
  log('安装依赖（pnpm install，可能需要几分钟）...')
  runIn(projectDir, 'pnpm install')
  log('编译（pnpm build && pnpm build:cli）...')
  runIn(projectDir, 'pnpm build')
  runIn(projectDir, 'pnpm build:cli')

  // 构建成功后才写指针（失败则保持 npm 模式，可重入）
  writePointer('self', projectDir)
  return { ok: true, message: `自迭代环境就绪。指针已指向源码版本，重启 chill 后生效（/use-npm 可随时回退）。` }
}
