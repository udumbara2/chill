/**
 * triageLogic 测试（改进提案点选裁决卡纯逻辑）：
 * - validateTriageCard 形状校验（失败 → null 落回文本问答卡；迭代 2 起 entries/batch 在场即校验——
 *   entry 的 title/n 是寻址键，重复或畸形整卡拒绝）
 * - 决策 reducer 双层语义（簇级/单条 toggle 再点取消、异动作覆盖）与覆盖规则
 *   （单条选择清簇级、簇级选择清该簇全部单条）
 * - compileDecisions 双形态混排（text 动词与 core parseDecisionInput 语法表逐一对齐，
 *   簇级用簇标识/单条用编号 n；decisions 簇级 clusterId / 单条 title 平铺）
 */
import type { AskTriageCard } from '../src/relay/envelope';
import {
  appendAnswerTrail,
  clearSelections,
  compileAnswerTrail,
  compileDecisions,
  countSelected,
  DECIDED_LABEL,
  migratePage,
  selectAllClusters,
  toggleCluster,
  toggleEntry,
  validateTriageCard,
  type TriageState,
} from '../src/screens/triageLogic';

function makeCard(): AskTriageCard {
  return {
    digest: '近7天新增 5 · 待确认 8 条 / 3 簇',
    clusters: [
      {
        id: 'C26',
        name: '工具调用精简',
        count: 3,
        recent: 3,
        difficulty: '低',
        latest: '2026-09-28',
        entries: [
          { n: 1, title: '工具激活检索一次命中', reason: '首轮并行调用两次 search_tools', difficulty: '低', benefit: '高', source: '会话 #2kt5wo' },
          { n: 2, title: '委派失败自动降级重试' },
          { n: 3, title: '长会话自动摘要卡片' },
        ],
      },
      {
        id: 'C22',
        name: '健壮性与异常处理',
        count: 3,
        recent: 2,
        latest: '2026-09-27',
        entries: [{ n: 4, title: 'relay 断连离线消息补发提示', reason: '断连时发送的消息静默排队' }],
      },
      {
        id: '__ungrouped__',
        name: '未分组',
        count: 2,
        recent: 0,
        latest: '',
        entries: [{ n: 7, title: '配对二维码大字号模式' }],
      },
    ],
  };
}

