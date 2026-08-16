<template>
  <div class="settings-tabs-layout">
    <!-- 左侧Tab导航区域 -->
    <aside class="settings-tabs-sidebar">
      <div class="tabs-header">
        <button
          class="tabs-close-button"
          @click="emit('close-settings')"
          title="关闭设置 (Esc)"
        >
          <svg class="tab-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>
      <nav class="tabs-nav">
        <div 
          class="tab-item" 
          :class="{ active: activeTab === 'models' }"
          @click="setActiveTab('models')"
          title="模型"
        >
          <svg class="tab-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <div 
          class="tab-item" 
          :class="{ active: activeTab === 'mcp' }"
          @click="setActiveTab('mcp')"
          title="MCP服务器"
        >
          <svg class="tab-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M8 9l3 3-3 3m5 0h3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M17 15l-3-3 3-3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <div 
          class="tab-item" 
          :class="{ active: activeTab === 'agent' }"
          @click="setActiveTab('agent')"
          title="AGENT"
        >
          <svg class="tab-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="4" y="4" width="16" height="16" rx="4" stroke="currentColor" stroke-width="2"/>
            <circle cx="9" cy="10" r="1.8" fill="currentColor"/>
            <circle cx="15" cy="10" r="1.8" fill="currentColor"/>
          </svg>
        </div>
        <div 
          class="tab-item" 
          :class="{ active: activeTab === 'skills' }"
          @click="setActiveTab('skills')"
          title="技能"
        >
          <svg class="tab-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 2l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 7.7l5.4-.8L12 2z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <div
          class="tab-item"
          :class="{ active: activeTab === 'knowledge' }"
          @click="setActiveTab('knowledge')"
          title="知识库"
        >
          <svg class="tab-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M4 19.5A2.5 2.5 0 016.5 17H20M4 19.5A2.5 2.5 0 006.5 22H20V2H6.5A2.5 2.5 0 004 4.5v15z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
      </nav>
    </aside>

    <!-- 右侧内容区域（内部各 Tab 由 settings-main 承担滚动语义） -->
    <div class="settings-content-area">
      <!-- 模型设置Tab内容 -->
      <div v-if="activeTab === 'models'" class="model-settings-container">
        <main class="settings-main">
          <div class="settings-page">
            <!-- 已选择的模型区域 - 移动到顶部，使用灵活的网格布局 -->
        <section v-if="selectedModels.length > 0" class="settings-group">
          <div class="settings-group-head"><h2>已选择的模型</h2></div>
          <div class="selected-models-grid">
              <div
                v-for="model in selectedModels"
                :key="model.name"
                class="settings-card selected-model-item"
              >
                <div class="selected-model-info">
                  <span class="selected-model-name">{{ model.displayName }}</span>
                  <span class="selected-model-provider">{{ model.provider }}</span>
                </div>
                <div class="selected-model-actions">
                  <button
                    type="button"
                    class="settings-icon-btn"
                    @click="openParameterDialog(model)"
                    title="设置参数"
                  >
                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M12 15.5A3.5 3.5 0 0 1 8.5 12A3.5 3.5 0 0 1 12 8.5a3.5 3.5 0 0 1 3.5 3.5a3.5 3.5 0 0 1-3.5 3.5m7.43-2.53c.04-.32.07-.64.07-.97c0-.33-.03-.65-.07-.97l2.11-1.63c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.3-.61-.22l-2.49 1c-.52-.39-1.06-.73-1.69-.98l-.37-2.65A.506.506 0 0 0 14 2h-4c-.25 0-.46.18-.5.42l-.37 2.65c-.63.25-1.17.59-1.69.98l-2.49-1c-.22-.08-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64L4.57 11c-.04.32-.07.64-.07.97c0 .33.03.65.07.97l-2.11 1.63c-.19.15-.24.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.39 1.06.73 1.69.98l.37 2.65c.04.24.25.42.5.42h4c.25 0 .46-.18.5-.42l.37-2.65c.63-.25 1.17-.59 1.69-.98l2.49 1c.22.08.49 0 .61-.22l2-3.46c.13-.22.07-.49-.12-.64l-2.11-1.63Z" stroke="currentColor" stroke-width="1.5" fill="none"/>
                    </svg>
                  </button>
                  <button
                    type="button"
                    class="settings-icon-btn settings-icon-btn-danger"
                    @click="removeModel(model.name)"
                    title="移除模型"
                  >
                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M19 6.41L17.59 5L12 10.59L6.41 5L5 6.41L10.59 12L5 17.59L6.41 19L12 13.41L17.59 19L19 17.59L13.41 12L19 6.41Z" stroke="currentColor" stroke-width="1.5" fill="none"/>
                    </svg>
                  </button>
                </div>
              </div>
            </div>
        </section>

        <!-- 目标模式评估器模型（独立可配，经 kv:set 写 defaultEvaluatorModel；缺省用当前会话模型） -->
        <section class="settings-group">
          <div class="settings-group-head"><h2>目标模式评估器模型</h2></div>
          <div class="provider-select-container">
            <label for="evaluator-select" class="settings-label">评估器模型:</label>
            <select
              id="evaluator-select"
              v-model="evaluatorModel"
              class="settings-input"
              @change="handleEvaluatorChange"
            >
              <option value="">默认（当前会话模型）</option>
              <option
                v-for="model in chatModels"
                :key="model.name"
                :value="model.name"
              >
                {{ model.displayName || model.name }}（{{ model.provider }}）
              </option>
            </select>
          </div>
          <p class="settings-hint">目标模式每轮结束由评估器判定目标是否达成；评估是轻量文本判定，可在此配置更便宜的对话模型降低成本。</p>
        </section>

        <!-- 工具渐进发现开关（kvStore 键 progressive_tools，与 CLI /tools mode 同一键；opt-out 默认开） -->
        <section class="settings-group">
          <div class="settings-group-head"><h2>工具渐进发现</h2></div>
          <div class="provider-select-container">
            <label class="checkbox-label">
              <input type="checkbox" v-model="progressiveTools" @change="handleProgressiveToolsChange" />
              工具渐进发现（省 token）
            </label>
          </div>
          <p class="settings-hint">开启后每次请求只下发常驻核心工具，模型按需经 search_tools 搜索激活其余工具，显著降低 token 消耗；关闭则恢复全量工具下发（与 CLI /tools mode on|off 读写同一配置键）。</p>
        </section>

        <!-- 桌面能力开关（kvStore 键 desktop_control_enabled，与 CLI /desktop 同一键；opt-in 默认关） -->
        <section class="settings-group">
          <div class="settings-group-head"><h2>桌面能力</h2></div>
          <div class="provider-select-container">
            <label class="checkbox-label">
              <input type="checkbox" v-model="desktopControl" @change="handleDesktopControlChange" />
              桌面能力（截屏 + 元素感知 + 键鼠操作）
            </label>
          </div>
          <p class="settings-hint">开启后模型可截屏（capture_screen）、列出前台窗口可交互元素（inspect_ui）并操作键鼠（computer_use，主动作逐次审批，可单次放行本次会话）；建议搭配视觉模型使用（与 CLI /desktop on|off 读写同一配置键）。</p>
        </section>

        <!-- 供应商选择和API Key输入区域 -->
        <section class="settings-group">
          <div class="settings-group-head"><h2>供应商设置</h2></div>
          <div class="provider-select-container">
            <label for="provider-select" class="settings-label">选择供应商:</label>
            <select
              id="provider-select"
              v-model="selectedProvider"
              class="settings-input"
              @change="handleProviderChange"
            >
              <option value="" disabled>请选择供应商</option>
              <option 
                v-for="provider in providers" 
                :key="`${provider.type}:${provider.name}`" 
                :value="provider.name"
              >
                {{ provider.name }}
              </option>
            </select>
            <button
              type="button"
              class="settings-btn"
              @click="showCustomProviderForm = !showCustomProviderForm"
            >
              {{ showCustomProviderForm ? '取消' : '添加自定义供应商' }}
            </button>
          </div>

          <!-- 自定义供应商表单 -->
          <div v-if="showCustomProviderForm" class="custom-provider-form">
            <div class="form-row">
              <label class="settings-label">供应商名:</label>
              <input v-model="customProviderName" placeholder="例如: Anthropic" class="settings-input" />
            </div>
            <div class="form-row">
              <label class="settings-label">Base URL:</label>
              <input v-model="customBaseURL" placeholder="例如: https://api.anthropic.com" class="settings-input" />
            </div>
            <div class="form-row">
              <label class="settings-label">协议类型:</label>
              <input v-model="customProtocol" placeholder="例如: openai-chat" class="settings-input" />
            </div>
            <div class="form-row">
              <label class="settings-label">API Key:</label>
              <input v-model="customApiKey" type="password" placeholder="输入 API Key" class="settings-input" />
            </div>
            <div class="form-row">
              <label class="settings-label">模型名列表:</label>
              <input v-model="customModelNames" placeholder="多个模型用逗号分隔，例如: claude-sonnet-4,claude-opus-4" class="settings-input" />
            </div>
            <div class="form-row">
              <label class="settings-label">描述:</label>
              <input v-model="customDescription" placeholder="模型描述（可选）" class="settings-input" />
            </div>
            <div class="form-row">
              <label class="settings-label">版本:</label>
              <input v-model="customVersion" placeholder="版本号（可选）" class="settings-input" />
            </div>
            <div class="form-row">
              <label class="settings-label">文档 URL:</label>
              <input v-model="customDocumentation" placeholder="文档链接（可选）" class="settings-input" />
            </div>
            <div class="form-row">
              <label class="settings-label">最大上下文 Tokens:</label>
              <input v-model.number="customMaxContextTokens" type="number" class="settings-input" />
            </div>
            <div class="form-row">
              <label class="settings-label">最大输出 Tokens:</label>
              <input v-model.number="customMaxOutputTokens" type="number" class="settings-input" />
            </div>
            <div class="form-row form-row-checkbox">
              <label class="settings-label">特性:</label>
              <div class="checkbox-group">
                <label class="checkbox-label"><input type="checkbox" v-model="customSupportsStreaming" /> 流式输出</label>
                <label class="checkbox-label"><input type="checkbox" v-model="customSupportsTools" /> 工具调用</label>
                <label class="checkbox-label"><input type="checkbox" v-model="customSupportsThinking" /> 思考模式</label>
              </div>
            </div>
            <div class="form-row">
              <label class="settings-label">额外配置 (JSON):</label>
              <input v-model="customExtraConfig" placeholder='例如: {"supports_images": true}' class="settings-input" />
            </div>
            <div class="form-actions">
              <button type="button" class="settings-btn settings-btn-primary" @click="submitCustomProvider">保存</button>
              <button type="button" class="settings-btn" @click="showCustomProviderForm = false">取消</button>
            </div>
          </div>

          <div v-if="selectedProvider" class="api-key-container">
            <label for="api-key-input" class="settings-label">API Key:</label>
            <div class="api-key-input-group">
              <input
                id="api-key-input"
                v-model="apiKey"
                :type="showApiKey ? 'text' : 'password'"
                placeholder="请输入API Key"
                class="settings-input"
              />
              <button 
                type="button" 
                class="settings-btn"
                @click="toggleApiKeyVisibility"
              >
                {{ showApiKey ? '隐藏' : '显示' }}
              </button>
            </div>
            
            <!-- 保存状态消息 -->
            <div v-if="saveMessage" class="settings-notice" :class="'settings-notice-' + saveMessageType">
              {{ saveMessage }}
            </div>
            
            <div class="api-key-actions">
              <button 
                type="button" 
                class="settings-btn settings-btn-primary"
                :disabled="!apiKey || isSaving"
                @click="saveApiKey"
              >
                {{ isSaving ? '保存中...' : '保存' }}
              </button>
              <button 
                v-if="hasStoredApiKey"
                type="button" 
                class="settings-btn settings-btn-danger"
                @click="deleteApiKey"
              >
                删除
              </button>
            </div>
          </div>
        </section>

        <!-- 可用模型展示区域 -->
        <section v-if="chatModels.length > 0" class="settings-group">
          <div class="settings-group-head"><h2>可用模型</h2></div>
          <div class="models-grid">
            <div
              v-for="model in chatModels"
              :key="model.name"
              class="settings-card model-card"
              :class="{ 'selected': isModelSelected(model.name) }"
              @click="toggleModelSelection(model)"
            >
              <div class="model-header">
                <h3 class="model-name">{{ model.displayName }}</h3>
                <div class="settings-badge settings-badge-neutral">{{ model.provider }}</div>
              </div>
              <p class="model-description">{{ model.description }}</p>
              <div class="model-features">
                <span v-if="model.supportsStreaming" class="settings-badge settings-badge-primary">流式</span>
                <span v-if="model.supportsTools" class="settings-badge settings-badge-primary">工具</span>
                <span v-if="model.supportsThinking" class="settings-badge settings-badge-primary">思考</span>
              </div>
              <div class="model-tokens">
                <span class="token-info">上下文: {{ formatTokenCount(model.maxContextTokens) }}</span>
                <span class="token-info">输出: {{ formatTokenCount(model.maxOutputTokens) }}</span>
              </div>
            </div>
          </div>
        </section>

        <!-- 生成模型（只读，经 generate_* 工具使用，不可切换为对话模型） -->
        <section v-if="genModels.length > 0" class="settings-group">
          <div class="settings-group-head"><h2>生成模型（经 generate_* 工具使用，不可切换）</h2></div>
          <div class="models-grid">
            <div
              v-for="model in genModels"
              :key="model.name"
              class="settings-card model-card readonly"
            >
              <div class="model-header">
                <h3 class="model-name">{{ model.displayName }}</h3>
                <div class="settings-badge settings-badge-neutral">{{ model.provider }}</div>
              </div>
              <p class="model-description">{{ model.description }}</p>
              <div class="model-tokens">
                <span class="token-info">上下文: {{ formatTokenCount(model.maxContextTokens) }}</span>
                <span class="token-info">输出: {{ formatTokenCount(model.maxOutputTokens) }}</span>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
    
        <!-- 模型参数设置对话框 -->
        <ModelParameterDialog 
          v-if="showParameterDialog && currentModel"
          :model="currentModel"
          @close="closeParameterDialog"
          @save="handleParameterSave"
        />
      </div>
      
      <!-- MCP配置Tab内容 -->
      <div v-else-if="activeTab === 'mcp'" class="mcp-settings-container">
        <main class="settings-main">
          <McpConfig />
        </main>
      </div>
      
      <!-- 技能管理Tab内容 -->
      <div v-else-if="activeTab === 'skills'" class="skill-settings-container">
        <main class="settings-main">
          <SkillSettings />
        </main>
      </div>

      <!-- 知识库Tab内容 -->
      <div v-else-if="activeTab === 'knowledge'" class="knowledge-settings-container">
        <main class="settings-main">
          <KnowledgeSettings />
        </main>
      </div>
      
      <!-- AGENT配置Tab内容 -->
      <div v-else-if="activeTab === 'agent'" class="agent-settings-container">
        <main class="settings-main">
        <!-- Agent列表视图 -->
        <div v-if="!isConfiguringAgent" class="agent-list-view">
          <RemoteAgentManager
            :local-agents="chatResourceStore.localAgents"
            :remote-agents="chatResourceStore.remoteAgents"
            @add-agent="handleAddAgent"
            @add-local-agent="handleAddLocalAgent"
            @edit-remote-agent="handleEditRemoteAgent"
            @delete-local-agent="handleDeleteLocalAgent"
            @delete-remote-agent="handleDeleteRemoteAgent"
            @toggle-local-agent="handleToggleLocalAgent"
            @toggle-remote-agent="handleToggleRemoteAgent"
            @open-workflow="handleOpenWorkflow"
            @load-local-description="handleLoadLocalDescription"
          >
          </RemoteAgentManager>
        </div>

        <!-- Agent配置输入视图 -->
        <div v-else class="agent-config-input-view settings-page">
          <div class="config-header">
            <button @click="cancelAgentConfiguration" class="settings-btn">
              ← 返回Agent列表
            </button>
          </div>

          <!-- 配置输入区域 -->
          <div class="config-input-section">
            <!-- 平台类型选择 -->
            <div class="form-group">
              <label class="settings-label">平台类型</label>
              <select v-model="agentPlatformType" class="settings-input">
                <option value="a2a">A2A协议</option>
                <option value="coze">扣子(Coze)</option>
              </select>
              <p class="settings-hint">选择远程Agent平台类型</p>
            </div>

            <!-- A2A配置表单 -->
            <div v-if="agentPlatformType === 'a2a'" class="platform-form">
              <div class="form-group">
                <label class="settings-label">服务地址 <span class="required">*</span></label>
                <div class="input-with-button">
                  <input
                    v-model="a2aUrl"
                    type="url"
                    class="settings-input"
                    placeholder="https://example.com/agent"
                    :disabled="isAgentLoading"
                  />
                  <button
                    class="settings-btn"
                    :disabled="!a2aUrl || isAgentLoading"
                    @click="fetchAgentInfo"
                  >
                    <span v-if="isAgentLoading">获取中...</span>
                    <span v-else>获取信息</span>
                  </button>
                </div>
                <p class="settings-hint">输入A2A服务地址，点击"获取信息"自动发现Agent能力</p>
              </div>

              <!-- Agent信息预览 -->
              <div v-if="agentCard" class="agent-preview">
                <h4 class="preview-title">Agent信息</h4>
                <div class="preview-content">
                  <div class="preview-item">
                    <span class="preview-label">名称：</span>
                    <span class="preview-value">{{ agentCard.name || '未命名' }}</span>
                  </div>
                  <div v-if="agentCard.description" class="preview-item">
                    <span class="preview-label">描述：</span>
                    <span class="preview-value">{{ agentCard.description }}</span>
                  </div>
                  <div v-if="agentCard.capabilities" class="preview-item">
                    <span class="preview-label">能力：</span>
                    <div class="capabilities-tags">
                      <span v-if="agentCard.capabilities.streaming" class="settings-badge settings-badge-neutral">流式响应</span>
                      <span v-if="agentCard.capabilities.pushNotifications" class="settings-badge settings-badge-neutral">推送通知</span>
                      <span v-if="agentCard.capabilities.stateTransitionHistory" class="settings-badge settings-badge-neutral">状态历史</span>
                    </div>
                  </div>
                  <div v-if="agentCard.skills && agentCard.skills.length > 0" class="preview-item">
                    <span class="preview-label">技能：</span>
                    <span class="preview-value">{{ agentCard.skills.length }}个</span>
                  </div>
                </div>
              </div>

              <!-- 错误提示 -->
              <div v-if="agentErrorMessage" class="settings-notice settings-notice-error">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10"/>
                  <line x1="12" y1="8" x2="12" y2="12"/>
                  <line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
                {{ agentErrorMessage }}
              </div>
            </div>

            <!-- Coze配置表单 -->
            <div v-if="agentPlatformType === 'coze'" class="platform-form">
              <div class="form-group">
                <label class="settings-label">Bot ID <span class="required">*</span></label>
                <input
                  v-model="cozeBotId"
                  type="text"
                  class="settings-input"
                  placeholder="输入扣子Bot ID"
                  :disabled="isAgentLoading"
                />
                <p class="settings-hint">在扣子平台创建的Bot ID</p>
              </div>

              <div class="form-group">
                <label class="settings-label">Token <span class="required">*</span></label>
                <input
                  v-model="cozeToken"
                  type="password"
                  class="settings-input"
                  placeholder="输入扣子Token"
                  :disabled="isAgentLoading"
                />
                <p class="settings-hint">扣子平台的Personal Access Token</p>
              </div>

              <div class="form-group">
                <label class="settings-label">API基础URL</label>
                <input
                  v-model="cozeBaseURL"
                  type="url"
                  class="settings-input"
                  placeholder="https://api.coze.cn"
                  :disabled="isAgentLoading"
                />
                <p class="settings-hint">可选，默认为 https://api.coze.cn</p>
              </div>

              <div class="form-group">
                <button
                  class="settings-btn"
                  :disabled="!cozeBotId || !cozeToken || isAgentLoading"
                  @click="fetchCozeBotInfo"
                >
                  <span v-if="isAgentLoading">获取中...</span>
                  <span v-else>获取Bot信息</span>
                </button>
              </div>

              <!-- Bot信息预览 -->
              <div v-if="cozeBotInfo" class="agent-preview">
                <h4 class="preview-title">Bot信息</h4>
                <div class="preview-content">
                  <div class="preview-item">
                    <span class="preview-label">名称：</span>
                    <span class="preview-value">{{ cozeBotInfo.name || '未命名' }}</span>
                  </div>
                  <div v-if="cozeBotInfo.description" class="preview-item">
                    <span class="preview-label">描述：</span>
                    <span class="preview-value">{{ cozeBotInfo.description }}</span>
                  </div>
                </div>
              </div>

              <!-- 错误提示 -->
              <div v-if="agentErrorMessage" class="settings-notice settings-notice-error">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10"/>
                  <line x1="12" y1="8" x2="12" y2="12"/>
                  <line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
                {{ agentErrorMessage }}
              </div>
            </div>
          </div>
          
          <div class="button-group">
            <button @click="handleAgentConfirm" class="settings-btn settings-btn-primary" :disabled="!canSubmitAgent">
              {{ isEditingAgent ? '保存' : '添加' }}
            </button>
            <button @click="cancelAgentConfiguration" class="settings-btn">
              取消
            </button>
          </div>
        </div>
        </main>
      </div>
    </div>

    <!-- 删除确认对话框 - 远程Agent -->
    <ConfirmDialog
      :is-open="showDeleteConfirm"
      title="删除确认"
      :message="deleteConfirmMessage"
      @confirm="confirmDeleteAgent"
      @cancel="cancelDeleteAgent"
    />
    
    <!-- 删除确认对话框 - 本地Agent -->
    <ConfirmDialog
      :is-open="showDeleteLocalConfirm"
      title="删除确认"
      :message="deleteLocalConfirmMessage"
      @confirm="confirmDeleteLocalAgent"
      @cancel="cancelDeleteLocalAgent"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { eventBus, EVENTS, ModelType, ModelInfo, SecureStorageService, SelectedModelsService, ModelInfoService, modelInfoService, builtInToolExecutor, A2AClient, CozeAgentAdapter, providerManager, deriveModelKind } from '@assistant-ai/core'
