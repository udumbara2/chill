<template>
  <div class="assets-panel">
    <!-- 全空统一欢迎页(设计稿 A;三路异步首刷落定后才可现,防闪烁) -->
    <div v-if="allEmpty" class="welcome">
      <div class="welcome-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="7" width="16" height="13" rx="3"/><circle cx="9" cy="13" r="1.4" fill="currentColor"/><circle cx="15" cy="13" r="1.4" fill="currentColor"/><path d="M12 7V4M8 4h8"/></svg>
      </div>
      <div class="welcome-title">从这里开始,组建你的 Agent 班底</div>
      <div class="welcome-sub">单 Agent 干活、团队灵活协同、工作流固化流程——三类资产都在这个页面创建和管理</div>
      <div class="welcome-entries">
        <div class="welcome-entry" @click="createAgent">
          <div class="welcome-entry-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a8 8 0 0 1 16 0v1"/></svg></div>
          <div class="welcome-entry-name">创建单 Agent</div>
          <div class="welcome-entry-desc">定制一个专精角色<br>审查代码、撰写文档、调研热点…</div>
        </div>
        <div class="welcome-entry" @click="createTeam">
          <div class="welcome-entry-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="9" r="3"/><circle cx="16" cy="9" r="3"/><path d="M2 20v-1a6 6 0 0 1 12 0v1M12 20v-1a6 6 0 0 1 10-4.4"/></svg></div>
          <div class="welcome-entry-name">组建团队</div>
          <div class="welcome-entry-desc">把几个 Agent 编成班底<br>共享看板认领、灵活协作</div>
        </div>
        <div class="welcome-entry" @click="createWorkflow">
          <div class="welcome-entry-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><path d="M10 6.5h6a2 2 0 0 1 2 2V14M14 17.5H8a2 2 0 0 1-2-2V10"/></svg></div>
          <div class="welcome-entry-name">创建工作流</div>
          <div class="welcome-entry-desc">把固定流程画成画布<br>一次编排,反复稳定执行</div>
        </div>
      </div>
      <div class="welcome-remote-link">已有云端 Agent?→ <a @click="emit('add-agent')">连接远程 Agent(A2A / Coze 平台)</a></div>
    </div>

    <template v-else>
    <!-- 单 Agent(模板文件;点卡片进编辑器) -->
    <section class="settings-group assets-group">
      <div class="settings-group-head">
        <h3>单 Agent <span class="assets-count">{{ agentCards.length }}</span></h3>
        <button v-if="agentCards.length > 0" class="assets-new-btn" @click="createAgent">+ 新建</button>
      </div>
      <div v-if="agentCards.length === 0" class="assets-empty">暂无单 Agent · <span class="assets-empty-link" @click="createAgent">+ 新建</span></div>
      <div v-else class="assets-cards">
        <div
          v-for="a in agentCards"
          :key="a.subagent_type"
          class="settings-card asset-card"
          :title="`${a.description || a.name}(点击编辑)`"
          @click="editAgent(a)"
        >
          <div class="asset-card-top">
            <span class="asset-name">{{ a.name }}</span>
            <span class="asset-badge" :class="{ gray: levelOf(a) !== 'user' }">{{ LEVEL_LABEL[levelOf(a)] }}</span>
          </div>
          <div class="asset-id">@{{ a.subagent_type }}</div>
          <div class="asset-desc">{{ a.description || '无描述' }}</div>
          <div class="asset-foot"><span class="asset-edit-btn">编辑</span></div>
        </div>
      </div>
    </section>

    <!-- Agent 团队(班底 YAML;点卡片进组队编辑器) -->
    <section class="settings-group assets-group">
      <div class="settings-group-head">
        <h3>Agent 团队 <span class="assets-count">{{ teamCards.length }}</span></h3>
        <button v-if="teamCards.length > 0" class="assets-new-btn" @click="createTeam">+ 新建</button>
      </div>
      <div v-if="teamCards.length === 0" class="assets-empty">暂无 Agent 团队 · <span class="assets-empty-link" @click="createTeam">+ 新建</span></div>
      <div v-else class="assets-cards">
        <div
          v-for="t in teamCards"
          :key="t.name"
          class="settings-card asset-card"
          :title="`${t.description || t.title || t.name}(点击编辑)`"
          @click="editTeam(t)"
        >
          <div class="asset-card-top">
            <span class="asset-name">{{ t.title || t.name }}</span>
            <span class="asset-badge" :class="{ gray: t.scope === 'project' }">{{ t.scope === 'project' ? '项目' : '个人' }}</span>
          </div>
          <div class="asset-id">@{{ t.name }}</div>
          <div class="asset-desc">{{ t.description || '无描述' }}</div>
          <div class="asset-members">
            <span v-for="m in t.members" :key="m.agent" class="asset-member-chip">{{ m.role || m.agent }}</span>
          </div>
          <div class="asset-foot"><span class="asset-edit-btn">编辑</span></div>
        </div>
      </div>
    </section>

    <!-- 工作流(YAML;点卡片打开 dock 画布) -->
    <section class="settings-group assets-group">
      <div class="settings-group-head">
        <h3>工作流 <span class="assets-count">{{ workflowCards.length }}</span></h3>
        <button v-if="workflowCards.length > 0" class="assets-new-btn" @click="createWorkflow">+ 新建</button>
      </div>
      <div v-if="workflowCards.length === 0" class="assets-empty">暂无工作流 · <span class="assets-empty-link" @click="createWorkflow">+ 新建</span></div>
      <div v-else class="assets-cards">
        <div
          v-for="w in workflowCards"
          :key="w.sourcePath || w.name"
          class="settings-card asset-card"
          :title="`${w.description || w.title || w.name}(点击打开画布)`"
          @click="editWorkflow(w)"
        >
          <div class="asset-card-top">
            <span class="asset-name">{{ w.title || w.name }}</span>
            <span class="asset-badge" :class="{ gray: w.scope === 'project' }">{{ w.scope === 'project' ? '项目' : '个人' }}</span>
          </div>
          <div class="asset-id">@{{ w.name }}</div>
          <div class="asset-desc">{{ workflowSummary(w) }}</div>
          <div class="asset-foot"><span class="asset-edit-btn">编辑画布</span></div>
        </div>
      </div>
    </section>

    <!-- 远程 Agent(卡片化,设计稿 B;启停/编辑/删除/刷新/能力技能展开全量保留,自 RemoteAgentManager 迁入) -->
    <section class="settings-group assets-group">
      <div class="settings-group-head">
        <h3>远程 Agent <span class="assets-count">{{ remoteCards.length }}</span></h3>
        <!-- 紧凑刷新图标(loadResources;结果提示 3s 自动隐藏) -->
        <button
          class="assets-refresh-btn"
          :class="{ loading: isRefreshing }"
          :disabled="isRefreshing"
          title="刷新Agent列表"
          @click="handleRefresh"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.3"/>
          </svg>
        </button>
        <span v-if="refreshResult.show" class="assets-refresh-result" :class="`result-${refreshResult.type}`">{{ refreshResult.message }}</span>
        <button v-if="remoteCards.length > 0" class="assets-new-btn" @click="emit('add-agent')">+ 连接</button>
      </div>
      <div v-if="remoteCards.length === 0" class="assets-empty">暂无远程 Agent · <span class="assets-empty-link" @click="emit('add-agent')">+ 连接</span></div>
      <div v-else class="assets-cards">
        <div
          v-for="r in remoteCards"
          :key="r.id"
          class="settings-card asset-card"
          :title="`${r.description || r.name}(点击展开详情)`"
          @click="toggleRemoteExpand(r.id)"
        >
          <div class="asset-card-top">
            <span class="asset-name">{{ r.name }}</span>
            <span class="asset-badge blue">{{ r.type === 'coze' ? 'Coze' : 'A2A' }}</span>
          </div>
          <div class="asset-id">{{ r.type === 'coze' ? `Bot ID: ${truncate(r.source)}` : truncate(r.source) }}</div>
          <div class="asset-desc">{{ r.description || '无描述' }}</div>
          <div class="asset-foot remote-foot">
            <!-- 启停开关(isRemoteAgentEnabled 逻辑迁入:remoteAgentResources 按 url 匹配) -->
            <span class="remote-status" @click.stop>
              <span class="remote-toggle" :class="{ on: r.enabled }" @click="emit('toggle-remote-agent', r.rawData, !r.enabled)"></span>
              <span class="remote-status-text" :class="{ on: r.enabled }">{{ r.enabled ? '已启用' : '已停用' }}</span>
            </span>
            <span class="remote-actions">
              <!-- 删除与展开详情超出设计稿 B 的卡片元素,属功能零回退的必要保留 -->
              <button class="asset-edit-btn" @click.stop="emit('edit-remote-agent', r.rawData, r.index)">编辑</button>
              <button class="remote-delete-btn" title="删除" @click.stop="emit('delete-remote-agent', r.rawData)">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M19 6.41L17.59 5L12 10.59L6.41 5L5 6.41L10.59 12L5 17.59L6.41 19L12 13.41L17.59 19L19 17.59L13.41 12L19 6.41Z"/>
                </svg>
              </button>
            </span>
          </div>
          <!-- 展开详情:描述/能力/技能(结构与内容自 RemoteAgentManager 迁入) -->
          <div v-if="expandedRemoteId === r.id" class="remote-details" @click.stop>
            <div class="remote-detail-sec">
              <div class="remote-detail-title">描述</div>
              <div class="remote-detail-content"><MessageMarkdown :content="r.description || '暂无描述'" /></div>
            </div>
            <div v-if="r.rawData.agentCard?.capabilities" class="remote-detail-sec">
              <div class="remote-detail-title">能力</div>
              <div class="remote-chip-list">
                <span v-if="r.rawData.agentCard.capabilities.streaming" class="remote-chip">流式响应</span>
                <span v-if="r.rawData.agentCard.capabilities.pushNotifications" class="remote-chip">推送通知</span>
                <span v-if="r.rawData.agentCard.capabilities.stateTransitionHistory" class="remote-chip">状态历史</span>
              </div>
            </div>
            <div v-if="r.rawData.agentCard?.skills && r.rawData.agentCard.skills.length > 0" class="remote-detail-sec">
              <div class="remote-detail-title">技能</div>
              <div class="remote-skill-list">
                <div v-for="skill in r.rawData.agentCard.skills" :key="skill.id" class="remote-skill-item">
                  <div class="remote-skill-name">{{ skill.name }}</div>
                  <div v-if="skill.description" class="remote-skill-desc">{{ skill.description }}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { eventBus, EVENTS } from '@assistant-ai/core'
