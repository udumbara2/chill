/**
 * workPlan 视图模型单测（迭代 2 双源树）：syncUiLogic 长条形态（含"子任务/任务"前缀、待认领灰调、
 * 面包屑叶子焦点）/ sheet 元信息 / 行视图（cancelled 灰态、needsYou 相位、待认领徽章、children 嵌套）。
 * 纯函数零渲染（组件零判定的另一半证据）。
 */
import {
  workPlanCountPrefix,
  workPlanRowView,
  workPlanSheetMeta,
  workPlanStripView,
  workPlanStripVisible,
} from '../src/screens/syncUiLogic';
import type { WorkPlanItemWire } from '../src/relay/envelope';

function item(id: string, status: WorkPlanItemWire['status'], over: Partial<WorkPlanItemWire> = {}): WorkPlanItemWire {
  return { id, content: `事项${id}`, status, ...over };
}

// ---------- 计数前缀（象限判定） ----------

test('前缀判定：顶层全带 actor=看板源 →「子任务」；有清单项 →「任务」', () => {
  expect(workPlanCountPrefix([item('a', 'pending', { actor: '待认领' })])).toBe('子任务');
  expect(workPlanCountPrefix([item('a', 'in_progress', { actor: 'explore·A' }), item('b', 'completed', { actor: 'coder·B' })])).toBe('子任务');
  expect(workPlanCountPrefix([item('a', 'pending')])).toBe('任务');
  // 混合（清单项 + 根层看板行）→ 任务（有清单即象限 2/3）
  expect(workPlanCountPrefix([item('a', 'pending'), item('b', 'pending', { actor: '待认领' })])).toBe('任务');
  expect(workPlanCountPrefix([])).toBe('任务');
});

// ---------- 长条形态 ----------

test('空树：长条不渲染（场景 11）', () => {
  const v = workPlanStripView([]);
  expect(v.visible).toBe(false);
  expect(v.text).toBe('');
});

test('纯待办清单：静态图标 +「任务 0/y · 下一项：{首个 pending}」（场景 1）', () => {
  const v = workPlanStripView([item('a', 'pending'), item('b', 'pending', { content: '写周报' })]);
  expect(v.visible).toBe(true);
  expect(v.spinning).toBe(false); // 没人在跑不装跑（不变量 ②）
  expect(v.muted).toBe(false);
  expect(v.done).toBe(false);
  expect(v.text).toBe('任务 0/2 · 下一项：事项a'); // 首个 pending=协议序第一
});

test('有进行中：spinner +「任务 x/y · 正在做：{焦点叶子}」（进度报顶层）', () => {
  const v = workPlanStripView([
    item('a', 'completed'),
    item('b', 'in_progress', { content: '对比定价策略' }),
    item('c', 'pending'),
  ]);
  expect(v.visible).toBe(true);
  expect(v.spinning).toBe(true);
  expect(v.done).toBe(false);
  expect(v.text).toBe('任务 1/3 · 正在做：对比定价策略');
});

test('有链树：面包屑=父项 › 正在做：子项（成员）；core 派生的 in_progress 父项不抢焦点（活动报叶子）', () => {
  const v = workPlanStripView([
    item('p', 'in_progress', {
      content: '竞品调研',
      children: [item('c', 'in_progress', { content: '对比定价策略', actor: '分析师' })],
    }),
  ]);
  expect(v.spinning).toBe(true);
  expect(v.text).toBe('任务 0/1 · 竞品调研 › 正在做：对比定价策略（分析师）');
});

test('无进行中但有失败：红字警示「任务 x/y ·「{failed 项}」失败」（警示非中断）', () => {
  const v = workPlanStripView([
    item('a', 'completed'),
    item('b', 'failed', { content: '对比定价' }),
    item('c', 'pending'),
  ]);
  expect(v.visible).toBe(true);
  expect(v.failed).toBe(true);
  expect(v.spinning).toBe(false);
  expect(v.text).toBe('任务 1/3 · 「对比定价」失败');
});

