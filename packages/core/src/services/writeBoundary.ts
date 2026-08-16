/**
 * 会话可写根与写边界判定（统一写边界模型）
 *
 * 边界目录集合 = 会话工作目录（fsProvider.getCurrentDirectory() 动态读取）
 *              + /add-dir 加入的目录（进程内存，会话结束失效）
 *              + workcopy/chill-archive 白名单（与 checkSourceRootGuard 同款计算：自迭代落在圈内）。
 *
 * 判定语义：isWithinWriteBoundary = 规范化后位于集合任一目录的递归内；
 * 符号链接双路径判定（realpath：链接本身与解析目标任一在界外即圈外）；
 * workDir 缺失（空集合）时按最保守处理——一切写视为圈外。
 * 规范化复用 guard 样板（normalize + sep 后缀 + 小写 + startsWith，防 ../ 逃逸与 Windows 大小写）。
 *
 * 写入模式状态（readonly / fullAccess）由 builtInToolExecutor 的 setters 同步进本单例，
 * 供 write-boundary 注入器与 wrapSubtaskPrompt 读取（单一事实源）。
 */

import * as path from 'path'
import * as fs from 'fs'
import type { IFileSystemProvider } from '../interfaces/IFileSystemProvider'

/** 规范化比较形式：normalize + sep 后缀 + 小写（guard 样板，防 ../ 逃逸与 Windows 大小写） */
export function normalizePathForCompare(p: string): string {
  return (path.normalize(p) + path.sep).toLowerCase()
}

/** 目录校验：存在且为目录 + realpath 规范化（绑定文件夹/可写根共用的入口校验，不静默接受无效目录） */
export function validateDirectory(inputPath: string): { success: boolean; path?: string; error?: string } {
  if (!inputPath?.trim()) {
    return { success: false, error: '路径为空' }
  }
  let real: string
  try {
    real = fs.realpathSync.native(inputPath)
    if (!fs.statSync(real).isDirectory()) {
      return { success: false, error: `不是目录: ${inputPath}` }
    }
  } catch {
    return { success: false, error: `目录不存在或不可访问: ${inputPath}` }
  }
  return { success: true, path: real }
}

export class WriteBoundary {
  private fsProvider: IFileSystemProvider | null = null
  /** workcopy 白名单计算基准（chill 源码根；同 checkSourceRootGuard） */
  private sourceRoot: string | null = null
  /** /add-dir 加入的会话可写根（realpath 规范化后） */
  private extraRoots: string[] = []
  /** 写入模式状态（-p readonly） */
  private readonlyMode = false
  /** 写入模式状态（autoApply on，含 -p --auto） */
  private fullAccessMode = false

  /** 注入 fsProvider 与源码根（builtInToolExecutor 构造时配置；重复配置后者覆盖） */
  configure(options: { fsProvider?: IFileSystemProvider | null; sourceRoot?: string | null }): void {
    if (options.fsProvider !== undefined) {
      this.fsProvider = options.fsProvider
    }
    if (options.sourceRoot !== undefined) {
      this.sourceRoot = options.sourceRoot
    }
  }

  /** 写入模式状态同步（builtInToolExecutor 的 setAutoApply/setNonInteractiveMode 调用） */
  setModeState(state: { readonly?: boolean; fullAccess?: boolean }): void {
    if (state.readonly !== undefined) {
      this.readonlyMode = state.readonly
    }
    if (state.fullAccess !== undefined) {
      this.fullAccessMode = state.fullAccess
    }
  }

  isReadonlyMode(): boolean {
    return this.readonlyMode
  }

  isFullAccess(): boolean {
    return this.fullAccessMode
  }

  /**
   * /add-dir：把目录加入本次会话的可写根集合（进程内存，会话结束失效）。
   * 校验存在且为目录 + realpath 规范化（不静默加入无效边界根）。
   */
  addWritableRoot(inputPath: string): { success: boolean; path?: string; error?: string } {
    const result = validateDirectory(inputPath)
    if (!result.success) {
      return result
    }
    const real = result.path!
    if (!this.extraRoots.includes(real)) {
      this.extraRoots.push(real)
    }
    return { success: true, path: real }
  }

