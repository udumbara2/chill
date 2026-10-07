import {
  SessionRegistry,
  getTaskRegistry,
  pickEvictableSessions,
  pickStalledRounds,
  resolveScheduledFireTarget,
  type RoundActivitySnapshot,
  type SchedulerService,
  type ScheduledTask,
  eventBus,
  EVENTS,
  type EngineIdleSnapshot,
  type ChatEngine,
  type SessionRecord,
  type SessionStoreAdapter,
} from '@assistant-ai/core'
import type { CliContext } from '../context/CliContext.js'
import { createCliChatEngineForServe } from '../adapters/cliChatEngineFactory.js'

/**
 * serveSessions.ts —— serve 多会话装配（M1，多会话并行规划定案 7）。
 *
 * serve 形态的多会话宿主：core SessionRegistry（Node-free 基座）+ CLI serve 工厂。
 * 本文件是纯装配薄层，与 UI 的 chatEngine.ts registry 包装同构但零依赖（壳际零依赖铁律）。
 *
 * M3 定向路由（D7「停钟」语义退役）：serve 是唯一 24/7 长驻壳，**持钟归宿主**——
 * 构造时接管 ctx.scheduler（setFireMode('directed') + onFire=定向路由 + start），
 * sealAll 时 stop。触发按任务归属定向路由（core resolveScheduledFireTarget 纯函数）：
 * session→在册引擎/装载；project→匹配引擎（活跃优先）/最近会话装载/新建兜底；
 * 归属不可达→markOrphaned 清账。**重绑纪律**：引擎 ctor 的 onFire/setActiveContext
 * 单槽抢注不受 shellOwnsScheduler 门控——registry 每次造引擎后必须重绑路由
 * （UI bindSchedulerRouting :569-570 同款先例）。
 *
 * 语义要点（规划定案）：
 * - active 指针是纯展示/命令面基准（M0.1′ 后 enqueue 不经它路由——按 sessionId 直寻）；
 * - ensureActive = 已开切指针（运行中会话后台续跑）/ 未开 registry.open（新引擎装载，
 *   M0.2 守卫收窄后他引擎任务不拦）；
 * - ensureNew = registry.create（同步铸 id——桥轮前附着契约）；
 * - resolveEngine = enqueue 直寻（M0.1′）：id 命中注册表，无 id/未命中回退活跃引擎；
 * - anchorTarget = 锚定目标会话（D12：盘比内存新=对端写过 → 先采纳再入队；
 *   非活跃会话的盘上更新由本锚定 + 切换时重读两道既有机制收敛）；
 * - 退出收口 sealAll = 逐引擎 abort 封口 + endSession + dispose（core abortAndSealTurn）
 *   + 调度钟 stop。
 */

export interface ServeSessionsDeps {
  ctx: CliContext
  /** 与 CliSessionService 共享同一 SessionPersistence 适配器（工厂头注释红线：watch 回声过滤依赖同一 mtime 基线） */
  sessionStore: SessionStoreAdapter
  /** 单会话盘上新检测（CliSessionService.loadIfNewer 适配） */
  loadIfNewer: (sessionId: string) => Promise<SessionRecord | null>
  /**
   * M3 定向路由：会话文件存在性（session 任务装载可达性判定；损坏文件按不存在处理=诚实 orphan）。
   * 实现建议：existsSync(join(sessionsDir, `${id}.json`))——轻量不做全量 parse。
   */
  sessionExists: (sessionId: string) => boolean
  /** M3 定向路由：该 workDir 下最近会话 id（core latestSessionIdInDir，sessionIndex 数据源） */
  latestSessionInDir: (workDir: string) => string | undefined
  /** M3：路由执行观测（serve.log 一行留痕：orphan 清账/新建承接会话/装载失败） */
  onFireRouted?: (note: string) => void
  /**
   * M2.1 闲置回收的桥运行时清理口（relayClient 透出：per-session 链条目 + 聚合格）。
   * 可选=未接则只收引擎不清桥（桥格子小，泄漏可忽略；装配完整性仍建议接）。
   */
  pruneBridgeRuntime?: (sessionId: string) => void
  /** 回收执行观测（serve.log 一行留痕） */
  onEvicted?: (sessionId: string, reason: 'idle' | 'cap') => void
  /**
   * F-3（迭代 F）：轮次停滞告警出口（判定=core roundStall 纯函数；编排=本类 5min 计时器）。
   * 10 分钟零任何进展（含心跳滴漏型模型挂死）→ 每轮一次；不自动杀——中止权归操作者
   * （F-2 保证 attach 即激活后 turn.stop 可达）。
   */
  onStallAlarm?: (sessionId: string, stalledMinutes: number) => void
}

