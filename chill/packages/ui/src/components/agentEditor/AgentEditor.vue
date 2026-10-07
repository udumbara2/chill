<template>
  <div class="agent-editor">
    <!-- 首屏：最小必填集（名称/标识/描述/提示词） -->
    <section class="ae-section">
      <div class="ae-field">
        <label class="ae-label">名称 <span class="ae-req">*</span></label>
        <input
          class="ae-input"
          v-model="name"
          placeholder="给 Agent 起个名字，如：代码评审员"
          :disabled="readonlyMode"
        />
      </div>
      <div class="ae-field">
        <label class="ae-label">
          标识
          <span class="ae-tag" v-if="!slugTouched">自动派生</span>
          <span class="ae-tag ae-tag-touched" v-else>手动</span>
        </label>
        <input
          class="ae-input"
          :class="{ 'ae-input-error': slugError }"
          v-model="slug"
          placeholder="code-reviewer"
          :disabled="readonlyMode"
          @input="slugTouched = true"
        />
        <div class="ae-error" v-if="slugError">{{ slugError }}</div>
        <div class="ae-warn" v-else-if="slugHint">{{ slugHint }}</div>
        <div class="ae-warn" v-if="overwriteHint">{{ overwriteHint }}</div>
      </div>
      <div class="ae-field">
        <label class="ae-label">描述 <span class="ae-req">*</span></label>
        <input
          class="ae-input"
          v-model="description"
          placeholder="一句话说明它擅长什么、何时该用它——这决定它能否被正确调用"
          :disabled="readonlyMode"
        />
      </div>
      <div class="ae-field">
        <label class="ae-label">提示词 <span class="ae-req">*</span></label>
        <textarea
          class="ae-textarea"
          v-model="systemPrompt"
          rows="8"
          placeholder="你是…。你的职责是…。输出要求…"
          :disabled="readonlyMode"
        ></textarea>
      </div>
    </section>

    <!-- 更多配置：手风琴（一次只展开一组，组标题带当前值摘要） -->
    <section class="ae-section">
      <div class="ae-accordion-head" @click="toggleAccordion('__none')">
        <span>更多配置</span>
        <span class="ae-dim">{{ anyAdvancedSet ? '已自定义' : '全部默认' }}</span>
      </div>

      <!-- 模型 -->
      <div class="ae-acc-item">
        <div class="ae-acc-title" @click="toggleAccordion('model')">
          <span>{{ openGroup === 'model' ? '▾' : '▸' }} 模型</span>
          <span class="ae-dim">{{ model || '跟随会话' }}</span>
        </div>
        <div class="ae-acc-body" v-show="openGroup === 'model'">
          <select class="ae-input" v-model="model" :disabled="readonlyMode">
            <option value="">跟随会话（默认）</option>
            <option v-for="m in availableModels" :key="m.name" :value="m.name">{{ m.displayName || m.name }}</option>
          </select>
          <div class="ae-hint">不指定 = 跟随你当前选用的模型</div>
        </div>
      </div>

      <!-- 权限 -->
      <div class="ae-acc-item">
        <div class="ae-acc-title" @click="toggleAccordion('perm')">
          <span>{{ openGroup === 'perm' ? '▾' : '▸' }} 工具</span>
          <span class="ae-dim">{{ permSummary }}</span>
        </div>
        <div class="ae-acc-body" v-show="openGroup === 'perm'">
          <label class="ae-radio"><input type="radio" value="none" v-model="permMode" :disabled="readonlyMode" /> 不使用任何工具（默认）</label>
          <label class="ae-radio"><input type="radio" value="all" v-model="permMode" :disabled="readonlyMode" /> 全部工具</label>
          <label class="ae-radio"><input type="radio" value="readonly" v-model="permMode" :disabled="readonlyMode" /> 只读（全部只读工具，修改性工具不可用）</label>
          <label class="ae-radio"><input type="radio" value="whitelist" v-model="permMode" :disabled="readonlyMode" /> 白名单（仅以下工具可用）</label>
          <div v-if="permMode === 'whitelist'" class="ae-tool-picker">
            <div class="ae-chips" v-if="whitelistTools.length">
              <span v-for="t in whitelistTools" :key="t" class="ae-chip">
                {{ t }}
                <button class="ae-chip-x" @click="removeTool(t)" :disabled="readonlyMode">×</button>
              </span>
            </div>
            <div v-for="group in toolGroups" :key="group.category" class="ae-tool-group">
              <div class="ae-tool-cat">{{ group.category }}</div>
              <label v-for="t in group.names" :key="t" class="ae-check">
                <input type="checkbox" :checked="whitelistTools.includes(t)" @change="toggleTool(t)" :disabled="readonlyMode" />
                {{ t }}
              </label>
            </div>
          </div>
        </div>
      </div>

      <!-- 技能 -->
      <div class="ae-acc-item">
        <div class="ae-acc-title" @click="toggleAccordion('skills')">
          <span>{{ openGroup === 'skills' ? '▾' : '▸' }} 技能</span>
          <span class="ae-dim">{{ selectedSkills.length ? `${selectedSkills.length} 项` : '未预载' }}</span>
        </div>
        <div class="ae-acc-body" v-show="openGroup === 'skills'">
          <SkillsPicker v-model="selectedSkills" :disabled="readonlyMode" />
        </div>
      </div>

      <!-- 知识库 -->
      <div class="ae-acc-item">
        <div class="ae-acc-title" @click="toggleAccordion('knowledge')">
          <span>{{ openGroup === 'knowledge' ? '▾' : '▸' }} 知识库</span>
          <span class="ae-dim">{{ selectedKnowledge.length ? `${selectedKnowledge.length} 个库` : '未绑定' }}</span>
        </div>
        <div class="ae-acc-body" v-show="openGroup === 'knowledge'">
          <KnowledgePicker v-model="selectedKnowledge" :disabled="readonlyMode" />
        </div>
      </div>

      <!-- 记忆 -->
      <div class="ae-acc-item">
        <div class="ae-acc-title" @click="toggleAccordion('memory')">
          <span>{{ openGroup === 'memory' ? '▾' : '▸' }} 记忆</span>
          <span class="ae-dim">{{ memoryLabel }}</span>
        </div>
        <div class="ae-acc-body" v-show="openGroup === 'memory'">
          <MemoryScopeSelect v-model="memory" :disabled="readonlyMode" />
        </div>
      </div>

      <!-- 参数 -->
      <div class="ae-acc-item">
        <div class="ae-acc-title" @click="toggleAccordion('params')">
          <span>{{ openGroup === 'params' ? '▾' : '▸' }} 参数</span>
          <span class="ae-dim">{{ paramsSummary }}</span>
        </div>
        <div class="ae-acc-body" v-show="openGroup === 'params'">
          <div class="ae-param-grid">
            <label>超时(秒)<input class="ae-input" type="number" min="1" v-model="paramTimeout" placeholder="600" :disabled="readonlyMode" /></label>
            <label>最大迭代<input class="ae-input" type="number" min="1" v-model="paramMaxIterations" placeholder="10" :disabled="readonlyMode" /></label>
            <label>温度<input class="ae-input" type="number" step="0.1" min="0" max="2" v-model="paramTemperature" placeholder="0.6" :disabled="readonlyMode" /></label>
            <label>最大输出 Token<input class="ae-input" type="number" min="1" v-model="paramMaxTokens" placeholder="4000" :disabled="readonlyMode" /></label>
            <label>Token 预算<input class="ae-input" type="number" min="1" v-model="paramTokenBudget" placeholder="200000" :disabled="readonlyMode" /></label>
          </div>
          <div class="ae-hint">留空 = 用系统默认</div>
        </div>
      </div>

      <!-- 存放 -->
      <div class="ae-acc-item">
        <div class="ae-acc-title" @click="toggleAccordion('storage')">
          <span>{{ openGroup === 'storage' ? '▾' : '▸' }} 存放</span>
          <span class="ae-dim">{{ storage === 'project' ? '项目共享' : '个人' }}</span>
        </div>
        <div class="ae-acc-body" v-show="openGroup === 'storage'">
          <label class="ae-radio"><input type="radio" value="user" v-model="storage" :disabled="readonlyMode" /> 个人（~/.chill/agents/templates/，仅你可用）</label>
          <label class="ae-radio" :class="{ 'ae-dim': !workDir }">
            <input type="radio" value="project" v-model="storage" :disabled="readonlyMode || !workDir" />
            项目共享（.agents/agents/，进项目目录可进 git 团队共享）
          </label>
          <div class="ae-hint" v-if="!workDir">未打开项目目录，项目共享不可用</div>
        </div>
      </div>
    </section>

    <!-- 模板文件预览（默认收起的披露区） -->
    <section class="ae-section">
      <div class="ae-accordion-head" @click="previewOpen = !previewOpen">
        <span>{{ previewOpen ? '▾' : '▸' }} 模板文件预览</span>
        <span class="ae-dim">保存后生成的就是这个 .md</span>
      </div>
      <pre v-show="previewOpen" class="ae-preview">{{ serializedMd }}</pre>
    </section>

    <!-- 保存栏 -->
    <div class="ae-savebar">
      <div class="ae-errors" v-if="validationErrors.length">
        <div v-for="(e, i) in validationErrors" :key="i" class="ae-error">{{ e }}</div>
      </div>
      <!-- 解析警告内联可见(归一化提示等,不阻断保存) -->
      <div class="ae-errors" v-if="previewWarnings.length">
        <div v-for="(w, i) in previewWarnings" :key="i" class="ae-warn">{{ w }}</div>
      </div>
      <div class="ae-savebar-actions">
        <button class="settings-btn" @click="$emit('cancel')">{{ readonlyMode ? '返回' : '取消' }}</button>
        <button v-if="readonlyMode" class="settings-btn settings-btn-primary" @click="$emit('fork')">另存为我的副本</button>
        <button v-else class="settings-btn settings-btn-primary" :disabled="!canSave || saving" @click="onSave">
          {{ saving ? '保存中…' : '保存 Agent' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import {
  serializeTemplate,
  parseTemplate,
  validateSubagentType,
  modelInfoService,
  type SubagentTemplate,
} from '@assistant-ai/core'
import SkillsPicker from '../agentConfig/SkillsPicker.vue'
import KnowledgePicker from '../agentConfig/KnowledgePicker.vue'
import MemoryScopeSelect from '../agentConfig/MemoryScopeSelect.vue'
import { useToolCatalog } from '../agentConfig/toolCatalog'

interface Props {
  mode: 'create' | 'edit'
  initialTemplate?: SubagentTemplate
  /** 内置模板只读模式（显示横幅 + 另存为） */
  readonlyMode?: boolean
  /** 既有模板标识集合（覆盖提示用：slug → 级别文案） */
  existingSlugs?: Record<string, string>
  workDir?: string
}

const props = withDefaults(defineProps<Props>(), {
  readonlyMode: false,
  existingSlugs: () => ({}),
  workDir: undefined,
})

const emit = defineEmits<{
  (e: 'save', payload: { slug: string; storage: 'user' | 'project'; content: string; renameFrom?: string }): void
  (e: 'cancel'): void
  (e: 'fork'): void
}>()

// ---------- 首屏字段 ----------
const name = ref(props.initialTemplate?.name ?? '')
const slug = ref(props.initialTemplate?.subagent_type ?? '')
const slugTouched = ref(!!props.initialTemplate)
const description = ref(props.initialTemplate?.description ?? '')
const systemPrompt = ref(props.initialTemplate?.system_prompt ?? '')

// ---------- 更多配置 ----------
const model = ref(props.initialTemplate?.model ?? '')
// 权限四态(与 toolPolicy.ts 语义格一致:省略=零工具 / [all]=全部 / readonly=[all]+只读约束 / 白名单)
const initTools = props.initialTemplate?.tools ?? []
const permMode = ref<'none' | 'all' | 'readonly' | 'whitelist'>(
  props.initialTemplate?.readonly
    ? 'readonly'
    : initTools.includes('all')
      ? 'all'
      : initTools.length
        ? 'whitelist'
        : 'none'
)
const whitelistTools = ref<string[]>(initTools.filter((t) => t !== 'all'))
const selectedSkills = ref<string[]>([...(props.initialTemplate?.skills ?? [])])
const selectedKnowledge = ref<string[]>([...(props.initialTemplate?.knowledge ?? [])])
const memory = ref(props.initialTemplate?.memory ?? '')
const paramTimeout = ref(props.initialTemplate?.default_parameters?.timeout?.toString() ?? '')
const paramMaxIterations = ref(props.initialTemplate?.default_parameters?.max_iterations?.toString() ?? '')
const paramTemperature = ref(props.initialTemplate?.default_parameters?.temperature?.toString() ?? '')
const paramMaxTokens = ref(props.initialTemplate?.default_parameters?.maxTokens?.toString() ?? '')
const paramTokenBudget = ref(props.initialTemplate?.default_parameters?.token_budget?.toString() ?? '')
const storage = ref<'user' | 'project'>('user')
const previewOpen = ref(false)
const openGroup = ref<string>('')
const saving = ref(false)

// ---------- 数据源 ----------
const availableModels = computed(() => modelInfoService.getAllModelInfos())
// 工具目录与共享 picker 数据源收敛到 agentConfig(与 ModelNode 同一数据源)
const { toolGroups } = useToolCatalog()

// ---------- 派生标识 ----------
function latinSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
}
watch(name, (v) => {
  if (!slugTouched.value) slug.value = latinSlug(v)
})

// ---------- 手风琴 ----------
function toggleAccordion(group: string): void {
  openGroup.value = openGroup.value === group ? '' : group
}

// ---------- 选择器操作 ----------
function toggleTool(t: string): void {
  const i = whitelistTools.value.indexOf(t)
  if (i >= 0) whitelistTools.value.splice(i, 1)
  else whitelistTools.value.push(t)
}
function removeTool(t: string): void {
  whitelistTools.value = whitelistTools.value.filter((x) => x !== t)
}

// ---------- 摘要 ----------
const permSummary = computed(() =>
  permMode.value === 'readonly'
    ? '只读'
    : permMode.value === 'whitelist'
      ? `白名单(${whitelistTools.value.length} 项)`
      : permMode.value === 'all'
        ? '全部工具'
        : '不使用工具'
)
const memoryLabel = computed(() => memory.value || '无')
const paramsSummary = computed(() =>
  paramTimeout.value || paramMaxIterations.value || paramTemperature.value || paramMaxTokens.value || paramTokenBudget.value
    ? '已自定义'
    : '默认'
)
const anyAdvancedSet = computed(
  () =>
    model.value !== '' ||
    permMode.value !== 'none' ||
    selectedSkills.value.length > 0 ||
    selectedKnowledge.value.length > 0 ||
    memory.value !== '' ||
    paramsSummary.value === '已自定义' ||
    storage.value !== 'user'
)

// ---------- 模板对象与序列化 ----------
function toPositiveInt(raw: string): number | undefined {
  const n = Number(raw)
  return raw.trim() !== '' && Number.isInteger(n) && n > 0 ? n : undefined
}
function toNumber(raw: string): number | undefined {
  const n = Number(raw)
  return raw.trim() !== '' && !Number.isNaN(n) ? n : undefined
}

const templateObject = computed<SubagentTemplate>(() => {
  const defaultParameters: Record<string, number> = {}
  const timeout = toPositiveInt(paramTimeout.value)
  const maxIterations = toPositiveInt(paramMaxIterations.value)
  const temperature = toNumber(paramTemperature.value)
  const maxTokens = toPositiveInt(paramMaxTokens.value)
  const tokenBudget = toPositiveInt(paramTokenBudget.value)
  if (timeout) defaultParameters.timeout = timeout
  if (maxIterations) defaultParameters.max_iterations = maxIterations
  if (temperature !== undefined) defaultParameters.temperature = temperature
  if (maxTokens) defaultParameters.maxTokens = maxTokens
  if (tokenBudget) defaultParameters.token_budget = tokenBudget

  return {
    name: name.value.trim(),
    subagent_type: slug.value.trim(),
    description: description.value.trim(),
    system_prompt: systemPrompt.value,
    ...(model.value ? { model: model.value } : {}),
    ...(permMode.value === 'readonly' ? { readonly: true, tools: ['all'] } : {}),
    ...(permMode.value === 'all' ? { tools: ['all'] } : {}),
    ...(permMode.value === 'whitelist' && whitelistTools.value.length ? { tools: [...whitelistTools.value] } : {}),
    ...(selectedSkills.value.length ? { skills: [...selectedSkills.value] } : {}),
    ...(selectedKnowledge.value.length ? { knowledge: [...selectedKnowledge.value] } : {}),
    ...(memory.value ? { memory: memory.value as SubagentTemplate['memory'] } : {}),
    ...(Object.keys(defaultParameters).length ? { default_parameters: defaultParameters } : {}),
  } as SubagentTemplate
})

const serializedMd = computed(() => serializeTemplate(templateObject.value))

// ---------- 校验 ----------
// 红错只给真正的非法输入(格式错误 / 用户清空);中文名派生不出标识是中性提示,不是错误
const slugError = computed(() => {
  const s = slug.value.trim()
  if (!s) return slugTouched.value ? '标识不能为空' : ''
  if (!validateSubagentType(s)) return '标识只能包含小写字母、数字和连字符'
  return ''
})
const slugHint = computed(() => {
  if (slug.value.trim() || slugError.value) return ''
  return name.value.trim() ? '中文名无法自动派生标识，请手动输入英文标识（小写字母/数字/连字符）' : ''
})
const overwriteHint = computed(() => {
  const hit = props.existingSlugs[slug.value.trim()]
  return hit ? `将覆盖${hit}模板「${slug.value.trim()}」` : ''
})
const validationErrors = computed(() => {
  const errors: string[] = []
  if (!name.value.trim()) errors.push('名称必填')
  if (!description.value.trim()) errors.push('描述必填（一句话说明擅长什么、何时该用）')
  if (!systemPrompt.value.trim()) errors.push('提示词必填')
  if (slugError.value) errors.push(slugError.value)
  else if (!slug.value.trim()) errors.push('标识不能为空（中文名请手动输入英文标识）')
  if (permMode.value === 'whitelist' && whitelistTools.value.length === 0) errors.push('白名单模式请至少选择一个工具')
  // 与加载器同一校验源兜底
  if (errors.length === 0) {
    const r = parseTemplate(serializedMd.value)
    if (!r.success) errors.push(r.error || '模板内容不合法')
  }
  return errors
})
const canSave = computed(() => validationErrors.value.length === 0)

/** 预览序列化的解析警告(与加载器同一校验源;归一化提示不阻断保存) */
const previewWarnings = computed(() => {
  if (validationErrors.value.length > 0) return []
  const r = parseTemplate(serializedMd.value)
  return r.warnings ?? []
})

// ---------- 保存 ----------
async function onSave(): Promise<void> {
  if (!canSave.value || saving.value) return
  saving.value = true
  try {
    const renameFrom =
      props.mode === 'edit' && props.initialTemplate && props.initialTemplate.subagent_type !== slug.value.trim()
        ? props.initialTemplate.subagent_type
        : undefined
    emit('save', {
      slug: slug.value.trim(),
      storage: storage.value,
      content: serializedMd.value,
      renameFrom,
    })
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.agent-editor {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  max-width: 720px;
}
.ae-section {
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
}
.ae-field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.ae-label {
  font-size: 0.8125rem;
  font-weight: 600;
  color: #1f2937;
  display: flex;
  align-items: center;
  gap: 0.375rem;
}
.ae-req {
  color: #ef4444;
}
.ae-tag {
  font-size: 0.625rem;
  font-weight: 500;
  padding: 0 0.375rem;
  border-radius: 9999px;
  background: rgba(139, 92, 246, 0.1);
  color: #8b5cf6;
}
.ae-tag-touched {
  background: rgba(107, 114, 128, 0.12);
  color: #6b7280;
}
.ae-input {
  width: 100%;
  padding: 0.5rem 0.625rem;
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 6px;
  font-size: 0.8125rem;
  background: #fff;
  color: #1f2937;
  box-sizing: border-box;
}
.ae-input:focus {
  outline: none;
  border-color: #8b5cf6;
}
.ae-input-error {
  border-color: #ef4444;
}
.ae-textarea {
  width: 100%;
  padding: 0.5rem 0.625rem;
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 6px;
  font-size: 0.8125rem;
  font-family: inherit;
  line-height: 1.6;
  resize: vertical;
  box-sizing: border-box;
}
.ae-textarea:focus {
  outline: none;
  border-color: #8b5cf6;
}
.ae-accordion-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.5rem 0;
  font-size: 0.8125rem;
  font-weight: 600;
  color: #1f2937;
  cursor: pointer;
  user-select: none;
  border-top: 1px solid var(--border-color, #e5e7eb);
}
.ae-acc-item {
  border-top: 1px solid rgba(229, 231, 235, 0.6);
}
.ae-acc-title {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.4375rem 0;
  font-size: 0.8125rem;
  color: #374151;
  cursor: pointer;
  user-select: none;
}
.ae-acc-body {
  padding: 0.25rem 0 0.625rem 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}
.ae-dim {
  font-size: 0.75rem;
  font-weight: 400;
  color: #9ca3af;
}
.ae-hint {
  font-size: 0.6875rem;
  color: #9ca3af;
}
.ae-radio {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.8125rem;
  color: #374151;
}
.ae-check {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.75rem;
  color: #374151;
  margin-right: 0.75rem;
}
.ae-check-block {
  display: flex;
  align-items: baseline;
  gap: 0.375rem;
}
.ae-check-name {
  font-weight: 500;
  color: #1f2937;
}
.ae-tool-picker {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-top: 0.375rem;
}
.ae-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
}
.ae-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.6875rem;
  padding: 0.125rem 0.5rem;
  border-radius: 9999px;
  background: rgba(139, 92, 246, 0.1);
  color: #8b5cf6;
}
.ae-chip-x {
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 0.75rem;
  padding: 0;
  line-height: 1;
}
.ae-tool-group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
}
.ae-tool-cat {
  width: 100%;
  font-size: 0.6875rem;
  font-weight: 600;
  color: #6b7280;
  margin-bottom: 0.125rem;
}
.ae-param-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 0.5rem;
}
.ae-param-grid label {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.75rem;
  color: #6b7280;
}
.ae-preview {
  background: rgba(17, 24, 39, 0.95);
  border-radius: 6px;
  padding: 0.75rem;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 0.75rem;
  line-height: 1.5;
  color: #e5e7eb;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 320px;
  overflow-y: auto;
  margin: 0;
}
.ae-savebar {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  border-top: 1px solid var(--border-color, #e5e7eb);
  padding-top: 0.75rem;
}
.ae-savebar-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}
.ae-error {
  font-size: 0.75rem;
  color: #ef4444;
}
.ae-warn {
  font-size: 0.75rem;
  color: #d97706;
}
</style>
