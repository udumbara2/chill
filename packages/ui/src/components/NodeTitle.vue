<template>
  <div class="node-title">
    <span 
      class="title-text"
      :class="{ 'editing': isEditing }"
      ref="titleElement"
      :contenteditable="isEditing"
      @blur="handleBlur"
      @keydown.enter="handleEnter"
      @dblclick.stop="handleDblClick"
      @mousedown="handleMouseDown"
      title="双击编辑"
    >
      {{ title }}
    </span>
  </div>
</template>

<script setup lang="ts">
import { ref, nextTick } from 'vue'

interface Props {
  title?: string
}

const props = withDefaults(defineProps<Props>(), {
  title: '模型节点'
})

const emit = defineEmits<{
  'update:title': [title: string]
}>()

const isEditing = ref(false)
const titleElement = ref<HTMLElement | null>(null)

const handleMouseDown = (event: MouseEvent) => {
  if (isEditing.value) {
    event.stopPropagation()
  }
}

const handleDblClick = () => {
  isEditing.value = true
  
  nextTick(() => {
    if (titleElement.value) {
      titleElement.value.focus()
    }
  })
}

const handleBlur = () => {
  isEditing.value = false
  const newTitle = titleElement.value?.innerText?.trim() || props.title
  if (newTitle !== props.title) {
    emit('update:title', newTitle)
  }
}

const handleEnter = (event: KeyboardEvent) => {
  event.preventDefault()
  isEditing.value = false
  const newTitle = titleElement.value?.innerText?.trim() || props.title
  if (newTitle !== props.title) {
    emit('update:title', newTitle)
  }
}
</script>

<style scoped>
.node-title {
  display: flex;
  align-items: center;
  flex: 1;
  padding: 0;
  background-color: transparent;
  border-bottom: none;
}

.title-text {
  font-weight: 500;
  font-size: 13px;
  color: var(--text-primary, #111827);
  cursor: pointer;
  user-select: none;
  padding: 2px 4px;
  border-radius: 4px;
  transition: all 0.2s ease;
}

.title-text:hover {
  background-color: var(--background-primary, #ffffff);
  box-shadow: 0 0 0 1px var(--border-color, #e5e7eb);
}

.title-text.editing {
  cursor: text;
  user-select: text;
  background-color: var(--background-primary, #ffffff);
  box-shadow: 0 0 0 2px #3b82f6;
  outline: none;
}

.title-text.editing:focus {
  outline: none;
}
</style>
