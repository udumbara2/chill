<template>
  <div v-if="approvals.length > 0" class="pending-operations-container">
    <!-- 审批请求列表（圈外写 + 命令确认，按到达顺序逐个回答） -->
    <div v-if="approvals.length > 0" class="approval-list">
      <div v-for="req in approvals" :key="req.toolCallId" class="approval-item">
        <div class="approval-header">
          <span class="approval-origin">{{ originText(req) }}</span>
          <span class="approval-kind" :class="req.kind">
            {{ req.kind === 'write' ? '写入边界外文件' : (req.sessionGrantable ? '桌面操作' : '执行命令') }}
          </span>
        </div>
        <div class="approval-target">{{ req.kind === 'write' ? req.path : req.command }}</div>
        <div v-if="req.detail" class="approval-detail">{{ req.detail }}</div>
        <template v-if="req.kind === 'write' && req.diffPreview">
          <button class="diff-toggle" @click="toggleDiff(req.toolCallId)">
            {{ expandedDiffs.includes(req.toolCallId) ? '收起 diff' : '查看 diff' }}
          </button>
          <pre v-if="expandedDiffs.includes(req.toolCallId)" class="diff-preview">{{ req.diffPreview }}</pre>
        </template>
        <div class="approval-actions">
          <template v-if="req.kind === 'write'">
            <button class="confirm-btn" @click="approve(req)">批准一次</button>
            <button class="add-dir-btn" @click="approveAndAddDir(req)">
              批准并把目录 {{ dirOf(req.path) }} 加入本次会话
            </button>
          </template>
          <button v-else class="confirm-btn" @click="approve(req)">确认执行</button>
          <!-- 桌面操作审批（payload.sessionGrantable）：[s] 本次会话内放行，对齐 CLI 语义 -->
          <button
            v-if="req.kind === 'command' && req.sessionGrantable"
            class="add-dir-btn"
            @click="approveForSession(req)"
          >
            本次会话放行桌面操作
          </button>
          <button class="reject-btn" @click="reject(req)">拒绝</button>
        </div>
      </div>
      <div v-if="!isFullAccess" class="auto-apply-entry">
        <button class="auto-apply-btn" @click="handleAutoApply">
          ⚡ 开启直写（后续写入与命令不再询问）
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { eventBus, EVENTS } from '@assistant-ai/core'
import type { ApprovalRequestPayload, ApprovalResolution } from '@assistant-ai/core'
import { usePermissionModeStore } from '../stores/permissionModeStore'

// 挂起中的审批请求（core 通用审批通道经 APPROVAL_REQUESTED 到达；按到达顺序排列，逐个回答）
const approvals = ref<ApprovalRequestPayload[]>([])
// 权限态走 permissionModeStore（唯一 UI 写入点）；横幅已删除，状态指示由常驻选择器高亮承担
const permissionModeStore = usePermissionModeStore()
const isFullAccess = computed(() => permissionModeStore.mode === 'fullAccess')
// 已展开 diff 预览的请求（按 toolCallId）
import { checkDangerousCommand } from '../utils/commandSafety'

const expandedDiffs = ref<string[]>([])

const handleApprovalRequested = (payload: ApprovalRequestPayload) => {
  // 危险命令硬拦截（自 PowerShellCommandDisplay.onMounted 迁移，行为逐字节一致）：
  // 命中 UI 黑名单即自动拒绝、不入审批队列——审批策略归位于审批面，不再依赖展示组件挂载时序
  if (payload.kind === 'command' && payload.command && checkDangerousCommand(payload.command)) {
    eventBus.emit(EVENTS.APPROVAL_RESOLVED, {
      toolCallId: payload.toolCallId,
      approved: false,
      reason: '检测到危险命令，已阻止执行'
    })
    return
  }
  approvals.value.push(payload)
}

// 审批在别处回答（如命令在消息流内联确认）时同步移除列表项
const handleApprovalResolved = (data: { toolCallId: string } & ApprovalResolution) => {
  approvals.value = approvals.value.filter(a => a.toolCallId !== data.toolCallId)
}

onMounted(() => {
  eventBus.on(EVENTS.APPROVAL_REQUESTED, handleApprovalRequested)
  eventBus.on(EVENTS.APPROVAL_RESOLVED, handleApprovalResolved)
})

onUnmounted(() => {
  eventBus.off(EVENTS.APPROVAL_REQUESTED, handleApprovalRequested)
  eventBus.off(EVENTS.APPROVAL_RESOLVED, handleApprovalResolved)
})

// 归属文本："后台任务 <type> 请求…" / "手机请求…（5 分钟超时自动拒绝）" / "主对话请求…"
const originText = (req: ApprovalRequestPayload): string => {
  if (req.origin?.source === 'subagent') {
    return `后台任务 ${req.origin.subagentType ?? ''} 请求`.replace(/\s+/g, ' ').trim()
  }
  if (req.origin?.source === 'mobile') {
    return '手机请求（5 分钟无人应答自动拒绝）'
  }
  return '主对话请求'
}

