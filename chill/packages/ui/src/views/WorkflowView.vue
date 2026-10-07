<template>
  <div class="workflow-view-layout" :class="{ 'readonly-mode': readonly }">
    <!-- 顶部工具栏（编辑器自持：侧栏切换/保存/执行，自 Home 菜单行迁入；轻量态隐藏） -->
    <div v-if="!light" class="workflow-toolbar">
      <button
        class="workflow-sidebar-toggle-btn"
        @click="toggleWorkflowSidebar"
        :title="showWorkflowSidebar ? '关闭工作流列表' : '打开工作流列表'"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
          <line x1="9" y1="3" x2="9" y2="21"/>
        </svg>
      </button>
      <button
        class="save-workflow-btn"
        @click="smartSaveWorkflow"
        title="保存工作流"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
          <polyline points="17 21 17 13 7 13 7 21"/>
          <polyline points="7 3 7 8 15 8"/>
        </svg>
      </button>
      <button
        class="execute-workflow-btn"
        @click="executeWorkflow"
        :disabled="workflowStore.isExecuting"
        title="执行工作流"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="5 3 19 12 5 21 5 3"/>
        </svg>
      </button>
    </div>

    <div class="workflow-body">
    <!-- 工作流侧边栏（内嵌可调整宽度） -->
    <div
      v-if="showWorkflowSidebar"
      class="workflow-sidebar"
      :style="{ width: sidebarWidth + 'px' }"
    >
      <div class="sidebar-header">
        <span class="sidebar-title">工作流</span>
        <div class="sidebar-header-actions">
          <button
            class="sidebar-new-btn"
            @click="createNewWorkflow"
            title="新建工作流（编排画布）"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="5" x2="12" y2="19"/>
              <line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
          </button>
          <!-- 新建单 Agent（表单；与"新建智能体"（编排画布）区分） -->
          <button
            class="sidebar-new-btn"
            @click="openTemplateEditor('create')"
            title="新建单 Agent（表单）"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="5" y="3" width="14" height="18" rx="2"/>
              <line x1="9" y1="8" x2="15" y2="8"/>
              <line x1="9" y1="12" x2="15" y2="12"/>
              <line x1="9" y1="16" x2="13" y2="16"/>
            </svg>
          </button>
          <button
            class="sidebar-close-btn"
            @click="toggleWorkflowSidebar"
            title="关闭"
          >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
          </button>
        </div>
      </div>
      <div class="sidebar-content">

        <!-- 执行中提示 -->
        <div v-if="workflowStore.isExecuting" class="executing-hint">
          <span class="executing-dot"></span>
          <span class="executing-text">执行中，暂不可切换</span>
        </div>


        <!-- 命名工作流分区(YAML 真相源,进 git 可团队共享;M2) -->
        <div class="tpl-section">
          <div class="tpl-section-head">
            <span class="tpl-section-title">工作流</span>
          </div>
          <div class="tpl-section-sub">YAML 文件，进 git 可团队共享</div>
          <div v-if="yamlWorkflows.length === 0 && yamlWorkflowErrors.length === 0" class="sidebar-empty">暂无工作流</div>
          <div
            v-for="w in yamlWorkflows"
            :key="w.sourcePath || w.name"
            class="workflow-list-item tpl-item"
            :class="{ 'workflow-list-item-active': currentYamlDef?.name === w.name }"
            @click="openYamlWorkflow(w)"
            :title="`${w.description || w.title || w.name}（点击打开画布）`"
          >
            <div class="workflow-item-info">
              <span class="workflow-item-name">
                {{ w.title || w.name }}
                <span class="tpl-level" :class="`tpl-level-${w.scope === 'project' ? 'project' : 'user'}`">{{ w.scope === 'project' ? '项目' : '个人' }}</span>
              </span>
              <span class="tpl-item-slug">@{{ w.name }}</span>
            </div>
            <div class="workflow-item-actions">
              <button
                class="workflow-item-rename-btn"
                @click.stop="runYamlWorkflow(w)"
                title="运行(有必填入参时会先打开画布,在开始节点填写后点执行)"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polygon points="5 3 19 12 5 21 5 3"/>
                </svg>
              </button>
              <button
                class="workflow-item-delete-btn"
                @click.stop="handleYamlWorkflowDelete(w)"
                title="删除"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="3 6 5 6 21 6"/>
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                </svg>
              </button>
            </div>
          </div>
          <!-- 非法文件带原因可见(不静默跳过) -->
          <div v-for="err in yamlWorkflowErrors" :key="err" class="tpl-error" :title="err">⚠ {{ err }}</div>
          <!-- 归一化警告(如空数组按未声明处理;不阻断加载但可见) -->
          <div v-for="warn in yamlWorkflowWarnings" :key="warn" class="tpl-warning" :title="warn">⚠ {{ warn }}</div>
        </div>

        <!-- 单 Agent 分区（模板文件，进 git 可团队共享；编辑/删除/迁移全生命周期在此） -->
        <div class="tpl-section">
          <div class="tpl-section-head">
            <span class="tpl-section-title">单 Agent</span>
            <button class="sidebar-new-btn" @click="openTemplateEditor('create')" title="新建单 Agent（表单）">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="12" y1="5" x2="12" y2="19"/>
                <line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
            </button>
          </div>
          <div class="tpl-section-sub">模板文件，进 git 可团队共享</div>
          <div v-if="localTemplates.length === 0" class="sidebar-empty">暂无单 Agent</div>
          <div
            v-for="t in localTemplates"
            :key="t.subagent_type"
            class="workflow-list-item tpl-item"
            @click="openTemplateEditor('edit', t)"
            :title="`${t.description || t.name}（点击编辑）`"
          >
            <div class="workflow-item-info">
              <span class="workflow-item-name">
                {{ t.name }}
                <span class="tpl-level" :class="`tpl-level-${templateLevel(t)}`">{{ TEMPLATE_LEVEL_LABEL[templateLevel(t)] }}</span>
              </span>
              <span class="tpl-item-slug">@{{ t.subagent_type }}</span>
            </div>
            <div class="workflow-item-actions">
              <button
                v-if="templateLevel(t) !== 'builtin'"
                class="workflow-item-delete-btn"
                @click.stop="handleTemplateDelete(t)"
                title="删除"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="3 6 5 6 21 6"/>
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>
      <!-- 拖拽调整手柄 -->
      <div class="sidebar-resize-handle" @mousedown="startResizeSidebar"></div>
    </div>

    <!-- 侧边栏拉出触发区域（当侧边栏关闭时显示） -->
    <div
      v-if="!showWorkflowSidebar"
      class="sidebar-pull-trigger"
      @mousedown="startPullSidebar"
      title="拖拽以打开工作流列表"
    ></div>

    <!-- 主画布区域 -->
    <div class="workflow-main-area" :style="{ width: mainAreaWidth }">
      <VueFlow
        v-model:nodes="nodes"
        v-model:edges="edges"
        :node-types="nodeTypes"
        :edge-types="edgeTypes"
        :default-viewport="{ zoom: 0.8 }"
        :min-zoom="0.1"
        :max-zoom="4"
        :default-edge-options="{ type: 'default', animated: true }"
        :auto-pan-on-connect="false"
        :auto-pan-on-node-drag="false"
        :nodes-draggable="!readonly"
        :nodes-connectable="!readonly"
        :elements-selectable="!readonly"
        @contextmenu="showContextMenu"
        @connect="handleConnect"
        @dragover="handleDragOver"
        @drop="handleDrop"
        @pointerup="handlePointerUp"
      >
        <Controls position="top-left" />
        <MiniMap position="bottom-right" />
      </VueFlow>

      <!-- 只看（readonly）时隐藏节点面板，画布不可新增节点 -->
      <NodePalette v-if="!readonly" />

    <button
      class="execution-history-toggle-btn"
      @click="toggleExecutionHistoryDrawer"
      :title="showExecutionHistoryDrawer ? '关闭执行历史' : '打开执行历史'"
    >
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <line x1="3" y1="12" x2="21" y2="12"/>
        <line x1="3" y1="6" x2="21" y2="6"/>
        <line x1="3" y1="18" x2="21" y2="18"/>
      </svg>
    </button>

    <div 
      v-if="showExecutionHistoryDrawer" 
      class="execution-history-drawer-overlay"
      @click="toggleExecutionHistoryDrawer"
    ></div>

    <div 
      class="execution-history-drawer"
      :class="{ 'drawer-open': showExecutionHistoryDrawer }"
    >
      <div class="drawer-header">
        <span class="drawer-title">执行历史</span>
        <button 
          class="drawer-close-btn"
          @click="toggleExecutionHistoryDrawer"
          title="关闭"
        >
          <svg 
            width="18" 
            height="18" 
            viewBox="0 0 24 24" 
            fill="none" 
            stroke="currentColor" 
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div class="drawer-content">
          <!-- 命名工作流运行记录(M6;与 CLI /workflow runs 同一数据源) -->
          <div v-if="workflowRuns.length > 0" class="workflow-runs-section">
            <div class="drawer-sub-title">命名工作流运行</div>
            <div v-for="r in workflowRuns" :key="r.runId" class="workflow-run-item" :title="r.finalOutput || r.error || r.runId">
              <span class="workflow-run-name">{{ r.workflowName }}</span>
              <span class="workflow-run-status" :class="`run-status-${r.status}`">{{ r.status }}</span>
              <span class="workflow-run-time">{{ formatTime(new Date(r.startedAt).toISOString()) }}</span>
            </div>
          </div>
          <div class="execution-history-content">
            <div v-if="executionRecords.length === 0" class="empty-state">暂无执行记录</div>
            <div v-else class="execution-records-list">
              <div 
                v-for="(record, index) in executionRecords" 
                :key="index"
                class="execution-record-item"
              >
                <div class="record-header" @click="toggleRecord(index)">
                  <div class="record-node-info">
                    <span class="execution-order">{{ index + 1 }}</span>
                    <span class="record-time">{{ formatTime(record.createdAt) }}</span>
                  </div>
                  <div class="record-header-right">
                    <div class="record-status" :class="getNodeStatus(record)">
                      {{ getNodeStatus(record) }}
                    </div>
                    <svg 
                      class="expand-icon" 
                      :class="{ 'expanded': expandedRecords.has(index) }"
                      viewBox="0 0 24 24" 
                      fill="none" 
                      stroke="currentColor" 
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <polyline points="9,18 15,12 9,6"></polyline>
                    </svg>
                  </div>
                </div>
                <transition name="record-details">
                  <div v-if="expandedRecords.has(index)" class="record-details">
                    <div class="detail-section">
                      <div class="detail-title" @click="toggleDetailSection(index, 0)">
                        <span>完整状态 (values)</span>
                        <svg 
                          class="section-expand-icon" 
                          :class="{ 'expanded': expandedDetailSections.get(index)?.has(0) }"
                          viewBox="0 0 24 24" 
                          fill="none" 
                          stroke="currentColor" 
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        >
                          <polyline points="9,18 15,12 9,6"></polyline>
                        </svg>
                      </div>
                      <transition name="section-content">
                        <pre v-if="expandedDetailSections.get(index)?.has(0)" class="json-content">{{ formatJSON(record.values) }}</pre>
                      </transition>
                    </div>
                    <div v-if="record.tasks[0]?.result" class="detail-section">
                      <div class="detail-title" @click="toggleDetailSection(index, 1)">
                        <span>节点执行结果 (result)</span>
                        <svg 
                          class="section-expand-icon" 
                          :class="{ 'expanded': expandedDetailSections.get(index)?.has(1) }"
                          viewBox="0 0 24 24" 
                          fill="none" 
                          stroke="currentColor" 
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        >
                          <polyline points="9,18 15,12 9,6"></polyline>
                        </svg>
                      </div>
                      <transition name="section-content">
                        <pre v-if="expandedDetailSections.get(index)?.has(1)" class="json-content">{{ formatJSON(getFilteredStateForDisplay(record)) }}</pre>
                      </transition>
                    </div>
                    <div v-if="record.tasks[0]?.error" class="detail-section">
                      <div class="detail-title error" @click="toggleDetailSection(index, 2)">
                        <span>错误信息 (error)</span>
                        <svg 
                          class="section-expand-icon" 
                          :class="{ 'expanded': expandedDetailSections.get(index)?.has(2) }"
                          viewBox="0 0 24 24" 
                          fill="none" 
                          stroke="currentColor" 
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        >
                          <polyline points="9,18 15,12 9,6"></polyline>
                        </svg>
                      </div>
                      <transition name="section-content">
                        <pre v-if="expandedDetailSections.get(index)?.has(2)" class="json-content error">{{ formatJSON(record.tasks[0].error) }}</pre>
                      </transition>
                    </div>
                    <div class="detail-section">
                      <div class="detail-title" @click="toggleDetailSection(index, 3)">
                        <span>元数据 (metadata)</span>
                        <svg 
                          class="section-expand-icon" 
                          :class="{ 'expanded': expandedDetailSections.get(index)?.has(3) }"
                          viewBox="0 0 24 24" 
                          fill="none" 
                          stroke="currentColor" 
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        >
                          <polyline points="9,18 15,12 9,6"></polyline>
                        </svg>
                      </div>
                      <transition name="section-content">
                        <pre v-if="expandedDetailSections.get(index)?.has(3)" class="json-content">{{ formatJSON(record.metadata) }}</pre>
                      </transition>
                    </div>
                  </div>
                </transition>
              </div>
            </div>
          </div>
      </div>
    </div>
    </div>
    
    <Teleport to="body">
      <EdgeTypeMenu
        v-if="showEdgeTypeMenu"
        :x="edgeTypeMenuPosition.x"
        :y="edgeTypeMenuPosition.y"
        :show-default="!isCycleConnection"
        @select="handleEdgeTypeSelect"
      />
    </Teleport>
    
    <ConditionalEdgeConfig
      v-if="showConditionalEdgeConfig"
      :is-visible="showConditionalEdgeConfig"
      :nodes="nodes"
      :edges="edges"
      :source-node-id="editingEdgeSource || pendingConnection?.source"
      :target-node-id="editingEdgeTarget || pendingConnection?.target"
      :editing-edge-id="editingEdgeId"
      :edge-data="editingEdgeData"
      :is-cycle-connection="isCycleConnection"
      @confirm="handleConditionalEdgeConfirm"
      @update="handleConditionalEdgeUpdate"
      @cancel="handleConditionalEdgeCancel"
    />
    
    <Teleport to="body">
      <div 
        v-if="showMenu" 
        class="context-menu"
        :style="menuStyle"
        @click.stop
      >
        <div class="menu-item" @click="handleAddNode('start')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <polygon points="10,8 16,12 10,16"/>
          </svg>
          <span>添加开始节点</span>
        </div>
        <div class="menu-item" @click="handleAddNode('model')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
            <line x1="8" y1="21" x2="16" y2="21"/>
            <line x1="12" y1="17" x2="12" y2="21"/>
          </svg>
          <span>添加模型节点</span>
        </div>
        <div class="menu-item" @click="handleAddNode('code')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="16,18 22,12 16,6"/>
            <polyline points="8,6 2,12 8,18"/>
          </svg>
          <span>添加代码执行节点</span>
        </div>
        <div class="menu-item" @click="handleAddNode('output')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7,10 12,15 17,10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          <span>添加输出节点</span>
        </div>
      </div>
    </Teleport>
    
    <Teleport to="body">
      <div 
        v-if="showNodeMenu" 
        class="context-menu node-context-menu"
        :style="nodeMenuStyle"
        @click.stop
      >
        <div class="menu-item delete-item" @click="handleDeleteNode">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
          <span>删除节点</span>
        </div>
      </div>
    </Teleport>
    
    <Teleport to="body">
      <div 
        v-if="showEdgeMenu" 
        class="context-menu edge-context-menu"
        :style="edgeMenuStyle"
        @click.stop
      >
        <div class="menu-item edge-info">
          <span>类型: {{ selectedEdge?.type === 'conditional' ? '条件边' : '普通边' }}</span>
        </div>
        <div class="menu-divider"></div>
        <div v-if="selectedEdge?.type === 'conditional'" class="menu-item" @click="handleEditEdge">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
          <span>编辑条件</span>
        </div>
        <div v-if="selectedEdge?.type === 'default'" class="menu-item" @click="handleConvertToConditional">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
          </svg>
          <span>转换为条件边</span>
        </div>
        <div v-if="selectedEdge?.type === 'conditional'" class="menu-item" @click="handleConvertToDefault">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="5" y1="12" x2="19" y2="12"/>
            <polyline points="12 5 19 12 12 19"/>
          </svg>
          <span>转换为普通边</span>
        </div>
        <div class="menu-divider"></div>
        <div class="menu-item delete-item" @click="handleDeleteEdge">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
          <span>删除连接线</span>
        </div>
      </div>
    </Teleport>
    
    <ConfirmDialog
      :is-open="showDeleteConfirm"
      :title="deleteConfirmTitle"
      :message="deleteConfirmMessage"
      @confirm="handleDeleteConfirm"
      @cancel="handleDeleteCancel"
    />

    <SaveWorkflowDialog
      :is-open="showSaveWorkflowDialog"
      :is-saving="isSavingWorkflow"
      :initial-name="saveDialogInitialName"
      :mode="saveDialogMode"
      @confirm="handleSaveWorkflowConfirm"
      @cancel="handleSaveWorkflowCancel"
    />

    <!-- 单模型节点改道 + 侧栏单 Agent 入口：模板编辑器（单 agent 走模板体系，不再存 SavedAgent） -->
    <div v-if="showTemplateEditor" class="template-editor-overlay" @click.self="showTemplateEditor = false">
      <div class="template-editor-panel">
        <div class="template-editor-head">
          <button class="settings-btn" @click="showTemplateEditor = false">← 返回</button>
          <span class="template-editor-title">{{ templateEditorMode === 'edit' ? '编辑 Agent' : '新建 Agent' }}</span>
        </div>
        <AgentEditor
          :key="templateEditorKey"
          :mode="templateEditorMode"
          :initial-template="templateEditorPrefill"
          :readonly-mode="templateEditorReadonly"
          :existing-slugs="templateSlugMap"
          :work-dir="getEngineWorkDir()"
          @save="handleTemplateEditorSave"
          @cancel="showTemplateEditor = false"
          @fork="handleTemplateFork"
        />
      </div>
    </div>

    <!-- Toast 提示 -->
    <Transition name="toast">
      <div v-if="toast.show" class="toast-message" :class="toast.type">
        <svg v-if="toast.type === 'success'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
        <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <span>{{ toast.message }}</span>
      </div>
    </Transition>

    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, markRaw, watch, nextTick, provide } from 'vue'
