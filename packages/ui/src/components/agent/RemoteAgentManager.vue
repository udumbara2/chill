<template>
  <div class="settings-page">
    <!-- 标题和操作栏 -->
    <div class="settings-page-header">
      <div class="header-title">
        <h2>Agent管理</h2>
        <p class="settings-page-description">配置和管理所有Agent服务</p>
      </div>
      <div class="header-actions settings-actions">
        <button class="icon-btn" @click="$emit('add-local-agent')" title="从Agent工厂创建">
          <!-- Agent工厂图标 -->
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <!-- 房子主体 - 右下角开放 -->
            <path d="M12 3 L20 9 L20 10.5 M12 3 L4 9 L4 19 Q4 21 6 21 L11 21" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            <!-- 房子内部闪电 -->
            <g transform="translate(3.5, 6.5) scale(0.6)">
              <path d="M13 2 L8 10 L12 10 L9 18 L16 9 L12 9 L15 2 Z" fill="currentColor" stroke="none"/>
            </g>
            <!-- 右下角机器人图标 -->
            <g transform="translate(10.5, 10.5) scale(0.65)">
              <rect x="4" y="4" width="16" height="16" rx="4" stroke="currentColor" stroke-width="2"/>
              <circle cx="9" cy="10" r="1.8" fill="currentColor"/>
              <circle cx="15" cy="10" r="1.8" fill="currentColor"/>
            </g>
          </svg>
        </button>
        <button class="icon-btn" @click="$emit('add-agent')" title="添加远程Agent">
          <!-- 远程/网络连接图标 - 地球 -->
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <!-- 地球外圈 -->
            <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/>
            <!-- 地球经纬线 -->
            <ellipse cx="12" cy="12" rx="4" ry="9" stroke="currentColor" stroke-width="1.5"/>
            <line x1="3" y1="12" x2="21" y2="12" stroke="currentColor" stroke-width="1.5"/>
          </svg>
        </button>
      </div>
    </div>

    <!-- 外部插入内容（如 Lead Agent 配置） -->
    <slot name="header-content"></slot>

    <!-- Agent列表 -->
    <div class="agent-list-container">
      <!-- 列表标题和刷新按钮 -->
      <div v-if="allAgents.length > 0" class="settings-group-head">
        <div class="list-title-wrapper">
          <h3>已添加的Agent</h3>
          <!-- 刷新按钮 -->
          <button
            @click="handleRefresh"
            class="refresh-btn"
            :class="{ 'loading': isRefreshing }"
            :disabled="isRefreshing"
            title="刷新Agent列表"
          >
            <svg
              v-if="!isRefreshing"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.3"/>
            </svg>
            <svg
              v-else
              class="refresh-spinner"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
              <path d="M3 3v5h5"/>
              <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/>
              <path d="M21 21v-5h-5"/>
            </svg>
          </button>

          <!-- 刷新结果显示 -->
          <div
            v-if="refreshResult.show"
            class="refresh-result"
            :class="`result-${refreshResult.type}`"
          >
            <span class="result-icon">
              <svg v-if="refreshResult.type === 'success'" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                <path d="M9 12l2 2 4-4"/>
                <path d="M21 12c0 4.97-4.03 9-9 9s-9-4.03-9-9 4.03-9 9-9 9 4.03 9 9z"/>
              </svg>
              <svg v-else-if="refreshResult.type === 'error'" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                <circle cx="12" cy="12" r="10"/>
                <path d="M15 9l-6 6M9 9l6 6"/>
              </svg>
            </span>
            <span class="result-message">{{ refreshResult.message }}</span>
          </div>
        </div>
      </div>

      <!-- 有数据时显示列表 -->
      <div v-if="allAgents.length > 0" class="agent-list">
        <div
          v-for="agent in allAgents"
          :key="agent.id"
          class="settings-card settings-card-flush agent-item"
          :class="{ 'expanded': expandedId === agent.id }"
        >
          <!-- Agent基本信息行 -->
          <div class="agent-header" @click="toggleExpand(agent.id)">
            <div class="agent-info">
              <div class="agent-name-row">
                <span class="agent-name">{{ agent.name }}</span>
                <span
                  class="settings-badge"
                  :class="{ local: 'settings-badge-accent', coze: 'settings-badge-primary', a2a: 'settings-badge-success', remote_agent: 'settings-badge-success' }[agent.type]"
                >
                  {{ agent.type === 'local' ? '本地' : agent.type === 'coze' ? '扣子' : 'A2A' }}
                </span>
              </div>
              <div class="agent-source">
                {{ agent.type === 'local' ? `Agent工厂: ${agent.source}` :
                   agent.type === 'coze' ? `Bot ID: ${agent.source}` : agent.source }}
              </div>
            </div>
            <div class="agent-actions" @click.stop>
              <!-- 启用/禁用开关 -->
              <label class="settings-switch" @click.stop>
                <input
                  type="checkbox"
                  :checked="agent.enabled"
                  @change="handleToggle(agent, $event)"
                />
                <span class="settings-switch-slider"></span>
              </label>
              
              <!-- 展开/收起图标 -->
              <svg
                class="expand-icon"
                :class="{ 'expanded': expandedId === agent.id }"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <path d="M6 9l6 6 6-6" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              
              <!-- 本地Agent：打开Agent工厂按钮 -->
              <button
                v-if="agent.rawType === 'local'"
                class="edit-btn"
                @click.stop="$emit('open-workflow', agent.source)"
                title="打开Agent工厂"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" stroke-linecap="round" stroke-linejoin="round"/>
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
              
              <!-- 远程Agent：编辑按钮 -->
              <button 
                v-else
                class="edit-btn"
                @click.stop="$emit('edit-remote-agent', agent.rawData as RemoteAgentConfig, agent.index!)"
                title="编辑"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" stroke-linecap="round" stroke-linejoin="round"/>
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
              
              <!-- 删除按钮 -->
              <button 
                v-if="agent.rawType === 'remote'"
                class="delete-btn"
                @click.stop="$emit('delete-remote-agent', agent.rawData as RemoteAgentConfig)"
                title="删除"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M19 6.41L17.59 5L12 10.59L6.41 5L5 6.41L10.59 12L5 17.59L6.41 19L12 13.41L17.59 19L19 17.59L13.41 12L19 6.41Z"/>
                </svg>
              </button>
              <button 
                v-else
                class="delete-btn"
                @click.stop="$emit('delete-local-agent', agent.rawData as AgentListItem)"
                title="删除"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M19 6.41L17.59 5L12 10.59L6.41 5L5 6.41L10.59 12L5 17.59L6.41 19L12 13.41L17.59 19L19 17.59L13.41 12L19 6.41Z"/>
                </svg>
              </button>
            </div>
          </div>

          <!-- Agent详情（展开时显示） -->
          <div v-if="expandedId === agent.id" class="agent-details">
            <!-- 描述 -->
            <div class="detail-section">
              <h4 class="detail-title">描述</h4>
              <p v-if="agent.description" class="detail-content">{{ agent.description }}</p>
              <p v-else-if="loadingDescriptionId === agent.id" class="detail-content">加载中...</p>
              <p v-else class="detail-content">暂无描述</p>
            </div>

            <!-- 远程Agent特有的能力/技能 -->
            <template v-if="agent.rawType === 'remote'">
              <div class="detail-section" v-if="(agent.rawData as RemoteAgentConfig).agentCard?.capabilities">
                <h4 class="detail-title">能力</h4>
                <div class="capabilities-list">
                  <span v-if="(agent.rawData as RemoteAgentConfig).agentCard?.capabilities?.streaming" class="settings-badge settings-badge-neutral">流式响应</span>
                  <span v-if="(agent.rawData as RemoteAgentConfig).agentCard?.capabilities?.pushNotifications" class="settings-badge settings-badge-neutral">推送通知</span>
                  <span v-if="(agent.rawData as RemoteAgentConfig).agentCard?.capabilities?.stateTransitionHistory" class="settings-badge settings-badge-neutral">状态历史</span>
                </div>
              </div>

              <div class="detail-section" v-if="(agent.rawData as RemoteAgentConfig).agentCard?.skills && (agent.rawData as RemoteAgentConfig).agentCard!.skills!.length > 0">
                <h4 class="detail-title">技能</h4>
                <div class="skills-list">
                  <div v-for="skill in (agent.rawData as RemoteAgentConfig).agentCard!.skills" :key="skill.id" class="skill-item">
                    <div class="skill-name">{{ skill.name }}</div>
                    <div v-if="skill.description" class="skill-description">{{ skill.description }}</div>
                  </div>
                </div>
              </div>
            </template>
          </div>
        </div>
      </div>

      <!-- 空状态 -->
      <div v-else class="settings-empty">
        <div class="settings-empty-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <!-- 机器人头部外框 -->
            <rect x="4" y="4" width="16" height="16" rx="4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            <!-- 眼睛 -->
            <circle cx="9" cy="10" r="1.5" fill="currentColor"/>
            <circle cx="15" cy="10" r="1.5" fill="currentColor"/>
          </svg>
        </div>
        <h3 class="settings-empty-title">暂无Agent</h3>
        <p class="settings-empty-hint">您可以通过以下方式添加Agent服务</p>

        <div class="empty-actions">
          <div class="action-card local" @click="$emit('add-local-agent')">
            <div class="action-icon">
              <!-- Agent工厂图标 -->
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <!-- 房子主体 - 右下角开放 -->
                <path d="M12 3 L20 9 L20 10.5 M12 3 L4 9 L4 19 Q4 21 6 21 L11 21" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <!-- 房子内部闪电 -->
                <g transform="translate(3.5, 6.5) scale(0.6)">
                  <path d="M13 2 L8 10 L12 10 L9 18 L16 9 L12 9 L15 2 Z" fill="currentColor" stroke="none"/>
                </g>
                <!-- 右下角机器人图标 -->
                <g transform="translate(10.5, 10.5) scale(0.65)">
                  <rect x="4" y="4" width="16" height="16" rx="4" stroke="currentColor" stroke-width="2"/>
                  <circle cx="9" cy="10" r="1.8" fill="currentColor"/>
                  <circle cx="15" cy="10" r="1.8" fill="currentColor"/>
                </g>
              </svg>
            </div>
            <h4>从Agent工厂创建</h4>
            <p>自定义Agent</p>
          </div>

          <div class="action-card remote" @click="$emit('add-agent')">
            <div class="action-icon">
              <!-- 远程/网络连接图标 - 地球 -->
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <!-- 地球外圈 -->
                <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/>
                <!-- 地球经纬线 -->
                <ellipse cx="12" cy="12" rx="4" ry="9" stroke="currentColor" stroke-width="1.5"/>
                <line x1="3" y1="12" x2="21" y2="12" stroke="currentColor" stroke-width="1.5"/>
              </svg>
            </div>
            <h4>连接远程Agent</h4>
            <p>支持A2A协议和扣子(Coze)平台</p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useChatResourceStore } from '../../stores/chatResourceStore'
