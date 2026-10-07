import * as fs from 'fs'
import * as path from 'path'

/**
 * 项目路径锚点解析（全库唯一事实来源）
 *
 * 模式判定（npm / 源代码）只依赖一个客观事实：本模块的物理位置。
 * 不读环境变量、不依赖启动器注入——意图层输入与事实可能漂移，曾是事故根因。
 *
 * API 两分：
 * - locateSourceRoot(startDir)  纯函数：从给定位置向上定位 chill 源码根（也是测试注入缝）
 * - getOwnProjectPaths()        memoized 自绑定：本进程代码所属源码树（进程内不变量）
 *
 * Shadow Copy 布局下 chill 是 junction，模块位置 realpath 到 chill-versions/vX/ 内；
 * 命中该布局时反推 junction 路径作为稳定身份，但仅当 junction 通过同一性校验
 * （realpath 指向本树且本身是 chill 项目），否则诚实上报版本目录本身。
 */

export interface ProjectPaths {
  /** chill 项目路径（junction 布局下为 junction 路径，如 <父目录>/chill）；npm 模式（无源码环境）为 null */
  projectPath: string | null
  /** 项目父目录（chill-workcopy、chill-guardian、chill-versions、chill-archive 所在目录）；npm 模式为 process.cwd() */
  parentDir: string
}

export const VERSIONS_DIR_NAME = 'chill-versions'
export const PROJECT_DIR_NAME = 'chill'

/** 校验目录是否为 chill 项目根（防误判：用户把 CLI 装进自己的 pnpm monorepo 时会命中其 workspace 文件） */
function isChillProjectRoot(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.self.md')) && fs.existsSync(path.join(dir, 'packages', 'cli'))
}

/** npm 模式形态：无源码环境，自迭代功能降级 */
function npmModePaths(): ProjectPaths {
  return { projectPath: null, parentDir: process.cwd() }
}

function realpathOrSelf(p: string): string {
  try { return fs.realpathSync(p) } catch { return p }
}

/** Windows 路径不区分大小写，统一转小写比较 */
function samePath(a: string, b: string): boolean {
  const na = path.normalize(a)
  const nb = path.normalize(b)
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb
}

/**
 * 本模块所在目录（不用 import.meta：core 的 CJS 编译器视其为语法错误，
 * 与 resolveTsxPath 同一规避约定）
 * - CJS（electron 主进程、core cjs 产物）：__dirname 全局可用
 * - ESM bundle（esbuild 横幅注入 createRequire）：require.resolve 解析回 core 包位置
 * - 其余 ESM（未打包产物、测试探针）：入口文件 realpath（单入口 CLI 与入口同树）
 */
function getOwnModuleDir(): string {
  if (typeof __dirname !== 'undefined') return realpathOrSelf(__dirname)
  if (typeof require !== 'undefined' && typeof require.resolve === 'function') {
    try {
      return realpathOrSelf(path.dirname(require.resolve('@assistant-ai/core')))
    } catch { /* 解析失败则走入口兜底 */ }
  }
  if (process.argv[1]) return realpathOrSelf(path.dirname(path.resolve(process.argv[1])))
  return process.cwd()
}

/**
 * 纯函数：从 startDir 向上定位 chill 源码根（含 chill-versions/vX → junction 反推）；
 * 找不到 workspace、或命中的不是 chill 项目时按 npm 模式返回
 */
export function locateSourceRoot(startDir: string): ProjectPaths {
  let dir = path.resolve(startDir)
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      // 落在 chill-versions/vX/ 内：junction 通过同一性校验才报 junction 身份，防指向他版错认
      const versionsDir = path.dirname(dir)
      if (path.basename(versionsDir) === VERSIONS_DIR_NAME) {
        const junctionPath = path.join(path.dirname(versionsDir), PROJECT_DIR_NAME)
        if (isChillProjectRoot(junctionPath) && samePath(realpathOrSelf(junctionPath), realpathOrSelf(dir))) {
          return { projectPath: junctionPath, parentDir: path.dirname(junctionPath) }
        }
      }
      // 非 chill 项目（如用户自己的 pnpm monorepo）按 npm 模式处理
      if (!isChillProjectRoot(dir)) {
        return npmModePaths()
      }
      return { projectPath: dir, parentDir: path.dirname(dir) }
    }
    dir = path.dirname(dir)
  }
  return npmModePaths()
}

let ownPathsCache: ProjectPaths | null = null

/**
 * 本进程代码所属源码树（memoized）。
 * 进程生命周期内"代码属于哪棵树"是不变量：freeze/switch 重指向 junction 不改变已加载代码的
 * 物理位置，缓存因此不仅安全，且语义上比重复探测更一致。
 */
export function getOwnProjectPaths(): ProjectPaths {
  if (ownPathsCache === null) {
    ownPathsCache = locateSourceRoot(getOwnModuleDir())
  }
  return ownPathsCache
}
