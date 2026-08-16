<template>
  <div class="text-editor">
    <!-- 只看（editable=false）时隐藏格式/保存工具栏，编辑器纯展示 -->
    <div v-if="editor && editable" class="editor-toolbar">
      <button
        @click="editor.chain().focus().toggleBold().run()"
        :class="{ 'is-active': editor.isActive('bold') }"
        title="加粗"
      >
        B
      </button>
      <button
        @click="editor.chain().focus().toggleItalic().run()"
        :class="{ 'is-active': editor.isActive('italic') }"
        title="斜体"
      >
        I
      </button>
      <button
        @click="editor.chain().focus().toggleHeading({ level: 1 }).run()"
        :class="{ 'is-active': editor.isActive('heading', { level: 1 }) }"
        title="标题1"
      >
        H1
      </button>
      <button
        @click="editor.chain().focus().toggleHeading({ level: 2 }).run()"
        :class="{ 'is-active': editor.isActive('heading', { level: 2 }) }"
        title="标题2"
      >
        H2
      </button>
      <button
        @click="editor.chain().focus().toggleBulletList().run()"
        :class="{ 'is-active': editor.isActive('bulletList') }"
        title="无序列表"
      >
        • 列表
      </button>
      <button
        @click="editor.chain().focus().toggleOrderedList().run()"
        :class="{ 'is-active': editor.isActive('orderedList') }"
        title="有序列表"
      >
        1. 列表
      </button>
      <button
        @click="$emit('save')"
        title="保存 (Ctrl+S)"
        class="save-button"
        :class="{ 'save-success': saveStatus === 'saved', 'save-error': saveStatus === 'error' }"
      >
        {{ saveStatus === 'saving' ? '保存中...' : saveStatus === 'saved' ? '已保存' : saveStatus === 'error' ? '保存失败' : '保存' }}
      </button>
    </div>
    <editor-content :editor="editor" class="editor-content" />
  </div>
</template>

<script setup lang="ts">
import { useEditor, EditorContent } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import { watch, computed } from 'vue'
import { DiffPreviewExtension, DiffPreviewPluginKey, type DiffOperation } from '../extensions/DiffPreviewExtension'
import { usePendingOperationsStore } from '../stores/pendingOperationsStore'
import { generateDocumentSnapshot, type DocumentSnapshot } from '../utils/tipTapDocumentSnapshot'

const props = withDefaults(defineProps<{
  content?: string
  saveStatus?: 'idle' | 'saving' | 'saved' | 'error'
  filePath?: string
  /** 参与/只看意图开关（dock 传入）；false 时编辑器只读，pendingOperations 锁定逻辑保留优先 */
  editable?: boolean
}>(), {
  editable: true
})

const pendingOperationsStore = usePendingOperationsStore()

const isEditable = computed(() => {
  if (!props.editable) return false
  if (!props.filePath) return true
  const pendingOps = pendingOperationsStore.getOperationsByFile(props.filePath)
  return pendingOps.length === 0
})

const editor = useEditor({
  extensions: [StarterKit, DiffPreviewExtension],
  content: props.content || '<p>开始写作...</p>',
  editable: isEditable.value,
  editorProps: {
    attributes: {
      class: 'prose prose-sm sm:prose lg:prose-lg xl:prose-2xl mx-auto focus:outline-none',
    },
  },
  onUpdate: () => {
    emit('content-change')
  },
})

watch(() => props.content, (newContent) => {
  // 双写路径协调：与 reloadFile 的 setContent 可能先后写入同一内容，
  // 内容一致时跳过 setContent，避免光标丢失/全量重渲染
  if (newContent && editor.value && newContent !== editor.value.getHTML()) {
    // emitUpdate: false——程序化写入不触发 onUpdate（避免误判为用户编辑的脏标记）
    editor.value.commands.setContent(newContent, { emitUpdate: false })
  }
})

watch(isEditable, (val) => {
  editor.value?.setEditable(val)
})

const getContent = () => {
  return editor.value?.getHTML() || ''
}

const setContent = (content: string) => {
  // 与 watch(props.content) 同一守卫：内容一致不重复 setContent（保留选区/光标）
  if (editor.value && content !== editor.value.getHTML()) {
    editor.value.commands.setContent(content, { emitUpdate: false })
  }
}

const setDiffPreview = (operations: DiffOperation[]) => {
  if (!editor.value) return
  
  const tr = editor.value.state.tr.setMeta(DiffPreviewPluginKey, {
    type: 'set',
    operations,
  })
  editor.value.view.dispatch(tr)
}

const clearDiffPreview = () => {
  if (!editor.value) return
  
  const tr = editor.value.state.tr.setMeta(DiffPreviewPluginKey, {
    type: 'clear',
  })
  editor.value.view.dispatch(tr)
}

const getSnapshot = (): DocumentSnapshot | null => {
  if (!editor.value) {
    return null
  }
  return generateDocumentSnapshot(editor.value)
}

const getDocSize = (): number => {
  if (!editor.value) {
    return 0
  }
  return editor.value.state.doc.content.size
}

defineExpose({
  getContent,
  setContent,
  setDiffPreview,
  clearDiffPreview,
  getSnapshot,
  getDocSize
})

const emit = defineEmits<{
  'save': []
  'content-change': []
}>()
</script>

<style scoped>
.text-editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  background-color: var(--background-primary);
}

.editor-toolbar {
  display: flex;
  gap: 4px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-color);
  background-color: var(--background-secondary);
}

.editor-toolbar button {
  padding: 4px 8px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background-color: var(--background-primary);
  color: var(--text-primary);
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
  transition: all 0.2s;
}

.editor-toolbar button:hover {
  background-color: var(--background-hover);
}

.editor-toolbar button.is-active {
  background-color: var(--primary-color);
  color: white;
  border-color: var(--primary-color);
}

.editor-toolbar .save-button {
  margin-left: auto;
  background-color: var(--primary-color);
  color: white;
  border-color: var(--primary-color);
}

.editor-toolbar .save-button:hover {
  opacity: 0.9;
}

.editor-toolbar .save-button.save-success {
  background-color: #22c55e;
  border-color: #22c55e;
}

.editor-toolbar .save-button.save-error {
  background-color: #ef4444;
  border-color: #ef4444;
}

.editor-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
}

.editor-content :deep(.ProseMirror) {
  min-height: 100%;
  outline: none;
}

.editor-content :deep(.ProseMirror p) {
  margin: 0.5em 0;
}

.editor-content :deep(.ProseMirror h1) {
  font-size: 2em;
  font-weight: bold;
  margin: 0.67em 0;
}

.editor-content :deep(.ProseMirror h2) {
  font-size: 1.5em;
  font-weight: bold;
  margin: 0.75em 0;
}

.editor-content :deep(.ProseMirror ul) {
  list-style-type: disc;
  padding-left: 1.5em;
  margin: 0.5em 0;
}

.editor-content :deep(.ProseMirror ol) {
  list-style-type: decimal;
  padding-left: 1.5em;
  margin: 0.5em 0;
}
</style>
