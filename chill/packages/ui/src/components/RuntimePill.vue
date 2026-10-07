<template>
  <div class="runtime-pill-display">
    <!-- 折叠药丸(没有运行中的东西不出现——由外层 v-if runtimePillStore.hasRuntime 保证) -->
    <div class="runtime-pill" :class="{ red: projection.overBudget }" @click="toggleExpanded">
      <span v-if="projection.allDone" class="pill-done">✓</span>
      <span v-else class="pill-dot"></span>
      <span class="pill-title">{{ pillLabel }}</span>
      <svg class="expand-icon" :class="{ expanded }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="6 9 12 15 18 9"/>
      </svg>
    </div>

    <!-- 就地展开面板(团队区 / 独立任务区;点某行进第二级详情) -->
    <transition name="expand">
      <div v-show="expanded" class="runtime-expand">
        <div class="expand-head">
          <span class="expand-title">{{ headTitle }}</span>
          <button v-if="finishedCount > 0" class="clear-finished-btn" @click.stop="runtimePillStore.clearFinished()">清空已结束</button>
          <!-- 全部停止(两步确认,3s 未确认自动复位;等价 CLI 的 Ctrl+K 双击) -->
          <button
            v-if="projection.runningCount > 0"
            class="kill-all-btn"
            :class="{ confirming: confirmingKillAll }"
            @click.stop="onKillAll"
          >
            {{ confirmingKillAll ? '确认停止全部?' : '全部停止' }}
          </button>
        </div>

        <!-- 团队区 -->
        <div v-if="projection.team" class="sec">
          <div class="sec-title">{{ projection.team.name || '临时团队' }}(团队)</div>
          <template v-for="m in projection.team.members" :key="m.name">
            <div
              class="row"
              :class="{ clickable: !!m.task, active: !!m.task && runtimePillStore.selectedTaskId === m.task.taskId }"
              @click="m.task && runtimePillStore.toggleSelectTask(m.task.taskId)"
            >
              <span class="sdot" :class="memberDotClass(m)"></span>
              <span class="rname">{{ m.name }}</span>
              <span class="rdoing">{{ memberDoing(m) }}</span>
              <!-- 过程 ›(点开右侧执行过程面板;选中行高亮) -->
              <span v-if="m.task" class="rarrow">过程 ›</span>
              <!-- 逐任务取消(两步确认,3s 未确认自动复位) -->
              <button
                v-if="m.task?.status === 'running'"
                class="rcancel"
                :class="{ confirming: confirmingTaskId === m.task.taskId }"
                @click.stop="onCancelTask(m.task.taskId)"
              >
                {{ confirmingTaskId === m.task.taskId ? '确认取消?' : '取消' }}
              </button>
            </div>
          </template>
          <!-- 待认领警示行(最高价值信号常驻一行;多条取最早一条+N 计数,其余在气泡里看) -->
          <div v-if="projection.team.pendingWarning" class="arow-pending">
            🟡 <span class="t">{{ projection.team.pendingWarning.count }} 条待认领「{{ projection.team.pendingWarning.title }}」</span>
            <span class="meta">挂于 {{ fmtAgo(projection.team.pendingWarning.createdAt) }}</span>
          </div>
          <!-- 看板行(有团队即无条件渲染:有条目显示计数,空看板灰色"(空)"——气泡入口必须可达) -->
          <div class="board-line" :class="{ empty: isBoardEmpty(projection.team.boardCounts) }" @click.stop="openBoardPopover($event, 'local')">
            <template v-if="!isBoardEmpty(projection.team.boardCounts)">
              看板:待认领 <b>{{ projection.team.boardCounts.pending }}</b> · 进行中 <b>{{ projection.team.boardCounts.inProgress }}</b> · 已完成 <b>{{ projection.team.boardCounts.completed }}</b> ▴
            </template>
            <template v-else>看板:(空) ▴</template>
          </div>
          <div class="ledger">
            账本:<span :class="{ over: projection.team.overBudget }">{{ projection.team.ledgerText }}{{ projection.team.overBudget ? '(已超)' : '' }}</span>
          </div>
        </div>

        <!-- 独立任务区 -->
        <div v-if="projection.independentTasks.length > 0" class="sec">
          <div class="sec-title">独立任务</div>
          <template v-for="t in projection.independentTasks" :key="t.taskId">
            <div
              class="row clickable"
              :class="{ active: runtimePillStore.selectedTaskId === t.taskId }"
              @click="runtimePillStore.toggleSelectTask(t.taskId)"
            >
              <span class="sdot" :class="taskDotClass(t.status)"></span>
              <span class="rname">{{ t.subagentType }}</span>
              <span class="rdoing">{{ taskDoing(t) }}</span>
              <span class="rarrow">过程 ›</span>
              <button
                v-if="t.status === 'running'"
                class="rcancel"
                :class="{ confirming: confirmingTaskId === t.taskId }"
                @click.stop="onCancelTask(t.taskId)"
              >
                {{ confirmingTaskId === t.taskId ? '确认取消?' : '取消' }}
              </button>
            </div>
          </template>
        </div>

        <!-- 跨进程快照区(迭代 2;只读,无取消按钮、无控制——控制请回来源会话;看板气泡同款只读) -->
        <div v-for="s in snapshotProjections" :key="s.runId" class="sec">
          <div class="sec-title">
            {{ s.team.name || '临时团队' }}(团队)
            <span class="snap-tag">快照 · 更新于 {{ formatClock(s.updatedAt) }} · 来源:另一进程</span>
          </div>
          <div v-for="m in s.team.members" :key="m.name" class="row">
            <span class="sdot" :class="memberDotClass(m)"></span>
            <span class="rname">{{ m.name }}</span>
            <span class="rdoing">{{ memberDoing(m) }}(只读)</span>
          </div>
          <div v-if="s.team.pendingWarning" class="arow-pending">
            🟡 <span class="t">{{ s.team.pendingWarning.count }} 条待认领「{{ s.team.pendingWarning.title }}」</span>
            <span class="meta">挂于 {{ fmtAgo(s.team.pendingWarning.createdAt) }}</span>
          </div>
          <div class="board-line" :class="{ empty: isBoardEmpty(s.team.boardCounts) }" @click.stop="openBoardPopover($event, s.runId)">
            <template v-if="!isBoardEmpty(s.team.boardCounts)">
              看板:待认领 <b>{{ s.team.boardCounts.pending }}</b> · 进行中 <b>{{ s.team.boardCounts.inProgress }}</b> · 已完成 <b>{{ s.team.boardCounts.completed }}</b> ▴
            </template>
            <template v-else>看板:(空) ▴</template>
          </div>
          <div class="ledger">
            账本:<span :class="{ over: s.team.overBudget }">{{ s.team.ledgerText }}{{ s.team.overBudget ? '(已超)' : '' }}</span>
          </div>
          <div class="snap-note">该团队运行在 CLI/手机会话,此处只读;控制请回到对应会话。</div>
        </div>

        <!-- 看板气泡(锚定看板行;点空白处收起;快照区同款只读) -->
        <BoardPopover
          v-if="boardPopoverTeam !== null"
          :team="boardPopoverTeam"
          :anchor-rect="boardAnchorRect"
          @close="closeBoardPopover"
        />
      </div>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { executeCancelTask, cancelAllRunningTasks } from '@assistant-ai/core'