import type { RemoteAgentConfig, AgentListItem } from '@assistant-ai/core'

// Props
const props = defineProps<{
  localAgents: Array<AgentListItem & { description?: string }>
  remoteAgents: RemoteAgentConfig[]
}>()

// Emits
const emit = defineEmits<{
  'add-agent': []
  'add-local-agent': []
  'edit-remote-agent': [agent: RemoteAgentConfig, index: number]
  'delete-local-agent': [agent: AgentListItem]
  'delete-remote-agent': [agent: RemoteAgentConfig]
  'toggle-local-agent': [agent: AgentListItem, enabled: boolean]
  'toggle-remote-agent': [agent: RemoteAgentConfig, enabled: boolean]
  'open-workflow': [workflowId: string]
  'load-local-description': [agentId: string]
}>()

// Store
const chatResourceStore = useChatResourceStore()

// 展开状态
const expandedId = ref<string | null>(null)
const loadingDescriptionId = ref<string | null>(null)

// 刷新状态
const isRefreshing = ref(false)
const refreshResult = ref<{
  show: boolean
  message: string
  type: 'success' | 'error'
}>({
  show: false,
  message: '',
  type: 'success'
})

// 刷新Agent列表
const handleRefresh = async () => {
  if (isRefreshing.value) return

  isRefreshing.value = true
  refreshResult.value.show = false

  try {
    await chatResourceStore.loadResources()
    refreshResult.value = {
      show: true,
      message: `刷新成功，共 ${allAgents.value.length} 个Agent`,
      type: 'success'
    }
  } catch (error) {
    refreshResult.value = {
      show: true,
      message: '刷新失败: ' + (error instanceof Error ? error.message : '未知错误'),
      type: 'error'
    }
  } finally {
    isRefreshing.value = false
    // 3秒后隐藏结果
    setTimeout(() => {
      refreshResult.value.show = false
    }, 3000)
  }
}