import type { AgentCard, AgentListItem, RemoteAgentConfig, AddModelParams } from '@assistant-ai/core'
import { useChatResourceStore } from '../stores/chatResourceStore'
import { useAgentPersistenceStore } from '../stores/agentPersistence'
import ModelParameterDialog from '../components/ModelParameterDialog.vue'
import { IPCKeyValueStore } from '../adapters/IPCKeyValueStore'
import { getChatEngine } from '../services/chatEngine'
import McpConfig from '../components/mcp/McpConfig.vue'
import SkillSettings from '../components/skill/SkillSettings.vue'
import KnowledgeSettings from '../components/knowledge/KnowledgeSettings.vue'
import RemoteAgentManager from '../components/agent/RemoteAgentManager.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'



// 供应商相关状态
const selectedProvider = ref<string>('')
const apiKey = ref<string>('')
const showApiKey = ref<boolean>(false)
const isSaving = ref<boolean>(false)
const hasStoredApiKey = ref<boolean>(false)
const saveMessage = ref<string>('')
const saveMessageType = ref<'success' | 'error' | ''>('')

// 模型相关状态
const availableModels = ref<ModelInfo[]>([])

// 使用面分层：chat 模型可选择加入切换集；生成模型只读展示（经 generate_* 工具使用）
const chatModels = computed(() => availableModels.value.filter(m => deriveModelKind(m.adapterConfig?.protocol) === 'chat'))
const genModels = computed(() => availableModels.value.filter(m => deriveModelKind(m.adapterConfig?.protocol) !== 'chat'))
const selectedModels = ref<ModelInfo[]>([])

