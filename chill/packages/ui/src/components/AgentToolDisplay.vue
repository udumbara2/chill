<template>
  <div class="agent-tool-display">
    <!-- AgentHeader -->
    <div class="agent-header" @click="toggleExpanded">

      <div class="agent-type-icon">
        <!-- 本地 Agent 图标 - 机器人头部 -->
        <svg v-if="agentType === 'local'" class="robot-icon" :class="{ 'running': status === 'running' }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <!-- 机器人头部外框 -->
          <rect x="4" y="4" width="16" height="16" rx="4" />
          <!-- 左眼 -->
          <circle cx="9" cy="10" r="1.8" fill="currentColor" class="eye" />
          <!-- 右眼 -->
          <circle cx="15" cy="10" r="1.8" fill="currentColor" class="eye" />
        </svg>
        <!-- 远程 Agent 图标 - 带信号的机器人 -->
        <svg v-else class="robot-remote-icon" :class="{ 'running': status === 'running' }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <!-- 机器人头部外框 - 使用路径绘制，右上角开放 -->
          <path d="M4 8 L4 16 Q4 20 8 20 L16 20 Q20 20 20 16 L20 12 M12 4 L8 4 Q4 4 4 8" />
          
          <!-- 左眼 -->
          <circle cx="9" cy="10" r="1.8" fill="currentColor" class="eye" />
          <!-- 右眼 -->
          <circle cx="15" cy="10" r="1.8" fill="currentColor" class="eye" />
          
          <!-- 信号元素（三条横杠，从右下向左上排列，长度递增） -->
          <g class="signal-bars">
            <!-- 最短的（最下面，最靠右） -->
            <line x1="17" y1="9" x2="21" y2="9" stroke-width="2" stroke-linecap="round" />
            <!-- 中间的（与头顶齐平） -->
            <line x1="16" y1="5" x2="22" y2="5" stroke-width="2" stroke-linecap="round" />
            <!-- 最长的（最上面，最靠左，超出头顶） -->
            <line x1="15" y1="1" x2="23" y2="1" stroke-width="2" stroke-linecap="round" />
          </g>
        </svg>
      </div>
      <div class="tool-name">{{ displayToolName }}</div>
      <div class="execution-status">{{ statusText }}</div>
    </div>

    <!-- 执行产物预览卡片（折叠区域外） -->
    <div v-if="artifacts && artifacts.length > 0 && !expanded" class="artifacts-preview">
      <div class="artifacts-preview-header">
        <span class="artifacts-preview-icon">📦</span>
        <span class="artifacts-preview-count">{{ artifacts.length }} 个执行产物</span>
      </div>
      <div class="artifacts-preview-list">
        <div v-for="(artifact, index) in artifacts.slice(0, 3)" :key="index" 
             class="artifacts-preview-item"
             @click="openArtifactModal(artifact, index)">
          <span class="artifacts-preview-icon-type">{{ getArtifactTypeIcon(artifact) }}</span>
          <span class="artifacts-preview-text">{{ getArtifactPreviewText(artifact) }}</span>
          <span class="artifacts-preview-arrow">→</span>
        </div>
        <div v-if="artifacts.length > 3" class="artifacts-preview-more">
          +{{ artifacts.length - 3 }} 更多...
        </div>
      </div>
    </div>

    <!-- 执行产物详情模态框 -->
    <Teleport to="body">
      <Transition name="modal">
        <div v-if="showArtifactModal" class="artifact-modal-overlay" @click="closeArtifactModal">
          <div class="artifact-modal" @click.stop>
            <div class="artifact-modal-header">
              <span class="artifact-modal-icon">{{ selectedArtifact ? getArtifactTypeIcon(selectedArtifact) : '📄' }}</span>
              <span class="artifact-modal-title">执行产物 #{{ selectedArtifactIndex + 1 }}</span>
              <button class="artifact-modal-close" @click="closeArtifactModal">×</button>
            </div>
            <div class="artifact-modal-body">
              <div v-if="selectedArtifact" class="artifact-modal-content">
                <div v-for="(part, pIndex) in selectedArtifact.parts" :key="pIndex" class="artifact-modal-part">
                  <div v-if="part.type === 'text'" class="artifact-modal-text">
                    <pre>{{ part.text }}</pre>
                  </div>
                  <div v-else-if="part.type === 'file'" class="artifact-modal-file">
                    <span class="file-icon">📎</span>
                    <span class="file-name">{{ part.file?.name || '文件' }}</span>
                    <a v-if="part.file?.uri" :href="part.file.uri" target="_blank" class="file-download">下载</a>
                  </div>
                </div>
              </div>
            </div>
            <div class="artifact-modal-footer">
              <button class="artifact-modal-btn copy" :class="{ 'success': copySuccess, 'error': copyError }" @click="copyArtifactContent">
                <span v-if="copySuccess">✓</span>
                <span v-else-if="copyError">✕</span>
                <span v-else>📋</span>
                {{ copySuccess ? '已复制' : copyError ? '复制失败' : '复制内容' }}
              </button>
              <button class="artifact-modal-btn close" @click="closeArtifactModal">
                关闭
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- 可展开内容 -->
    <transition name="expand">
      <div v-show="expanded" class="agent-content">
        <!-- InputSection -->
        <div v-if="parameters && Object.keys(parameters).length > 0" class="input-section">
          <div class="section-title">输入参数</div>
          <div class="parameters-list">
            <div v-for="(value, key) in parameters" :key="key" class="parameter-item">
              <div class="parameter-key">{{ key }}</div>
              <div class="parameter-value">{{ formatValue(value) }}</div>
            </div>
          </div>
        </div>

        <!-- ExecutionStatus -->
        <div class="execution-status-section">
          <div class="section-title">执行状态</div>
          <div class="status-badge" :class="status">{{ statusText }}</div>
        </div>

        <!-- ResultSection -->
        <div v-if="result" class="result-section">
          <div class="section-title">执行结果</div>
          <div class="result-content">{{ formatResult(result) }}</div>
        </div>

        <!-- ArtifactsSection -->
        <div v-if="artifacts && artifacts.length > 0" class="artifacts-section">
          <div class="section-title">执行产物 ({{ artifacts.length }})</div>
          <div class="artifacts-list">
            <div v-for="(artifact, index) in artifacts" :key="index" class="artifact-item">
              <div class="artifact-index">#{{ index + 1 }}</div>
              <div class="artifact-content">
                <div v-if="artifact.parts" class="artifact-parts">
                  <div v-for="(part, pIndex) in artifact.parts" :key="pIndex" class="artifact-part">
                    <div v-if="part.type === 'text'" class="text-part">{{ part.text }}</div>
                    <div v-else-if="part.type === 'file'" class="file-part">
                      <span class="file-icon">📎</span>
                      <span class="file-name">{{ part.file?.name || '文件' }}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- ActionBar -->
        <div class="action-bar">
          <button v-if="status === 'failed'" class="action-btn retry" @click="handleRetry">
            <span>🔄</span> 重试
          </button>
          <button class="action-btn toggle" @click="toggleExpanded">
            <span>{{ expanded ? '👆' : '👇' }}</span> {{ expanded ? '收起' : '展开' }}
          </button>
        </div>
      </div>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import type { ToolCallStatus } from '@assistant-ai/core'

