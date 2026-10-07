<template>
  <div class="improvements-panel">
    <!-- 统计条 -->
    <div class="stats-bar">
      <div class="stat"><span class="num pending">{{ digest?.pending ?? 0 }}</span><span class="lbl">待确认</span></div>
      <div class="stat"><span class="num">{{ digest?.clusters ?? 0 }}</span><span class="lbl">问题簇</span></div>
      <div class="stat"><span class="num confirmed">{{ digest?.confirmed ?? 0 }}</span><span class="lbl">已确认（待实施）</span></div>
      <div class="stat"><span class="num implemented">{{ digest?.implemented ?? 0 }}</span><span class="lbl">已实现</span></div>
    </div>

    <!-- 老化置顶提示（可关闭） -->
    <div v-if="store.agingNote" class="aging-note">
      <span>⏳ {{ store.agingNote }}</span>
      <button class="link-btn" @click="store.agingNote = null">×</button>
    </div>

    <!-- 错误提示 -->
    <div v-if="store.lastError" class="error-note">✗ {{ store.lastError }}</div>

    <!-- 四区 tab -->
    <div class="zone-tabs">
      <button v-for="z in zones" :key="z.key" class="zone-tab" :class="{ active: activeZone === z.key }" @click="activeZone = z.key">
        {{ z.label }} <span class="count">{{ z.count }}</span>
      </button>
    </div>

    <!-- 待确认：簇卡片 -->
    <div v-if="activeZone === 'pending'" class="zone-body">
      <div v-if="!store.loaded && store.loading" class="empty">加载中…</div>
      <div v-else-if="store.clusters.length === 0" class="empty">
        （暂无待确认改进提案{{ store.digest && store.digest.pending > 0 ? `——${store.digest.pending} 条在册但无分组` : '' }}；
        npm 模式下自动攒料不运行）
      </div>
      <div v-for="(c, ci) in store.clusters" :key="c.id" class="cluster-card" :class="{ done: settledClusters.has(c.id) }">
        <div class="cluster-head">
          <span class="c-id">{{ c.id }}</span>
          <span class="c-name">{{ c.name }}</span>
          <span class="badges">
            <span v-if="c.recent > 0" class="badge new">近期+{{ c.recent }}</span>
            <span class="badge" :class="diffClass(c)">{{ diffLabel(c) }}</span>
            <span class="badge plain">最新 {{ c.latest || '—' }}</span>
            <span v-if="settledClusters.has(c.id)" class="badge done-badge">✓ 已确认（待实施）</span>
          </span>
        </div>
        <div class="cluster-preview">「{{ c.entries[0]?.title ?? '' }}」</div>
        <div class="cluster-actions">
          <button class="btn primary" :disabled="store.loading || settledClusters.has(c.id)" @click="confirmCluster(ci)">✓ 确认整簇（{{ c.count }} 条）</button>
          <button class="btn" :disabled="store.loading" @click="activeZone = 'pending'; toggleExpand(ci)">{{ expanded === ci ? '收起' : `展开 ${c.count} 条` }}</button>
        </div>
        <div v-if="expanded === ci" class="entries">
          <div v-for="e in c.entries" :key="e.title" class="entry" :class="{ 'settled-yes': entrySettled[e.title] === 'yes', 'settled-no': entrySettled[e.title] === 'no' }">
            <div class="e-title">{{ e.title }}<span v-if="entrySettled[e.title] === 'yes'" class="mini">✓ 已确认</span><span v-else-if="entrySettled[e.title] === 'no'" class="mini">✕ 已删除</span></div>
            <div class="e-meta">{{ e.difficulty ? `难度${e.difficulty} · ` : '' }}{{ e.date }}<span v-if="e.source"> · 来源：{{ e.source }}</span></div>
            <div v-if="e.reason" class="e-reason">{{ e.reason }}</div>
            <div v-if="!entrySettled[e.title]" class="e-actions">
              <button class="btn small" :disabled="store.loading" @click="confirmEntry(e)">确认</button>
              <button class="btn small danger" :disabled="store.loading" @click="deleteEntry(e)">删除</button>
            </div>
          </div>
        </div>
      </div>
      <button v-if="store.totalClusters > store.clusters.length" class="btn show-all" @click="store.toggleShowAll()">
        显示全部 {{ store.totalClusters }} 簇（当前 Top {{ store.clusters.length }}）
      </button>
    </div>

    <!-- 其他三区：简洁清单 -->
    <div v-else class="zone-body">
      <div v-if="zoneEntries(activeZone).length === 0" class="empty">（暂无）</div>
      <div v-for="(e, i) in zoneEntries(activeZone)" :key="i" class="simple-entry">
        <span class="date">{{ e.date }}</span>
        <span class="title">{{ e.title }}</span>
        <span v-if="e.group" class="group">{{ e.group }}</span>
      </div>
      <div v-if="activeZone === 'confirmed'" class="zone-hint">💡 对已确认簇说「实施 Cxx 簇」即可进入自迭代（对话中直接说即可）。</div>
      <div v-if="activeZone === 'discarded'" class="zone-hint">已关闭区条目可恢复：对助手说「把某某提案移回待确认」。</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useProposalsStore } from '../../stores/proposalsStore'