import type { SubagentTemplate, TeamDefinition, WorkflowDefinition, RemoteAgentConfig } from '@assistant-ai/core'
import { useOrchestratorStore } from '../../stores/orchestratorStore'
import MessageMarkdown from '../MessageMarkdown.vue'
import { useChatResourceStore } from '../../stores/chatResourceStore'
import { initTeamAssetService, listTeamAssets, OPEN_TEAM_EDITOR_EVENT, TEAMS_RELOADED_EVENT } from '../../services/teamAssetService'
import {
  initWorkflowAssetService,
  listWorkflowAssets,
  stageWorkflowCanvas,
  OPEN_WORKFLOW_CANVAS_EVENT,
  WORKFLOWS_RELOADED_EVENT,
} from '../../services/workflowAssetService'

/**
 * 设置 Agent 页资产中心(UI 三层显示统一 · 迭代 3 + 远程 Agent 卡片化/欢迎页):
 * 五分组卡片——单 Agent | Agent 团队 | 工作流 | 远程 Agent(自 RemoteAgentManager 迁入,功能全量保留)| 委派限额(在 ModelSettings)。
 * 全空(用户资产=0,内置出厂件不算)且三路异步首刷落定 → 统一欢迎页替代全部分组(设计稿 A)。
 * 空组(任一组)隐藏组头新建按钮,操作并入空态内链(四组统一,照设计稿 B)。
 * 数据源:单 Agent = orchestratorStore.templates(响应式);团队/工作流 = 资产服务快照 + 重扫订阅;
 * 远程 = chatResourceStore.remoteAgents(原 props 改直读,同一 store)。
 */
