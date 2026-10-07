/**
 * 运行态标志（2026-10-04）：nextRunningSet 纯判定回归。
 * 覆盖：单会话增删 / runningAll 整替 / 纯快照形态（无 sessionId）/ 快照优先于增量 /
 * 集合无变化返回 null（周期重申防抖）/ 输入不完整返回 null（旧桌面兼容）。
 */
import { nextRunningSet } from '../src/relay/syncReducer';

const setOf = (...ids: string[]): ReadonlySet<string> => new Set(ids);

describe('nextRunningSet（运行中会话集合纯判定）', () => {
  it('单会话增量：启动入集 / 落定出集', () => {
    const started = nextRunningSet(setOf(), { sessionId: 's-a', running: true });
    expect(started && [...started]).toEqual(['s-a']);
    const settled = nextRunningSet(setOf('s-a', 's-b'), { sessionId: 's-a', running: false });
    expect(settled && [...settled]).toEqual(['s-b']);
  });

  it('增量无实际变化返回 null（重申/重复事件防抖）', () => {
    expect(nextRunningSet(setOf('s-a'), { sessionId: 's-a', running: true })).toBeNull();
    expect(nextRunningSet(setOf(), { sessionId: 's-a', running: false })).toBeNull();
  });

  it('runningAll 整替：集合等价返回 null；不等价返回新集合（含清空）', () => {
    expect(nextRunningSet(setOf('s-a'), { runningAll: ['s-a'] })).toBeNull();
    const replaced = nextRunningSet(setOf('s-a'), { runningAll: ['s-b', 's-c'] });
    expect(replaced && [...replaced]).toEqual(['s-b', 's-c']);
    const cleared = nextRunningSet(setOf('s-a', 's-b'), { runningAll: [] });
    expect(cleared && [...cleared]).toEqual([]);
  });

  it('纯快照形态（sessionId 省略 + 仅 runningAll）走整替', () => {
    const snap = nextRunningSet(setOf('s-a'), { runningAll: ['s-a', 's-b'] });
    expect(snap && [...snap]).toEqual(['s-a', 's-b']);
  });

  it('runningAll 优先于增量（两者同在以快照为准）', () => {
    const r = nextRunningSet(setOf('s-a'), { sessionId: 's-a', running: false, runningAll: ['s-a', 's-x'] });
    expect(r && [...r]).toEqual(['s-a', 's-x']);
  });

  it('输入不完整返回 null（旧桌面未知 kind 兜底 / 空串 sessionId 防御）', () => {
    expect(nextRunningSet(setOf('s-a'), {})).toBeNull();
    expect(nextRunningSet(setOf('s-a'), { sessionId: '', running: true })).toBeNull();
    expect(nextRunningSet(setOf('s-a'), { sessionId: 's-a' })).toBeNull();
    expect(nextRunningSet(setOf('s-a'), { running: true })).toBeNull();
  });

  it('返回新集合实例（不可变更新——调用方以引用替换触发重渲）', () => {
    const prev = setOf('s-a');
    const next = nextRunningSet(prev, { sessionId: 's-b', running: true });
    expect(next).not.toBe(prev);
    expect([...prev]).toEqual(['s-a']); // 原集合不被就地改写
  });
});