// 写目标所在目录（[d] 选项：批准并把该目录加入本次会话可写根）
const dirOf = (filePath?: string): string => {
  if (!filePath) return ''
  const normalized = filePath.replace(/\\/g, '/')
  const idx = normalized.lastIndexOf('/')
  return idx > 0 ? filePath.slice(0, idx) : filePath
}

const toggleDiff = (toolCallId: string) => {
  expandedDiffs.value = expandedDiffs.value.includes(toolCallId)
    ? expandedDiffs.value.filter(id => id !== toolCallId)
    : [...expandedDiffs.value, toolCallId]
}

// 回答经 APPROVAL_RESOLVED 事件进通用审批通道（core 通道监听该事件转 resolve()）；
// 列表项移除由上面的 APPROVAL_RESOLVED 监听统一处理
const resolveApproval = (req: ApprovalRequestPayload, resolution: ApprovalResolution) => {
  eventBus.emit(EVENTS.APPROVAL_RESOLVED, { toolCallId: req.toolCallId, ...resolution })
}

const approve = (req: ApprovalRequestPayload) => {
  resolveApproval(req, { approved: true })
}

// [s] 回答：批准并在本次会话内放行后续桌面主动作（resolution.allowSession 回传，core 置会话级内存放行）
const approveForSession = (req: ApprovalRequestPayload) => {
  resolveApproval(req, { approved: true, allowSession: true })
}

const approveAndAddDir = (req: ApprovalRequestPayload) => {
  resolveApproval(req, { approved: true, addDir: dirOf(req.path) })
}

const reject = (req: ApprovalRequestPayload) => {
  resolveApproval(req, { approved: false, reason: '用户拒绝' })
}

// 开启直写：后续写入与命令全量直接执行（不影响已在等待的审批，仍需逐个回答）
const handleAutoApply = () => {
  permissionModeStore.set('fullAccess')
}
</script>

<style scoped>
.pending-operations-container {
  margin-bottom: 0.5rem;
}

.pending-operations-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0.75rem;
  background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%);
  border: 1px solid #f59e0b;
  border-radius: 6px;
  animation: slideIn 0.3s ease;
}

@keyframes slideIn {
  from {
    opacity: 0;
    transform: translateY(-10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.approval-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.approval-item {
  padding: 0.5rem 0.75rem;
  background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%);
  border: 1px solid #f59e0b;
  border-radius: 6px;
  animation: slideIn 0.3s ease;
}

.approval-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.25rem;
}

.approval-origin {
  font-size: 0.8125rem;
  color: #92400e;
  font-weight: 500;
}

.approval-kind {
  font-size: 0.6875rem;
  font-weight: 600;
  padding: 0.125rem 0.5rem;
  border-radius: 4px;
}

.approval-kind.write {
  background: rgba(245, 158, 11, 0.2);
  color: #b45309;
}

.approval-kind.command {
  background: rgba(14, 116, 144, 0.15);
  color: #0e7490;
}

.approval-target {
  font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
  font-size: 0.8125rem;
  color: #78350f;
  word-break: break-all;
}

.approval-detail {
  font-size: 0.75rem;
  color: #92400e;
  margin-top: 0.25rem;
}

.diff-toggle {
  margin-top: 0.375rem;
  padding: 0.125rem 0.5rem;
  border: 1px solid #f59e0b;
  border-radius: 4px;
  font-size: 0.75rem;
  cursor: pointer;
  background: transparent;
  color: #b45309;
}

.diff-toggle:hover {
  background: rgba(245, 158, 11, 0.15);
}

.diff-preview {
  margin-top: 0.375rem;
  padding: 0.5rem;
  background: #fffbeb;
  border: 1px solid #fde68a;
  border-radius: 4px;
  font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
  font-size: 0.75rem;
  line-height: 1.5;
  color: #78350f;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 240px;
  overflow-y: auto;
}

.approval-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.5rem;
  flex-wrap: wrap;
}

.confirm-btn,
.reject-btn,
.add-dir-btn {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.375rem 0.75rem;
  border: none;
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.confirm-btn {
  background: #10b981;
  color: white;
}

.confirm-btn:hover {
  background: #059669;
}

.add-dir-btn {
  background: rgba(16, 185, 129, 0.12);
  color: #047857;
  border: 1px solid rgba(16, 185, 129, 0.4);
}

.add-dir-btn:hover {
  background: rgba(16, 185, 129, 0.2);
}

.reject-btn {
  background: rgba(239, 68, 68, 0.1);
  color: #dc2626;
}

.reject-btn:hover {
  background: rgba(239, 68, 68, 0.2);
}

.auto-apply-entry {
  display: flex;
  justify-content: flex-end;
}

.auto-apply-btn {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.375rem 0.75rem;
  border: none;
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 500;
  cursor: pointer;
  background: rgba(139, 92, 246, 0.15);
  color: #7c3aed;
  transition: all 0.2s ease;
}

.auto-apply-btn:hover {
  background: rgba(139, 92, 246, 0.25);
}
</style>
