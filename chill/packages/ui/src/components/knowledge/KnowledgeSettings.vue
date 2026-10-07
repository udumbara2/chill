<template>
  <div class="settings-page">
    <div class="settings-page-header">
      <h2>知识库</h2>
      <div class="settings-actions">
        <button class="settings-btn" @click="loadAll" :disabled="loading" title="重新加载知识库列表">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="23 4 23 10 17 10"></polyline>
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
          </svg>
          刷新
        </button>
      </div>
    </div>
    <p class="settings-tip">
      知识库存放在 ~/.chill/knowledge/，与 CLI 共享；摄入与检索的 embedding 配置见底部"服务配置"。
    </p>

    <!-- 全局提示条：core 抛出的中文错误原样展示 -->
    <div v-if="notice" class="settings-notice" :class="'settings-notice-' + notice.type">{{ notice.text }}</div>

    <!-- ============ 库列表区 ============ -->
    <section class="settings-group">
      <div class="settings-group-head">
        <h3>库列表</h3>
        <button class="settings-btn" @click="showCreateForm = !showCreateForm">
          {{ showCreateForm ? '收起' : '新建知识库' }}
        </button>
      </div>

      <div v-if="showCreateForm" class="create-form">
        <input v-model="newKbName" class="settings-input" type="text" placeholder="库名称（必填，用作目录名）" />
        <input v-model="newKbDesc" class="settings-input" type="text" placeholder="描述（可选）" />
        <button class="settings-btn settings-btn-primary" @click="createKb" :disabled="loading">创建</button>
      </div>

      <div v-if="kbs.length === 0" class="settings-empty">
        <div class="settings-empty-icon">📚</div>
        <p class="settings-empty-title">暂无知识库</p>
        <p class="settings-empty-hint">点击"新建知识库"创建第一个库，然后即可摄入文档</p>
      </div>

      <div v-else class="kb-list">
        <div
          v-for="kb in kbs"
          :key="kb.name"
          class="settings-card kb-card"
          :class="{ selected: selectedKb === kb.name }"
          @click="selectKb(kb.name)"
        >
          <div class="kb-card-header">
            <div class="kb-name-row">
              <span class="kb-name">{{ kb.name }}</span>
              <span class="settings-badge settings-badge-neutral">{{ docCounts[kb.name] ?? 0 }} 篇文档</span>
              <span v-if="indexHealth[kb.name] === false" class="settings-badge settings-badge-warning" title="索引的 embedding 模型/维度与当前配置不一致，需重建索引后才能摄入与检索">
                索引需重建
              </span>
            </div>
            <div class="kb-actions">
              <button
                v-if="indexHealth[kb.name] === false"
                class="settings-btn settings-btn-warning"
                :disabled="rebuildingKb !== null"
                @click.stop="askRebuild(kb.name)"
              >{{ rebuildingKb === kb.name ? '重建中...' : '重建索引' }}</button>
              <button class="settings-btn settings-btn-danger" :disabled="loading" @click.stop="askDeleteKb(kb.name)">删除</button>
            </div>
          </div>
          <p class="kb-desc">{{ kb.description || '（无描述）' }}</p>
        </div>
      </div>
    </section>

    <!-- ============ 文档管理区 ============ -->
    <section v-if="selectedKb" class="settings-group">
      <div class="settings-group-head">
        <h3>文档管理 — {{ selectedKb }}</h3>
      </div>

      <div v-if="docs.length === 0" class="settings-empty small">
        <p class="settings-empty-title">该库暂无文档</p>
      </div>

      <div v-else class="doc-list">
        <div v-for="doc in docs" :key="doc.docId" class="settings-card doc-row">
          <div class="doc-main">
            <div class="doc-title-row">
              <span class="doc-title" :title="doc.sourcePath">{{ doc.title }}</span>
              <span
                class="settings-badge"
                :class="{ note: 'settings-badge-primary', pdf: 'settings-badge-accent', office: 'settings-badge-accent', image: 'settings-badge-accent', distilled: 'settings-badge-success' }[doc.type]"
              >{{ docTypeLabel(doc.type) }}</span>
            </div>
            <p class="doc-meta">
              docId: {{ doc.docId }} · {{ formatTime(doc.createdAt) }} · {{ doc.chunkCount }} 个切块
            </p>
          </div>
          <div class="doc-actions">
            <button class="settings-btn" @click="viewDoc(doc.docId)">查看正本</button>
            <button class="settings-btn settings-btn-danger" :disabled="loading" @click="askDeleteDoc(doc.docId, doc.title)">删除</button>
          </div>
        </div>
      </div>
    </section>

    <!-- ============ 摄入区 ============ -->
    <section v-if="selectedKb" class="settings-group">
      <div class="settings-group-head">
        <h3>摄入到「{{ selectedKb }}」</h3>
        <button class="settings-btn" @click="addFiles" :disabled="ingesting">添加文件</button>
      </div>
      <p class="settings-tip">支持 .md / .txt / .pdf / .docx / .xlsx / .pptx / .png / .jpg（可多选）；扫描版 PDF 与图片走视觉模型 OCR；同一路径内容未变化时自动跳过。</p>

      <p v-if="ingesting" class="progress-text">{{ ingestProgress }}</p>
      <div v-if="ingestSummary" class="settings-notice" :class="ingestSummary.failed > 0 ? 'settings-notice-error' : 'settings-notice-success'">
        {{ ingestSummary.text }}
      </div>

      <div class="distill-form">
        <p class="settings-hint">粘贴沉淀（直接入库为单块知识，标题即文档身份，同标题重复摄入会更新同一文档）</p>
        <input v-model="distillTitle" class="settings-input" type="text" placeholder="标题" />
        <textarea v-model="distillContent" class="settings-input" rows="5" placeholder="内容..."></textarea>
        <div class="form-actions">
          <button class="settings-btn settings-btn-primary" @click="submitDistill" :disabled="distilling || ingesting">
            {{ distilling ? '入库中...' : '沉淀入库' }}
          </button>
        </div>
      </div>
    </section>

    <!-- ============ 配置区 ============ -->
    <section class="settings-group">
      <div class="settings-group-head">
        <h3>服务配置</h3>
      </div>
      <p class="settings-tip">
        embedding 为任意 OpenAI 兼容服务（默认阿里百炼 text-embedding-v4 / 1024 维）。
        更换模型或维度后，已有索引的库会标记"索引需重建"，需重建后才能继续摄入与检索。
      </p>

      <div class="config-form">
        <div class="form-row">
          <label class="settings-label">Provider</label>
          <input v-model="configForm.embedding.provider" class="settings-input" type="text" placeholder="dashscope" />
        </div>
        <div class="form-row">
          <label class="settings-label">Base URL</label>
          <input v-model="configForm.embedding.baseURL" class="settings-input" type="text" placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1" />
        </div>
        <div class="form-row">
          <label class="settings-label">模型</label>
          <input v-model="configForm.embedding.model" class="settings-input" type="text" placeholder="text-embedding-v4" />
        </div>
        <div class="form-row">
          <label class="settings-label">维度</label>
          <input v-model.number="configForm.embedding.dimensions" class="settings-input narrow" type="number" min="1" placeholder="1024" />
        </div>
        <div class="form-row">
          <label class="settings-label">API Key</label>
          <input
            v-model="keyInput"
            class="settings-input"
            type="password"
            :placeholder="keyConfigured ? '已配置（输入新 key 可覆盖）' : '未配置'"
            autocomplete="off"
          />
        </div>
        <div class="form-row">
          <label class="settings-label">Rerank</label>
          <label class="settings-switch" :title="configForm.rerank.enabled ? '已开启（DashScope rerank）' : '已关闭'">
            <input type="checkbox" v-model="configForm.rerank.enabled" />
            <span class="settings-switch-slider"></span>
          </label>
        </div>
        <div class="form-row">
          <label class="settings-label">章节/全书摘要</label>
          <label class="settings-switch" :title="configForm.enhancements.summaryLayer ? '已开启（摄入/重建时生成摘要块）' : '已关闭'">
            <input type="checkbox" v-model="configForm.enhancements.summaryLayer" />
            <span class="settings-switch-slider"></span>
          </label>
        </div>
        <div class="form-row">
          <label class="settings-label">块定位前缀</label>
          <label class="settings-switch" :title="configForm.enhancements.contextualPrefix ? '已开启（摄入/重建时为切块生成定位前缀）' : '已关闭'">
            <input type="checkbox" v-model="configForm.enhancements.contextualPrefix" />
            <span class="settings-switch-slider"></span>
          </label>
        </div>
        <p class="settings-hint">
          增强开关（默认关）：摘要为每个章节/全书生成一个可检索的摘要块，命中时附下钻指引；定位前缀为每个切块生成一句上下文说明，提升嵌向量的辨识度。
          开启后摄入与重建索引会调用聊天模型生成上述内容，消耗聊天模型 token；开关变更后需重建索引才会生效（库卡片会出现"索引需重建"徽标）。
          当前为全局生效，逐库覆盖后续提供。
        </p>
        <div class="form-row">
          <label class="settings-label">Top K</label>
          <input v-model.number="configForm.retrieval.topK" class="settings-input narrow" type="number" min="1" />
        </div>
        <div class="form-row">
          <label class="settings-label">相似度阈值</label>
          <input v-model.number="configForm.retrieval.similarityThreshold" class="settings-input narrow" type="number" min="0" max="1" step="0.05" />
        </div>
        <div class="form-actions">
          <button class="settings-btn settings-btn-primary" @click="saveConfig" :disabled="savingConfig">
            {{ savingConfig ? '保存中...' : '保存配置' }}
          </button>
        </div>
      </div>
    </section>

    <!-- ============ 检索测试台 ============ -->
    <section class="settings-group">
      <div class="settings-group-head">
        <h3>检索测试台</h3>
      </div>
      <p class="settings-tip">
        输入问题实测检索命中与分数，走与 search_knowledge 工具相同的检索管线（消耗 1 次 embedding 调用，rerank 开启时另有 1 次 rerank 调用）。
      </p>
      <div class="search-form">
        <input
          v-model="testQuery"
          class="settings-input"
          type="text"
          placeholder="输入测试问题，回车或点击按钮检索..."
          @keyup.enter="runTestSearch"
        />
        <select v-model="testKb" class="settings-input search-kb-select" title="限定检索的库；默认检索全部库">
          <option value="">全部库</option>
          <option v-for="kb in kbs" :key="kb.name" :value="kb.name">{{ kb.name }}</option>
        </select>
        <button class="settings-btn settings-btn-primary" @click="runTestSearch" :disabled="testSearching">
          {{ testSearching ? '检索中...' : '测试检索' }}
        </button>
      </div>

      <!-- core 抛出的中文错误（如 embedding key 未配置）原样展示 -->
      <div v-if="testError" class="settings-notice settings-notice-error">{{ testError }}</div>
      <div v-else-if="testSearched && testHits.length === 0" class="settings-empty small">
        <p class="settings-empty-title">无命中结果</p>
        <p class="settings-empty-hint">可尝试降低相似度阈值，或确认库内文档已摄入且索引健康</p>
      </div>

      <div v-if="testHits.length > 0" class="hit-list">
        <div v-for="(hit, i) in testHits" :key="i" class="settings-card hit-row">
          <div class="hit-head">
            <span
              class="settings-badge"
              :class="hit.kind === 'summary' ? 'settings-badge-accent' : 'settings-badge-neutral'"
              :title="hit.kind === 'summary' ? '摘要块命中：content 为摘要 + 下钻指引' : '普通内容块命中'"
            >{{ hit.kind === 'summary' ? '摘要' : '内容' }}</span>
            <span class="hit-score">score {{ hit.score.toFixed(3) }}</span>
            <button class="settings-btn" @click="toggleHit(i)">{{ hit.expanded ? '收起' : '展开全文' }}</button>
          </div>
          <p class="hit-meta">{{ hit.kb }} / {{ hit.docId }}<span v-if="hit.headingPath"> / {{ hit.headingPath }}</span></p>
          <p class="hit-preview">{{ hit.expanded ? hit.content : previewOf(hit.content) }}</p>
        </div>
      </div>
    </section>

    <!-- 文档正本查看弹层 -->
    <div v-if="viewingDoc" class="doc-modal" @click="viewingDoc = null">
      <div class="doc-modal-content" @click.stop>
        <div class="doc-modal-header">
          <h4>{{ viewingDoc.title }}</h4>
          <button class="settings-btn" @click="viewingDoc = null">关闭</button>
        </div>
        <div class="doc-modal-body"><MessageMarkdown :content="viewingDoc.body" /></div>
      </div>
    </div>

    <!-- 统一确认弹窗（删库/删文档/重建索引共用） -->
    <ConfirmDialog
      :is-open="confirmState.open"
      :title="confirmState.title"
      :message="confirmState.message"
      @confirm="runConfirmAction"
      @cancel="confirmState.open = false"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import {
  knowledgeStore,
  ingestDocument,
  ingestPdf,
  ingestOffice,
  ingestImage,
  officeExtOf,
  imageMimeOf,
  removeDocument,
  rebuildIndex,
  searchKnowledge,
  base64ToBytes,
  SecureStorageService,
  EMBEDDING_KEY_PROVIDER,
} from '@assistant-ai/core'
import type { KnowledgeBaseConfig, KnowledgeGlobalConfig, KnowledgeSearchResult, DocType } from '@assistant-ai/core'
import { getHostAPI } from '../../host/hostApi'
import ConfirmDialog from '../ConfirmDialog.vue'
import MessageMarkdown from '../MessageMarkdown.vue'