// 参数设置对话框相关状态
const showParameterDialog = ref<boolean>(false)
const currentModel = ref<ModelInfo | null>(null)

// 目标模式评估器模型（kvStore 键 defaultEvaluatorModel，与 CLI /model evaluator 同一键；'' = 默认当前会话模型）
const evaluatorKv = window.electronAPI?.getKeyValue ? new IPCKeyValueStore() : null
const evaluatorModel = ref<string>('')
const handleEvaluatorChange = () => {
  if (!evaluatorKv) return
  if (evaluatorModel.value) evaluatorKv.setItem('defaultEvaluatorModel', evaluatorModel.value)
  else evaluatorKv.removeItem('defaultEvaluatorModel')
}

// 工具渐进发现开关（kvStore 键 progressive_tools，opt-out：读不到/'true'=开；与 CLI /tools mode 同一键。
// 复用上面的 evaluatorKv——IPCKeyValueStore 是无状态 IPC 桥，不按业务键区分实例）
const progressiveTools = ref<boolean>(true)
const handleProgressiveToolsChange = () => {
  if (!evaluatorKv) return
  evaluatorKv.setItem('progressive_tools', progressiveTools.value ? 'true' : 'false')
}

// 桌面能力开关（kvStore 键 desktop_control_enabled，opt-in：读不到/'false'=关；与 CLI /desktop 同一键。
// 切换时注入合成消息显式告知模型工具集变化（对齐 CLI /desktop 文案，kind 'desktopToggle'），
// 关闭时收回 [s] 会话级放行）
const desktopControl = ref<boolean>(false)
const handleDesktopControlChange = () => {
  if (!evaluatorKv) return
  const on = desktopControl.value
  evaluatorKv.setItem('desktop_control_enabled', on ? 'true' : 'false')
  if (on) {
    getChatEngine().appendSyntheticMessage(
      '【桌面能力已开启】你新增了三个内置工具：capture_screen（截取主显示器屏幕，只读免审批，返回缩放后图像与坐标系说明）；inspect_ui（列出前台窗口的可交互元素，只读免审批，按元素编号引用）；computer_use（键鼠与元素级操作：点击/拖拽/滚动/输入文本/组合键/click_element/set_value/focus_window，主动作需用户审批，coordinate 以最近一次截图的图像坐标系为准）。若当前模型不支持视觉，截图图片会被替换为占位符，建议提醒用户切换视觉模型。',
      'desktopToggle'
    )
  } else {
    builtInToolExecutor.resetDesktopSessionAllow()
    getChatEngine().appendSyntheticMessage(
      '【桌面能力已关闭】capture_screen、inspect_ui 与 computer_use 已从你的可用工具集移除，不要再尝试调用；如用户询问，请说明桌面能力已被用户关闭（可在设置中重新开启）。',
      'desktopToggle'
    )
  }
}

