// 桌面审计渲染端 shim：core DesktopAuditSink 接口的 Electron 实现。
// record 经 desktop:audit 单工 IPC 转发给主进程落盘（渲染进程无 fs）；
// core 侧接口合入后可直接 implements DesktopAuditSink，条目形状以 core 契约为准。

import { getHostAPI } from '../host/hostApi'

/** 审计条目形状（与 core IDesktopAudit.DesktopAuditEntry 契约逐字段对齐：coord 双记/batch 定位/审批四态） */
export interface DesktopAuditEntry {
  ts: string
  tool: string
  action: string
  desc: string
  purpose?: string
  coord?: { image: [number, number]; phys: [number, number] }
  approval: 'approved' | 'rejected' | 'session' | 'passive'
  ok: boolean
  error?: string
  batch?: { id: string; step: number; total: number }
  shot?: string
  [key: string]: unknown
}

export class ElectronDesktopAuditSink {
  record(entry: DesktopAuditEntry, imageDataUri?: string): void {
    try {
      getHostAPI().desktopAudit(entry, imageDataUri)
    } catch {
      // 审计失败静默——不得影响工具执行
    }
  }
}
