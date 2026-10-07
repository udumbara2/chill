/**
 * 会话搜索（结构化结果，供 UI 会话列表搜索框使用）。
 *
 * 检索语义（索引对账/分词/AND 匹配/片段定位/预过滤）全部复用 sessionIndex.ts 原语——
 * 与模型侧 search_sessions 工具同一事实源，严禁壳侧重写匹配逻辑。
 * 差异仅在产出形态：模型侧拼文本（含大小提示/精读指引），本模块返回结构化命中供 UI 渲染。
 */

import * as fs from 'fs'
import * as path from 'path'
import {
  ensureIndex,
  saveIndexAtomic,
  tokenizeQuery,
  allTokensHit,
  locateSnippet,
  rawPrefilterSafe,
  rawContainsAllTokens,
  textOf,
} from './sessionIndex'
import type { SessionSummary } from '../persistence/SessionPersistence'

export interface SessionSearchHit {
  id: string
  title: string
  updatedAt: string
  /** 标题命中 / 正文命中（正文命中时 snippet 为首个命中消息的片段） */
  matchKind: 'title' | 'content'
  snippet: string
}

/**
 * 会话列表元数据通道（UI 侧边栏数据源）：旁路索引惰性对账后按 updatedAt 降序返回
 * SessionSummary 数组。无变化时零 parse（仅 readdir+stat）；dirty 时原子写回索引
 * （与 searchSessionRecords 同款，否则索引不落地、每次展开都重 parse 漂移文件）。
 * 依赖 fs，只能从 core Node 全量入口导出（严禁进 index.renderer.ts）。
 */
export async function listSessionSummaries(sessionsDir: string): Promise<SessionSummary[]> {
  const { entries, dirty } = ensureIndex(sessionsDir)
  if (dirty) saveIndexAtomic(sessionsDir, entries)
  return entries.map(e => ({
    id: e.id,
    title: e.title,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    titleSource: e.titleSource,
    projectId: e.projectId,
    workdir: e.workdir,
  }))
}

/**
 * 搜索会话（标题 + 正文，多词元 AND、顺序无关），按索引顺序（更新时间降序）返回前 limit 条。
 * query 仅含空白时返回空数组（列表态由调用方自己渲染）。
 */
export function searchSessionRecords(sessionsDir: string, query: string, limit = 50): SessionSearchHit[] {
  const tokens = tokenizeQuery(query)
  if (tokens.length === 0) return []

  // 惰性索引对账：stat 双指纹增量 parse，dirty 时原子写回（同 search_sessions 工具）
  const { entries, dirty } = ensureIndex(sessionsDir)
  if (dirty) saveIndexAtomic(sessionsDir, entries)

  const prefilterUsable = rawPrefilterSafe(tokens)
  const hits: SessionSearchHit[] = []
  for (const entry of entries) {
    if (hits.length >= limit) break

    if (allTokensHit(entry.title, tokens)) {
      hits.push({ id: entry.id, title: entry.title, updatedAt: entry.updatedAt, matchKind: 'title', snippet: entry.preview })
      continue
    }

    // 正文检索：原文预过滤（不含任一词元 → 整文件跳过不 parse）→ parse 后逐消息 AND 匹配
    let raw: string
    try {
      raw = fs.readFileSync(path.join(sessionsDir, `${entry.id}.json`), 'utf-8')
    } catch { continue }
    if (prefilterUsable && !rawContainsAllTokens(raw, tokens)) continue
    let record: any
    try {
      record = JSON.parse(raw)
    } catch { continue }
    if (!Array.isArray(record?.messages)) continue
    for (const msg of record.messages) {
      const text = textOf(msg.content)
      if (text && allTokensHit(text, tokens)) {
        hits.push({
          id: entry.id,
          title: entry.title,
          updatedAt: entry.updatedAt,
          matchKind: 'content',
          snippet: locateSnippet(text, tokens),
        })
        break // 每个会话只取首个命中
      }
    }
  }
  return hits
}
