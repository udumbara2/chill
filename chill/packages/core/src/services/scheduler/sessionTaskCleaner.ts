/**
 * sessionTaskCleaner.ts —— 会话删除的定时任务清账（M5，规划《定时任务 serve 持钟与定向路由》）。
 *
 * orphaned 死状态激活：四壳删除路径（CLI /session delete、UI IPC session:delete、手机
 * session.delete、web）全部汇聚 core SessionPersistence.delete——本模块提供进程级单槽
 * 清账器（照 getSessionBoardService 会话级看板归档先例），delete 成功后 best-effort 调用：
 * 绑定该会话的 active session 任务批量转 orphaned（SchedulerService.markSessionDeleted，
 * 与 M2 路由 orphan 分支同一状态语义）。未注入=不清账（现状）；清账失败不阻断删除
 * （任务清单独立文件，残留可由下次触发时的路由 orphan 分支兜底）。
 */

export type SessionTaskCleaner = (sessionId: string) => Promise<string[] | void>

let sessionTaskCleaner: SessionTaskCleaner | null = null

/** 壳装配点注入（进程级单槽；传 null 摘除）。实现建议：async (id) => scheduler.markSessionDeleted(id) */
export function setSessionTaskCleaner(cleaner: SessionTaskCleaner | null): void {
  sessionTaskCleaner = cleaner
}

/** SessionPersistence.delete 的取数口（delete 时刻现读；未装配返回 null） */
export function getSessionTaskCleaner(): SessionTaskCleaner | null {
  return sessionTaskCleaner
}