// 自定义供应商表单状态
const showCustomProviderForm = ref<boolean>(false)
const customProviderName = ref<string>('')
const customBaseURL = ref<string>('')
const customProtocol = ref<string>('openai-chat')
const customApiKey = ref<string>('')
const customModelNames = ref<string>('')  // 逗号分隔
const customMaxContextTokens = ref<number | undefined>(undefined)
const customMaxOutputTokens = ref<number | undefined>(undefined)
const customSupportsStreaming = ref<boolean>(false)
const customSupportsTools = ref<boolean>(false)
const customSupportsThinking = ref<boolean>(false)
const customExtraConfig = ref<string>('')
const customDescription = ref<string>('')
const customVersion = ref<string>('')
const customDocumentation = ref<string>('')

// Tab状态管理
const activeTab = ref<string>('models')

// Store
const chatResourceStore = useChatResourceStore()
const agentPersistenceStore = useAgentPersistenceStore()

// Emits
const emit = defineEmits<{
  'close-settings': []
  'open-workflow': [workflowId: string]
  'open-agent-factory': []
}>()

// Props（组件常驻挂载，由父级告知面板是否可见，用于 Esc 关闭的可见性门控）
const props = withDefaults(defineProps<{
  visible?: boolean
}>(), {
  visible: true
})