export class ServeSessions {
  private readonly registry: SessionRegistry
  private readonly deps: ServeSessionsDeps
  /** M3：宿主持钟（ctx.scheduler 单实例；构造接管、sealAll 停） */
  private readonly scheduler: SchedulerService | null
  private active: ChatEngine | null = null
  private activeListeners: Array<(sessionId: string | null) => void> = []
  /** M2.1：每会话闲置基线（epoch ms；open/create/切活跃/轮次落定刷新）——回收判定数据源 */
  private idleSince = new Map<string, number>()
  private evictionTimer: ReturnType<typeof setInterval> | null = null
  /** F-3：停滞告警已发集合（每轮一次；TURN_SETTLED 清除） */
  private stallAlarmed = new Set<string>()

  constructor(deps: ServeSessionsDeps) {
    this.deps = deps
    this.scheduler = deps.ctx.scheduler ?? null
    this.registry = new SessionRegistry({
      // M3 重绑纪律：引擎 ctor 抢注共享 scheduler 单槽（onFire/setActiveContext）——
      // 每次造引擎后立即重绑路由（同步块内完成，tick 计时器无法插入竞态）
      createEngine: () => {
        const engine = createCliChatEngineForServe(deps.ctx, deps.sessionStore, this.scheduler)
        this.bindSchedulerRouting()
        return engine
      },
    })
    // M3：宿主接管——定向模式 + 路由 + 持钟启动（单实例；chatService 退位引擎已不注入）
    if (this.scheduler) {
      this.bindSchedulerRouting()
      this.scheduler.start()
    }
    // M2.1：轮次落定刷新闲置基线（含后台轮——TURN_SETTLED 全局总线带 sessionId 归因）；
    // F-3：落定同时清除停滞告警标志（新轮次重新计）
    eventBus.on(EVENTS.TURN_SETTLED, this.onTurnSettled)
    // F-3：进展信号（与 lastActivity 同一张表——任何带归因事件都证明该会话活着）
    eventBus.on(EVENTS.TURN_STREAM_CHUNK, this.onProgress)
    eventBus.on(EVENTS.TOOL_CALL_STATUS_CHANGED, this.onProgress)
    eventBus.on(EVENTS.ASSISTANT_MESSAGE_CREATED, this.onProgress)
  }

  /** M3：路由重绑（装配点确定性覆盖引擎 ctor 抢注；fireMode/onFire 单源指向本宿主） */
  private bindSchedulerRouting(): void {
    const scheduler = this.scheduler
    if (!scheduler) return
    scheduler.setFireMode('directed')
    scheduler.setOnFire((task, coalescedCount) => {
      void this.routeScheduledFire(task, coalescedCount)
    })
  }

