<template>
  <!-- 看板气泡(Teleport 到 body 防 runtime-expand 裁剪;z-index 1600:高于过程面板 overlay 1500、低于设置覆盖层 2000) -->
  <Teleport to="body">
    <div ref="popRef" class="board-popover" :style="popStyle">
      <div class="pop-head"><span class="pop-title">看板{{ team?.name ? ` · ${team.name}` : '' }}</span><span class="pop-hint">点空白处收起</span></div>

      <!-- 空看板引导空态(设计稿空态②) -->
      <div v-if="!team || team.boardGroups.length === 0" class="pop-empty">
        <div class="ico">📋</div>
        <div class="t">暂无条目</div>
        <div class="d">Lead 或成员可用 team_board 挂活;<br>成员从看板认领条目开工。</div>
      </div>

      <div v-else class="pop-body">
        <template v-for="g in displayGroups" :key="g.status">
          <!-- 已完成默认折叠(多轮累积防噪,一行计数可点开) -->
          <div v-if="g.status === 'completed'" class="pb-group">
            <div class="pb-gtitle clickable" @click="completedExpanded = !completedExpanded">
              🟢 已完成({{ g.items.length }}) {{ completedExpanded ? '▾' : '▸' }}
            </div>
            <template v-if="completedExpanded">
              <div v-for="i in g.items" :key="i.id" class="pb-item">
                <span class="t">{{ i.title }}</span>
                <span v-if="i.assignee" class="who">{{ i.assignee }}</span>
                <span class="done">{{ fmtClock(i.updatedAt) }}</span>
              </div>
            </template>
          </div>

          <div v-else class="pb-group">
            <div class="pb-gtitle">{{ GROUP_LABEL[g.status] }}</div>
            <template v-for="i in g.items" :key="i.id">
              <div
                class="pb-item"
                :class="{ clickable: hasHistory(i) }"
                :title="hasHistory(i) ? '点击展开/收起退回历史' : ''"
                @click="hasHistory(i) && toggleHistory(i.id)"
              >
                <span class="t">{{ i.title }}</span>
                <span v-if="i.assignee" class="who">{{ i.assignee }}</span>
                <span class="meta">{{ itemMeta(g.status, i) }}</span>
              </div>
              <!-- 退回历史+交付摘要(只在气泡出现,成员行/警示行保持一行) -->
              <div v-if="hasHistory(i) && expandedHistory.has(i.id)" class="pb-detail">
                <div v-for="(r, idx) in i.releaseHistory" :key="idx" class="rel-line">
                  <span class="rel">退回:{{ r.reason }}</span>
                  {{ r.by }} · {{ fmtClock(r.at) }}{{ r.suggestedTo ? ` · 建议:${r.suggestedTo}` : '' }}
                </div>
                <div v-if="i.result" class="rel-result">
                  <span class="rel-result-label">交付摘要:</span>
                  <MessageMarkdown :content="i.result" />
                </div>
              </div>
            </template>
          </div>
        </template>
      </div>
      <div class="pop-arrow" :style="arrowStyle"></div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import type { RuntimeTeamSection, RuntimeBoardItem, BoardItemStatus } from '@assistant-ai/core'
import { useRuntimePillStore } from '../stores/runtimePillStore'
import MessageMarkdown from './MessageMarkdown.vue'

/**
 * 看板气泡(看板显示三段式 · 明细在气泡;设计稿 team-observe-merged.html):
 * 点看板行浮出全量看板(待认领/进行中/已完成[默认折叠]/失败退回),退回条目可展开 releaseHistory+result;
 * 纯观测零操作;点空白处收起;防出屏——上方空间不足时向下弹出,限高滚动。
 * 数据唯一来源 = core 投影 boardGroups(SSOT,UI 不直接读 teamState.board 组装);快照区同款只读。
 */
const props = defineProps<{
  team: RuntimeTeamSection | null
  /** 锚点(看板行)的视口矩形 */
  anchorRect: DOMRect | null
}>()
const emit = defineEmits<{
  close: []
}>()

const runtimePillStore = useRuntimePillStore()

const POP_WIDTH = 340
const POP_MAX_BODY = 280

const GROUP_LABEL: Record<BoardItemStatus, string> = {
  pending: '🟡 待认领',
  in_progress: '🟣 进行中',
  completed: '🟢 已完成',
  failed: '🔴 失败退回',
}

// 投影已是固定序,直接透传(completed 单独处理折叠)
const displayGroups = computed(() => props.team?.boardGroups ?? [])

const completedExpanded = ref(false)
const expandedHistory = ref<Set<string>>(new Set())
const hasHistory = (i: RuntimeBoardItem): boolean => (i.releaseHistory?.length ?? 0) > 0
const toggleHistory = (id: string): void => {
  if (expandedHistory.value.has(id)) expandedHistory.value.delete(id)
  else expandedHistory.value.add(id)
}

// ---------- 定位:锚点上方优先,上方空间不足向下弹出(防出屏);水平防右出屏 ----------
const POP_EST_HEIGHT = 360 // 估算高度(头 + 限高 body + 边距),仅用于上下方向判定
const popStyle = computed(() => {
  const rect = props.anchorRect
  if (!rect) return { display: 'none' }
  const openDown = rect.top < POP_EST_HEIGHT + 12 // 上方放不下 → 向下弹出
  let left = rect.left
  if (left + POP_WIDTH > window.innerWidth - 8) left = window.innerWidth - POP_WIDTH - 8
  if (left < 8) left = 8
  return openDown
    ? { left: `${left}px`, top: `${rect.bottom + 8}px`, width: `${POP_WIDTH}px` }
    : { left: `${left}px`, top: `${rect.top - 8}px`, width: `${POP_WIDTH}px`, transform: 'translateY(-100%)' }
})
const arrowStyle = computed(() => {
  const rect = props.anchorRect
  if (!rect) return {}
  const openDown = rect.top < POP_EST_HEIGHT + 12
  return openDown ? { top: '-6px', transform: 'rotate(225deg)' } : {}
})