import { VueFlow, useVueFlow } from '@vue-flow/core'
import type { Edge } from '@vue-flow/core'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import { Controls } from '@vue-flow/controls'
import '@vue-flow/controls/dist/style.css'
import { MiniMap } from '@vue-flow/minimap'
import '@vue-flow/minimap/dist/style.css'
import ModelNode from '../components/ModelNode.vue'
import StartNode from '../components/StartNode.vue'
import ToolNode from '../components/ToolNode.vue'
import CodeExecutorNode from '../components/CodeExecutorNode.vue'
import EdgeTypeMenu from '../components/EdgeTypeMenu.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import SaveWorkflowDialog from '../components/SaveWorkflowDialog.vue'
import AgentEditor from '../components/agentEditor/AgentEditor.vue'
import { getTemplateManager, TemplatePriority, serializeTemplate, type SubagentTemplate } from '@assistant-ai/core'
import { saveTemplateFile, deleteTemplateFile } from '../services/templateSaver'
import { initTeamAssetService } from '../services/teamAssetService'
import { getEngineWorkDir } from '../services/chatEngine'
import {
  listWorkflowAssets,
  getWorkflowAssetErrors,
  getWorkflowAssetWarnings,
  getWorkflowAssetService,
  saveWorkflowAsset,
  deleteWorkflowAsset,
  definitionToCanvasWithLayout,
  initWorkflowAssetService,
  listWorkflowRuns,
  consumeStagedWorkflowCanvas,
  OPEN_WORKFLOW_CANVAS_EVENT,
  WORKFLOWS_RELOADED_EVENT,
} from '../services/workflowAssetService'
import { canvasToDefinition, WORKFLOW_DSL_VERSION, eventBus, type WorkflowDefinition, type WorkflowRunRecord } from '@assistant-ai/core'
import ConditionalEdgeConfig from '../components/ConditionalEdgeConfig.vue'
import ConditionalEdge from '../components/edges/ConditionalEdge.vue'
import NodePalette from '../components/NodePalette.vue'
import type { ConditionalEdge as ConditionalEdgeType, BranchConfig, BranchCondition, RouterCondition, StateFieldCondition, Message, ToolDefinition, ModelNodeData, ToolNodeData, StartNodeData, WorkflowNode, CodeExecutorNodeData } from '@assistant-ai/core'
import { ConditionType, OperatorType, EdgeType, workflowEventBus, WORKFLOW_EVENTS, NamespacedWorkflowEventBus } from '@assistant-ai/core'
import { useWorkflowStore } from '../stores/workflowStore'
import { useResizablePanel } from '../composables/useResizablePanel'
import type { WorkflowState } from '../stores/workflowStore'

const props = withDefaults(defineProps<{
  /** 只看/参与意图（ContentDock 传入）：true 时画布只读（交互/菜单/删除/自动保存全 gate） */
  readonly?: boolean
  /** 轻量态（WorkflowLightView 传入）：在只读基础上隐藏编辑器 toolbar，作为 dock 默认渲染态 */
  light?: boolean
}>(), {
  readonly: false,
  light: false
})

const workflowStore = useWorkflowStore()

/**
 * 迁移旧版边数据到新版格式
 * 将旧版的单条件格式（含 StateFieldCondition.branches Record）转换为新版 BranchConfig[] 格式
 */
const migrateEdgeData = (edge: any): { branches: BranchConfig[], fallbackNodeId?: string, label?: string } | null => {
  // 如果已经是新版格式，直接返回
  if (edge.data?.branches && Array.isArray(edge.data.branches)) {
    return {
      branches: edge.data.branches,
      fallbackNodeId: edge.data.fallbackNodeId,
      label: edge.data.label
    }
  }

  // 如果没有旧版 condition 数据，返回 null
  if (!edge.data?.condition) {
    return null
  }

  const oldCondition = edge.data.condition as RouterCondition
  const branches: BranchConfig[] = []
  let fallbackNodeId = oldCondition.fallback || '__end__'

  // 根据旧版条件类型创建 BranchConfig
  switch (oldCondition.type) {
    case ConditionType.TOOL_CALL:
      branches.push({
        id: `branch_${Date.now()}_tool`,
        label: '有工具调用',
        condition: {
          type: ConditionType.TOOL_CALL,
          fallback: fallbackNodeId
        } as BranchCondition,
        targetNodeId: edge.target,
        priority: 1
      })
      break

    case ConditionType.CONTENT:
      const contentCondition = oldCondition as any
      branches.push({
        id: `branch_${Date.now()}_content`,
        label: `内容${contentCondition.operator || '等于'}${contentCondition.value}`,
        condition: {
          type: ConditionType.CONTENT,
          operator: contentCondition.operator || 'equals',
          value: contentCondition.value,
          fallback: fallbackNodeId
        } as BranchCondition,
        targetNodeId: edge.target,
        priority: 1
      })
      break

    case ConditionType.STATE_FIELD:
      const stateFieldCondition = oldCondition as StateFieldCondition
      
      // 处理 StateFieldCondition.branches（旧版多分支格式）
      if (stateFieldCondition.branches && Object.keys(stateFieldCondition.branches).length > 0) {
        let priority = 1
        for (const [fieldValue, targetNodeId] of Object.entries(stateFieldCondition.branches)) {
          branches.push({
          id: `branch_${Date.now()}_${priority}`,
          label: `${stateFieldCondition.field}=${fieldValue}`,
          condition: {
            type: ConditionType.STATE_FIELD,
            field: stateFieldCondition.field,
            operator: OperatorType.EQ,
            value: fieldValue,
            fallback: fallbackNodeId
          } as BranchCondition,
          targetNodeId,
          priority: priority++
        })
        }
      } else {
        // 单分支格式
        branches.push({
          id: `branch_${Date.now()}_state`,
          label: `${stateFieldCondition.field}${stateFieldCondition.operator}${stateFieldCondition.value}`,
          condition: {
            type: ConditionType.STATE_FIELD,
            field: stateFieldCondition.field,
            operator: stateFieldCondition.operator,
            value: stateFieldCondition.value,
            fallback: fallbackNodeId
          } as BranchCondition,
          targetNodeId: edge.target,
          priority: 1
        })
      }
      break

    case ConditionType.EXPRESSION:
      const expressionCondition = oldCondition as any
      branches.push({
        id: `branch_${Date.now()}_expr`,
        label: '表达式条件',
        condition: {
          type: ConditionType.EXPRESSION,
          expression: expressionCondition.expression,
          fallback: fallbackNodeId
        } as BranchCondition,
        targetNodeId: edge.target,
        priority: 1
      })
      break

    default:
      console.warn('Unknown condition type during migration:', oldCondition.type)
      return null
  }

  return {
    branches,
    fallbackNodeId,
    label: edge.data?.label
  }
}

