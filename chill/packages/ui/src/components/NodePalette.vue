<template>
  <div class="node-palette">
    <div class="palette-items">
      <div
        class="palette-item palette-item-start"
        draggable="true"
        @dragstart="handleDragStart($event, 'start')"
        @click="handleClick('start')"
        title="开始节点（点击创建或拖动）"
      >
        <div class="item-icon">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <polygon points="10 8 16 12 10 16 10 8"/>
          </svg>
        </div>
      </div>
      <div
        class="palette-item palette-item-model"
        draggable="true"
        @dragstart="handleDragStart($event, 'model')"
        @click="handleClick('model')"
        title="模型节点（点击创建或拖动）"
      >
        <div class="item-icon">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
            <line x1="8" y1="21" x2="16" y2="21"/>
            <line x1="12" y1="17" x2="12" y2="21"/>
          </svg>
        </div>
      </div>
      <div
        class="palette-item palette-item-tool"
        draggable="true"
        @dragstart="handleDragStart($event, 'tool')"
        @click="handleClick('tool')"
        title="工具节点（点击创建或拖动）"
      >
        <div class="item-icon">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
          </svg>
        </div>
      </div>
      <div
        class="palette-item palette-item-code"
        draggable="true"
        @dragstart="handleDragStart($event, 'code')"
        @click="handleClick('code')"
        title="代码执行节点（点击创建或拖动）"
      >
        <div class="item-icon">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="16 18 22 12 16 6"/>
            <polyline points="8 6 2 12 8 18"/>
          </svg>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { workflowEventBus, WORKFLOW_EVENTS } from '@assistant-ai/core'

const handleDragStart = (event: DragEvent, nodeType: string) => {
  if (event.dataTransfer) {
    event.dataTransfer.setData('application/vueflow-node-type', nodeType)
    event.dataTransfer.effectAllowed = 'copy'
  }
}

const handleClick = (nodeType: string) => {
  workflowEventBus.emit(WORKFLOW_EVENTS.NODE_CREATE, { nodeType })
}
</script>

<style scoped>
.node-palette {
  position: absolute;
  left: 12px;
  bottom: 12px;
  width: auto;
  background: transparent;
  border: none;
  box-shadow: none;
  padding: 0;
  z-index: 10;
  user-select: none;
}

.palette-items {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
}

.palette-item {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  cursor: grab;
  transition: all 0.15s ease;
  backdrop-filter: blur(4px);
}

.palette-item-start {
  background-color: rgba(16, 185, 129, 0.08);
  color: rgba(16, 185, 129, 0.85);
}

.palette-item-start:hover {
  background-color: rgba(16, 185, 129, 0.2);
  color: rgba(16, 185, 129, 1);
}

.palette-item-model {
  background-color: rgba(59, 130, 246, 0.08);
  color: rgba(59, 130, 246, 0.85);
}

.palette-item-model:hover {
  background-color: rgba(59, 130, 246, 0.2);
  color: rgba(59, 246, 1);
}

.palette-item-tool {
  background-color: rgba(139, 92, 246, 0.08);
  color: rgba(139, 92, 246, 0.85);
}

.palette-item-tool:hover {
  background-color: rgba(139, 92, 246, 0.2);
  color: rgba(139, 92, 246, 1);
}

.palette-item-code {
  background-color: rgba(137, 180, 250, 0.08);
  color: rgba(137, 180, 250, 0.85);
}

.palette-item-code:hover {
  background-color: rgba(137, 180, 250, 0.2);
  color: rgba(137, 180, 250, 1);
}

.palette-item:active {
  cursor: grabbing;
}

.item-icon {
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