interface DocRow {
  docId: string
  title: string
  sourcePath: string
  type: DocType
  createdAt: string
  chunkCount: number
}

const kbs = ref<KnowledgeBaseConfig[]>([])
const docCounts = ref<Record<string, number>>({})
const indexHealth = ref<Record<string, boolean>>({})
const selectedKb = ref<string | null>(null)
const docs = ref<DocRow[]>([])
const loading = ref(false)
const notice = ref<{ type: 'error' | 'success' | 'info'; text: string } | null>(null)

// 新建库表单
const showCreateForm = ref(false)
const newKbName = ref('')
const newKbDesc = ref('')

// 摄入状态
const ingesting = ref(false)
const ingestProgress = ref('')
const ingestSummary = ref<{ text: string; failed: number } | null>(null)

// 粘贴沉淀表单
const distillTitle = ref('')
const distillContent = ref('')
const distilling = ref(false)

// 配置区（含二期 enhancements 增强开关，随"保存配置"整体写入 knowledge.json）
const configForm = ref<KnowledgeGlobalConfig>({
  embedding: { provider: '', baseURL: '', model: '', dimensions: 1024 },
  rerank: { enabled: true },
  retrieval: { topK: 5, similarityThreshold: 0.5, childChunkSize: 300, parentChunkSize: 1200 },
  enhancements: { summaryLayer: false, contextualPrefix: false },
})
const keyInput = ref('')
const keyConfigured = ref(false)
const savingConfig = ref(false)

