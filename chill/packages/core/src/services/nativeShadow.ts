/**
 * 原生模块影子加载判定（.NET Shadow Copy 同款解法的判定层）。
 *
 * 问题：Windows 对加载中的 .node 映像文件终身禁删——任何从安装树/workcopy
 * 加载原生模块的进程都会把该目录锁死，版本切换后的 workcopy/旧版本目录清理必撞 EPERM。
 * 解法：加载前把 .node 复制到安装树外的影子目录（~/.chill/native-shadow/），
 * 进程锁的是影子，原件所在树永远可删。
 *
 * 本模块只做判定（唯一事实点，仿 textMatcher 先例）：候选挑选 / 内容标签 /
 * 影子命名 / 过期清单。fs 接线（复制/require）归壳适配器
 * （CLI adapters/NativeDesktopController.ensureLoaded）。
 *
 * 纯函数、Node-free。
 */

/**
 * 从目录文件清单中挑选原生绑定文件名。
 * 匹配 `^<baseName>\..+\.node$`（napi 预构建命名：<baseName>.<platform>-<arch>[-msvc].node）；
 * 多份时优先文件名含 `${platform}-${arch}` 者，仍多份取排序后第一份（确定性）。
 */
export function pickNativeFile(fileNames: string[], baseName: string, platform: string, arch: string): string | null {
  const re = new RegExp(`^${escapeRegExp(baseName)}\\..+\\.node$`)
  const candidates = fileNames.filter((n) => re.test(n))
  if (candidates.length === 0) return null
  const platArch = `${platform}-${arch}`
  const preferred = candidates.filter((n) => n.includes(platArch))
  const pool = preferred.length > 0 ? preferred : candidates
  return pool.sort()[0]
}

/**
 * 影子内容标签：`${size}-${mtimeMs}`。
 * stat 零读成本；重建必变 mtime；同构建的多版本目录共享同一影子=天然去重
 * （robocopy 保 mtime，版本目录间同构建原件标签一致）。
 */
export function computeShadowTag(stat: { size: number; mtimeMs: number }): string {
  return `${stat.size}-${stat.mtimeMs}`
}

/** 影子文件名：`<original>.<tag>`（与原件同名不同目录 → 标签挂在文件名上） */
export function shadowFileName(original: string, tag: string): string {
  return `${original}.${tag}`
}

/**
 * 过期影子清单：existing 中属于 original 名下（`<original>.*`）但非当前标签影子的文件。
 * 覆盖旧标签影子与原子复制的临时残留（`<original>.<tag>.tmp-<pid>`）。
 */
export function staleShadowNames(existing: string[], original: string, currentTag: string): string[] {
  const prefix = `${original}.`
  const current = shadowFileName(original, currentTag)
  return existing.filter((n) => n.startsWith(prefix) && n !== current)
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