test('失败 + 进行中并存：运行中形态优先（失败不中断）', () => {
  const v = workPlanStripView([item('a', 'failed'), item('b', 'in_progress', { content: '继续推进' })]);
  expect(v.spinning).toBe(true);
  expect(v.failed).toBe(false);
  expect(v.text).toBe('任务 0/2 · 正在做：继续推进');
});

test('全部完成：绿底「✓ y/y · 工作计划全部完成」（场景 9）；看板源则「子任务全部完成」', () => {
  const v = workPlanStripView([item('a', 'completed'), item('b', 'completed')]);
  expect(v.done).toBe(true);
  expect(v.text).toBe('✓ 2/2 · 工作计划全部完成');
  const vb = workPlanStripView([item('a', 'completed', { actor: 'explore·A' }), item('b', 'completed', { actor: 'coder·B' })]);
  expect(vb.done).toBe(true);
  expect(vb.text).toBe('✓ 2/2 · 子任务全部完成');
});

test('cancelled 是终态不挡收摊：completed+cancelled → 绿底完成态（取消不计入已完成数）', () => {
  const v = workPlanStripView([item('a', 'completed'), item('b', 'cancelled', { actor: 'explore·A' })]);
  expect(v.done).toBe(true);
  expect(v.text).toBe('✓ 1/2 · 工作计划全部完成');
});

test('needsYou 压顶：唯一中断信号（行级标记递归扫；带面包屑与成员）', () => {
  const v = workPlanStripView([
    item('p', 'in_progress', {
      content: '竞品调研',
      children: [item('c', 'failed', { content: '定价口径待确认', actor: '分析师', needsYou: true })],
    }),
  ]);
  expect(v.needsYou).toBe(true);
  expect(v.spinning).toBe(false); // needsYou 中断优先于运行中
  expect(v.text).toBe('要你做决定 · 竞品调研 › 定价口径待确认（分析师）');
});

test('看板全待认领：灰调「子任务 0/3 · 3 条等待认领」（场景 4；不冒充清单下一项）', () => {
  const v = workPlanStripView([
    item('a', 'pending', { actor: '待认领' }),
    item('b', 'pending', { actor: '待认领' }),
    item('c', 'pending', { actor: '待认领' }),
  ]);
  expect(v.visible).toBe(true);
  expect(v.spinning).toBe(false);
  expect(v.muted).toBe(true); // 灰调（静态灰点 + 灰文案）
  expect(v.text).toBe('子任务 0/3 · 3 条等待认领');
});

test('长文案语义截断（叶子 > 20 字截断带省略号）', () => {
  const long = '这是一个非常非常长的工作事项内容需要被截断处理';
  const v = workPlanStripView([item('a', 'in_progress', { content: long })]);
  expect(v.text).toBe(`任务 0/1 · 正在做：${long.slice(0, 20)}…`);
});

test('显隐（1.4 共存规则已退役）：树非空即候选可见，无 boardActive 维度', () => {
  expect(workPlanStripVisible([item('a', 'in_progress')])).toBe(true);
  expect(workPlanStripVisible([])).toBe(false);
});

// ---------- sheet 元信息 + 行视图 ----------

test('sheet 元信息：x/y 已完成（计数报顶层，与长条同源）', () => {
  const meta = workPlanSheetMeta([
    item('a', 'completed'),
    item('b', 'pending'),
    item('c', 'in_progress', { children: [item('c1', 'completed')] }), // 子项不计入顶层
  ]);
  expect(meta).toEqual({ total: 3, doneCount: 1 });
});