// AGENT相关状态
const isConfiguringAgent = ref<boolean>(false)
const agentPlatformType = ref<'a2a' | 'coze'>('a2a')
const a2aUrl = ref('')
const agentCard = ref<AgentCard | null>(null)

// 删除确认对话框状态 - 远程Agent
const showDeleteConfirm = ref<boolean>(false)
const deleteAgentConfig = ref<RemoteAgentConfig | null>(null)
const deleteConfirmMessage = ref<string>('确定要删除这个远程Agent吗？')

// 删除确认对话框状态 - 本地Agent
const showDeleteLocalConfirm = ref<boolean>(false)
const deleteLocalAgentId = ref<string>('')
const deleteLocalConfirmMessage = ref<string>('确定要删除这个本地Agent吗？')

// 编辑Agent相关状态
const isEditingAgent = ref<boolean>(false)
const editingAgentIndex = ref<number>(-1)
const cozeBotId = ref('')
const cozeToken = ref('')
const cozeBaseURL = ref('')
const cozeBotInfo = ref<AgentCard | null>(null)
const isAgentLoading = ref(false)
const agentErrorMessage = ref('')

// 计算属性：是否可以提交Agent
const canSubmitAgent = computed(() => {
  if (isAgentLoading.value) return false

  if (agentPlatformType.value === 'a2a') {
    return a2aUrl.value.trim() && agentCard.value !== null
  }

  if (agentPlatformType.value === 'coze') {
    return cozeBotId.value.trim() && cozeToken.value.trim() && cozeBotInfo.value !== null
  }

  return false
})

// 处理添加远程Agent
const handleAddAgent = () => {
  isConfiguringAgent.value = true
  isEditingAgent.value = false
  editingAgentIndex.value = -1
  resetAgentForm()
}

// 处理从Agent工厂创建Agent
const handleAddLocalAgent = () => {
  // 关闭设置界面，打开Agent工厂/工作流界面
  emit('close-settings')
  emit('open-agent-factory')
}

// 处理编辑远程Agent
const handleEditRemoteAgent = async (agent: RemoteAgentConfig, index: number) => {
  isConfiguringAgent.value = true
  isEditingAgent.value = true
  editingAgentIndex.value = index

  // 填充表单数据
  if (agent.type === 'remote_agent') {
    agentPlatformType.value = 'a2a'
    a2aUrl.value = agent.url || ''
    agentCard.value = agent.agentCard || null
  } else if (agent.type === 'coze') {
    agentPlatformType.value = 'coze'
    cozeBotId.value = agent.bot_id || ''
    // 从安全存储中获取Token
    const storedToken = await SecureStorageService.getApiKey('coze')
    cozeToken.value = storedToken || ''
    cozeBaseURL.value = agent.baseURL || ''
    cozeBotInfo.value = agent.agentCard || null
  }
}

// 处理删除本地Agent
const handleDeleteLocalAgent = (agent: AgentListItem) => {
  deleteLocalAgentId.value = agent.id
  deleteLocalConfirmMessage.value = `确定要删除本地Agent "${agent.name}" 吗？\n\n注意：这将永久删除该Agent，无法恢复。`
  showDeleteLocalConfirm.value = true
}

// 确认删除本地Agent
const confirmDeleteLocalAgent = async () => {
  try {
    await agentPersistenceStore.deleteAgent(deleteLocalAgentId.value)
    await chatResourceStore.loadLocalAgents()
    await chatResourceStore.loadResources()
  } catch (err) {
    console.error('删除本地Agent失败:', err)
    alert('删除失败: ' + (err instanceof Error ? err.message : '未知错误'))
  } finally {
    showDeleteLocalConfirm.value = false
    deleteLocalAgentId.value = ''
  }
}

// 取消删除本地Agent
const cancelDeleteLocalAgent = () => {
  showDeleteLocalConfirm.value = false
  deleteLocalAgentId.value = ''
}

// 处理删除远程Agent
const handleDeleteRemoteAgent = (config: RemoteAgentConfig) => {
  deleteAgentConfig.value = config
  const agentName = config?.agentCard?.name || (config?.type === 'coze' ? '扣子Agent' : '远程Agent')
  deleteConfirmMessage.value = `确定要删除远程Agent "${agentName}" 吗？\n\n注意：此操作不可恢复。`
  showDeleteConfirm.value = true
}

// 切换本地Agent启用状态
const handleToggleLocalAgent = (agent: AgentListItem, enabled: boolean) => {
  const resource = chatResourceStore.localAgentResources.find(r => {
    const config = r.config as { agentId: string }
    return config.agentId === agent.id
  })
  if (resource) {
    chatResourceStore.setResourceEnabled(resource.id, enabled)
  }
}

// 切换远程Agent启用状态
const handleToggleRemoteAgent = (agent: RemoteAgentConfig, enabled: boolean) => {
  const resource = chatResourceStore.remoteAgentResources.find(r => {
    const config = r.config as RemoteAgentConfig
    return config.url === agent.url
  })
  if (resource) {
    chatResourceStore.setResourceEnabled(resource.id, enabled)
  }
}

// 打开工作流
const handleOpenWorkflow = (workflowId: string) => {
  emit('close-settings')
  emit('open-workflow', workflowId)
}

// 加载本地Agent描述
const handleLoadLocalDescription = async (agentId: string) => {
  await chatResourceStore.loadLocalAgentDescription(agentId)
}

