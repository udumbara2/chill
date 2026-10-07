import type { SessionBoardStore, BoardState } from '@assistant-ai/core'
import { getHostAPI } from '../host/hostApi'

/**
 * 会话看板快照存取（core SessionBoardStore 的渲染进程实现）：
 * 渲染进程 fs 是空 shim，经 board:* IPC 桥到主进程 BoardStore（照 hooks:mtime 注入先例）；
 * 主进程落盘 ~/.chill/boards/<boardId>.json（tmp+rename 原子写在 BoardStore 内）。
 * 未接线主进程 handler 时调用会拒——SessionBoardService 按"快照读失败降级新板/写失败仅告警"消化，
 * 内存为真相不受影响（与 CLI 的 Node BoardStore 同语义，只是 fs 在主进程）。
 */
export class ElectronIPCBoardStore implements SessionBoardStore {
  async load(boardId: string): Promise<BoardState | undefined> {
    return (await getHostAPI().boardLoad(boardId)) as BoardState | undefined
  }

  async save(state: BoardState): Promise<void> {
    await getHostAPI().boardSave(state)
  }

  async exists(boardId: string): Promise<boolean> {
    return (await getHostAPI().boardExists(boardId)) === true
  }

  async archiveBoard(boardId: string, reason: string): Promise<BoardState> {
    return (await getHostAPI().boardArchive(boardId, reason)) as BoardState
  }
}
