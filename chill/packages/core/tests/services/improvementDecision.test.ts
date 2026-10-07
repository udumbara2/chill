import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as nodePath from 'node:path'
import {
  parseProposals,
  applyDecisions,
  buildClusterSummaries,
  buildDecisionView,
  buildAgingDecisions,
  buildTriageCard,
  planTriageLayout,
  buildTriagePageCard,
  summarizeDigest,
  formatDigestLine,
  formatEntriesGrouped,
  formatClusterOverview,
  parseDecisionInput,
  sanitizeEntryText,
  UNGROUPED_CLUSTER_ID,
  type ProposalEntry,
} from '../../src/services/ImprovementProposalManager.ts'
import { ImprovementLedger } from '../../src/services/improvementLedger.ts'
import { executeCommand, COMMAND_REGISTRY } from '../../src/services/commands/commandSurface.ts'
import { openImprovementCourt, turnImprovementCourtPage } from '../../src/services/improvementCourt.ts'
import { getAskChannel, resetAskChannel, type AskRequestPayload } from '../../src/services/askChannel.ts'
import { PLAINTEXT_BUDGET_BYTES } from '../../src/services/relay/envelope.ts'
import { eventBus, EVENTS } from '../../src/utils/eventBus.ts'

/**
 * 改进提案决策闭环（迭代 1）回归基线：
 * 视图构建（簇聚合/TopN/摘要/分组展示编号不变式）、决策解析（簇语法/前缀歧义/友好短语/
 * 快捷项/空输入保护/未提及 keep 语义）、老化边界、ImprovementLedger 单例
 * （原子写/串行化/缓存失效/stat 对账/缺文件语义）。
 */

const NOW = new Date('2026-09-26T00:00:00Z')

/** ledger 单例在宿主 path.join 下解析的提案文件键（Windows 反斜杠安全） */
const FILE = nodePath.join('/root', 'improvement-proposals.md')

function entry(date: string, title: string, group?: string, difficulty?: string): ProposalEntry {
  return { date, title, group, difficulty, reason: 'r', benefit: 'b', source: 's' }
}

const C26 = [entry('2026-09-25', '先答后探收口', 'C26 模型行为与步数低效', '低'), entry('2026-09-20', '限量指令禁追加', 'C26 模型行为与步数低效', '低')]
const C02 = [entry('2026-09-24', '记忆提示时机', 'C02 待确认记忆打扰', '低')]
const OLD = [entry('2026-08-01', '老提案A', 'C99 历史遗留', '中'), entry('2026-08-15', '老提案B', 'C98 历史遗留', '高')]

/** 构造与生产文件同构的四区 markdown */
function makeMd(entries: ProposalEntry[]): string {
  const lines = ['# 改进候选', '', '<!-- header -->', '', '## 待确认']
  for (const e of entries) {
    lines.push(`- [${e.date}] **功能**：${e.title}`)
    if (e.group) lines.push(`  **组**：${e.group}`)
    if (e.difficulty) lines.push(`  **难度**：${e.difficulty}`)
    lines.push(`  **理由**：${e.reason ?? 'r'}`, `  **收益**：${e.benefit ?? 'b'}`, `  **来源**：${e.source ?? 's'}`, '')
  }
  lines.push('## 已确认', '（暂无）', '', '## 已实现', '（暂无）', '', '## 已关闭', '（暂无）', '')
  return lines.join('\n')
}

// ==================== A. 视图构建 ====================

test('A1 buildClusterSummaries：C 编号提取/聚合/难度分布/近期计数', () => {
  const clusters = buildClusterSummaries([...C26, ...C02, ...OLD], { now: NOW })
  const byId = new Map(clusters.map(c => [c.id, c]))
  assert.equal(byId.get('C26')?.count, 2)
  assert.equal(byId.get('C26')?.name, 'C26 模型行为与步数低效')
  assert.equal(byId.get('C26')?.difficulty.low, 2)
  assert.equal(byId.get('C26')?.dominantDifficulty, '低')
  assert.equal(byId.get('C26')?.recent, 2)
  assert.equal(byId.get('C99')?.recent, 0)
  assert.equal(byId.get('C98')?.latest, '2026-08-15')
})

test('A2 排序：近期新增 ↓ → 条数 ↓，未分组恒最后', () => {
  const entries = [...C02, ...OLD, entry('2026-09-26', '散条', undefined, '低')]
  const clusters = buildClusterSummaries(entries, { now: NOW })
  assert.equal(clusters[0].id, 'C02')
  assert.equal(clusters[clusters.length - 1].id, '未分组')
})

test('A3 buildDecisionView topN 截取 + pendingCount', () => {
  const parsed = parseProposals(makeMd([...C26, ...C02, ...OLD]))
  const view = buildDecisionView(parsed, { now: NOW, topN: 2 })
  assert.equal(view.clusters.length, 2)
  assert.equal(view.pendingCount, 5)
})

test('A4 summarizeDigest + formatDigestLine', () => {
  const parsed = parseProposals(makeMd([...C26, ...C02]))
  const digest = summarizeDigest(parsed, { now: NOW })
  assert.equal(digest.pending, 3)
  assert.equal(digest.clusters, 2)
  assert.equal(digest.confirmed, 0)
  assert.equal(digest.implemented, 0)
  assert.equal(digest.recent, 3)
  const line = formatDigestLine(digest)
  assert.ok(line.includes('待确认 3 条 / 2 簇'))
  assert.ok(line.includes('已确认 0 待实施'))
  assert.ok(line.includes('近7天新增 3'))
})

test('A5 formatEntriesGrouped：原始编号不变式（与 pending[n-1] 决策解析对应）', () => {
  const entries = [...C02, ...C26]
  const text = formatEntriesGrouped(entries, { now: NOW })
  const c02Num = Number(text.match(/^(\d+)\. \[2026-09-24\]/m)?.[1])
  const firstC26 = Number(text.match(/^(\d+)\. \[2026-09-25\] 先答后探收口/m)?.[1])
  assert.equal(c02Num, 1)
  assert.equal(firstC26, 2)
  assert.ok(text.includes('【C26 模型行为与步数低效】（2 条'))
})

test('A6 formatClusterOverview：digest 行 + 每簇一行（簇名=决策寻址键）+ 条目不展开', () => {
  const parsed = parseProposals(makeMd([...C26, ...C02, ...OLD]))
  const text = formatClusterOverview(parsed, { now: NOW })
  // 摘要行（近7天新增 3 · 待确认 5 条 / 4 簇 · 已确认 0 待实施）
  assert.ok(text.includes('待确认 5 条 / 4 簇'))
  // 每簇恰好一行：名称含 C 编号（=决策寻址键），计数可见
  assert.ok(text.includes('- C26 模型行为与步数低效（2 条'))
  assert.ok(text.includes('- C02 待确认记忆打扰（1 条'))
  // 近期计数与主难度
  assert.ok(text.includes('近7天+2'))
  assert.ok(text.includes('低难度为主'))
  // 紧凑视图不展开条目正文（标题不出现）
  assert.ok(!text.includes('先答后探收口'))
})

test('A7 formatClusterOverview：maxClusters 封顶折叠 + 空 pending 空态', () => {
  const parsed = parseProposals(makeMd([...C26, ...C02, ...OLD]))
  const capped = formatClusterOverview(parsed, { now: NOW, maxClusters: 2 })
  assert.ok(capped.includes('…其余 2 簇略'))
  assert.ok(!capped.includes('- C98 历史遗留'))
  const empty = formatClusterOverview(parseProposals(makeMd([])), { now: NOW })
  assert.ok(empty.includes('（暂无待确认条目）'))
})

// ==================== B. 簇语法与歧义 ====================

const ALL = [...C26, ...C02, ...OLD]

test('B1 y C26 整簇确认（大小写不敏感）', () => {
  const r = parseDecisionInput('y c26', ALL)
  assert.equal(r.explicitCount, 2)
  assert.ok(r.decisions.every(d => d.action === 'confirm'))
  assert.deepEqual(r.invalidTargets, [])
})

