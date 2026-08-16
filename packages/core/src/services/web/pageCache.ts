/**
 * 网页内容快照缓存：TTL 15 分钟 + LRU 上限 20 条。
 * 纯内存实现（无 fs 依赖，CLI / 宿主 / 渲染进程三端同码），
 * 供 web_fetch 截断续读时直接切片，避免对同一 URL 重复抓取。
 * URL 即网页的持久句柄：缓存过期后重新 fetch 即可恢复快照，无需磁盘持久化。
 */

interface CacheEntry {
  content: string
  fetchedAt: number
}

const TTL_MS = 15 * 60 * 1000
const MAX_ENTRIES = 20

// Map 迭代序即插入序：命中时重插到末尾，首个键即为最久未使用条目
const cache = new Map<string, CacheEntry>()

/** 读取缓存快照；未命中或已过期（TTL 15 分钟）返回 undefined */
export function getCachedPage(url: string): string | undefined {
  const entry = cache.get(url)
  if (!entry) {
    return undefined
  }
  if (Date.now() - entry.fetchedAt > TTL_MS) {
    cache.delete(url)
    return undefined
  }
  // 命中后重插到末尾，刷新为最近使用
  cache.delete(url)
  cache.set(url, entry)
  return entry.content
}

/** 写入缓存快照；超出 LRU 上限（20 条）时淘汰最久未使用的条目 */
export function setCachedPage(url: string, content: string): void {
  cache.delete(url)
  cache.set(url, { content, fetchedAt: Date.now() })
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) {
      break
    }
    cache.delete(oldest)
  }
}
