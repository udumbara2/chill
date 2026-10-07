/**
 * 长条收摊规则测试（原演示稿 3·收摊/3·复现 规格基准；settled 永驻规格 2026-10-06 演进：settled 不再 6s 自动收摊，
 * 仅 ✕ 与新一轮活跃可退场）。判定唯一事实点=pillPresence/pillActivitySig/pillActivityGrew 纯函数（时序精确锁——
 * 纯函数完整语义保留在 syncUiLogic 供未来调用方复用；WorkPlanPanel 组件恒传 settledSince:null 不起算）；
 * 组件级锁新行为语义（面板=WorkPlanPanel，BoardPanel 已退役并入）：
 * ✕ 立即收摊 / 显隐不依���动画完成态 / settled 永驻展示 / 切会话隔离 /
 * 收摊后持续活跃不复现、出现新边沿才复现。
 * 与 BoardPanel 的语义差异：WorkPlanPanel 初值 dismissed=false——工作计划是持久事实，
 * fresh 会话首见即亮（含 settled 态，永驻展示）；无"重启 settled 不显示"规则。
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import {
  pillActivityGrew,
  pillActivitySig,
  pillPresence,
  PILL_SETTLED_DISMISS_MS,
  type PillActivitySig,
} from '../src/screens/syncUiLogic';
import type { BoardNeedsYouWire, BoardStripWire } from '../src/relay/envelope';

// ---------- fixtures（全部协议字段，零自算被测面） ----------
const running: BoardStripWire = { status: 'running', countText: '1/2', needsYou: false };
const settled: BoardStripWire = { status: 'settled', countText: '2/2', settleText: '2 个子任务完成', needsYou: false };
const needNone: BoardNeedsYouWire = { needed: false, count: 0 };
const needSome: BoardNeedsYouWire = { needed: true, count: 2 };
const rows2 = [{ status: 'in_progress' }, { status: 'completed' }];
const rowsDone = [{ status: 'completed' }, { status: 'completed' }];
const sigOf = (rows: Array<{ status: string }>, needsYou: BoardNeedsYouWire, strip: BoardStripWire): PillActivitySig =>
  pillActivitySig(strip, needsYou, rows);
const base = {
  rowCount: 2,
  dismissed: false,
  settledSince: null as number | null,
  now: 1_000_000,
  sig: sigOf(rows2, needNone, running),
  sinceSig: null as PillActivitySig | null,
};

// ---------- 纯函数规则锁 ----------

test('规则1：settled 展示满 6 秒 → auto-dismiss（边界 5999 未到、6000 到）', () => {
  const t0 = base.now;
  expect(pillPresence({ ...base, strip: settled, needsYou: needNone, settledSince: t0, now: t0 + PILL_SETTLED_DISMISS_MS - 1 })).toBe('show');
  expect(pillPresence({ ...base, strip: settled, needsYou: needNone, settledSince: t0, now: t0 + PILL_SETTLED_DISMISS_MS })).toBe('auto-dismiss');
});

test('规则1/3：settledSince=null（running 取消计时后）不触发收摊', () => {
  expect(pillPresence({ ...base, strip: running, needsYou: needNone, settledSince: null, now: base.now + 60_000 })).toBe('show');
});

test('规则3：收摊后纯终态不弹（又 completed/cancelled、rev 前进——活跃签名不增不弹）', () => {
  const since = sigOf(rows2, needNone, running); // 收摊时 1 条进行中
  // 又一条 completed：进行中 1→0（降）/ 要你不变 → 无新边沿
  expect(pillPresence({ ...base, strip: settled, needsYou: needNone, dismissed: true, sig: sigOf(rowsDone, needNone, settled), sinceSig: since })).toBe('hidden');
  // rev 前进但行态摘要不变 → 仍不弹
  expect(pillPresence({ ...base, strip: settled, needsYou: needNone, dismissed: true, sig: since, sinceSig: since, now: base.now + 30_000 })).toBe('hidden');
});

test('规则3：收摊后出现进行中或要你 → 复现（边沿语义）', () => {
  const since = sigOf(rowsDone, needNone, settled); // 收摊时 0 进行中、无要你
  // 出现进行中（0→1）
  expect(pillPresence({ ...base, strip: running, needsYou: needNone, dismissed: true, sig: sigOf(rows2, needNone, running), sinceSig: since })).toBe('reappear');
  // 出现要你（false→true）
  expect(pillPresence({ ...base, strip: settled, needsYou: needSome, dismissed: true, sig: sigOf(rowsDone, needSome, settled), sinceSig: since })).toBe('reappear');
});

test('规则3：收摊时已活跃的持续态不复现（✕ 收摊后进行中照旧不弹）', () => {
  const since = sigOf(rows2, needNone, running); // ✕ 时 1 条进行中
  expect(pillPresence({ ...base, strip: running, needsYou: needNone, dismissed: true, sinceSig: since })).toBe('hidden');
});

test('规则4：重启语义（fresh=dismissed 初值 true、sinceSig=null 基线全零）', () => {
  // settled 且无要你：0 进行中 → 直接不显示
  expect(pillPresence({ ...base, strip: settled, needsYou: needNone, dismissed: true, sig: sigOf(rowsDone, needNone, settled), sinceSig: null })).toBe('hidden');
  // 亮态照常唤起（进行中 0→1）
  expect(pillPresence({ ...base, strip: running, needsYou: needNone, dismissed: true, sinceSig: null })).toBe('reappear');
});

test('复现即重置后续 6 秒计时：复现指令后 settledSince 重新起算', () => {
  const t0 = base.now;
  expect(pillPresence({ ...base, strip: settled, needsYou: needSome, dismissed: false, settledSince: t0, now: t0 + 3000 })).toBe('show');
  expect(pillPresence({ ...base, strip: settled, needsYou: needSome, dismissed: false, settledSince: t0, now: t0 + PILL_SETTLED_DISMISS_MS })).toBe('auto-dismiss');
});

test('无内容（无 strip / 0 行）一律 hidden；pillActivityGrew 边沿方向性', () => {
  expect(pillPresence({ ...base, strip: null, needsYou: needNone })).toBe('hidden');
  expect(pillPresence({ ...base, strip: running, needsYou: needNone, rowCount: 0 })).toBe('hidden');
  // 边沿方向性：增加才弹、减少/持平不弹
  expect(pillActivityGrew({ doing: 2, needsYou: false }, { doing: 1, needsYou: false })).toBe(true);
  expect(pillActivityGrew({ doing: 0, needsYou: true }, { doing: 1, needsYou: false })).toBe(true);
  expect(pillActivityGrew({ doing: 0, needsYou: false }, { doing: 1, needsYou: false })).toBe(false);
  expect(pillActivityGrew({ doing: 1, needsYou: false }, { doing: 1, needsYou: true })).toBe(false);
});

// ---------- 组件级行为（WorkPlanPanel；显隐不依赖动画完成态；✕ 纯观测） ----------

interface TreeItem {
  id: string;
  content: string;
  status: string;
  actor?: string;
}

const mockDbState: {
  meta: { agentId: string; sessionId: string; rev: string; treeJson: string; updatedAt: string } | null;
} = { meta: null };

const TREE_RUNNING: TreeItem[] = [
  { id: 'b1', content: '任务一', status: 'completed', actor: 'explore·A' },
  { id: 'b2', content: '任务二', status: 'in_progress', actor: 'explore·B' },
];

jest.mock('../src/db/syncDb', () => ({
  getSyncDb: () => ({
    getWorkPlanMeta: async () => mockDbState.meta,
    listBoardItems: async () => [],
  }),
}));

import { WorkPlanPanel } from '../src/components/WorkPlanPanel';
import type { RelaySession } from '../src/relay/session';

/** 事件捕获型 session 假件：on 收集监听器，emit 触发 workplan 事件驱动 reload（数据变更可达） */
type Listener = (e: { type: string; sessionId?: string }) => void;
const listeners = new Set<Listener>();
const session = {
  getAgentId: () => 'a1',
  on: (cb: Listener) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
  getFeedFacts: () => [],
  getCommandCatalog: () => null, // C 迭代：canDetail 门控读取（null=目录未同步，行不可点）
} as unknown as RelaySession;
async function flushAll(): Promise<void> {
  // mock 的 async 链走微任务；React 的调度在假定时器下走 setImmediate/setTimeout 队列——
  // 只 await Promise 不够，必须在 act 内同时把假定时器推 0ms，渲染才会落位
  await ReactTestRenderer.act(async () => {
    for (let i = 0; i < 6; i += 1) {
      await Promise.resolve();
      jest.advanceTimersByTime(0);
    }
  });
}
async function emitWorkplan(): Promise<void> {
  await ReactTestRenderer.act(async () => {
    for (const cb of listeners) cb({ type: 'workplan', sessionId: 's1' });
  });
  await flushAll();
}