test('B2 C 前缀歧义拒绝：C21/C22 并存时 C2 无效', () => {
  const entries = [entry('2026-09-26', 't1', 'C21 甲组', '低'), entry('2026-09-26', 't2', 'C22 乙组', '低')]
  const bad = parseDecisionInput('y C2', entries)
  assert.equal(bad.decisions.length, 0)
  assert.deepEqual(bad.invalidTargets, ['C2'])
  const good = parseDecisionInput('y C21', entries)
  assert.equal(good.explicitCount, 1)
})

test('B3 组名全称寻址（无空格组名）', () => {
  const entries = [entry('2026-09-26', 't1', '检索噪声过滤', '低'), entry('2026-09-26', 't2', 'C26 其他', '低')]
  const r = parseDecisionInput('y 检索噪声过滤', entries)
  assert.equal(r.explicitCount, 1)
  assert.equal(r.decisions[0].title, 't1')
})

test('B4 编号越界进 invalidNums，不产生决策但保留反馈', () => {
  const r = parseDecisionInput('y 99', ALL)
  assert.equal(r.decisions.length, 0)
  assert.deepEqual(r.invalidNums, [99])
})

test('B5 快捷项保持原语义（all / s all / del all）', () => {
  assert.equal(parseDecisionInput('all', ALL).shortcut, 'all')
  assert.equal(parseDecisionInput('s all', ALL).shortcut, 's all')
  assert.equal(parseDecisionInput('del all', ALL).shortcut, 'del all')
  assert.equal(parseDecisionInput('s all', ALL).explicitCount, ALL.length)
})

// ==================== C. 友好短语与空输入保护 ====================

test('C1 确认/跳过/删除 簇 友好短语', () => {
  assert.equal(parseDecisionInput('确认 C26 簇', ALL).explicitCount, 2)
  const skip = parseDecisionInput('跳过 C26', ALL)
  assert.equal(skip.decisions.filter(d => d.action === 'skip').length, 2)
  const del = parseDecisionInput('删除 C02', ALL)
  assert.equal(del.decisions.filter(d => d.action === 'close').length, 1)
})

test('C2 混合输入：y 1 s C02 del 99', () => {
  const r = parseDecisionInput('y 1 s C02 del 99', ALL)
  assert.equal(r.decisions.find(d => d.title === ALL[0].title)?.action, 'confirm')
  assert.equal(r.decisions.filter(d => d.action === 'skip').length, 1)
  assert.deepEqual(r.invalidNums, [99])
})

test('C3 空输入保护：无有效决策不产生任何 decisions', () => {
  assert.equal(parseDecisionInput('', ALL).decisions.length, 0)
  assert.equal(parseDecisionInput('foobar', ALL).decisions.length, 0)
  assert.equal(parseDecisionInput('跳过本轮', ALL).decisions.length, 0) // 执行器对这类答案有专门收场分支
})

// ==================== D. 老化边界 ====================

test('D1 buildAgingDecisions：超期关闭/边界不误伤/无老化 null', () => {
  const entries = [
    entry('2026-09-25', '新', 'C26 x', '低'),
    entry('2026-08-20', '老(37天)', 'C99 y', '低'),
    entry('2026-08-27', '恰好30天', 'C98 z', '低'),
  ]
  const r = buildAgingDecisions(parseProposals(makeMd(entries)), { now: NOW, days: 30 })
  assert.equal(r.closed, 1)
  assert.equal(r.decisions[0].title, '老(37天)')
  assert.ok(r.summary?.includes('1 条'))
  const none = buildAgingDecisions(parseProposals(makeMd([entries[0]])), { now: NOW, days: 30 })
  assert.equal(none.summary, null)
  assert.equal(none.closed, 0)
})

// ==================== E. 未提及语义 ====================

test('E1 默认 keep：未提及保留待确认（不再静默删除）', () => {
  const r = parseDecisionInput('y 1', ALL)
  assert.equal(r.decisions.length, 1)
  assert.equal(r.autoClosedCount, 0)
  const next = applyDecisions(makeMd(ALL), r.decisions)
  assert.equal(parseProposals(next).pending.length, ALL.length - 1)
})

test('E2 显式 close 语义（旧行为需 opt-in）', () => {
  const r = parseDecisionInput('y 1', ALL, { onUnmentioned: 'close' })
  assert.equal(r.decisions.filter(d => d.action === 'close').length, ALL.length - 1)
  assert.equal(r.autoClosedCount, ALL.length - 1)
})

// ==================== F. ImprovementLedger 单例 ====================

function makeMemFs(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial))
  let mtime = 1
  const provider = {
    readFile: async (p: string) => {
      const c = files.get(p)
      return c === undefined ? { success: false, error: 'not found' } : { success: true, data: { content: c } }
    },
    writeFile: async (p: string, c: string) => {
      files.set(p, c)
      mtime++
      return { success: true }
    },
    deleteFile: async (p: string) => {
      files.delete(p)
      return { success: true }
    },
    listDirectory: async () => ({ success: true, data: [] }),
    getCurrentDirectory: () => null,
    fileExists: async (p: string) => ({ success: true, data: files.has(p) }),
    getPathType: async () => ({ success: true, data: { type: 'file' } }),
    renameFile: async (from: string, to: string) => {
      const c = files.get(from)
      if (c === undefined) return { success: false, error: 'not found' }
      files.set(to, c)
      files.delete(from)
      mtime++
      return { success: true }
    },
    statFile: async (p: string) => ({ success: true, data: { mtimeMs: mtime, size: (files.get(p) ?? '').length } }),
  }
  return { files, provider }
}

const PATH_PROVIDER = { getUserDataPath: () => '/root' } as any

function makeLedger(initial: Record<string, string>) {
  const mem = makeMemFs(initial)
  const ledger = ImprovementLedger.getInstance()
  ledger.init(mem.provider as any, PATH_PROVIDER)
  return { ledger, files: mem.files }
}

test('F1 decide：应用决策 + 原子写（tmp 清理）+ 缓存失效', async () => {
  const { ledger, files } = makeLedger({ [FILE]: makeMd(ALL) })
  const res = await ledger.decide([{ title: '先答后探收口', action: 'confirm' }])
  assert.equal(res.ok, true)
  assert.equal(res.applied, 1)
  assert.equal(files.has(`${FILE}.tmp`), false, 'tmp 应已被 rename 消费')
  const parsed = await ledger.getParsed()
  assert.equal(parsed?.pending.length, ALL.length - 1)
  assert.equal(parsed?.confirmed.length, 1)
  assert.ok((files.get(FILE) ?? '').includes('<!-- header -->'))
})

test('F2 decide 幂等：未命中 title 为无害空操作', async () => {
  const { ledger } = makeLedger({ [FILE]: makeMd(ALL) })
  const res = await ledger.decide([{ title: '不存在的条目', action: 'confirm' }])
  assert.equal(res.ok, true)
  const parsed = await ledger.getParsed()
  assert.equal(parsed?.pending.length, ALL.length)
})

test('F3 并发 decide 串行化：两个并发决策都生效', async () => {
  const { ledger } = makeLedger({ [FILE]: makeMd(ALL) })
  const [a, b] = await Promise.all([
    ledger.decide([{ title: '先答后探收口', action: 'confirm' }]),
    ledger.decide([{ title: '记忆提示时机', action: 'confirm' }]),
  ])
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  const parsed = await ledger.getParsed()
  assert.equal(parsed?.confirmed.length, 2)
})

test('F4 缺文件：getView/getDigest 返回 null，decide 报错不写盘', async () => {
  const { ledger, files } = makeLedger({})
  assert.equal(await ledger.getView(), null)
  assert.equal(await ledger.getDigest(), null)
  const res = await ledger.decide([{ title: 'x', action: 'confirm' }])
  assert.equal(res.ok, false)
  assert.equal(files.size, 0)
})