// 重建进度
const rebuildingKb = ref<string | null>(null)

// 检索测试台
interface TestHit extends KnowledgeSearchResult {
  expanded: boolean
}
const testQuery = ref('')
const testKb = ref('')
const testSearching = ref(false)
const testSearched = ref(false)
const testError = ref<string | null>(null)
const testHits = ref<TestHit[]>([])

// 正本查看弹层
const viewingDoc = ref<{ title: string; body: string } | null>(null)

// 统一确认弹窗
const confirmState = ref<{ open: boolean; title: string; message: string; action: (() => Promise<void>) | null }>({
  open: false,
  title: '',
  message: '',
  action: null,
})

function showError(err: unknown, fallback: string): void {
  // core 抛出的已是面向用户的中文错误，原样展示
  notice.value = { type: 'error', text: err instanceof Error ? err.message : fallback }
}

function showSuccess(text: string): void {
  notice.value = { type: 'success', text }
}

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p
}

/** 文档标题：沉淀/内联文档取 sourcePath 前缀后的标题，文件取文件名 */
function docTitle(sourcePath: string, docId: string): string {
  if (sourcePath.startsWith('distilled:')) return sourcePath.slice('distilled:'.length)
  if (sourcePath.startsWith('inline:')) return sourcePath.slice('inline:'.length)
  return sourcePath ? baseName(sourcePath) : docId
}

