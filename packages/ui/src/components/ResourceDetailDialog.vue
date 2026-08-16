<template>
  <div class="resource-dialog-overlay" v-if="visible" @click="handleClose">
    <div class="resource-dialog" @click.stop>
      <div class="dialog-header">
        <h3>资源详情</h3>
        <button class="close-button" @click="handleClose">×</button>
      </div>
      
      <div class="dialog-content">
        <div class="resource-info">
          <div class="info-row">
            <span class="info-label">名称：</span>
            <span class="info-value">{{ resource?.name || resource?.uri }}</span>
          </div>
          <div class="info-row">
            <span class="info-label">URI：</span>
            <span class="info-value">{{ resource?.uri }}</span>
          </div>
          <div v-if="resource?.description" class="info-row">
            <span class="info-label">描述：</span>
            <span class="info-value description">{{ resource.description }}</span>
          </div>
        </div>
        
        <div class="resource-content-section">
          <div class="content-header">资源内容</div>
          <div v-if="loading" class="loading-indicator">加载中...</div>
          <div v-else-if="error" class="error-message">{{ error }}</div>
          <div v-else class="resource-content">
            <pre>{{ content }}</pre>
          </div>
        </div>
      </div>
      
      <div class="dialog-actions">
        <button class="btn-secondary" @click="handleClose">
          取消
        </button>
        <button 
          class="btn-primary" 
          @click="handleCopy" 
          :disabled="loading || !content"
          :class="{ 'copy-success': copyStatus === 'success', 'copy-error': copyStatus === 'error' }"
        >
          <span v-if="copyStatus === 'idle'">复制</span>
          <span v-else-if="copyStatus === 'success'">✓ 已复制</span>
          <span v-else-if="copyStatus === 'error'">✗ 复制失败</span>
        </button>
        <button class="btn-primary" @click="handleInsert" :disabled="loading || !content">
          插入
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { eventBus } from '@assistant-ai/core'
import { EVENTS } from '@assistant-ai/core'
import { MCPService } from '@assistant-ai/core'

interface Resource {
  uri: string
  name?: string
  description?: string
  serverId?: string
}

interface Props {
  visible: boolean
  resource: Resource | null
}

const props = defineProps<Props>()
const emit = defineEmits<{
  close: []
}>()

const loading = ref<boolean>(false)
const content = ref<string>('')
const error = ref<string>('')
const copyStatus = ref<'idle' | 'success' | 'error'>('idle')
const copyStatusTimer = ref<number | null>(null)

const loadResourceContent = async () => {
  if (!props.resource) {
    content.value = ''
    error.value = ''
    return
  }
  
  loading.value = true
  error.value = ''
  content.value = ''
  
  try {
    const result = await new MCPService().readResource(props.resource.uri, props.resource.serverId)
    content.value = result?.contents?.[0]?.text || '(空)'
  } catch (err) {
    const errorObj = err as Error
    error.value = '加载失败: ' + (errorObj.message || String(err))
  } finally {
    loading.value = false
  }
}

watch(() => props.visible, (newVisible) => {
  if (newVisible && props.resource) {
    loadResourceContent()
  }
})

const handleClose = () => {
  emit('close')
}

const handleCopy = async () => {
  try {
    await navigator.clipboard.writeText(content.value)
    copyStatus.value = 'success'
    
    if (copyStatusTimer.value) {
      clearTimeout(copyStatusTimer.value)
    }
    
    copyStatusTimer.value = window.setTimeout(() => {
      copyStatus.value = 'idle'
    }, 2000)
  } catch (err) {
    copyStatus.value = 'error'
    
    if (copyStatusTimer.value) {
      clearTimeout(copyStatusTimer.value)
    }
    
    copyStatusTimer.value = window.setTimeout(() => {
      copyStatus.value = 'idle'
    }, 2000)
  }
}

const handleInsert = () => {
  eventBus.emit(EVENTS.INSERT_TEXT, content.value)
  handleClose()
}
</script>

<style scoped>
.resource-dialog-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 11000;
}

.resource-dialog {
  background: rgba(255, 255, 255, 0.15);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 16px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
  max-width: 700px;
  width: 90%;
  max-height: 80vh;
  overflow: hidden;
}

.dialog-header {
  padding: 14px 20px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  position: relative;
}

