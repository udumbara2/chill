import { SessionBoardService, setSessionBoardService, getSessionBoardService, wireBoardAskBridge } from '@assistant-ai/core'
import { ElectronIPCBoardStore } from '../adapters/ElectronIPCBoardStore'

/**
 * 会话级共享看板服务的 UI 装配（与 CLI CliContext 同语义）：
 * boardId=sessionId；内存为真相 + 快照经 board:* IPC 落主进程 ~/.chill/boards。
 * 幂等（main.ts 启动调用）；未装配时 relay/板工具显式降级的语义保留给真未装配场景。
 */
export function initSessionBoardService(): SessionBoardService {
  const existing = getSessionBoardService()
  if (existing) return existing
  const svc = new SessionBoardService(new ElectronIPCBoardStore())
  setSessionBoardService(svc)
  wireBoardAskBridge() // V3.2 ask↔条目联动
  return svc
}