const handleNodeExecute = async (nodeId: string, config: any, messages: Message[] = []) => {
  const node = nodes.value.find(n => n.id === nodeId)
  if (!node) return

  // 获取当前工作流的命名空间事件总线
  const namespacedEventBus = workflowEventBusInstance.value

  try {
    // 根据节点类型执行不同的逻辑
    if (node.type === 'tool') {
      // 工具节点单节点测试执行
      const { toolNode } = await import('../stores/workflowStore')
      
      const state: any = {
        messages,
        selectedToolsMap: {
          [nodeId]: config.selectedTools || []
        },
        toolParamsMap: {
          [nodeId]: config.toolParams || {}
        },
        toolResultsMap: {}
      }

      namespacedEventBus.emit(WORKFLOW_EVENTS.NODE_STARTED, { nodeId })

      const result = await toolNode(state, nodeId)

      namespacedEventBus.emit(WORKFLOW_EVENTS.NODE_COMPLETED, {
        nodeId,
        result
      })
    } else {
      // 模型节点单节点测试执行（原有逻辑）
      await workflowStore.executeNode(
        {
          id: nodeId,
          type: 'model',
          label: node.data.label,
          modelType: config.modelType,
          modelName: config.modelName,
          systemPrompt: config.systemPrompt,
          parameters: config.parameters,
          selectedTools: config.selectedTools
        },
        messages,
        (chunk) => {
          // 使用命名空间事件总线 emit 事件
          namespacedEventBus.emit(WORKFLOW_EVENTS.STREAM_CHUNK, {
            nodeId,
            chunk
          })
        },
        workflowId.value
      )
    }
  } catch (error) {
    console.error('Node execution error:', error)
    // 使用命名空间事件总线 emit 错误事件
    namespacedEventBus.emit(WORKFLOW_EVENTS.STREAM_ERROR, {
      nodeId,
      error
    })
  }
}

const compileWorkflow = () => {
  // 迁移边数据到新版格式
  const migratedEdges = edges.value.map(edge => {
    if (edge.type === 'conditional') {
      const migratedData = migrateEdgeData(edge)
      if (migratedData) {
        return {
          ...edge,
          data: migratedData
        }
      }
    }
    return edge
  })

  // 传递 workflowId 给 store 方法
  workflowStore.createWorkflowWithStartNode(nodes.value, migratedEdges, workflowId.value)
}

const executeWorkflow = async () => {
  compileWorkflow()
  
  const startNodeData = getStartNodeData()
  
  const systemPrompts: Record<string, string> = {}
  const modelConfigs: Record<string, Record<string, any>> = {}
  const selectedToolsMap: Record<string, ToolDefinition[]> = {}
  const toolParamsMap: Record<string, Record<string, any>> = {}
  const codeExecutorConfigs: Record<string, { interactiveMode?: boolean }> = {}
  
  nodes.value.forEach(node => {
    if (node.type === 'model') {
      const modelNodeData = node.data as ModelNodeData
      if (modelNodeData.systemPrompt !== undefined && modelNodeData.systemPrompt !== null) {
        systemPrompts[node.id] = modelNodeData.systemPrompt
      }
      
      if (modelNodeData.selectedModel) {
        modelConfigs[node.id] = {
          ...modelNodeData.parameters,
          model: modelNodeData.selectedModel.name
        }
      }
      
      if (modelNodeData.selectedTools) {
        selectedToolsMap[node.id] = modelNodeData.selectedTools
      }
    }
    
    if (node.type === 'tool') {
      const toolNodeData = node.data as ToolNodeData
      if (toolNodeData.selectedTools) {
        selectedToolsMap[node.id] = toolNodeData.selectedTools
      }
      
      if (toolNodeData.toolParams) {
        toolParamsMap[node.id] = toolNodeData.toolParams
      }
    }
    
    if (node.type === 'code') {
      const codeNodeData = node.data as CodeExecutorNodeData
      codeExecutorConfigs[node.id] = {
        interactiveMode: codeNodeData.interactiveMode
      }
    }
  })

  const input: Partial<WorkflowState> = {
    text: startNodeData.text,
    files: startNodeData.files,
    modelConfigs,
    selectedToolsMap,
    toolParamsMap,
    codeExecutorConfigs,
    executionResults: [],
    currentNode: '',
    systemPrompts
  }
  
  try {
    // 传递 workflowId 和 namespacedEventBus 给 store 方法
    await workflowStore.streamWorkflow(input, () => {}, workflowId.value, workflowEventBusInstance.value)
  } catch (error) {
    console.error('Workflow execution error:', error)
  }
  // 注意：不再在 finally 中加载执行历史
  // 因为执行过程中的事件已经准确记录了历史，重新加载会清空这些记录
}

const getStartNodeData = () => {
  const startNode = nodes.value.find(n => n.type === 'start')
  
  if (!startNode) {
    return { text: '', files: [] }
  }
  
  const startNodeData = startNode.data as StartNodeData
  
  return {
    text: startNodeData.textInput || '',
    files: startNodeData.fileInputs?.filter((f: string) => f.trim()) || []
  }
}

const nodes = ref<WorkflowNode[]>([])
const edges = ref<Edge[]>([])
const previewEdge = ref<Edge | null>(null)

// 自动保存相关
const autoSaveTimer = ref<number | null>(null)
const AUTO_SAVE_DELAY = 3000 // 3秒防抖

// 监听 nodes 和 edges 变化，自动保存草稿
watch([nodes, edges], () => {
  // 只看（readonly）模式停写：不触发任何保存
  if (props.readonly) return

  // 清除之前的定时器
  if (autoSaveTimer.value) {
    clearTimeout(autoSaveTimer.value)
  }

  // 设置新的定时器
  autoSaveTimer.value = window.setTimeout(() => {
    // 保存到 workflowStore（按 workflowId 隔离；内存草稿，旧 workflowPersistence 的 JSON 落盘草稿已退役）
    workflowStore.saveWorkflowData(workflowId.value, nodes.value, edges.value)
  }, AUTO_SAVE_DELAY)
}, { deep: true })

const nodeTypes = markRaw({
  model: ModelNode,
  start: StartNode,
  tool: ToolNode,
  code: CodeExecutorNode
})

const edgeTypes = markRaw({
  conditional: ConditionalEdge
})

const { onPaneClick, onNodesChange, onNodeContextMenu, onEdgesChange, onEdgeContextMenu, onEdgeDoubleClick } = useVueFlow()

const showMenu = ref(false)
const menuPosition = ref({ x: 0, y: 0 })

const showNodeMenu = ref(false)
const nodeMenuPosition = ref({ x: 0, y: 0 })
const selectedNodes = ref<WorkflowNode[]>([])

const showEdgeMenu = ref(false)
const edgeMenuPosition = ref({ x: 0, y: 0 })
const selectedEdgeId = ref<string | null>(null)
const selectedEdges = ref<Edge[]>([])

const selectedEdge = ref<Edge | null>(null)
watch(selectedEdgeId, (newId) => {
  if (!newId) {
    selectedEdge.value = null
  } else {
    selectedEdge.value = edges.value.find(e => e.id === newId) || null
  }
})

const showEdgeTypeMenu = ref(false)
const edgeTypeMenuPosition = ref({ x: 0, y: 0 })
const pendingConnection = ref<any>(null)
const isCycleConnection = ref(false)
const lastPointerPosition = ref({ x: 0, y: 0 })
const showConditionalEdgeConfig = ref(false)
const editingEdgeId = ref<string | null>(null)
const editingEdgeData = ref<any>(null)
const editingEdgeSource = ref<string | null>(null)
const editingEdgeTarget = ref<string | null>(null)
const showDeleteConfirm = ref(false)
const deleteConfirmTitle = ref('')
const deleteConfirmMessage = ref('')
const pendingDeleteAction = ref<(() => void) | null>(null)

// 保存工作流对话框相关
const showSaveWorkflowDialog = ref(false)
const isSavingWorkflow = ref(false)
const saveDialogInitialName = ref('')
const saveDialogMode = ref<'save' | 'saveAs'>('save')


// Toast 提示系统
const toast = ref({
  show: false,
  message: '',
  type: 'success' as 'success' | 'error'
})
let toastTimer: ReturnType<typeof setTimeout> | null = null

const showToast = (message: string, type: 'success' | 'error' = 'success') => {
  toast.value = { show: true, message, type }
  if (toastTimer) {
    clearTimeout(toastTimer)
  }
  toastTimer = setTimeout(() => {
    toast.value.show = false
  }, 2000)
}

// 保存成功提示
const showSaveSuccessToast = () => showToast('保存成功')


// 左侧边栏显示/隐藏与拖拽调宽（并入 useResizablePanel；collapsed 即原 showWorkflowSidebar 取反）
const {
  width: sidebarWidth,
  collapsed: sidebarCollapsed,
  startResize: startResizeSidebar,
  startPull
} = useResizablePanel({
  defaultWidth: 280,
  minWidth: 200,
  maxWidth: 500,
  collapseThreshold: 100,
  direction: 'right'
})

// 保留原 showWorkflowSidebar 读写语义（toggleWorkflowSidebar 等处直接赋值）
const showWorkflowSidebar = computed({
  get: () => !sidebarCollapsed.value,
  set: (v: boolean) => { sidebarCollapsed.value = !v }
})

// 计算主区域宽度
const mainAreaWidth = computed(() => {
  return showWorkflowSidebar.value ? `calc(100% - ${sidebarWidth.value}px)` : '100%'
})

const executionRecords = ref<any[]>([])
const expandedRecords = ref<Set<number>>(new Set())
const expandedDetailSections = ref<Map<number, Set<number>>>(new Map())
const showExecutionHistoryDrawer = ref(false)

// 监听 executionRecords 变化，自动保存执行记录（用于工作流切换时保留调试状态）
watch(executionRecords, () => {
  if (currentEditingWorkflowId.value && workflowId.value) {
    workflowStore.saveExecutionRecords(workflowId.value, executionRecords.value)
  }
}, { deep: true })

// 循环高亮状态：记录当前处于循环中的分支ID集合
const highlightedLoopBranches = ref<Set<string>>(new Set())

const menuStyle = computed(() => ({
  left: `${menuPosition.value.x}px`,
  top: `${menuPosition.value.y}px`
}))

const nodeMenuStyle = computed(() => ({
  left: `${nodeMenuPosition.value.x}px`,
  top: `${nodeMenuPosition.value.y}px`
}))

const edgeMenuStyle = computed(() => ({
  left: `${edgeMenuPosition.value.x}px`,
  top: `${edgeMenuPosition.value.y}px`
}))

const handleDragOver = (event: DragEvent) => {
  event.preventDefault()
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'copy'
  }
}

const handleDrop = (event: DragEvent) => {
  event.preventDefault()
  // 只看（readonly）模式：禁止拖入新节点
  if (props.readonly) return
  
  const nodeType = event.dataTransfer?.getData('application/vueflow-node-type')
  if (!nodeType) return
  
  // 获取画布容器的位置信息
  const vueFlowElement = (event.currentTarget as HTMLElement).querySelector('.vue-flow__container')
  if (!vueFlowElement) return
  
  const rect = vueFlowElement.getBoundingClientRect()
  
  // 计算相对于画布的坐标
  const x = event.clientX - rect.left
  const y = event.clientY - rect.top
  
  // 创建节点
  createNodeAtPosition(nodeType, x, y)
}

const createNodeAtPosition = (nodeType: string, x: number, y: number) => {
  let newNode: WorkflowNode | undefined
  let label = ''
  
  // 生成唯一节点ID：找到当前最大ID并+1
  const maxId = nodes.value.reduce((max, node) => {
    const idNum = parseInt(node.id, 10)
    return Math.max(max, idNum)
  }, 0)
  const newId = `${maxId + 1}`
  
  switch (nodeType) {
    case 'start':
      label = generateUniqueNodeLabel('开始节点')
      newNode = {
        id: newId,
        type: 'start',
        position: { x, y },
        data: { 
          label: label,
          textInput: '',
          fileInputs: []
        }
      }
      break
    case 'model':
      label = generateUniqueNodeLabel('模型节点')
      newNode = {
        id: newId,
        type: 'model',
        position: { x, y },
        data: { 
          label: label,
          onExecute: handleNodeExecute
        }
      }
      break
    case 'tool':
      label = generateUniqueNodeLabel('工具节点')
      newNode = {
        id: newId,
        type: 'tool',
        position: { x, y },
        data: { 
          label: label,
          selectedTools: [],
          toolParams: {},
          isCollapsed: true,
          onExecute: handleNodeExecute
        } as ToolNodeData
      }
      break
    case 'code':
      label = generateUniqueNodeLabel('代码执行器')
      newNode = {
        id: newId,
        type: 'code',
        position: { x, y },
        data: { 
          label: label,
          isCollapsed: true
        }
      }
      break
    default:
      return
  }
  
  if (newNode) {
    nodes.value.push(newNode)
  }
}

