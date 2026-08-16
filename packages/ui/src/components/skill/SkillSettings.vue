<template>
  <div class="settings-page">
    <div class="settings-page-header">
      <h2>技能管理</h2>
      <div class="settings-actions">
        <button class="settings-btn" @click="refresh" :disabled="loading" title="重新扫描技能目录">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="23 4 23 10 17 10"></polyline>
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
          </svg>
          刷新
        </button>
      </div>
    </div>
    <p class="settings-tip">
      技能存放在：个人级 ~/.chill/skills/、项目级 .agents/skills/；启用状态与 CLI 共享（同一份配置）。
    </p>

    <div v-if="skills.length === 0" class="settings-empty">
      <div class="settings-empty-icon">🧩</div>
      <p class="settings-empty-title">暂无已安装的技能</p>
      <p class="settings-empty-hint">可在 CLI 中用 /skill install 安装，或让助手通过 install_skill 工具安装</p>
    </div>

    <div v-else class="skill-list">
      <div
        v-for="skill in skills"
        :key="skill.name"
        class="settings-card skill-card"
        :class="{ disabled: !isEnabled(skill.name) }"
      >
        <div class="skill-card-header">
          <div class="skill-name-row">
            <span class="skill-name">{{ skill.name }}</span>
            <span
              class="settings-badge"
              :class="{ personal: 'settings-badge-primary', project: 'settings-badge-success', builtin: 'settings-badge-accent' }[sourceType(skill).cls]"
            >{{ sourceType(skill).label }}</span>
            <span v-if="!isEnabled(skill.name)" class="settings-badge settings-badge-neutral">已禁用</span>
          </div>
          <div class="skill-actions">
            <label class="settings-switch" :title="isEnabled(skill.name) ? '点击禁用' : '点击启用'">
              <input
                type="checkbox"
                :checked="isEnabled(skill.name)"
                @change="toggleEnabled(skill.name)"
              />
              <span class="settings-switch-slider"></span>
            </label>
            <button
              v-if="sourceType(skill).cls !== 'builtin'"
              class="settings-btn settings-btn-danger skill-uninstall-btn"
              @click="askUninstall(skill.name)"
              title="卸载此技能"
            >卸载</button>
          </div>
        </div>
        <p class="skill-desc">{{ skill.description || '（无描述）' }}</p>
        <p class="skill-path" :title="skill.sourcePath">{{ skill.sourcePath }}</p>
        <p v-if="skill.availableDirs && skill.availableDirs.length > 0" class="skill-dirs">
          资源目录: {{ skill.availableDirs.join(', ') }}
        </p>
      </div>
    </div>

    <!-- 卸载确认弹窗 -->
    <div v-if="uninstallTarget" class="confirm-modal" @click="uninstallTarget = null">
      <div class="confirm-content" @click.stop>
        <h4>确认卸载</h4>
        <p>确定要卸载技能 "<strong>{{ uninstallTarget }}</strong>" 吗？文件将从技能目录中删除。</p>
        <div class="confirm-footer">
          <button class="settings-btn" @click="uninstallTarget = null">取消</button>
          <button class="settings-btn settings-btn-danger" @click="doUninstall" :disabled="loading">{{ loading ? '卸载中...' : '确认卸载' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { getSkillRegistry } from '@assistant-ai/core'
import type { SkillMeta } from '@assistant-ai/core'
import { reloadSkills } from '../../services/skillService'

const skills = ref<SkillMeta[]>([])
const loading = ref(false)
const uninstallTarget = ref<string | null>(null)

const registry = getSkillRegistry()

function reloadList(): void {
  skills.value = [...registry.getAll()]
}

function isEnabled(name: string): boolean {
  return registry.isEnabled(name)
}

function toggleEnabled(name: string): void {
  if (registry.isEnabled(name)) {
    registry.disable(name)
  } else {
    registry.enable(name)
  }
  reloadList()
}

function sourceType(skill: SkillMeta): { label: string; cls: string } {
  const p = skill.sourcePath.replace(/\\/g, '/')
  if (p.includes('/.agents/')) return { label: '项目', cls: 'project' }
  if (p.includes('/.chill/')) return { label: '个人', cls: 'personal' }
  return { label: '内置', cls: 'builtin' }
}

function askUninstall(name: string): void {
  uninstallTarget.value = name
}

async function doUninstall(): Promise<void> {
  if (!uninstallTarget.value) return
  loading.value = true
  try {
    const result = await window.electronAPI.skillUninstall(uninstallTarget.value)
    if (result?.success) {
      await reloadSkills()
      reloadList()
    } else {
      alert(`卸载失败: ${result?.error || '未知错误'}`)
    }
  } catch (err) {
    console.error('卸载技能失败:', err)
    alert('卸载技能失败，请重试')
  } finally {
    loading.value = false
    uninstallTarget.value = null
  }
}

async function refresh(): Promise<void> {
  loading.value = true
  try {
    await reloadSkills()
    reloadList()
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  reloadList()
})
</script>

<style scoped>
/* 视觉规格全部来自契约层 settings.css（settings-page/header/card/badge/btn/switch/empty）；
   此处只保留页内结构性布局 */
.skill-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.skill-card.disabled {
  opacity: 0.6;
}

.skill-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.skill-name-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.skill-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}

.skill-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.skill-uninstall-btn {
  padding: 3px 10px;
  font-size: 12px;
}

.skill-desc {
  font-size: var(--font-size-base);
  color: var(--text-secondary);
  margin: 8px 0 0;
  line-height: 1.5;
}

.skill-path {
  font-size: 11px;
  color: var(--text-tertiary);
  margin: 6px 0 0;
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.skill-dirs {
  font-size: 12px;
  color: var(--text-secondary);
  margin: 4px 0 0;
}

.confirm-modal {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.confirm-content {
  background: var(--background-primary);
  border-radius: var(--radius-xl);
  padding: 20px 24px;
  width: 380px;
  box-shadow: var(--shadow-lg);
}

.confirm-content h4 {
  margin: 0 0 12px;
  font-size: 16px;
  color: var(--text-primary);
}

.confirm-content p {
  margin: 0 0 20px;
  font-size: 14px;
  color: var(--text-secondary);
  line-height: 1.5;
}

.confirm-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
</style>