// 合并本地和远程Agent，按名称排序
const allAgents = computed(() => {
  const locals = props.localAgents.map(agent => ({
    id: `local-${agent.id}`,
    name: agent.name,
    description: agent.description,
    type: 'local' as const,
    source: agent.sourceWorkflowId,
    enabled: isLocalAgentEnabled(agent),
    rawType: 'local' as const,
    rawData: agent
  }))
  
  const remotes = props.remoteAgents.map((agent, index) => ({
    id: `remote-${index}`,
    name: agent.agentCard?.name || (agent.type === 'coze' ? `扣子Agent-${index + 1}` : `远程Agent-${index + 1}`),
    description: agent.agentCard?.description,
    type: agent.type === 'coze' ? 'coze' as const : 'a2a' as const,
    source: agent.type === 'coze' ? agent.bot_id || '' : agent.url || '',
    enabled: isRemoteAgentEnabled(index),
    rawType: 'remote' as const,
    rawData: agent,
    index
  }))
  
  // 合并并按名称排序
  return [...locals, ...remotes].sort((a, b) => a.name.localeCompare(b.name))
})

// 切换展开/收起
const toggleExpand = async (id: string) => {
  if (expandedId.value === id) {
    expandedId.value = null
    return
  }
  expandedId.value = id
  
  // 如果是本地Agent且没有描述，触发加载
  const agent = allAgents.value.find(a => a.id === id)
  if (agent?.rawType === 'local' && agent.description === undefined) {
    loadingDescriptionId.value = id
    emit('load-local-description', (agent.rawData as AgentListItem).id)
    loadingDescriptionId.value = null
  }
}