function docTypeLabel(type: DocType): string {
  return type === 'pdf' ? 'PDF' : type === 'office' ? 'Office' : type === 'image' ? '图片' : type === 'distilled' ? '沉淀' : '笔记'
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

async function loadAll(): Promise<void> {
  loading.value = true
  notice.value = null
  try {
    kbs.value = await knowledgeStore.listKnowledgeBases()
    const counts: Record<string, number> = {}
    const health: Record<string, boolean> = {}
    for (const kb of kbs.value) {
      counts[kb.name] = (await knowledgeStore.listDocs(kb.name)).length
      health[kb.name] = await knowledgeStore.isIndexEmbeddingCurrent(kb.name)
    }
    docCounts.value = counts
    indexHealth.value = health
    if (selectedKb.value && !kbs.value.some(k => k.name === selectedKb.value)) {
      selectedKb.value = null
      docs.value = []
    } else if (selectedKb.value) {
      await loadDocs(selectedKb.value)
    }
  } catch (err) {
    showError(err, '加载知识库列表失败')
  } finally {
    loading.value = false
  }
}

async function selectKb(name: string): Promise<void> {
  selectedKb.value = name
  ingestSummary.value = null
  await loadDocs(name)
}

/** 文档列表：正本 frontmatter 提供标题/类型/时间，chunk 数从 readIndex 统计 */
async function loadDocs(kbName: string): Promise<void> {
  try {
    const docIds = await knowledgeStore.listDocs(kbName)
    const index = await knowledgeStore.readIndex(kbName)
    const rows: DocRow[] = []
    for (const docId of docIds) {
      const doc = await knowledgeStore.readDoc(kbName, docId)
      rows.push({
        docId,
        title: docTitle(doc?.frontmatter.sourcePath ?? '', docId),
        sourcePath: doc?.frontmatter.sourcePath ?? '',
        type: doc?.frontmatter.type ?? 'note',
        createdAt: doc?.frontmatter.createdAt ?? '',
        chunkCount: (index?.chunks ?? []).filter(c => c.docId === docId).length,
      })
    }
    docs.value = rows
  } catch (err) {
    showError(err, '加载文档列表失败')
  }
}

async function createKb(): Promise<void> {
  const name = newKbName.value.trim()
  if (!name) {
    notice.value = { type: 'error', text: '库名称不能为空' }
    return
  }
  loading.value = true
  notice.value = null
  try {
    const result = await knowledgeStore.createKnowledgeBase(name, newKbDesc.value.trim())
    if (!result.success) {
      notice.value = { type: 'error', text: result.error || '创建知识库失败' }
      return
    }
    newKbName.value = ''
    newKbDesc.value = ''
    showCreateForm.value = false
    showSuccess(`已创建知识库「${name}」`)
    await loadAll()
    await selectKb(name)
  } catch (err) {
    showError(err, '创建知识库失败')
  } finally {
    loading.value = false
  }
}

function askDeleteKb(name: string): void {
  confirmState.value = {
    open: true,
    title: '删除知识库',
    message: `确定要删除知识库「${name}」吗？库内全部文档正本与向量索引将一并删除，不可恢复。`,
    action: async () => {
      const result = await knowledgeStore.deleteKnowledgeBase(name)
      if (!result.success) throw new Error(result.error || '删除知识库失败')
      showSuccess(`已删除知识库「${name}」`)
      await loadAll()
    },
  }
}

function askDeleteDoc(docId: string, title: string): void {
  if (!selectedKb.value) return
  const kb = selectedKb.value
  confirmState.value = {
    open: true,
    title: '删除文档',
    message: `确定要从「${kb}」删除文档「${title}」吗？文档正本与其索引切块将一并删除。`,
    action: async () => {
      const result = await removeDocument(kb, docId)
      if (!result.success) throw new Error(result.error || '删除文档失败')
      showSuccess(`已删除文档「${title}」（清理 ${result.removedChunks} 个索引切块）`)
      await loadAll()
    },
  }
}

function askRebuild(name: string): void {
  confirmState.value = {
    open: true,
    title: '重建索引',
    message: `将为知识库「${name}」按当前 embedding 配置重新切块并嵌向量，会消耗 embedding API 额度。`
      + '若当前开启了增强（章节/全书摘要、块定位前缀），重建还会逐文档调用聊天模型重新生成摘要/定位前缀，产生额外 token 成本。'
      + '旧索引在全部重建成功后才会被替换。确定继续吗？',
    action: async () => {
      rebuildingKb.value = name
      try {
        const result = await rebuildIndex(name)
        showSuccess(`「${name}」索引重建完成：${result.docCount} 篇文档、${result.chunkCount} 个切块（嵌向量 ${result.childCount} 条）`)
        await loadAll()
      } finally {
        rebuildingKb.value = null
      }
    },
  }
}

async function runConfirmAction(): Promise<void> {
  const action = confirmState.value.action
  confirmState.value.open = false
  confirmState.value.action = null
  if (!action) return
  notice.value = null
  try {
    await action()
  } catch (err) {
    showError(err, '操作失败')
  }
}

async function viewDoc(docId: string): Promise<void> {
  if (!selectedKb.value) return
  try {
    const doc = await knowledgeStore.readDoc(selectedKb.value, docId)
    if (!doc) {
      notice.value = { type: 'error', text: `文档正本不存在或已损坏: ${docId}` }
      return
    }
    viewingDoc.value = { title: docTitle(doc.frontmatter.sourcePath, docId), body: doc.body }
  } catch (err) {
    showError(err, '读取文档失败')
  }
}

/** 添加文件：showOpenDialog 多选 → 逐文件摄入（pdf 走 base64 + ingestPdf，md/txt 走文本 + ingestDocument） */
async function addFiles(): Promise<void> {
  if (!selectedKb.value || ingesting.value) return
  const kb = selectedKb.value
  let paths: string[] = []
  try {
    const resp = await getHostAPI().showOpenDialog({
      title: '选择要摄入的文档',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '文档 (md/txt/pdf/office/图片)', extensions: ['md', 'txt', 'pdf', 'docx', 'xlsx', 'pptx', 'png', 'jpg', 'jpeg'] }],
    })
    paths = resp?.success && !resp.result?.canceled ? resp.result?.filePaths ?? [] : []
  } catch (err) {
    showError(err, '打开文件选择框失败')
    return
  }
  if (paths.length === 0) return

  ingesting.value = true
  ingestSummary.value = null
  notice.value = null
  let ok = 0
  let skipped = 0
  let failed = 0
  const failures: string[] = []
  try {
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i]
      ingestProgress.value = `正在摄入第 ${i + 1}/${paths.length} 个：${baseName(p)}`
      try {
        let result
        if (p.toLowerCase().endsWith('.pdf')) {
          const read = await getHostAPI().fileReadBase64(p)
          if (!read?.success || !read.base64) throw new Error(`读取文件失败: ${read?.error || '未知错误'}`)
          result = await ingestPdf(kb, base64ToBytes(read.base64), p)
        } else if (officeExtOf(p)) {
          const read = await getHostAPI().fileReadBase64(p)
          if (!read?.success || !read.base64) throw new Error(`读取文件失败: ${read?.error || '未知错误'}`)
          result = await ingestOffice(kb, base64ToBytes(read.base64), p)
        } else if (imageMimeOf(p)) {
          const read = await getHostAPI().fileReadBase64(p)
          if (!read?.success || !read.base64) throw new Error(`读取文件失败: ${read?.error || '未知错误'}`)
          result = await ingestImage(kb, base64ToBytes(read.base64), p)
        } else {
          const read = await getHostAPI().fileRead(p)
          if (!read?.success || typeof read.content !== 'string') throw new Error(`读取文件失败: ${read?.error || '未知错误'}`)
          result = await ingestDocument(kb, p, read.content, 'note')
        }
        if (result.status === 'skipped') skipped++
        else ok++
      } catch (err) {
        failed++
        failures.push(`${baseName(p)}：${err instanceof Error ? err.message : '摄入失败'}`)
      }
    }
  } finally {
    ingesting.value = false
    ingestProgress.value = ''
  }
  const summary = `摄入完成：成功 ${ok} 个，跳过 ${skipped} 个（内容未变化），失败 ${failed} 个`
  ingestSummary.value = {
    failed,
    text: failures.length > 0 ? `${summary}\n${failures.join('\n')}` : summary,
  }
  await loadAll()
}