function setTree(items: TreeItem[]): void {
  mockDbState.meta = {
    agentId: 'a1', sessionId: 's1', rev: '1', treeJson: JSON.stringify(items), updatedAt: '',
  };
}

/** 可见性哨兵：长条是否在树上（真机修复——显隐=语义挂载：挂载即可见即点得动，
 *  不再用 pointerEvents 切换：动画未生效时会留"看得见却点不动"的残影） */
function pillMounted(tree: ReactTestRenderer.ReactTestRenderer): boolean {
  return tree.root.findAll((n) => n.props?.accessibilityLabel === '工作计划进度，点按查看详情').length > 0;
}

async function renderPanel(sid: string): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(<WorkPlanPanel session={session} sessionId={sid} />);
  });
  await flushAll();
  return tree;
}

const findX = (tree: ReactTestRenderer.ReactTestRenderer) =>
  tree.root.findAll((n) => typeof n.props?.onPress === 'function' && n.props?.accessibilityLabel === '收起工作计划长条')[0]!;

test('组件：✕ 点击立即收摊；收摊后持续活跃不复现，出现新边沿才复现', async () => {
  jest.useFakeTimers();
  try {
    setTree(TREE_RUNNING);
    const tree = await renderPanel('s1');
    expect(pillMounted(tree)).toBe(true);

    await ReactTestRenderer.act(async () => {
      findX(tree).props.onPress();
    });
    // 点击即刻：语义隐藏（pointerEvents none）——不等 0.35s 过渡动画
    expect(pillMounted(tree)).toBe(false);

    // 持续进行中（同签名）：不复现
    await emitWorkplan();
    expect(pillMounted(tree)).toBe(false);

    // 新边沿：进行中行 1→2 → 复现
    setTree([...TREE_RUNNING, { id: 'b3', content: '任务三', status: 'in_progress', actor: 'explore·C' }]);
    await emitWorkplan();
    expect(pillMounted(tree)).toBe(true);

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  } finally {
    jest.useRealTimers();
  }
}, 20_000);