test('F5 stat 对账：外部改写后缓存不返回旧数据', async () => {
  const mem = makeMemFs({ [FILE]: makeMd(ALL) })
  const ledger = ImprovementLedger.getInstance()
  ledger.init(mem.provider as any, PATH_PROVIDER)
  const before = await ledger.getDigest()
  assert.equal(before?.pending, ALL.length)
  // 外部进程改写（绕过 ledger）：mtime 变化 → 下次读取必须看到新内容
  mem.files.set(FILE, makeMd([C02[0]]))
  await mem.provider.writeFile('/root/.tick', '') // mtime 前进
  const after = await ledger.getDigest()
  assert.equal(after?.pending, 1)
})

test('F6 applyAging：超期条目移入已关闭 + 摘要行', async () => {
  const { ledger } = makeLedger({ [FILE]: makeMd([...C26, ...OLD]) })
  const r = await ledger.applyAging({ now: NOW, days: 30 })
  assert.equal(r.ok, true)
  assert.equal(r.applied, OLD.length)
  assert.ok(r.summary?.includes(`${OLD.length} 条`))
  const parsed = await ledger.getParsed()
  assert.equal(parsed?.pending.length, C26.length)
  assert.equal(parsed?.discarded.length, OLD.length)
})

test('F7 getDigestLine / getView topN 走单例通道', async () => {
  const { ledger } = makeLedger({ [FILE]: makeMd(ALL) })
  const line = await ledger.getDigestLine({ now: NOW })
  assert.ok(line?.includes(`待确认 ${ALL.length} 条`))
  const view = await ledger.getView({ now: NOW, topN: 1 })
  assert.equal(view?.clusters.length, 1)
  assert.equal(view?.pendingCount, ALL.length)
})

// ==================== G. capture（闪念捕获 · 第三写入者） ====================

test('G1 capture：追加「闪念」簇条目（含来源戳），原子写不破坏四区', async () => {
  const { ledger, files } = makeLedger({ [FILE]: makeMd(ALL) })
  const r = await ledger.capture('搜索结果应该默认过滤构建产物', 'CLI /idea', { sessionId: 's-42' })
  assert.equal(r.ok, true)
  assert.equal(r.applied, 1)
  const parsed = await ledger.getParsed()
  assert.equal(parsed?.pending.length, ALL.length + 1)
  const flash = parsed?.pending.find(e => e.group === '闪念')
  assert.ok(flash, '闪念簇应存在')
  assert.equal(flash?.title, '搜索结果应该默认过滤构建产物')
  assert.ok(flash?.source?.includes('CLI /idea') && flash?.source?.includes('s-42'))
  assert.ok((files.get(FILE) ?? '').includes('<!-- header -->'), '头部注释保留')
  assert.ok(files.has(`${FILE}.tmp`) === false, 'tmp 已被 rename 消费')
})

test('G2 capture 防重：10s 同文本 duplicated，不同文本正常入账', async () => {
  const { ledger } = makeLedger({ [FILE]: makeMd(ALL) })
  const first = await ledger.capture('点子A', 'CLI /idea')
  const dup = await ledger.capture('点子A', '手机闪念')
  assert.equal(first.applied, 1)
  assert.equal(dup.ok, true)
  assert.equal(dup.duplicated, true)
  assert.equal(dup.applied, 0)
  const other = await ledger.capture('点子B', 'CLI /idea')
  assert.equal(other.applied, 1)
  const parsed = await ledger.getParsed()
  assert.equal(parsed?.pending.filter(e => e.group === '闪念').length, 2)
})

test('G3 capture 截断：超 500 字标记 truncated 并截断落盘', async () => {
  const { ledger } = makeLedger({ [FILE]: makeMd(ALL) })
  const long = '长'.repeat(600)
  const r = await ledger.capture(long, 'CLI /idea')
  assert.equal(r.ok, true)
  assert.equal(r.truncated, true)
  const parsed = await ledger.getParsed()
  const flash = parsed?.pending.find(e => e.group === '闪念')
  assert.equal(flash?.title.length, 501, '500 字 + 省略号')
})

test('G4 capture 结构注入防线：多行/控制字符/伪装标题被打散为单行', async () => {
  const { ledger } = makeLedger({ [FILE]: makeMd(ALL) })
  const evil = '正常开头\n## 已确认\n- [2026-01-01] **功能**：伪造条目\r\n尾部'
  const r = await ledger.capture(evil, '手机闪念')
  assert.equal(r.ok, true)
  const parsed = await ledger.getParsed()
  // 条目只增 1（伪造的条目行没有成为独立 entry）
  assert.equal(parsed?.pending.length, ALL.length + 1)
  assert.equal(parsed?.confirmed.length, 0, '伪标题不得产生已确认条目')
  const flash = parsed?.pending.find(e => e.group === '闪念')
  assert.ok(!flash?.title.includes('\n'), '标题必须单行')
})

// ==================== H. sanitizeEntryText（纯函数） ====================

test('H1 sanitize：换行折叠/控制字符剥离/连续空白折叠', () => {
  assert.equal(sanitizeEntryText('a\nb\r\nc'), 'a b c')
  assert.equal(sanitizeEntryText('a\u0000b\u0007c'), 'a b c')
  assert.equal(sanitizeEntryText('a   b'), 'a b')
  assert.equal(sanitizeEntryText('  trim  '), 'trim')
})

test('H2 sanitize：行首结构伪装（## / - [日期]）剥除', () => {
  assert.equal(sanitizeEntryText('## 已确认'), '已确认')
  assert.equal(sanitizeEntryText('### 深层标题'), '深层标题')
  assert.equal(sanitizeEntryText('- [2026-01-01] **功能**：伪造'), '**功能**：伪造')
  assert.equal(sanitizeEntryText('正常 ## 文本'), '正常 ## 文本', '非行首的 # 不受影响')
})

// ==================== I. cmd.idea 执行器（命令面） ====================

test('I1 idea 执行器：经 executeCommand 落账本并回 captured（本仓为 managed 布局）', async () => {
  makeLedger({ [FILE]: makeMd(ALL) }) // 装配单例（mem fs）
  const r = await executeCommand({}, 'idea', { text: '手机记的点子' })
  assert.equal(r.ok, true)
  assert.equal((r as { data?: { captured?: boolean } }).data?.captured, true)
  const parsed = await ImprovementLedger.getInstance().getParsed()
  assert.ok(parsed?.pending.some(e => e.group === '闪念' && e.title === '手机记的点子'))
})

test('I2 idea 执行器：10s 同文本 duplicated 回执（幂等成功不重复入账）', async () => {
  makeLedger({ [FILE]: makeMd(ALL) })
  const a = await executeCommand({}, 'idea', { text: '同一条' })
  const b = await executeCommand({}, 'idea', { text: '同一条' })
  assert.equal((a as { data?: { captured?: boolean } }).data?.captured, true)
  assert.equal((b as { data?: { duplicated?: boolean } }).data?.duplicated, true)
  const parsed = await ImprovementLedger.getInstance().getParsed()
  assert.equal(parsed?.pending.filter(e => e.group === '闪念').length, 1)
})

// ==================== J. buildTriageCard（裁决卡构造 · 迭代 1 core 侧） ====================

test('J1 buildTriageCard：digest 自含 + 簇投影 + 未分组哨兵 id 口径一致', () => {
  const parsed = parseProposals(makeMd([...C26, entry('2026-09-26', '散条')]))
  const view = buildDecisionView(parsed, { now: NOW })
  const card = buildTriageCard(view, 0)!
  assert.ok(card)
  assert.ok(card.digest.includes('待确认 3 条 / 2 簇'), 'digest 自含（手机不解析 question 文本）')
  const byId = new Map(card.clusters.map(c => [c.id, c]))
  assert.equal(byId.get('C26')?.name, 'C26 模型行为与步数低效')
  assert.equal(byId.get('C26')?.count, 2)
  assert.equal(byId.get('C26')?.recent, 2)
  assert.equal(byId.get('C26')?.difficulty, '低')
  assert.equal(byId.get('C26')?.latest, '2026-09-25')
  // 未分组簇无 C 编号 → 固定哨兵 id（组名全称留在 name，文本回退可寻址）
  assert.equal(byId.get(UNGROUPED_CLUSTER_ID)?.name, '未分组')
  assert.equal(byId.get(UNGROUPED_CLUSTER_ID)?.difficulty, undefined, '无难度字段的簇 difficulty 键缺省')
})

