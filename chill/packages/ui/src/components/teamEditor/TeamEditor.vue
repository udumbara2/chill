<template>
  <div class="te-root">
    <!-- 首屏必填 -->
    <div class="te-field">
      <label class="te-label">名称 <span class="te-req">*</span></label>
      <input class="te-input" v-model="name" placeholder="如:热点团队" :disabled="readonlyMode" />
    </div>
    <div class="te-field">
      <label class="te-label">标识 <span class="te-tag">{{ slugTouched ? '手动' : '自动派生' }}</span></label>
      <input class="te-input" :class="{ 'te-input-error': slugError }" v-model="slug" placeholder="news-team"
        :disabled="readonlyMode" @input="slugTouched = true" />
      <div class="te-error" v-if="slugError">{{ slugError }}</div>
      <div class="te-warn" v-else-if="slugHint">{{ slugHint }}</div>
    </div>
    <div class="te-field">
      <label class="te-label">描述 <span class="te-req">*</span></label>
      <input class="te-input" v-model="description" placeholder="一句话说明这个班底干什么、何时该用" :disabled="readonlyMode" />
    </div>

    <!-- 成员选择 -->
    <div class="te-field">
      <label class="te-label">成员 <span class="te-dim">(已选 {{ members.length }})</span></label>
      <div v-if="availableTemplates.length === 0" class="te-dim">暂无可用的单 Agent</div>
      <div v-for="t in availableTemplates" :key="t.subagent_type" class="te-member">
        <label class="te-check">
          <input type="checkbox" :checked="isSelected(t.subagent_type)" @change="toggleMember(t.subagent_type)" :disabled="readonlyMode" />
          <span class="te-member-name">{{ t.name }}</span>
          <span class="te-dim">@{{ t.subagent_type }}</span>
        </label>
        <div v-if="isSelected(t.subagent_type)" class="te-member-config">
          <input class="te-input te-input-sm" v-model="memberOf(t.subagent_type).role" placeholder="分工(如:调研员)" :disabled="readonlyMode" />
          <input class="te-input te-input-sm" v-model="memberOf(t.subagent_type).note" placeholder="备注(如:多轮检索,素材不足时上报)" :disabled="readonlyMode" />
          <label class="te-check te-check-sm" title="该成员被委派时先出只读计划,Lead 批准后开工">
            <input type="checkbox" v-model="memberOf(t.subagent_type).plan_first" :disabled="readonlyMode" />
            <span class="te-dim">先报计划</span>
          </label>
        </div>
      </div>
      <div class="te-error" v-if="membersError">{{ membersError }}</div>
    </div>

    <!-- 协作说明 -->
    <div class="te-field">
      <label class="te-label">协作说明 <span class="te-dim">(指导 Lead 现场编排:顺序/打回/轮次上限/素材不足时的处置)</span></label>
      <textarea class="te-textarea" v-model="orchestration" rows="4"
        placeholder="如:先调研后撰稿再核查;核查不过打回撰稿人修订,最多两轮;素材不足时先补一轮调研再写。"
        :disabled="readonlyMode"></textarea>
    </div>

    <!-- 保存栏 -->
    <div class="te-savebar">
      <div class="te-errors" v-if="validationErrors.length">
        <div v-for="(e, i) in validationErrors" :key="i" class="te-error">{{ e }}</div>
      </div>
      <button class="te-save-btn" :disabled="!canSave || saving" @click="onSave">
        {{ saving ? '保存中…' : (mode === 'edit' ? '保存修改' : '保存团队') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { getTemplateManager, serializeTeam, parseTeamDefinition, type SubagentTemplate, type TeamDefinition, type TeamMember } from '@assistant-ai/core'

interface Props {
  mode: 'create' | 'edit'
  initialTeam?: TeamDefinition
  readonlyMode?: boolean
}
const props = withDefaults(defineProps<Props>(), { readonlyMode: false })
const emit = defineEmits<{
  save: [payload: { slug: string; storage: 'user' | 'project'; content: string; renameFrom?: string }]
  cancel: []
}>()

const name = ref(props.initialTeam?.title ?? '')
const slug = ref(props.initialTeam?.name ?? '')
const slugTouched = ref(!!props.initialTeam)
const description = ref(props.initialTeam?.description ?? '')
const members = ref<TeamMember[]>(props.initialTeam ? props.initialTeam.members.map((m) => ({ ...m })) : [])
const orchestration = ref(props.initialTeam?.orchestration ?? '')
const storage = ref<'user' | 'project'>('user')
const saving = ref(false)

const availableTemplates = computed<SubagentTemplate[]>(() => {
  try {
    return getTemplateManager().getAllTemplates().filter((t) => {
      const type = (t.type as string | undefined) ?? 'builtin'
      return type === 'builtin' || type === 'custom'
    })
  } catch {
    return []
  }
})

function isSelected(agent: string): boolean {
  return members.value.some((m) => m.agent === agent)
}
function memberOf(agent: string): TeamMember {
  let m = members.value.find((x) => x.agent === agent)
  if (!m) {
    m = { agent, role: '', note: '' }
    members.value.push(m)
  }
  return m
}
function toggleMember(agent: string): void {
  const i = members.value.findIndex((m) => m.agent === agent)
  if (i >= 0) members.value.splice(i, 1)
  else members.value.push({ agent, role: '', note: '' })
}

// ---------- 派生标识(AgentEditor 同款) ----------
function latinSlug(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '')
}
watch(name, (v) => {
  if (!slugTouched.value) slug.value = latinSlug(v)
})

const slugError = computed(() => {
  const s = slug.value.trim()
  if (!s) return slugTouched.value ? '标识不能为空' : ''
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(s)) return '标识只能包含小写字母、数字和连字符'
  return ''
})
const slugHint = computed(() => {
  if (slug.value.trim() || slugError.value) return ''
  return name.value.trim() ? '中文名无法自动派生标识，请手动输入英文标识（小写字母/数字/连字符）' : ''
})
const membersError = computed(() => (members.value.length === 0 ? '至少选择 1 个成员' : ''))

