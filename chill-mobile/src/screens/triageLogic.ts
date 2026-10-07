/**
 * triageLogic.ts — 手机端改进提案点选裁决卡纯逻辑（无 React/无 DB 依赖，jest 可单测）：
 * - validateTriageCard：ask.request card 字段形状校验（失败 → null，落回文本问答卡）；
 *   迭代 2 起 entries/batch 不再是纯容忍——在场即校验形状（entry 的 title 是结构化匹配键、
 *   n 是文本语法编号，重复/畸形 = 寻址歧义，整卡拒绝落回文本卡）
 * - 决策 reducer（双层状态）：簇级 toggle / 单条 toggle（同动作再点=取消、异动作=覆盖）
 *   + 覆盖规则（单条选择清簇级、簇级选择清该簇全部单条——原型定稿语义）+ 本批批量 / 清空
 * - compileDecisions：双形态混排产出——text 用 parseDecisionInput 文本表层语法
 *   （y/s/del + 簇标识 / 单条编号 n；未分组簇无 C 编号，回退组名全称寻址；碰撞消歧的 # 后缀 id
 *   文本不可寻址——跳过 text 只走结构化），decisions 用账本词汇
 *   （簇级 {action, clusterId} / 单条 {action, title} 平铺）直达 core 结构化收口。
 *   两形态同源于同一份点选状态；产出顺序恒为卡内簇序→簇内条目序（审计文本稳定）。
 */
import type { AskDecisionEntry, AskTriageCard } from '../relay/envelope';

export type TriageAction = 'confirm' | 'close' | 'skip';

type TriageEntryWire = NonNullable<NonNullable<AskTriageCard['clusters']>[number]['entries']>[number];

/** 点选状态（Record 便于 React 不可变更新）：簇级 clusterId → 动作；单条 title → 动作（title=结构化匹配键） */
export interface TriageState {
  clusters: Record<string, TriageAction>;
  entries: Record<string, TriageAction>;
}

/** 「未分组」簇哨兵 id（core ImprovementProposalManager.UNGROUPED_CLUSTER_ID 同值，三处口径一致） */
const UNGROUPED_CLUSTER_ID = '__ungrouped__';

/** 动作 → 文本表层动词（与 core parseDecisionInput 的 DECISION_VERBS 语法表逐一对齐） */
const TEXT_VERB: Record<TriageAction, string> = { confirm: 'y', skip: 's', close: 'del' };

const DIFFICULTIES = new Set(['低', '中', '高']);

/** 动作合法值集（entry decided 标注校验用；与 TriageAction 词表同源） */
const ACTIONS_SET = new Set<string>(['confirm', 'close', 'skip']);

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/** 单条载荷形状（n=开庭快照下标+1；title=结构化匹配键；其余字段可选字符串；decided=已决标注） */
function isValidEntry(e: unknown): e is TriageEntryWire {
  if (e === null || typeof e !== 'object') return false;
  const w = e as Partial<TriageEntryWire> & Record<string, unknown>;
  if (!isPositiveInt(w.n)) return false;
  if (typeof w.title !== 'string' || w.title === '') return false;
  for (const k of ['reason', 'difficulty', 'benefit', 'source'] as const) {
    if (w[k] !== undefined && typeof w[k] !== 'string') return false;
  }
  if (w.decided !== undefined && !ACTIONS_SET.has(w.decided as string)) return false;
  return true;
}

/**
 * 卡载荷形状校验：任一字段不符 → null（渲染层落回 QuestionCard 文本卡，协议面零风险）。
 * entries 在场即逐条校验 + 全卡 title/n 去重（两者都是寻址键，重复=歧义整卡拒绝）；
 * batch 在场即校验 {offset,total} 非负整数。
 */
export function validateTriageCard(card: unknown): AskTriageCard | null {
  if (card === null || typeof card !== 'object') return null;
  const c = card as Partial<AskTriageCard>;
  if (typeof c.digest !== 'string' || c.digest.trim() === '') return null;
  if (!Array.isArray(c.clusters) || c.clusters.length === 0) return null;
  const ids = new Set<string>();
  const titles = new Set<string>();
  const nums = new Set<number>();
  for (const cl of c.clusters) {
    if (cl === null || typeof cl !== 'object') return null;
    if (typeof cl.id !== 'string' || cl.id === '') return null;
    if (ids.has(cl.id)) return null; // 簇 id 重复 = 点选寻址歧义，整卡拒绝
    ids.add(cl.id);
    if (typeof cl.name !== 'string') return null;
    if (typeof cl.count !== 'number' || !(cl.count >= 0)) return null;
    if (typeof cl.recent !== 'number' || !(cl.recent >= 0)) return null;
    if (typeof cl.latest !== 'string') return null;
    if (cl.difficulty !== undefined && !DIFFICULTIES.has(cl.difficulty)) return null;
    if (cl.entries !== undefined) {
      if (!Array.isArray(cl.entries)) return null;
      for (const e of cl.entries) {
        if (!isValidEntry(e)) return null;
        if (titles.has(e.title) || nums.has(e.n)) return null; // 匹配键/编号重复 = 寻址歧义
        titles.add(e.title);
        nums.add(e.n);
      }
    }
  }
  if (c.batch !== undefined) {
    if (c.batch === null || typeof c.batch !== 'object') return null;
    if (!isNonNegativeInt(c.batch.offset) || !isNonNegativeInt(c.batch.total)) return null;
    // 真实页码（布局前置后下发，additive）：在场即校验非负整数
    if (c.batch.pageIndex !== undefined && !isNonNegativeInt(c.batch.pageIndex)) return null;
    if (c.batch.pageCount !== undefined && !isNonNegativeInt(c.batch.pageCount)) return null;
  }
  if (c.inplace !== undefined && typeof c.inplace !== 'boolean') return null;
  return c as AskTriageCard;
}

