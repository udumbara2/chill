<template>
  <div class="improve-pill-wrap">
    <button
      v-if="!expanded"
      class="improve-pill"
      :title="`改进提案账本：${digestLine}`"
      @click="toggle"
    >📬 改进提案 {{ digest?.pending ?? 0 }} ▴</button>
    <div v-else class="improve-pop" @click.stop>
      <div class="pop-head">
        <b>📬 改进提案账本</b>
        <button class="close" @click="expanded = false">×</button>
      </div>
      <div class="pop-body">
        <div class="digest">{{ digestLine }}</div>
        <div v-if="topClusters.length > 0" class="top">
          <div v-for="c in topClusters" :key="c.id" class="row">
            <span class="cid">{{ c.id }}</span>
            <span class="cname">{{ c.name }}</span>
            <span class="meta">{{ c.count }} 条<template v-if="c.recent > 0"> · 近期+{{ c.recent }}</template></span>
          </div>
        </div>
        <div v-else class="top empty-row">暂无待确认提案（已确认 {{ digest?.confirmed ?? 0 }} 条待实施）</div>
        <input
          v-if="managedFlag"
          class="capture-input"
          v-model="ideaText"
          placeholder="记个点子…（回车入账；任意界面 Ctrl+I 呼出捕获条）"
          @keydown.enter="submitIdea"
        >
        <div v-if="ideaNote" class="idea-note">{{ ideaNote }}</div>
        <div class="pop-actions">
          <button class="btn primary" @click="goDecide">去决策 →</button>
          <button class="btn" @click="expanded = false">稍后</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useProposalsStore } from '../stores/proposalsStore'
import { formatDigestLine, type ClusterSummary } from '@assistant-ai/core'
import { managedFlag } from '../services/managedFlag'

/**
 * 改进提案药丸（Home footer-pill-row · 决策闭环迭代 3 + 闪念捕获迭代 1）
 * 角色严格限定（UI 三层显示约定）：运行态观测点——折叠计数 + 就地一行摘要 + 捕获输入框 + 去决策跳转；
 * 管理面在设置页面板。无文件或全零时由父级（Home）隐匿本组件；npm 模式捕获框不渲染（managedFlag）。
 */
const emit = defineEmits<{ (e: 'decide'): void }>()
const store = useProposalsStore()
const expanded = ref(false)
const ideaText = ref('')
const ideaNote = ref('')

const digest = computed(() => store.digest)
const digestLine = computed(() => (store.digest ? formatDigestLine(store.digest) : '账本读取中…'))
const topClusters = computed<ClusterSummary[]>(() => store.clusters.slice(0, 3))

const submitIdea = async () => {
  const text = ideaText.value.trim()
  if (!text) return
  const r = await store.capture(text, 'GUI 药丸')
  ideaText.value = ''
  if (!r.ok) {
    ideaNote.value = `✗ ${r.error ?? '写入失败'}`
  } else if (r.duplicated) {
    ideaNote.value = '⚠ 10 秒内已记录过相同点子'
  } else {
    ideaNote.value = `✓ 已记入「闪念」簇${r.truncated ? '（超长已截断）' : ''} · 待确认 ${store.digest?.pending ?? ''} 条`
  }
}

const toggle = async () => {
  expanded.value = !expanded.value
  if (expanded.value) await store.refresh()
}

const goDecide = () => {
  expanded.value = false
  emit('decide')
}

const onDocClick = (e: MouseEvent) => {
  const wrap = (e.target as HTMLElement)?.closest?.('.improve-pill-wrap')
  if (!wrap) expanded.value = false
}

onMounted(async () => {
  await store.refresh()
  document.addEventListener('click', onDocClick)
})
onBeforeUnmount(() => document.removeEventListener('click', onDocClick))
</script>

<style scoped>
.improve-pill-wrap { position: relative; display: inline-flex; }
.improve-pill {
  border: 1px solid #cddcec; background: #eef3f8; color: #38587a;
  border-radius: 999px; padding: 3px 12px; font-size: 12px; cursor: pointer; font-weight: 600;
}
.improve-pill:hover { background: #e2ecf5; }
.improve-pop {
  position: absolute; bottom: calc(100% + 8px); left: 0; z-index: 1500;
  background: #fff; border: 1px solid #cddcec; border-radius: 10px; padding: 10px 12px;
  box-shadow: 0 6px 18px rgba(30, 60, 100, 0.15); min-width: 300px; max-width: 420px;
}
.pop-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; font-size: 13px; color: #38587a; }
.pop-head .close { border: none; background: none; cursor: pointer; color: #9aa2ae; font-size: 15px; }
.digest { font-size: 12.5px; color: #2b3240; margin-bottom: 6px; }
.top .row { display: flex; gap: 6px; font-size: 12px; color: #6b7484; padding: 2px 0; align-items: baseline; }
.row .cid { color: #4a7aa8; font-weight: 600; flex: none; }
.row .cname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row .meta { margin-left: auto; flex: none; color: #9aa2ae; }
.empty-row { font-size: 12px; color: #9aa2ae; padding: 4px 0; }
.capture-input { width: 100%; border: 1px solid #cddcec; border-radius: 7px; padding: 6px 10px; font-size: 12.5px; outline: none; color: #2b3240; margin-top: 2px; }
.capture-input:focus { border-color: var(--accent); }
.idea-note { font-size: 11px; color: #3d8f5f; margin-top: 4px; min-height: 13px; }
.pop-actions { display: flex; gap: 8px; margin-top: 8px; }
.btn { border: 1px solid #e3e6ea; background: #fff; color: #6b7484; border-radius: 7px; padding: 4px 12px; font-size: 12.5px; cursor: pointer; }
.btn.primary { background: #4a7aa8; border-color: #4a7aa8; color: #fff; font-weight: 600; }
.btn.primary:hover { background: #38587a; }
</style>