const emit = defineEmits<{
  /** 请求关闭设置并打开 dock 工作流页签(画布在 dock 里,设置覆盖层 z-index 高于 dock,须先关) */
  'open-workflow-canvas': []
  /** 远程 Agent 四事件(接 ModelSettings 既有四个 handle,原 RemoteAgentManager 接线平移) */
  'add-agent': []
  'edit-remote-agent': [agent: RemoteAgentConfig, index: number]
  'delete-remote-agent': [agent: RemoteAgentConfig]
  'toggle-remote-agent': [agent: RemoteAgentConfig, enabled: boolean]
  /** 全空状态联动(全空时 ModelSettings 连委派限额一并隐藏——设计稿 A 的整页语义) */
  'empty-change': [empty: boolean]
}>()

// ---------- 单 Agent(与 WorkflowView 侧栏同款过滤:内置/个人/项目,远程模板不归此列) ----------
const orchestratorStore = useOrchestratorStore()
const agentCards = computed(() =>
  orchestratorStore.templates.filter((t) => {
    const type = (t.type as string | undefined) ?? 'builtin'
    return type === 'builtin' || type === 'custom'
  }),
)

const LEVEL_LABEL: Record<string, string> = { builtin: '内置', user: '个人', project: '项目' }
const levelOf = (t: SubagentTemplate): 'builtin' | 'user' | 'project' => {
  const type = (t.type as string | undefined) ?? 'builtin'
  if (type === 'builtin') return 'builtin'
  return t.priority_scope === 'project' ? 'project' : 'user'
}

