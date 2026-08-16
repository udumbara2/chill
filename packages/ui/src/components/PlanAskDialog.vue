<template>
  <div class="plan-ask-dialog-overlay" v-if="planModeStore.askVisible">
    <div class="plan-ask-dialog" @click.stop>
      <div class="dialog-header">
        <h3>规划模式提问</h3>
      </div>

      <div class="dialog-content">
        <!-- 问题文本（长文本滚动预览） -->
        <div class="ask-question">{{ planModeStore.askQuestion }}</div>

        <!-- 选项按钮列表 -->
        <div v-if="planModeStore.askOptions.length > 0" class="ask-options">
          <button
            v-for="(option, index) in planModeStore.askOptions"
            :key="index"
            class="ask-option-btn"
            @click="handleSelect(option.label)"
          >
            <span class="option-label">{{ option.label }}</span>
            <span v-if="option.description" class="option-description">{{ option.description }}</span>
          </button>
        </div>

        <!-- 自由文本输入（无选项或允许自由输入时显示） -->
        <div v-if="planModeStore.askOptions.length === 0 || planModeStore.askAllowFreeText" class="ask-free-text">
          <textarea
            v-model="freeText"
            class="free-text-input"
            placeholder="输入你的回答..."
            rows="3"
            @keydown.enter.ctrl="handleConfirmFreeText"
          ></textarea>
          <div class="dialog-actions">
            <button
              class="btn-primary"
              :disabled="!freeText.trim()"
              @click="handleConfirmFreeText"
            >
              确认
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { usePlanModeStore } from '../stores/planModeStore'

const planModeStore = usePlanModeStore()

const freeText = ref('')

// 每次打开新提问时清空上次输入
watch(() => planModeStore.askVisible, (visible) => {
  if (visible) freeText.value = ''
})

// 选择选项：以选项 label 作为回答
const handleSelect = (answer: string) => {
  planModeStore.resolveAsk(answer)
}

// 确认自由文本：以输入内容作为回答
const handleConfirmFreeText = () => {
  const answer = freeText.value.trim()
  if (!answer) return
  planModeStore.resolveAsk(answer)
}
</script>

<style scoped>
.plan-ask-dialog-overlay {
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

.plan-ask-dialog {
  background: rgba(255, 255, 255, 0.15);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 16px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
  max-width: 500px;
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

.dialog-content {
  padding: 20px;
  max-height: 60vh;
  overflow-y: auto;
}

.ask-question {
  font-size: 14px;
  color: var(--vscode-foreground, #1f2937);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 30vh;
  overflow-y: auto;
  margin-bottom: 16px;
}

.ask-options {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ask-option-btn {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 10px 12px;
  border: none;
  border-radius: 8px;
  background-color: rgba(255, 255, 255, 0.8);
  cursor: pointer;
  text-align: left;
  transition: all 0.2s ease;
}

.ask-option-btn:hover {
  background-color: rgba(255, 255, 255, 0.95);
  box-shadow: 0 0 0 2px rgba(0, 122, 204, 0.3);
}

.option-label {
  font-size: 14px;
  font-weight: 500;
  color: var(--vscode-foreground, #1f2937);
}

.option-description {
  font-size: 12px;
  font-weight: 300;
  color: var(--vscode-descriptionForeground, #6b7280);
  line-height: 1.4;
}

.ask-free-text {
  margin-top: 12px;
}

.free-text-input {
  width: 100%;
  padding: 10px 12px;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  box-sizing: border-box;
  background-color: rgba(255, 255, 255, 0.8);
  color: var(--vscode-foreground, #1f2937);
  resize: vertical;
  transition: all 0.2s ease;
}

.free-text-input:focus {
  outline: none;
  background-color: rgba(255, 255, 255, 0.95);
  box-shadow: 0 0 0 2px rgba(0, 122, 204, 0.3);
}

.dialog-actions {
  padding-top: 12px;
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}

.btn-primary {
  padding: 10px 20px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 400;
  cursor: pointer;
  border: none;
  transition: all 0.2s ease;
  letter-spacing: 0.2px;
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
</style>
