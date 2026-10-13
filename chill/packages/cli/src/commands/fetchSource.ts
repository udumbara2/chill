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

/** 包根推导：运行时文件恒为 dist/cli.js，而 dist 是包根的直接子目录（npm 包 / workspace
 *  源码版 / npx 缓存三种布局同构），一级向上即可——与 bootstrap.ts / cli.ts 读版本的既有
 *  正确写法对齐。旧版两级向上在 esbuild 内联布局下越过包根指向 node_modules，是 v0.0.0
 *  下载 404 的根因（2026-10-10 npm 用户实测必经断点；guardian 副本复制用同一函数同病）。 */
function getOwnPackageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..')
}

/** 读自身版本。读不到 / name 不符时显式抛错——严禁静默兜底 '0.0.0'（无声 404 的排查
 *  代价不值得付第二次）；调用方转为 ok:false 让用户看到明确原因。cli.ts 复用门的版本
 *  透明文案也消费它（export 原因）。 */
export function getOwnVersion(): string {
  const pkgPath = join(getOwnPackageRoot(), 'package.json')
  let pkg: { name?: unknown; version?: unknown }
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  } catch {
    throw new Error(`无法读取 ${pkgPath}——无法确定 chill 包根，构造源码下载地址需要自身版本号。`)
  }
  if (pkg?.name !== '@assistant-ai/chill-cli') {
    throw new Error(`${pkgPath} 的 name 为 ${String(pkg?.name)}，期望 @assistant-ai/chill-cli（包布局可能已变更）。`)
  }
  if (typeof pkg.version !== 'string' || !pkg.version) {
    throw new Error(`${pkgPath} 缺少 version 字段。`)
  }
  return pkg.version
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

/** ①格式门：HTTP 200 ≠ 是压缩包（Gitee 归档登录墙实测回 44.8KB HTML 网页）。
 *  魔数与扩展名对账，不符/为空/是网页 → 抛带分类话术的错误（进候选循环换下一源）。 */
function verifyArchiveFormat(archivePath: string, url: string): void {
  const lowerUrl = url.toLowerCase()
  const expectZip = lowerUrl.endsWith('.zip')
  const expectGzip = lowerUrl.endsWith('.tar.gz') || lowerUrl.endsWith('.tgz')
  if (!expectZip && !expectGzip) return // .tar 等罕见覆盖格式无 gzip 头，跳过（文档注明）
  let head: Buffer
  try {
    head = readFileSync(archivePath).subarray(0, 2)
  } catch (e: any) {
    throw new Error(`下载内容读取失败：${e?.message ?? e}`)
  }
  if (head.length < 2) throw new Error('下载到的文件为空')
  if (head[0] === 0x3c && head[1] === 0x21) {
    throw new Error('该源返回的是网页而非压缩包（疑似登录墙/防爬）')
  }
  const isZip = head[0] === 0x50 && head[1] === 0x4b // PK
  const isGzip = head[0] === 0x1f && head[1] === 0x8b // 1F 8B
  if ((expectZip && !isZip) || (expectGzip && !isGzip)) {
    throw new Error('下载内容文件头与压缩包格式不符')
  }
}

/** ②内容门：解压产物形状必须是 chill 源码归档（四件套容器或单仓）——
 *  形状不对=下错了东西，不许当源码就位。 */
function verifyExtractedLayout(extractedRoot: string): void {
  const fourPiece = existsSync(join(extractedRoot, 'chill', 'pnpm-workspace.yaml'))
  const singleRepo =
    existsSync(join(extractedRoot, 'package.json')) && existsSync(join(extractedRoot, 'pnpm-workspace.yaml'))
  if (!fourPiece && !singleRepo) {
    throw new Error('归档布局不符（非 chill 源码仓库）')
  }
}

export interface ProjectDirProbe {
  usable: boolean
  /** projectDir 内 packages/cli 的版本（读不到为 null）——就位门对账与复用门透明共用 */
  cliVersion: string | null
}

/** ③就位门/复用门共用探针：projectDir 是「可构建的 chill monorepo」（package.json 含
 *  build:cli——与本文件 runIn(projectDir, 'pnpm build:cli') 调用点同改，脚本改名两处同步）。 */
export function inspectProjectDir(projectDir: string): ProjectDirProbe {
  try {
    const pkg = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf-8'))
    const usable = typeof pkg?.scripts?.['build:cli'] === 'string' && pkg.scripts['build:cli'].length > 0
    let cliVersion: string | null = null
    try {
      const cliPkg = JSON.parse(readFileSync(join(projectDir, 'packages', 'cli', 'package.json'), 'utf-8'))
      if (typeof cliPkg?.version === 'string' && cliPkg.version) cliVersion = cliPkg.version
    } catch {
      /* 版本读不到不影响可用性判定 */
    }
    return { usable, cliVersion }
  } catch {
    return { usable: false, cliVersion: null }
  }
}

/** pnpm 版本门槛：pnpm-workspace.yaml 的 allowBuilds（依赖构建脚本白名单）为 pnpm 10.26.0
 *  引入的机制，旧版会静默无视白名单、按默认全跑构建脚本——错误形态远离根因，晚撞墙不如早拦截。 */
const MIN_PNPM = [10, 26] as const

/** pnpm 前置双检（存在性 + 版本，共用同一次探测）。stdout 解析不出 semver 时按旧的存在性
 *  语义放行——非常规构建形态不误拦。 */