test('J2 buildTriageCard 预算：question 实际字节 + card 序列化合计超预算返回 null（降级不带卡）', () => {
  const view = buildDecisionView(parseProposals(makeMd(C26)), { now: NOW })
  const card = buildTriageCard(view, 0)!
  const cardBytes = new TextEncoder().encode(JSON.stringify(card)).length
  // 合计恰好顶到预算 → 仍有卡
  assert.ok(buildTriageCard(view, PLAINTEXT_BUDGET_BYTES - cardBytes) !== null)
  // 合计超 1 字节 → null（防两者叠加顶爆线上预算）
  assert.equal(buildTriageCard(view, PLAINTEXT_BUDGET_BYTES - cardBytes + 1), null)
})

// ==================== K. improvementCourt（开庭唯一事实点 · 迭代 1 core 侧） ====================

/** 开庭测试用的新鲜条目（日期跟随真实当天——court 的 applyAging 用真实 now，钉死日期会被老化误伤） */
const TODAY = new Date().toISOString().split('T')[0]
const FRESH_C26 = [entry(TODAY, '先答后探收口', 'C26 模型行为与步数低效', '低'), entry(TODAY, '限量指令禁追加', 'C26 模型行为与步数低效', '低')]
const FRESH_C02 = [entry(TODAY, '记忆提示时机', 'C02 待确认记忆打扰', '低')]

/** 捕获 ASK_REQUESTED（开庭发卡/重推的观测点） */
function captureAsks(): { fired: AskRequestPayload[]; off: () => void } {
  const fired: AskRequestPayload[] = []
  const listener = (p: AskRequestPayload) => fired.push(p)
  eventBus.on(EVENTS.ASK_REQUESTED, listener)
  return { fired, off: () => eventBus.off(EVENTS.ASK_REQUESTED, listener) }
}

/** 让开庭异步前置（读账本/老化/构造）落定到 ask 发卡点 */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 10))
}

test('K1 开庭空账本短回：无文件与 pending=0 皆空态，不发卡', async () => {
  makeLedger({})
  resetAskChannel()
  const asks = captureAsks()
  const r = await openImprovementCourt()
  assert.equal(r.success, true)
  assert.ok(r.data!.includes('（暂无待确认改进提案）'))
  assert.equal(asks.fired.length, 0)
  asks.off()
  // pending=0（有四区骨架但无条目）同口径
  makeLedger({ [FILE]: makeMd([]) })
  const r2 = await openImprovementCourt()
  assert.ok(r2.data!.includes('（暂无待确认改进提案）'))
  assert.equal(asks.fired.length, 0)
  asks.off()
})

test('K2 开庭前补做老化：超期条目移入已关闭 + 摘要行前置（老化清空则短回不开庭）', async () => {
  makeLedger({ [FILE]: makeMd(OLD) }) // OLD 钉在 2026-08 月，真实 now 下恒 >30 天
  resetAskChannel()
  const asks = captureAsks()
  const r = await openImprovementCourt()
  assert.equal(asks.fired.length, 0, '老化清空后不开庭')
  assert.ok(r.data!.includes('已自动归档 2 条'), '老化摘要前置告知')
  assert.ok(r.data!.includes('（暂无待确认改进提案）'))
  const parsed = await ImprovementLedger.getInstance().getParsed()
  assert.equal(parsed!.pending.length, 0)
  assert.equal(parsed!.discarded.length, 2)
  asks.off()
})

test('K3 开庭发卡：card 随 ask 载荷（自供 id）；无 decisions 时文本回退 parseDecisionInput', async () => {
  makeLedger({ [FILE]: makeMd([...FRESH_C26, ...FRESH_C02]) })
  resetAskChannel()
  const asks = captureAsks()
  const court = openImprovementCourt()
  await tick()
  assert.equal(asks.fired.length, 1)
  const payload = asks.fired[0]
  assert.ok(payload.card, '卡载荷随 ask 携带')
  assert.equal(payload.card!.clusters.some(c => c.id === 'C26'), true)
  assert.ok(payload.question.includes('待确认 3 条 / 2 簇'), 'question 文本维持簇概览现状')
  getAskChannel().resolve(payload.id, 'y C26', 'phone')
  const r = await court
  assert.equal(r.success, true)
  assert.ok(r.data!.includes('确认 2 条'))
  const parsed = await ImprovementLedger.getInstance().getParsed()
  assert.equal(parsed!.confirmed.length, 2)
  assert.equal(parsed!.pending.length, 1)
  asks.off()
})

test('K4 结构化 decisions 优先：answer 为不可解析文本时仍按 decisions 落账', async () => {
  makeLedger({ [FILE]: makeMd([...FRESH_C26, ...FRESH_C02]) })
  resetAskChannel()
  const asks = captureAsks()
  const court = openImprovementCourt()
  await tick()
  const id = asks.fired[0].id
  getAskChannel().resolve(id, '（手机点选提交）', 'phone', [
    { action: 'confirm', clusterId: 'C26' },
    { action: 'close', title: '记忆提示时机' },
  ])
  const r = await court
  assert.equal(r.success, true)
  assert.ok(r.data!.includes('确认 2 条'), '簇级 clusterId 按开庭快照展开')
  assert.ok(r.data!.includes('删除 1 条'), '单条 title 直接校验落账')
  const parsed = await ImprovementLedger.getInstance().getParsed()
  assert.equal(parsed!.confirmed.length, 2)
  assert.equal(parsed!.discarded.length, 1)
  assert.equal(parsed!.pending.length, 0)
  asks.off()
})

test('K5 结构化 decisions 全部未命中（陈旧快照）幂等丢弃 → 回退文本解析', async () => {
  makeLedger({ [FILE]: makeMd([...FRESH_C26, ...FRESH_C02]) })
  resetAskChannel()
  const asks = captureAsks()
  const court = openImprovementCourt()
  await tick()
  const id = asks.fired[0].id
  getAskChannel().resolve(id, 'y C02', 'phone', [
    { action: 'confirm', clusterId: 'C404' },
    { action: 'close', title: '不存在的条目' },
  ])
  const r = await court
  assert.equal(r.success, true)
  const parsed = await ImprovementLedger.getInstance().getParsed()
  assert.equal(parsed!.confirmed.length, 1, '文本 y C02 生效（回退路径）')
  assert.equal(parsed!.confirmed[0].title, '记忆提示时机')
  assert.equal(parsed!.pending.length, 2)
  asks.off()
})

test('K6 开庭去重：在跑中再次开庭 reannounce 重推同卡（同 id）+ 共享结果 Promise', async () => {
  makeLedger({ [FILE]: makeMd(FRESH_C26) })
  resetAskChannel()
  const asks = captureAsks()
  const court1 = openImprovementCourt()
  await tick() // 等首个庭的 ask 挂起（去重重推的真实场景=首庭在等待回答）
  assert.equal(asks.fired.length, 1)
  const court2 = openImprovementCourt()
  await tick()
  assert.equal(asks.fired.length, 2, '重推不新发卡（绝不产生两张编号快照可能不一致的卡）')
  assert.equal(asks.fired[1].id, asks.fired[0].id, '同 id 幂等收敛')
  assert.equal(court2, court1, '新调用方共享同一结果 Promise')
  getAskChannel().resolve(asks.fired[0].id, 's all', 'phone')
  const [r1, r2] = await Promise.all([court1, court2])
  assert.deepEqual(r1, r2)
  const parsed = await ImprovementLedger.getInstance().getParsed()
  assert.equal(parsed!.pending.length, 2, 's all 未修改文件')
  asks.off()
})

