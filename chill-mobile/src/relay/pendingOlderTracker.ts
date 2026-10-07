/**
 * pendingOlderTracker.ts — 在途上翻请求登记簿（纯内存纯逻辑，可独立单测）。
 *
 * 配对关系：history.request(asOlder) 发出时登记信封 id → 桌面应答 history.page
 * 的 replyTo=请求信封 id → handleHistoryPage 据此在 'history' 事件上携带
 * intent='older'（UI 保持窗口 prepend、不重置）。
 *
 * 未登记的应答（尾部拉齐 / tailChain 链式补拉 / 迟到重投）= 无 intent = 刷新语义，
 * 保守降级为现状行为。
 *
 * 防泄漏：容量上限 FIFO 淘汰（请求投递失败、应答永不到达的死 id 兜底）。
 */

/** 死 id 兜底容量：单会话在途上翻请求至多 1（pagingRef 防重入），多会话/异常累积场景余量充足 */
const CAPACITY = 32;

export class PendingOlderTracker {
  /** Map 保插入序：FIFO 淘汰取最旧键用 */
  private ids = new Map<string, true>();

  /** 登记��个在途上翻请求信封 id（同 id 重复登记幂等；超容量淘汰最旧） */
  add(id: string): void {
    if (this.ids.has(id)) return;
    this.ids.set(id, true);
    if (this.ids.size > CAPACITY) {
      const oldest = this.ids.keys().next().value;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
  }

  /** 消费：命中=true 并移除（一次性）；未登记/已消费=false（幂等，重复应答不二跳） */
  consume(id: string): boolean {
    if (!this.ids.has(id)) return false;
    this.ids.delete(id);
    return true;
  }

  get size(): number {
    return this.ids.size;
  }
}