// ---------- 时长/时间(store 共享分钟 tick:与成员行同一计时源) ----------
const fmtMinutes = (ts: number): string => {
  const mins = Math.max(0, Math.floor((runtimePillStore.minuteTick - ts) / 60_000))
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins} 分钟`
  return `${Math.floor(mins / 60)} 小时`
}
const fmtClock = (ts: number): string => {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
/** 条目行 meta:待认领=挂于 X 前(+最近退回建议);进行中=认领时长(无 claimedAt 旧数据不显示);失败退回=退回 N 次 ▸ */
const itemMeta = (status: BoardItemStatus, i: RuntimeBoardItem): string => {
  if (status === 'pending') {
    const ago = `挂于 ${fmtMinutes(i.createdAt)}前`
    const suggested = i.releaseHistory?.at(-1)?.suggestedTo
    return suggested ? `${ago} · 建议:${suggested}` : ago
  }
  if (status === 'in_progress') {
    const base = i.claimedAt ? fmtMinutes(i.claimedAt) : ''
    return hasHistory(i) ? `${base}${base ? ' · ' : ''}退回 ${i.releaseHistory!.length} 次 ▸` : base
  }
  // failed:退回次数可展开(无历史则空)
  return hasHistory(i) ? `退回 ${i.releaseHistory!.length} 次 ▸` : ''
}

// ---------- 点空白处收起 ----------
const popRef = ref<HTMLElement | null>(null)
const onDocDown = (e: MouseEvent): void => {
  if (popRef.value && !popRef.value.contains(e.target as Node)) emit('close')
}
onMounted(() => document.addEventListener('mousedown', onDocDown, true))
onUnmounted(() => document.removeEventListener('mousedown', onDocDown, true))
</script>

<style scoped>
/* 气泡(设计稿 popover;fixed 定位由 :style 供给) */
.board-popover {
  position: fixed;
  z-index: 1600;
  background: #fff;
  border: 1px solid #e5e2dc;
  border-radius: 12px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.15);
  overflow: hidden;
}

.pop-head {
  padding: 8px 14px;
  border-bottom: 1px solid #f0eee9;
  display: flex;
  align-items: center;
  gap: 8px;
  background: #fcfbfa;
}

.pop-title {
  font-size: 12px;
  font-weight: 700;
  color: #1f2937;
}

.pop-hint {
  font-size: 10px;
  color: #9ca3af;
  margin-left: auto;
}

.pop-body {
  max-height: 280px;
  overflow-y: auto;
  padding: 8px 14px 10px;
}

.pb-group {
  margin-bottom: 7px;
}

.pb-gtitle {
  font-size: 10px;
  font-weight: 700;
  color: #9ca3af;
  margin-bottom: 2px;
}

.pb-gtitle.clickable {
  cursor: pointer;
}

.pb-item {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 11.5px;
  padding: 3px 6px;
  border-radius: 6px;
}

.pb-item:hover {
  background: #faf9f6;
}

.pb-item.clickable {
  cursor: pointer;
}

.pb-item .t {
  font-weight: 600;
  color: #1f2937;
}

.pb-item .who {
  color: #7c3aed;
  font-weight: 600;
  white-space: nowrap;
}

.pb-item .meta {
  color: #9ca3af;
  font-size: 10px;
  margin-left: auto;
  white-space: nowrap;
}

.pb-item .done {
  color: #10b981;
  font-size: 10px;
  margin-left: auto;
}

.pb-detail {
  margin: 2px 6px 4px 18px;
  padding: 5px 9px;
  background: #f7f5f1;
  border: 1px solid #eceae4;
  border-radius: 6px;
  font-size: 10.5px;
  color: #4b5563;
  line-height: 1.5;
}

.pb-detail .rel {
  color: #b45309;
}

.rel-line + .rel-line {
  margin-top: 3px;
}

/* 交付摘要经 markdown 渲染：不再 pre-wrap（避免与 markdown 换行双计） */
.rel-result {
  margin-top: 4px;
  word-break: break-word;
}

.rel-result-label {
  font-weight: 600;
  color: #4b5563;
}

.pop-arrow {
  position: absolute;
  left: 24px;
  top: 100%;
  width: 12px;
  height: 12px;
  background: #fff;
  border-right: 1px solid #e5e2dc;
  border-bottom: 1px solid #e5e2dc;
  transform: rotate(45deg) translateY(-6px);
}

/* 空看板引导空态(设计稿空态② pop-empty) */
.pop-empty {
  padding: 26px 20px 24px;
  text-align: center;
}

.pop-empty .ico {
  font-size: 26px;
  margin-bottom: 8px;
}

.pop-empty .t {
  font-size: 13px;
  font-weight: 700;
  color: #1f2937;
  margin-bottom: 6px;
}

.pop-empty .d {
  font-size: 11.5px;
  color: #9ca3af;
  line-height: 1.7;
}
</style>