function checkPnpm(): 'ok' | 'missing' | { old: string } {
  const r = spawnSync('pnpm --version', { shell: true, stdio: ['ignore', 'pipe', 'ignore'] })
  if (r.status !== 0 || !r.stdout) return 'missing'
  const m = /^v?(\d+)\.(\d+)/.exec(r.stdout.toString().trim())
  if (!m) return 'ok'
  const [major, minor] = [Number(m[1]), Number(m[2])]
  if (major > MIN_PNPM[0] || (major === MIN_PNPM[0] && minor >= MIN_PNPM[1])) return 'ok'
  return { old: `${major}.${minor}` }
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

  // 前置检查 pnpm（workspace 构建依赖；双检=存在性+版本）。文案四问：为什么/不装会怎样/怎么装/装完干嘛。
  const pnpm = checkPnpm()
  if (pnpm === 'missing') {
    return {
      ok: false,
      message:
        '未检测到 pnpm。源码需在本地「安装依赖 + 编译」后才能运行，本仓库依赖\n' +
        '仅 pnpm 可装（npm/yarn 不支持）；不装不影响 chill 日常使用，仅无法进入\n' +
        '源码自迭代模式。\n' +
        '安装：npm i -g pnpm（Node <22 请装 pnpm@10，详见 README「自迭代」章节）\n' +
        '装好后重试 /fetch-source。',
    }
  }
  if (pnpm !== 'ok') {
    return {
      ok: false,
      message: `检测到 pnpm ${pnpm.old}，本仓库需 ≥${MIN_PNPM[0]}.${MIN_PNPM[1]}（依赖构建脚本白名单 allowBuilds 为 pnpm 10.26 引入，旧版会静默无视）。\n请升级：npm i -g pnpm@10\n然后重试 /fetch-source。`,
    }
  }

  const workspaceDir = getWorkspaceDir()
  const projectDir = getWorkspaceProjectDir()
  mkdirSync(workspaceDir, { recursive: true })

  // 下载 + 解压（已存在时按用户选择处理）
  // CHILL_SOURCE_URL 显式覆盖时版本号不参与下载地址（candidateUrls 直接返回覆盖地址）；
  // 否则必须读对且读得出——读错=双源 404，读不出=显式失败，均不再静默兜底 0.0.0
  // （提升到外层：③就位门的 tag 模式版本对账也要用它）
  let version = ''
  if (existsSync(projectDir) && opts.onExisting === 'continue') {
    log('复用已存在的源码目录，跳过下载。')
  } else {
    if (existsSync(projectDir)) {
      removeRecursive(projectDir)
    }
    if (!process.env.CHILL_SOURCE_URL) {
      try {
        version = getOwnVersion()
      } catch (e: any) {
        return { ok: false, message: `无法确定自身版本：${e?.message ?? e}` }
      }
    }
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
          verifyArchiveFormat(archivePath, url) // ①格式门：200 ≠ 压缩包
          const extractDir = join(tmp, 'extract')
          mkdirSync(extractDir, { recursive: true })
          extractedRoot = await decompressArchive(archivePath, extractDir)
          verifyExtractedLayout(extractedRoot) // ②内容门：形状=chill 源码归档才认
          break
        } catch (e: any) {
          // 复位关键：②门在赋值后抛错时 extractedRoot 已带脏值，不复位会误判「已有产物」
          extractedRoot = null
          errors.push(`${url} → ${e?.message ?? e}`)
          log(`⚠ ${url}：${e?.message ?? e}（已自动尝试下一源）`)
          // 失败的解压可能留下半成品，清场防污染下一个候选源的同名解压目录
          removeRecursive(join(tmp, 'extract'))
        }
      }
      if (!extractedRoot) {
        // override 模式下用户已在用 CHILL_SOURCE_URL，再提示是语义矛盾
        const hint = process.env.CHILL_SOURCE_URL ? '' : '\n可用 CHILL_SOURCE_URL 环境变量指定下载地址后重试。'
        return { ok: false, message: `源码下载失败：\n${errors.join('\n')}${hint}` }
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

  // ③就位门：走到构建前，磁盘事实必须是「可构建的 chill monorepo」——同时覆盖全新下载与
  // 复用两条路径（复用侧另有 cli.ts 复用门在提问层拦，此处为管线内兜底）。不通过=全清场，
  // 杜绝「空目录/脏残留被当源码 + pnpm 向上爬到无关 manifest 装了个寂寞」（2026-10-13 事故环 #6/#7）
  const probe = inspectProjectDir(projectDir)
  if (!probe.usable) {
    for (const piece of ['chill', 'chill-relay', 'chill-mobile', 'chill-guardian']) {
      const p = join(workspaceDir, piece)
      if (existsSync(p)) removeRecursive(p)
    }
    return {
      ok: false,
      message: '源码就位校验失败：workspace/chill 缺少 package.json 或 build:cli 脚本（不是可构建的 chill 源码）。已清场，可重新执行 /fetch-source。',
    }
  }
  // 版本对账（tag 模式硬拒）：/fetch-source 的契约=「你正在运行的版本的源码」，不符即失败。
  // override 模式跳过（用户显式指定 URL=显式意图，本地验证语义）
  if (version && probe.cliVersion && probe.cliVersion !== version) {
    for (const piece of ['chill', 'chill-relay', 'chill-mobile', 'chill-guardian']) {
      const p = join(workspaceDir, piece)
      if (existsSync(p)) removeRecursive(p)
    }
    return {
      ok: false,
      message: `归档版本 v${probe.cliVersion} 与当前运行的 chill v${version} 不符——请升级 npm 包后重试（npm i -g @assistant-ai/chill），或检查 tag 指针。已清场。`,
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