// 编辑器覆盖层(Home,z-index 高于设置)直接开在设置上方,不关设置——保存后回到资产中心
const editAgent = (t: SubagentTemplate): void => {
  eventBus.emit(EVENTS.OPEN_AGENT_EDITOR, { slug: t.subagent_type })
}
const createAgent = (): void => {
  eventBus.emit(EVENTS.OPEN_AGENT_EDITOR, {})
}

// ---------- Agent 团队 ----------
const teamCards = ref<TeamDefinition[]>([])
const refreshTeams = (): void => {
  teamCards.value = listTeamAssets()
}

const editTeam = (t: TeamDefinition): void => {
  eventBus.emit(OPEN_TEAM_EDITOR_EVENT, { slug: t.name })
}
const createTeam = (): void => {
  eventBus.emit(OPEN_TEAM_EDITOR_EVENT, {})
}

// ---------- 工作流 ----------
const workflowCards = ref<WorkflowDefinition[]>([])
const refreshWorkflows = (): void => {
  workflowCards.value = listWorkflowAssets()
}

const workflowSummary = (w: WorkflowDefinition): string => {
  const nodes = `${w.nodes?.length ?? 0} 节点`
  return w.description ? `${w.description} · ${nodes}` : nodes
}

/** 编辑画布/新建:暂存指令(防时序竞争) + 事件 nudge(画布已挂载时即时消费) + 关设置开 dock */
const openCanvas = (cmd: Parameters<typeof stageWorkflowCanvas>[0]): void => {
  stageWorkflowCanvas(cmd)
  eventBus.emit(OPEN_WORKFLOW_CANVAS_EVENT, {})
  emit('open-workflow-canvas')
}
const editWorkflow = (w: WorkflowDefinition): void => {
  if (!w.sourcePath) return
  openCanvas({ kind: 'open', sourcePath: w.sourcePath })
}
const createWorkflow = (): void => {
  openCanvas({ kind: 'new' })
}

