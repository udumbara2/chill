/**
 * workPlanMirrorStore.ts — 工作计划镜像+rev 的落盘快照（根治 serve 重启双丢）。
 *
 * 根因（2026-10-05 实证）：workPlanMirror/workPlanRevs 为进程内存 Map，serve 重启双丢 →
 * ①推：TASK_STATUS_UPDATED 在空镜像按 id 更新 miss，不建条目不推送；
 * ②拉：sync 应答 rev=0 被手机 LWW 拒收 → 手机永远显示重启前旧树。
 * 本模块把镜像+rev 持久化：装配时恢复、bump 防抖同窗落盘——重启后系统状态对手机不可区分。
 *
 * 纪律：tmp+rename 原子写（照 boardStore 先例）；内存为真相、文件为快照；
 *   读降级=空镜像（"中途启动边界"现状）；写降级=静默跳过（内存态现状）——
 *   所有错误路径退化为修复前行为，无新增失败模式。
 * 本文件允许 Node（fs/promises、os、homedir）。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { TaskItem } from '../../types/models'

export interface WorkPlanMirrorSnapshot {
  version: 1
  sessions: Record<string, { tasks: TaskItem[]; rev: number }>
}

export class WorkPlanMirrorStore {
  private readonly filePath: string

  constructor(baseDir?: string) {
    this.filePath = join(baseDir ?? homedir(), '.chill', 'workplan-mirror.json')
  }

  /** 读快照恢复（不存在/损坏/结构不符 → 空 Map 降级："中途启动边界"现状；坏键单个跳过，不炸装配） */
  async load(): Promise<{ tasks: Map<string, TaskItem[]>; revs: Map<string, number> }> {
    const tasks = new Map<string, TaskItem[]>()
    const revs = new Map<string, number>()
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch {
      return { tasks, revs } // 不存在=首启
    }
    try {
      const parsed = JSON.parse(raw) as WorkPlanMirrorSnapshot
      if (!parsed || typeof parsed !== 'object' || typeof parsed.sessions !== 'object' || parsed.sessions === null) {
        return { tasks, revs } // 结构不符=损坏降级
      }
      for (const [sid, entry] of Object.entries(parsed.sessions)) {
        if (!entry || !Array.isArray(entry.tasks) || typeof entry.rev !== 'number') continue
        tasks.set(sid, entry.tasks)
        revs.set(sid, entry.rev)
      }
    } catch {
      /* JSON 损坏=降级空（不炸装配） */
    }
    return { tasks, revs }
  }

  /** 落盘快照（tmp+rename 原子写；失败静默——内存态现状，下一次 bump 再试） */
  async save(tasks: ReadonlyMap<string, TaskItem[]>, revs: ReadonlyMap<string, number>): Promise<void> {
    const sessions: WorkPlanMirrorSnapshot['sessions'] = {}
    for (const [sid, list] of tasks) {
      sessions[sid] = { tasks: list, rev: revs.get(sid) ?? 0 }
    }
    // rev 有而镜像无的键（BOARD_CHANGED 只 bump rev 的会话）同样保留——rev 连续性不丢
    for (const [sid, rev] of revs) {
      if (!(sid in sessions)) sessions[sid] = { tasks: [], rev }
    }
    const snapshot: WorkPlanMirrorSnapshot = { version: 1, sessions }
    try {
      await mkdir(dirname(this.filePath), { recursive: true })
      const tmp = `${this.filePath}.tmp-${process.pid}`
      await writeFile(tmp, JSON.stringify(snapshot), 'utf8')
      await rename(tmp, this.filePath)
    } catch {
      /* 写失败静默：内存态现状，下一 bump 再试 */
    }
  }
}

/** 单例（懒构造真 store；测试经 setWorkPlanMirrorStoreForTest 注入临时目录 store——照 SessionBoardService 先例） */
let instance: WorkPlanMirrorStore | null = null

export function getWorkPlanMirrorStore(): WorkPlanMirrorStore {
  if (!instance) instance = new WorkPlanMirrorStore()
  return instance
}

/** 测试专用：注入临时目录 store（生产永不调用——照 setSessionBoardService 先例） */
export function setWorkPlanMirrorStoreForTest(store: WorkPlanMirrorStore | null): void {
  instance = store
}