const showContextMenu = (event: MouseEvent) => {
  event.preventDefault()
  // 只看（readonly）模式：不出画布右键（新建节点）菜单
  if (props.readonly) return
  menuPosition.value = {
    x: event.clientX,
    y: event.clientY
  }
  showMenu.value = true
}

const hideContextMenu = () => {
  showMenu.value = false
}

const hideEdgeTypeMenu = () => {
  showEdgeTypeMenu.value = false
  pendingConnection.value = null
}

const hideNodeMenu = () => {
  showNodeMenu.value = false
}

const hideEdgeMenu = () => {
  showEdgeMenu.value = false
  selectedEdgeId.value = null
}

const loadExecutionHistory = async () => {
  try {
    if (workflowStore.isExecuting) {
      return
    }
    
    const history = await workflowStore.getExecutionHistory()
    
    executionRecords.value = history
      .filter(record => {
        const nextNode = record.next && record.next.length > 0 ? record.next[0] : null
        return nextNode && nextNode !== '__start__' && record.tasks && record.tasks.length > 0
      })
      .sort((a, b) => {
        const timeA = new Date(a.createdAt).getTime()
        const timeB = new Date(b.createdAt).getTime()
        return timeA - timeB
      })
  } catch (error) {
    console.error('Failed to load execution history:', error)
  }
}

const getNodeStatus = (record: any): string => {
  const result = record.tasks[0]?.result
  const currentNode = record.values?.currentNode
  const nodeId = record.next[0]
  
  if (result !== undefined) return '已完成'
  if (currentNode === nodeId) return '执行中'
  return '待执行'
}

const formatTime = (timestamp: string | undefined): string => {
  if (!timestamp) return '--:--:--'
  
  const date = new Date(timestamp)
  const hours = date.getHours().toString().padStart(2, '0')
  const minutes = date.getMinutes().toString().padStart(2, '0')
  const seconds = date.getSeconds().toString().padStart(2, '0')
  return `${hours}:${minutes}:${seconds}`
}

const toggleRecord = (index: number) => {
  if (expandedRecords.value.has(index)) {
    expandedRecords.value.delete(index)
  } else {
    expandedRecords.value.add(index)
  }
}

const toggleDetailSection = (recordIndex: number, sectionIndex: number) => {
  if (!expandedDetailSections.value.has(recordIndex)) {
    expandedDetailSections.value.set(recordIndex, new Set())
  }
  
  const sections = expandedDetailSections.value.get(recordIndex)!
  if (sections.has(sectionIndex)) {
    sections.delete(sectionIndex)
  } else {
    sections.add(sectionIndex)
  }
}

const toggleExecutionHistoryDrawer = () => {
  showExecutionHistoryDrawer.value = !showExecutionHistoryDrawer.value
  if (showExecutionHistoryDrawer.value) {
    refreshWorkflowRunRecords().catch(() => {})
  }
}

/** 命名工作流运行记录(M6;抽屉打开时刷新) */
const workflowRuns = ref<WorkflowRunRecord[]>([])
async function refreshWorkflowRunRecords(): Promise<void> {
  workflowRuns.value = await listWorkflowRuns()
}

const formatJSON = (data: any): string => {
  try {
    return JSON.stringify(data, null, 2)
  } catch (error) {
    return '无法解析数据'
  }
}

const getFilteredStateForDisplay = (record: any): any => {
  const nodeId = record.values?.currentNode
  const state = record.tasks[0]?.result
  
  if (!state || !nodeId) {
    return state
  }
  
  const node = nodes.value.find(n => n.id === nodeId)
  if (node && node.type === 'start') {
    return {
      text: state.text,
      files: state.files,
      messages: state.messages
    }
  }
  
  return state
}

const showDeleteConfirmDialog = (title: string, message: string, action: () => void) => {
  deleteConfirmTitle.value = title
  deleteConfirmMessage.value = message
  pendingDeleteAction.value = action
  showDeleteConfirm.value = true
}

const handleNodeStarted = (data: { nodeId: string }) => {
  const node = nodes.value.find(n => n.id === data.nodeId)
  if (!node) {
    return
  }

  const existingIndex = executionRecords.value.findIndex(r => r.next[0] === data.nodeId)
  if (existingIndex >= 0) {
    return
  }

  const record = {
    createdAt: new Date().toISOString(),
    next: [data.nodeId],
    values: { currentNode: data.nodeId },
    tasks: [{ id: data.nodeId, name: node.data.label || data.nodeId, result: undefined }],
    metadata: {
      source: 'loop',
      step: executionRecords.value.length,
      writes: {}
    }
  }

  executionRecords.value.push(record)
}

const handleNodeCompleted = (data: { nodeId: string; result?: any; values?: any }) => {
  const node = nodes.value.find(n => n.id === data.nodeId)
  if (!node) {
    return
  }

  const existingIndex = executionRecords.value.findIndex(r => r.next[0] === data.nodeId)
  if (existingIndex >= 0) {
    const existingRecord = executionRecords.value[existingIndex]
    executionRecords.value[existingIndex] = {
      ...existingRecord,
      values: data.values || existingRecord.values,
      tasks: [{ 
        id: data.nodeId, 
        name: node.data.label || data.nodeId, 
        result: data.result || {} 
      }],
      metadata: {
        ...existingRecord.metadata,
        source: 'loop',
        writes: {
          [data.nodeId]: data.result
        }
      }
    }
  }
}

// 处理循环开始事件
const handleLoopStarted = (data: { branchId: string; nodeId: string; maxIterations?: number }) => {
  highlightedLoopBranches.value.add(data.branchId)

  // 更新对应边的 data 属性，添加循环高亮标记
  edges.value = edges.value.map(edge => {
    if (edge.data?.branches) {
      // 检查分支ID匹配且目标节点匹配当前边
      const hasLoopBranch = edge.data.branches.some(
        (branch: any) => branch.id === data.branchId && branch.targetNodeId === edge.target
      )
      if (hasLoopBranch) {
        return {
          ...edge,
          data: {
            ...edge.data,
            isLoopHighlighted: true,
            loopBranchId: data.branchId
          }
        }
      }
    }
    return edge
  })
}

// 处理循环结束事件
const handleLoopCompleted = (data: { branchId: string; nodeId: string; maxIterations?: number }) => {
  // 处理清理所有高亮的情况（branchId 为 '*'）
  if (data.branchId === '*') {
    highlightedLoopBranches.value.clear()
    
    // 移除所有边的循环高亮标记
    edges.value = edges.value.map(edge => {
      if (edge.data?.isLoopHighlighted) {
        const { isLoopHighlighted, loopBranchId, ...restData } = edge.data
        return {
          ...edge,
          data: restData
        }
      }
      return edge
    })
    return
  }
  
  highlightedLoopBranches.value.delete(data.branchId)
  
  // 移除对应边的循环高亮标记
  edges.value = edges.value.map(edge => {
    if (edge.data?.loopBranchId === data.branchId) {
      const { isLoopHighlighted, loopBranchId, ...restData } = edge.data
      return {
        ...edge,
        data: restData
      }
    }
    return edge
  })
}

const handleDeleteNode = () => {
  if (selectedNodes.value.length === 0) return
  
  const nodeIdsToDelete = selectedNodes.value.map(node => node.id)
  
  showDeleteConfirmDialog(
    '删除节点',
    `确定要删除选中的 ${nodeIdsToDelete.length} 个节点吗？`,
    () => {
      nodes.value = nodes.value.filter(node => !nodeIdsToDelete.includes(node.id))
      edges.value = edges.value.filter(edge => !nodeIdsToDelete.includes(edge.source) && !nodeIdsToDelete.includes(edge.target))
      selectedNodes.value = selectedNodes.value.filter(node => !nodeIdsToDelete.includes(node.id))
      hideNodeMenu()
    }
  )
}

const handleDeleteEdge = () => {
  if (selectedEdges.value.length === 0) return
  
  const edgeIdsToDelete = selectedEdges.value.map(edge => edge.id)
  
  showDeleteConfirmDialog(
    '删除连接线',
    `确定要删除选中的 ${edgeIdsToDelete.length} 条连接线吗？`,
    () => {
      edges.value = edges.value.filter(edge => !edgeIdsToDelete.includes(edge.id))
      selectedEdges.value = selectedEdges.value.filter(edge => !edgeIdsToDelete.includes(edge.id))
      hideEdgeMenu()
    }
  )
}

const handleEditEdge = () => {
  if (!selectedEdge.value) return
  
  const edge = selectedEdge.value
  if (edge.type === 'conditional') {
    editingEdgeId.value = edge.id
    editingEdgeData.value = edge.data
    editingEdgeSource.value = edge.source
    editingEdgeTarget.value = edge.target
    // 编辑已有边时，根据该边本身是否形成循环来设置 isCycleConnection
    isCycleConnection.value = wouldFormCycle(edge.source, edge.target)
    showConditionalEdgeConfig.value = true
    hideEdgeMenu()
  } else {
    alert('普通边无法编辑，请先转换为条件边')
  }
}

const handleConvertToConditional = () => {
  if (!selectedEdge.value) return
  
  const edge = selectedEdge.value
  if (edge.type === 'default') {
    editingEdgeId.value = edge.id
    editingEdgeData.value = edge.data
    editingEdgeSource.value = edge.source
    editingEdgeTarget.value = edge.target
    // 转换边类型时，根据该边本身是否形成循环来设置 isCycleConnection
    isCycleConnection.value = wouldFormCycle(edge.source, edge.target)
    showConditionalEdgeConfig.value = true
    hideEdgeMenu()
  }
}

const handleConvertToDefault = () => {
  if (!selectedEdge.value) return
  
  const edge = selectedEdge.value
  if (edge.type === 'conditional') {
    const updatedEdge = {
      ...edge,
      type: 'default',
      data: {}
    }
    edges.value = edges.value.map(e => e.id === edge.id ? updatedEdge : e)
    hideEdgeMenu()
  }
}

const handleDeleteConfirm = () => {
  if (pendingDeleteAction.value) {
    pendingDeleteAction.value()
  }
  showDeleteConfirm.value = false
  pendingDeleteAction.value = null
}

const handleDeleteCancel = () => {
  showDeleteConfirm.value = false
  pendingDeleteAction.value = null
}

// 保存工作流相关函数
const showSaveDialog = (mode: 'save' | 'saveAs' = 'save') => {
  saveDialogMode.value = mode
  // 初始名取当前打开的 YAML 工作流标题/名（旧 JSON 工作流通道已退役）
  saveDialogInitialName.value = currentYamlDef.value?.title || currentYamlDef.value?.name || ''
  showSaveWorkflowDialog.value = true
}

// 智能保存：当前画布是命名工作流（YAML）时直接覆盖保存，否则弹出保存对话框（新保存一律落 YAML）
const smartSaveWorkflow = () => {
  // YAML 真相源通道:当前画布是命名工作流时直接覆盖保存(运行时状态序列化时剥掉)
  if (currentYamlDef.value) {
    isSavingWorkflow.value = true
    saveYamlWorkflow()
      .then(() => showSaveSuccessToast())
      .catch((error) => {
        console.error('保存工作流失败:', error)
        alert(`保存工作流失败:${error instanceof Error ? error.message : '未知错误'}`)
      })
      .finally(() => {
        isSavingWorkflow.value = false
      })
    return
  }
  // 没有工作流，弹出保存对话框
  showSaveDialog('save')
}

const handleSaveWorkflowConfirm = async (name: string, key: string) => {
  isSavingWorkflow.value = true
  try {
    // 清除自动保存定时器，防止保存过程中触发自动保存
    if (autoSaveTimer.value) {
      clearTimeout(autoSaveTimer.value)
      autoSaveTimer.value = null
    }

    // 唯一真相源通道:新保存一律落 YAML(用户级 ~/.chill/workflows/<key>.yaml)
    await saveYamlWorkflow(key, name)

    showSaveWorkflowDialog.value = false
    showSaveSuccessToast()
  } catch (error) {
    console.error('保存工作流失败:', error)
    alert('保存工作流失败，请重试')
  } finally {
    isSavingWorkflow.value = false
  }
}

