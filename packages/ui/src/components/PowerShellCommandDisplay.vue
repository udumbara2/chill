<template>
  <div class="powershell-command-display">
    <!-- 命令头部 -->
    <div class="command-header" @click="toggleExpanded">
      <div class="header-left">
        <div class="status-icon">
          <!-- 等待确认状态 -->
          <svg v-if="status === 'pending'" class="pending-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <path d="M12 8v4l3 3"/>
          </svg>
          <!-- 运行中状态 -->
          <svg v-else-if="status === 'running'" class="loading-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10" stroke-opacity="0.3"/>
            <path d="M12 2 A10 10 0 0 1 12 22" stroke-linecap="round">
              <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/>
            </path>
          </svg>
          <!-- 成功状态 -->
          <svg v-else-if="status === 'success'" class="success-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <!-- 失败/拒绝状态 -->
          <svg v-else-if="status === 'failed' || status === 'rejected'" class="failed-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18" stroke-linecap="round" stroke-linejoin="round"/>
            <line x1="6" y1="6" x2="18" y2="18" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <div class="command-title">
          <span class="tool-name">PowerShell</span>
          <span v-if="isBlocked" class="blocked-badge">已阻止</span>
        </div>
      </div>
      <div class="header-right">
        <span class="status-text">{{ statusText }}</span>
        <svg class="expand-icon" :class="{ 'expanded': expanded }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </div>
    </div>

    <!-- 命令详情 -->
    <transition name="expand">
      <div v-show="expanded" class="command-details">
        <!-- 危险命令警告 -->
        <div v-if="isBlocked" class="warning-banner danger">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/>
            <line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          <span>检测到危险命令，已阻止执行</span>
        </div>

        <!-- 命令代码 -->
        <div class="detail-section">
          <div class="section-label">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="4 17 10 11 4 5"/>
              <line x1="12" y1="19" x2="20" y2="19"/>
            </svg>
            命令代码
          </div>
          <div class="code-block">
            <pre><code>{{ command }}</code></pre>
          </div>
        </div>

        <!-- 功能说明 -->
        <div class="detail-section">
          <div class="section-label">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="16" x2="12" y2="12"/>
              <line x1="12" y1="8" x2="12.01" y2="8"/>
            </svg>
            功能说明
          </div>
          <div class="section-content">{{ purpose }}</div>
        </div>

        <!-- 执行意图 -->
        <div class="detail-section">
          <div class="section-label">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 2L2 7l10 5 10-5-10-5z"/>
              <path d="M2 17l10 5 10-5"/>
              <path d="M2 12l10 5 10-5"/>
            </svg>
            执行意图
          </div>
          <div class="section-content intent">{{ intent }}</div>
        </div>

        <!-- 工作目录 -->
        <div v-if="workingDirectory" class="detail-section">
          <div class="section-label">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
            工作目录
          </div>
          <div class="section-content directory">{{ workingDirectory }}</div>
        </div>

        <!-- 用户确认按钮 -->
        <div v-if="status === 'pending' && !isBlocked" class="action-buttons">
          <button 
            class="btn btn-reject" 
            :class="{ 'clicked': isRejectClicked }"
            :disabled="isRejectClicked || isConfirmClicked"
            @click="handleReject"
          >
            <svg v-if="!isRejectClicked" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
            <svg v-else class="spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10" stroke-dasharray="60" stroke-dashoffset="20"/>
            </svg>
            {{ isRejectClicked ? '已拒绝' : '拒绝执行' }}
          </button>
          <button 
            class="btn btn-confirm" 
            :class="{ 'clicked': isConfirmClicked }"
            :disabled="isRejectClicked || isConfirmClicked"
            @click="handleConfirm"
          >
            <svg v-if="!isConfirmClicked" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
            <svg v-else class="spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10" stroke-dasharray="60" stroke-dashoffset="20"/>
            </svg>
            {{ isConfirmClicked ? '执行中...' : '确认执行' }}
          </button>
        </div>

        <!-- 执行结果 -->
        <div v-if="result !== undefined && result !== null" class="detail-section result-section">
          <div class="section-label">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
              <line x1="16" y1="13" x2="8" y2="13"/>
              <line x1="16" y1="17" x2="8" y2="17"/>
              <polyline points="10 9 9 9 8 9"/>
            </svg>
            执行结果
          </div>
          <div class="result-block" :class="{ 'error': isError }">
            <pre>{{ formatResult(result) }}</pre>
          </div>
        </div>
      </div>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { eventBus, EVENTS } from '@assistant-ai/core'
import { useWritingViewStore } from '../stores/writingViewStore'

const writingViewStore = useWritingViewStore()

interface Props {
  toolName: string
  status: 'pending' | 'running' | 'success' | 'failed' | 'rejected'
  parameters?: Record<string, any>
  result?: any
  toolCallId?: string
}

const props = withDefaults(defineProps<Props>(), {
  parameters: () => ({}),
  result: undefined,
  toolCallId: ''
})

const expanded = ref(true)

// 按钮点击状态（用于显示反馈）
const isConfirmClicked = ref(false)
const isRejectClicked = ref(false)