/** 检索测试台：调 core searchKnowledge（与 search_knowledge 工具同管线），错误原文展示 */
async function runTestSearch(): Promise<void> {
  const q = testQuery.value.trim()
  if (!q) {
    testError.value = '请输入测试问题'
    return
  }
  if (testSearching.value) return
  testSearching.value = true
  testError.value = null
  try {
    const hits = await searchKnowledge(q, testKb.value || undefined)
    testHits.value = hits.map(h => ({ ...h, expanded: false }))
    testSearched.value = true
  } catch (err) {
    testHits.value = []
    testSearched.value = false
    testError.value = err instanceof Error ? err.message : '检索失败'
  } finally {
    testSearching.value = false
  }
}

function toggleHit(i: number): void {
  const hit = testHits.value[i]
  if (hit) hit.expanded = !hit.expanded
}

function previewOf(content: string): string {
  const oneLine = content.replace(/\s+/g, ' ').trim()
  return oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine
}

async function submitDistill(): Promise<void> {
  if (!selectedKb.value || distilling.value) return
  const title = distillTitle.value.trim()
  const content = distillContent.value.trim()
  if (!title || !content) {
    notice.value = { type: 'error', text: '沉淀的标题与内容均不能为空' }
    return
  }
  distilling.value = true
  notice.value = null
  try {
    const result = await ingestDocument(selectedKb.value, `distilled:${title}`, content, 'distilled')
    showSuccess(
      result.status === 'skipped'
        ? `「${title}」内容未变化，已跳过（docId: ${result.docId}）`
        : `已把「${title}」沉淀到「${selectedKb.value}」（docId: ${result.docId}）`
    )
    distillTitle.value = ''
    distillContent.value = ''
    await loadAll()
  } catch (err) {
    showError(err, '沉淀入库失败')
  } finally {
    distilling.value = false
  }
}

