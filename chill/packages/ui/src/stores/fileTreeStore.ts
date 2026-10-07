import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { normalizePathForCompare } from '@assistant-ai/core'
import { getHostAPI } from '../host/hostApi'

/** 文件树条目（与 file:list-directory IPC 单层返回形状一致） */
export interface FileTreeEntry {
  id: string
  name: string
  path: string
  type: 'file' | 'directory'
  parentId: string | null
}

/**
 * 文件树懒加载数据层（「显示多少取多少，哪里变了刷哪里」）
 *
 * - 取数：单层按需——openRoot 取根层，toggleExpand 展开时取该层；已加载层缓存于 childrenOf。
 * - watch：集合制——syncWatchSet 把 [根, ...已展开目录] 推给主进程 file:watch-set（各 depth 0），
 *   展开/收起/级联清理后同步。
 * - 刷新：外部（Home 的 onFileChanged / 本层文件操作）按目录 invalidate 单层失效重取；
 *   'change' 内容事件不进这里。
 * - 键：所有路径键一律经 core normalizePathForCompare 归一（小写 + sep 后缀，防大小写/分隔符分叉）。
 * - 竞态：每层取数带代际令牌，响应落地时仍是当前代才写缓存（openRoot 换根/快速连点展开安全）。
 */
export const useFileTreeStore = defineStore('fileTree', () => {
  // State
  /** 当前根目录（归一化键；null = 未打开） */
  const rootPath = ref<string | null>(null)
  /** 已加载层缓存：归一化目录键 → 该层直接子项（IPC 原文，parentId=父目录原始路径） */
  const childrenOf = ref<Map<string, FileTreeEntry[]>>(new Map())
  /** 已展开目录（归一化键集合） */
  const expanded = ref<Set<string>>(new Set())
  /** 取数中的目录（归一化键集合） */
  const loadingDirs = ref<Set<string>>(new Set())
  /** 取数失败信息：归一化目录键 → 错误文案（重试经 invalidate） */
  const errorOf = ref<Map<string, string>>(new Map())
  /** 每层取数代际（非响应式）：递增作废旧层在途响应 */
  const generationOf = new Map<string, number>()

  const keyOf = (p: string): string => normalizePathForCompare(p)

  // Getters

  /** 渲染数据（FileTree 现状形状）：各层展平——根层条目 parentId 置 null（rootItems 过滤契约），
   *  其余层保留 IPC 返回的 parentId（= 父目录原始路径 = 父条目 id，children 过滤契约） */
  const files = computed<FileTreeEntry[]>(() => {
    const out: FileTreeEntry[] = []
    const rootKey = rootPath.value
    for (const [k, items] of childrenOf.value) {
      if (k === rootKey) {
        for (const item of items) out.push({ ...item, parentId: null })
      } else {
        out.push(...items)
      }
    }
    return out
  })

  // Actions

  /** watch 集合同步：范围 = 根 + 已展开目录（归一化键即 watch 路径，主进程按集合 diff 增删） */
  function syncWatchSet(): void {
    const paths = rootPath.value ? [rootPath.value, ...expanded.value] : [...expanded.value]
    void getHostAPI().fileWatchSet(paths)
  }

  /** 死路径级联清理：某路径被删/改名（或父层刷新后子项消失）时，
   *  以其为前缀的层缓存/展开/加载/错误条目全清并同步 watch 集合 */
  function prunePath(dirPath: string): void {
    const prefix = keyOf(dirPath)
    const isUnder = (k: string) => k === prefix || k.startsWith(prefix)
    for (const k of [...childrenOf.value.keys()].filter(isUnder)) childrenOf.value.delete(k)
    for (const k of [...expanded.value].filter(isUnder)) expanded.value.delete(k)
    for (const k of [...loadingDirs.value].filter(isUnder)) loadingDirs.value.delete(k)
    for (const k of [...errorOf.value.keys()].filter(isUnder)) errorOf.value.delete(k)
    for (const k of [...generationOf.keys()].filter(isUnder)) generationOf.delete(k)
    syncWatchSet()
  }

  /** 取单层（内部）：代际令牌防过期响应落地；成功后对消失的旧子目录做级联清理 */
  async function fetchLayer(dirPath: string): Promise<void> {
    const k = keyOf(dirPath)
    const gen = (generationOf.get(k) ?? 0) + 1
    generationOf.set(k, gen)
    loadingDirs.value.add(k)
    errorOf.value.delete(k)
    try {
      const res = await getHostAPI().fileListDirectory(dirPath)
      if (generationOf.get(k) !== gen) return // 已有更新一代的取数，过期响应丢弃
      if (res.success && res.files) {
        // 父层刷新后子项消失（删除/改名）→ 死路径级联清理
        const oldItems = childrenOf.value.get(k)
        if (oldItems) {
          const freshDirs = new Set(
            res.files.filter(f => f.type === 'directory').map(f => keyOf(f.path))
          )
          for (const old of oldItems) {
            if (old.type === 'directory' && !freshDirs.has(keyOf(old.path))) {
              prunePath(old.path)
            }
          }
        }
        childrenOf.value.set(k, res.files)
      } else {
        childrenOf.value.delete(k)
        errorOf.value.set(k, res.error || '无法访问')
      }
    } catch (err) {
      if (generationOf.get(k) !== gen) return
      childrenOf.value.delete(k)
      errorOf.value.set(k, err instanceof Error ? err.message : String(err))
    } finally {
      if (generationOf.get(k) === gen) loadingDirs.value.delete(k)
    }
  }

  /** 打开根目录：清空全部树状态（换根），先同步 watch 集合再取根层（消竞态顺序） */
  async function openRoot(dirPath: string): Promise<void> {
    rootPath.value = keyOf(dirPath)
    expanded.value.clear()
    childrenOf.value.clear()
    loadingDirs.value.clear()
    errorOf.value.clear()
    generationOf.clear() // 旧树在途响应因代际失配被丢弃
    syncWatchSet()
    await fetchLayer(dirPath)
  }

  /** 重挂刷新（根未变）：展开状态保留，只重取根 + 已展开的少数几层（真相源=磁盘） */
  async function refreshExpanded(): Promise<void> {
    syncWatchSet()
    const dirs = [rootPath.value, ...expanded.value].filter((d): d is string => !!d)
    await Promise.all(dirs.map((d) => invalidate(d)))
  }

  /** 展开/收起：展开时先同步 watch 集合再取该层（取数期间的变更不丢事件）；
   *  收起不取数（缓存保留），只移出展开集合并同步 watch 集合 */
  async function toggleExpand(dirPath: string): Promise<void> {
    const k = keyOf(dirPath)
    if (expanded.value.has(k)) {
      expanded.value.delete(k)
      syncWatchSet()
      return
    }
    expanded.value.add(k)
    syncWatchSet()
    if (!childrenOf.value.has(k) && !loadingDirs.value.has(k)) {
      await fetchLayer(dirPath)
    }
  }

  /** 单层失效（结构性变更：add/addDir/unlink/unlinkDir 与本地文件操作；'change' 类不会进来）：
   *  清该层缓存与错误、递增代际作废旧响应；该层在展开中（或是根）则重取 */
  async function invalidate(dirPath: string): Promise<void> {
    const k = keyOf(dirPath)
    childrenOf.value.delete(k)
    errorOf.value.delete(k)
    loadingDirs.value.delete(k)
    generationOf.set(k, (generationOf.get(k) ?? 0) + 1)
    if (k === rootPath.value || expanded.value.has(k)) {
      await fetchLayer(dirPath)
    }
  }

  return {
    // State
    rootPath,
    childrenOf,
    expanded,
    loadingDirs,
    errorOf,
    // Getters
    files,
    // Actions
    keyOf,
    openRoot,
    refreshExpanded,
    toggleExpand,
    invalidate,
    prunePath,
    syncWatchSet
  }
})