// 取消Agent配置
const cancelAgentConfiguration = () => {
  isConfiguringAgent.value = false
  isEditingAgent.value = false
  editingAgentIndex.value = -1
  resetAgentForm()
}

// 重置Agent表单
const resetAgentForm = () => {
  agentPlatformType.value = 'a2a'
  a2aUrl.value = ''
  agentCard.value = null
  cozeBotId.value = ''
  cozeToken.value = ''
  cozeBaseURL.value = ''
  cozeBotInfo.value = null
  agentErrorMessage.value = ''
  isAgentLoading.value = false
}

// 获取Agent信息
async function fetchAgentInfo() {
  if (!a2aUrl.value.trim()) return

  isAgentLoading.value = true
  agentErrorMessage.value = ''
  agentCard.value = null

  try {
    const client = new A2AClient({ url: a2aUrl.value.trim() })
    const card = await client.getAgentCard()

    if (card) {
      agentCard.value = card
    } else {
      agentErrorMessage.value = '无法获取Agent信息，请检查地址是否正确'
    }
  } catch (error) {
    agentErrorMessage.value = error instanceof Error ? error.message : '获取Agent信息失败'
  } finally {
    isAgentLoading.value = false
  }
}

// 获取Coze Bot信息
async function fetchCozeBotInfo() {
  if (!cozeBotId.value.trim() || !cozeToken.value.trim()) return

  isAgentLoading.value = true
  agentErrorMessage.value = ''
  cozeBotInfo.value = null

  try {
    const adapter = new CozeAgentAdapter({
      bot_id: cozeBotId.value.trim(),
      token: cozeToken.value.trim(),
      baseURL: cozeBaseURL.value.trim() || undefined,
    })
    const card = await adapter.getBotInfo()

    if (card) {
      cozeBotInfo.value = card
    } else {
      agentErrorMessage.value = '无法获取Bot信息，请检查Bot ID和Token是否正确'
    }
  } catch (error) {
    agentErrorMessage.value = error instanceof Error ? error.message : '获取Bot信息失败'
  } finally {
    isAgentLoading.value = false
  }
}

// 处理Agent确认添加
const handleAgentConfirm = async () => {
  if (!canSubmitAgent.value) return

  if (isEditingAgent.value && editingAgentIndex.value >= 0) {
    // 编辑模式：先删除旧的（旧 key 可能因类型变更而不同），再添加新的
    const oldConfig = chatResourceStore.remoteAgents[editingAgentIndex.value]
    if (oldConfig) {
      await chatResourceStore.deleteRemoteAgent(oldConfig)
    }
  }

  if (agentPlatformType.value === 'a2a') {
    await chatResourceStore.addRemoteAgent({
      type: 'remote_agent',
      url: a2aUrl.value.trim(),
      agentCard: agentCard.value || undefined
    })
  } else if (agentPlatformType.value === 'coze') {
    await chatResourceStore.addRemoteAgent({
      type: 'coze',
      bot_id: cozeBotId.value.trim(),
      token: cozeToken.value.trim(),
      baseURL: cozeBaseURL.value.trim() || undefined,
      name: cozeBotInfo.value?.name,
      description: cozeBotInfo.value?.description,
      agentCard: cozeBotInfo.value || undefined
    })
    SecureStorageService.storeApiKey('coze', cozeToken.value.trim())
  }

  cancelAgentConfiguration()
}

// 确认删除远程Agent
const confirmDeleteAgent = async () => {
  try {
    if (deleteAgentConfig.value) {
      await chatResourceStore.deleteRemoteAgent(deleteAgentConfig.value)
    }
  } catch (err) {
    console.error('删除远程Agent失败:', err)
    alert('删除失败')
  } finally {
    showDeleteConfirm.value = false
    deleteAgentConfig.value = null
  }
}

// 取消删除远程Agent
const cancelDeleteAgent = () => {
  showDeleteConfirm.value = false
  deleteAgentConfig.value = null
}

// 设置活跃Tab
const setActiveTab = (tab: string) => {
  activeTab.value = tab
}

// 获取所有供应商（从 ModelInfoService 动态获取）
const providers = computed(() => {
  const allInfos = modelInfoService.getAllModelInfos()
  const seen = new Map<string, { type: ModelType; name: string }>()
  
  for (const info of allInfos) {
    const key = `${info.type}:${info.provider}`
    if (!seen.has(key)) {
      seen.set(key, { type: info.type, name: info.provider })
    }
  }
  
  return Array.from(seen.values())
})