interface Props {
  toolName: string
  displayName?: string
  agentType?: 'local' | 'remote'
  status: ToolCallStatus
  parameters?: Record<string, any>
  result?: any
  artifacts?: any[]
}

const props = withDefaults(defineProps<Props>(), {
  agentType: 'remote',
  parameters: () => ({}),
  result: '',
  artifacts: () => []
})

// 显示的名称：优先使用 displayName，否则使用 toolName
const displayToolName = computed(() => {
  return props.displayName || props.toolName
})

const emit = defineEmits<{
  retry: []
}>()

const expanded = ref(false)
const showArtifactModal = ref(false)
const selectedArtifact = ref<any>(null)
const selectedArtifactIndex = ref(0)

const statusText = computed(() => {
  switch (props.status) {
    case 'running':
      return '执行中'
    case 'success':
      return '已完成'
    case 'failed':
      return '执行失败'
    default:
      return '未知状态'
  }
})

const toggleExpanded = () => {
  expanded.value = !expanded.value
}

const handleRetry = () => {
  emit('retry')
}

const formatValue = (value: any): string => {
  if (typeof value === 'object') {
    return JSON.stringify(value, null, 2)
  }
  return String(value)
}

const formatResult = (result: any): string => {
  if (typeof result === 'object') {
    if (result.content) {
      return result.content
    }
    return JSON.stringify(result, null, 2)
  }
  return String(result)
}