/** 簇级三态点选：同动作再点 = 取消；异动作 = 覆盖（并清该簇全部单条——簇级选择覆盖单条） */
export function toggleCluster(
  state: TriageState,
  card: AskTriageCard,
  clusterId: string,
  action: TriageAction,
): TriageState {
  const clusters = { ...state.clusters };
  const entries = { ...state.entries };
  if (clusters[clusterId] === action) {
    delete clusters[clusterId];
    return { clusters, entries };
  }
  clusters[clusterId] = action;
  const cluster = card.clusters.find((c) => c.id === clusterId);
  for (const e of cluster?.entries ?? []) delete entries[e.title];
  return { clusters, entries };
}

/** 单条三态点选：同动作再点 = 取消；异动作 = 覆盖（并清所在簇的簇级选择——单条覆盖簇级） */
export function toggleEntry(
  state: TriageState,
  clusterId: string,
  title: string,
  action: TriageAction,
): TriageState {
  const clusters = { ...state.clusters };
  const entries = { ...state.entries };
  if (entries[title] === action) {
    delete entries[title];
    return { clusters, entries };
  }
  entries[title] = action;
  delete clusters[clusterId];
  return { clusters, entries };
}

/** 批量：本批全部簇置为同一动作（覆盖既有全部点选，含单条） */
export function selectAllClusters(card: AskTriageCard, action: TriageAction): TriageState {
  const clusters: Record<string, TriageAction> = {};
  for (const c of card.clusters) clusters[c.id] = action;
  return { clusters, entries: {} };
}

export function clearSelections(): TriageState {
  return { clusters: {}, entries: {} };
}

/** 已选计数（簇级 + 单条合计；提交钮文案/禁用态数据源） */
export function countSelected(state: TriageState): number {
  return Object.keys(state.clusters).length + Object.keys(state.entries).length;
}

/**
 * 编译提交载荷（双形态混排）：
 * - text：按卡内簇序拼接 `<动词> <簇标识>`（簇级）与 `<动词> <n>`（单条，n=快照编号）——
 *   旧桌面 parseDecisionInput 回退 + 人可读审计痕迹；未分组簇哨兵 id 不可寻址，回退组名全称
 * - decisions：簇级 {action, clusterId} 与单条 {action, title} 平铺（core 开庭收口各自展开/校验）
 * 同簇簇级与单条按 reducer 不变量互斥；此处仍防御性簇级优先（簇级选中时其单条不产出）。
 * 未点选的簇/条目两形态都不出现（未提及默认保留待确认）。
 */
export function compileDecisions(
  card: AskTriageCard,
  state: TriageState,
): { text: string; decisions: AskDecisionEntry[] } {
  const parts: string[] = [];
  const decisions: AskDecisionEntry[] = [];
  for (const c of card.clusters) {
    const clusterAction = state.clusters[c.id];
    if (clusterAction !== undefined) {
      // 碰撞消歧后缀 id（C03#2）文本语法不可寻址（parseDecisionInput 无此表层，已知边界）：
      // text 跳过该簇——若编译 `y C03#2`，parseDecisionInput 的簇解析会把它当无效目标或误配，
      // 而 decisions 结构化字段（clusterId 原样携带）在 core 收口精确命中，双通道语义保持正确
      if (!c.id.includes('#')) {
        parts.push(`${TEXT_VERB[clusterAction]} ${c.id === UNGROUPED_CLUSTER_ID ? c.name : c.id}`);
      }
      decisions.push({ action: clusterAction, clusterId: c.id });
      continue;
    }
    for (const e of c.entries ?? []) {
      if (e.decided !== undefined) continue; // 已决行（本庭已落账）只读，不可重复决策
      const entryAction = state.entries[e.title];
      if (entryAction === undefined) continue;
      parts.push(`${TEXT_VERB[entryAction]} ${e.n}`);
      decisions.push({ action: entryAction, title: e.title });
    }
  }
  return { text: parts.join(' '), decisions };
}

// ==================== 页态（单卡原地翻页：ask=一场开庭，页=庭内视图状态） ====================

/** 已决行的落定文案（entry.decided → 显示词；只读渲染用） */
export const DECIDED_LABEL: Record<TriageAction, string> = { confirm: '已确认', close: '已关闭', skip: '已跳过' };

/** 累计审计文本：追加一段翻页/收卷的编译片段（空段跳过；不可变） */
export function appendAnswerTrail(trail: string[], segment: string): string[] {
  const t = segment.trim();
  return t ? [...trail, t] : trail;
}

/** 收卷 answer 文本：累计段 + 本页编译段按序拼接；全空 → null（调用方走「跳过本轮」语义） */
export function compileAnswerTrail(trail: string[], currentText: string): string | null {
  const parts = appendAnswerTrail(trail, currentText);
  return parts.length > 0 ? parts.join(' ') : null;
}

/** 翻页成功的页态迁移：换页清选择（已决行由新页卡 decided 标注承接），本页编译片段入累计审计文本 */
export function migratePage(trail: string[], pageText: string): { state: TriageState; trail: string[] } {
  return { state: clearSelections(), trail: appendAnswerTrail(trail, pageText) };
}
