import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decompressArchive, downloadFile, getOwnProjectPaths } from '@assistant-ai/core'

/**
 * fetch-source：把 chill 源码按需下载到受管位置（~/.chill/workspace/），
 * 构建完成后写指针（~/.chill/current.json）使 bootstrap 委托到源码版本。
 * 仅在 npm 模式（无源码环境）下可用；npm 版本与双仓 tag 的对齐由 release.mjs 发布闸保证。
 */

// 源码仓库地址（Gitee 优先，GitHub 兜底；CHILL_SOURCE_URL 环境变量可显式覆盖）
const GITHUB_REPO = 'https://github.com/udumbara2/chill'
const GITEE_REPO = 'https://gitee.com/assistant-ai/chill'

// 源码归档约 3.5MB；慢网络（尤其 GitHub 兜底源）需要分钟级余量，downloadFile 默认 30s 是通用小文件语义
const DOWNLOAD_TIMEOUT_MS = 300_000

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

/** 手写递归删除（lstat+unlink+rmdir）。禁用 fs.rmSync：Node 24 在含非 ASCII 字符的
 *  路径下静默失败（tmp 探针实测复现；build.mjs / guardian/freeze.js 同款既定规避）——
 *  ~/.chill/workspace 落在中文用户名目录下时，重下载清场会静默残留并令 renameSync 报错 */