// 本地执行状态（用于右上角状态显示）
const localExecutionStatus = ref<'pending' | 'running' | 'success' | 'failed' | 'rejected' | null>(null)

// 组件挂载时，如果检测到危险命令，立即经通用审批通道回答拒绝
import { onMounted, onUnmounted } from 'vue'

// 审批在别处回答（审批条 PendingOperationsBar）时同步内联按钮/状态
const handleApprovalResolved = (data: { toolCallId: string; approved: boolean }) => {
  if (!props.toolCallId || data.toolCallId !== props.toolCallId) return
  if (data.approved) {
    isConfirmClicked.value = true
    localExecutionStatus.value = 'running'
  } else {
    isRejectClicked.value = true
    localExecutionStatus.value = 'rejected'
  }
}

onUnmounted(() => {
  eventBus.off(EVENTS.APPROVAL_RESOLVED, handleApprovalResolved)
})

onMounted(() => {
  eventBus.on(EVENTS.APPROVAL_RESOLVED, handleApprovalResolved)
  if (isBlocked.value && props.status === 'pending') {
    console.log('【PowerShellCommandDisplay】检测到危险命令，自动拒绝:', command.value)
    eventBus.emit(EVENTS.APPROVAL_RESOLVED, {
      toolCallId: props.toolCallId,
      approved: false,
      reason: '检测到危险命令，已阻止执行'
    })
  }
})

// 从参数中提取信息
const command = computed(() => props.parameters?.command || '')
const purpose = computed(() => props.parameters?.purpose || '')
const intent = computed(() => props.parameters?.intent || '')
const workingDirectory = computed(() => props.parameters?.working_directory || '')

// 检查是否被阻止（危险命令）
const isBlocked = computed(() => {
  return checkDangerousCommand(command.value)
})

// 状态文本（优先使用本地状态实现即时反馈，但 props 的完成状态优先）
const statusText = computed(() => {
  // 如果 props 状态已经是完成状态（success/failed/rejected），优先使用 props 状态
  if (props.status === 'success' || props.status === 'failed' || props.status === 'rejected') {
    switch (props.status) {
      case 'success':
        return '执行成功'
      case 'failed':
        return '执行失败'
      case 'rejected':
        return '已拒绝'
    }
  }
  
  // 否则使用本地状态（用于点击后的即时反馈）
  const status = localExecutionStatus.value || props.status
  
  switch (status) {
    case 'pending':
      return isBlocked.value ? '已阻止' : '等待确认'
    case 'running':
      return '执行中'
    case 'success':
      return '执行成功'
    case 'failed':
      return '执行失败'
    case 'rejected':
      return '已拒绝'
    default:
      return '未知状态'
  }
})

// 是否错误结果
const isError = computed(() => {
  return props.status === 'failed' || props.status === 'rejected'
})

// 切换展开/折叠
const toggleExpanded = () => {
  expanded.value = !expanded.value
}

// 确认执行（经 APPROVAL_RESOLVED 进通用审批通道；携带命令与工作目录，语义同旧确认流）
const handleConfirm = () => {
  isConfirmClicked.value = true
  localExecutionStatus.value = 'running'
  
  const finalWorkingDirectory = workingDirectory.value || writingViewStore.currentDirectory || undefined
  
  eventBus.emit(EVENTS.APPROVAL_RESOLVED, {
    toolCallId: props.toolCallId,
    approved: true,
    command: command.value,
    workingDirectory: finalWorkingDirectory
  })
}

// 拒绝执行
const handleReject = () => {
  isRejectClicked.value = true
  localExecutionStatus.value = 'rejected' // 立即更新本地状态为已拒绝
  eventBus.emit(EVENTS.APPROVAL_RESOLVED, {
    toolCallId: props.toolCallId,
    approved: false,
    reason: '用户拒绝执行'
  })
}

// 格式化结果
const formatResult = (result: any): string => {
  if (typeof result === 'object' && result !== null) {
    // 如果结果包含 content 字段，直接显示 content 的内容
    if ('content' in result && result.content !== undefined) {
      return String(result.content)
    }
    return JSON.stringify(result, null, 2)
  }
  return String(result)
}

// 检查危险命令
function checkDangerousCommand(cmd: string): boolean {
  if (!cmd) return false
  
  const lowerCmd = cmd.toLowerCase()
  
  // 危险命令黑名单
  const dangerousPatterns = [
    // 系统破坏类
    'format-volume',
    'clear-disk',
    'remove-item -recurse -force c:\\',
    'remove-item -recurse -force "c:\\',
    'rm -rf /',
    'dismount-diskimage',
    'initialize-disk',
    
    // 权限提升类
    '-executionpolicy bypass',
    '-verb runas',
    'bypass -windowstyle hidden',
    
    // 网络攻击类
    'invoke-expression',
    'iex ',
    'downloadstring(',
    'downloadfile(',
    'net.webclient',
    'start-bitstransfer',
    
    // 敏感信息类
    'get-credential',
    'convertto-securestring',
    'export-clixml',
    
    // 进程终止类（系统关键进程）
    'stop-process -name svchost',
    'stop-process -name csrss',
    'stop-process -name smss',
    'stop-process -name lsass',
    
    // 注册表危险操作
    'remove-item -path hklm:\\',
    'remove-item -path hkcu:\\'
  ]
  
  return dangerousPatterns.some(pattern => lowerCmd.includes(pattern))
}
</script>