import type { RuntimeMemberRow, RuntimeProcessTask, RuntimeBoardCounts } from '@assistant-ai/core'
import { useRuntimePillStore } from '../stores/runtimePillStore'
import BoardPopover from './BoardPopover.vue'

/**
 * "运行"药丸(UI 三层显示统一 · 迭代 1 + 迭代 2 + 看板三段式):运行态唯一观测点。
 * 零 props:直读 runtimePillStore,视图模型由 core buildRuntimeProjection 供给;
 * 结构/文案/配色照设计稿 weRealize/mockups/runtime-pill.html 与 team-observe-merged.html;
 * 取消/全部停止自 SubagentProcessDisplay 平移(两步确认哲学保留);
 * 迭代 2:跨进程快照区(另一进程落盘的 team-runs 运行态,只读,带"更新于"时间戳,无取消按钮);
 * 执行过程面板:成员/任务行"过程 ›"点开右侧面板(选中行高亮;二级就地展开已退役,详情统一进面板;
 * 快照区行不出"过程 ›"——跨进程无实时事件,不伪装实时);
 * 看板三段式:成员行带认领(认领「…」· N 分钟)+ 待认领警示行 + 看板气泡(点看板行浮出;
 * 有团队即无条件渲染看板行——空看板灰色"(空)",气泡引导空态必须可达;纯观测零操作)。
 */