async function loadConfig(): Promise<void> {
  try {
    configForm.value = await knowledgeStore.getGlobalConfig()
  } catch (err) {
    showError(err, '读取知识库配置失败')
  }
  try {
    keyConfigured.value = await SecureStorageService.hasApiKey(EMBEDDING_KEY_PROVIDER)
  } catch {
    keyConfigured.value = false
  }
}

async function saveConfig(): Promise<void> {
  savingConfig.value = true
  notice.value = null
  try {
    const result = await knowledgeStore.saveGlobalConfig(configForm.value)
    if (!result.success) {
      notice.value = { type: 'error', text: result.error || '保存配置失败' }
      return
    }
    // key 只在用户输入了新值时写入安全存储，界面永不回显明文
    const newKey = keyInput.value.trim()
    if (newKey) {
      await SecureStorageService.storeApiKey(EMBEDDING_KEY_PROVIDER, newKey)
      keyInput.value = ''
    }
    keyConfigured.value = await SecureStorageService.hasApiKey(EMBEDDING_KEY_PROVIDER)
    showSuccess('配置已保存')
    // 模型/维度变化会影响索引健康判定，重新加载
    await loadAll()
  } catch (err) {
    showError(err, '保存配置失败')
  } finally {
    savingConfig.value = false
  }
}