const validationErrors = computed(() => {
  const errors: string[] = []
  if (!name.value.trim()) errors.push('名称必填')
  if (!description.value.trim()) errors.push('描述必填')
  if (slugError.value) errors.push(slugError.value)
  else if (!slug.value.trim()) errors.push('标识不能为空（中文名请手动输入英文标识）')
  if (membersError.value) errors.push(membersError.value)
  // 与解析器同一校验源兜底
  if (errors.length === 0) {
    const r = parseTeamDefinition(serializedYaml.value)
    if (!r.success) errors.push(r.error || '团队内容不合法')
  }
  return errors
})
const canSave = computed(() => validationErrors.value.length === 0)

const teamObject = computed<TeamDefinition>(() => ({
  name: slug.value.trim(),
  version: 1,
  title: name.value.trim(),
  description: description.value.trim(),
  members: members.value
    .filter((m) => m.agent)
    .map((m) => ({
      agent: m.agent,
      ...(m.role?.trim() ? { role: m.role.trim() } : {}),
      ...(m.note?.trim() ? { note: m.note.trim() } : {}),
    })),
  ...(orchestration.value.trim() ? { orchestration: orchestration.value.trim() } : {}),
}))
const serializedYaml = computed(() => serializeTeam(teamObject.value))

async function onSave(): Promise<void> {
  if (!canSave.value || saving.value) return
  saving.value = true
  try {
    emit('save', {
      slug: slug.value.trim(),
      storage: storage.value,
      content: serializedYaml.value,
      ...(props.mode === 'edit' && props.initialTeam && props.initialTeam.name !== slug.value.trim()
        ? { renameFrom: props.initialTeam.name }
        : {}),
    })
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.te-root { display: flex; flex-direction: column; gap: 0.75rem; }
.te-field { display: flex; flex-direction: column; gap: 0.25rem; }
.te-label { font-size: 0.8125rem; font-weight: 500; color: #374151; }
.te-req { color: #ef4444; }
.te-dim { font-size: 0.75rem; color: #9ca3af; font-weight: 400; }
.te-tag { font-size: 0.6875rem; color: #8b5cf6; background: rgba(139, 92, 246, 0.1); padding: 0 0.375rem; border-radius: 4px; margin-left: 0.25rem; }
.te-input { padding: 0.375rem 0.5rem; border: 1px solid #e5e7eb; border-radius: 6px; font-size: 0.8125rem; color: #1f2937; }
.te-input:focus { outline: none; border-color: #8b5cf6; }
.te-input-sm { font-size: 0.75rem; padding: 0.25rem 0.375rem; }
.te-input-error { border-color: #ef4444; }
.te-textarea { padding: 0.375rem 0.5rem; border: 1px solid #e5e7eb; border-radius: 6px; font-size: 0.8125rem; color: #1f2937; resize: vertical; font-family: inherit; }
.te-textarea:focus { outline: none; border-color: #8b5cf6; }
.te-member { display: flex; flex-direction: column; gap: 0.25rem; }
.te-check { display: inline-flex; align-items: center; gap: 0.375rem; font-size: 0.8125rem; color: #374151; }
.te-member-name { font-weight: 500; color: #1f2937; }
.te-member-config { display: flex; gap: 0.375rem; margin-left: 1.375rem; }
.te-member-config .te-input { flex: 1; }
.te-error { font-size: 0.75rem; color: #ef4444; }
.te-warn { font-size: 0.75rem; color: #d97706; }
.te-savebar { display: flex; align-items: center; justify-content: space-between; margin-top: 0.25rem; }
.te-save-btn { padding: 0.375rem 1rem; background: #3b82f6; color: #fff; border: none; border-radius: 6px; font-size: 0.8125rem; cursor: pointer; }
.te-save-btn:hover:not(:disabled) { background: #2563eb; }
.te-save-btn:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