  /** 当前边界目录集合：工作目录（动态）+ add-dir 目录 + workcopy 白名单 */
  listWritableRoots(): string[] {
    const roots: string[] = []
    // 会话工作目录（动态读取：切换工作目录即跟随）
    const workDir = this.fsProvider?.getCurrentDirectory?.()
    if (workDir) {
      roots.push(workDir)
    }
    // /add-dir 加入的会话可写根
    roots.push(...this.extraRoots)
    // workcopy 与 chill-archive 白名单（同级与源码目录内两种可能，同款计算：
    // workcopy = 自迭代代码副本；chill-archive = 自迭代档案库，两者都落在圈内）
    if (this.sourceRoot) {
      roots.push(path.resolve(this.sourceRoot, '..', 'chill-workcopy'))
      roots.push(path.join(this.sourceRoot, 'chill-workcopy'))
      roots.push(path.resolve(this.sourceRoot, '..', 'chill-archive'))
      roots.push(path.join(this.sourceRoot, 'chill-archive'))
    }
    return roots
  }

  /**
   * 边界判定：resolvedPath 是否位于边界目录集合内。
   * 双路径判定：链接本身与 realpath 目标任一在界外即圈外（防界内 symlink 穿透）；
   * 空边界集合（无 workDir）= 圈外（最保守）。
   */
  isWithinWriteBoundary(resolvedPath: string): boolean {
    if (!resolvedPath) return false
    const roots = this.listWritableRoots()
    if (roots.length === 0) return false
    // 链接本身在界外 → 圈外
    if (!this.isUnderAnyRoot(resolvedPath, roots)) return false
    // realpath 目标在界外同样视为圈外
    const real = this.tryRealpath(resolvedPath)
    if (real && !this.isUnderAnyRoot(real, roots)) return false
    return true
  }

  /** 规范化前缀判定（guard 样板：normalize + sep 后缀 + 小写 + startsWith） */
  private isUnderAnyRoot(target: string, roots: string[]): boolean {
    const normalizedTarget = normalizePathForCompare(target)
    return roots.some((root) => normalizedTarget.startsWith(normalizePathForCompare(root)))
  }

  /**
   * realpath 解析：不存在的路径回退到最近存在的祖先再拼接尾部（create_file 目标尚不存在）；
   * fs 不可用（渲染进程）或解析失败返回 null（跳过 realpath 判定）。
   */
  private tryRealpath(target: string): string | null {
    try {
      let current = target
      const tail: string[] = []
      for (;;) {
        try {
          const real = fs.realpathSync.native(current)
          return tail.length > 0 ? path.join(real, ...tail) : real
        } catch {
          const parent = path.dirname(current)
          if (parent === current) return null
          tail.unshift(path.basename(current))
          current = parent
        }
      }
    } catch {
      return null
    }
  }
}

/**
 * 写边界提示文本（write-boundary 注入器与 wrapSubtaskPrompt 共用的纯函数）。
 * 状态分支：readonly（写本被拦截）/ fullAccess（全量直通）/ 默认（圈内直通+圈外审批）。
 */
export function buildWriteBoundaryPrompt(
  roots: string[],
  options?: { readonly?: boolean; fullAccess?: boolean },
): string {
  if (options?.readonly) {
    return '## 写边界\n当前为只读模式：写操作会被系统拦截，不要尝试写文件；如需修改请向用户说明。'
  }
  if (options?.fullAccess) {
    return '## 写边界\n当前为全量直接写模式（autoApply 开启）：写操作不触发审批、直接落盘。'
  }
  const list =
    roots.length > 0 ? roots.map((r) => `- ${r}`).join('\n') : '（空——当前任何写入都视为圈外）'
  return [
    '## 写边界',
    '当前可写范围（边界目录集合）：',
    list,
    '规则：圈内可直接写；圈外会触发用户审批（批准才执行）。需要写圈外时提前告知用户，或建议用户使用 /add-dir 加入目录；审批被拒绝后，向用户报告并等待指示，不要静默重试同一操作。',
  ].join('\n')
}

/**
 * 全局写边界单例
 */
let globalWriteBoundary: WriteBoundary | null = null

export function getWriteBoundary(): WriteBoundary {
  if (!globalWriteBoundary) {
    globalWriteBoundary = new WriteBoundary()
  }
  return globalWriteBoundary
}

/** 重置全局写边界（主要用于测试） */
export function resetWriteBoundary(): void {
  globalWriteBoundary = null
}