describe('validateTriageCard', () => {
  it('合法载荷通过（原样返回；含 entries）', () => {
    const card = makeCard();
    expect(validateTriageCard(card)).toBe(card);
  });

  it('无 entries 的纯簇摘要卡通过（迭代 1 形态兼容）', () => {
    const card = makeCard();
    for (const c of card.clusters) delete c.entries;
    expect(validateTriageCard(card)).toBe(card);
  });

  it('batch 游标合法形状通过', () => {
    const card = { ...makeCard(), batch: { offset: 20, total: 23 } };
    expect(validateTriageCard(card)).toBe(card);
  });

  it('difficulty 可缺省', () => {
    const card = makeCard();
    delete card.clusters[0]!.difficulty;
    expect(validateTriageCard(card)).toBe(card);
  });

  it.each([null, undefined, 42, 'x', true, []])('非对象 → null（%p）', (v) => {
    expect(validateTriageCard(v)).toBeNull();
  });

  it('digest 缺失/空白 → null', () => {
    expect(validateTriageCard({ ...makeCard(), digest: '' })).toBeNull();
    expect(validateTriageCard({ ...makeCard(), digest: '   ' })).toBeNull();
    const noDigest: Record<string, unknown> = { ...makeCard() };
    delete noDigest.digest;
    expect(validateTriageCard(noDigest)).toBeNull();
  });

  it('clusters 缺失/空数组 → null', () => {
    expect(validateTriageCard({ digest: 'd' })).toBeNull();
    expect(validateTriageCard({ digest: 'd', clusters: [] })).toBeNull();
  });

  it.each(['id', 'name', 'count', 'recent', 'latest'])('簇字段 %s 缺失 → null', (field) => {
    const card = makeCard();
    delete (card.clusters[1] as unknown as Record<string, unknown>)[field];
    expect(validateTriageCard(card)).toBeNull();
  });

  it('簇字段类型错误 → null', () => {
    const card = makeCard();
    (card.clusters[0] as unknown as Record<string, unknown>).count = '3';
    expect(validateTriageCard(card)).toBeNull();
  });

  it('簇 id 重复 → null（点选寻址歧义，整卡拒绝）', () => {
    const card = makeCard();
    card.clusters[1]!.id = 'C26';
    expect(validateTriageCard(card)).toBeNull();
  });

  it('difficulty 非法值 → null', () => {
    const card = makeCard();
    (card.clusters[0] as unknown as Record<string, unknown>).difficulty = '极高';
    expect(validateTriageCard(card)).toBeNull();
  });

  // ---------- entries 形状校验（迭代 2） ----------

  it('entries 非数组 → null', () => {
    const card = makeCard();
    (card.clusters[0] as unknown as Record<string, unknown>).entries = 'x';
    expect(validateTriageCard(card)).toBeNull();
  });

  it.each([
    ['n 缺失', { title: '某条' }],
    ['n 非正整数', { n: 0, title: '某条' }],
    ['n 非整数', { n: 1.5, title: '某条' }],
    ['title 空串', { n: 9, title: '' }],
    ['可选字段非字符串', { n: 9, title: '某条', reason: 42 }],
  ])('entry %s → null', (_label, entry) => {
    const card = makeCard();
    card.clusters[0]!.entries = [entry as never];
    expect(validateTriageCard(card)).toBeNull();
  });

  it('entry title 全卡重复 → null（结构化匹配键歧义）', () => {
    const card = makeCard();
    card.clusters[1]!.entries = [{ n: 9, title: '委派失败自动降级重试' }];
    expect(validateTriageCard(card)).toBeNull();
  });

  it('entry n 全卡重复 → null（文本编号寻址歧义）', () => {
    const card = makeCard();
    card.clusters[1]!.entries = [{ n: 1, title: '另一条' }];
    expect(validateTriageCard(card)).toBeNull();
  });

  it('空 entries 数组合法（仅标题档的边界形态）', () => {
    const card = makeCard();
    card.clusters[2]!.entries = [];
    expect(validateTriageCard(card)).toBe(card);
  });

  // ---------- batch 游标校验（迭代 2） ----------

  it.each([
    ['非对象', 'x'],
    ['offset 缺失', { total: 5 }],
    ['负数', { offset: -1, total: 5 }],
    ['非整数', { offset: 0.5, total: 5 }],
  ])('batch %s → null', (_label, batch) => {
    expect(validateTriageCard({ ...makeCard(), batch: batch as never })).toBeNull();
  });

  // ---------- batch 真实页码（pageIndex/pageCount，布局前置） ----------

  it('batch pageIndex/pageCount 合法非负整数通过', () => {
    const card = { ...makeCard(), batch: { offset: 0, total: 7, pageIndex: 1, pageCount: 3 } };
    expect(validateTriageCard(card)).toBe(card);
  });

  it.each([
    ['pageIndex 非整数', { offset: 0, total: 7, pageIndex: 0.5, pageCount: 3 }],
    ['pageIndex 负数', { offset: 0, total: 7, pageIndex: -1, pageCount: 3 }],
    ['pageCount 非整数', { offset: 0, total: 7, pageIndex: 0, pageCount: 1.5 }],
    ['pageCount 非数字', { offset: 0, total: 7, pageIndex: 0, pageCount: '3' }],
  ])('batch %s → null', (_label, batch) => {
    expect(validateTriageCard({ ...makeCard(), batch: batch as never })).toBeNull();
  });

  // ---------- inplace / decided（单卡原地翻页） ----------

  it('inplace 合法布尔通过；非布尔 → null', () => {
    const withFlag = { ...makeCard(), inplace: true };
    expect(validateTriageCard(withFlag)).toBe(withFlag);
    expect(validateTriageCard({ ...makeCard(), inplace: 'yes' as never })).toBeNull();
  });

  it('entry decided 合法动作通过；非法值 → null', () => {
    const card = makeCard();
    card.clusters[0]!.entries![0]!.decided = 'confirm';
    expect(validateTriageCard(card)).toBe(card);
    const bad = makeCard();
    bad.clusters[0]!.entries![0]!.decided = 'maybe' as never;
    expect(validateTriageCard(bad)).toBeNull();
  });
});