// ---------- 远程 Agent(自 RemoteAgentManager 迁入;视图模型同款,按名称排序) ----------
const chatResourceStore = useChatResourceStore()

/** 启用态判定(自 RemoteAgentManager.isRemoteAgentEnabled 迁入):remoteAgentResources 按 url 匹配,缺省启用 */
const isRemoteAgentEnabled = (agent: RemoteAgentConfig): boolean => {
  const resource = chatResourceStore.remoteAgentResources.find((r) => {
    const config = r.config as RemoteAgentConfig
    return config.url === agent.url
  })
  return resource?.enabled ?? true
}

const remoteCards = computed(() =>
  chatResourceStore.remoteAgents
    .map((agent, index) => ({
      id: `remote-${index}`,
      name: agent.agentCard?.name || (agent.type === 'coze' ? `扣子Agent-${index + 1}` : `远程Agent-${index + 1}`),
      description: agent.agentCard?.description,
      type: agent.type === 'coze' ? ('coze' as const) : ('a2a' as const),
      source: agent.type === 'coze' ? agent.bot_id || '' : agent.url || '',
      enabled: isRemoteAgentEnabled(agent),
      rawData: agent,
      index,
    }))
    .sort((a, b) => a.name.localeCompare(b.name)),
)

const truncate = (s: string): string => (s.length > 42 ? `${s.slice(0, 39)}…` : s)

// 展开详情(能力/技能)
const expandedRemoteId = ref<string | null>(null)
const toggleRemoteExpand = (id: string): void => {
  expandedRemoteId.value = expandedRemoteId.value === id ? null : id
}

// 刷新(loadResources 幂等;结果提示沿用 3s 自动隐藏)
const isRefreshing = ref(false)
const refreshResult = ref<{ show: boolean; message: string; type: 'success' | 'error' }>({
  show: false,
  message: '',
  type: 'success',
})
const handleRefresh = async (): Promise<void> => {
  if (isRefreshing.value) return
  isRefreshing.value = true
  refreshResult.value.show = false
  try {
    await chatResourceStore.loadResources()
    refreshResult.value = { show: true, message: `刷新成功，共 ${remoteCards.value.length} 个Agent`, type: 'success' }
  } catch (error) {
    refreshResult.value = { show: true, message: '刷新失败: ' + (error instanceof Error ? error.message : '未知错误'), type: 'error' }
  } finally {
    isRefreshing.value = false
    setTimeout(() => {
      refreshResult.value.show = false
    }, 3000)
  }
}

// ---------- 全空欢迎页(设计稿 A) ----------
/** 三路异步首刷落定标记(Promise.allSettled 后统一直位,防欢迎页闪烁) */
const firstLoadDone = ref(false)

/** 用户创建的单 Agent 数(内置出厂模板不算用户资产——否则欢迎页永远触发不了) */
const userAgentCount = computed(() => agentCards.value.filter((t) => levelOf(t) !== 'builtin').length)

const allEmpty = computed(
  () =>
    firstLoadDone.value &&
    userAgentCount.value === 0 &&
    teamCards.value.length === 0 &&
    workflowCards.value.length === 0 &&
    chatResourceStore.remoteAgents.length === 0,
)

// 全空联动:emit 给 ModelSettings,委派限额一并隐藏(计算不下移——团队/工作流计数非响应式,上移要复制订阅逻辑)
watch(allEmpty, (v) => emit('empty-change', v), { immediate: true })

