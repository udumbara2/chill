/**
 * hostToggleUi.test.ts — 宿主级开关（desktop.set / autoswitch.set）手机侧行为：
 * 纯逻辑（值映射 undefined≠false / 徽标显隐 / 点按目标态）+ SessionSheet 两行目录门控与值渲染。
 * 纪律：值一律来自 cmd.state 宿主标量（latest-wins 落定），手机不本地假落定——测试锁此红线。
 */
import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { Text, Dimensions } from 'react-native';
import { hostToggleValue, desktopBadgeVisible, hostToggleNext } from '../src/screens/hostToggleUi';
import SessionSheet from '../src/components/SessionSheet';
import type { CommandCatalogEntry, CommandStateSnapshot } from '../src/relay/envelope';

// SessionSheet 的开合动画插值用 Dimensions.get('window').height 作回退 outputRange——jest 环境给真值防 layout 崩
beforeAll(() => {
  jest.spyOn(Dimensions, 'get').mockReturnValue({ width: 412, height: 915, scale: 2, fontScale: 1 });
});

const CATALOG_WITH: CommandCatalogEntry[] = [
  { id: 'desktop.set', title: '桌面能力', section: 'maintain', presentation: 'console-row', risk: 'confirm', channel: 'serial' },
  { id: 'autoswitch.set', title: '自动切换', section: 'maintain', presentation: 'console-row', risk: 'instant', channel: 'fast' },
];
const CATALOG_OLD: CommandCatalogEntry[] = [{ id: 'idea', title: '记个点子', section: 'maintain', presentation: 'input-morph', risk: 'input', channel: 'fast' }];

function state(over: Partial<CommandStateSnapshot> = {}): CommandStateSnapshot {
  return { sessionId: 's1', running: false, plan: false, model: null, front: null, goal: null, ctx: null, ...over };
}

/** 收集渲染树全部文本（行值断言用） */
function allTexts(root: ReactTestRenderer.ReactTestInstance): string[] {
  return root.findAll((n) => n.type === Text).map((n) => String(n.props.children));
}

function renderSheet(over: Partial<React.ComponentProps<typeof SessionSheet>> = {}) {
  const props: React.ComponentProps<typeof SessionSheet> = {
    visible: true,
    onClose: () => {},
    commandState: null,
    commandCatalog: null,
    onOpenHistory: () => {},
    onToggleDesktop: () => {},
    onToggleAutoSwitch: () => {},
    ...over,
  };
  let tree!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    tree = ReactTestRenderer.create(<SessionSheet {...props} />);
  });
  return tree;
}

// ==================== 纯逻辑 ====================

test('hostToggleValue：undefined=未同步（未知≠已关）；true/false=开/关', () => {
  expect(hostToggleValue(undefined)).toBe('未同步');
  expect(hostToggleValue(true)).toBe('开');
  expect(hostToggleValue(false)).toBe('关');
});

test('desktopBadgeVisible：仅明确开启时常驻（安全感知红线）', () => {
  expect(desktopBadgeVisible(null)).toBe(false);
  expect(desktopBadgeVisible(state({ desktop: undefined }))).toBe(false);
  expect(desktopBadgeVisible(state({ desktop: false }))).toBe(false);
  expect(desktopBadgeVisible(state({ desktop: true }))).toBe(true);
});

test('hostToggleNext：未知/已关 → 开；仅明确为开 → 关', () => {
  expect(hostToggleNext(undefined)).toBe(true);
  expect(hostToggleNext(false)).toBe(true);
  expect(hostToggleNext(true)).toBe(false);
});

// ==================== SessionSheet 两行（目录门控 + 值渲染） ====================

test('目录含两命令且注入入口 → 维护节渲染两行，值随 cmd.state 宿主标量', () => {
  const tree = renderSheet({ commandCatalog: CATALOG_WITH, commandState: state({ desktop: true, autoswitch: false }) });
  const texts = allTexts(tree.root);
  const joined = texts.join('|');
  expect(joined).toContain('🖥️ 桌面能力');
  expect(joined).toContain('自动切换');
  // 值渲染：desktop=true→开、autoswitch=false→关（cmd.state 落定，标题与值同面板联立断言）
  expect(joined).toContain('开');
  expect(joined).toContain('关');
  tree.unmount();
});

test('旧桌面（目录无两命令）→ 两行不渲染（入口不存在而非禁用）', () => {
  const tree = renderSheet({ commandCatalog: CATALOG_OLD, commandState: state({ desktop: true }) });
  const joined = allTexts(tree.root).join('|');
  expect(joined).not.toContain('🖥️ 桌面能力');
  expect(joined).not.toContain('自动切换');
  tree.unmount();
});

test('快照宿主标量缺省（undefined）→ 行渲染但值"未同步"（不假落定为关）', () => {
  const tree = renderSheet({ commandCatalog: CATALOG_WITH, commandState: state({ desktop: undefined, autoswitch: undefined }) });
  const texts = allTexts(tree.root);
  expect(texts.filter((t) => t === '未同步').length).toBeGreaterThanOrEqual(2);
  tree.unmount();
});

test('目录有命令但未注入入口（onToggleX 缺省）→ 该行不出现（照 idea/improve 同闸先例）', () => {
  const tree = renderSheet({ commandState: state({ desktop: true }), commandCatalog: CATALOG_WITH, onToggleDesktop: undefined, onToggleAutoSwitch: () => {} });
  const joined = allTexts(tree.root).join('|');
  expect(joined).not.toContain('🖥️ 桌面能力');
  expect(joined).toContain('自动切换');
  tree.unmount();
});