test('K7 跳过本轮收场行为不变（options 尾项 + 明确无变更语义）', async () => {
  makeLedger({ [FILE]: makeMd([...FRESH_C26, ...FRESH_C02]) })
  resetAskChannel()
  const asks = captureAsks()
  const court = openImprovementCourt()
  await tick()
  const opts = asks.fired[0].options!
  assert.equal(opts[opts.length - 1].label, '跳过本轮')
  getAskChannel().resolve(asks.fired[0].id, '跳过本轮', 'local')
  const r = await court
  assert.equal(r.success, true)
  assert.ok(r.data!.includes('用户选择跳过本轮'))
  assert.ok(r.data!.includes('全部 3 条保留待确认'))
  const parsed = await ImprovementLedger.getInstance().getParsed()
  assert.equal(parsed!.pending.length, 3)
  asks.off()
})

test('K8 归因分流：模型开庭透传 sessionId（分页重发延续）；召唤开庭无归因（纯旁路）', async () => {
  // ① 模型开庭（manage_improvements ask 分支形态）：ask 载荷带发起会话归因
  makeLedger({ [FILE]: makeMd([...FRESH_C26, ...FRESH_C02]) })
  resetAskChannel()
  const asks = captureAsks()
  const court = openImprovementCourt({ sessionId: 's-42' })
  await tick()
  assert.equal(asks.fired.length, 1)
  assert.equal(asks.fired[0].sessionId, 's-42', '模型开庭：ask 载荷带发起会话归因')
  getAskChannel().resolve(asks.fired[0].id, 's all', 'phone')
  await court
  asks.off()

  // ② 召唤开庭（cmd improve）：无归因——纯旁路，手机端只进全局浮层
  makeLedger({ [FILE]: makeMd([...FRESH_C26, ...FRESH_C02]) })
  resetAskChannel()
  const asks2 = captureAsks()
  await executeCommand({}, 'improve', {})
  await tick()
  assert.equal(asks2.fired.length, 1)
  assert.equal('sessionId' in asks2.fired[0], false, '召唤开庭：不带会话归因键')
  getAskChannel().resolve(asks2.fired[0].id, 's all', 'phone')
  await tick()
  asks2.off()

  // ③ 分页重发延续同归因（「下一批」文本路径的新卡同归因——归因随开庭不随页）
  makeLedger({ [FILE]: makeMd(makeHeavyEntries()) })
  resetAskChannel()
  const asks3 = captureAsks()
  const court3 = openImprovementCourt({ sessionId: 's-42' })
  await tick()
  assert.equal(asks3.fired[0].sessionId, 's-42')
  getAskChannel().resolve(asks3.fired[0].id, '下一批', 'phone')
  await tick()
  assert.equal(asks3.fired.length, 2, '重发下一批卡')
  assert.equal(asks3.fired[1].sessionId, 's-42', '分页重发延续同归因')
  getAskChannel().resolve(asks3.fired[1].id, 's all', 'phone')
  await court3
  asks3.off()
})

// ==================== L. buildTriageCard 迭代 2：entries + 预算降级链 + 截批 ====================

/** 控制字节量的长理由（300 字） */
const LONG_REASON = '理'.repeat(300)

function detailedEntry(date: string, title: string, group?: string): ProposalEntry {
  return { date, title, group, difficulty: '低', reason: LONG_REASON, benefit: 'b', source: 's' }
}

const cardBytes = (card: unknown): number => new TextEncoder().encode(JSON.stringify(card)).length

test('L1 entries：编号 n 与 pending 快照同源（跨簇重排不改编号），详情字段全量', () => {
  const parsed = parseProposals(makeMd([
    detailedEntry('2026-09-28', '甲', 'C01 组A'),
    detailedEntry('2026-09-28', '乙', 'C02 组B'),
    detailedEntry('2026-09-27', '丙', 'C01 组A'),
  ]))
  const view = buildDecisionView(parsed, { now: NOW })
  const card = buildTriageCard(view, 0, { pending: parsed.pending })!
  const c01 = card.clusters.find(c => c.id === 'C01')!
  assert.deepEqual(c01.entries!.map(e => e.n), [1, 3], 'C01 两条在 pending 快照下标 0/2 → n=1,3')
  assert.equal(card.clusters.find(c => c.id === 'C02')!.entries![0].n, 2)
  assert.equal(c01.entries![0].reason, LONG_REASON, '首档不截断理由')
  assert.equal(c01.entries![0].benefit, 'b')
  assert.equal(c01.entries![0].source, 's')
  // 编号语义与 parseDecisionInput 同源：y 3 命中的标题 = 卡上 n=3 的标题
  const r = parseDecisionInput('y 3', parsed.pending)
  assert.equal(r.decisions[0].title, '丙')
  assert.equal(c01.entries![1].title, '丙')
})

test('L2 降级链第一档：理由截断 120 字（带省略号），其余字段保留', () => {
  const entries = Array.from({ length: 6 }, (_, i) => detailedEntry('2026-09-28', `条目${i}`, 'C01 组A'))
  const parsed = parseProposals(makeMd(entries))
  const view = buildDecisionView(parsed, { now: NOW })
  const fullBytes = cardBytes(buildTriageCard(view, 0, { pending: parsed.pending })!)
  // question 顶到 full 档恰好放不下、trim120 档放得下的位置
  const card = buildTriageCard(view, PLAINTEXT_BUDGET_BYTES - fullBytes + 1, { pending: parsed.pending })!
  assert.ok(card)
  assert.equal(card.batch, undefined, '未到截批档')
  assert.equal(card.clusters[0].entries!.length, 6, 'entries 不丢条')
  assert.equal(card.clusters[0].entries![0].reason!.length, 121, '120 字 + 省略号')
  assert.ok(card.clusters[0].entries![0].reason!.endsWith('…'))
})

test('L3 降级链第二档：只保留每簇首条详情，其余仅 {n,title}', () => {
  const entries = Array.from({ length: 6 }, (_, i) => detailedEntry('2026-09-28', `条目${i}`, 'C01 组A'))
  const parsed = parseProposals(makeMd(entries))
  const view = buildDecisionView(parsed, { now: NOW })
  const trimCard = buildTriageCard(view, PLAINTEXT_BUDGET_BYTES - cardBytes(buildTriageCard(view, 0, { pending: parsed.pending })!) + 1, { pending: parsed.pending })!
  const trimBytes = cardBytes(trimCard)
  const card = buildTriageCard(view, PLAINTEXT_BUDGET_BYTES - trimBytes + 1, { pending: parsed.pending })!
  assert.ok(card)
  const wire = card.clusters[0].entries!
  assert.equal(wire.length, 6)
  assert.ok(wire[0].reason, '首条保留详情')
  for (const e of wire.slice(1)) {
    assert.deepEqual(Object.keys(e).sort(), ['n', 'title'], '其余仅标题')
  }
})

test('L4 降级链第三档：簇数截到本批（≤20）+ batch 游标自描述（offset/total）', () => {
  const entries: ProposalEntry[] = []
  for (let c = 0; c < 25; c++) entries.push(detailedEntry('2026-09-28', `簇${c}条目`, `C${String(c + 1).padStart(2, '0')} 组${c}`))
  const parsed = parseProposals(makeMd(entries))
  const view = buildDecisionView(parsed, { now: NOW })
  const firstOnlyFull = buildTriageCard(view, PLAINTEXT_BUDGET_BYTES - cardBytes(buildTriageCard(view, 0, { pending: parsed.pending })!) + 1, { pending: parsed.pending })
  const firstOnlyBytes = cardBytes(buildTriageCard(view, PLAINTEXT_BUDGET_BYTES - cardBytes(firstOnlyFull!) + 1, { pending: parsed.pending })!)
  // 顶到 firstOnly 全量恰好放不下 → 必走截批
  const card = buildTriageCard(view, PLAINTEXT_BUDGET_BYTES - firstOnlyBytes + 1, { pending: parsed.pending })!
  assert.ok(card)
  assert.ok(card.batch, '截批带游标')
  assert.equal(card.batch!.offset, 0)
  assert.equal(card.batch!.total, 25)
  assert.ok(card.clusters.length <= 20, `本批簇数 ≤20，实际 ${card.clusters.length}`)
  assert.ok(card.batch!.total - card.batch!.offset - card.clusters.length > 0, '有隐藏簇待下一批')
})