const getArtifactPreviewText = (artifact: any): string => {
  if (artifact.parts && artifact.parts.length > 0) {
    const firstPart = artifact.parts[0]
    if (firstPart.type === 'text' && firstPart.text) {
      return firstPart.text.length > 30 ? firstPart.text.substring(0, 30) + '...' : firstPart.text
    } else if (firstPart.type === 'file') {
      return firstPart.file?.name || '文件'
    }
  }
  return '执行产物'
}

const openArtifactModal = (artifact: any, index: number) => {
  selectedArtifact.value = artifact
  selectedArtifactIndex.value = index
  showArtifactModal.value = true
}

const closeArtifactModal = () => {
  showArtifactModal.value = false
  selectedArtifact.value = null
}

const getArtifactTypeIcon = (artifact: any): string => {
  if (!artifact.parts || artifact.parts.length === 0) return '📄'
  const firstPart = artifact.parts[0]
  if (firstPart.type === 'file') {
    const fileName = firstPart.file?.name || ''
    if (fileName.match(/\.(jpg|jpeg|png|gif|webp|svg)$/i)) return '🖼️'
    if (fileName.match(/\.(pdf|doc|docx)$/i)) return '📄'
    if (fileName.match(/\.(js|ts|py|java|cpp|c|go|rs|html|css)$/i)) return '💻'
    if (fileName.match(/\.(json|xml|yaml|yml)$/i)) return '📋'
    return '📎'
  }
  return '📝'
}

const copySuccess = ref(false)
const copyError = ref(false)

const copyArtifactContent = async () => {
  if (!selectedArtifact.value) return
  const text = getArtifactFullText(selectedArtifact.value)
  try {
    await navigator.clipboard.writeText(text)
    copySuccess.value = true
    setTimeout(() => {
      copySuccess.value = false
    }, 2000)
  } catch (err) {
    console.error('复制失败:', err)
    copyError.value = true
    setTimeout(() => {
      copyError.value = false
    }, 2000)
  }
}

const getArtifactFullText = (artifact: any): string => {
  if (!artifact.parts) return ''
  return artifact.parts
    .filter((part: any) => part.type === 'text')
    .map((part: any) => part.text)
    .join('\n')
}
</script>

<style scoped>
.agent-tool-display {
  margin: 0.5rem 0;
  border-radius: 8px;
  overflow: hidden;
  background: rgba(99, 102, 241, 0.03);
  border: 1px solid rgba(99, 102, 241, 0.15);
  max-width: fit-content;
}

.agent-header {
  display: flex;
  align-items: center;
  padding: 0.6rem 0.9rem;
  cursor: pointer;
  user-select: none;
  gap: 0.6rem;
  transition: background-color 0.2s ease;
}

.agent-header:hover {
  background: rgba(99, 102, 241, 0.06);
}

.status-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

.loading-spinner {
  animation: spin 1s linear infinite;
  color: #6366f1;
}

.success-icon {
  color: #10b981;
}

.failed-icon {
  color: #ef4444;
}

.agent-type-icon {
  font-size: 14px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
}

/* 机器人图标样式 */
.robot-icon {
  width: 18px;
  height: 18px;
  color: #4b5563;
}

.robot-icon.running {
  color: #6366f1;
}

.robot-icon .eye {
  fill: #4b5563;
}

.robot-icon.running .eye {
  fill: #6366f1;
  animation: eye-blink-random 12s ease-in-out infinite;
}

@keyframes eye-blink-random {
  /* 第1次眨眼 - 短间隔后单次 */
  0%, 7% { opacity: 1; }
  8% { opacity: 0.2; }
  9%, 23% { opacity: 1; }
  
  /* 第2次眨眼 - 长间隔后单次 */
  24%, 35% { opacity: 1; }
  36% { opacity: 0.2; }
  37%, 48% { opacity: 1; }
  
  /* 第3次眨眼 - 双连眨 */
  49%, 52% { opacity: 1; }
  53% { opacity: 0.2; }
  54%, 56% { opacity: 1; }
  57% { opacity: 0.2; }
  58%, 71% { opacity: 1; }
  
  /* 第4次眨眼 - 超长间隔后单次 */
  72%, 82% { opacity: 1; }
  83% { opacity: 0.2; }
  84%, 100% { opacity: 1; }
}