onMounted(async () => {
  await loadConfig()
  await loadAll()
})
</script>

<style scoped>
/* 视觉规格全部来自契约层 settings.css（settings-page/header/group/card/badge/btn/input/switch/empty/notice）；
   此处只保留页内结构性布局 */

.create-form {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
}

/* 窄输入（维度/TopK 等短数字列）：布局修饰，视觉仍走契约 */
.settings-input.narrow {
  flex: 0 0 120px;
}

.settings-empty.small {
  padding: 16px 0;
}

.kb-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.kb-card {
  cursor: pointer;
}

.kb-card.selected {
  border-color: var(--primary-color);
  box-shadow: 0 0 0 1px var(--primary-color);
}

.kb-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.kb-name-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.kb-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.kb-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.kb-desc {
  font-size: 12px;
  color: var(--text-secondary, #64748b);
  margin: 6px 0 0;
  line-height: 1.5;
}

.doc-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.doc-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.doc-main {
  min-width: 0;
}

.doc-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.doc-title {
  font-size: var(--font-size-base);
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.doc-meta {
  font-size: 11px;
  color: var(--text-tertiary, #94a3b8);
  margin: 4px 0 0;
  font-family: var(--font-mono, monospace);
}

.doc-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.progress-text {
  font-size: 13px;
  color: var(--primary-color, #2563eb);
  margin: 0 0 12px;
}

.distill-form {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.form-actions {
  display: flex;
  justify-content: flex-end;
}

.config-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 560px;
}

/* 检索测试台 */
.search-form {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.search-kb-select {
  flex: 0 0 160px;
}

.hit-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.hit-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.hit-head .settings-btn {
  margin-left: auto;
}

.hit-score {
  font-size: 12px;
  color: var(--text-secondary, #64748b);
  font-family: var(--font-mono, monospace);
}

.hit-meta {
  font-size: 11px;
  color: var(--text-tertiary, #94a3b8);
  margin: 6px 0 0;
  font-family: var(--font-mono, monospace);
  word-break: break-all;
}

.hit-preview {
  font-size: 13px;
  color: var(--text-primary, #1e293b);
  margin: 6px 0 0;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.form-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* 行内标签列宽（布局修饰，视觉走契约 settings-label） */
.form-row .settings-label {
  flex: 0 0 96px;
  margin-bottom: 0;
}

.doc-modal {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.doc-modal-content {
  background: var(--background-primary, #fff);
  border-radius: 10px;
  width: 720px;
  max-width: 90vw;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow-lg, 0 8px 30px rgba(0, 0, 0, 0.2));
}

.doc-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  border-bottom: 1px solid var(--border-color, #e2e8f0);
}

.doc-modal-header h4 {
  margin: 0;
  font-size: 15px;
  color: var(--text-primary, #1e293b);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 文档正本经 MessageMarkdown 渲染：不再 pre-wrap（换行由 markdown 渲染承担） */
.doc-modal-body {
  margin: 0;
  padding: 16px 20px;
  overflow: auto;
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-primary, #1e293b);
  word-break: break-word;
}
</style>
