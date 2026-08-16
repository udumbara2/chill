/**
 * 目标文档持久化（~/.chill/goals/，对照 plans 目录模式）
 *
 * current-goal.md 是目标模式的工作文档：frontmatter 存运行计数（status/roundCount/
 * noProgressCount/maxRounds/createdAt），正文存目标与完成判据。
 * 达成时归档为 goal-<时间戳>.md 并清除 current-goal.md；放弃/会话切换只清除不归档。
 *
 * 本模块 import Node fs/os/path，只从 core 的 index.ts（Node 全量入口）导出，不进 renderer 入口。
 * 唯一写方是 ChatEngine（经 goalStore 适配器注入）；executor 的 read_goal 只读。
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { GoalState } from '../engine/types'

let goalsDirOverride: string | null = null

/** 测试注入 goals 目录覆盖（生产代码不调用；防测试写真实 ~/.chill） */
export function setGoalsDirOverride(dir: string | null): void {
  goalsDirOverride = dir
}

export function getGoalsDir(): string {
  const dir = goalsDirOverride ?? path.join(os.homedir(), '.chill', 'goals')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function getCurrentGoalPath(): string {
  return path.join(getGoalsDir(), 'current-goal.md')
}

/** 目标状态 → current-goal.md 全文（frontmatter 计数 + 正文目标/判据） */
export function renderGoalDocument(state: GoalState): string {
  return (
    `---\nstatus: ${state.status}\nroundCount: ${state.roundCount}\nnoProgressCount: ${state.noProgressCount}\n` +
    `maxRounds: ${state.maxRounds}\ncreatedAt: ${state.createdAt}\n---\n\n` +
    `# 目标\n\n${state.objective}\n\n# 完成判据\n\n${state.successCriteria}\n`
  )
}

/** 覆盖写 current-goal.md（setGoal / 每轮 goalTick 后计数更新 / pause/resume 状态翻转） */
export function saveCurrentGoal(state: GoalState): void {
  fs.writeFileSync(getCurrentGoalPath(), renderGoalDocument(state), 'utf-8')
}

/** 读取 current-goal.md 原文（read_goal 用；不存在返回 null） */
export function readCurrentGoal(): string | null {
  const filePath = getCurrentGoalPath()
  if (!fs.existsSync(filePath)) return null
  return fs.readFileSync(filePath, 'utf-8')
}

/** 清除工作文档（放弃/会话切换；幂等） */
export function clearCurrentGoal(): void {
  const filePath = getCurrentGoalPath()
  if (fs.existsSync(filePath)) fs.rmSync(filePath)
}

/** 达成归档：current-goal.md → goal-<时间戳>.md（重命名，与 plans 归档同手法），返回归档路径 */
export function archiveCurrentGoal(state: GoalState): string {
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13)
  const archivePath = path.join(getGoalsDir(), `goal-${ts}.md`)
  const currentPath = getCurrentGoalPath()
  if (fs.existsSync(currentPath)) {
    // 归档前刷新一次计数（frontmatter 是终态记录）
    saveCurrentGoal(state)
    fs.renameSync(currentPath, archivePath)
  } else {
    fs.writeFileSync(archivePath, renderGoalDocument(state), 'utf-8')
  }
  return archivePath
}