describe('决策 reducer（双层）', () => {
  const card = makeCard();

  it('簇级 toggle：未选 → 选中；同动作再点 = 取消；异动作 = 覆盖', () => {
    const s1 = toggleCluster(clearSelections(), card, 'C26', 'confirm');
    expect(s1.clusters).toEqual({ C26: 'confirm' });
    const s2 = toggleCluster(s1, card, 'C26', 'confirm');
    expect(s2.clusters).toEqual({});
    const s3 = toggleCluster(s1, card, 'C26', 'close');
    expect(s3.clusters).toEqual({ C26: 'close' });
  });

  it('单条 toggle：未选 → 选中；同动作再点 = 取消；异动作 = 覆盖', () => {
    const s1 = toggleEntry(clearSelections(), 'C26', '委派失败自动降级重试', 'skip');
    expect(s1.entries).toEqual({ 委派失败自动降级重试: 'skip' });
    const s2 = toggleEntry(s1, 'C26', '委派失败自动降级重试', 'skip');
    expect(s2.entries).toEqual({});
    const s3 = toggleEntry(s1, 'C26', '委派失败自动降级重试', 'confirm');
    expect(s3.entries).toEqual({ 委派失败自动降级重试: 'confirm' });
  });

  it('覆盖规则：单条选择清簇级（同簇）', () => {
    const s1 = toggleCluster(clearSelections(), card, 'C26', 'confirm');
    const s2 = toggleEntry(s1, 'C26', '委派失败自动降级重试', 'close');
    expect(s2.clusters).toEqual({});
    expect(s2.entries).toEqual({ 委派失败自动降级重试: 'close' });
  });

  it('覆盖规则：单条选择不清其他簇的簇级', () => {
    const s1 = toggleCluster(clearSelections(), card, 'C22', 'confirm');
    const s2 = toggleEntry(s1, 'C26', '委派失败自动降级重试', 'close');
    expect(s2.clusters).toEqual({ C22: 'confirm' });
    expect(s2.entries).toEqual({ 委派失败自动降级重试: 'close' });
  });

  it('覆盖规则：簇级选择清该簇全部单条', () => {
    let s = toggleEntry(clearSelections(), 'C26', '委派失败自动降级重试', 'close');
    s = toggleEntry(s, 'C26', '长会话自动摘要卡片', 'skip');
    s = toggleEntry(s, 'C22', 'relay 断连离线消息补发提示', 'confirm');
    s = toggleCluster(s, card, 'C26', 'confirm');
    expect(s.clusters).toEqual({ C26: 'confirm' });
    expect(s.entries).toEqual({ 'relay 断连离线消息补发提示': 'confirm' }); // 他簇单条保留
  });

  it('簇级取消（再点同动作）不清单条', () => {
    let s = toggleEntry(clearSelections(), 'C26', '委派失败自动降级重试', 'close');
    s = toggleCluster(s, card, 'C26', 'confirm'); // 清单条
    s = toggleCluster(s, card, 'C26', 'confirm'); // 取消簇级
    expect(s).toEqual({ clusters: {}, entries: {} });
  });

  it('toggle 不可变（不改原对象）', () => {
    const s: TriageState = { clusters: { C26: 'confirm' }, entries: {} };
    toggleEntry(s, 'C22', 'relay 断连离线消息补发提示', 'skip');
    expect(s).toEqual({ clusters: { C26: 'confirm' }, entries: {} });
  });

  it('selectAllClusters：本批全部簇置位，并清全部单条', () => {
    let s = toggleEntry(clearSelections(), 'C26', '委派失败自动降级重试', 'close');
    s = selectAllClusters(card, 'skip');
    expect(s).toEqual({ clusters: { C26: 'skip', C22: 'skip', __ungrouped__: 'skip' }, entries: {} });
  });

  it('clearSelections / countSelected', () => {
    expect(clearSelections()).toEqual({ clusters: {}, entries: {} });
    const s: TriageState = { clusters: { C26: 'confirm' }, entries: { t1: 'skip', t2: 'close' } };
    expect(countSelected(s)).toBe(3);
    expect(countSelected(clearSelections())).toBe(0);
  });
});

