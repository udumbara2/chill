<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="isOpen" class="modal-container" :style="modalStyle" @click.stop>
        <div class="modal-header" @mousedown="startDrag">
          <h3 class="modal-title">{{ title }}</h3>
          <div class="modal-header-actions" @mousedown.stop>
            <button class="modal-action-button" @click="toggleFullscreen" :title="isFullscreen ? '退出全屏' : '全屏'">
              <svg v-if="!isFullscreen" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>
              </svg>
              <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>
              </svg>
            </button>
            <button class="modal-action-button" @click="handleClose" title="关闭">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>
        <div class="modal-content">
          <slot></slot>
        </div>
        <div class="modal-resize-handle" @mousedown="startResize"></div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'

interface Props {
  isOpen?: boolean
  title?: string
  width?: number
  height?: number
  modalId?: string
}

const props = withDefaults(defineProps<Props>(), {
  isOpen: false,
  title: '执行结果',
  width: 300,
  height: 480,
  modalId: ''
})

const emit = defineEmits<{
  close: []
}>()

const isFullscreen = ref(false)
const isResizing = ref(false)
const isDragging = ref(false)
const resizeStartX = ref(0)
const resizeStartY = ref(0)
const resizeStartWidth = ref(0)
const resizeStartHeight = ref(0)
const dragStartX = ref(0)
const dragStartY = ref(0)
const dragStartLeft = ref(0)
const dragStartTop = ref(0)

const modalSize = ref({
  width: props.width,
  height: props.height
})

const modalPosition = ref({
  left: 0,
  top: 0
})

const modalStyle = computed(() => {
  if (isFullscreen.value) {
    return {
      width: '100vw',
      height: '100vh',
      top: '0',
      left: '0',
      transform: 'none',
      position: 'fixed' as const,
      zIndex: 1000
    }
  }
  return {
    width: `${modalSize.value.width}px`,
    height: `${modalSize.value.height}px`,
    left: `${modalPosition.value.left}px`,
    top: `${modalPosition.value.top}px`,
    position: 'absolute' as const,
    zIndex: 1000
  }
})

const handleClose = () => {
  emit('close')
}

const toggleFullscreen = () => {
  isFullscreen.value = !isFullscreen.value
}

const startResize = (e: MouseEvent) => {
  if (isFullscreen.value) return
  
  isResizing.value = true
  resizeStartX.value = e.clientX
  resizeStartY.value = e.clientY
  resizeStartWidth.value = modalSize.value.width
  resizeStartHeight.value = modalSize.value.height
  
  document.addEventListener('mousemove', handleResize)
  document.addEventListener('mouseup', stopResize)
}

const handleResize = (e: MouseEvent) => {
  if (!isResizing.value) return
  
  const deltaX = e.clientX - resizeStartX.value
  const deltaY = e.clientY - resizeStartY.value
  
  modalSize.value.width = Math.max(400, resizeStartWidth.value + deltaX)
  modalSize.value.height = Math.max(300, resizeStartHeight.value + deltaY)
}

const stopResize = () => {
  isResizing.value = false
  document.removeEventListener('mousemove', handleResize)
  document.removeEventListener('mouseup', stopResize)
}

const startDrag = (e: MouseEvent) => {
  if (isFullscreen.value) return
  
  isDragging.value = true
  dragStartX.value = e.clientX
  dragStartY.value = e.clientY
  dragStartLeft.value = modalPosition.value.left
  dragStartTop.value = modalPosition.value.top
  
  document.addEventListener('mousemove', handleDrag)
  document.addEventListener('mouseup', stopDrag)
}

const handleDrag = (e: MouseEvent) => {
  if (!isDragging.value) return
  
  const deltaX = e.clientX - dragStartX.value
  const deltaY = e.clientY - dragStartY.value
  
  modalPosition.value.left = dragStartLeft.value + deltaX
  modalPosition.value.top = dragStartTop.value + deltaY
}

const stopDrag = () => {
  isDragging.value = false
  document.removeEventListener('mousemove', handleDrag)
  document.removeEventListener('mouseup', stopDrag)
}

const handleKeyDown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') {
    handleClose()
  }
}

watch(() => props.isOpen, (newVal) => {
  if (newVal) {
    document.addEventListener('keydown', handleKeyDown)
    centerModal()
  } else {
    document.removeEventListener('keydown', handleKeyDown)
  }
})

const centerModal = () => {
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  
  modalPosition.value.left = (viewportWidth - modalSize.value.width) / 2
  modalPosition.value.top = (viewportHeight - modalSize.value.height) / 2
}

onMounted(() => {
  if (props.isOpen) {
    document.addEventListener('keydown', handleKeyDown)
  }
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeyDown)
  document.removeEventListener('mousemove', handleResize)
  document.removeEventListener('mouseup', stopResize)
  document.removeEventListener('mousemove', handleDrag)
  document.removeEventListener('mouseup', stopDrag)
})
</script>

<style scoped>
.modal-container {
  background-color: var(--background-primary, #ffffff);
  border-radius: 8px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
  display: flex;
  flex-direction: column;
  position: absolute;
  min-width: 300px;
  min-height: 300px;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color-light, #f3f4f6);
  background-color: var(--background-secondary, #f9fafb);
  border-radius: 8px 8px 0 0;
  cursor: move;
  user-select: none;
}

.modal-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary, #111827);
  margin: 0;
}

.modal-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.modal-action-button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  background-color: transparent;
  border: none;
  color: var(--text-secondary, #6b7280);
  cursor: pointer;
  border-radius: 4px;
  transition: all 0.2s;
}

.modal-action-button:hover {
  background-color: var(--background-tertiary, #f3f4f6);
  color: var(--text-primary, #111827);
}

.modal-content {
  flex: 0 1 auto;
  padding: 16px;
  overflow-x: hidden;
  overflow-y: hidden;
}

.modal-content::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

.modal-content::-webkit-scrollbar-track {
  background: var(--background-secondary, #f9fafb);
  border-radius: 4px;
}

.modal-content::-webkit-scrollbar-thumb {
  background: rgba(203, 213, 225, 0.6);
  border-radius: 4px;
  transition: background-color 0.2s;
}

.modal-content::-webkit-scrollbar-thumb:hover {
  background: rgba(100, 116, 139, 0.8);
}

.modal-resize-handle {
  position: absolute;
  bottom: 0;
  right: 0;
  width: 16px;
  height: 16px;
  cursor: se-resize;
  background: linear-gradient(135deg, transparent 50%, var(--text-secondary, #6b7280) 50%);
  opacity: 0.3;
  transition: opacity 0.2s;
  border-radius: 0 0 8px 0;
}

.modal-resize-handle:hover {
  opacity: 0.6;
}

.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.3s ease;
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.modal-enter-active .modal-container,
.modal-leave-active .modal-container {
  transition: transform 0.3s ease, opacity 0.3s ease;
}

.modal-enter-from .modal-container,
.modal-leave-to .modal-container {
  transform: scale(0.95);
  opacity: 0;
}
</style>