const handleSaveWorkflowCancel = () => {
  showSaveWorkflowDialog.value = false
}

// ---------- 单模型节点改道：模板编辑器状态与保存 ----------
const showTemplateEditor = ref(false)
const templateEditorPrefill = ref<SubagentTemplate | undefined>(undefined)
// 编辑器模式状态（M4 改道用 create+预填；侧栏入口用 create 空表/edit 回填/内置只读另存为）
const templateEditorMode = ref<'create' | 'edit'>('create')
const templateEditorReadonly = ref(false)
const templateEditorKey = ref(0)

// ---------- 单 Agent 模板列表（侧栏分区数据源；与 ModelSettings 原分类规则同款） ----------

/** 本地模板（内置/个人/项目；远程模板归设置页远程平台，不在此列） */
const localTemplates = computed<SubagentTemplate[]>(() => {
  try {
    return getTemplateManager().getAllTemplates().filter((t) => {
      const type = (t.type as string | undefined) ?? 'builtin'
      return type === 'builtin' || type === 'custom'
    })
  } catch {
    return []
  }
})

function templateLevel(t: SubagentTemplate): 'builtin' | 'user' | 'project' {
  const type = (t.type as string | undefined) ?? 'builtin'
  if (type === 'builtin') return 'builtin'
  return t.priority_scope === 'project' ? 'project' : 'user'
}
const TEMPLATE_LEVEL_LABEL: Record<string, string> = { builtin: '内置', user: '个人', project: '项目' }

function isBuiltinTemplate(t?: SubagentTemplate): boolean {
  return !!t && ((t.type as string | undefined) ?? 'builtin') === 'builtin'
}

/** 打开模板编辑器：create = 空表新建；edit = 回填（内置为只读+另存为） */
function openTemplateEditor(mode: 'create' | 'edit', template?: SubagentTemplate): void {
  templateEditorMode.value = mode
  templateEditorReadonly.value = mode === 'edit' && isBuiltinTemplate(template)
  templateEditorPrefill.value = template
  templateEditorKey.value++  // 强制重挂载，避免不同模板间状态串扰
  showTemplateEditor.value = true
}

/** 删除模板（非内置；确认后删文件——个人级 fs.watch 自动生效，项目级触发重扫） */
async function handleTemplateDelete(t: SubagentTemplate): Promise<void> {
  if (!t.sourcePath) return
  showDeleteConfirmDialog('删除模板', `删除模板「${t.name}」？删除后 @${t.subagent_type} 将不可用。`, () => {
    deleteTemplateFile(t.sourcePath!, templateLevel(t) === 'project' ? 'project' : 'user').catch((error) => {
      showToast(`删除失败: ${error instanceof Error ? error.message : '未知错误'}`, 'error')
    })
  })
}

// ---------- 命名工作流(YAML 真相源,M2):侧栏列表/打开/删除/保存改道 ----------

const yamlWorkflows = ref<WorkflowDefinition[]>([])
const yamlWorkflowErrors = ref<string[]>([])
const yamlWorkflowWarnings = ref<string[]>([])
/** 当前画布打开的 YAML 工作流(非空时保存走 YAML 通道而非旧 JSON 通道) */
const currentYamlDef = ref<WorkflowDefinition | null>(null)

/** 首次刷新不做"新增检测"(避免启动时误自动打开) */
let yamlListInitialized = false

function refreshYamlWorkflows(): void {
  const prevNames = new Set(yamlWorkflows.value.map((w) => w.name))
  yamlWorkflows.value = listWorkflowAssets()
  yamlWorkflowErrors.value = getWorkflowAssetErrors()
  yamlWorkflowWarnings.value = getWorkflowAssetWarnings()

  // 创建即所见(M4):恰好新增一个工作流且画布空闲(未在编辑任何内容)时,自动在画布打开它
  if (yamlListInitialized) {
    const added = yamlWorkflows.value.filter((w) => !prevNames.has(w.name))
    const canvasIdle = !currentYamlDef.value && !currentEditingWorkflowId.value && nodes.value.length === 0
    if (added.length === 1 && canvasIdle) {
      openYamlWorkflow(added[0])
    }
  }
  yamlListInitialized = true
}

/** 打开 YAML 工作流到画布(无坐标自动布局;model 节点回挂执行函数;保存现场语义同旧列表) */
function openYamlWorkflow(def: WorkflowDefinition): void {
  if (currentEditingWorkflowId.value) {
    workflowStore.saveWorkflowData(workflowId.value, nodes.value, edges.value)
  }
  const { nodes: canvasNodes, edges: canvasEdges } = definitionToCanvasWithLayout(def)
  nodes.value = canvasNodes.map((n) =>
    n.type === 'model' ? { ...n, data: { ...n.data, onExecute: handleNodeExecute } } : n,
  ) as WorkflowNode[]
  edges.value = canvasEdges as Edge[]
  executionRecords.value = []
  currentYamlDef.value = def
  currentEditingWorkflowId.value = `yaml:${def.name}`
}

/** 侧栏运行入口:打开到画布;无必填入参时直接开始执行(同一引擎,画布草稿试跑通道) */
async function runYamlWorkflow(def: WorkflowDefinition): Promise<void> {
  openYamlWorkflow(def)
  await nextTick()
  const hasRequiredInputs = (def.inputs ?? []).some((i) => i.required)
  if (!hasRequiredInputs) {
    executeWorkflow()
  }
  // 有必填入参时停在画布:用户在开始节点填写输入后点执行(画布即入参表单)
}

/** 删除 YAML 工作流文件(确认后删文件,watcher 热生效刷新列表) */
async function handleYamlWorkflowDelete(def: WorkflowDefinition): Promise<void> {
  // 应用内原生确认对话框(window.confirm 在 Electron 渲染层不可靠,统一走 ConfirmDialog 组件);
  // 删除失败经 toast 可见(此前异常被静默吞掉)
  showDeleteConfirmDialog(
    '删除工作流',
    `删除工作流「${def.title || def.name}」？文件 ${def.sourcePath} 将被删除。`,
    () => {
      void doDeleteWorkflow(def)
    },
  )
}

async function doDeleteWorkflow(def: WorkflowDefinition): Promise<void> {
  try {
    await deleteWorkflowAsset(def)
    if (currentYamlDef.value?.name === def.name) {
      currentYamlDef.value = null
      nodes.value = []
      edges.value = []
      currentEditingWorkflowId.value = null
    }
  } catch (error) {
    showToast(`删除失败: ${error instanceof Error ? error.message : '未知错误'}`, 'error')
  }
}

/**
 * 画布 → YAML 保存(唯一真相源通道)。
 * key/title 省略时按当前打开的 YAML 工作流覆盖保存(保留其元信息与项目级来源)。
 */
async function saveYamlWorkflow(key?: string, title?: string): Promise<void> {
  const base = currentYamlDef.value
  const def = canvasToDefinition(nodes.value as unknown as WorkflowNode[], edges.value, {
    name: key ?? base!.name,
    title: title ?? base?.title,
    version: WORKFLOW_DSL_VERSION,
    description: base?.description,
    when_to_use: base?.when_to_use,
    inputs: base?.inputs ?? [{ name: 'input', type: 'text', required: false }],
  })
  if (!key && base?.scope) def.scope = base.scope
  if (!key && base?.sourcePath) def.sourcePath = base.sourcePath
  await saveWorkflowAsset(def)
  const saved = getWorkflowAssetService().getWorkflowByName(def.name)
  currentYamlDef.value = saved ?? def
  currentEditingWorkflowId.value = `yaml:${def.name}`
}

/** 覆盖提示数据源：slug → 级别文案（与 ModelSettings 同一分类规则） */
const templateSlugMap = computed(() => {
  const map: Record<string, string> = {}
  try {
    for (const t of getTemplateManager().getAllTemplates()) {
      const type = (t.type as string | undefined) ?? 'builtin'
      if (type !== 'builtin' && type !== 'custom') continue
      map[t.subagent_type] = type === 'builtin' ? '内置级' : t.priority_scope === 'project' ? '项目级' : '个人级'
    }
  } catch { /* 模板管理器未就绪时无提示 */ }
  return map
})

const handleTemplateEditorSave = async (payload: { slug: string; storage: 'user' | 'project'; content: string; renameFrom?: string }): Promise<void> => {
  await saveTemplateFile(payload)
  if (payload.renameFrom) {
    // 迁移语义：编辑模式改标识 = 删旧写新（旧模板只可能是个人/项目级自定义）
    const old = templateEditorPrefill.value
    if (old?.sourcePath) {
      await deleteTemplateFile(old.sourcePath, templateLevel(old) === 'project' ? 'project' : 'user')
    }
  }
  showTemplateEditor.value = false
  alert(`已保存为模板，@${payload.slug} 立即可用`)
}

/** 内置只读 → 另存为：新建模式预填（标识默认同名，语义 = 覆盖内置） */
const handleTemplateFork = (): void => {
  const t = templateEditorPrefill.value
  if (!t) return
  templateEditorMode.value = 'create'
  templateEditorReadonly.value = false
  templateEditorKey.value++  // 强制编辑器重挂载以脱离只读态
}

// 工作流侧边栏相关函数
const toggleWorkflowSidebar = () => {
  showWorkflowSidebar.value = !showWorkflowSidebar.value
}

// 侧边栏调整大小与拉出均走 useResizablePanel
const startPullSidebar = (e: MouseEvent) => startPull(e)


// 当前正在编辑的工作流ID（用于草稿管理）
const currentEditingWorkflowId = ref<string | null>(null)

// 当前工作流的唯一标识（用于工作流隔离）
// 当 currentEditingWorkflowId 为 null 时，生成临时ID
const workflowId = computed(() => {
  if (currentEditingWorkflowId.value) {
    return currentEditingWorkflowId.value
  }
  // 生成临时ID，格式：temp_${timestamp}
  return `temp_${Date.now()}`
})

// 创建当前工作流的命名空间事件总线
const workflowEventBusInstance = computed(() => {
  return new NamespacedWorkflowEventBus(workflowId.value)
})

// 提供工作流上下文（用于子组件注入）
// 使用 computed 确保 workflowId 变化时子组件能获取最新值
const workflowContext = computed(() => ({
  workflowId: workflowId.value,
  eventBus: workflowEventBusInstance.value,
  // 节点"编辑该模板"入口(模板是真相源,配置只在模板里改)
  onEditTemplate: (subagentType: string): void => {
    const t = getTemplateManager().getTemplateByType(subagentType)
    if (t) openTemplateEditor('edit', t)
    else showToast(`模板 "${subagentType}" 不存在或已被删除`, 'error')
  },
  getUpstreamNode: (nodeId: string): WorkflowNode | null => {
    const incomingEdge = edges.value.find(e => e.target === nodeId)
    if (!incomingEdge) return null
    return nodes.value.find(n => n.id === incomingEdge.source) || null
  },
  getUpstreamOutput: (nodeId: string): string | null => {
    const upstreamNode = edges.value.find(e => e.target === nodeId)
    if (!upstreamNode) return null
    
    const sourceNode = nodes.value.find(n => n.id === upstreamNode.source)
    if (!sourceNode) return null
    
    const nodeData = sourceNode.data as any
    
    if (sourceNode.type === 'start' && nodeData.textInput) {
      return nodeData.textInput
    }
    
    if (nodeData.executionResult?.contentBlocks) {
      const textBlocks = nodeData.executionResult.contentBlocks
        .filter((block: any) => block.type === 'text' && block.content)
        .map((block: any) => block.content)
      if (textBlocks.length > 0) {
        return textBlocks.join('\n')
      }
    }
    
    return null
  }
}))
provide('workflowContext', workflowContext)

// 新建工作流（编排画布）：保存当前现场到 workflowStore 内存，回到空白画布；保存时落 YAML 文件
const createNewWorkflow = () => {
  if (currentEditingWorkflowId.value) {
    workflowStore.saveWorkflowData(workflowId.value, nodes.value, edges.value)
    workflowStore.saveExecutionRecords(workflowId.value, executionRecords.value)
  }
  currentYamlDef.value = null
  nodes.value = []
  edges.value = []
  executionRecords.value = []
  currentEditingWorkflowId.value = null
}

/** 消费设置资产中心暂存的画布指令(openYamlWorkflow/createNewWorkflow 同款逻辑;
 *  一次性消费:onMounted 与 OPEN_WORKFLOW_CANVAS_EVENT 两处入口) */
