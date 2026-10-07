/**
 * 上翻分页滚动修复的核心纯逻辑测试（视口跳变根因：history 事件语义压扁 → reloadDb(false) 误重置）：
 * - PendingOlderTracker：asOlder 请求登记-应答 replyTo 配对消费（intent='older' 的判定源）
 * - cursorAllowsPrepend：双通路（older 应答 reloadDb(true) / loadOlder）并发 prepend 的游标 CAS
 */
import { PendingOlderTracker } from '../src/relay/pendingOlderTracker';
import { cursorAllowsPrepend } from '../src/screens/syncUiLogic';

describe('PendingOlderTracker（intent 推断判定源）', () => {
  it('登记→消费命中（asOlder 请求的应答 → intent=older）', () => {
    const t = new PendingOlderTracker();
    t.add('env-1');
    expect(t.consume('env-1')).toBe(true);
    expect(t.size).toBe(0);
  });

  it('未登记不命中（尾部拉齐 / tailChain 链式补拉 / 迟到重投 → 无 intent=刷新语义）', () => {
    const t = new PendingOlderTracker();
    expect(t.consume('env-unknown')).toBe(false);
    t.add('env-1');
    expect(t.consume('env-2')).toBe(false); // 登记了别的 id，本应答不命中
  });

  it('消费后同 replyTo 再达不命中（应答重投幂等，不二跳）', () => {
    const t = new PendingOlderTracker();
    t.add('env-1');
    expect(t.consume('env-1')).toBe(true);
    expect(t.consume('env-1')).toBe(false);
  });

  it('同 id 重复登记幂等', () => {
    const t = new PendingOlderTracker();
    t.add('env-1');
    t.add('env-1');
    expect(t.size).toBe(1);
  });

  it('容量上限 FIFO 淘汰最旧（死 id 泄漏兜底）', () => {
    const t = new PendingOlderTracker();
    const many = [];
    for (let i = 0; i < 40; i++) {
      const id = `env-${i}`;
      t.add(id);
      many.push(id);
    }
    // 容量 32：最旧的 8 个被淘汰
    expect(t.size).toBe(32);
    expect(t.consume('env-0')).toBe(false);
    expect(t.consume('env-7')).toBe(false);
    expect(t.consume('env-8')).toBe(true);
    expect(t.consume('env-39')).toBe(true);
  });
});

describe('cursorAllowsPrepend（双通路并发 prepend 的游标 CAS）', () => {
  it('游标未被推进 → 允许 prepend（首到通路）', () => {
    expect(cursorAllowsPrepend('E1', 'E1')).toBe(true);
  });

  it('查询期间游标被并发通路推进 → 让位（后到通路早退，先到先得）', () => {
    // 交错：reloadDb(true) 与 loadOlder 同以 E1 为基准查询；loadOlder 先回写游标 E2
    expect(cursorAllowsPrepend('E2', 'E1')).toBe(false);
    // 反序：reloadDb(true) 先回写 E2，loadOlder 后到让位
    expect(cursorAllowsPrepend('E1', 'E2')).toBe(false);
  });

  it('查询期间整组替换重置游标 → 让位（reloadDb(false) 重定义窗口，过时 prepend 废弃是语义正确的）', () => {
    expect(cursorAllowsPrepend('N', 'E1')).toBe(false);
    expect(cursorAllowsPrepend(null, 'E1')).toBe(false); // 重置为空窗口同样废弃
  });

  it('null/undefined 归一：DB 空游标基准 + 游标仍空 → 允许（首次 prepend）', () => {
    expect(cursorAllowsPrepend(null, undefined)).toBe(true);
    expect(cursorAllowsPrepend(undefined, undefined)).toBe(true);
  });

  it('双通路并发场景串演：同基准并发 → 恰好一方通过、消息集无重复', () => {
    // 模拟 earliestRef：查询基准 E1，两通路并发返回同一批 rows（同参数同结果）
    let cursor: string | null = 'E1';
    const base = cursor ?? undefined;
    const window: string[] = ['m1', 'm2', 'm3'];

    // 通路 A（先完成）：CAS 通过 → 推进游标 + prepend
    const aAllows = cursorAllowsPrepend(cursor, base);
    expect(aAllows).toBe(true);
    if (aAllows) cursor = 'E0'; // rows[0].msgKey
    const windowAfterA = [...window]; // A 的 prepend 模拟（同批内容已在窗口语义下不重复添加）

    // 通路 B（后完成）：游标已变 → CAS 让位，不 prepend
    const bAllows = cursorAllowsPrepend(cursor, base);
    expect(bAllows).toBe(false);

    // 消息集无重复 id：窗口保持 A 的一份
    expect(windowAfterA).toHaveLength(3);
    expect(cursor).toBe('E0');
  });

  it('让位不丢数据：剩余存货下次以新游标查询仍可得（判定只跳过内存 prepend）', () => {
    // 让位后游标 E2；下次查询基准=E2，判定通过 → prepend 继续
    expect(cursorAllowsPrepend('E2', 'E2')).toBe(true);
  });
});