onMounted(() => {
  // 资产服务幂等初始化 + 三路首刷(teams/workflows/remoteAgents),全部落定后才允许欢迎页出现
  void Promise.allSettled([
    initTeamAssetService().then(refreshTeams),
    initWorkflowAssetService().then(refreshWorkflows),
    chatResourceStore.loadResources(),
  ]).then(() => {
    firstLoadDone.value = true
  })
  // 重扫广播订阅(编辑器保存后本面板仍在设置页内,需热刷新)
  eventBus.on(TEAMS_RELOADED_EVENT, refreshTeams)
  eventBus.on(WORKFLOWS_RELOADED_EVENT, refreshWorkflows)
})

onUnmounted(() => {
  eventBus.off(TEAMS_RELOADED_EVENT, refreshTeams)
  eventBus.off(WORKFLOWS_RELOADED_EVENT, refreshWorkflows)
})
</script>

<style scoped>
/* 分组间距沿用全局 settings-group;卡片网格/徽标照设计稿 settings-assets-tab.html 与 assets-with-remote-cards.html */
.assets-count {
  font-size: 11px;
  color: var(--text-secondary);
  font-weight: 400;
  margin-left: 6px;
}

.assets-new-btn {
  font-size: 12px;
  color: var(--primary-color);
  font-weight: 600;
  padding: 3px 10px;
  border-radius: 999px;
  border: none;
  background: rgba(var(--primary-color-rgb), 0.08);
  cursor: pointer;
}

.assets-new-btn:hover {
  background: rgba(var(--primary-color-rgb), 0.15);
}

/* 空组一行空态(设计稿 B empty-line;操作并入空态内链) */
.assets-empty {
  font-size: 12.5px;
  color: #b0aca2;
  padding: 8px 2px;
}

.assets-empty-link {
  color: var(--primary-color);
  font-weight: 600;
  cursor: pointer;
}

.assets-empty-link:hover {
  text-decoration: underline;
}

.assets-cards {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}

.asset-card {
  cursor: pointer;
  display: flex;
  flex-direction: column;
}