const consumeStagedCanvas = (): void => {
  const cmd = consumeStagedWorkflowCanvas()
  if (!cmd) return
  if (cmd.kind === 'new') {
    createNewWorkflow()
    return
  }
  const def = listWorkflowAssets().find((w) => w.sourcePath === cmd.sourcePath)
  if (def) openYamlWorkflow(def)
}


const handleKeyDown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    if (showExecutionHistoryDrawer.value) {
      showExecutionHistoryDrawer.value = false
      return
    }
  }
  
  if (event.key === 'Delete') {
    // 只看（readonly）模式：Delete 键不删节点/连线
    if (props.readonly) return
    if (selectedNodes.value.length > 0) {
      const nodeIdsToDelete = selectedNodes.value.map(node => node.id)
      
      showDeleteConfirmDialog(
        '删除节点',
        `确定要删除选中的 ${nodeIdsToDelete.length} 个节点吗？`,
        () => {
          nodes.value = nodes.value.filter(node => !nodeIdsToDelete.includes(node.id))
          edges.value = edges.value.filter(edge => !nodeIdsToDelete.includes(edge.source) && !nodeIdsToDelete.includes(edge.target))
          selectedNodes.value = selectedNodes.value.filter(node => !nodeIdsToDelete.includes(node.id))
          hideNodeMenu()
        }
      )
    } else if (selectedEdges.value.length > 0) {
      const edgeIdsToDelete = selectedEdges.value.map(edge => edge.id)
      
      showDeleteConfirmDialog(
        '删除连接线',
        `确定要删除选中的 ${edgeIdsToDelete.length} 条连接线吗？`,
        () => {
          edges.value = edges.value.filter(edge => !edgeIdsToDelete.includes(edge.id))
          selectedEdges.value = selectedEdges.value.filter(edge => !edgeIdsToDelete.includes(edge.id))
          hideEdgeMenu()
        }
      )
    }
  }
}

/**
 * 检测从 target 节点是否能到达 source 节点（使用 DFS）
 * 如果能到达，说明添加 source->target 这条边会形成循环
 */
const canReach = (
  fromId: string,
  toId: string,
  visited = new Set<string>()
): boolean => {
  if (fromId === toId) return true
  if (visited.has(fromId)) return false

  visited.add(fromId)

  // 获取从 fromId 出发的所有边
  const outgoingEdges = edges.value.filter(e => e.source === fromId)

  for (const edge of outgoingEdges) {
    if (canReach(edge.target, toId, visited)) {
      return true
    }
  }

  return false
}

/**
 * 检测添加 source->target 这条边是否会形成循环
 */
const wouldFormCycle = (sourceId: string, targetId: string): boolean => {
  // 自连接必然形成循环
  if (sourceId === targetId) return true

  // 如果 target 可以通过现有边到达 source，则形成循环
  return canReach(targetId, sourceId)
}

const handlePointerUp = (event: PointerEvent) => {
  lastPointerPosition.value = {
    x: event.clientX,
    y: event.clientY
  }
}

const handleConnect = (connection: any) => {
  // 只看（readonly）模式：禁止连线（nodes-connectable 已关，双保险）
  if (props.readonly) return
  const sourceNode = nodes.value.find(n => n.id === connection.source)
  const targetNode = nodes.value.find(n => n.id === connection.target)

  const existingEdge = edges.value.find(
    e => e.source === connection.source && e.target === connection.target
  )
  if (existingEdge) {
    console.warn('Connection already exists')
    return
  }

  if (sourceNode?.type === 'model' && targetNode?.type === 'start') {
    console.warn('Cannot connect model node to start node')
    return
  }

  // 检测是否会形成循环（包括自循环和多节点循环）
  isCycleConnection.value = wouldFormCycle(connection.source, connection.target)

  pendingConnection.value = connection
  // 使用最后一次 pointerup 的鼠标位置，因为 connectionPosition 在连接完成时可能已被重置
  edgeTypeMenuPosition.value = {
    x: lastPointerPosition.value.x,
    y: lastPointerPosition.value.y
  }
  showEdgeTypeMenu.value = true
}

const handleEdgeTypeSelect = (edgeType: 'default' | 'conditional') => {
  if (!pendingConnection.value) return

  const connection = pendingConnection.value

  if (edgeType === 'conditional') {
    showEdgeTypeMenu.value = false
    showConditionalEdgeConfig.value = true
  } else {
    // 普通边禁止形成循环的连接（包括自循环和多节点循环）
    if (isCycleConnection.value) {
      console.warn('Cannot create cycle connection with default edge')
      showEdgeTypeMenu.value = false
      pendingConnection.value = null
      return
    }
    const newEdge: Edge = {
      id: `edge_${edges.value.length + 1}`,
      source: connection.source,
      target: connection.target,
      type: 'default',
      animated: true
    }
    edges.value.push(newEdge)
    showEdgeTypeMenu.value = false
    pendingConnection.value = null
  }
}

const handleConditionalEdgeConfirm = (config: { branches: BranchConfig[]; fallbackNodeId?: string }) => {
  if (!pendingConnection.value) return

  const connection = pendingConnection.value
  const sourceNodeId = connection.source

  // 为每个分支创建一条独立的边，共享相同的 branches 数据
  config.branches.forEach((branch, index) => {
    const newEdge: ConditionalEdgeType = {
      id: `edge_${Date.now()}_${index}`,
      source: sourceNodeId,
      target: branch.targetNodeId || '__end__',
      type: EdgeType.CONDITIONAL,
      animated: true,
      data: {
        branches: config.branches,
        fallbackNodeId: config.fallbackNodeId,
        // 标记这是哪个分支的边，用于编辑时识别
        branchId: branch.id
      }
    }
    edges.value.push(newEdge)
  })

  showConditionalEdgeConfig.value = false
  pendingConnection.value = null
}

const handleConditionalEdgeUpdate = (edgeId: string, config: { branches: BranchConfig[]; fallbackNodeId?: string }) => {
  // 找到当前编辑的边
  const currentEdge = edges.value.find(e => e.id === edgeId)
  if (!currentEdge) return

  const sourceNodeId = currentEdge.source

  // 只删除当前编辑的这条边，保留该源节点的其他边
  edges.value = edges.value.filter(e => e.id !== edgeId)

  // 为每个分支创建新的边
  config.branches.forEach((branch, index) => {
    const newEdge: ConditionalEdgeType = {
      id: `edge_${Date.now()}_${index}`,
      source: sourceNodeId,
      target: branch.targetNodeId || '__end__',
      type: EdgeType.CONDITIONAL,
      animated: true,
      data: {
        branches: config.branches,
        fallbackNodeId: config.fallbackNodeId,
        branchId: branch.id
      }
    }
    edges.value.push(newEdge)
  })

  showConditionalEdgeConfig.value = false
  editingEdgeId.value = null
  editingEdgeData.value = null
  editingEdgeSource.value = null
  editingEdgeTarget.value = null
}

const handleConditionalEdgeCancel = () => {
  showConditionalEdgeConfig.value = false
  pendingConnection.value = null
  editingEdgeId.value = null
  editingEdgeData.value = null
  editingEdgeSource.value = null
  editingEdgeTarget.value = null
}

/** 生成唯一的节点名称 */
const generateUniqueNodeLabel = (baseLabel: string): string => {
  // 获取所有现有节点的名称
  const existingLabels = new Set(nodes.value.map(node => node.data?.label).filter(Boolean))
  
  // 如果基础名称不存在，直接使用
  if (!existingLabels.has(baseLabel)) {
    return baseLabel
  }
  
  // 如果已存在，添加数字后缀
  let counter = 1
  let newLabel = `${baseLabel}${counter}`
  
  while (existingLabels.has(newLabel)) {
    counter++
    newLabel = `${baseLabel}${counter}`
  }
  
  return newLabel
}

const handleAddNode = (nodeType: string) => {
  let newNode: WorkflowNode | undefined
  let label = ''
  
  // 生成唯一节点ID：找到当前最大ID并+1
  const maxId = nodes.value.reduce((max, node) => {
    const idNum = parseInt(node.id, 10)
    return Math.max(max, idNum)
  }, 0)
  const newId = `${maxId + 1}`
  
  switch (nodeType) {
    case 'start':
      label = generateUniqueNodeLabel('开始节点')
      newNode = {
        id: newId,
        type: 'start',
        position: { x: 250, y: nodes.value.length * 100 + 25 },
        data: { 
          label: label,
          textInput: '',
          fileInputs: []
        }
      }
      break
    case 'model':
      label = generateUniqueNodeLabel('模型节点')
      newNode = {
        id: newId,
        type: 'model',
        position: { x: 250, y: nodes.value.length * 100 + 25 },
        data: { 
          label: label,
          onExecute: handleNodeExecute
        }
      }
      break
    case 'code':
      label = generateUniqueNodeLabel('代码执行器')
      newNode = {
        id: newId,
        type: 'code',
        position: { x: 250, y: nodes.value.length * 100 + 25 },
        data: { 
          label: label,
          isCollapsed: true
        }
      }
      break
    case 'output':
      label = generateUniqueNodeLabel('输出节点')
      newNode = {
        id: newId,
        type: 'default',
        position: { x: 250, y: nodes.value.length * 100 + 25 },
        data: { 
          label: label
        }
      }
      break
    default:
      return
  }
  
  if (newNode) {
    nodes.value.push(newNode)
  }
  hideContextMenu()
}

defineExpose({
  executeWorkflow,
  toggleSidebar: toggleWorkflowSidebar,
  isSidebarOpen: () => showWorkflowSidebar.value,
  saveWorkflow: smartSaveWorkflow,
  saveWorkflowAs: () => showSaveDialog('saveAs'),
  getWorkflowData: () => ({ nodes: nodes.value, edges: edges.value }),
  getCurrentWorkflowInfo: () => ({
    workflowId: currentEditingWorkflowId.value,
    isTemporary: !currentEditingWorkflowId.value || currentEditingWorkflowId.value.startsWith('temp_'),
    hasWorkflow: nodes.value.length > 0,
    workflowVersion: 1
  })
})

// 处理节点创建事件（点击节点图标）
const handleNodeCreate = ({ nodeType }: { nodeType: string }) => {
  // 只看（readonly）模式：不创建节点
  if (props.readonly) return
  // 计算画布中心位置
  const vueFlowContainer = document.querySelector('.vue-flow__container')
  if (!vueFlowContainer) return
  
  const rect = vueFlowContainer.getBoundingClientRect()
  const centerX = rect.width / 2
  const centerY = rect.height / 2
  
  // 添加随机偏移，避免重叠
  const offsetX = (Math.random() - 0.5) * 100
  const offsetY = (Math.random() - 0.5) * 100
  
  createNodeAtPosition(nodeType, centerX + offsetX, centerY + offsetY)
}

