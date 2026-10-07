<template>
  <div v-if="task" class="agent-process-panel" :class="{ overlay }">
    <!-- 头部:成员名/状态+耗时徽章/关闭;任务描述;类型与工具计数芯片 -->
    <div class="panel-head">
      <div class="ph-row1">
        <span class="ph-name">{{ displayName }}</span>
        <span class="ph-status" :class="headStatus.class">
          <span v-if="task.status === 'running'" class="dot"></span>{{ headStatus.text }}
        </span>
        <button class="ph-close" title="关闭" @click="emit('close')">✕</button>
      </div>
      <div class="ph-task">任务:{{ task.description }}</div>
      <div class="ph-meta">
        <span class="chip">@{{ task.subagentType }}</span>
        <span class="chip">工具调用 {{ log.length }} 次</span>
      </div>
    </div>

    <!-- 时间线:running 脉冲/success 绿✓耗时/failed 红✗原因;行折叠 ~200 字符,点击展开至 4KB -->
    <div ref="timelineRef" class="timeline">
      <div class="tl-title">执行过程(实时)</div>
      <div v-if="log.length === 0" class="tl-empty">暂无工具调用记录(任务启动前的准备阶段不经过工具网关)</div>
      <div v-for="e in log" :key="e.toolCallId" class="tl-item">
        <div class="tl-icon" :class="iconClass(e)">{{ e.status === 'success' ? '✓' : e.status === 'failed' ? '✗' : '' }}</div>
        <div class="tl-body">
          <div class="tl-tool">{{ e.toolName }}</div>
          <div
            v-if="e.argsSummary"
            class="tl-args"
            :class="{ expandable: isLong(e.argsSummary), expanded: expandedIds.has(e.toolCallId) }"
            :title="isLong(e.argsSummary) ? '点击展开/收起全文' : ''"
            @click="toggleExpand(e.toolCallId)"
          >{{ fold(e.argsSummary, expandedIds.has(e.toolCallId)) }}</div>
          <div v-if="e.status === 'running'" class="tl-meta">进行中…</div>
          <div v-else-if="e.status === 'success'" class="tl-meta">成功{{ e.durationMs !== undefined ? ` · ${formatDuration(e.durationMs)}` : '' }}</div>
          <div v-else class="tl-meta err">失败{{ e.resultSummary ? ` · ${fold(e.resultSummary, expandedIds.has(e.toolCallId))}` : '' }}</div>
          <!-- 成功结果摘要(网关级拒绝留痕在失败行;成功结果折叠展示) -->
          <div
            v-if="e.status === 'success' && e.resultSummary"
            class="tl-detail"
            :class="{ expandable: isLong(e.resultSummary) }"
            :title="isLong(e.resultSummary) ? '点击展开/收起全文' : ''"
            @click="isLong(e.resultSummary) && toggleExpand(e.toolCallId)"
          >
            <div class="d-label">结果摘要</div>
            {{ fold(e.resultSummary, expandedIds.has(e.toolCallId)) }}
          </div>
        </div>
      </div>
    </div>

    <!-- 底部:settle 后最终输出全文 + 资源用量芯片(估值带 ~);运行中为占位 -->
    <div class="final">
      <div class="final-title">最终输出{{ task.status === 'running' ? '(任务完成后呈现)' : '' }}</div>
      <template v-if="task.status !== 'running'">
        <div v-if="task.output" class="final-text"><MessageMarkdown :content="task.output" /></div>
        <div v-if="task.result?.error_info" class="final-error">错误: {{ task.result.error_info.message }}</div>
        <div v-if="task.result?.resource_usage" class="final-res">
          <span v-if="task.result.resource_usage.tokens_used" class="chip">
            token {{ task.result.resource_usage.tokens_estimated ? '~' : '' }}{{ task.result.resource_usage.tokens_used }}{{ task.result.resource_usage.tokens_estimated ? '(估值)' : '' }}
          </span>
          <span v-if="task.result.resource_usage.execution_time" class="chip">{{ formatDuration(task.result.resource_usage.execution_time) }}</span>
          <span v-if="task.result.resource_usage.iterations" class="chip">{{ task.result.resource_usage.iterations }} 轮</span>
        </div>
        <div v-if="!task.output && !task.result?.error_info" class="final-text">(无输出)</div>
      </template>
      <div v-else class="final-text">任务进行中——成员交付后将在此显示全文;点右上角 ✕ 收起面板,不打扰主对话。</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onUnmounted, nextTick } from 'vue'