test('行视图：状态点映射 + completed 删除线/结果灰注 + failed 红注', () => {
  const doing = workPlanRowView(item('a', 'in_progress'));
  expect(doing.dotKind).toBe('doing');
  expect(doing.done).toBe(false);
  expect(doing.note).toBeNull();

  const todo = workPlanRowView(item('b', 'pending'));
  expect(todo.dotKind).toBe('todo');

  const done = workPlanRowView(item('c', 'completed', { result: '产出摘要' }));
  expect(done.dotKind).toBe('done');
  expect(done.done).toBe(true);
  expect(done.note).toBe('产出摘要');
  expect(done.noteFailed).toBe(false);

  const failed = workPlanRowView(item('d', 'failed', { result: '超时未响应' }));
  expect(failed.dotKind).toBe('dead');
  expect(failed.done).toBe(false);
  expect(failed.note).toBe('超时未响应');
  expect(failed.noteFailed).toBe(true);
});

test('行视图：cancelled 灰态（cancel 点 + 灰删除线；结果留痕灰注）', () => {
  const v = workPlanRowView(item('a', 'cancelled', { actor: 'explore·A', result: '已撤单' }));
  expect(v.dotKind).toBe('cancel');
  expect(v.cancelled).toBe(true);
  expect(v.done).toBe(false);
  expect(v.note).toBe('已撤单');
  expect(v.noteFailed).toBe(false);
  expect(v.badge).toEqual({ text: 'explore·A', color: 'muted' }); // 终态徽章绿灰
});

test('行视图：看板行徽章与相位（待认领 muted 灰芯片 / needsYou amber / coder teal）', () => {
  const unclaimed = workPlanRowView(item('a', 'pending', { actor: '待认领', needsYou: true }));
  expect(unclaimed.badge).toEqual({ text: '待认领', color: 'muted' });
  expect(unclaimed.needsYou).toBe(true);

  const blocked = workPlanRowView(item('b', 'failed', { actor: '分析师', needsYou: true, note: '受阻：等拍板' }));
  expect(blocked.badge).toEqual({ text: '分析师', color: 'amber' }); // needsYou=琥珀徽章
  expect(blocked.note).toBe('受阻：等拍板'); // 受阻原因小注（wire.note；failed 无 result 时兜底）
  expect(blocked.needsYou).toBe(true);

  const coder = workPlanRowView(item('c', 'in_progress', { actor: 'coder·B' }));
  expect(coder.badge).toEqual({ text: 'coder·B', color: 'teal' });

  const explore = workPlanRowView(item('d', 'in_progress', { actor: 'explore·A' }));
  expect(explore.badge).toEqual({ text: 'explore·A', color: 'indigo' });
});

test('行视图：有链嵌套（children 递归随行）+ 父项自动结项标注（core 投影派生）', () => {
  const parent = workPlanRowView(
    item('p', 'completed', {
      content: '竞品调研',
      note: '自动结项',
      children: [
        item('c1', 'completed', { content: '对比定价策略', actor: '分析师', result: '交付：对比表' }),
        item('c2', 'completed', { content: '收集用户评价', actor: 'explore·A' }),
      ],
    }),
  );
  expect(parent.dotKind).toBe('done');
  expect(parent.note).toBe('自动结项'); // 父项自动结项派生标注（终态小注=result ?? note）
  expect(parent.children.length).toBe(2);
  expect(parent.children[0]!.content).toBe('对比定价策略');
  expect(parent.children[0]!.badge).toEqual({ text: '分析师', color: 'muted' }); // 子行终态徽章
  expect(parent.children[0]!.note).toBe('交付：对比表');
  expect(parent.children[1]!.badge).toEqual({ text: 'explore·A', color: 'muted' }); // 看板行恒带 actor → 徽章必在
});

test('行视图：无链/断链看板行就是根层行（同一 workPlanRowView 渲染，无特殊分支——不猜父子）', () => {
  const rootRow = workPlanRowView(item('r', 'in_progress', { content: '无链看板行', actor: 'explore·A', note: '推进中' }));
  expect(rootRow.children).toEqual([]);
  expect(rootRow.dotKind).toBe('doing');
  expect(rootRow.note).toBe('推进中'); // 非终态=wire.note 直显（feed 兜底在组件侧）
  expect(rootRow.badge).toEqual({ text: 'explore·A', color: 'indigo' });
});
