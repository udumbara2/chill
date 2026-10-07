/**
 * confirmedSheetLogic.test.ts — D 迭代清单弹层纯逻辑测试
 * actionsForZone（双 zone 动作集映射）+ ARM_WINDOW_MS（两段式武装窗口常量）
 */
import { actionsForZone, ARM_WINDOW_MS } from '../src/components/ConfirmedListSheet';

test('actionsForZone(confirmed)：三向流出动作，close 标 danger', () => {
  const acts = actionsForZone('confirmed');
  expect(acts.map((a) => a.key)).toEqual(['close', 'implement', 'requeue']);
  expect(acts.find((a) => a.key === 'close')?.danger).toBe(true);
  expect(acts.find((a) => a.key === 'implement')?.danger).toBeUndefined();
});

test('actionsForZone(closed)：仅 reopen（误关恢复）', () => {
  const acts = actionsForZone('closed');
  expect(acts.map((a) => a.key)).toEqual(['reopen']);
});

test('两段式武装窗口与裁决卡先例同款（3000ms）', () => {
  expect(ARM_WINDOW_MS).toBe(3000);
});