test('组件：亮起后转 settled 永驻展示（推进任意时长仍显示）；✕ 仍可收摊；新一轮活跃边沿复现', async () => {
  jest.useFakeTimers();
  try {
    setTree(TREE_RUNNING);
    const tree = await renderPanel('s1');
    expect(pillMounted(tree)).toBe(true);

    // 转全完成（settled）
    setTree([
      { id: 'b1', content: '任务一', status: 'completed', actor: 'explore·A' },
      { id: 'b2', content: '任务二', status: 'completed', actor: 'explore·B' },
    ]);
    await emitWorkplan();
    expect(pillMounted(tree)).toBe(true);

    // settled 永驻规格（2026-10-06）：推进远超旧 6s 收摊窗口的任意时长——仍展示（供回看）
    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(PILL_SETTLED_DISMISS_MS * 10);
    });
    expect(pillMounted(tree)).toBe(true);

    // 手动 ✕：立即收摊（settled 永驻规格下唯一人工退场口）
    await ReactTestRenderer.act(async () => {
      findX(tree).props.onPress();
    });
    expect(pillMounted(tree)).toBe(false);

    // 新一轮任务顶掉：新边沿（进行中 0→1）→ 复现
    setTree(TREE_RUNNING);
    await emitWorkplan();
    expect(pillMounted(tree)).toBe(true);

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  } finally {
    jest.useRealTimers();
  }
}, 20_000);

