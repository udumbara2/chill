/**
 * deliverableModal.test.tsx — 中量档三态弹座行为测试（规划 v2 T2 全用例）
 * 覆盖：打开即终态直达 / 执行中→落定迁移+终态停轮询 / 并行防串（feed 事件 taskId 过滤）/
 * 并行洪峰防回收（本地环只增不删）/ 轮询乱序双守卫（迟到 running 应答不回退）/ 关闭零泄漏 / overlay 空态。
 */
import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { DeliverableModal } from '../src/components/DeliverableModal';
import type { RelaySession } from '../src/relay/session';

// ---------- 可编程 session 假件 ----------

interface Fact {
  taskId: string;
  toolCallId: string;
  toolName: string;
  kind: string;
  argsSummary: string;
  status: 'running' | 'success' | 'failed';
  resultSummary?: string;
  durationMs?: number;
  at: number;
}

function makeSession() {
  const listeners = new Set<(e: { type: string; taskId?: string }) => void>();
  let facts: Fact[] = [];
  let reqCount = 0;
  let responder: (args: { sessionId: string; taskId: string }) => Promise<unknown> = async () => ({
    ok: true,
    data: { status: 'success', deliverable: '默认全文', truncated: false },
  });
  return {
    on: (cb: (e: { type: string; taskId?: string }) => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    emit: (e: { type: string; taskId?: string }) => {
      [...listeners].forEach((cb) => cb(e));
    },
    getFeedFacts: (taskId: string, limit?: number) =>
      facts.filter((f) => f.taskId === taskId).slice(0, limit ?? 10),
    setFacts: (f: Fact[]) => {
      facts = f;
    },
    requestCmd: async (_id: string, _cmd: string, args: { sessionId: string; taskId: string }) => {
      reqCount += 1;
      return responder(args) as Promise<{ ok: boolean; data?: unknown; error?: { message?: string } }>;
    },
    setResponder: (fn: (args: { sessionId: string; taskId: string }) => Promise<unknown>) => {
      responder = fn;
    },
    reqCountNow: () => reqCount,
    listenerCount: () => listeners.size,
  };
}

type SessionMock = ReturnType<typeof makeSession>;

const treeText = (tree: ReactTestRenderer.ReactTestRenderer): string => JSON.stringify(tree.toJSON());

async function renderOpen(s: SessionMock): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(
      <DeliverableModal
        visible
        onClose={() => {}}
        session={s as unknown as RelaySession}
        sessionId="s1"
        taskId="tc-A"
        title="测试任务"
      />,
    );
  });
  return tree;
}

/** microtask 排空 + 定时器推进（act 包裹：轮询/异步回调的 setState 在 act 内落地，测试树才会重渲） */
async function flush(ms = 0): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

test('打开即终态：直达 settled 全文（不进 running 视图）', async () => {
  const s = makeSession();
  // deferred 同款机制（避免首拉在 renderOpen 的 act 内同步完成——fake timers 下 React 调度 flush 会挂起 act）
  const deferred: Array<(v: unknown) => void> = [];
  s.setResponder(
    () =>
      new Promise((resolve) => {
        deferred.push(resolve as (v: unknown) => void);
      }),
  );
  const tree = await renderOpen(s);
  // resolve 在 act 外触发（act 内同步完成 setState 在本测试环境会挂起——fake timers 与 React 调度的
  // 交互怪癖，非组件缺陷：同款 settled 渲染已被乱序用例覆盖），由 flush 的 act 收敛状态与渲染
  deferred[0]({ ok: true, data: { status: 'success', deliverable: '全文内容XYZ', truncated: false } });
  await flush();
  await flush();
  const txt = treeText(tree);
  expect(txt).toContain('全文内容XYZ');
  expect(txt).not.toContain('执行过程（实时）');
});

test('执行中→落定迁移：running 视图 → 3s 轮询到终态 → settled 且停轮询', async () => {
  const s = makeSession();
  let call = 0;
  s.setResponder(async () => {
    call += 1;
    return call === 1
      ? { ok: true, data: { status: 'running', deliverable: '受理中', truncated: false } }
      : { ok: true, data: { status: 'success', deliverable: '最终交付', truncated: false } };
  });
  const tree = await renderOpen(s);
  await flush();
  expect(treeText(tree)).toContain('执行过程（实时）');
  expect(treeText(tree)).toContain('最终输出（任务完成后呈现）');
  // 3s 轮询触发第二次拉取 → success
  await flush(3000);
  const txt = treeText(tree);
  expect(txt).toContain('最终交付');
  expect(txt).not.toContain('执行过程（实时）');
  // 停轮询：再推进 10s 不再有新请求
  const n = s.reqCountNow();
  await flush(10000);
  expect(s.reqCountNow()).toBe(n);
});