import type { ClusterSummary, Decision, ProposalEntry } from '@assistant-ai/core'

/**
 * 改进提案面板（设置页「改进提案」tab · 决策闭环迭代 3）
 * 数据/决策全走 proposalsStore（→ core ImprovementLedger 单例）；决策直构 Decision[]（R2）。
 * 安全分级：确认=无损（移入待实施）；删除需点击（移入已关闭，可恢复）。
 */
const store = useProposalsStore()
const activeZone = ref<'pending' | 'confirmed' | 'implemented' | 'discarded'>('pending')
const expanded = ref<number | null>(null)
/** 本轮已落定条目的视觉标记（title → 'yes'|'no'）——落盘后由刷新数据自然接管 */
const entrySettled = ref<Record<string, 'yes' | 'no'>>({})
const settledClusters = computed(() => {
  const s = new Set<string>()
  for (const c of store.clusters) if (c.entries.length > 0 && c.entries.every(e => entrySettled.value[e.title] === 'yes')) s.add(c.id)
  return s
})

const digest = computed(() => store.digest)
const zones = computed(() => [
  { key: 'pending' as const, label: '待确认', count: store.digest?.pending ?? 0 },
  { key: 'confirmed' as const, label: '已确认', count: store.digest?.confirmed ?? 0 },
  { key: 'implemented' as const, label: '已实现', count: store.digest?.implemented ?? 0 },
  { key: 'discarded' as const, label: '已关闭', count: store.zones?.discarded.length ?? 0 },
])

const zoneEntries = (z: 'confirmed' | 'implemented' | 'discarded'): ProposalEntry[] =>
  z === 'confirmed' ? store.confirmedEntries() : z === 'implemented' ? store.implementedEntries() : store.discardedEntries()

const diffLabel = (c: ClusterSummary) => (c.dominantDifficulty ? `${c.dominantDifficulty}难度为主` : '难度未标')
const diffClass = (c: ClusterSummary) => (c.dominantDifficulty === '低' ? 'low' : c.dominantDifficulty === '中' ? 'mid' : c.dominantDifficulty === '高' ? 'high' : '')

const toggleExpand = (ci: number) => {
  expanded.value = expanded.value === ci ? null : ci
}

const applyDecisions = async (decisions: Decision[], settled: 'yes' | 'no', okMsg: string) => {
  const ok = await store.decide(decisions)
  if (ok) {
    for (const d of decisions) entrySettled.value[d.title] = settled
    store.lastError = null
    // 落定的簇收起展开态
    if (settled === 'yes' && expanded.value !== null) {
      const c = store.clusters[expanded.value]
      if (c && c.entries.every(e => entrySettled.value[e.title])) expanded.value = null
    }
  } else {
    store.lastError = store.lastError ?? '写入失败'
  }
  void okMsg
}

const confirmCluster = async (ci: number) => {
  const c = store.clusters[ci]
  if (!c) return
  await applyDecisions(c.entries.map(e => ({ title: e.title, action: 'confirm' as const })), 'yes', `已确认 ${c.id} 簇`)
}

const confirmEntry = async (e: ProposalEntry) => {
  await applyDecisions([{ title: e.title, action: 'confirm' }], 'yes', '已确认')
}

const deleteEntry = async (e: ProposalEntry) => {
  await applyDecisions([{ title: e.title, action: 'close' }], 'no', '已删除（可恢复）')
}

onMounted(() => {
  void store.open()
})
</script>