// 格式化token数量
const formatTokenCount = (count?: number): string => {
  if (!count) return '未知'
  if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`
  if (count >= 1000) return `${(count / 1000).toFixed(1)}K`
  return count.toString()
}



// 提交自定义供应商
const submitCustomProvider = async () => {
  if (!customProviderName.value || !customBaseURL.value || !customApiKey.value || !customModelNames.value) {
    saveMessage.value = '请填写所有必填字段'
    saveMessageType.value = 'error'
    setTimeout(() => { saveMessage.value = '' }, 3000)
    return
  }

  const modelNames = customModelNames.value.split(',').map(s => s.trim()).filter(Boolean)
  if (modelNames.length === 0) {
    saveMessage.value = '请至少输入一个模型名'
    saveMessageType.value = 'error'
    return
  }

  // 解析 extra_config
  let extraConfig: Record<string, any> = {}
  if (customExtraConfig.value.trim()) {
    try {
      extraConfig = JSON.parse(customExtraConfig.value.trim())
    } catch {
      saveMessage.value = '额外配置 JSON 格式无效'
      saveMessageType.value = 'error'
      setTimeout(() => { saveMessage.value = '' }, 3000)
      return
    }
  }

  let addedCount = 0
  for (const modelName of modelNames) {
    const params: AddModelParams = {
      model_name: modelName,
      provider: customProviderName.value,
      base_url: customBaseURL.value,
      api_key: customApiKey.value,
      protocol: customProtocol.value,
      display_name: modelName,
      max_context_tokens: customMaxContextTokens.value,
      max_output_tokens: customMaxOutputTokens.value,
      supports_streaming: customSupportsStreaming.value,
      supports_tools: customSupportsTools.value,
      supports_thinking: customSupportsThinking.value,
      extra_config: extraConfig,
      description: customDescription.value || undefined,
      version: customVersion.value || undefined,
      documentation: customDocumentation.value || undefined,
    }

    const result = await builtInToolExecutor.executeAddModel(params)
    if (result.success) {
      addedCount++
    } else {
      saveMessage.value = result.error || `添加模型 ${modelName} 失败`
      saveMessageType.value = 'error'
      setTimeout(() => { saveMessage.value = '' }, 3000)
    }
  }

  // 重置表单
  showCustomProviderForm.value = false
  customProviderName.value = ''
  customBaseURL.value = ''
  customProtocol.value = 'openai-chat'
  customApiKey.value = ''
  customModelNames.value = ''
  customMaxContextTokens.value = undefined
  customMaxOutputTokens.value = undefined
  customSupportsStreaming.value = false
  customSupportsTools.value = false
  customSupportsThinking.value = false
  customExtraConfig.value = ''
  customDescription.value = ''
  customVersion.value = ''
  customDocumentation.value = ''

  if (addedCount > 0) {
    saveMessage.value = `成功添加 ${addedCount} 个自定义模型`
    saveMessageType.value = 'success'
    setTimeout(() => { saveMessage.value = '' }, 3000)
  }
}

// 切换API Key可见性
const toggleApiKeyVisibility = () => {
  showApiKey.value = !showApiKey.value
}

// 处理供应商变更
const handleProviderChange = async () => {
  // 清除保存消息
  saveMessage.value = ''
  saveMessageType.value = ''
  
  if (!selectedProvider.value) {
    availableModels.value = []
    return
  }

  // 获取该供应商的模型信息
  const svc = ModelInfoService.getInstance()
  
  const models = svc.getModelInfosByProvider(selectedProvider.value)
  availableModels.value = models || []

  // 统一按 provider 名称查询 API Key
  const hasKey = await SecureStorageService.hasApiKey(selectedProvider.value)
  hasStoredApiKey.value = hasKey

  if (hasKey) {
    const storedKey = await SecureStorageService.getApiKey(selectedProvider.value)
    apiKey.value = storedKey || ''
  } else {
    apiKey.value = ''
  }
}

// 保存API Key
const saveApiKey = async () => {
  if (!selectedProvider.value || !apiKey.value) return

  const keyIdentifier = getKeyIdentifier()

  isSaving.value = true
  saveMessage.value = ''
  saveMessageType.value = ''
  
  try {
    const success = await SecureStorageService.storeApiKey(keyIdentifier, apiKey.value)
    if (success) {
      hasStoredApiKey.value = true
      saveMessage.value = 'API密钥已成功保存'
      saveMessageType.value = 'success'
      
      const hasKey = await SecureStorageService.hasApiKey(keyIdentifier)
      if (!hasKey) {
        saveMessage.value = 'API密钥保存失败，请重试'
        saveMessageType.value = 'error'
        hasStoredApiKey.value = false
      }
    } else {
      saveMessage.value = 'API密钥保存失败，请检查输入后重试'
      saveMessageType.value = 'error'
    }
  } catch (error) {
    console.error('保存API Key失败:', error)
    saveMessage.value = `保存失败: ${error instanceof Error ? error.message : '未知错误'}`
    saveMessageType.value = 'error'
  } finally {
    isSaving.value = false
  }
}

// 删除API Key
const deleteApiKey = async () => {
  if (!selectedProvider.value) return

  const keyIdentifier = getKeyIdentifier()

  try {
    const success = await SecureStorageService.deleteApiKey(keyIdentifier)
    if (success) {
      hasStoredApiKey.value = false
      apiKey.value = ''
      saveMessage.value = 'API密钥已成功删除'
      saveMessageType.value = 'success'
      
      const hasKey = await SecureStorageService.hasApiKey(keyIdentifier)
      if (hasKey) {
        saveMessage.value = 'API密钥删除失败，请重试'
        saveMessageType.value = 'error'
        hasStoredApiKey.value = true
      }
    } else {
      saveMessage.value = 'API密钥删除失败，请重试'
      saveMessageType.value = 'error'
    }
  } catch (error) {
    console.error('删除API Key失败:', error)
    saveMessage.value = `删除失败: ${error instanceof Error ? error.message : '未知错误'}`
    saveMessageType.value = 'error'
  }
}

// 统一按 provider 名称作为 key 标识
const getKeyIdentifier = (): string => {
  return selectedProvider.value
}

// 检查模型是否已选择
const isModelSelected = (modelName: string): boolean => {
  return selectedModels.value.some(model => model.name === modelName)
}

// 切换模型选择状态
const toggleModelSelection = (model: ModelInfo) => {
  const index = selectedModels.value.findIndex(m => m.name === model.name)
  if (index === -1) {
    // 添加模型
    selectedModels.value.push(model)
  } else {
    // 移除模型
    selectedModels.value.splice(index, 1)
  }
  // 保存已选择的模型
  saveSelectedModels()
}

// 移除模型
const removeModel = (modelName: string) => {
  const index = selectedModels.value.findIndex(m => m.name === modelName)
  if (index !== -1) {
    selectedModels.value.splice(index, 1)
    // 保存已选择的模型
    saveSelectedModels()
  }
}

// 打开参数设置对话框
const openParameterDialog = (model: ModelInfo) => {
  currentModel.value = model
  showParameterDialog.value = true
}

// 关闭参数设置对话框
const closeParameterDialog = () => {
  showParameterDialog.value = false
  currentModel.value = null
}

// 处理参数保存
const handleParameterSave = (modelName: string, _parameters: { [key: string]: any }) => {
  // 可以在这里添加保存成功后的提示
  saveMessage.value = `模型 ${modelName} 的参数已保存`
  saveMessageType.value = 'success'
  
  // 3秒后清除消息
  setTimeout(() => {
    saveMessage.value = ''
    saveMessageType.value = ''
  }, 3000)
}

// 保存已选择的模型
const saveSelectedModels = () => {
  const selectedModelsService = SelectedModelsService.getInstance()
  selectedModelsService.saveSelectedModels(selectedModels.value)
}

// 加载已选择的模型
const loadSelectedModels = () => {
  const selectedModelsService = SelectedModelsService.getInstance()
  selectedModels.value = selectedModelsService.getSelectedModels()
}

// 处理切换Tab事件（白名单覆盖全部有效页签）
const SETTINGS_TABS = ['models', 'mcp', 'agent', 'skills', 'knowledge']
const handleSwitchTab = (tab: string) => {
  if (SETTINGS_TABS.includes(tab)) {
    setActiveTab(tab)
  }
}

// Esc 关闭设置（组件常驻挂载，仅在面板可见时响应）
const handleEscKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape' && props.visible) {
    emit('close-settings')
  }
}

// 组件挂载时加载已选择的模型
onMounted(() => {
  loadSelectedModels()

  // 目标模式评估器模型配置回显（kvStore 现读）
  evaluatorModel.value = evaluatorKv?.getItem('defaultEvaluatorModel') ?? ''

  // 工具渐进发现开关回显（opt-out：读不到/'true'=开，仅 'false' 为关）
  progressiveTools.value = evaluatorKv?.getItem('progressive_tools') !== 'false'

  // 桌面能力开关回显（opt-in：仅 'true' 为开）
  desktopControl.value = evaluatorKv?.getItem('desktop_control_enabled') === 'true'
  
  // 加载远程Agent数据
  chatResourceStore.loadResources()
  
  // 加载本地Agent列表
  chatResourceStore.loadLocalAgents()
  
  // lead_agent_system_prompt 配置已退役（调度人设由 core 委派指南统一维护），清理旧键
  try { localStorage.removeItem('lead_agent_system_prompt') } catch { /* ignore */ }

  // 监听切换Tab事件
  eventBus.on(EVENTS.SWITCH_SETTINGS_TAB, handleSwitchTab)

  // 监听 Esc 关闭设置
  window.addEventListener('keydown', handleEscKeydown)
})

// 组件卸载时清理事件监听
onUnmounted(() => {
  eventBus.off(EVENTS.SWITCH_SETTINGS_TAB, handleSwitchTab)
  window.removeEventListener('keydown', handleEscKeydown)
})
</script>

<style scoped>
/* 视觉规格来自契约层 settings.css（settings-page/group/card/badge/btn/input/label/hint/notice）；
   此处只保留页内结构性布局与少量局部变体 */
.model-settings-container,
.mcp-settings-container,
.agent-settings-container,
.skill-settings-container,
.knowledge-settings-container {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  overflow: hidden;
  background-color: var(--background-tertiary);
}

/* 滚动由 settings-main 独占；列表/配置视图均为自然流 */
.agent-list-view {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.agent-config-input-view .config-header {
  margin-bottom: var(--spacing-4);
}

.agent-config-input-view .config-input-section {
  background-color: var(--background-primary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  padding: var(--spacing-6);
  margin-bottom: var(--spacing-6);
}

.agent-config-input-view .form-group {
  margin-bottom: var(--spacing-5);
}

.agent-config-input-view .required {
  color: var(--error-color);
}

.agent-config-input-view .input-with-button {
  display: flex;
  gap: var(--spacing-3);
}

.agent-config-input-view .input-with-button .settings-input {
  flex: 1;
  width: auto;
}

.agent-config-input-view .button-group {
  display: flex;
  gap: var(--spacing-3);
  justify-content: flex-start;
}

.agent-config-input-view .agent-preview {
  background-color: var(--background-secondary);
  border-radius: var(--radius-lg);
  padding: var(--spacing-4);
  margin-top: var(--spacing-4);
}

.agent-config-input-view .preview-title {
  font-size: var(--font-size-base);
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 var(--spacing-3) 0;
}

.agent-config-input-view .preview-content {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-2);
}

.agent-config-input-view .preview-item {
  display: flex;
  align-items: flex-start;
  gap: var(--spacing-2);
  font-size: var(--font-size-base);
}

.agent-config-input-view .preview-label {
  color: var(--text-secondary);
  font-weight: 500;
  white-space: nowrap;
}

.agent-config-input-view .preview-value {
  color: var(--text-primary);
  flex: 1;
}

.agent-config-input-view .capabilities-tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-2);
}



.settings-main {
  flex: 1;
  overflow-y: auto;
  /* 留白与限宽唯一归属 .settings-page（契约层 settings.css），此处只承担布局与滚动 */
}

.api-key-container {
  margin-top: var(--spacing-6);
}

.api-key-container .settings-notice {
  margin-top: var(--spacing-3);
}

.api-key-input-group {
  display: flex;
  gap: var(--spacing-2);
}

.api-key-input-group .settings-input {
  flex: 1;
  width: auto;
}

.api-key-actions {
  display: flex;
  gap: var(--spacing-3);
  margin-top: var(--spacing-4);
}

.models-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: var(--spacing-4);
}

.model-card {
  cursor: pointer;
}

.model-card.selected {
  border-color: var(--primary-color);
  background-color: rgba(var(--primary-color-rgb), 0.06);
}

.model-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--spacing-2);
}

.model-name {
  margin: 0;
  font-size: var(--font-size-lg);
  font-weight: 600;
  color: var(--text-primary);
}

.model-description {
  margin: 0 0 var(--spacing-3) 0;
  font-size: var(--font-size-base);
  color: var(--text-secondary);
  line-height: 1.4;
}

.model-features {
  display: flex;
  gap: var(--spacing-2);
  margin-bottom: var(--spacing-3);
}

.model-tokens {
  display: flex;
  justify-content: space-between;
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
}

.token-info {
  background-color: var(--background-secondary);
  padding: var(--spacing-1) var(--spacing-2);
  border-radius: var(--radius-sm);
}

.selected-models-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--spacing-3);
  margin-top: var(--spacing-4);
}

/* 契约卡片之上的行布局 */
.selected-model-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
}

.selected-model-info {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-1);
  flex: 1;
  min-width: 0;
}

.selected-model-name {
  font-weight: 600;
  color: var(--text-primary);
  font-size: var(--font-size-base);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.selected-model-provider {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
}

.selected-model-actions {
  display: flex;
  gap: var(--spacing-2);
}

/* Tab布局样式 */
.settings-tabs-layout {
  display: flex;
  height: 100%;
  background-color: var(--background-primary);
}

.settings-tabs-sidebar {
  width: min(80px, 12vw);
  min-width: 70px;
  background-color: var(--background-secondary);
  border-right: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  padding: var(--spacing-4);
  flex-shrink: 0;
}

.tabs-header {
  display: flex;
  justify-content: center;
  margin-bottom: var(--spacing-6);
}

.tabs-close-button {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--spacing-3);
  border: none;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all var(--transition-fast);
  background-color: transparent;
  color: var(--text-secondary);
}

.tabs-close-button:hover {
  background-color: var(--background-tertiary);
  color: var(--text-primary);
}

.tabs-nav {
  flex: 1;
}

.tab-item {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--spacing-3);
  margin-bottom: var(--spacing-1);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all var(--transition-fast);
  background-color: transparent;
  color: var(--text-secondary);
  position: relative;
}

.tab-item:hover {
  background-color: var(--background-tertiary);
  color: var(--text-primary);
}

.tab-item.active {
  background-color: var(--primary-color);
  color: white;
}

.tab-icon {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
}

.settings-content-area {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  min-width: 0; /* 防止flex子项溢出 */
}

/* 响应式布局 */
@media (max-width: 1024px) {
  .selected-models-grid {
    grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
  }
}

@media (max-width: 768px) {
  .models-grid {
    grid-template-columns: 1fr;
  }
}

/* 自定义供应商表单（嵌套面板，视觉走契约控件） */
.custom-provider-form {
  margin-top: var(--spacing-4);
  padding: var(--spacing-4);
  background-color: var(--background-primary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
}

.custom-provider-form .form-row {
  margin-bottom: var(--spacing-3);
}

.custom-provider-form .form-actions {
  display: flex;
  gap: var(--spacing-2);
  margin-top: var(--spacing-4);
}
</style>