test('组件：切会话隔离（A 收摊不影响 B）；fresh 会话首见即亮（含 settled，永驻展示）', async () => {
  jest.useFakeTimers();
  try {
    setTree(TREE_RUNNING);
    const tree = await renderPanel('s1');
    expect(pillMounted(tree)).toBe(true);
    await ReactTestRenderer.act(async () => {
      findX(tree).props.onPress();
    });
    expect(pillMounted(tree)).toBe(false);

    // 切到 B 会话（fresh 状态）：A 的收摊标记不串，亮态照常展示
    await ReactTestRenderer.act(() => {
      tree.update(<WorkPlanPanel session={session} sessionId="s2" />);
    });
    await ReactTestRenderer.act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(pillMounted(tree)).toBe(true);

    // 切回 A：仍收摊（per-session 隔离）
    await ReactTestRenderer.act(() => {
      tree.update(<WorkPlanPanel session={session} sessionId="s1" />);
    });
    await ReactTestRenderer.act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(pillMounted(tree)).toBe(false);

    // fresh 会话 s3 + 全完成树：首见即亮（WorkPlanPanel 语义：工作计划是持久事实），settled 永驻不自动收摊
    setTree([
      { id: 'b1', content: '任务一', status: 'completed', actor: 'explore·A' },
      { id: 'b2', content: '任务二', status: 'completed', actor: 'explore·B' },
    ]);
    await ReactTestRenderer.act(() => {
      tree.update(<WorkPlanPanel session={session} sessionId="s3" />);
    });
    await ReactTestRenderer.act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(pillMounted(tree)).toBe(true);
    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(PILL_SETTLED_DISMISS_MS + 200);
    });
    expect(pillMounted(tree)).toBe(true); // settled 永驻规格：推进超 6s 仍展示

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  } finally {
    jest.useRealTimers();
  }
}, 20_000);

// ---------- 真机回归（2026-09-30 用户反馈）：全完成态“看得见却点不动、✕ 也关不掉” ----------
test('真机回归：全完成 settled 态长条可见即可点开；详情卡可关（显隐=挂载，不依赖动画/pointerEvents）', async () => {
  jest.useFakeTimers();
  try {
    setTree([
      { id: 'b1', content: '甲', status: 'completed' },
      { id: 'b2', content: '乙', status: 'completed' },
    ]);
    const tree = await renderPanel('s1');

    // 可见=已挂载（旧写法：常挂载 + pointerEvents none 切换 → 动画未生效时留不可点残影）
    expect(pillMounted(tree)).toBe(true);
    const pill = tree.root.findAll((n) => n.props?.accessibilityLabel === '工作计划进度，点按查看详情')[0]!;
    expect(typeof pill.props.onPress).toBe('function');

    // 点开：详情卡（收起 ⌄）在树上
    await ReactTestRenderer.act(async () => { pill.props.onPress(); });
    await flushAll();
    // findAll 会把 Pressable 的多层宿主节点都匹配上（>1 正常）——只取带 onPress 的那层
    const closeBtns = tree.root.findAll((n) => n.props?.accessibilityLabel === '收起详情卡');
    expect(closeBtns.length).toBeGreaterThan(0);
    const closeBtn = closeBtns.filter((n) => typeof n.props?.onPress === 'function');
    expect(closeBtn.length).toBeGreaterThan(0);

    // 关闭：收起 ⌄ 可用，详情卡卸载
    await ReactTestRenderer.act(async () => { closeBtn[0]!.props.onPress(); });
    await flushAll();
    expect(tree.root.findAll((n) => n.props?.accessibilityLabel === '收起详情卡').length).toBe(0);

    await ReactTestRenderer.act(() => { tree.unmount(); });
  } finally {
    jest.useRealTimers();
  }
}, 20_000);