describe('compileDecisions 双形态混排', () => {
  const card = makeCard();

  it('空选择 → 空 text + 空 decisions（提交钮据此禁用）', () => {
    expect(compileDecisions(card, clearSelections())).toEqual({ text: '', decisions: [] });
  });

  it('动词映射与 parseDecisionInput 语法表逐一对齐：confirm→y / skip→s / close→del（簇级与单条同表）', () => {
    expect(compileDecisions(card, { clusters: { C26: 'confirm' }, entries: {} })).toEqual({
      text: 'y C26',
      decisions: [{ action: 'confirm', clusterId: 'C26' }],
    });
    expect(compileDecisions(card, { clusters: {}, entries: { 委派失败自动降级重试: 'skip' } })).toEqual({
      text: 's 2',
      decisions: [{ action: 'skip', title: '委派失败自动降级重试' }],
    });
    expect(compileDecisions(card, { clusters: {}, entries: { 委派失败自动降级重试: 'close' } }).text).toBe('del 2');
  });

  it('簇级 + 单条混排：text 如 "y C26 del C22 y 7"，decisions 平铺（clusterId / title 各自寻址）', () => {
    const r = compileDecisions(card, {
      clusters: { C26: 'confirm', C22: 'close' },
      entries: { 配对二维码大字号模式: 'confirm' },
    });
    expect(r.text).toBe('y C26 del C22 y 7');
    expect(r.decisions).toEqual([
      { action: 'confirm', clusterId: 'C26' },
      { action: 'close', clusterId: 'C22' },
      { action: 'confirm', title: '配对二维码大字号模式' },
    ]);
  });

  it('同簇多单条按卡内条目序产出', () => {
    const r = compileDecisions(card, {
      clusters: {},
      entries: { 长会话自动摘要卡片: 'skip', 工具激活检索一次命中: 'confirm' },
    });
    expect(r.text).toBe('y 1 s 3');
    expect(r.decisions).toEqual([
      { action: 'confirm', title: '工具激活检索一次命中' },
      { action: 'skip', title: '长会话自动摘要卡片' },
    ]);
  });

  it('未分组簇：text 回退组名全称寻址，decisions 保留哨兵 clusterId', () => {
    const r = compileDecisions(card, { clusters: { __ungrouped__: 'confirm' }, entries: {} });
    expect(r.text).toBe('y 未分组');
    expect(r.decisions).toEqual([{ action: 'confirm', clusterId: '__ungrouped__' }]);
  });

  it('簇级选中时其单条不产出（防御：与 reducer 不变量一致的簇级优先）', () => {
    const r = compileDecisions(card, {
      clusters: { C26: 'confirm' },
      entries: { 委派失败自动降级重试: 'close' }, // 手造的越界状态
    });
    expect(r.text).toBe('y C26');
    expect(r.decisions).toEqual([{ action: 'confirm', clusterId: 'C26' }]);
  });

  it('产出顺序 = 卡内簇序 → 簇内条目序（与点选先后无关，审计文本稳定）', () => {
    const a = compileDecisions(card, { clusters: { C22: 'skip' }, entries: { 工具激活检索一次命中: 'confirm' } });
    expect(a.text).toBe('y 1 s C22');
  });

  it('点选了卡内不存在的陈旧 clusterId/title 被忽略', () => {
    const r = compileDecisions(card, {
      clusters: { C99: 'confirm', C26: 'skip' },
      entries: { 不存在的标题: 'close' },
    });
    expect(r.text).toBe('s C26');
    expect(r.decisions).toEqual([{ action: 'skip', clusterId: 'C26' }]);
  });

  it('无 entries 的纯簇摘要卡照常编译（迭代 1 形态兼容）', () => {
    const plain = makeCard();
    for (const c of plain.clusters) delete c.entries;
    const r = compileDecisions(plain, { clusters: { C22: 'close' }, entries: {} });
    expect(r.text).toBe('del C22');
    expect(r.decisions).toEqual([{ action: 'close', clusterId: 'C22' }]);
  });
});