.asset-card-top {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.asset-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.asset-badge {
  font-size: 10.5px;
  padding: 1px 8px;
  border-radius: 999px;
  background: rgba(var(--primary-color-rgb), 0.1);
  color: var(--primary-color);
  flex-shrink: 0;
}

.asset-badge.gray {
  background: var(--background-secondary);
  color: var(--text-secondary);
}

/* 平台徽标(设计稿 B badge.blue) */
.asset-badge.blue {
  background: rgba(59, 130, 246, 0.1);
  color: #3b82f6;
}

.asset-id {
  font-size: 11.5px;
  color: var(--primary-color);
  margin-bottom: 6px;
  font-family: Consolas, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.asset-desc {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.asset-members {
  display: flex;
  gap: 4px;
  margin-top: 8px;
  flex-wrap: wrap;
}

.asset-member-chip {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  color: var(--text-primary);
}

.asset-foot {
  margin-top: 10px;
  display: flex;
  justify-content: flex-end;
}

.asset-edit-btn {
  font-size: 11.5px;
  color: var(--text-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 2px 10px;
  background: var(--background-primary);
  cursor: pointer;
}

/* ---------- 远程 Agent 卡片(设计稿 B) ---------- */
.remote-foot {
  align-items: center;
  justify-content: space-between;
}

.remote-status {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* 开关(设计稿 B toggle) */
.remote-toggle {
  width: 34px;
  height: 19px;
  border-radius: 999px;
  background: #d1d5db;
  position: relative;
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.15s;
}

.remote-toggle::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  background: #fff;
  transition: left 0.15s;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
}

.remote-toggle.on {
  background: var(--primary-color);
}

.remote-toggle.on::after {
  left: 17px;
}

.remote-status-text {
  font-size: 11px;
  color: var(--text-tertiary);
}

.remote-status-text.on {
  color: var(--success-color, #10b981);
}

.remote-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.remote-delete-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: 6px;
  color: var(--text-tertiary);
  cursor: pointer;
}

.remote-delete-btn:hover {
  background-color: rgba(var(--error-color-rgb), 0.08);
  color: var(--error-color);
}

/* 展开详情(能力/技能;结构自 RemoteAgentManager 迁入) */
.remote-details {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--border-color);
  cursor: default;
}

.remote-detail-sec {
  margin-bottom: 10px;
}

.remote-detail-title {
  font-size: 10.5px;
  font-weight: 600;
  color: var(--text-tertiary);
  letter-spacing: 0.5px;
  margin-bottom: 4px;
}

.remote-detail-content {
  font-size: 12px;
  color: var(--text-primary);
  line-height: 1.5;
}

.remote-chip-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.remote-chip {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  color: var(--text-primary);
}

.remote-skill-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.remote-skill-item {
  padding: 8px 10px;
  background: var(--background-secondary);
  border-radius: 8px;
  border: 1px solid var(--border-color);
}

.remote-skill-name {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-primary);
  margin-bottom: 2px;
}

.remote-skill-desc {
  font-size: 11px;
  color: var(--text-secondary);
}

/* 组头紧凑刷新控件 */
.assets-refresh-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  background: transparent;
  border: none;
  color: var(--text-tertiary);
  cursor: pointer;
}

.assets-refresh-btn:hover:not(:disabled) {
  color: var(--primary-color);
}

.assets-refresh-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.assets-refresh-btn.loading svg {
  animation: assets-spin 1s linear infinite;
}

@keyframes assets-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.assets-refresh-result {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 6px;
}

.assets-refresh-result.result-success {
  background: rgba(var(--success-color-rgb, 16, 185, 129), 0.1);
  color: var(--success-color, #10b981);
}

.assets-refresh-result.result-error {
  background: rgba(var(--error-color-rgb), 0.1);
  color: var(--error-color);
}

/* ---------- 全空欢迎页(设计稿 A) ---------- */
.welcome {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-top: 90px;
}

.welcome-icon {
  width: 64px;
  height: 64px;
  border-radius: 18px;
  background: rgba(var(--primary-color-rgb), 0.1);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 22px;
}

.welcome-icon svg {
  width: 34px;
  height: 34px;
  color: var(--primary-color);
}

.welcome-title {
  font-size: 21px;
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 10px;
}

.welcome-sub {
  font-size: 13.5px;
  color: var(--text-secondary);
  margin-bottom: 44px;
}

.welcome-entries {
  display: flex;
  gap: 18px;
}

.welcome-entry {
  width: 250px;
  background: var(--background-primary);
  border: 1.5px solid var(--border-color);
  border-radius: 14px;
  padding: 26px 22px 22px;
  cursor: pointer;
  transition: all 0.15s;
  text-align: center;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
}

.welcome-entry:hover {
  border-color: rgba(var(--primary-color-rgb), 0.5);
  box-shadow: 0 8px 20px rgba(var(--primary-color-rgb), 0.1);
  transform: translateY(-2px);
}

.welcome-entry-ico {
  width: 46px;
  height: 46px;
  border-radius: 12px;
  margin: 0 auto 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(var(--primary-color-rgb), 0.08);
  color: var(--primary-color);
}

.welcome-entry-ico svg {
  width: 24px;
  height: 24px;
}

.welcome-entry-name {
  font-size: 15px;
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 7px;
}

.welcome-entry-desc {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.6;
}

.welcome-remote-link {
  margin-top: 34px;
  font-size: 12.5px;
  color: var(--text-tertiary);
}

.welcome-remote-link a {
  color: var(--primary-color);
  text-decoration: none;
  font-weight: 600;
  cursor: pointer;
}

.welcome-remote-link a:hover {
  text-decoration: underline;
}
</style>