test('L5 降级链末档：批内收缩到 1 簇仍超预算 → null（不带卡纯文本降级）', () => {
  const parsed = parseProposals(makeMd([detailedEntry('2026-09-28', '条目', 'C01 组A')]))
  const view = buildDecisionView(parsed, { now: NOW })
  assert.equal(buildTriageCard(view, PLAINTEXT_BUDGET_BYTES, { pending: parsed.pending }), null)
})

test('L6 布局页界契约：batchOffset 非页界 → null；页卡带 pageIndex/pageCount，编号沿用原快照', () => {
  // 单页布局（5 小簇整案装得下）→ batchOffset 3 非页界 → null（布局前置后 offset 只取页界）
  const entries: ProposalEntry[] = []
  for (let c = 0; c < 5; c++) entries.push(detailedEntry('2026-09-28', `簇${c}条目`, `C${String(c + 1).padStart(2, '0')} 组${c}`))
  const parsed = parseProposals(makeMd(entries))
  const view = buildDecisionView(parsed, { now: NOW })
  assert.equal(buildTriageCard(view, 0, { pending: parsed.pending, batchOffset: 3 }), null)
  // 多页布局（重账本函数在 M 节定义，function 声明提升可用）：页界投影 + 恒定分母
  const heavy = parseProposals(makeMd(makeHeavyEntries()))
  const hv = buildDecisionView(heavy, { now: NOW })
  const layout = planTriageLayout(hv, 2000, { pending: heavy.pending })!
  assert.ok(layout.pages.length > 1, '重账本必须多页')
  const page0 = buildTriagePageCard(hv, layout, 0, { pending: heavy.pending })!
  assert.deepEqual(page0.batch, { offset: 0, total: 25, pageIndex: 0, pageCount: layout.pages.length })
  const page1 = buildTriagePageCard(hv, layout, 1, { pending: heavy.pending })!
  assert.equal(page1.batch!.pageIndex, 1)
  assert.equal(page1.batch!.offset, layout.pages[1]!.offset)
  // 编号不因分页重排：页 2 首条 n = 该条目在原 pending 快照的下标+1
  const firstTitle = page1.clusters[0]!.entries![0]!.title
  assert.equal(page1.clusters[0]!.entries![0]!.n, heavy.pending.findIndex((e) => e.title === firstTitle) + 1)
})

// ==================== M. 开庭分页（「下一批」收口 · 迭代 2 core 侧） ====================

/** 25 簇 × 30 条的重账本（长标题顶爆预算强制截批） */
function makeHeavyEntries(): ProposalEntry[] {
  const entries: ProposalEntry[] = []
  for (let c = 0; c < 25; c++) {
    for (let i = 0; i < 30; i++) {
      entries.push(entry(TODAY, `簇${c}条目${i}·${'题'.repeat(40)}`, `C${String(c + 1).padStart(2, '0')} 组${c}`, '低'))
    }
  }
  return entries
}

test('M1 「下一批」：已点选 decisions 先落账，再以 offset 重发同快照卡（不进 parseDecisionInput）', async () => {
  makeLedger({ [FILE]: makeMd(makeHeavyEntries()) })
  resetAskChannel()
  const asks = captureAsks()
  const court = openImprovementCourt()
  await tick()
  assert.equal(asks.fired.length, 1)
  const card1 = asks.fired[0].card!
  assert.ok(card1.batch, '截批带游标')
  assert.equal(card1.batch!.offset, 0)
  assert.equal(card1.batch!.total, 25)
  assert.ok(card1.clusters.length <= 20)
  assert.ok(asks.fired[0].question.includes('回复「下一批」'), 'question 尾部追加分页提示（仅截批时）')
  const firstClusterId = card1.clusters[0].id
  // 同发不互斥：结构化 decisions + 文本「下一批」
  getAskChannel().resolve(asks.fired[0].id, '下一批', 'phone', [{ action: 'confirm', clusterId: firstClusterId }])
  await tick()
  assert.equal(asks.fired.length, 2, '重发下一批卡')
  assert.notEqual(asks.fired[1].id, asks.fired[0].id, '新卡新 id')
  const card2 = asks.fired[1].card!
  assert.equal(card2.batch!.offset, card1.clusters.length, '下一批 offset = 本批 offset + 本批簇数')
  assert.equal(card2.batch!.total, 25)
  // 本批 decisions 已照常落账
  const parsed = await ImprovementLedger.getInstance().getParsed()
  assert.equal(parsed!.confirmed.length, 30)
  // 第二批文本决策后收场
  getAskChannel().resolve(asks.fired[1].id, 's all', 'phone')
  const r = await court
  assert.equal(r.success, true)
  assert.ok(r.data!.includes('确认 30 条'), '首批落账回执')
  assert.ok(r.data!.includes('全部跳过'), '次批收场回执')
  asks.off()
})

test('M2 最后一批喊「下一批」→ 已是最后一批（不再发卡），无决策不落账', async () => {
  makeLedger({ [FILE]: makeMd(makeHeavyEntries()) })
  resetAskChannel()
  const asks = captureAsks()
  let done = false
  let result: Awaited<ReturnType<typeof openImprovementCourt>> | null = null
  void openImprovementCourt().then((r) => { result = r; done = true })
  await tick()
  let rounds = 0
  while (!done && rounds < 20) {
    const last = asks.fired[asks.fired.length - 1]
    getAskChannel().resolve(last.id, '下一批', 'phone')
    await tick()
    rounds++
  }
  assert.ok(done, '开庭在有限批内收场')
  assert.ok(asks.fired.length >= 2, '确实发生了分页')
  assert.ok(result!.data!.includes('已是最后一批'), '末批提示')
  const parsed = await ImprovementLedger.getInstance().getParsed()
  assert.equal(parsed!.pending.length, 750, '纯翻页不落账')
  asks.off()
})

test('M3 混排文本不触发分页：「y C01 下一批」走文本解析（下一批进 invalidTargets），不重发卡', async () => {
  makeLedger({ [FILE]: makeMd(makeHeavyEntries()) })
  resetAskChannel()
  const asks = captureAsks()
  const court = openImprovementCourt()
  await tick()
  assert.equal(asks.fired.length, 1)
  getAskChannel().resolve(asks.fired[0].id, 'y C01 下一批', 'local')
  const r = await court
  await tick()
  assert.equal(asks.fired.length, 1, '混排文本不翻页')
  assert.ok(r.data!.includes('确认 30 条'))
  assert.ok(r.data!.includes('下一批'), '无效目标回显引导')
  const parsed = await ImprovementLedger.getInstance().getParsed()
  assert.equal(parsed!.confirmed.length, 30)
  asks.off()
})

// ==================== N. cmd.improve 执行器（召唤裁决卡 · 迭代 3 core 侧） ====================

test('N1 improve 空账本短回：无待确认提案（带 0 条统计兜底），不发卡', async () => {
  makeLedger({})
  resetAskChannel()
  const asks = captureAsks()
  const r = await executeCommand({}, 'improve', {})
  assert.equal(r.ok, true)
  assert.equal((r as { data?: { message?: string; court?: string } }).data?.message, '没有待确认提案 · 已确认 0 条待实施（桌面 /improve 面板可查看）')
  assert.equal((r as { data?: { court?: string } }).data?.court, 'empty')
  await tick()
  assert.equal(asks.fired.length, 0, '空账本不开庭')
  asks.off()
})