onMounted(() => {
  // 命名工作流(YAML)列表:初始化资产服务 + 订阅热重载
  initWorkflowAssetService().then(() => {
    refreshYamlWorkflows()
    consumeStagedCanvas() // 设置资产中心"编辑画布/新建"暂存指令(onMounted 消费点)
  }).catch(() => {})
  eventBus.on(WORKFLOWS_RELOADED_EVENT, refreshYamlWorkflows)
  // 暂存指令事件 nudge:本视图已挂载(设置覆盖在其上)时 onMounted 不会再触发,经事件即时消费
  eventBus.on(OPEN_WORKFLOW_CANVAS_EVENT, consumeStagedCanvas)
  // 团队(班底)资产服务初始化(幂等;团队编辑已迁设置资产中心,此处仅保服务装配)
  initTeamAssetService().catch(() => {})

  onPaneClick(() => {
    hideContextMenu()
    hideEdgeTypeMenu()
    hideNodeMenu()
    hideEdgeMenu()
  })

  // 监听节点创建事件（点击节点图标）
  workflowEventBus.on(WORKFLOW_EVENTS.NODE_CREATE, handleNodeCreate)

  // 监听分支悬停事件，显示预览边
  workflowEventBus.on(WORKFLOW_EVENTS.BRANCH_HOVER, ({ sourceNodeId, targetNodeId }: { sourceNodeId: string; targetNodeId: string }) => {
    // 移除之前的预览边
    if (previewEdge.value) {
      edges.value = edges.value.filter(e => e.id !== previewEdge.value!.id)
      previewEdge.value = null
    }

    // 检查目标节点是否存在
    const targetNode = nodes.value.find(n => n.id === targetNodeId)
    if (!targetNode) return

    // 创建预览边（不显示标签，只高亮连接线）
    const newPreviewEdge: Edge = {
      id: `preview_branch_${Date.now()}`,
      source: sourceNodeId,
      target: targetNodeId,
      type: 'default',
      animated: true,
      style: {
        stroke: '#3b82f6',
        strokeWidth: 3,
        strokeDasharray: '5, 5'
      },
      data: {}
    }

    previewEdge.value = newPreviewEdge
    edges.value.push(newPreviewEdge)
  })

  // 监听分支离开事件，移除预览边
  workflowEventBus.on(WORKFLOW_EVENTS.BRANCH_LEAVE, () => {
    if (previewEdge.value) {
      edges.value = edges.value.filter(e => e.id !== previewEdge.value!.id)
      previewEdge.value = null
    }
  })
  
  loadExecutionHistory()
  
  onNodeContextMenu((event: any) => {
    // 只看（readonly）模式：不出节点右键菜单
    if (props.readonly) return
    event.event.preventDefault()
    event.event.stopPropagation()
    
    const node = nodes.value.find(n => n.id === event.node.id)
    if (node && !selectedNodes.value.find(n => n.id === node.id)) {
      selectedNodes.value.push(node)
    }
    
    nodeMenuPosition.value = {
      x: event.event.clientX,
      y: event.event.clientY
    }
    showNodeMenu.value = true
  })
  
  onEdgeContextMenu((event: any) => {
    // 只看（readonly）模式：不出连线右键菜单
    if (props.readonly) return
    event.event.preventDefault()
    event.event.stopPropagation()
    selectedEdgeId.value = event.edge.id
    
    const edge = edges.value.find(e => e.id === event.edge.id)
    if (edge && !selectedEdges.value.find(e => e.id === edge.id)) {
      selectedEdges.value.push(edge)
    }
    
    edgeMenuPosition.value = {
      x: event.event.clientX,
      y: event.event.clientY
    }
    showEdgeMenu.value = true
  })
  
  onEdgeDoubleClick((event: any) => {
    // 只看（readonly）模式：双击不打开连线配置
    if (props.readonly) return
    event.event.preventDefault()
    window.getSelection()?.removeAllRanges()
    const edge = edges.value.find(e => e.id === event.edge.id)
    if (edge && edge.type === 'conditional') {
      editingEdgeId.value = edge.id
      editingEdgeData.value = edge.data
      editingEdgeSource.value = edge.source
      editingEdgeTarget.value = edge.target
      // 双击编辑边时，根据该边本身是否形成循环来设置 isCycleConnection
      isCycleConnection.value = wouldFormCycle(edge.source, edge.target)
      showConditionalEdgeConfig.value = true
    }
  })
  
  workflowEventBus.on(WORKFLOW_EVENTS.EDGE_EDIT, ({ edgeId }: { edgeId: string }) => {
    // 只看（readonly）模式：不打开连线编辑
    if (props.readonly) return
    const edge = edges.value.find(e => e.id === edgeId)
    if (edge && edge.type === 'conditional') {
      editingEdgeId.value = edge.id
      editingEdgeData.value = edge.data
      editingEdgeSource.value = edge.source
      editingEdgeTarget.value = edge.target
      // 通过事件编辑边时，根据该边本身是否形成循环来设置 isCycleConnection
      isCycleConnection.value = wouldFormCycle(edge.source, edge.target)
      showConditionalEdgeConfig.value = true
    }
  })
  
  workflowEventBus.on(WORKFLOW_EVENTS.EDGE_DELETE, ({ edgeId }: { edgeId: string }) => {
    // 只看（readonly）模式：不删连线
    if (props.readonly) return
    const edge = edges.value.find(e => e.id === edgeId)
    if (!edge || edge.type !== 'conditional') return

    const sourceNodeId = edge.source
    const branchId = edge.data?.branchId

    // 1. 将当前边降级为普通边
    const updatedEdges = edges.value.map(e => {
      if (e.id === edgeId) {
        return {
          ...e,
          type: 'default' as const,
          data: {}
        }
      }
      return e
    })

    // 2. 从其他条件边的 branches 配置中移除该分支
    edges.value = updatedEdges.map(e => {
      if (e.source === sourceNodeId && e.type === 'conditional' && e.data?.branches) {
        const updatedBranches = e.data.branches.filter(
          (b: any) => b.id !== branchId
        )
        return {
          ...e,
          data: {
            ...e.data,
            branches: updatedBranches
          }
        }
      }
      return e
    })
  })
  
  workflowEventBus.on(WORKFLOW_EVENTS.EDGE_CONTEXT_MENU, ({ edgeId, clientX, clientY }: { edgeId: string, clientX: number, clientY: number }) => {
    // 只看（readonly）模式：不出连线右键菜单（自定义边触发路径）
    if (props.readonly) return
    selectedEdgeId.value = edgeId
    
    const edge = edges.value.find(e => e.id === edgeId)
    if (edge && !selectedEdges.value.find(e => e.id === edge.id)) {
      selectedEdges.value.push(edge)
    }
    
    edgeMenuPosition.value = {
      x: clientX,
      y: clientY
    }
    showEdgeMenu.value = true
  })
  
  // 注意：执行完成后不再重新加载历史记录
  // 因为执行过程中的 NODE_STARTED/NODE_COMPLETED 事件已经准确记录了执行历史
  // 重新加载会替换掉这些记录，导致显示为空
  // workflowEventBus.on(WORKFLOW_EVENTS.STREAM_COMPLETE, () => {
  //   setTimeout(() => {
  //     loadExecutionHistory()
  //   }, 200)
  // })

  workflowEventBus.on(WORKFLOW_EVENTS.NODE_STARTED, handleNodeStarted)
  workflowEventBus.on(WORKFLOW_EVENTS.NODE_COMPLETED, handleNodeCompleted)
  workflowEventBus.on(WORKFLOW_EVENTS.LOOP_STARTED, handleLoopStarted)
  workflowEventBus.on(WORKFLOW_EVENTS.LOOP_COMPLETED, handleLoopCompleted)
  
  onNodesChange((changes: any[]) => {
    changes.forEach((change: any) => {
      if (change.type === 'select') {
        if (change.selected) {
          const node = nodes.value.find(n => n.id === change.id)
          if (node && !selectedNodes.value.find(n => n.id === node.id)) {
            selectedNodes.value.push(node)
          }
        } else {
          selectedNodes.value = selectedNodes.value.filter(n => n.id !== change.id)
        }
      }
    })
  })
  
  onEdgesChange((changes: any[]) => {
    changes.forEach((change: any) => {
      if (change.type === 'select') {
        if (change.selected) {
          const edge = edges.value.find(e => e.id === change.id)
          if (edge && !selectedEdges.value.find(e => e.id === edge.id)) {
            selectedEdges.value.push(edge)
          }
        } else {
          selectedEdges.value = selectedEdges.value.filter(e => e.id !== change.id)
        }
      }
    })
  })
  
  window.addEventListener('keydown', handleKeyDown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeyDown)
  workflowEventBus.off(WORKFLOW_EVENTS.NODE_STARTED, handleNodeStarted)
  workflowEventBus.off(WORKFLOW_EVENTS.NODE_COMPLETED, handleNodeCompleted)
  workflowEventBus.off(WORKFLOW_EVENTS.LOOP_STARTED, handleLoopStarted)
  workflowEventBus.off(WORKFLOW_EVENTS.LOOP_COMPLETED, handleLoopCompleted)
  workflowEventBus.off(WORKFLOW_EVENTS.NODE_CREATE, handleNodeCreate)
  eventBus.off(WORKFLOWS_RELOADED_EVENT, refreshYamlWorkflows)
  eventBus.off(OPEN_WORKFLOW_CANVAS_EVENT, consumeStagedCanvas)

  // 清理预览边
  if (previewEdge.value) {
    edges.value = edges.value.filter(e => e.id !== previewEdge.value!.id)
    previewEdge.value = null
  }

  // 清理自动保存定时器
  if (autoSaveTimer.value) {
    clearTimeout(autoSaveTimer.value)
    autoSaveTimer.value = null
  }

  // 清理工作流状态，释放内存
  workflowStore.cleanupWorkflow(workflowId.value)
})
</script>

<style scoped>
.workflow-view-layout {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  background-color: #ffffff;
  position: relative;
  overflow: hidden;
}

/* 只看（readonly）模式：节点内部输入框/按钮整体不可交互（画布平移缩放保留） */
.readonly-mode :deep(.vue-flow__node) {
  pointer-events: none;
}

/* 顶部工具栏（编辑器自持，自 Home 菜单行迁入） */
.workflow-toolbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--spacing-2);
  padding: var(--spacing-2) var(--spacing-3);
  border-bottom: 1px solid #e5e7eb;
  background-color: #ffffff;
  min-height: 34px;
}

.workflow-body {
  flex: 1 1 auto;
  display: flex;
  flex-direction: row;
  min-height: 0;
  position: relative;
  overflow: hidden;
}

/* 工作流侧边栏切换按钮样式 */
.workflow-sidebar-toggle-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: var(--radius-lg);
  background-color: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.workflow-sidebar-toggle-btn:hover {
  background-color: var(--background-secondary);
  color: var(--primary-color);
}

.workflow-sidebar-toggle-btn:active {
  transform: scale(0.95);
}

.workflow-sidebar-toggle-btn svg {
  display: block;
  width: 18px;
  height: 18px;
}

/* 保存工作流按钮样式 */
.save-workflow-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: var(--radius-lg);
  background-color: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.save-workflow-btn:hover {
  background-color: var(--background-secondary);
  color: var(--primary-color);
}

.save-workflow-btn:active {
  transform: scale(0.95);
}

.save-workflow-btn svg {
  display: block;
  width: 18px;
  height: 18px;
}

/* 执行工作流按钮样式 */
.execute-workflow-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: var(--radius-lg);
  background-color: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.execute-workflow-btn:hover:not(:disabled) {
  background-color: var(--primary-color);
  color: white;
}

.execute-workflow-btn:active:not(:disabled) {
  transform: scale(0.95);
}

.execute-workflow-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.execute-workflow-btn svg {
  display: block;
  width: 18px;
  height: 18px;
}

/* 工作流侧边栏 */
.workflow-sidebar {
  display: flex;
  flex-direction: column;
  height: 100%;
  background-color: #ffffff;
  border-right: 1px solid #e5e7eb;
  position: relative;
  flex-shrink: 0;
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid #e5e7eb;
  flex-shrink: 0;
}

.sidebar-title {
  font-size: 16px;
  font-weight: 600;
  color: #111827;
}

.sidebar-close-btn {
  background: none;
  border: none;
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  color: #6b7280;
  transition: all 0.2s;
}

.sidebar-close-btn:hover {
  background-color: #f3f4f6;
  color: #111827;
}

.sidebar-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sidebar-new-btn {
  background: none;
  border: none;
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  color: #6b7280;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
}

.sidebar-new-btn:hover {
  background-color: #dcfce7;
  color: #16a34a;
}

.sidebar-content {
  flex: 1;
  overflow-y: auto;
  padding: 12px 0;
}


.sidebar-empty {
  padding: 40px 20px;
  text-align: center;
  color: #9ca3af;
  font-size: 14px;
}

.workflow-list {
  display: flex;
  flex-direction: column;
}

.workflow-list-item {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px;
  cursor: pointer;
  transition: background-color 0.2s;
  border-left: 3px solid transparent;
}

.workflow-list-item:hover {
  background-color: #f3f4f6;
  border-left-color: #3b82f6;
}

.workflow-list-item-active {
  background-color: #eff6ff;
  border-left-color: #3b82f6;
}

.workflow-list-item-active .workflow-item-name {
  color: #1d4ed8;
  font-weight: 600;
}

/* 执行中提示 - 轻量设计 */
.executing-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  margin: 0 12px 8px;
  background-color: #fef3c7;
  border-radius: 4px;
  font-size: 12px;
  color: #92400e;
}

.executing-dot {
  width: 6px;
  height: 6px;
  background-color: #f59e0b;
  border-radius: 50%;
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
}

.executing-text {
  font-weight: 400;
}

.workflow-item-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-width: 0;
}

.workflow-item-name {
  font-size: 14px;
  font-weight: 500;
  color: #111827;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: flex;
  align-items: center;
  gap: 6px;
}

.workflow-agent-indicator {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #10b981;
  flex-shrink: 0;
}

.workflow-agent-indicator svg {
  stroke: #10b981;
}

.workflow-item-name-input {
  font-size: 14px;
  font-weight: 500;
  color: #111827;
  border: 1px solid #3b82f6;
  border-radius: 4px;
  padding: 2px 6px;
  outline: none;
  width: 100%;
  min-width: 0;
}