const runtimePillStore = useRuntimePillStore()
const projection = computed(() => runtimePillStore.projection)
const snapshotProjections = computed(() => runtimePillStore.snapshotProjections)

const expanded = ref(false)
const toggleExpanded = () => {
  expanded.value = !expanded.value
}

// 取消按钮两步确认状态(确认态 3s 未确认自动复位——与 Ctrl+K 双击确认同哲学)
const confirmingTaskId = ref<string | null>(null)
const confirmingKillAll = ref(false)
let confirmTimer: ReturnType<typeof setTimeout> | null = null

const resetConfirmLater = (): void => {
  if (confirmTimer) clearTimeout(confirmTimer)
  confirmTimer = setTimeout(() => {
    confirmingTaskId.value = null
    confirmingKillAll.value = false
    confirmTimer = null
  }, 3000)
}

/** 逐任务取消:core executeCancelTask 全链路(拒审批/销毁环境/占位写回;状态经 settle 事件自更新) */
const onCancelTask = (taskId: string): void => {
  if (confirmingTaskId.value === taskId) {
    confirmingTaskId.value = null
    if (confirmTimer) { clearTimeout(confirmTimer); confirmTimer = null }
    executeCancelTask({ toolCallId: taskId }).catch(() => {})
    return
  }
  confirmingTaskId.value = taskId
  confirmingKillAll.value = false
  resetConfirmLater()
}

/** 全部停止:core cancelAllRunningTasks(逐项复用单取消全链路) */
const onKillAll = (): void => {
  if (confirmingKillAll.value) {
    confirmingKillAll.value = false
    if (confirmTimer) { clearTimeout(confirmTimer); confirmTimer = null }
    cancelAllRunningTasks().catch(() => {})
    return
  }
  confirmingKillAll.value = true
  confirmingTaskId.value = null
  resetConfirmLater()
}

// 折叠态文案:进行中 N / 全部落地 ✓ 全部完成 / 仅快照时标来源
const pillLabel = computed(() => {
  const p = projection.value
  if (p.runningCount > 0) {
    return p.team ? `${p.team.name || '临时团队'} · ${p.runningCount} 进行中` : `${p.runningCount} 进行中`
  }
  if (p.allDone) return '全部完成'
  if (p.team) return p.team.name || '临时团队'
  if (snapshotProjections.value.length > 0) return `快照 · ${snapshotProjections.value.length} 个团队`
  return '运行'
})

const headTitle = computed(() => {
  const p = projection.value
  if (p.runningCount > 0) return `运行中 · ${p.runningCount}`
  if (p.allDone) return '全部完成'
  if (!p.hasRuntime && snapshotProjections.value.length > 0) return '跨进程快照'
  return '运行'
})

const finishedCount = computed(() =>
  runtimePillStore.processTasks.filter((t) => t.status !== 'running' && t.status !== 'idle').length,
)

/** 看板空判定(四计数全零;有团队即无条件渲染看板行,空看板走灰色"(空)"+气泡引导空态) */
const isBoardEmpty = (c: RuntimeBoardCounts): boolean =>
  c.pending + c.inProgress + c.completed + c.failed === 0

// ---------- 看板气泡(锚定看板行;快照区同款只读) ----------
const boardPopoverFor = ref<string | null>(null) // 'local' | 快照 runId
const boardAnchorRect = ref<DOMRect | null>(null)

const openBoardPopover = (e: MouseEvent, key: string): void => {
  if (boardPopoverFor.value === key) {
    boardPopoverFor.value = null
    return
  }
  boardAnchorRect.value = (e.currentTarget as HTMLElement).getBoundingClientRect()
  boardPopoverFor.value = key
}
const closeBoardPopover = (): void => {
  boardPopoverFor.value = null
}