test('N1b improve 空态有信息（P3）：pending 空且已确认 N 条 → message 带真实统计与去向', async () => {
  const md = [
    '# 改进候选', '', '<!-- header -->', '', '## 待确认', '（暂无）', '',
    '## 已确认',
    '- [2026-07-25] **功能**：历史版本磁盘清理', '',
    '- [2026-07-25] **功能**：消除静默吞异常', '',
    '## 已实现', '（暂无）', '', '## 已关闭', '（暂无）', '',
  ].join('\n')
  makeLedger({ [FILE]: md })
  resetAskChannel()
  const asks = captureAsks()
  const r = await executeCommand({}, 'improve', {})
  assert.equal(r.ok, true)
  assert.equal((r as { data?: { message?: string; court?: string } }).data?.message, '没有待确认提案 · 已确认 2 条待实施（桌面 /improve 面板可查看）')
  assert.equal((r as { data?: { court?: string } }).data?.court, 'empty')
  await tick()
  assert.equal(asks.fired.length, 0, '不开庭')
  asks.off()
})

test('N2 improve 正常开庭：即时回"裁决卡已发出"（不 await 开庭），卡随后经 ASK_REQUESTED 发出', async () => {
  makeLedger({ [FILE]: makeMd([...FRESH_C26, ...FRESH_C02]) })
  resetAskChannel()
  const asks = captureAsks()
  const r = await executeCommand({}, 'improve', {})
  assert.equal(r.ok, true)
  assert.equal((r as { data?: { message?: string } }).data?.message, '裁决卡已发出')
  assert.equal((r as { data?: { court?: string } }).data?.court, 'issued')
  await tick()
  assert.equal(asks.fired.length, 1, '裁决卡经 ask 通道发出')
  assert.ok(asks.fired[0].card, '带裁决卡载荷')
  // 收摊：落定本次开庭，防 activeCourt 泄漏到后续用例
  getAskChannel().resolve(asks.fired[0].id, 's all', 'phone')
  await tick()
  asks.off()
})

test('N3 improve 去重：已有未决裁决卡 → "裁决卡已重推"（同 id 重发，不开第二庭）', async () => {
  makeLedger({ [FILE]: makeMd([...FRESH_C26, ...FRESH_C02]) })
  resetAskChannel()
  const asks = captureAsks()
  const r1 = await executeCommand({}, 'improve', {})
  assert.equal((r1 as { data?: { court?: string } }).data?.court, 'issued')
  await tick()
  assert.equal(asks.fired.length, 1)
  const r2 = await executeCommand({}, 'improve', {})
  assert.equal((r2 as { data?: { message?: string } }).data?.message, '裁决卡已重推')
  assert.equal((r2 as { data?: { court?: string } }).data?.court, 'reannounced')
  assert.equal(asks.fired.length, 2, '重推一次')
  assert.equal(asks.fired[1].id, asks.fired[0].id, '同 id 幂等收敛')
  // 收摊
  getAskChannel().resolve(asks.fired[0].id, 's all', 'phone')
  await tick()
  asks.off()
})

test('N4 improve 注册表形状：managedOnly + fast + console-row（对齐规划钉死的条目形状）', () => {
  const spec = COMMAND_REGISTRY.find((c) => c.id === 'improve')!
  assert.ok(spec)
  assert.equal(spec.managedOnly, true)
  assert.equal(spec.channel, 'fast')
  assert.equal(spec.presentation, 'console-row')
  assert.equal(spec.risk, 'instant')
  assert.equal(spec.section, 'maintain')
})

// ==================== O. 簇 id 碰撞消歧（C 编号相同/组名不同 · 真机实测回归） ====================

/** 组名不同但 C 编号相同的两个簇（"C03 search_tools批量…" 与 "C03 search_tools 批量…"，不同时期写入） */
const COLLIDE = [
  entry(TODAY, '碰撞甲1', 'C03 search_tools批量检索与工具激活', '低'),
  entry(TODAY, '碰撞甲2', 'C03 search_tools批量检索与工具激活', '低'),
  entry(TODAY, '碰撞乙1', 'C03 search_tools 批量检索与工具激活', '低'),
]

test('O1 碰撞消歧：card 簇 id 唯一且确定性（C03 / C03#2，按簇序加后缀）', () => {
  const parsed = parseProposals(makeMd(COLLIDE))
  const view = buildDecisionView(parsed, { now: NOW })
  const card = buildTriageCard(view, 0, { pending: parsed.pending })!
  assert.ok(card)
  const ids = card.clusters.map((c) => c.id)
  assert.equal(new Set(ids).size, ids.length, '簇 id 唯一（手机 validateTriageCard 不再整卡拒绝）')
  assert.deepEqual(ids, ['C03', 'C03#2'])
  assert.equal(card.clusters[0].entries![0].title, '碰撞甲1', '首现簇保原 id')
  assert.equal(card.clusters[1].entries![0].title, '碰撞乙1', '次现簇加 #2 后缀')
  // 确定性：同输入重构造逐字一致（开庭两遍构造/收口展开依赖同序同后缀）
  const again = buildTriageCard(view, 0, { pending: parsed.pending })!
  assert.deepEqual(again.clusters.map((c) => c.id), ids)
})

test('O2 结构化决策经 C03#2 只命中第二个簇（按发出的 card 展开，不从 view 重建）', async () => {
  makeLedger({ [FILE]: makeMd(COLLIDE) })
  resetAskChannel()
  const asks = captureAsks()
  const court = openImprovementCourt()
  await tick()
  const payload = asks.fired[0]
  assert.deepEqual(payload.card!.clusters.map((c) => c.id), ['C03', 'C03#2'])
  getAskChannel().resolve(payload.id, '（手机点选提交）', 'phone', [{ action: 'confirm', clusterId: 'C03#2' }])
  const r = await court
  assert.equal(r.success, true)
  const parsed = await ImprovementLedger.getInstance().getParsed()
  assert.deepEqual(parsed!.confirmed.map((e) => e.title), ['碰撞乙1'], '只有第二个簇落账')
  assert.equal(parsed!.pending.length, 2, '第一个簇（同 C 编号）不受影响')
  asks.off()
})

// ==================== Q. 原地翻页（improve.page · 单卡原地翻页迭代 core 侧） ====================

/** 起一个重账本开庭（25 簇 × 30 条强制截批），返回捕获的 asks 与首个卡载荷 */
async function openHeavyCourt() {
  makeLedger({ [FILE]: makeMd(makeHeavyEntries()) })
  resetAskChannel()
  const asks = captureAsks()
  const court = openImprovementCourt()
  await tick()
  return { asks, court }
}

test('Q1 原地翻页：本页 decisions 先落账再换页；回翻已决页带 decided 标注；卡带 inplace 能力声明', async () => {
  const { asks, court } = await openHeavyCourt()
  const card1 = asks.fired[0].card!
  assert.equal(card1.inplace, true, '开庭构造的卡带 inplace 能力声明')
  assert.equal(card1.batch!.offset, 0)
  const firstClusterId = card1.clusters[0].id
  const firstClusterSize = card1.clusters.length

  // 翻页：本页点选随翻页落账
  const r = await turnImprovementCourtPage('next', [{ action: 'confirm', clusterId: firstClusterId }])
  assert.ok(r.ok)
  assert.equal(r.ok && r.card.batch!.offset, firstClusterSize, '下一页 offset = 本批 offset + 本批簇数')
  assert.equal(r.ok && r.card.inplace, true)
  const parsed = await ImprovementLedger.getInstance().getParsed()
  assert.equal(parsed!.confirmed.length, 30, '本页点选已随翻页落账（翻页即提交）')

  // 回翻：已决条目带 decided 标注（落定行渲染数据源）
  const back = await turnImprovementCourtPage('prev')
  assert.ok(back.ok)
  assert.equal(back.ok && back.card.batch!.offset, 0)
  const decidedEntries = back.ok ? back.card.clusters[0].entries! : []
  assert.ok(decidedEntries.length > 0 && decidedEntries.every((e) => e.decided === 'confirm'), '已决条目逐条带 decided 标注')

  // 收卷：翻页落账回执累计进最终结果
  getAskChannel().resolve(asks.fired[0].id, 's all', 'phone')
  const final = await court
  assert.ok(final.data!.includes('确认 30 条'), '翻页落账回执汇总进收卷结果')
  asks.off()
})