function removeRecursive(p: string): void {
  let stat: ReturnType<typeof lstatSync>
  try { stat = lstatSync(p) } catch { return }
  if (stat.isSymbolicLink()) { rmdirSync(p); return }
  if (!stat.isDirectory()) { unlinkSync(p); return }
  for (const name of readdirSync(p)) removeRecursive(join(p, name))
  rmdirSync(p)
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
    // 委托态 self 会话也命中此分支：基版升级不能在本会话内完成（fetchSource 拒跑），
    // 必须给出可行动的出口路径，而非让用户撞墙后无指引。
    // 路径比较先归一化：两侧来源不同（realpath vs homedir+join），分隔符/大小写可能不一致
    const norm = (p: string) => {
      const n = p.replace(/\//g, '\\')
      return process.platform === 'win32' ? n.toLowerCase() : n
    }
    const inWorkspace = norm(getOwnProjectPaths().projectPath!) === norm(getWorkspaceProjectDir())
    return {
      ok: false,
      message: inWorkspace
        ? '源码环境已存在（当前正运行自迭代版本），无需下载。若要升级自迭代基版：先 /use-npm 切回官方包并重启，再执行 /fetch-source。'
        : '源码环境已存在（当前就在 chill 项目中运行），无需下载。',
    }
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
      removeRecursive(projectDir)
    }
    const version = getOwnVersion()
    // 临时目录落在 workspace 内（与目标同卷）：renameSync 跨卷必败——libuv 的
    // MoveFileExW 不带 MOVEFILE_COPY_ALLOWED，POSIX rename(2) 跨挂载点同样 EXDEV；
    // 同卷落点是构造上消灭该失败面，而非事后兜底
    const tmp = mkdtempSync(join(workspaceDir, '.fetch-source-'))
    try {
      let extractedRoot: string | null = null
      const errors: string[] = []
      for (const url of candidateUrls(version)) {
        try {
          const archivePath = join(tmp, url.endsWith('.zip') ? 'source.zip' : 'source.tar.gz')
          log(`下载源码：${url}`)
          await downloadFile(url, archivePath, DOWNLOAD_TIMEOUT_MS)
          const extractDir = join(tmp, 'extract')
          mkdirSync(extractDir, { recursive: true })
          extractedRoot = await decompressArchive(archivePath, extractDir)
          break
        } catch (e: any) {
          errors.push(`${url} → ${e?.message ?? e}`)
          // 失败的解压可能留下半成品，清场防污染下一个候选源的同名解压目录
          removeRecursive(join(tmp, 'extract'))
        }
      }
      if (!extractedRoot) {
        return { ok: false, message: `源码下载失败：\n${errors.join('\n')}\n可用 CHILL_SOURCE_URL 环境变量指定下载地址后重试。` }
      }
      // 四件套容器布局（公开仓 v0.0.2 起）：归档根含 chill/ 子目录与兄弟件——拆到
      // workspace 平铺（chill=monorepo、chill-relay/chill-mobile=自迭代对象、
      // chill-guardian=切换工具），与开发机活树布局同构（mobile-iterate 的路径注入、
      // e2e 相对路径均按此布局解析）。旧单仓归档（老 tag / CHILL_SOURCE_URL 本地验证）
      // 不含 chill/ 子目录，保持原行为。
      if (existsSync(join(extractedRoot, 'chill', 'pnpm-workspace.yaml'))) {
        for (const piece of ['chill', 'chill-relay', 'chill-mobile', 'chill-guardian']) {
          const src = join(extractedRoot, piece)
          if (!existsSync(src)) continue
          const dest = join(workspaceDir, piece)
          if (existsSync(dest)) removeRecursive(dest)
          renameSync(src, dest)
        }
        log(`源码已就位（四件套）：${projectDir} + chill-relay/chill-mobile/chill-guardian`)
      } else {
        renameSync(extractedRoot, projectDir)
        log(`源码已就位：${projectDir}`)
      }
    } finally {
      removeRecursive(tmp)
    }
  }

  // guardian 工具随包携带 → 复制到 workspace/chill-guardian/（switcher.js=版本切换；mobile-freeze.js=手机端自迭代快照锚点）
  // 四件套归档自带 chill-guardian/ 时以归档为准（与源码版本对齐），跳过包内副本
  const bundledGuardian = join(getOwnPackageRoot(), 'guardian')
  const guardianDir = join(workspaceDir, 'chill-guardian')
  mkdirSync(guardianDir, { recursive: true })
  if (existsSync(join(guardianDir, 'switcher.js'))) {
    log('chill-guardian/ 已随源码归档就位（版本对齐），跳过包内副本。')
  } else {
    const bundledSwitcher = join(bundledGuardian, 'switcher.js')
    if (existsSync(bundledSwitcher)) {
      writeFileSync(join(guardianDir, 'switcher.js'), readFileSync(bundledSwitcher))
      log('switcher.js 已就位。')
    } else {
      log('警告：包内未找到 switcher.js，版本切换功能将不可用。')
    }
    const bundledFreeze = join(bundledGuardian, 'mobile-freeze.js')
    if (existsSync(bundledFreeze)) {
      writeFileSync(join(guardianDir, 'mobile-freeze.js'), readFileSync(bundledFreeze))
      log('mobile-freeze.js 已就位。')
    } else {
      log('警告：包内未找到 mobile-freeze.js，手机端自迭代将不可用（不影响其他功能）。')
    }
    const bundledPush = join(bundledGuardian, 'mobile-push.js')
    if (existsSync(bundledPush)) {
      writeFileSync(join(guardianDir, 'mobile-push.js'), readFileSync(bundledPush))
      log('mobile-push.js 已就位。')
    } else {
      log('警告：包内未找到 mobile-push.js，手机端远程推送将不可用（不影响其他功能）。')
    }
  }

  // 构建 workspace
  log('安装依赖（pnpm install，可能需要几分钟）...')
  runIn(projectDir, 'pnpm install')
  // 只构建 CLI 自迭代必需的目标：build:cli 内含 core 构建。
  // 全量 pnpm build 会强制 native-desktop 的 cargo 编译（用户机无 Rust 必败）与 electron 构建——
  // CLI 对 native-desktop 是 esbuild external + 仓库预编译 .node 运行时懒加载，均非必需
  log('编译（pnpm build:cli，含 core）...')
  runIn(projectDir, 'pnpm build:cli')

  // 构建成功后才写指针（失败则保持 npm 模式，可重入）
  writePointer('self', projectDir)
  return { ok: true, message: `自迭代环境就绪。指针已指向源码版本，重启 chill 后生效（/use-npm 可随时回退）。` }
}
