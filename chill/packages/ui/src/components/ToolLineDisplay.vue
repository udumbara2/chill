<template>
  <div class="tool-line-display">
    <div class="tool-line" :class="{ expandable }" @click="toggleExpanded">
      <span class="status-icon">
        <svg v-if="status === 'running'" class="loading-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10" stroke-opacity="0.3" />
          <path d="M12 2 A10 10 0 0 1 12 22" stroke-linecap="round">
            <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite" />
          </path>
        </svg>
        <svg v-else-if="status === 'success'" class="success-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="20 6 9 17 4 12" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <svg v-else-if="status === 'failed'" class="failed-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18" stroke-linecap="round" stroke-linejoin="round" />
          <line x1="6" y1="6" x2="18" y2="18" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <svg v-else-if="status === 'pending'" class="pending-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <svg v-else-if="status === 'rejected'" class="rejected-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10" />
          <line x1="15" y1="9" x2="9" y2="15" stroke-linecap="round" />
          <line x1="9" y1="9" x2="15" y2="15" stroke-linecap="round" />
        </svg>
      </span>
      <span class="verb">{{ verbText }}</span>
      <span
        v-if="objectText"
        class="object"
        :class="{ link: !!objectFullPath }"
        :title="objectTitleText"
        @click.stop="openFile"
      >{{ objectText }}</span>
      <span v-if="mcpServerName" class="mcp-server">/{{ mcpServerName }}</span>
      <svg v-if="expandable" class="expand-icon" :class="{ expanded }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </div>

    <transition name="expand">
      <div v-show="expanded" class="details">
        <!-- 命令详情（execute_powershell / execute_code） -->
        <template v-if="descriptor.detail === 'command'">
          <div v-if="isBlocked" class="warning-banner">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <span>检测到危险命令，已阻止执行</span>
          </div>
          <div class="detail-section">
            <div class="section-label">命令代码</div>
            <div class="code-block"><pre><code>{{ commandText }}</code></pre></div>
          </div>
          <div v-if="purpose" class="detail-section">
            <div class="section-label">功能说明</div>
            <div class="section-content">{{ purpose }}</div>
          </div>
          <div v-if="intent" class="detail-section">
            <div class="section-label">执行意图</div>
            <div class="section-content">{{ intent }}</div>
          </div>
          <div v-if="workingDirectory" class="detail-section">
            <div class="section-label">工作目录</div>
            <div class="section-content mono">{{ workingDirectory }}</div>
          </div>
          <div v-if="hasResult" class="detail-section">
            <div class="section-label">执行结果</div>
            <div class="section-content result">{{ formatResult(result) }}</div>
          </div>
        </template>

        <!-- 多文件清单（delete_file 且 paths.length > 1） -->
        <template v-else-if="descriptor.detail === 'fileList'">
          <div class="file-list">
            <div v-for="(path, index) in filePaths" :key="index" class="file-item">
              <svg class="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              <span class="file-name">{{ baseName(path) }}</span>
              <span class="file-path">{{ path }}</span>
            </div>
          </div>
        </template>

        <!-- 参数键值 + 执行结果（默认） -->
        <template v-else>
          <div v-if="parameters && Object.keys(parameters).length > 0" class="parameters-section">
            <div v-for="(value, key) in parameters" :key="key" class="parameter-item">
              <div class="parameter-key">{{ key }}</div>
              <div class="parameter-value">{{ formatValue(value) }}</div>
            </div>
          </div>
          <div v-if="hasResult" class="detail-section">
            <div class="section-label">执行结果</div>
            <div class="section-content result">{{ formatResult(result) }}</div>
          </div>
        </template>
      </div>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { eventBus } from '@assistant-ai/core'
import { resolveDescriptor, baseName, UI_EVENTS } from '../utils/toolDisplay'
import { checkDangerousCommand } from '../utils/commandSafety'

defineOptions({ inheritAttrs: false })

interface Props {
  toolName: string
  status: 'pending' | 'running' | 'success' | 'failed' | 'rejected'
  parameters?: Record<string, any>
  result?: any
  mcpServerName?: string
}

const props = withDefaults(defineProps<Props>(), {
  parameters: () => ({}),
  result: undefined,
  mcpServerName: ''
})

const descriptor = computed(() => resolveDescriptor(props.toolName))

/** running 态显示进行时动词（"正在读取"），对齐行业进行时动词短语惯例 */
const verbText = computed(() =>
  props.status === 'running' ? `正在${descriptor.value.verb}` : descriptor.value.verb
)

const objectText = computed(() => descriptor.value.object?.(props.parameters, props.result) || '')
const objectTitleText = computed(() => descriptor.value.objectTitle?.(props.parameters) || '')

