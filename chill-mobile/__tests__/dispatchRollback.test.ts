/**
 * dispatchRollback.test.ts — 分派层失败回滚（记账滞后于事实）：
 * 1. DedupeSet：mark 到达即标记 / delete 撤销后重投可重处理 / has 只读
 * 2. RelaySession 标记配对：markAndPersist → unmarkAndPersist 回滚后同 id 可重新标记
 *    （处理失败 → 不 ACK → 服务器重投 → 去重通道重新打开，信封不再永久丢失）
 * 分派层 6 组分支的 try{处理+ack}catch{回滚} 形态由 e2e 注入异常与真机场景覆盖
 * （handleBoxMessage 需加密信道，jest 不可直调）。
 */
import { test } from '@jest/globals';
import { DedupeSet } from '../src/relay/envelope';
import { RelaySession } from '../src/relay/session';

/* eslint-disable @typescript-eslint/no-explicit-any */

test('DedupeSet：mark 到达即标记 / delete 撤销后重投可重处理 / has 只读检查', () => {
  const d = new DedupeSet(16);
  expect(d.has('x')).toBe(false);
  expect(d.mark('x')).toBe(true); // 首次到达
  expect(d.mark('x')).toBe(false); // 重投去重
  expect(d.has('x')).toBe(true);
  d.delete('x'); // 处理失败回滚
  expect(d.has('x')).toBe(false);
  expect(d.mark('x')).toBe(true); // 重投可重处理——信封不再永久丢失
});

test('RelaySession 标记配对：markAndPersist → unmarkAndPersist 回滚后可重新标记（重投通道重开）', () => {
  const s = new RelaySession();
  const anyS = s as any;
  expect(anyS.markAndPersist('env-1')).toBe(true);
  expect(anyS.dedupe.has('env-1')).toBe(true);
  anyS.unmarkAndPersist('env-1'); // 处理失败回滚（含快照重存）
  expect(anyS.dedupe.has('env-1')).toBe(false);
  expect(anyS.markAndPersist('env-1')).toBe(true); // 重投重处理通道重新打开
});

test('DedupeSet 容量边界：回滚后重标不占双倍槽位（order 同步移除）', () => {
  const d = new DedupeSet(3, ['a', 'b']);
  d.mark('c');
  d.delete('c');
  d.mark('c'); // 回滚重标
  d.mark('d'); // 触发驱逐最旧（a）
  expect(d.has('a')).toBe(false);
  expect(d.has('c')).toBe(true);
  expect(d.snapshot()).toEqual(['b', 'c', 'd']);
});