// 统一处理切换启用
const handleToggle = (agent: typeof allAgents.value[0], event: Event) => {
  const enabled = (event.target as HTMLInputElement).checked
  if (agent.rawType === 'local') {
    emit('toggle-local-agent', agent.rawData as AgentListItem, enabled)
  } else {
    emit('toggle-remote-agent', agent.rawData as RemoteAgentConfig, enabled)
  }
}

// 本地Agent启用状态
const isLocalAgentEnabled = (agent: AgentListItem): boolean => {
  const resource = chatResourceStore.localAgentResources.find(r => {
    const config = r.config as { agentId: string }
    return config.agentId === agent.id
  })
  return resource?.enabled ?? true
}

// 远程Agent启用状态
const isRemoteAgentEnabled = (index: number): boolean => {
  const agent = props.remoteAgents[index]
  if (!agent) return false
  const resource = chatResourceStore.remoteAgentResources.find(r => {
    const config = r.config as RemoteAgentConfig
    return config.url === agent.url
  })
  return resource?.enabled ?? true
}
</script>

<style scoped>
/* 视觉规格来自契约层 settings.css（settings-page/page-header/group-head/card-flush/badge/switch/empty）；
   此处只保留页内结构性布局；滚动由外层 settings-main 独占 */
.header-title {
  flex: 1;
}

.agent-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-3);
}

/* 条目卡片内的行布局（视觉走契约 settings-card-flush） */
.agent-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--spacing-4);
  cursor: pointer;
  transition: background-color 0.2s;
}

.agent-header:hover {
  background-color: var(--background-secondary);
}

.agent-info {
  flex: 1;
  min-width: 0;
}

.agent-name {
  font-size: var(--font-size-base);
  font-weight: 600;
  color: var(--text-primary);
}

.agent-name-row {
  display: flex;
  align-items: center;
  gap: var(--spacing-2);
  margin-bottom: var(--spacing-1);
}

.agent-url {
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
  word-break: break-all;
}

.agent-actions {
  display: flex;
  align-items: center;
  gap: var(--spacing-3);
  margin-left: var(--spacing-4);
}

.expand-icon {
  color: var(--text-tertiary);
  transition: transform 0.2s;
}

.expand-icon.expanded {
  transform: rotate(180deg);
}

.edit-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: var(--radius-md);
  color: var(--text-tertiary);
  cursor: pointer;
  transition: all 0.2s;
}