/** 文件族对象可点击打开（objectTitle 给出完整路径时） */
const objectFullPath = computed(() => objectTitleText.value)

const openFile = () => {
  if (!objectFullPath.value) return
  eventBus.emit(UI_EVENTS.OPEN_FILE_IN_DOCK, { path: objectFullPath.value })
}

const filePaths = computed<string[]>(() =>
  Array.isArray(props.parameters?.paths) ? props.parameters.paths : []
)

/** fileList 仅 delete_file 且 paths.length > 1 时可展开（对齐 FileOperationConfirmDisplay 旧 canExpand） */
const expandable = computed(() => {
  const kind = descriptor.value.detail ?? 'params'
  if (kind === 'none') return false
  if (kind === 'fileList') return filePaths.value.length > 1
  return true
})

const expanded = ref(false)
const toggleExpanded = () => {
  if (!expandable.value) return
  expanded.value = !expanded.value
}

// ---- 命令详情 ----
const commandText = computed(() => props.parameters?.command || props.parameters?.code || '')
const purpose = computed(() => props.parameters?.purpose || '')
const intent = computed(() => props.parameters?.intent || '')
const workingDirectory = computed(() => props.parameters?.working_directory || '')
const isBlocked = computed(() => checkDangerousCommand(commandText.value))

// ---- 通用格式化 ----
const hasResult = computed(() => props.result !== undefined && props.result !== null && props.result !== '')

const formatValue = (value: any): string => {
  if (typeof value === 'object') return JSON.stringify(value, null, 2)
  return String(value)
}

const formatResult = (result: any): string => {
  if (result === undefined || result === null) return ''
  if (typeof result === 'object') return JSON.stringify(result, null, 2)
  return String(result)
}
</script>

<style scoped>
.tool-line-display {
  display: flex;
  flex-direction: column;
  margin: 0.25rem 0;
  max-width: 100%;
}

.tool-line {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  user-select: none;
  min-width: 0;
}

.tool-line.expandable {
  cursor: pointer;
}

.status-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}

.status-icon svg {
  width: 100%;
  height: 100%;
}

.loading-spinner {
  color: #3b82f6;
}

.success-icon {
  color: #10b981;
}

.failed-icon {
  color: #ef4444;
}

.pending-icon,
.rejected-icon {
  color: #9ca3af;
}

.verb {
  font-size: 0.8125rem;
  color: #6b7280;
  font-weight: 500;
  flex-shrink: 0;
}

.object {
  font-size: 0.8125rem;
  color: #4b5563;
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.object.link {
  color: #3b82f6;
  cursor: pointer;
}

.object.link:hover {
  text-decoration: underline;
}

.mcp-server {
  font-size: 0.8125rem;
  color: #9ca3af;
  flex-shrink: 0;
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

.details {
  padding: 0.375rem 0 0.25rem 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.detail-section {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.section-label {
  font-size: 0.75rem;
  color: #9ca3af;
  font-weight: 500;
}

.section-content {
  font-size: 0.8125rem;
  color: #6b7280;
  white-space: pre-wrap;
  word-break: break-word;
}

.section-content.mono {
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
}

.section-content.result {
  max-height: 300px;
  overflow-y: auto;
}

.code-block {
  background: rgba(0, 0, 0, 0.03);
  border-radius: 4px;
  padding: 0.375rem 0.5rem;
  max-height: 300px;
  overflow-y: auto;
}

.code-block pre {
  margin: 0;
  font-size: 0.8125rem;
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
  color: #374151;
  white-space: pre-wrap;
  word-break: break-word;
}

.warning-banner {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.375rem 0.5rem;
  background: rgba(239, 68, 68, 0.06);
  border-radius: 4px;
  color: #dc2626;
  font-size: 0.8125rem;
}

.warning-banner svg {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}

.parameters-section {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.parameter-item {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.parameter-key {
  font-size: 0.75rem;
  color: #9ca3af;
  font-weight: 500;
}

.parameter-value {
  font-size: 0.8125rem;
  color: #6b7280;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
  background: rgba(0, 0, 0, 0.02);
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
  max-height: 300px;
  overflow-y: auto;
}

.file-list {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.file-item {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  min-width: 0;
}

.file-icon {
  width: 14px;
  height: 14px;
  color: #9ca3af;
  flex-shrink: 0;
}

.file-name {
  font-size: 0.8125rem;
  color: #4b5563;
  font-weight: 500;
  flex-shrink: 0;
}

.file-path {
  font-size: 0.75rem;
  color: #9ca3af;
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
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
  max-height: 600px;
  opacity: 1;
}
</style>