/* 远程机器人图标样式 */
.robot-remote-icon {
  width: 18px;
  height: 18px;
  color: #4b5563;
}

.robot-remote-icon.running {
  color: #6366f1;
}

.robot-remote-icon .eye {
  fill: #4b5563;
}

.robot-remote-icon.running .eye {
  fill: #6366f1;
  animation: eye-blink-random 12s ease-in-out infinite;
}

.robot-remote-icon .signal-bars line {
  stroke: currentColor;
}

.robot-remote-icon.running .signal-bars line {
  opacity: 0;
  animation: signal-wave 1.2s ease-in-out infinite;
}

/* 最下面的杠（第1条） */
.robot-remote-icon.running .signal-bars line:nth-child(1) {
  animation-delay: 0s;
}

/* 中间的杠（第2条） */
.robot-remote-icon.running .signal-bars line:nth-child(2) {
  animation-delay: 0.15s;
}

/* 最上面的杠（第3条） */
.robot-remote-icon.running .signal-bars line:nth-child(3) {
  animation-delay: 0.3s;
}

@keyframes signal-wave {
  0% {
    opacity: 0;
  }
  20% {
    opacity: 1;
  }
  60% {
    opacity: 1;
  }
  80%, 100% {
    opacity: 0;
  }
}

.tool-name {
  font-weight: 500;
  color: #374151;
  font-size: 13px;
  flex: 1;
}

.execution-status {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  background: rgba(99, 102, 241, 0.1);
  color: #6366f1;
  flex-shrink: 0;
}

/* 执行产物预览卡片（折叠区域外） */
.artifacts-preview {
  margin: 0.5rem 0.9rem;
  padding: 0.6rem 0.75rem;
  background: rgba(99, 102, 241, 0.06);
  border-radius: 6px;
  border: 1px solid rgba(99, 102, 241, 0.15);
}

.artifacts-preview-header {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-bottom: 0.4rem;
}

.artifacts-preview-icon {
  font-size: 12px;
}

.artifacts-preview-count {
  font-size: 11px;
  font-weight: 600;
  color: #6366f1;
}

.artifacts-preview-list {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.artifacts-preview-item {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 12px;
  color: #4b5563;
}

.artifacts-preview-dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: #6366f1;
  flex-shrink: 0;
}

.artifacts-preview-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.artifacts-preview-more {
  font-size: 11px;
  color: #9ca3af;
  padding-left: 0.8rem;
  margin-top: 0.2rem;
}

.artifacts-preview-icon-type {
  font-size: 12px;
  flex-shrink: 0;
}

.artifacts-preview-arrow {
  font-size: 12px;
  color: #9ca3af;
  margin-left: auto;
  opacity: 0;
  transition: opacity 0.2s ease;
}

.artifacts-preview-item:hover .artifacts-preview-arrow {
  opacity: 1;
}

/* 执行产物详情模态框 */
.artifact-modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 1rem;
}

.artifact-modal {
  background: white;
  border-radius: 12px;
  width: 100%;
  max-width: 600px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
}

.artifact-modal-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid #e5e7eb;
}

.artifact-modal-icon {
  font-size: 18px;
}

.artifact-modal-title {
  flex: 1;
  font-size: 16px;
  font-weight: 600;
  color: #111827;
}

.artifact-modal-close {
  width: 32px;
  height: 32px;
  border: none;
  background: transparent;
  border-radius: 6px;
  font-size: 24px;
  color: #6b7280;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
}

.artifact-modal-close:hover {
  background: #f3f4f6;
  color: #374151;
}

.artifact-modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 1.25rem;
}