describe('簇 id 碰撞消歧后缀（C03#2 · 真机实测回归）', () => {
  const collided: AskTriageCard = {
    digest: '待确认 3 条 / 2 簇',
    clusters: [
      { id: 'C03', name: 'C03 search_tools批量检索与工具激活', count: 2, recent: 2, latest: '2026-09-29',
        entries: [{ n: 1, title: '碰撞甲1' }, { n: 2, title: '碰撞甲2' }] },
      { id: 'C03#2', name: 'C03 search_tools 批量检索与工具激活', count: 1, recent: 1, latest: '2026-09-29',
        entries: [{ n: 3, title: '碰撞乙1' }] },
    ],
  };

  it('validateTriageCard 接受消歧后的唯一 id（builder 保证唯一，校验保持不变）', () => {
    expect(validateTriageCard(collided)).not.toBeNull();
  });

  it('compileDecisions：# 后缀簇 id 跳过 text（parseDecisionInput 不可寻址），decisions 照常携带', () => {
    const r = compileDecisions(collided, { clusters: { C03: 'confirm', 'C03#2': 'close' }, entries: {} });
    expect(r.text).toBe('y C03'); // 只编译可寻址的首簇；C03#2 不进文本（防误寻址）
    expect(r.decisions).toEqual([
      { action: 'confirm', clusterId: 'C03' },
      { action: 'close', clusterId: 'C03#2' }, // 结构化字段原样携带，core 收口精确命中第二簇
    ]);
  });
});

describe('页态（单卡原地翻页）', () => {
  it('compileDecisions：decided 已决行不产出（只读，不可重复决策）', () => {
    const card = makeCard();
    card.clusters[0]!.entries![1]!.decided = 'close';
    const r = compileDecisions(card, {
      clusters: {},
      entries: { 委派失败自动降级重试: 'confirm', 长会话自动摘要卡片: 'skip' },
    });
    // n=2 已决：即使状态里有它的点选（防御）也不进 text/decisions
    expect(r.text).toBe('s 3');
    expect(r.decisions).toEqual([{ action: 'skip', title: '长会话自动摘要卡片' }]);
  });

  it('migratePage：换页清选择 + 本页编译片段入累计', () => {
    const mig = migratePage([], 'y C26 del 2');
    expect(mig.state).toEqual({ clusters: {}, entries: {} });
    expect(mig.trail).toEqual(['y C26 del 2']);
  });

  it('migratePage：本页无点选（空文本）不留下空段', () => {
    const mig = migratePage(['y C26'], '');
    expect(mig.trail).toEqual(['y C26']);
  });

  it('appendAnswerTrail：追加非空段、跳过空段、不可变', () => {
    const t0: string[] = [];
    const t1 = appendAnswerTrail(t0, 'y C26');
    const t2 = appendAnswerTrail(t1, '  ');
    const t3 = appendAnswerTrail(t2, 'del C22');
    expect(t0).toEqual([]);
    expect(t3).toEqual(['y C26', 'del C22']);
  });

  it('compileAnswerTrail：累计段+本页段按序拼接为收卷 answer；全空 → null', () => {
    expect(compileAnswerTrail(['y C26', 'del C22'], 'y 7')).toBe('y C26 del C22 y 7');
    expect(compileAnswerTrail(['y C26'], '')).toBe('y C26');
    expect(compileAnswerTrail([], 'y 7')).toBe('y 7');
    expect(compileAnswerTrail([], '')).toBeNull();
  });

  it('DECIDED_LABEL：三动作落定文案齐全', () => {
    expect(DECIDED_LABEL).toEqual({ confirm: '已确认', close: '已关闭', skip: '已跳过' });
  });
});