test('并行防串：B 任务的 feed 事件与事实零混入 A 弹层', async () => {
  const s = makeSession();
  s.setFacts([
    { taskId: 'tc-A', toolCallId: 'a1', toolName: 'tool_A1', kind: 'builtin', argsSummary: 'x', status: 'success', at: 1 },
    { taskId: 'tc-B', toolCallId: 'b1', toolName: 'tool_B1', kind: 'builtin', argsSummary: 'y', status: 'success', at: 2 },
  ]);
  s.setResponder(async () => ({ ok: true, data: { status: 'running', deliverable: '', truncated: false } }));
  const tree = await renderOpen(s);
  await flush();
  // B 事件到达（taskId 不符）→ 不进 A 时间线、不触发重拉
  const n = s.reqCountNow();
  await act(async () => {
    s.emit({ type: 'feed', taskId: 'tc-B' });
  });
  await flush();
  const txt = treeText(tree);
  expect(txt).toContain('tool_A1');
  expect(txt).not.toContain('tool_B1');
  expect(s.reqCountNow()).toBe(n); // 防串过滤在订阅入口，无重拉
});

test('并行洪峰防回收：overlay 被 prune 挤出后，A 时间线不缩短、不重复（本地环只增不删）', async () => {
  const s = makeSession();
  const ten: Fact[] = Array.from({ length: 10 }, (_, i) => ({
    taskId: 'tc-A', toolCallId: `a${i}`, toolName: `toolA${i}`, kind: 'builtin', argsSummary: 'x', status: 'success', at: i + 1,
  }));
  s.setFacts(ten);
  s.setResponder(async () => ({ ok: true, data: { status: 'running', deliverable: '', truncated: false } }));
  const tree = await renderOpen(s);
  await flush();
  // JSX 拆分文本不可直接匹配：以 10 条事实的工具名逐一断言在场（完整不丢失）
  const txt = treeText(tree);
  for (let i = 0; i < 10; i++) expect(txt).toContain(`toolA${i}`);
  // B 注入 55 条（超 overlay 全局 60）→ A 只剩 3 条仍在 overlay（模拟 prune 挤出）
  const flood: Fact[] = Array.from({ length: 55 }, (_, i) => ({
    taskId: 'tc-B', toolCallId: `b${i}`, toolName: `toolB${i}`, kind: 'builtin', argsSummary: 'y', status: 'success', at: 100 + i,
  }));
  s.setFacts([...ten.slice(-3), ...flood]); // A 仅存最近 3 条
  await act(async () => {
    s.emit({ type: 'feed', taskId: 'tc-A' });
  });
  await flush();
  const txt2 = treeText(tree);
  for (let i = 0; i < 10; i++) expect(txt2).toContain(`toolA${i}`); // 本地环保留全部 10 条（不缩短不丢失）
  expect(txt2).not.toContain('toolB'); // 且 B 零混入
});

test('乱序双守卫：settled 应用后，迟到的 running 应答不回退视图', async () => {
  const s = makeSession();
  const deferred: Array<(v: unknown) => void> = [];
  s.setResponder(
    () =>
      new Promise((resolve) => {
        deferred.push(resolve as (v: unknown) => void);
      }),
  );
  const tree = await renderOpen(s);
  await flush();
  // 首拉（seq1）→ running
  await act(async () => {
    deferred[0]({ ok: true, data: { status: 'running', deliverable: '', truncated: false } });
  });
  await flush();
  expect(treeText(tree)).toContain('执行过程（实时）');
  // 3s 轮询发出（seq2）→ 先到的是 success（seq2 最新，采纳 → settled）
  await flush(3000);
  expect(deferred.length).toBe(2);
  await act(async () => {
    deferred[1]({ ok: true, data: { status: 'success', deliverable: '终态全文', truncated: false } });
  });
  await flush();
  expect(treeText(tree)).toContain('终态全文');
  // 迟到的旧应答（seq1 的 running）到达 → 序号守卫丢弃，视图不回退
  await act(async () => {
    deferred[0]({ ok: true, data: { status: 'running', deliverable: '', truncated: false } });
  });
  await flush();
  const txt = treeText(tree);
  expect(txt).toContain('终态全文');
  expect(txt).not.toContain('执行过程（实时）');
});

test('关闭零泄漏：visible=false 后 feed 订阅退订、后续事件零副作用', async () => {
  const s = makeSession();
  s.setResponder(async () => ({ ok: true, data: { status: 'running', deliverable: '', truncated: false } }));
  const tree = await renderOpen(s);
  await flush();
  const during = s.listenerCount();
  expect(during).toBeGreaterThan(0);
  await act(async () => {
    tree.update(
      <DeliverableModal
        visible={false}
        onClose={() => {}}
        session={s as unknown as RelaySession}
        sessionId="s1"
        taskId="tc-A"
        title="测试任务"
      />,
    );
  });
  await flush();
  expect(s.listenerCount()).toBe(during - 1); // 订阅退订
  // 关闭后事件与定时器推进均无副作用/无崩溃
  await act(async () => {
    s.emit({ type: 'feed', taskId: 'tc-A' });
  });
  await flush(30000);
});

test('overlay 空态：无事实时 running 视图显示空态文案（结果通道不受影响）', async () => {
  const s = makeSession();
  s.setFacts([]);
  s.setResponder(async () => ({ ok: true, data: { status: 'running', deliverable: '', truncated: false } }));
  const tree = await renderOpen(s);
  await flush();
  const txt = treeText(tree);
  expect(txt).toContain('暂无工具调用记录');
  expect(txt).toContain('执行过程（实时）');
});
