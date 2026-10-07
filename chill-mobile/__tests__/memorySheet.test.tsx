/**
 * memorySheet.test.tsx — 记忆库管理手机侧行为（直记+事后治理）：
 * SessionSheet 记忆行目录门控与「N 新」值渲染；MemorySheet 命令流
 * （打开即 list+seen / items 渲染 NEW 徽标 / 搜索过滤 / show 详情 / 删除两段确认闭环）。
 * 纪律：值一律来自 cmdResult/cmd.state，手机不本地假落定——测试锁此红线。
 */
import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { Dimensions, Text } from 'react-native';
import SessionSheet from '../src/components/SessionSheet';
import MemorySheet from '../src/components/MemorySheet';
import type { RelaySession } from '../src/relay/session';
import type { CommandCatalogEntry, CommandStateSnapshot } from '../src/relay/envelope';

beforeAll(() => {
  jest.spyOn(Dimensions, 'get').mockReturnValue({ width: 412, height: 915, scale: 2, fontScale: 1 });
});

const CATALOG_WITH_MEMORY: CommandCatalogEntry[] = [
  { id: 'memory', title: '记忆', section: 'maintain', presentation: 'console-row', risk: 'instant', channel: 'fast' },
  { id: 'idea', title: '记个点子', section: 'maintain', presentation: 'input-morph', risk: 'input', channel: 'fast' },
];
const CATALOG_OLD: CommandCatalogEntry[] = [
  { id: 'idea', title: '记个点子', section: 'maintain', presentation: 'input-morph', risk: 'input', channel: 'fast' },
];

function state(over: Partial<CommandStateSnapshot> = {}): CommandStateSnapshot {
  return { sessionId: 's1', running: false, plan: false, model: null, front: null, goal: null, ctx: null, ...over };
}

function allTexts(root: ReactTestRenderer.ReactTestInstance): string[] {
  return root.findAll((n) => n.type === Text).map((n) => String(n.props.children));
}

// ==================== SessionSheet 记忆行 ====================

function renderSessionSheet(over: Partial<React.ComponentProps<typeof SessionSheet>> = {}) {
  const props: React.ComponentProps<typeof SessionSheet> = {
    visible: true,
    onClose: () => {},
    commandState: null,
    commandCatalog: CATALOG_WITH_MEMORY,
    onOpenHistory: () => {},
    onOpenMemory: () => {},
    ...over,
  };
  let tree!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    tree = ReactTestRenderer.create(<SessionSheet {...props} />);
  });
  return tree;
}

test('SessionSheet：目录含 memory 且注入入口 → 记忆行渲染，值=N 新（warn）', () => {
  const tree = renderSessionSheet({ commandState: state({ memoryNewCount: 3 }) });
  const texts = allTexts(tree.root);
  expect(texts.some((t) => t.includes('🧠 记忆'))).toBe(true);
  expect(texts.some((t) => t.includes('3 新'))).toBe(true);
});

test('SessionSheet：memoryNewCount=0 → 无新；缺省（旧桌面）→ 未同步', () => {
  const t1 = renderSessionSheet({ commandState: state({ memoryNewCount: 0 }) });
  expect(allTexts(t1.root).some((t) => t.includes('无新'))).toBe(true);
  const t2 = renderSessionSheet({ commandState: state() });
  expect(allTexts(t2.root).some((t) => t.includes('未同步'))).toBe(true);
});

test('SessionSheet：旧目录（无 memory 行）→ 记忆行不渲染（不存在而非禁用）', () => {
  const tree = renderSessionSheet({ commandCatalog: CATALOG_OLD });
  expect(allTexts(tree.root).some((t) => t.includes('🧠'))).toBe(false);
});

// ==================== MemorySheet 命令流 ====================

type CmdListener = (e: { type: string; ok?: boolean; data?: Record<string, unknown>; error?: { message?: string } }) => void;

function makeFakeSession() {
  const sent: Array<{ id: string; cmd: string; args?: Record<string, unknown> }> = [];
  const listeners = new Set<CmdListener>();
  const emit = (e: Parameters<CmdListener>[0]) => {
    for (const fn of listeners) fn(e);
  };
  const session = {
    sent,
    emit,
    on: (fn: CmdListener) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    sendCmdRequest: async (id: string, cmd: string, args?: Record<string, unknown>) => {
      sent.push({ id, cmd, args });
    },
  } as unknown as RelaySession;
  return { session, sent, emit };
}

function renderMemorySheet(session: RelaySession) {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    tree = ReactTestRenderer.create(<MemorySheet visible={true} onClose={() => {}} session={session} />);
  });
  return tree;
}

