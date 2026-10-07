/**
 * WorkPlanPanel 弹层开合 + 位移数值回归（真机 bug：点「详情 ›」详情卡不升起；自 BoardPanel 同款红线移植）。
 * 根因：sheet translateY 用字符串 outputRange ['100%','0%'] + useNativeDriver——Android 原生
 * 插值节点对字符串只写 objectValue、nodeValue 恒 NaN，transform 节点取 getValue() 得 NaN，
 * 弹层永不升起。锁两条红线：
 * ① 开合可见性不依赖动画完成态（点按即挂载/收起即卸载）；
 * ② sheet 位移必须是数值 outputRange（经 __getNativeConfig 即原生驱动实际下发的配置验证）。
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { StyleSheet } from 'react-native';

const TREE = [
  {
    id: 'b1',
    content: '读取桌面文件和子文件夹介绍',
    status: 'in_progress',
    actor: 'explore·A',
  },
];

const mockDbState: {
  meta: { agentId: string; sessionId: string; rev: string; treeJson: string; updatedAt: string } | null;
  boardRows: unknown[];
} = {
  meta: {
    agentId: 'a1',
    sessionId: 's1',
    rev: '1',
    treeJson: JSON.stringify(TREE),
    updatedAt: '2026-09-30T00:00:00.000Z',
  },
  boardRows: [],
};

jest.mock('../src/db/syncDb', () => ({
  getSyncDb: () => ({
    getWorkPlanMeta: async () => mockDbState.meta,
    listBoardItems: async () => mockDbState.boardRows,
  }),
}));

import { WorkPlanPanel } from '../src/components/WorkPlanPanel';
import type { RelaySession } from '../src/relay/session';

const session = {
  getAgentId: () => 'a1',
  on: () => () => {},
  getFeedFacts: () => [],
  getCommandCatalog: () => null, // C 迭代：canDetail 门控读取（null=目录未同步，行不可点）
} as unknown as RelaySession;

/** 找到弹层 sheet 节点（高度 68% 唯一）并取出 translateY 动画节点 */
function findSheetTranslateY(tree: ReactTestRenderer.ReactTestRenderer) {
  const sheet = tree.root.findAll((n) => {
    const s = StyleSheet.flatten((n.props?.style ?? null) as never);
    return typeof s === 'object' && s !== null && (s as { height?: unknown }).height === '68%';
  })[0];
  if (!sheet) return null;
  const flat = StyleSheet.flatten((sheet.props.style ?? null) as never) as {
    transform?: Array<{ translateY?: { __getNativeConfig?: () => { outputRange?: unknown[] } } }>;
  };
  return flat.transform?.[0]?.translateY ?? null;
}

test('点长条升起详情卡、收起恢复（可见性不依赖动画完成态）', async () => {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(<WorkPlanPanel session={session} sessionId="s1" />);
  });
  // 等 reload 落定（异步读树副本）
  await ReactTestRenderer.act(async () => {
    await Promise.resolve();
  });
  const before = JSON.stringify(tree.toJSON());
  expect(before).toContain('详情 ›');
  expect(before).toContain('子任务 0/1 · 正在做：读取桌面文件和子文件夹介绍（explore·A）');
  expect(before).not.toContain(' 已完成'); // 收起态：弹层不挂载（sheet 头计数不在）

  // 点长条（Animated.timing 未跑完也必须升起——开合只由 open 布尔决定）
  const pill = tree.root.findAll(
    (n) => typeof n.props?.onPress === 'function' && n.props?.accessibilityLabel === '工作计划进度，点按查看详情',
  )[0]!;
  await ReactTestRenderer.act(async () => {
    pill.props.onPress();
  });
  const opened = JSON.stringify(tree.toJSON());
  expect(opened).toContain(' 已完成'); // 详情卡挂载（sheet 头计数）
  expect(opened).toContain('读取桌面文件和子文件夹介绍');
  expect(opened).toContain('explore·A'); // 成员徽章
  expect(opened).not.toContain('详情 ›'); // 卡开长条整条退场

  // 收起：长条恢复、弹层卸载
  const close = tree.root.findAll(
    (n) => typeof n.props?.onPress === 'function' && n.props?.accessibilityLabel === '收起详情卡',
  )[0]!;
  await ReactTestRenderer.act(async () => {
    close.props.onPress();
  });
  const closed = JSON.stringify(tree.toJSON());
  expect(closed).not.toContain(' 已完成');
  expect(closed).toContain('详情 ›');

  await ReactTestRenderer.act(() => {
    tree.unmount(); // 释放动画句柄（红线测试不残留计时器）
  });
}, 15_000);

test('sheet 位移是数值 outputRange（字符串会让原生驱动拿到 NaN——真机弹层不升起的根因）', async () => {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(<WorkPlanPanel session={session} sessionId="s1" />);
  });
  await ReactTestRenderer.act(async () => {
    await Promise.resolve();
  });
  const pill = tree.root.findAll(
    (n) => typeof n.props?.onPress === 'function' && n.props?.accessibilityLabel === '工作计划进度，点按查看详情',
  )[0]!;
  await ReactTestRenderer.act(async () => {
    pill.props.onPress();
  });

  const ty = findSheetTranslateY(tree);
  expect(ty).not.toBeNull();
  // 原生驱动实际下发的插值配置：outputRange 逐值必须是 number
  //（'100%' 会经 transformDataType 原样穿透 → Kotlin 节点 nodeValue=NaN → transform=NaN）
  const cfg = ty!.__getNativeConfig!();
  expect(Array.isArray(cfg.outputRange)).toBe(true);
  for (const v of cfg.outputRange!) {
    expect(typeof v).toBe('number');
  }

  // onLayout 量高后：起始位移 = 实测弹层高度（数值）
  const sheet = tree.root.findAll((n) => typeof n.props?.onLayout === 'function' && StyleSheet.flatten((n.props?.style ?? null) as never)?.height === '68%')[0]!;
  await ReactTestRenderer.act(async () => {
    sheet.props.onLayout({ nativeEvent: { layout: { height: 420 } } });
  });
  const cfg2 = findSheetTranslateY(tree)!.__getNativeConfig!();
  expect(cfg2.outputRange![0]).toBe(420);
  expect(cfg2.outputRange![1]).toBe(0);

  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
}, 15_000);