.edit-btn:hover {
  background-color: rgba(var(--primary-color-rgb), 0.08);
  color: var(--primary-color);
}

.delete-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: var(--radius-md);
  color: var(--text-tertiary);
  cursor: pointer;
  transition: all 0.2s;
}

.delete-btn:hover {
  background-color: rgba(var(--error-color-rgb), 0.08);
  color: var(--error-color);
}

/* Agent详情 */
.agent-details {
  padding: 0 var(--spacing-4) var(--spacing-4) var(--spacing-4);
  border-top: 1px solid var(--border-color-light);
  background-color: var(--background-secondary);
}

.detail-section {
  margin-top: var(--spacing-4);
}

.detail-title {
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin: 0 0 var(--spacing-2) 0;
}

.detail-content {
  font-size: var(--font-size-sm);
  color: var(--text-primary);
  margin: 0;
  line-height: 1.5;
}

.capabilities-list {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-2);
}

.skills-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-2);
}

.skill-item {
  padding: var(--spacing-3);
  background-color: var(--background-primary);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-color-light);
}

.skill-name {
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--text-primary);
  margin-bottom: var(--spacing-1);
}

.skill-description {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
}

/* 空状态操作卡片（契约 settings-empty 之上的富内容） */
.empty-actions {
  display: flex;
  gap: var(--spacing-4);
  margin-top: var(--spacing-4);
}

/* 头部图标按钮（36px 方形，页内局部规格） */
.icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  background-color: var(--background-secondary);
  color: var(--text-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all 0.2s;
}

.icon-btn:hover {
  background-color: var(--background-tertiary);
  color: var(--primary-color);
  border-color: var(--primary-color);
}

/* Agent来源（原agent-url） */
.agent-source {
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
  word-break: break-all;
}

/* 空状态操作卡片 */
.empty-actions {
  display: flex;
  gap: var(--spacing-4);
  margin-top: var(--spacing-4);
}

.action-card {
  width: 200px;
  padding: var(--spacing-6);
  background-color: var(--background-primary);
  border: 2px solid var(--border-color);
  border-radius: var(--radius-lg);
  text-align: center;
  cursor: pointer;
  transition: all 0.2s;
}

.action-card:hover {
  border-color: var(--primary-color);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

.action-card.local {
  border-color: rgba(139, 92, 246, 0.3);
}

.action-card.local:hover {
  border-color: #8b5cf6;
  box-shadow: 0 4px 12px rgba(139, 92, 246, 0.15);
}

.action-card.remote {
  border-color: rgba(59, 130, 246, 0.3);
}

.action-card.remote:hover {
  border-color: #3b82f6;
  box-shadow: 0 4px 12px rgba(59, 130, 246, 0.15);
}

.action-icon {
  color: var(--text-tertiary);
  margin-bottom: var(--spacing-3);
  display: flex;
  justify-content: center;
}

.action-card.local .action-icon {
  color: #8b5cf6;
}

.action-card.remote .action-icon {
  color: #3b82f6;
}

.action-card h4 {
  font-size: var(--font-size-base);
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 var(--spacing-2) 0;
}

.action-card p {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  margin: 0;
  line-height: 1.4;
}

/* 列表标题行内的刷新控件（标题本体走契约 settings-group-head） */
.list-title-wrapper {
  display: flex;
  align-items: center;
  gap: var(--spacing-2);
}

.refresh-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  background-color: transparent;
  color: var(--text-tertiary);
  border: none;
  cursor: pointer;
  transition: color 0.2s;
}

.refresh-btn:hover:not(:disabled) {
  color: var(--primary-color);
}

.refresh-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.refresh-spinner {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.refresh-result {
  display: flex;
  align-items: center;
  gap: var(--spacing-2);
  padding: var(--spacing-2) var(--spacing-3);
  border-radius: var(--radius-md);
  font-size: var(--font-size-xs);
  animation: fadeIn 0.2s ease;
}

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(-5px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.refresh-result.result-success {
  background-color: rgba(var(--success-color-rgb), 0.1);
  color: var(--success-color);
}

.refresh-result.result-error {
  background-color: rgba(var(--error-color-rgb), 0.1);
  color: var(--error-color);
}

.result-icon {
  display: flex;
  align-items: center;
}

.result-message {
  white-space: nowrap;
}
</style>