  /** M3：定向路由执行（决策=core resolveScheduledFireTarget 纯函数；本方法只执行） */
  private async routeScheduledFire(task: ScheduledTask, coalescedCount: number): Promise<void> {
    const scheduler = this.scheduler
    if (!scheduler) return
    const activeId = this.getActiveSessionId()
    const engines = this.registry.list().reduce<Array<{ sessionId: string; workDir: string; isActive?: boolean; lastActiveAt?: number }>>((acc, id) => {
      const engine = this.registry.get(id)
      if (engine) {
        acc.push({
          sessionId: id,
          workDir: engine.getWorkDir(),
          isActive: id === activeId,
          lastActiveAt: this.idleSince.get(id),
        })
      }
      return acc
    }, [])
    const decision = resolveScheduledFireTarget(task, {
      engines,
      sessionExists: this.deps.sessionExists,
      latestSessionInDir: this.deps.latestSessionInDir,
    })
    if (decision.kind === 'engine') {
      const engine = this.registry.get(decision.sessionId)
      if (engine) {
        engine.enqueueScheduledFire(task, coalescedCount)
        return
      }
      // 快照与执行之间被回收（罕见）→ 退化走装载
    }
    if (decision.kind === 'engine' || decision.kind === 'load') {
      const sessionId = decision.sessionId
      const engine = await this.registry.open(sessionId).catch(() => null)
      if (engine) {
        engine.enqueueScheduledFire(task, coalescedCount)
        this.touchIdle(sessionId)
        return
      }
      // 装载失败（会话文件不存在/损坏/守卫拒绝）→ 诚实清账
      await scheduler.markOrphaned(task.id)
      this.deps.onFireRouted?.(`定时任务 ${task.id} 归属会话 ${sessionId} 装载失败——转 orphaned（归属会话已删除或损坏）`)
      return
    }
    if (decision.kind === 'newSession') {
      // project 任务无人值守兜底：到点必有归宿（新建承接会话钉住任务 workDir；目录不存在
      // 照常新建——工具调用自然报错可观测，不做存在性拦截）
      const engine = this.birthInDir(decision.workDir)
      engine.enqueueScheduledFire(task, coalescedCount)
      this.deps.onFireRouted?.(`定时任务 ${task.id} 新建承接会话 ${engine.getSessionState().sessionId}（workDir=${decision.workDir || '（空）'}）`)
      return
    }
    // orphan：归属不可达（M2 路由器判定）
    await scheduler.markOrphaned(task.id)
    this.deps.onFireRouted?.(`定时任务 ${task.id} ${decision.reason}——转 orphaned（不再触发，可 cancel 清理）`)
  }

  /** 新建承接会话（M3 project 兜底）：create → 钉 workDir → startNewSession（SessionStart hooks 补登记）→ 铸 id */
  private birthInDir(workDir: string): ChatEngine {
    const engine = this.registry.create()
    if (workDir) engine.setWorkDir(workDir)
    engine.startNewSession()
    engine.ensureSessionId()
    this.touchIdle(engine.getSessionState().sessionId)
    return engine
  }

  private readonly onTurnSettled = (p: { sessionId?: string }): void => {
    if (typeof p?.sessionId === 'string') {
      this.touchIdle(p.sessionId)
      this.stallAlarmed.delete(p.sessionId)
    }
  }

  private readonly onProgress = (p: { sessionId?: string | null }): void => {
    if (typeof p?.sessionId === 'string' && p.sessionId) this.touchIdle(p.sessionId)
  }

  /**
   * F-2（迭代 F）：attach 即激活——桥 onSessionAttached 的 serve 接线。
   * **仅当目标已在注册表才 setActive**（浏览未打开的旧会话零装载副作用；需要控制的会话
   * 必然在册——在跑的轮次就在册）。attach(null) 不动 active（离开界面≠交还控制权）。
   * serve 单操作者宿主专属绑定（UI 宿主有桌面人不接——协议冻结 :76 对多操作者仍成立，
   * 见 PROTOCOL-FROZEN.md serve 例外注记）。
   */
  onPeerAttach(sessionId: string | null): void {
    if (sessionId === null) return
    const engine = this.registry.get(sessionId)
    if (engine) this.setActive(engine)
  }

  /**
   * 引擎诞生（照搬 cli.ts:471-482 的 SessionStart 补登记先例）：
   * registry.create 铸 id 入册 → startNewSession 排 SessionStart(startup) hooks 派发
   * （启动即得的全新会话不经 /session new·load，hook 永不触发——chatService 启动同款补登记）
   * → ensureSessionId 重铸 id（桥 'new' 契约：返 ok 时 id 必已诞生），registry 经订阅自动 rekey。
   */
  private birth(): ChatEngine {
    const engine = this.registry.create()
    engine.startNewSession()
    engine.ensureSessionId()
    return engine
  }