.dialog-header::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 20px;
  right: 20px;
  height: 1px;
  background: linear-gradient(90deg, 
    transparent 0%, 
    rgba(255, 248, 255, 1) 15%, 
    rgba(255, 238, 250, 1) 22%, 
    rgba(255, 225, 245, 1) 30%, 
    rgba(255, 215, 240, 1) 38%, 
    rgba(255, 235, 230, 1) 46%, 
    rgba(255, 240, 210, 1) 54%, 
    rgba(255, 245, 190, 1) 62%, 
    rgba(250, 255, 170, 1) 70%, 
    rgba(200, 255, 180, 1) 78%, 
    rgba(170, 255, 170, 1) 84%, 
    rgba(160, 250, 190, 1) 90%, 
    rgba(155, 245, 200, 1) 96%, 
    transparent 100%
  );
}

.dialog-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 400;
  color: var(--vscode-foreground, #1f2937);
  letter-spacing: 0.2px;
}

.close-button {
  background: none;
  border: none;
  font-size: 18px;
  cursor: pointer;
  padding: 0;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  color: var(--vscode-descriptionForeground, #6b7280);
  transition: all 0.15s ease;
}

.close-button:hover {
  background: rgba(255, 255, 255, 0.4);
  color: var(--vscode-foreground, #1f2937);
}

.dialog-content {
  padding: 20px;
  max-height: 60vh;
  overflow-y: auto;
}

.resource-info {
  padding: 12px;
  background-color: rgba(255, 255, 255, 0.4);
  border-radius: 8px;
  margin-bottom: 16px;
}

.info-row {
  display: flex;
  margin-bottom: 8px;
  line-height: 1.5;
}

.info-row:last-child {
  margin-bottom: 0;
}

.info-label {
  font-weight: 400;
  color: var(--vscode-foreground, #1f2937);
  font-size: 13px;
  min-width: 60px;
  flex-shrink: 0;
}

.info-value {
  color: var(--vscode-descriptionForeground, #6b7280);
  font-size: 13px;
  word-break: break-word;
}

.info-value.description {
  line-height: 1.6;
}

.resource-content-section {
  background-color: rgba(255, 255, 255, 0.3);
  border-radius: 8px;
  overflow: hidden;
}

.content-header {
  padding: 10px 12px;
  font-size: 13px;
  font-weight: 400;
  color: var(--vscode-foreground, #1f2937);
  background-color: rgba(255, 255, 255, 0.5);
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
}

.loading-indicator {
  padding: 40px 20px;
  text-align: center;
  color: var(--vscode-descriptionForeground, #6b7280);
  font-size: 13px;
}

.error-message {
  padding: 16px 20px;
  color: #c53030;
  font-size: 13px;
  background-color: rgba(255, 235, 235, 0.9);
  border-radius: 8px;
}

.resource-content {
  padding: 12px;
  max-height: 300px;
  overflow-y: auto;
  font-size: 13px;
  line-height: 1.6;
  color: var(--vscode-foreground, #1f2937);
}

.resource-content pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
}

.dialog-actions {
  padding: 20px;
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}

.btn-primary, .btn-secondary {
  padding: 10px 20px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 400;
  cursor: pointer;
  border: none;
  transition: all 0.2s ease;
  letter-spacing: 0.2px;
}

.btn-primary {
  background: var(--vscode-button-background, #007acc);
  color: var(--vscode-button-foreground, #ffffff);
  box-shadow: 0 2px 4px rgba(0, 122, 204, 0.2);
}

.btn-primary:hover:not(:disabled) {
  background: var(--vscode-button-hoverBackground, #005a9e);
  transform: translateY(-1px);
  box-shadow: 0 4px 8px rgba(0, 122, 204, 0.3);
}

.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-secondary {
  background: rgba(255, 255, 255, 0.6);
  color: var(--vscode-foreground, #1f2937);
}

.btn-secondary:hover {
  background: rgba(255, 255, 255, 0.8);
  transform: translateY(-1px);
}

.btn-primary.copy-success {
  background: #10b981;
  color: #ffffff;
  box-shadow: 0 2px 4px rgba(16, 185, 129, 0.2);
}

.btn-primary.copy-success:hover:not(:disabled) {
  background: #059669;
  transform: translateY(-1px);
  box-shadow: 0 4px 8px rgba(16, 185, 129, 0.3);
}

.btn-primary.copy-error {
  background: #ef4444;
  color: #ffffff;
  box-shadow: 0 2px 4px rgba(239, 68, 68, 0.2);
}

.btn-primary.copy-error:hover:not(:disabled) {
  background: #dc2626;
  transform: translateY(-1px);
  box-shadow: 0 4px 8px rgba(239, 68, 68, 0.3);
}
</style>