.artifact-modal-content {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.artifact-modal-text {
  background: #f9fafb;
  border-radius: 8px;
  padding: 1rem;
}

.artifact-modal-text pre {
  margin: 0;
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
  font-size: 13px;
  line-height: 1.6;
  color: #374151;
  white-space: pre-wrap;
  word-break: break-word;
}

.artifact-modal-file {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 1rem;
  background: #f9fafb;
  border-radius: 8px;
}

.artifact-modal-file .file-icon {
  font-size: 20px;
}

.artifact-modal-file .file-name {
  flex: 1;
  font-size: 14px;
  color: #374151;
}

.file-download {
  padding: 0.4rem 0.75rem;
  background: #6366f1;
  color: white;
  text-decoration: none;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
  transition: background 0.2s ease;
}

.file-download:hover {
  background: #4f46e5;
}

.artifact-modal-footer {
  display: flex;
  gap: 0.75rem;
  padding: 1rem 1.25rem;
  border-top: 1px solid #e5e7eb;
  justify-content: flex-end;
}

.artifact-modal-btn {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.5rem 1rem;
  border: none;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.artifact-modal-btn.copy {
  background: rgba(99, 102, 241, 0.1);
  color: #6366f1;
}

.artifact-modal-btn.copy:hover {
  background: rgba(99, 102, 241, 0.2);
}

.artifact-modal-btn.copy.success {
  background: rgba(16, 185, 129, 0.1);
  color: #10b981;
}

.artifact-modal-btn.copy.error {
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
}

.artifact-modal-btn.close {
  background: #f3f4f6;
  color: #374151;
}

.artifact-modal-btn.close:hover {
  background: #e5e7eb;
}

/* 模态框动画 */
.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.3s ease;
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.modal-enter-active .artifact-modal,
.modal-leave-active .artifact-modal {
  transition: transform 0.3s ease, opacity 0.3s ease;
}

.modal-enter-from .artifact-modal,
.modal-leave-to .artifact-modal {
  transform: scale(0.95);
  opacity: 0;
}

.agent-content {
  padding: 0.75rem 0.9rem;
  border-top: 1px solid rgba(99, 102, 241, 0.1);
}

.section-title {
  font-size: 11px;
  font-weight: 600;
  color: #6b7280;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 0.5rem;
}

.input-section {
  margin-bottom: 0.75rem;
}

.parameters-list {
  background: rgba(255, 255, 255, 0.5);
  border-radius: 6px;
  padding: 0.5rem;
}

.parameter-item {
  display: flex;
  gap: 0.5rem;
  padding: 0.25rem 0;
  font-size: 12px;
}

.parameter-key {
  color: #6b7280;
  font-weight: 500;
  flex-shrink: 0;
}

.parameter-value {
  color: #374151;
  word-break: break-all;
  font-family: monospace;
}

.execution-status-section {
  margin-bottom: 0.75rem;
}

.status-badge {
  display: inline-block;
  padding: 4px 12px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 500;
}

.status-badge.running {
  background: rgba(99, 102, 241, 0.1);
  color: #6366f1;
}

.status-badge.success {
  background: rgba(16, 185, 129, 0.1);
  color: #10b981;
}

.status-badge.failed {
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
}

.result-section {
  margin-bottom: 0.75rem;
}

.result-content {
  background: rgba(255, 255, 255, 0.5);
  border-radius: 6px;
  padding: 0.75rem;
  font-size: 13px;
  color: #374151;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.artifacts-section {
  margin-bottom: 0.75rem;
}

.artifacts-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.artifact-item {
  display: flex;
  gap: 0.5rem;
  background: rgba(255, 255, 255, 0.5);
  border-radius: 6px;
  padding: 0.5rem;
  border-left: 3px solid #6366f1;
}

.artifact-index {
  font-size: 11px;
  color: #6366f1;
  font-weight: 600;
  flex-shrink: 0;
}

.artifact-content {
  flex: 1;
}

.artifact-parts {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.text-part {
  font-size: 12px;
  color: #374151;
  line-height: 1.4;
}

.file-part {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 12px;
  color: #6366f1;
}

.action-bar {
  display: flex;
  gap: 0.5rem;
  padding-top: 0.5rem;
  border-top: 1px solid rgba(99, 102, 241, 0.1);
}

.action-btn {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.4rem 0.75rem;
  border: none;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.action-btn.retry {
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
}

.action-btn.retry:hover {
  background: rgba(239, 68, 68, 0.2);
}

.action-btn.toggle {
  background: rgba(99, 102, 241, 0.1);
  color: #6366f1;
}

.action-btn.toggle:hover {
  background: rgba(99, 102, 241, 0.2);
}

.expand-enter-active,
.expand-leave-active {
  transition: all 0.3s ease;
  max-height: 1000px;
  opacity: 1;
  overflow: hidden;
}

.expand-enter-from,
.expand-leave-to {
  max-height: 0;
  opacity: 0;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>