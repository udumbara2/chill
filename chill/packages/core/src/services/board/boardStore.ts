/**
 * 共享看板 · 落盘快照
 *
 * 事实源路径:`~/.chill/boards/<boardId>.json`(boardId=sessionId;团队板=runId)。
 * 纪律:tmp+rename 原子写(照 TeamRuntimeService.persist / team-runs 先例);
 *   内存为真相、文件为快照;结清快照保留——save 不因结清删除文件;
 *   archiveBoard=会话删除语义:在途条目全部 cancelItem 留痕后落盘归档标记。
 * 本文件允许 Node(fs/promises)。
 */

import { mkdir, rename, readFile, writeFile, access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { cancelItem } from './boardCore'
import { BoardError, type BoardState, type BoardItemStatus } from './boardTypes'

const IN_FLIGHT: ReadonlySet<BoardItemStatus> = new Set<BoardItemStatus>(['pending', 'in_progress', 'blocked', 'failed'])

/** boardId 进文件名:Windows 非法字符响亮拒绝(防路径穿插/写炸) */
function assertSafeBoardId(boardId: string): void {
  if (!boardId || /[\\/:*?"<>|]/.test(boardId)) {
    throw new BoardError('INVALID_INPUT', `boardId "${boardId}" 含文件系统非法字符(\\/:*?"<>|),请更换后再试`)
  }
}

/**
 * 看板快照存储端口(SessionBoardService 注入;BoardStore 为 Node 实现,UI 可换 IPC 实现)
 */
export interface SessionBoardStore {
  load(boardId: string): Promise<BoardState | undefined>
  save(state: BoardState): Promise<void>
  exists(boardId: string): Promise<boolean>
  archiveBoard(boardId: string, reason: string): Promise<BoardState>
}

/**
 * 损坏错误判别(唯一事实点):code 命中或消息前缀命中均可——后者保 electron IPC 序列化存活
 * (ipcMain.handle 的 rejection 克隆只保 message,自定义属性丢失;渲染进程经 ElectronIPCBoardStore
 * 收到的损坏错误只剩 message,前缀 `看板快照损坏` 是跨进程仍可判别的键)。
 */
export function isCorruptSnapshotError(err: unknown): boolean {
  if (err instanceof BoardError) return err.code === 'SNAPSHOT_CORRUPT'
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('看板快照损坏')
}

export class BoardStore implements SessionBoardStore {
  private baseDir: string

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(homedir(), '.chill', 'boards')
  }

  private pathOf(boardId: string): string {
    assertSafeBoardId(boardId)
    return join(this.baseDir, `${boardId}.json`)
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true })
  }

  /**
   * 读快照;文件不存在(ENOENT)返回 undefined;**其他 IO 错误上抛**(不得当"没有板"新建覆盖好文件——
   * Windows 杀软/索引短暂锁文件是真实场景,2026-10-07 根治);快照损坏→先隔离留证再抛 SNAPSHOT_CORRUPT。
   */
  async load(boardId: string): Promise<BoardState | undefined> {
    const path = this.pathOf(boardId)
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT') return undefined
      throw err
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw await this.quarantineAndThrow(path, `看板快照损坏(非合法 JSON):${path}`)
    }
    const state = parsed as BoardState
    if (!state || typeof state !== 'object' || !Array.isArray(state.items)) {
      throw await this.quarantineAndThrow(path, `看板快照损坏(结构不符):${path}`)
    }
    return state
  }

  /** 损坏隔离:rename 留证(恢复优先于留证——隔离失败仅告警不阻断),然后抛 typed 损坏错误 */
  private async quarantineAndThrow(path: string, message: string): Promise<never> {
    const corpse = `${path}.corrupt-${Date.now()}`
    try {
      await rename(path, corpse)
    } catch (err) {
      console.warn(`【看板】损坏快照隔离失败(继续按新板恢复,尸体未留):`, err)
    }
    throw new BoardError('SNAPSHOT_CORRUPT', message)
  }

  async exists(boardId: string): Promise<boolean> {
    const path = this.pathOf(boardId)
    try {
      await access(path)
      return true
    } catch {
      return false
    }
  }

  /** 落盘(tmp+rename 原子写;永不让删除文件——结清快照保留)。
   *  tmp 名含 pid+时刻:并发写者(serve+桌面 UI 双进程共写同一 ~/.chill/boards)各写各的临时件——
   *  固定 tmp 名同路径互踩会把撕裂内容 rename 成正式文件(2026-10-06 切版混乱实测事故的撕裂机制) */
  async save(state: BoardState): Promise<void> {
    const path = this.pathOf(state.boardId)
    await this.ensureDir()
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
    await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
    await rename(tmp, path)
  }

  /**
   * 归档=会话删除语义:在途条目(pending/in_progress/blocked/failed)全部 cancelItem 留痕,
   * 再写 archivedAt/archiveReason 归档标记并落盘;已完成条目原样保留,文件不删。
   */
  async archiveBoard(boardId: string, reason: string): Promise<BoardState> {
    const existing = await this.load(boardId)
    if (!existing) {
      throw new BoardError('ITEM_NOT_FOUND', `看板 ${boardId} 不存在,无法归档`)
    }
    let state = existing
    for (const item of [...state.items]) {
      if (!IN_FLIGHT.has(item.status)) continue
      const res = cancelItem(state, item.id, { by: 'system', reason: `看板归档:${reason}` })
      state = res.state
    }
    const now = Date.now()
    state = {
      ...state,
      archivedAt: now,
      archiveReason: reason,
      revision: state.revision + 1,
      updatedAt: now,
    }
    await this.save(state)
    return state
  }
}