import type { RuntimeProcessTask } from '@assistant-ai/core'
import { useRuntimePillStore, type ToolCallLogEntry } from '../stores/runtimePillStore'
import MessageMarkdown from './MessageMarkdown.vue'

/**
 * Agent 执行过程右侧面板(迭代 2;设计稿 agent-process-panel.html):
 * 点药丸成员/任务行的"过程 ›"滑出——Worker 工具调用实时时间线(网关 SUBAGENT_TOOL_CALL 事件归档),
 * 含网关级拒绝留痕;settle 后底部最终输出 + 资源用量芯片。
 * 窄窗转 overlay 覆盖模式(ContentDock dockOverlay 先例,防挤压聊天区);纯观测,无操作。
 */
defineProps<{
  /** 窄窗覆盖模式(Home 按可用宽计算,滞回阈值同 dockOverlay 先例) */
  overlay?: boolean
}>()
const emit = defineEmits<{
  close: []
}>()

const runtimePillStore = useRuntimePillStore()

const task = computed<RuntimeProcessTask | undefined>(() =>
  runtimePillStore.processTasks.find((t) => t.taskId === runtimePillStore.selectedTaskId),
)
const log = computed<ToolCallLogEntry[]>(() =>
  runtimePillStore.selectedTaskId ? (runtimePillStore.toolCallLog[runtimePillStore.selectedTaskId] ?? []) : [],
)

/** 显示名:团队成员名(roster.currentTaskId 对账)优先,独立任务回退 subagentType */
const displayName = computed(() => {
  const t = task.value
  if (!t) return ''
  return runtimePillStore.teamState?.roster.find((e) => e.currentTaskId === t.taskId)?.name ?? t.subagentType
})

// 头部状态徽章(进行中 · Ns:startedAt 计时基线,1s 节拍)
const nowTick = ref(Date.now())
let tickTimer: ReturnType<typeof setInterval> | null = null
watch(
  () => task.value?.status,
  (status) => {
    if (status === 'running' && !tickTimer) {
      tickTimer = setInterval(() => { nowTick.value = Date.now() }, 1000)
    } else if (status !== 'running' && tickTimer) {
      clearInterval(tickTimer)
      tickTimer = null
    }
  },
  { immediate: true },
)
onUnmounted(() => {
  if (tickTimer) clearInterval(tickTimer)
})

const headStatus = computed(() => {
  const t = task.value
  if (!t) return { text: '', class: '' }
  if (t.status === 'running') {
    const startedAt = runtimePillStore.taskStartedAt[t.taskId]
    const elapsed = startedAt ? Math.max(0, Math.floor((nowTick.value - startedAt) / 1000)) : 0
    return { text: `进行中 · ${elapsed}s`, class: 'running' }
  }
  switch (t.status) {
    case 'completed': return { text: '已完成', class: 'done' }
    case 'failed': return { text: '失败', class: 'err' }
    case 'cancelled': return { text: '已取消', class: '' }
    default: return { text: '', class: '' }
  }
})

// 行折叠/展开:折叠显 ~200 字符,展开可见至 4KB(发射点截断上限)
const FOLD_CHARS = 200
const expandedIds = ref<Set<string>>(new Set())
const isLong = (s: string): boolean => s.length > FOLD_CHARS
const fold = (s: string, expanded: boolean): string =>
  expanded || !isLong(s) ? s : `${s.slice(0, FOLD_CHARS)}…`
const toggleExpand = (toolCallId: string): void => {
  if (expandedIds.value.has(toolCallId)) expandedIds.value.delete(toolCallId)
  else expandedIds.value.add(toolCallId)
}

const iconClass = (e: ToolCallLogEntry): string =>
  e.status === 'success' ? 'ok' : e.status === 'failed' ? 'err' : 'run'

const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

// 实时滚动:新条目到达且任务在跑时滚到底
const timelineRef = ref<HTMLElement | null>(null)
watch(
  () => log.value.length,
  async () => {
    if (task.value?.status !== 'running') return
    await nextTick()
    if (timelineRef.value) timelineRef.value.scrollTop = timelineRef.value.scrollHeight
  },
)
</script>

<style scoped>
/* 右侧面板(设计稿 agent-process-panel.html;抽屉形态参照 WorkflowView execution-history-drawer) */
.agent-process-panel {
  width: 400px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: #fdfcfa;
  border-left: 1px solid var(--border-color);
  min-height: 0;
}

/* 窄窗覆盖模式(ContentDock overlay 先例;z-index 低于设置覆盖层 2000) */
.agent-process-panel.overlay {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 1500;
  box-shadow: -8px 0 24px rgba(0, 0, 0, 0.12);
}