const boardPopoverTeam = computed(() => {
  if (boardPopoverFor.value === 'local') return projection.value.team
  if (boardPopoverFor.value) {
    return snapshotProjections.value.find((s) => s.runId === boardPopoverFor.value)?.team ?? null
  }
  return null
})

/** 时长格式化(共享 store 分钟 tick:成员行/警示行/气泡同一计时源;<1 分钟显"刚刚") */
const fmtDuration = (ts: number): string => {
  const mins = Math.max(0, Math.floor((runtimePillStore.minuteTick - ts) / 60_000))
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins} 分钟`
  return `${Math.floor(mins / 60)} 小时`
}
const fmtAgo = (ts: number): string => `${fmtDuration(ts)}前`

/** 快照"更新于"时间戳(HH:mm:ss) */
const formatClock = (ts: number): string => {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const statusText = (status: RuntimeProcessTask['status']): string => {
  switch (status) {
    case 'completed': return '已完成'
    case 'failed': return '失败'
    case 'cancelled': return '已取消'
    default: return ''
  }
}

const taskDotClass = (status: RuntimeProcessTask['status']): string => {
  switch (status) {
    case 'running': return 'running'
    case 'completed': return 'done'
    case 'failed': return 'failed'
    case 'cancelled': return 'standby'
    default: return 'standby'
  }
}

const memberDotClass = (m: RuntimeMemberRow): string => {
  if (m.task) return taskDotClass(m.task.status)
  return m.status
}

const memberDoing = (m: RuntimeMemberRow): string => {
  // 认领显示优先(看板三段式:归属在成员行;claimedAt 缺省=旧数据,不显示时长)
  if (m.claim) {
    return m.claim.claimedAt ? `认领「${m.claim.itemTitle}」 · ${fmtDuration(m.claim.claimedAt)}` : `认领「${m.claim.itemTitle}」`
  }
  if (m.task) {
    return m.task.status === 'running'
      ? m.task.description
      : `${m.task.description} — ${statusText(m.task.status)}`
  }
  switch (m.status) {
    case 'standby': return '待命'
    case 'idle': return '空闲'
    case 'failed': return '上次任务失败'
    default: return ''
  }
}

const taskDoing = (t: RuntimeProcessTask): string => {
  return t.status === 'running' ? t.description : `${t.description} — ${statusText(t.status)}`
}
</script>

<style scoped>
.runtime-pill-display {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  min-width: 0;
  max-width: 100%;
}

/* 折叠药丸(设计稿:白底圆角,紫点脉冲,超预算变红) */
.runtime-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: #374151;
  background: #fff;
  border: 1px solid #e5e2dc;
  border-radius: 999px;
  padding: 4px 12px;
  cursor: pointer;
  user-select: none;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
}

.pill-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #8b5cf6;
  animation: pulse 2s infinite;
  flex-shrink: 0;
}

.pill-done {
  color: #10b981;
}

.runtime-pill.red {
  border-color: rgba(239, 68, 68, 0.5);
  color: #dc2626;
}

.runtime-pill.red .pill-dot {
  background: #ef4444;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.expand-icon {
  width: 14px;
  height: 14px;
  color: #9ca3af;
  flex-shrink: 0;
  transition: transform 0.2s ease;
}

.expand-icon.expanded {
  transform: rotate(180deg);
}

/* 就地展开面板 */
.runtime-expand {
  margin-top: 6px;
  width: 100%;
  max-width: 100%;
  background: #fff;
  border: 1px solid #e8e5df;
  border-radius: 12px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.08);
  overflow: hidden;
  max-height: 320px;
  overflow-y: auto;
}

.expand-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid #f0eee9;
  background: #fcfbfa;
  position: sticky;
  top: 0;
}

.expand-title {
  font-size: 13px;
  font-weight: 700;
  color: #1f2937;
  flex: 1;
}

.kill-all-btn {
  font-size: 11px;
  color: #ef4444;
  border: 1px solid rgba(239, 68, 68, 0.35);
  border-radius: 999px;
  padding: 2px 10px;
  background: #fff;
  cursor: pointer;
  flex-shrink: 0;
}

.kill-all-btn.confirming {
  background: #ef4444;
  color: #fff;
}

.clear-finished-btn {
  font-size: 11px;
  color: #6b7280;
  border: 1px solid #e5e2dc;
  border-radius: 999px;
  padding: 2px 10px;
  background: #fff;
  cursor: pointer;
  flex-shrink: 0;
}

.clear-finished-btn:hover {
  color: #374151;
  background: #faf9f6;
}

.sec {
  padding: 10px 14px 12px;
}

.sec + .sec {
  border-top: 1px solid #f3f1ec;
}

.sec-title {
  font-size: 11px;
  font-weight: 700;
  color: #9ca3af;
  letter-spacing: 0.05em;
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 快照区徽标(设计稿 snap-tag) */
.snap-tag {
  font-size: 10.5px;
  font-weight: 500;
  color: #b45309;
  background: rgba(245, 158, 11, 0.12);
  border-radius: 999px;
  padding: 1px 8px;
  letter-spacing: 0;
  white-space: nowrap;
}

/* 快照区只读说明(设计稿 snap-note) */
.snap-note {
  font-size: 10.5px;
  color: #b45309;
  margin: 4px 0 0 16px;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 8px;
}

.row:hover {
  background: #faf9f6;
}

.row.clickable {
  cursor: pointer;
}

/* 选中行高亮(执行过程面板当前行;设计稿 mrow.active) */
.row.active {
  background: rgba(139, 92, 246, 0.08);
  outline: 1px solid rgba(139, 92, 246, 0.3);
}

/* "过程 ›"点击区(设计稿 rarrow) */
.rarrow {
  font-size: 11px;
  color: #9ca3af;
  flex-shrink: 0;
  white-space: nowrap;
}

.sdot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.sdot.running {
  background: #8b5cf6;
  animation: pulse 2s infinite;
}

.sdot.idle,
.sdot.done {
  background: #10b981;
}

.sdot.standby {
  background: #d1d5db;
}

.sdot.failed {
  background: #ef4444;
}

.rname {
  font-size: 12.5px;
  font-weight: 600;
  color: #1f2937;
  white-space: nowrap;
}

.rdoing {
  font-size: 12px;
  color: #6b7280;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.rcancel {
  font-size: 10.5px;
  color: #ef4444;
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 5px;
  padding: 1px 7px;
  background: #fff;
  cursor: pointer;
  flex-shrink: 0;
}

.rcancel.confirming {
  background: #ef4444;
  color: #fff;
}

.board-line {
  font-size: 11.5px;
  color: #7c3aed;
  font-weight: 600;
  margin: 6px 0 2px 16px;
  cursor: pointer;
}

/* 空看板:灰色"(空)"可点(设计稿空态② board-empty;气泡引导空态入口) */
.board-line.empty {
  color: #9ca3af;
  font-weight: 400;
}

.board-line b {
  color: #374151;
}

/* 待认领警示行(设计稿 arow.pending;最高价值信号常驻一行) */
.arow-pending {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 8px;
  font-size: 12px;
  background: rgba(217, 119, 6, 0.08);
  margin: 6px 8px 2px;
}

.arow-pending .t {
  font-weight: 600;
  color: #1f2937;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.arow-pending .meta {
  color: #9ca3af;
  font-size: 10.5px;
  margin-left: auto;
  white-space: nowrap;
  flex-shrink: 0;
}

.ledger {
  font-size: 11.5px;
  color: #6b7280;
  margin: 2px 0 0 16px;
}

.ledger .over {
  color: #dc2626;
  font-weight: 700;
}

.expand-enter-active,
.expand-leave-active {
  transition: max-height 0.2s ease-in-out, opacity 0.2s ease-in-out;
  overflow: hidden;
}

.expand-enter-from,
.expand-leave-to {
  max-height: 0;
  opacity: 0;
}

.expand-enter-to,
.expand-leave-from {
  max-height: 340px;
  opacity: 1;
}
</style>