  /** 活跃引擎（惰性铸初始空会话——对齐 CLI 启动即全新空会话的现状语义，cli.ts:480-482） */
  getActiveEngine(): ChatEngine {
    if (!this.active) this.setActive(this.birth())
    return this.active!
  }

  getActiveSessionId(): string | null {
    return this.active?.getSessionState().sessionId ?? null
  }

  private touchIdle(sessionId: string | null): void {
    if (sessionId !== null) this.idleSince.set(sessionId, Date.now())
  }

  /**
   * M2.1 闲置回收编排（判定归 core pickEvictableSessions 纯函数；本方法只做快照采集与执行）：
   * 每 5min 扫描——非活跃 × 无在途轮 × 无本句柄 running 任务 × idle>30min → close
   * （顺带清桥 per-session 运行时）；引擎数超软帽从未到期闲置 LRU 补选。一切状态在盘，
   * 重开=registry 重新装载（冷启动）。三重守卫保证回收绝不杀在途任务/活跃会话。
   */
  startEvictionTimer(intervalMs = 5 * 60 * 1000): void {
    if (this.evictionTimer) return
    this.evictionTimer = setInterval(() => void this.evictIdle(), intervalMs)
    this.evictionTimer.unref?.()
  }

  stopEvictionTimer(): void {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer)
      this.evictionTimer = null
    }
  }

  private async evictIdle(): Promise<void> {
    const activeId = this.getActiveSessionId()
    const now = Date.now()
    const snapshots: EngineIdleSnapshot[] = []
    const stallSnapshots: RoundActivitySnapshot[] = []
    for (const id of this.registry.list()) {
      const engine = this.registry.get(id)
      if (!engine) continue
      const handle = engine.getScopeHandle()
      const isRunning = engine.getSessionState().isRunning
      const runningTaskCount = getTaskRegistry()
        .listRunning()
        .filter((t) => t.engineHandle === handle).length
      snapshots.push({
        sessionId: id,
        isActive: id === activeId,
        isRunning,
        runningTaskCount,
        idleSince: this.idleSince.get(id) ?? now,
      })
      stallSnapshots.push({ sessionId: id, isRunning, lastActivityAt: this.idleSince.get(id) ?? now })
    }
    // F-3：停滞告警（判定=core 纯函数；每轮一次；只告警不杀——中止权归操作者，F-2 保证可达）
    for (const id of pickStalledRounds(stallSnapshots, { now })) {
      if (this.stallAlarmed.has(id)) continue
      this.stallAlarmed.add(id)
      const stalledMin = Math.round((now - (this.idleSince.get(id) ?? now)) / 60000)
      this.deps.onStallAlarm?.(id, stalledMin)
    }
    const evictable = pickEvictableSessions(snapshots, { now })
    for (const id of evictable) {
      const reason = now - (this.idleSince.get(id) ?? now) >= 30 * 60 * 1000 ? 'idle' : 'cap'
      this.idleSince.delete(id)
      this.stallAlarmed.delete(id)
      this.deps.pruneBridgeRuntime?.(id)
      const closed = await this.closeSession(id)
      if (closed) this.deps.onEvicted?.(id, reason)
    }
  }

  /** 活跃变更订阅（cli.ts 装配点转发桥 active.changed——serve 不装 wireActiveSession，定案 7） */
  onActiveChanged(listener: (sessionId: string | null) => void): () => void {
    this.activeListeners.push(listener)
    return () => {
      this.activeListeners = this.activeListeners.filter((l) => l !== listener)
    }
  }

  private setActive(engine: ChatEngine | null): void {
    this.active = engine
    const sid = engine?.getSessionState().sessionId ?? null
    this.touchIdle(sid)
    for (const l of this.activeListeners) l(sid)
  }

  /**
   * 打开会话（照 UI chatEngine.openSession 形态）：已开 → 仅切 active（不动引擎——运行中
   * 会话切走后台续跑）；未开 → registry.open（新引擎 + loadSession）。记录不存在返回 null。
   */
  async openSession(sessionId?: string): Promise<ChatEngine | null> {
    if (sessionId === undefined) {
      this.setActive(this.birth())
      return this.active
    }
    const existing = this.registry.get(sessionId)
    if (existing) {
      this.setActive(existing)
      return existing
    }
    const engine = await this.registry.open(sessionId)
    if (!engine) return null
    this.setActive(engine)
    return engine
  }

  /** 桥守卫（M6 发言即激活）：已开切指针 / 未开装载；loadSession 守卫 throw → 'busy' */
  async ensureActive(sessionId: string): Promise<'ok' | 'busy' | 'notfound'> {
    try {
      const engine = await this.openSession(sessionId)
      return engine ? 'ok' : 'notfound'
    } catch {
      return 'busy'
    }
  }

  /** 桥 'new' 分支守卫：registry.create 同步铸 id（返 ok 时 id 必已诞生——桥轮前附着契约）+ SessionStart 补登记 */
  async ensureNew(): Promise<'ok' | 'busy'> {
    try {
      this.setActive(this.birth())
      return 'ok'
    } catch {
      return 'busy'
    }
  }

  /**
   * enqueue 直寻（M0.1′）：id 命中注册表现取；无 id / 未命中（守卫应已装载，防御回退）
   * → 活跃引擎。旧装配同款回退语义。
   */
  resolveEngine(sessionId: string | undefined): ChatEngine {
    if (sessionId !== undefined) {
      const hit = this.registry.get(sessionId)
      if (hit) return hit
    }
    return this.getActiveEngine()
  }

  /**
   * D12 锚定（按目标会话）：目标引擎轮中跳过（防在途轮内存换底）；盘比内存新 →
   * 引擎 loadSession 采纳（M0.2 收窄后他引擎任务不拦；自己任务在跑则 isRunning 已挡）。
   */
  async anchorTarget(sessionId: string | undefined): Promise<void> {
    const engine = this.resolveEngine(sessionId)
    const id = engine.getSessionState().sessionId
    if (id === null) return
    if (engine.getSessionState().isRunning) return
    const record = await this.deps.loadIfNewer(id)
    if (record) {
      try {
        await engine.loadSession(record.id)
      } catch {
        /* 守卫拒绝（自己后台任务恰在跑）→ 放弃锚定，注入照旧走引擎队列 */
      }
    }
  }

  /** 观测（M2.2 状态行）：引擎数/活跃 id/在途轮数 */
  counts(): { engines: number; active: string | null; busy: number } {
    const ids = this.registry.list()
    let busy = 0
    for (const id of ids) {
      if (this.registry.get(id)?.getSessionState().isRunning) busy++
    }
    return { engines: ids.length, active: this.getActiveSessionId(), busy }
  }

  /**
   * 运行中会话全集（运行态标志）：薄包 core SessionRegistry.runningSessionIds（判定单源）——
   * 供 relayClient deps.getRunningSessionIds 注入（桥 runningAll + catalog 对账快照）。
   */
  runningSessionIds(): string[] {
    return this.registry.runningSessionIds()
  }

  /** 单会话回收（M2.1 闲置回收调用方使用；桥 per-session 运行时由调用方另行清理） */
  async closeSession(sessionId: string): Promise<boolean> {
    this.idleSince.delete(sessionId)
    if (this.active?.getSessionState().sessionId === sessionId) this.setActive(null)
    return this.registry.close(sessionId)
  }

  /** 退出收口（serveShutdown / 换版自退）：逐引擎 abort 封口 + endSession + dispose + 调度钟停 */
  async sealAll(): Promise<void> {
    this.stopEvictionTimer()
    // M3：宿主停钟（错过触发由下次启动首轮 tick collapse 补跑——at-least-once 不丢）
    this.scheduler?.stop()
    eventBus.off(EVENTS.TURN_SETTLED, this.onTurnSettled)
    eventBus.off(EVENTS.TURN_STREAM_CHUNK, this.onProgress)
    eventBus.off(EVENTS.TOOL_CALL_STATUS_CHANGED, this.onProgress)
    eventBus.off(EVENTS.ASSISTANT_MESSAGE_CREATED, this.onProgress)
    this.setActive(null)
    await this.registry.disposeAll()
  }
}