.panel-head {
  padding: 14px 16px 12px;
  border-bottom: 1px solid #efece6;
  background: #fff;
  flex-shrink: 0;
}

.ph-row1 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.ph-name {
  font-size: 15px;
  font-weight: 700;
  color: #1f2937;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ph-status {
  font-size: 10.5px;
  font-weight: 600;
  padding: 2px 9px;
  border-radius: 999px;
  background: var(--background-secondary);
  color: var(--text-secondary);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
}

.ph-status.running {
  background: rgba(var(--primary-color-rgb), 0.1);
  color: var(--primary-color);
}

.ph-status.done {
  background: rgba(var(--success-color-rgb, 16, 185, 129), 0.1);
  color: var(--success-color, #10b981);
}

.ph-status.err {
  background: rgba(var(--error-color-rgb), 0.1);
  color: var(--error-color);
}

.ph-status .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--primary-color);
  animation: ap-pulse 2s infinite;
}

.ph-close {
  margin-left: auto;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  border: none;
  background: var(--background-secondary);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 14px;
  flex-shrink: 0;
}

.ph-close:hover {
  color: var(--text-primary);
}

.ph-task {
  font-size: 12px;
  color: #4b5563;
  line-height: 1.5;
  margin-bottom: 8px;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.ph-meta {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.chip {
  font-size: 10.5px;
  padding: 2px 8px;
  border-radius: 999px;
  background: #f5f4f0;
  border: 1px solid #e8e5df;
  color: #6b7280;
}

.timeline {
  flex: 1;
  overflow-y: auto;
  padding: 12px 16px;
  min-height: 0;
}

.tl-title {
  font-size: 11px;
  font-weight: 700;
  color: #9ca3af;
  letter-spacing: 0.05em;
  margin-bottom: 10px;
}

.tl-empty {
  font-size: 12px;
  color: #b0aca2;
  line-height: 1.6;
}

.tl-item {
  display: flex;
  gap: 10px;
  position: relative;
  padding-bottom: 14px;
}

.tl-item::before {
  content: '';
  position: absolute;
  left: 7px;
  top: 18px;
  bottom: 0;
  width: 2px;
  background: #efece6;
}

.tl-item:last-child::before {
  display: none;
}

.tl-icon {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  flex-shrink: 0;
  margin-top: 2px;
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  color: #fff;
}

.tl-icon.ok {
  background: #10b981;
}

.tl-icon.err {
  background: #ef4444;
}

.tl-icon.run {
  background: var(--primary-color);
  animation: ap-pulse 1.6s infinite;
}

.tl-body {
  flex: 1;
  min-width: 0;
}

.tl-tool {
  font-size: 12.5px;
  font-weight: 600;
  color: #1f2937;
  font-family: Consolas, monospace;
}

.tl-args {
  font-size: 11.5px;
  color: #6b7280;
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tl-args.expandable {
  cursor: pointer;
}

.tl-args.expanded {
  white-space: pre-wrap;
  word-break: break-all;
}

.tl-meta {
  font-size: 10.5px;
  color: #9ca3af;
  margin-top: 2px;
}

.tl-meta.err {
  color: #dc2626;
  word-break: break-all;
}

.tl-detail {
  margin-top: 6px;
  background: #f7f5f1;
  border: 1px solid #eceae4;
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 11px;
  color: #4b5563;
  line-height: 1.6;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tl-detail.expandable {
  cursor: pointer;
  white-space: pre-wrap;
  word-break: break-all;
}

.tl-detail .d-label {
  font-weight: 700;
  color: #9ca3af;
  font-size: 10px;
  letter-spacing: 0.05em;
}

.final {
  border-top: 1px solid #efece6;
  padding: 12px 16px;
  background: #fff;
  flex-shrink: 0;
  max-height: 220px;
  overflow-y: auto;
}

.final-title {
  font-size: 11px;
  font-weight: 700;
  color: #9ca3af;
  letter-spacing: 0.05em;
  margin-bottom: 6px;
}

/* 成员交付全文经 MessageMarkdown 渲染：不再 pre-wrap（换行由 markdown 渲染承担，避免双倍空行） */
.final-text {
  font-size: 12px;
  color: #4b5563;
  line-height: 1.6;
  word-break: break-word;
}

.final-error {
  font-size: 11px;
  color: #dc2626;
  margin-bottom: 6px;
}

.final-res {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 6px;
}

@keyframes ap-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
</style>