<style scoped>
.improvements-panel { padding: 16px 18px; max-width: 860px; }
.stats-bar { display: flex; gap: 12px; margin-bottom: 12px; }
.stat { flex: 1; background: var(--bg-card, #f6f7f9); border: 1px solid #e3e6ea; border-radius: 8px; padding: 10px 14px; }
.stat .num { font-size: 20px; font-weight: 700; color: #38587a; display: block; }
.stat .num.confirmed { color: #b98a2e; }
.stat .num.implemented { color: #6b7484; }
.stat .lbl { font-size: 12px; color: #6b7484; }
.aging-note { display: flex; justify-content: space-between; align-items: center; background: #fbf3e2; border: 1px solid #ecd9ae; border-radius: 8px; padding: 8px 12px; margin-bottom: 10px; font-size: 13px; color: #8a6a1e; }
.error-note { background: #faeeec; border: 1px solid #ecd2ce; border-radius: 8px; padding: 8px 12px; margin-bottom: 10px; font-size: 13px; color: #b5544a; }
.link-btn { border: none; background: none; cursor: pointer; color: #8a6a1e; font-size: 15px; }
.zone-tabs { display: flex; gap: 6px; border-bottom: 1px solid #e3e6ea; margin-bottom: 14px; flex-wrap: wrap; }
.zone-tab { border: none; background: none; padding: 8px 14px; font-size: 13.5px; color: #6b7484; cursor: pointer; border-bottom: 2px solid transparent; }
.zone-tab.active { color: #38587a; border-color: #4a7aa8; font-weight: 600; }
.zone-tab .count { opacity: 0.75; font-size: 12px; margin-left: 3px; }
.zone-body { display: flex; flex-direction: column; gap: 10px; }
.empty { color: #9aa2ae; font-size: 13.5px; padding: 14px 4px; }
.cluster-card { border: 1px solid #e3e6ea; border-radius: 10px; padding: 12px 14px; background: #fff; }
.cluster-card.done { border-color: #cfe4d6; background: #eaf5ef; }
.cluster-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.c-id { font-weight: 700; color: #4a7aa8; }
.c-name { font-weight: 600; font-size: 14px; }
.badges { margin-left: auto; display: flex; gap: 6px; flex-wrap: wrap; }
.badge { font-size: 11px; padding: 2px 9px; border-radius: 999px; border: 1px solid #e3e6ea; color: #6b7484; background: #fafbfc; white-space: nowrap; }
.badge.new { background: #eef3f8; border-color: #cddcec; color: #38587a; font-weight: 600; }
.badge.low { color: #3d8f5f; border-color: #cfe4d6; background: #eaf5ef; }
.badge.mid { color: #b98a2e; border-color: #ecd9ae; background: #fbf3e2; }
.badge.high { color: #b5544a; border-color: #ecd2ce; background: #faeeec; }
.badge.done-badge { color: #3d8f5f; border-color: #cfe4d6; background: #eaf5ef; }
.cluster-preview { color: #6b7484; font-size: 13px; margin: 6px 0 8px; }
.cluster-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.btn { border: 1px solid #e3e6ea; background: #fff; color: #6b7484; border-radius: 7px; padding: 5px 14px; font-size: 13px; cursor: pointer; }
.btn:hover:not(:disabled) { border-color: #4a7aa8; color: #4a7aa8; }
.btn.primary { background: #4a7aa8; border-color: #4a7aa8; color: #fff; font-weight: 600; }
.btn.primary:hover:not(:disabled) { background: #38587a; }
.btn.small { padding: 2px 10px; font-size: 12px; }
.btn.danger:hover:not(:disabled) { border-color: #b5544a; color: #b5544a; }
.btn.show-all { align-self: center; }
.btn:disabled { opacity: 0.5; cursor: default; }
.entries { border-top: 1px dashed #e3e6ea; margin-top: 10px; padding-top: 6px; }
.entry { padding: 8px 2px; border-bottom: 1px dashed #e3e6ea; }
.entry:last-child { border-bottom: none; }
.e-title { font-size: 13.5px; font-weight: 600; }
.entry.settled-yes .e-title { color: #3d8f5f; }
.entry.settled-no .e-title { color: #9aa2ae; text-decoration: line-through; }
.mini { font-size: 11px; color: #6b7484; margin-left: 8px; }
.e-meta { font-size: 12px; color: #9aa2ae; margin: 2px 0; }
.e-reason { font-size: 12px; color: #6b7484; }
.e-actions { display: flex; gap: 6px; margin-top: 4px; }
.simple-entry { display: flex; gap: 10px; padding: 7px 4px; border-bottom: 1px dashed #e3e6ea; font-size: 13px; }
.simple-entry .date { color: #9aa2ae; flex: none; }
.simple-entry .title { color: #2b3240; }
.simple-entry .group { color: #9aa2ae; font-size: 12px; margin-left: auto; }
.zone-hint { color: #9aa2ae; font-size: 12.5px; padding: 6px 2px; }
</style>