test('Q2 offset clamp：首批上一批原地不动；翻到末批后下一批原地不动', async () => {
  const { asks, court } = await openHeavyCourt()
  const atStart = await turnImprovementCourtPage('prev')
  assert.ok(atStart.ok)
  assert.equal(atStart.ok && atStart.card.batch!.offset, 0, '首批 prev 钳在 0')

  // 一路翻到末批
  let cur = atStart
  for (let i = 0; i < 30 && cur.ok && cur.card.batch!.offset + cur.card.clusters.length < cur.card.batch!.total; i++) {
    cur = await turnImprovementCourtPage('next')
  }
  assert.ok(cur.ok)
  const lastOffset = cur.ok ? cur.card.batch!.offset : -1
  const beyond = await turnImprovementCourtPage('next')
  assert.ok(beyond.ok)
  assert.equal(beyond.ok && beyond.card.batch!.offset, lastOffset, '末批 next 钳住不动')

  getAskChannel().resolve(asks.fired[0].id, 's all', 'phone')
  await court
  asks.off()
})

test('Q3 无开庭/已收卷翻页 → 明确错误「没有进行中的裁决」', async () => {
  resetAskChannel()
  const noCourt = await turnImprovementCourtPage('next')
  assert.equal(noCourt.ok, false)
  assert.equal(!noCourt.ok && noCourt.error, '没有进行中的裁决')

  // 已收卷（提交后又点翻页竞态）：开庭 → 收卷 → 翻页报错
  const { asks, court } = await openHeavyCourt()
  getAskChannel().resolve(asks.fired[0].id, 's all', 'phone')
  await court
  await tick()
  const afterSettle = await turnImprovementCourtPage('prev')
  assert.equal(afterSettle.ok, false)
  assert.equal(!afterSettle.ok && afterSettle.error, '没有进行中的裁决')
  asks.off()
})

test('Q4 翻页串行化：并发两次 next 顺序迁移（不双双从同一页出发）', async () => {
  const { asks, court } = await openHeavyCourt()
  const size1 = asks.fired[0].card!.clusters.length
  const [a, b] = await Promise.all([turnImprovementCourtPage('next'), turnImprovementCourtPage('next')])
  assert.ok(a.ok && b.ok)
  const offA = a.ok ? a.card.batch!.offset : -1
  const offB = b.ok ? b.card.batch!.offset : -1
  assert.equal(offA, size1, '第一次翻页从首批出发')
  assert.equal(offB, offA + (a.ok ? a.card.clusters.length : 0), '第二次翻页从第一次落点出发（串行）')

  getAskChannel().resolve(asks.fired[0].id, 's all', 'phone')
  await court
  asks.off()
})

test('Q5 翻页落账幂等：同 decisions 重复提交不双落账', async () => {
  const { asks, court } = await openHeavyCourt()
  const card1 = asks.fired[0].card!
  const firstClusterId = card1.clusters[0].id
  await turnImprovementCourtPage('next', [{ action: 'confirm', clusterId: firstClusterId }])
  const once = await ImprovementLedger.getInstance().getParsed()
  // 回翻再带同一条 decisions 翻走（重投场景）
  await turnImprovementCourtPage('prev')
  await turnImprovementCourtPage('next', [{ action: 'confirm', clusterId: firstClusterId }])
  const twice = await ImprovementLedger.getInstance().getParsed()
  assert.equal(twice!.confirmed.length, once!.confirmed.length, '重复落账幂等（title 未命中即空操作）')

  getAskChannel().resolve(asks.fired[0].id, 's all', 'phone')
  await court
  asks.off()
})

test('Q6 cmd 通道：improve.page 无开庭报错 / 非法参数拒绝 / 有开庭返回新页卡', async () => {
  resetAskChannel()
  const noCourt = await executeCommand({}, 'improve.page', { dir: 'next' })
  assert.equal(noCourt.ok, false)
  assert.equal((noCourt as { error?: { message?: string } }).error?.message, '没有进行中的裁决')

  const badDir = await executeCommand({}, 'improve.page', { dir: ' sideways ' })
  assert.equal(badDir.ok, false)
  assert.equal((badDir as { error?: { code?: string } }).error?.code, 'invalid_args')
  const badDecision = await executeCommand({}, 'improve.page', { dir: 'next', decisions: [{ action: 'bogus' }] })
  assert.equal(badDecision.ok, false)

  const { asks, court } = await openHeavyCourt()
  const r = await executeCommand({}, 'improve.page', { dir: 'next', decisions: [] })
  assert.equal(r.ok, true)
  const card = (r as { data?: { card?: { batch?: { offset: number } } } }).data?.card
  assert.ok(card, 'cmdResult data.card 携带新页卡')
  assert.equal(card!.batch!.offset, asks.fired[0].card!.clusters.length)

  getAskChannel().resolve(asks.fired[0].id, 's all', 'phone')
  await court
  asks.off()
})

// ==================== R. 分页布局前置（"第 x/y 批"跳变根治 · 布局=开庭会话事实） ====================

test('R1 布局确定性：同输入两次规划逐字一致；页界连续无重叠、全覆盖', () => {
  const heavy = parseProposals(makeMd(makeHeavyEntries()))
  const view = buildDecisionView(heavy, { now: NOW })
  const a = planTriageLayout(view, 2000, { pending: heavy.pending })!
  const b = planTriageLayout(view, 2000, { pending: heavy.pending })!
  assert.deepEqual(a, b, '布局是纯函数：同输入逐字同')
  let expect = 0
  for (const p of a.pages) {
    assert.equal(p.offset, expect, '页界连续')
    expect += p.clusterCount
  }
  assert.equal(expect, view.clusters.length, '页集全覆盖')
})

test('R2 标注余量：布局按 decided 最坏情形计费——全条目带标注的页卡仍在预算内', () => {
  const heavy = parseProposals(makeMd(makeHeavyEntries()))
  const view = buildDecisionView(heavy, { now: NOW })
  const QB = 2000
  const layout = planTriageLayout(view, QB, { pending: heavy.pending })!
  const allDecided = new Map(heavy.pending.map((e) => [e.title, 'confirm' as const]))
  for (let i = 0; i < layout.pages.length; i++) {
    const card = buildTriagePageCard(view, layout, i, { pending: heavy.pending, decidedByTitle: allDecided })!
    const bytes = new TextEncoder().encode(JSON.stringify(card)).length
    assert.ok(bytes + QB <= PLAINTEXT_BUDGET_BYTES, `页 ${i} 全标注仍合预算（${bytes}+${QB}=${bytes + QB}）`)
    assert.ok(card.clusters.every((c) => c.entries!.every((e) => e.decided === 'confirm')), '标注随行')
  }
})

test('R3 开庭布局前置：卡带 pageIndex/pageCount；翻页后 pageCount 恒定（y 不跳变）', async () => {
  const { asks, court } = await openHeavyCourt()
  const card1 = asks.fired[0].card!
  assert.ok(card1.batch)
  assert.equal(card1.batch!.pageIndex, 0)
  const pageCount = card1.batch!.pageCount
  assert.ok(pageCount !== undefined && pageCount > 1, '重账本必须多页')
  const r = await turnImprovementCourtPage('next')
  assert.ok(r.ok)
  assert.equal(r.ok && r.card.batch!.pageIndex, 1)
  assert.equal(r.ok && r.card.batch!.pageCount, pageCount, 'pageCount 全程恒定（y 不跳变）')
  assert.equal(r.ok && r.card.batch!.offset, card1.clusters.length, '页 2 offset = 页 1 簇数（页界连续）')

  getAskChannel().resolve(asks.fired[0].id, 's all', 'phone')
  await court
  asks.off()
})