.workflow-item-name-input:focus {
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
}

.workflow-item-time {
  font-size: 12px;
  color: #9ca3af;
}

.workflow-item-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.2s;
}

.workflow-list-item:hover .workflow-item-actions {
  opacity: 1;
}

.workflow-item-rename-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 4px;
  background-color: transparent;
  color: #9ca3af;
  cursor: pointer;
  transition: all 0.2s;
}

.workflow-item-rename-btn:hover {
  background-color: #f3e8ff;
  color: #a855f7;
}

.workflow-item-rename-btn:active {
  transform: scale(0.95);
}

.workflow-item-export-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 4px;
  background-color: transparent;
  color: #9ca3af;
  cursor: pointer;
  transition: all 0.2s;
}

.workflow-item-export-btn:hover {
  background-color: #dbeafe;
  color: #3b82f6;
}

.workflow-item-export-btn:active {
  background-color: #bfdbfe;
}

.workflow-item-export-agent-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 4px;
  background-color: transparent;
  color: #9ca3af;
  cursor: pointer;
  transition: all 0.2s;
}

.workflow-item-export-agent-btn:hover {
  background-color: #d1fae5;
  color: #10b981;
}

.workflow-item-export-agent-btn:active {
  transform: scale(0.95);
}

.workflow-item-delete-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 4px;
  background-color: transparent;
  color: #9ca3af;
  cursor: pointer;
  transition: all 0.2s;
}

.workflow-item-delete-btn:hover {
  background-color: #fee2e2;
  color: #ef4444;
}

.workflow-item-delete-btn:active {
  transform: scale(0.95);
}

.workflow-item-delete-btn svg {
  display: block;
}

.sidebar-resize-handle {
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  width: 4px;
  cursor: col-resize;
  background-color: transparent;
  transition: background-color 0.2s;
  z-index: 10;
}

.sidebar-resize-handle:hover {
  background-color: #3b82f6;
}

/* 侧边栏拉出触发区域 */
.sidebar-pull-trigger {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  cursor: col-resize;
  background-color: transparent;
  transition: background-color 0.2s;
  z-index: 10;
}

.sidebar-pull-trigger:hover {
  background-color: rgba(59, 130, 246, 0.3);
}

/* 主画布区域 */
.workflow-main-area {
  flex: 1;
  position: relative;
  min-width: 0;
  height: 100%;
}

.workflow-main-area > :deep(.vue-flow) {
  width: 100%;
  height: 100%;
}

/* 确保Vue Flow控件可见 */
.workflow-view-layout :deep(.vue-flow__controls) {
  display: flex !important;
  position: absolute !important;
  top: 15px !important;
  left: 5px !important;
  z-index: 100 !important;
  background-color: transparent !important;
  box-shadow: none !important;
}

.workflow-view-layout :deep(.vue-flow__controls button) {
  background-color: transparent !important;
  border: 1px solid rgba(0, 0, 0, 0.1) !important;
  border-radius: 4px !important;
  padding: 6px !important;
  margin: 2px !important;
  transition: all 0.2s !important;
}

.workflow-view-layout :deep(.vue-flow__controls button:hover) {
  background-color: rgba(0, 0, 0, 0.05) !important;
}

.workflow-view-layout :deep(.vue-flow__minimap) {
  display: block !important;
  position: absolute !important;
  bottom: 15px !important;
  right: 15px !important;
  z-index: 10 !important;
}

.context-menu {
  position: fixed;
  min-width: 160px;
  background-color: var(--background-primary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  padding: var(--spacing-2);
  z-index: 1000;
  animation: fadeIn var(--transition-fast);
}

@keyframes fadeIn {
  from { opacity: 0; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1); }
}

.menu-item {
  display: flex;
  align-items: center;
  gap: var(--spacing-3);
  padding: var(--spacing-2) var(--spacing-3);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.menu-item:hover {
  background-color: var(--background-secondary);
  color: var(--primary-color);
}

.menu-item svg {
  flex-shrink: 0;
}

.node-context-menu {
  z-index: 1001;
}

.edge-context-menu {
  z-index: 1001;
}

.delete-item {
  color: #ef4444;
}

.delete-item:hover {
  background-color: rgba(239, 68, 68, 0.1);
  color: #dc2626;
}

.delete-item svg {
  color: #ef4444;
}

.delete-item:hover svg {
  color: #dc2626;
}

.edge-info {
  color: #6b7280;
  font-weight: 500;
  cursor: default;
}

.edge-info:hover {
  background-color: transparent;
  color: #6b7280;
}

.menu-divider {
  height: 1px;
  background-color: #e5e7eb;
  margin: var(--spacing-2) 0;
}

.execution-history-toggle-btn {
  position: absolute;
  top: 15px;
  right: 15px;
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: transparent;
  border-radius: 8px;
  cursor: pointer;
  z-index: 100;
  transition: all 0.2s;
}

.execution-history-toggle-btn:hover {
  background-color: transparent;
}

.execution-history-toggle-btn svg {
  color: #6b7280;
}

/* 执行历史抽屉遮罩 */
.execution-history-drawer-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(0, 0, 0, 0.5);
  z-index: 1000;
  animation: fadeIn 0.2s ease;
}

.execution-history-drawer {
  position: fixed;
  top: 0;
  right: 0;
  width: 320px;
  height: 100%;
  background-color: white;
  box-shadow: -4px 0 16px rgba(0, 0, 0, 0.1);
  z-index: 1001;
  display: flex;
  flex-direction: column;
  transform: translateX(100%);
  transition: transform 0.2s ease;
}

.execution-history-drawer.drawer-open {
  transform: translateX(0);
}

.drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid #e5e7eb;
  background-color: white;
}

.drawer-title {
  font-size: 16px;
  font-weight: 600;
  color: #111827;
}

.drawer-close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background-color: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s;
  color: #6b7280;
}

.drawer-close-btn:hover {
  background-color: #f3f4f6;
  color: #374151;
}

.drawer-content {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

.execution-history-content {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.empty-state {
  text-align: center;
  color: #9ca3af;
  font-size: 13px;
  padding: 24px 16px;
}

.execution-records-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.execution-record-item {
  display: flex;
  flex-direction: column;
  padding: 10px 12px;
  border-radius: 6px;
  background-color: #f9fafb;
  border: 1px solid #f3f4f6;
  transition: all 0.2s;
}

.execution-record-item:hover {
  background-color: #f3f4f6;
  border-color: #e5e7eb;
}

.record-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  cursor: pointer;
  user-select: none;
}

.record-header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.expand-icon {
  width: 16px;
  height: 16px;
  color: #9ca3af;
  transition: transform 0.2s;
  flex-shrink: 0;
}

.expand-icon.expanded {
  transform: rotate(90deg);
}

.record-details {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid #e5e7eb;
}

.record-details-enter-active,
.record-details-leave-active {
  transition: all 0.3s ease;
}

.record-details-enter-from,
.record-details-leave-to {
  opacity: 0;
  transform: translateY(-10px);
}

.detail-section {
  margin-bottom: 12px;
}

.detail-section:last-child {
  margin-bottom: 0;
}

.detail-title {
  font-size: 12px;
  font-weight: 600;
  color: #374151;
  margin-bottom: 4px;
  cursor: pointer;
  display: flex;
  justify-content: space-between;
  align-items: center;
  user-select: none;
}

.detail-title.error {
  color: #ef4444;
}

.section-expand-icon {
  width: 16px;
  height: 16px;
  transition: transform 0.2s ease;
  flex-shrink: 0;
}

.section-expand-icon.expanded {
  transform: rotate(90deg);
}

.section-content-enter-active,
.section-content-leave-active {
  transition: all 0.2s ease;
}

.section-content-enter-from,
.section-content-leave-to {
  opacity: 0;
  max-height: 0;
  overflow: hidden;
}

.section-content-enter-to,
.section-content-leave-from {
  opacity: 1;
  max-height: 1000px;
}

.json-content {
  background-color: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 4px;
  padding: 8px;
  font-size: 11px;
  color: #374151;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
}

.json-content.error {
  background-color: #fef2f2;
  border-color: #fecaca;
  color: #b91c1c;
}

.record-node-info {
  display: flex;
  align-items: center;
  gap: 8px;
}

.execution-order {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  font-size: 11px;
  font-weight: 600;
  color: #6b7280;
  background-color: #f3f4f6;
  border-radius: 50%;
  flex-shrink: 0;
}

.record-time {
  font-size: 12px;
  color: #6b7280;
  font-weight: 500;
}

.record-status {
  font-size: 12px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 4px;
  white-space: nowrap;
}

.执行中 {
  color: #3b82f6;
  background-color: #dbeafe;
}

.已完成 {
  color: #10b981;
  background-color: #d1fae5;
}

.待执行 {
  color: #9ca3af;
  background-color: #f3f4f6;
}

/* Toast 提示 */
.toast-message {
  position: fixed;
  top: 60px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 20px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  z-index: 10001;
  backdrop-filter: blur(8px);
  border: 1px solid rgba(255, 255, 255, 0.2);
}

.toast-message.success {
  background-color: rgba(16, 185, 129, 0.95);
  color: white;
  box-shadow: 0 4px 16px rgba(16, 185, 129, 0.3);
}

.toast-message.error {
  background-color: rgba(239, 68, 68, 0.95);
  color: white;
  box-shadow: 0 4px 16px rgba(239, 68, 68, 0.3);
}

.toast-message svg {
  flex-shrink: 0;
}

/* Toast 动画 */
.toast-enter-active,
.toast-leave-active {
  transition: all 0.3s ease;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(-10px);
}

/* 单模型节点改道：模板编辑器覆盖层 */
.template-editor-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.template-editor-panel {
  background: var(--background-primary, #fff);
  border-radius: 10px;
  padding: 1.25rem;
  max-width: 780px;
  width: 92vw;
  max-height: 88vh;
  overflow-y: auto;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.18);
}

.template-editor-head {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 1rem;
}

.template-editor-title {
  font-size: 0.9375rem;
  font-weight: 600;
  color: #1f2937;
}

/* 单 Agent 分区（侧栏） */
.tpl-section {
  border-top: 1px solid var(--border-color, #e5e7eb);
  margin-top: 0.5rem;
  padding-top: 0.5rem;
}

.tpl-section-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 0.25rem;
}

.tpl-section-title {
  font-size: 0.8125rem;
  font-weight: 600;
  color: #1f2937;
}

.tpl-section-sub {
  font-size: 0.6875rem;
  color: #9ca3af;
  padding: 0 0.25rem 0.375rem;
}

.tpl-legacy-head {
  margin-top: 0.5rem;
  border-top: 1px dashed var(--border-color, #e5e7eb);
  padding-top: 0.5rem;
}

.tpl-item-slug {
  font-size: 0.6875rem;
  color: #8b5cf6;
  font-family: 'JetBrains Mono', monospace;
}

.tpl-level {
  font-size: 0.625rem;
  font-weight: 500;
  padding: 0 0.375rem;
  border-radius: 9999px;
  margin-left: 0.375rem;
}

.tpl-level-builtin {
  background: rgba(107, 114, 128, 0.12);
  color: #6b7280;
}

.tpl-level-user {
  background: rgba(139, 92, 246, 0.1);
  color: #8b5cf6;
}

.tpl-level-project {
  background: rgba(16, 185, 129, 0.1);
  color: #10b981;
}

/* 工作流 YAML 非法文件错误条目(带原因可见) */
.tpl-error {
  font-size: 0.6875rem;
  color: #dc2626;
  padding: 0.25rem 0.5rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tpl-warning {
  font-size: 0.6875rem;
  color: #d97706;
  padding: 0.25rem 0.5rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 命名工作流运行记录(执行历史抽屉) */
.workflow-runs-section {
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--border-color, #e5e7eb);
}

.drawer-sub-title {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--text-secondary, #6b7280);
  margin-bottom: 0.375rem;
}

.workflow-run-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.75rem;
  padding: 0.25rem 0;
}

.workflow-run-name {
  font-weight: 500;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workflow-run-status {
  font-size: 0.625rem;
  padding: 0 0.375rem;
  border-radius: 9999px;
}

.run-status-completed { background: rgba(16, 185, 129, 0.1); color: #10b981; }
.run-status-failed { background: rgba(220, 38, 38, 0.1); color: #dc2626; }
.run-status-cancelled { background: rgba(107, 114, 128, 0.12); color: #6b7280; }
.run-status-running { background: rgba(59, 130, 246, 0.1); color: #3b82f6; }

.workflow-run-time {
  color: var(--text-tertiary, #9ca3af);
  font-size: 0.6875rem;
}
</style>
