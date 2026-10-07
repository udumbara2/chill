/**
 * SessionScope（多会话归因基座 · 迭代 1）
 *
 * 每引擎注册一个上下文对象（句柄随 __origin 流动，与 origin.taskId 同性质——
 * 只是路由键，不是第二身份键；会话身份唯一键是 sessionId）。
 * executor 与模块级派发通道的一切按调用归属经 scope 现读解析；无归因（Worker 网关/
 * 老任务/异常路径）回退 legacy 单槽现状——这是行为兼容硬规则。
 *
 * 全部为现读 getter（返回值随引擎状态实时变化，不缓存快照）；Node-free，渲染进程可导入。
 */

import type { HookRunner } from '../hooks/HookRunner'
import type { SchedulerService } from '../scheduler/SchedulerService'

/** 定时任务三件套取数形状（与 executor.setSchedulerProvider 的闭包返回同形） */
export interface SessionSchedulerContext {
  scheduler: SchedulerService | null
  workDir: string
  ensureSessionId(): string
  activeScheduledTaskId: string | null
}

/**
 * 会话作用域：executor 按 __origin.handle 找到本对象，一切会话级取数走这里。
 * 注册/注销由引擎构造与 dispose 对称完成（见 builtInToolExecutor.registerSessionScope）。
 */
export interface SessionScope {
  /** 路由句柄（引擎铸造，随 __origin.handle 流动） */
  readonly handle: string
  /** 会话身份（现读；未铸 id 时为 null） */
  getSessionId(): string | null
  /** 工作目录（现读引擎本地 workDir——1.7 workDir 会话化，不受前台目录联动漂移） */
  getCwd(): string
  /** 当前轮次 user 消息身份（现读；轮外为 undefined） */
  getTurnId(): string | undefined
  /** plan 模式旗标（现读引擎旗标——executor 门按调用归属取，setPlanMode 单旗标退居 legacy 回退） */
  getPlanMode(): boolean
  /** hooks 运行器（现读；无则 null） */
  getHookRunner(): HookRunner | null
  /** 定时任务取数（现读；未装配为 null） */
  getSchedulerContext(): SessionSchedulerContext | null
  /** agent 记忆目录（现读；无专属空间为 null） */
  getAgentMemoryDir(): string | null
  /** agent 知识库绑定名单（现读；不划界为 null） */
  getAgentKnowledgeBases(): string[] | null
}