<style scoped>
.powershell-command-display {
  margin: 0.5rem 0;
  border-radius: 8px;
  overflow: hidden;
  background: rgba(0, 150, 136, 0.05);
  border: 1px solid rgba(0, 150, 136, 0.2);
  max-width: fit-content;
  min-width: 400px;
}

.command-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  cursor: pointer;
  user-select: none;
  transition: background-color 0.2s ease;
}

.command-header:hover {
  background: rgba(0, 150, 136, 0.08);
}

.header-left {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.status-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex-shrink: 0;
}

.status-icon svg {
  width: 100%;
  height: 100%;
}

.pending-icon {
  color: #f59e0b;
}

.loading-spinner {
  color: #009688;
}

.success-icon {
  color: #10b981;
}

.failed-icon {
  color: #ef4444;
}

.command-title {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.tool-name {
  font-size: 0.875rem;
  font-weight: 600;
  color: #009688;
}

.blocked-badge {
  font-size: 0.6875rem;
  font-weight: 500;
  padding: 0.125rem 0.5rem;
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
  border-radius: 4px;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.status-text {
  font-size: 0.8125rem;
  color: #6b7280;
}

.expand-icon {
  width: 16px;
  height: 16px;
  color: #9ca3af;
  transition: transform 0.2s ease;
}

.expand-icon.expanded {
  transform: rotate(180deg);
}

.command-details {
  padding: 0 1rem 1rem;
  border-top: 1px solid rgba(0, 150, 136, 0.1);
}

.warning-banner {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem;
  margin: 1rem 0;
  border-radius: 6px;
  font-size: 0.8125rem;
  font-weight: 500;
}

.warning-banner.danger {
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
  border: 1px solid rgba(239, 68, 68, 0.2);
}

.warning-banner svg {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
}

.detail-section {
  margin-top: 1rem;
}

.section-label {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.75rem;
  font-weight: 600;
  color: #6b7280;
  text-transform: uppercase;
  letter-spacing: 0.025em;
  margin-bottom: 0.375rem;
}

.section-label svg {
  width: 14px;
  height: 14px;
}

.code-block {
  background: #1e293b;
  border-radius: 6px;
  padding: 0.75rem;
  overflow-x: auto;
  max-height: 300px;
  overflow-y: auto;
}

.code-block pre {
  margin: 0;
  font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
  font-size: 0.8125rem;
  line-height: 1.5;
  color: #e2e8f0;
  white-space: pre-wrap;
  word-break: break-all;
}

.section-content {
  font-size: 0.875rem;
  color: #374151;
  line-height: 1.5;
  padding: 0.5rem;
  background: rgba(255, 255, 255, 0.5);
  border-radius: 4px;
}

.section-content.intent {
  color: #059669;
  font-style: italic;
  background: rgba(16, 185, 129, 0.05);
  border-left: 3px solid #10b981;
}

.section-content.directory {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.8125rem;
  color: #6b7280;
  background: rgba(0, 0, 0, 0.02);
}

.action-buttons {
  display: flex;
  gap: 0.75rem;
  margin-top: 1rem;
  padding-top: 1rem;
  border-top: 1px solid rgba(0, 150, 136, 0.1);
}

.btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.375rem;
  padding: 0.5rem 1rem;
  border: none;
  border-radius: 6px;
  font-size: 0.8125rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  flex: 1;
}

.btn svg {
  width: 14px;
  height: 14px;
}

.btn-confirm {
  background: #009688;
  color: white;
}

.btn-confirm:hover {
  background: #00897b;
}

.btn-reject {
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
}

.btn-reject:hover {
  background: rgba(239, 68, 68, 0.2);
}

/* 按钮点击后的状态 */
.btn.clicked {
  opacity: 0.7;
  cursor: not-allowed;
}

.btn:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.btn-confirm.clicked {
  background: #00897b;
}

.btn-reject.clicked {
  background: rgba(239, 68, 68, 0.2);
}

/* 加载动画 */
.spinner {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.result-section {
  margin-top: 1rem;
}

.result-block {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  padding: 0.75rem;
  max-height: 300px;
  overflow-y: auto;
}

.result-block.error {
  background: rgba(239, 68, 68, 0.05);
  border-color: rgba(239, 68, 68, 0.2);
}

.result-block pre {
  margin: 0;
  font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
  font-size: 0.8125rem;
  line-height: 1.5;
  color: #374151;
  white-space: pre-wrap;
  word-break: break-word;
}

.result-block.error pre {
  color: #ef4444;
}

/* 展开/折叠动画 */
.expand-enter-active,
.expand-leave-active {
  transition: all 0.2s ease;
  max-height: 1000px;
  opacity: 1;
  overflow: hidden;
}

.expand-enter-from,
.expand-leave-to {
  max-height: 0;
  opacity: 0;
}
</style>