test('MemorySheet：打开即 memory.list + memory.seen（巡检水位归零闭环）', () => {
  const { session, sent } = makeFakeSession();
  renderMemorySheet(session);
  const cmds = sent.map((s) => s.cmd);
  expect(cmds).toContain('memory.list');
  expect(cmds).toContain('memory.seen');
});

test('MemorySheet：items 应答渲染条目与 NEW 徽标；搜索过滤', () => {
  const { session, emit } = makeFakeSession();
  const tree = renderMemorySheet(session);
  act(() => {
    emit({
      type: 'cmdResult',
      ok: true,
      data: {
        items: [
          { name: '搜索偏好', type: 'user', hook: '用 tavily 搜索', importance: 5, updated_at: '2026-10-07T10:00:00.000Z', new: true },
          { name: '旧记忆', type: 'project', hook: '', importance: 4, updated_at: '2026-09-01T00:00:00.000Z', new: false },
        ],
        total: 2,
        newCount: 1,
      },
    });
  });
  let texts = allTexts(tree.root);
  expect(texts.some((t) => t.includes('搜索偏好'))).toBe(true);
  expect(texts.some((t) => t === 'NEW')).toBe(true);
  expect(texts.some((t) => t.includes('旧记忆'))).toBe(true);

  // 搜索过滤（act 内 setState flush）
  const input = tree.root.findByProps({ placeholder: '搜索标题 / 摘要…' });
  act(() => {
    input.props.onChangeText('搜索');
  });
  texts = allTexts(tree.root);
  expect(texts.some((t) => t.includes('搜索偏好'))).toBe(true);
  expect(texts.some((t) => t.includes('旧记忆'))).toBe(false);
});

test('MemorySheet：show 应答展开详情；删除两段确认闭环（确认→memory.delete→deleted 应答移除）', () => {
  const { session, sent, emit } = makeFakeSession();
  const tree = renderMemorySheet(session);
  act(() => {
    emit({
      type: 'cmdResult',
      ok: true,
      data: {
        items: [{ name: '待删记忆', type: 'feedback', hook: '', importance: 5, updated_at: '2026-10-07T10:00:00.000Z', new: true }],
      },
    });
  });
  // 点条目 → memory.show 请求 → entry 应答展开详情（按 Pressable 含目标文本定位行）
  const row = tree.root
    .findAll((n) => typeof n.props.onPress === 'function')
    .find((n) => allTexts(n).some((t) => String(t).includes('待删记忆')));
  expect(row).toBeTruthy();
  act(() => {
    row!.props.onPress();
  });
  expect(sent.some((s) => s.cmd === 'memory.show' && s.args?.title === '待删记忆')).toBe(true);
  act(() => {
    emit({
      type: 'cmdResult',
      ok: true,
      data: {
        entry: { name: '待删记忆', type: 'feedback', hook: '', importance: 5, updated_at: '2026-10-07T10:00:00.000Z', new: true, body: '正文全文', created_at: '2026-10-01T00:00:00.000Z', last_used_at: '2026-10-07T00:00:00.000Z', usage_count: 2 },
      },
    });
  });
  expect(allTexts(tree.root).some((t) => t.includes('正文全文'))).toBe(true);

  // 点「删除该记忆」→ 本地确认弹层（不先发命令）
  const delBtn = tree.root.findByProps({ accessibilityLabel: '删除记忆 待删记忆' });
  act(() => {
    delBtn.props.onPress();
  });
  expect(sent.some((s) => s.cmd === 'memory.delete')).toBe(false);
  expect(allTexts(tree.root).some((t) => t.includes('不可撤销'))).toBe(true);

  // 确认 → 发 memory.delete → deleted 应答 → 条目移除 + 弹层收起
  const goBtn = tree.root.findByProps({ accessibilityLabel: undefined }).findAll; // 占位——下方直接找「删除」确认按钮文本
  const confirmGo = tree.root.findAll((n) => n.type === Text && String(n.props.children) === '删除' && n.props.style?.color === '#fff');
  expect(confirmGo.length).toBeGreaterThan(0);
  act(() => {
    confirmGo[0]!.parent!.parent!.parent!.props.onPress();
  });
  expect(sent.some((s) => s.cmd === 'memory.delete' && s.args?.title === '待删记忆')).toBe(true);
  act(() => {
    emit({ type: 'cmdResult', ok: true, data: { deleted: '待删记忆' } });
  });
  expect(allTexts(tree.root).some((t) => t.includes('待删记忆'))).toBe(false);
  expect(allTexts(tree.root).some((t) => t.includes('不可撤销'))).toBe(false);
});
