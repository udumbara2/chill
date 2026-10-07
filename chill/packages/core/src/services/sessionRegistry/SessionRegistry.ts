/**
 * SessionRegistry（多会话基座 · 迭代 1）：纯容器，只管会话生死。
 *
 * Map<sessionId, ChatEngine>，单写者：同 sessionId 至多一个引擎（open 幂等）。
 * active 是壳视图态，不在本容器；core 服务需"当前会话"走注入 getter 先例
 * （scheduler.setActiveContext 同款），本容器不提供全局"当前"。
 *
 * close 语义 = 先 abort 在途轮（有界等待封口——发现 #14：带在途轮销毁会破坏
 * 落盘时序、产生孤儿占位）→ endSession（SessionEnd hooks）→ dispose。
 *
 * Node-free（ChatEngine 只 import type），渲染进程可导入。
 */

import type { ChatEngine } from '../../engine/ChatEngine'
import type { SessionScope } from './SessionScope'

/** 引擎工厂（壳装配注入 deps；registry 不认识引擎构造细节） */
export type SessionEngineFactory = () => ChatEngine

export interface SessionRegistryOptions {
  createEngine: SessionEngineFactory
}

/**
 * 有界等待在途轮封口（与 UI 退出封口同逻辑，抽成可复用函数供 registry.close
 * 与壳层退出口共用）：先 abort，再轮询 isRunning 至预算耗尽（兜底防卡死）。
 */
export async function abortAndSealTurn(
  engine: Pick<ChatEngine, 'abort' | 'getSessionState'>,
  budgetMs = 2000,
): Promise<void> {
  if (!engine.getSessionState().isRunning) return
  engine.abort()
  const deadline = Date.now() + budgetMs
  while (engine.getSessionState().isRunning && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50))
  }
}

export class SessionRegistry {
  private readonly engines = new Map<string, ChatEngine>()
  private readonly createEngine: SessionEngineFactory
  /** 每引擎的 active-changed 订阅退订函数（dispose 对称回收） */
  private readonly unsubscribes = new Map<ChatEngine, () => void>()

  constructor(options: SessionRegistryOptions) {
    this.createEngine = options.createEngine
  }

  /**
   * 打开会话（幂等单写者）：
   * - 带 id：取既有引擎；无则新建引擎并 loadSession——load 失败即 dispose，不留半生引擎；
   * - 无 id：新建引擎并立即铸 sessionId（1.1：id 与生俱来，纯内存诞生、落盘时机不变）。
   * 返回 null 仅当带 id 且记录加载失败。
   */
  async open(sessionId?: string): Promise<ChatEngine | null> {
    if (sessionId !== undefined) {
      const existing = this.engines.get(sessionId)
      if (existing) return existing
      const engine = this.createEngine()
      this.watch(engine)
      const ok = await engine.loadSession(sessionId)
      if (!ok) {
        this.unwatch(engine)
        engine.dispose()
        return null
      }
      // loadSession 成功即带记录 id；保险重键一次（幂等）
      this.rekey(engine, engine.getSessionState().sessionId)
      return engine
    }
    return this.create()
  }

  /**
   * 同步新建空会话引擎（open 无 id 路径的同步形态；壳 getChatEngine 惰性单例需要同步返回）。
   * 立即铸 sessionId、入册并返回——纯内存诞生，落盘时机不变。
   */
  create(): ChatEngine {
    const engine = this.createEngine()
    this.watch(engine)
    engine.ensureSessionId()
    this.rekey(engine, engine.getSessionState().sessionId)
    return engine
  }

  get(sessionId: string): ChatEngine | undefined {
    return this.engines.get(sessionId)
  }

  has(sessionId: string): boolean {
    return this.engines.has(sessionId)
  }

  /** 全部会话 id（Map 插入序） */
  list(): string[] {
    return [...this.engines.keys()]
  }

  /**
   * 运行中会话全集（运行态标志，2026-10-04）：过滤 isRunning——判定逻辑唯一事实点在 core，
   * serve 与 UI 两壳薄调用（口径一致由构造保证；serve 状态行 busy / 手机列表转圈 / 桥 runningAll
   * 三者同源）。只读查询，不改容器状态。
   */
  runningSessionIds(): string[] {
    const out: string[] = []
    for (const [id, engine] of this.engines) {
      if (engine.getSessionState().isRunning) out.push(id)
    }
    return out
  }

  /** 会话作用域快照（诊断/测试用；无此会话返回 undefined） */
  getScope(sessionId: string): SessionScope | undefined {
    return this.engines.get(sessionId)?.getSessionScope()
  }

  /**
   * 关闭会话：abort 在途轮（有界等待封口）→ endSession → dispose。
   * 幂等：未知 id 返回 false，不抛错。
   */
  async close(sessionId: string): Promise<boolean> {
    const engine = this.engines.get(sessionId)
    if (!engine) return false
    this.engines.delete(sessionId)
    this.unwatch(engine)
    await abortAndSealTurn(engine)
    await engine.endSession()
    engine.dispose()
    return true
  }

  /** 退出收口：全部 close（并发执行，总预算由各引擎封口共享） */
  async disposeAll(): Promise<void> {
    const ids = this.list()
    await Promise.all(ids.map((id) => this.close(id)))
  }

  /** 订阅引擎会话身份变化：detach 换新 id / id 诞生时重键（1.3 订阅列表消费方） */
  private watch(engine: ChatEngine): void {
    const off = engine.subscribeActiveSessionChanged((sessionId) => {
      this.rekey(engine, sessionId)
    })
    this.unsubscribes.set(engine, off)
  }

  private unwatch(engine: ChatEngine): void {
    this.unsubscribes.get(engine)?.()
    this.unsubscribes.delete(engine)
  }

  /** 重键：同一引擎旧键清掉、新键登记（null = 暂不键控，等下次铸 id） */
  private rekey(engine: ChatEngine, sessionId: string | null): void {
    for (const [id, e] of this.engines) {
      if (e === engine && id !== sessionId) this.engines.delete(id)
    }
    if (sessionId) this.engines.set(sessionId, engine)
  }
}
