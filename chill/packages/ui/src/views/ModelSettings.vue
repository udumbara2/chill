<template>
  <div class="settings-tabs-layout">
    <!-- 左侧Tab导航区域（macOS 式：图标 + 文字标签；窄窗口回退纯图标） -->
    <aside class="settings-tabs-sidebar">
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
          <span class="tab-label">模型</span>
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
          <span class="tab-label">MCP</span>
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
          <span class="tab-label">AGENT</span>
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
          <span class="tab-label">技能</span>
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
          <span class="tab-label">知识库</span>
        </div>
        <div
          class="tab-item"
          :class="{ active: activeTab === 'tools' }"
          @click="setActiveTab('tools')"
          title="工具"
        >
          <svg class="tab-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3L6.91 6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span class="tab-label">工具</span>
        </div>
        <div
          class="tab-item"
          :class="{ active: activeTab === 'desktop' }"
          @click="setActiveTab('desktop')"
          title="桌面"
        >
          <svg class="tab-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="2" y="3" width="20" height="14" rx="2" stroke="currentColor" stroke-width="2"/>
            <line x1="8" y1="21" x2="16" y2="21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            <line x1="12" y1="17" x2="12" y2="21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          <span class="tab-label">桌面</span>
        </div>
        <div
          class="tab-item"
          :class="{ active: activeTab === 'relay' }"
          @click="setActiveTab('relay')"
          title="手机"
        >
          <svg class="tab-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="7" y="2" width="10" height="20" rx="2" stroke="currentColor" stroke-width="2"/>
            <line x1="10" y1="18" x2="14" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          <span class="tab-label">手机</span>
        </div>
        <div
          class="tab-item"
          :class="{ active: activeTab === 'improvements' }"
          @click="setActiveTab('improvements')"
          title="改进提案"
        >
          <svg class="tab-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M22 12h-6l-2 3h-4l-2-3H2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span class="tab-label">改进提案</span>
        </div>
      </nav>
    </aside>

    <!-- 右侧内容区域（内部各 Tab 由 settings-main 承担滚动语义） -->
    <div class="settings-content-area">
      <!-- 关闭按钮：自侧栏顶部迁入内容区右上角（圆形幽灵按钮，绝对定位于内容区） -->
      <button
        class="tabs-close-button"
        @click="emit('close-settings')"
        title="关闭设置 (Esc)"
      >
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
      <!-- 模型设置Tab内容 -->
      <div v-if="activeTab === 'models'" class="model-settings-container">
        <main class="settings-main">
          <div class="settings-page">
            <div class="settings-page-header">
              <div>
                <h2>模型</h2>
                <p class="settings-page-description">配置模型供应商、API Key 与可用模型。</p>
              </div>
            </div>
            <!-- 已选择的模型区域 - 置顶网格布局（卡片吃契约 settings-card 规格） -->
        <section v-if="selectedModels.length > 0" class="settings-group">
          <div class="settings-group-head"><h3>已选择的模型</h3></div>
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
          <div class="settings-group-head"><h3>目标模式评估器模型</h3></div>
          <div class="settings-card settings-card-flush">
            <div class="settings-row">
              <div>
                <div class="settings-row-label">评估器模型</div>
                <div class="settings-row-desc">每轮结束判定目标是否达成；可配置更便宜的模型降低成本。</div>
              </div>
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
          </div>
        </section>

        <!-- 供应商选择和API Key输入区域（卡片行：左标签+描述，右控件） -->
        <section class="settings-group">
          <div class="settings-group-head"><h3>供应商设置</h3></div>
          <div class="settings-card settings-card-flush">
            <div class="settings-row">
              <div>
                <div class="settings-row-label">供应商</div>
                <div class="settings-row-desc">选择内置供应商或自定义 OpenAI 兼容端点。</div>
              </div>
              <div class="settings-actions">
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
            </div>
            <div v-if="selectedProvider" class="settings-row">
              <div>
                <div class="settings-row-label">API Key</div>
                <div class="settings-row-desc">{{ keyDomains.length === 0 ? '该供应商暂无绑定模型，Key 将写入模板域（建议先添加模型）。' : (keyDomains.length > 1 ? '该供应商存在多个通道（凭证域），请先选择域再保存。' : '仅存储在本机加密存储，不会上传。') }}</div>
              </div>
              <div class="api-key-input-group">
                <select
                  v-if="keyDomains.length > 1"
                  v-model="selectedKeyDomain"
                  class="settings-input"
                  title="凭证域（通道）"
                >
                  <option v-for="d in keyDomains" :key="d" :value="d">{{ d }}</option>
                </select>
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
            </div>
            <!-- 操作行：左侧保存状态消息（保存/删除反馈），右侧按钮组 -->
            <div v-if="selectedProvider" class="settings-row">
              <div>
                <div v-if="saveMessage" class="settings-notice" :class="'settings-notice-' + saveMessageType">
                  {{ saveMessage }}
                </div>
              </div>
              <div class="settings-actions">
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
          </div>

          <!-- 自定义供应商表单（嵌套面板，视觉走契约控件；字段名/帮助文案 = connect schema 单源） -->
          <div v-if="showCustomProviderForm" class="custom-provider-form">
            <div class="form-row">
              <label class="settings-label">供应商名:</label>
              <input v-model="customProviderName" :title="schemaDoc('provider')" placeholder="例如: Anthropic" class="settings-input" />
            </div>
            <div class="form-row">
              <label class="settings-label">Base URL:</label>
              <input v-model="customBaseURL" :title="schemaDoc('base_url')" placeholder="例如: https://api.anthropic.com" class="settings-input" />
            </div>
            <div class="form-row">
              <label class="settings-label">协议类型:</label>
              <input v-model="customProtocol" :title="schemaDoc('protocol')" placeholder="例如: openai-chat" class="settings-input" />
            </div>
            <div class="form-row">
              <label class="settings-label">API Key:</label>
              <input v-model="customApiKey" :title="schemaDoc('api_key')" type="password" placeholder="输入 API Key" class="settings-input" />
            </div>
            <div class="form-row">
              <label class="settings-label">模型 ID 列表:</label>
              <input v-model="customModelNames" :title="schemaDoc('models')" placeholder="上游 API 模型 ID，逗号分隔，例如: claude-sonnet-4,claude-opus-4" class="settings-input" />
            </div>
            <div class="form-row">
              <label class="settings-label">描述:</label>
              <input v-model="customDescription" :title="schemaDoc('description')" placeholder="模型描述（可选）" class="settings-input" />
            </div>
            <div class="form-row">
              <label class="settings-label">版本:</label>
              <input v-model="customVersion" :title="schemaDoc('version')" placeholder="版本号（可选）" class="settings-input" />
            </div>
            <div class="form-row">
              <label class="settings-label">文档 URL:</label>
              <input v-model="customDocumentation" :title="schemaDoc('documentation')" placeholder="文档链接（可选）" class="settings-input" />
            </div>
            <div class="form-row">
              <label class="settings-label">最大上下文 Tokens:</label>
              <input v-model.number="customMaxContextTokens" :title="schemaDoc('max_context_tokens')" type="number" class="settings-input" />
            </div>
            <div class="form-row">
              <label class="settings-label">最大输出 Tokens:</label>
              <input v-model.number="customMaxOutputTokens" :title="schemaDoc('max_output_tokens')" type="number" class="settings-input" />
            </div>
            <div class="form-row form-row-checkbox">
              <label class="settings-label">特性:</label>
              <div class="checkbox-group">
                <label class="checkbox-label"><input type="checkbox" v-model="customSupportsStreaming" :title="schemaDoc('supports_streaming')" /> 流式输出</label>
                <label class="checkbox-label"><input type="checkbox" v-model="customSupportsTools" :title="schemaDoc('supports_tools')" /> 工具调用</label>
                <label class="checkbox-label"><input type="checkbox" v-model="customSupportsThinking" :title="schemaDoc('supports_thinking')" /> 思考模式</label>
              </div>
            </div>
            <div class="form-actions">
              <button type="button" class="settings-btn settings-btn-primary" @click="submitCustomProvider">保存</button>
              <button type="button" class="settings-btn" @click="showCustomProviderForm = false">取消</button>
            </div>
          </div>

        </section>

        <!-- 可用模型展示区域 -->
        <section v-if="chatModels.length > 0" class="settings-group">
          <div class="settings-group-head"><h3>可用模型</h3></div>
          <div class="models-grid">
            <div
              v-for="model in chatModels"
              :key="model.name"
              class="settings-card model-card"
              :class="{ 'selected': isModelSelected(model.name), 'deprecated': model.deprecated }"
              @click="toggleModelSelection(model)"
            >
              <div class="model-header">
                <h3 class="model-name">{{ model.displayName }}</h3>
                <div class="settings-badge settings-badge-neutral">{{ model.provider }}</div>
              </div>
              <p class="model-description">{{ model.description }}</p>
              <div class="model-features">
                <span v-if="model.deprecated" class="settings-badge settings-badge-neutral">已退役</span>
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
          <div class="settings-group-head"><h3>生成模型</h3></div>
          <p class="settings-hint">经 generate_* 工具使用，不可切换为对话模型。</p>
          <div class="models-grid">
            <div
              v-for="model in genModels"
              :key="model.name"
              class="settings-card model-card readonly"
              :class="{ 'deprecated': model.deprecated }"
            >
              <div class="model-header">
                <h3 class="model-name">{{ model.displayName }}</h3>
                <div class="settings-badge settings-badge-neutral">{{ model.provider }}</div>
              </div>
              <p class="model-description">{{ model.description }}</p>
              <div v-if="model.deprecated" class="model-features">
                <span class="settings-badge settings-badge-neutral">已退役</span>
              </div>
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

      <!-- 工具管理Tab内容（工具渐进发现开关自模型页迁出：独立功能，非模型设置） -->
      <div v-else-if="activeTab === 'tools'" class="tools-settings-container">
        <main class="settings-main">
          <div class="settings-page">
            <div class="settings-page-header">
              <div>
                <h2>工具</h2>
                <p class="settings-page-description">管理模型可用工具的下发方式。</p>
              </div>
            </div>
            <!-- 工具渐进发现开关（kvStore 键 progressive_tools，与 CLI /tools mode 同一键；opt-out 默认开） -->
            <section class="settings-group">
              <div class="settings-group-head"><h3>工具渐进发现</h3></div>
              <div class="settings-card settings-card-flush">
                <div class="settings-row">
                  <div>
                    <div class="settings-row-label">渐进发现（省 token）</div>
                    <div class="settings-row-desc">每次请求只下发常驻核心工具，模型按需经 search_tools 检索激活其余工具；关闭则恢复全量下发（与 CLI /tools mode 同一配置键）。</div>
                  </div>
                  <label class="settings-switch">
                    <input type="checkbox" v-model="progressiveTools" @change="handleProgressiveToolsChange" />
                    <span class="settings-switch-slider"></span>
                  </label>
                </div>
              </div>
            </section>
          </div>
        </main>
      </div>

      <!-- 桌面能力Tab内容（截屏感知 + computer use，自模型页迁出：独立功能，非模型设置） -->
      <div v-else-if="activeTab === 'desktop'" class="desktop-settings-container">
        <main class="settings-main">
          <div class="settings-page">
            <div class="settings-page-header">
              <div>
                <h2>桌面</h2>
                <p class="settings-page-description">让助手看见并操作你的桌面：截屏感知、UI 元素识别、键鼠操作。</p>
              </div>
            </div>
            <!-- 桌面能力开关（kvStore 键 desktop_control_enabled，与 CLI /desktop 同一键；opt-in 默认关） -->
            <section class="settings-group">
              <div class="settings-group-head"><h3>桌面能力</h3></div>
              <div class="settings-card settings-card-flush">
                <div class="settings-row">
                  <div>
                    <div class="settings-row-label">桌面能力</div>
                    <div class="settings-row-desc">截屏（capture_screen）、前台窗口可交互元素识别（inspect_ui）、键鼠操作（computer_use，主动作逐次审批）。建议搭配视觉模型使用。</div>
                  </div>
                  <label class="settings-switch">
                    <input type="checkbox" v-model="desktopControl" @change="handleDesktopControlChange" />
                    <span class="settings-switch-slider"></span>
                  </label>
                </div>
                <!-- 操作审计留痕（kvStore 键 desktop_audit，与 CLI /desktop audit 同一键；opt-out 默认开） -->
                <div class="settings-row">
                  <div>
                    <div class="settings-row-label">操作审计留痕</div>
                    <div class="settings-row-desc">动作逐条记录到本地审计日志（按日 jsonl），可随时查看。</div>
                  </div>
                  <label class="settings-switch">
                    <input type="checkbox" v-model="desktopAudit" @change="handleDesktopAuditChange" />
                    <span class="settings-switch-slider"></span>
                  </label>
                </div>
              </div>
            </section>
          </div>
        </main>
      </div>

      <!-- 手机 Tab（M2a：盲中继配置 + 扫码配对 + 已配对设备） -->
      <div v-else-if="activeTab === 'relay'" class="relay-settings-container">
        <main class="settings-main">
          <div class="settings-page">
            <div class="settings-page-header">
              <div>
                <h2>手机</h2>
                <p class="settings-page-description">经盲中继把手机连到这台电脑：扫码配对后，手机消息注入当前会话，回复回流手机。中继只见密文。</p>
              </div>
            </div>

            <!-- 中继配置卡片（存 secureStorage） -->
            <section class="settings-group">
              <div class="settings-group-head"><h3>中继配置</h3></div>
              <div class="settings-card settings-card-flush">
                <div class="settings-row">
                  <div style="flex:1">
                    <div class="settings-row-label">relay 地址</div>
                    <input v-model="relayConfigForm.relayUrl" placeholder="wss://<host>:8443" style="width:100%" />
                  </div>
                </div>
                <div class="settings-row">
                  <div style="flex:1">
                    <div class="settings-row-label">运营者密钥</div>
                    <input v-model="relayConfigForm.operatorKey" type="password" placeholder="服务器 operator.env 的 OPERATOR_KEY" style="width:100%" />
                  </div>
                </div>
                <div class="settings-row">
                  <div style="flex:1">
                    <div class="settings-row-label">私有 CA 证书路径（wss 必填）</div>
                    <input v-model="relayConfigForm.caPath" placeholder="C:\path\to\ca.crt" style="width:100%" />
                  </div>
                </div>
                <div class="settings-row">
                  <div class="settings-row-desc">配置存 secureStorage；caFP 由 CA 文件计算（手机扫码时核对）。</div>
                  <button class="settings-action-button" @click="saveRelayConfig" :disabled="relayBusy">保存配置</button>
                </div>
              </div>
            </section>

            <!-- 配对二维码卡片 -->
            <section class="settings-group">
              <div class="settings-group-head"><h3>配对</h3></div>
              <div class="settings-card settings-card-flush">
                <div class="settings-row">
                  <div>
                    <div class="settings-row-label">状态：{{ relayState.connected ? '已连接中继' : relayState.running ? 'relay 运行中（未连接）' : 'relay 未运行' }}</div>
                    <div class="settings-row-desc" v-if="relayState.lastError">⚠️ {{ relayState.lastError }}</div>
                    <div class="settings-row-desc" v-if="relayPairMessage">{{ relayPairMessage }}</div>
                  </div>
                  <button class="settings-action-button" @click="startPair" :disabled="relayBusy">生成配对二维码</button>
                </div>
                <div class="settings-row" v-if="relayQrDataUrl">
                  <div style="text-align:center;flex:1">
                    <img :src="relayQrDataUrl" alt="配对二维码" style="max-width:260px;image-rendering:pixelated" />
                    <div class="settings-row-desc">用手机 chill App 扫码。配对完成后请关闭本卡片（QR 含一次性令牌）。</div>
                  </div>
                </div>
              </div>
            </section>

            <!-- 已配对设备列表 -->
            <section class="settings-group">
              <div class="settings-group-head"><h3>已配对设备</h3></div>
              <div class="settings-card settings-card-flush">
                <div class="settings-row" v-if="relayDevices.length === 0">
                  <div class="settings-row-desc">（无已配对设备）</div>
                </div>
                <div class="settings-row" v-for="d in relayDevices" :key="d.phonePub">
                  <div>
                    <div class="settings-row-label">{{ d.device }}</div>
                    <div class="settings-row-desc">pairedAt={{ d.pairedAt }}　phonePub={{ d.phonePub.slice(0, 12) }}…</div>
                  </div>
                  <button class="settings-action-button" @click="revokeDevice(d)" :disabled="relayBusy">注销</button>
                </div>
              </div>
            </section>
          </div>
        </main>
      </div>

      <!-- AGENT配置Tab内容 -->
      <div v-else-if="activeTab === 'improvements'" class="improvements-settings-container">
        <main class="settings-main">
        <!-- 改进提案面板（决策闭环迭代 3）：设置=资产唯一的家——四区账本 + 簇卡片决策；
             数据/写盘全走 core ImprovementLedger 单例（渲染进程直跑 core，零新增 IPC） -->
        <ImprovementsPanel />
        </main>
      </div>

      <div v-else-if="activeTab === 'agent'" class="agent-settings-container">
        <main class="settings-main">
        <!-- 资产中心(UI 三层显示统一 · 迭代 3 + 远程卡片化/欢迎页):单 Agent | Agent 团队 | 工作流 | 远程 Agent 四分组卡片;
             远程组四事件接既有四个 handle(原 RemoteAgentManager 接线平移);empty-change 联动隐藏委派限额 -->
        <AgentAssetsPanel
          @open-workflow-canvas="handleOpenWorkflowCanvas"
          @add-agent="handleAddAgent"
          @edit-remote-agent="handleEditRemoteAgent"
          @delete-remote-agent="handleDeleteRemoteAgent"
          @toggle-remote-agent="handleToggleRemoteAgent"
          @empty-change="assetsAllEmpty = $event"
        />

        <!-- Agent配置输入视图 -->
        <div v-if="isConfiguringAgent" class="agent-config-input-view settings-page">
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

        <!-- 委派资源限额（kvStore 键 delegation_max_concurrent/delegation_max_cumulative，与 CLI /limits 同一对键；空 = 默认） -->
        <section v-if="!assetsAllEmpty" class="settings-group">
          <div class="settings-group-head"><h3>委派限额</h3></div>
          <div class="settings-card settings-card-flush">
            <div class="settings-row">
              <div>
                <div class="settings-row-label">并发上限</div>
                <div class="settings-row-desc">同时在跑的后台委派任务数上限，超出拒绝新委派（默认 6，Codex max_threads 参照；留空即默认）。</div>
              </div>
              <input
                class="settings-input"
                type="number" min="1" step="1" placeholder="6"
                v-model="delegationMaxConcurrent"
                @change="handleMaxConcurrentChange"
              />
            </div>
            <div class="settings-row">
              <div>
                <div class="settings-row-label">累计上限</div>
                <div class="settings-row-desc">进程内累计委派数上限，含已完成的任务（默认 200，Claude Code 会话累计参照；重启进程重置计数，留空即默认）。</div>
              </div>
              <input
                class="settings-input"
                type="number" min="1" step="1" placeholder="200"
                v-model="delegationMaxCumulative"
                @change="handleMaxCumulativeChange"
              />
            </div>
            <div class="settings-row">
              <div>
                <div class="settings-row-label">恢复默认</div>
                <div class="settings-row-desc">清除自定义值，两项都回到默认（6 / 200）。</div>
              </div>
              <button class="settings-btn" @click="resetLimits">恢复默认</button>
            </div>
          </div>
        </section>
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
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { eventBus, EVENTS, ModelType, ModelInfo, SecureStorageService, SelectedModelsService, ModelInfoService, modelInfoService, builtInToolExecutor, A2AClient, CozeAgentAdapter, providerManager, deriveModelKind } from '@assistant-ai/core'
import type { AgentCard, RemoteAgentConfig, AddModelParams } from '@assistant-ai/core'
import { getHostAPI, tryGetHostAPI } from '../host/hostApi'
import { listKeySlotDomains, resolveKeySlotId, CONNECT_PARAM_SCHEMA } from '@assistant-ai/core'
import { useChatResourceStore } from '../stores/chatResourceStore'
import ModelParameterDialog from '../components/ModelParameterDialog.vue'
import { IPCKeyValueStore } from '../adapters/IPCKeyValueStore'
import { getChatEngine } from '../services/chatEngine'
import McpConfig from '../components/mcp/McpConfig.vue'
import SkillSettings from '../components/skill/SkillSettings.vue'
import KnowledgeSettings from '../components/knowledge/KnowledgeSettings.vue'
import AgentAssetsPanel from '../components/settings/AgentAssetsPanel.vue'
import ImprovementsPanel from '../components/settings/ImprovementsPanel.vue'
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
const evaluatorKv = tryGetHostAPI()?.getKeyValue ? new IPCKeyValueStore() : null
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

// 委派资源限额（kvStore 键 delegation_max_concurrent/delegation_max_cumulative，与 CLI /limits 同一对键；
// 每次委派现读即改即生效；复用 evaluatorKv——IPCKeyValueStore 是无状态 IPC 桥）
const delegationMaxConcurrent = ref<string>('')
const delegationMaxCumulative = ref<string>('')

/** 限额输入落盘：正整数写入，空/非法值删除键回退默认（core 兜底 6/200） */
const saveLimitKey = (key: string, raw: string): void => {
  if (!evaluatorKv) return
  const n = Number(raw)
  if (raw.trim() !== '' && Number.isInteger(n) && n > 0) {
    evaluatorKv.setItem(key, String(n))
  } else {
    evaluatorKv.removeItem(key)
  }
}
const handleMaxConcurrentChange = () => saveLimitKey('delegation_max_concurrent', delegationMaxConcurrent.value)
const handleMaxCumulativeChange = () => saveLimitKey('delegation_max_cumulative', delegationMaxCumulative.value)
const resetLimits = (): void => {
  delegationMaxConcurrent.value = ''
  delegationMaxCumulative.value = ''
  evaluatorKv?.removeItem('delegation_max_concurrent')
  evaluatorKv?.removeItem('delegation_max_cumulative')
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

// 桌面操作审计留痕开关（kvStore 键 desktop_audit，opt-out：读不到/'true'=开；与 CLI /desktop audit 同一键。
// 仅持久化开关：core builtInToolExecutor 现读现生效，UI 侧无需额外动作）
const desktopAudit = ref<boolean>(true)
const handleDesktopAuditChange = () => {
  if (!evaluatorKv) return
  evaluatorKv.setItem('desktop_audit', desktopAudit.value ? 'true' : 'false')
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
const customDescription = ref<string>('')
const customVersion = ref<string>('')
const customDocumentation = ref<string>('')

// Tab状态管理
const activeTab = ref<string>('models')

// ========== 手机 Tab（M2a relay） ==========
import {
  getPairingManager,
  startPairingSession,
  stopRelay,
  relayState,
} from '../services/relayService'
import type { PairedDevice } from '@assistant-ai/core'

const relayConfigForm = ref({ relayUrl: '', operatorKey: '', caPath: '' })
const relayDevices = ref<PairedDevice[]>([])
const relayQrDataUrl = ref('')
const relayPairMessage = ref('')
const relayBusy = ref(false)

async function loadRelayTab(): Promise<void> {
  const pm = getPairingManager()
  const config = await pm.getRelayConfig()
  if (config) {
    relayConfigForm.value.relayUrl = config.relayUrl
    relayConfigForm.value.operatorKey = config.operatorKey
  }
  relayConfigForm.value.caPath = (await pm.getCaPath()) ?? ''
  relayDevices.value = await pm.listDevices()
}

async function saveRelayConfig(): Promise<void> {
  relayBusy.value = true
  relayPairMessage.value = ''
  try {
    const f = relayConfigForm.value
    if (!/^wss?:\/\//.test(f.relayUrl)) {
      relayPairMessage.value = '❌ relay 地址须以 ws:// 或 wss:// 开头'
      return
    }
    let caFP = ''
    if (f.relayUrl.startsWith('wss://')) {
      if (!f.caPath) {
        relayPairMessage.value = '❌ wss 模式必须提供私有 CA 证书路径'
        return
      }
      caFP = (await getHostAPI().relayCaFP(f.caPath)).caFP
    }
    await getPairingManager().saveRelayConfig({
      relayUrl: f.relayUrl,
      operatorKey: f.operatorKey,
      caFP,
      caPath: f.caPath,
    })
    relayPairMessage.value = '✅ 配置已保存'
  } catch (err) {
    relayPairMessage.value = `❌ ${String(err)}`
  } finally {
    relayBusy.value = false
  }
}

async function startPair(): Promise<void> {
  relayBusy.value = true
  relayPairMessage.value = ''
  relayQrDataUrl.value = ''
  try {
    const session = await startPairingSession('chill 桌面')
    const { default: QRCode } = await import('qrcode')
    relayQrDataUrl.value = await QRCode.toDataURL(JSON.stringify(session.qr), { margin: 1, width: 260 })
    relayPairMessage.value = '等待手机 redeem…'
    const result = await session.wait()
    relayPairMessage.value = result.message
    if (result.ok) {
      relayQrDataUrl.value = ''
      relayDevices.value = await getPairingManager().listDevices()
    }
  } catch (err) {
    relayPairMessage.value = `❌ ${String(err)}`
  } finally {
    relayBusy.value = false
  }
}

async function revokeDevice(d: PairedDevice): Promise<void> {
  if (!window.confirm(`注销设备「${d.device}」？将注销其对向信箱并删除本地记录。`)) return
  relayBusy.value = true
  try {
    const pm = getPairingManager()
    const config = await pm.getRelayConfig()
    if (!config) throw new Error('relay 未配置')
    const { ElectronRelayHttp } = await import('../adapters/ElectronRelayTransport')
    const http = new ElectronRelayHttp(config.relayUrl, (await pm.getCaPath()) ?? undefined)
    const r = await pm.revokeDevice(http, d.phonePub)
    relayPairMessage.value = r.ok ? `✅ 已注销 ${d.device}` : `⚠️ 服务器 HTTP ${r.status}；本地记录已删除`
    relayDevices.value = await pm.listDevices()
    if ((await pm.listDevices()).length === 0) await stopRelay()
  } catch (err) {
    relayPairMessage.value = `❌ ${String(err)}`
  } finally {
    relayBusy.value = false
  }
}

void loadRelayTab()

// Store
const chatResourceStore = useChatResourceStore()

// Emits
const emit = defineEmits<{
  'close-settings': []
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

// 资产中心"编辑画布/新建工作流":画布在 dock 里(设置覆盖层 z-index 高于 dock),先关设置再开 dock 工作流页签
const handleOpenWorkflowCanvas = () => {
  emit('close-settings')
  emit('open-agent-factory')
}

// 资产中心全空联动(设计稿 A 整页语义):全空时连委派限额一并隐藏
const assetsAllEmpty = ref(false)

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

// 处理删除远程Agent
const handleDeleteRemoteAgent = (config: RemoteAgentConfig) => {
  deleteAgentConfig.value = config
  const agentName = config?.agentCard?.name || (config?.type === 'coze' ? '扣子Agent' : '远程Agent')
  deleteConfirmMessage.value = `确定要删除远程Agent "${agentName}" 吗？\n\n注意：此操作不可恢复。`
  showDeleteConfirm.value = true
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



// 表单帮助文案 = connect schema 单源（UI 只消费 schema，不自造字段与说明）
const schemaDoc = (name: string): string =>
  ((CONNECT_PARAM_SCHEMA.properties as Record<string, { description?: string }>)[name]?.description) ?? ''

// 提交自定义供应商（connect 契约投影：字段名 = CONNECT_PARAM_SCHEMA，UI 不自造字段）
const submitCustomProvider = async () => {
  if (!customProviderName.value || !customBaseURL.value || !customApiKey.value || !customModelNames.value) {
    saveMessage.value = '请填写所有必填字段'
    saveMessageType.value = 'error'
    setTimeout(() => { saveMessage.value = '' }, 3000)
    return
  }

  const modelNames = customModelNames.value.split(',').map(s => s.trim()).filter(Boolean)
  if (modelNames.length === 0) {
    saveMessage.value = '请至少输入一个模型 ID'
    saveMessageType.value = 'error'
    return
  }

  // 能力字段标 declared（缺省时 connect 按探测/目录/保守缺省收敛）；supported_modalities 按 supports_* 派生
  const modalityParts = ['text']
  if (customSupportsTools.value) modalityParts.push('function_calling', 'json_mode')
  if (customSupportsThinking.value) modalityParts.push('thinking_mode')
  // 一次勾选多项（models = 上游真实 ID 清单）；本地注册名缺省自动派生消歧，不再被迫发明假注册名
  const params: AddModelParams = {
    models: modelNames,
    provider: customProviderName.value,
    base_url: customBaseURL.value,
    api_key: customApiKey.value,
    protocol: customProtocol.value,
    supported_modalities: modalityParts.join(','),
    max_context_tokens: customMaxContextTokens.value ?? 128000,
    max_output_tokens: customMaxOutputTokens.value ?? 16384,
    supports_streaming: customSupportsStreaming.value,
    supports_tools: customSupportsTools.value,
    supports_thinking: customSupportsThinking.value,
    description: customDescription.value || undefined,
    version: customVersion.value || undefined,
    documentation: customDocumentation.value || undefined,
  }

  const result = await builtInToolExecutor.executeAddModel(params)
  if (result.success) {
    saveMessage.value = result.data || `成功添加 ${modelNames.length} 个模型`
    saveMessageType.value = 'success'
    setTimeout(() => { saveMessage.value = '' }, 3000)
  } else {
    saveMessage.value = result.error || `添加模型失败`
    saveMessageType.value = 'error'
    setTimeout(() => { saveMessage.value = '' }, 3000)
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
  customDescription.value = ''
  customVersion.value = ''
  customDocumentation.value = ''
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

  // 域作用域：多域列选（默认首个）、单域直写、无绑定域缺省模板域（getKeyIdentifier 同轨解析，V5）
  const domains = listKeySlotDomains(selectedProvider.value, models || [])
  if (!domains.includes(selectedKeyDomain.value)) selectedKeyDomain.value = domains[0] ?? ''

  const keyIdentifier = getKeyIdentifier()
  const hasKey = await SecureStorageService.hasApiKey(keyIdentifier)
  hasStoredApiKey.value = hasKey

  if (hasKey) {
    const storedKey = await SecureStorageService.getApiKey(keyIdentifier)
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

// 凭证域（通道）作用域的 key 标识：多域时跟随下拉选择，单域直定，无绑定域缺省模板域
//（不再裸用 provider 名——⑤病类的 UI 侧残留）
const keyDomains = computed<string[]>(() =>
  selectedProvider.value ? listKeySlotDomains(selectedProvider.value, availableModels.value) : [],
)
const selectedKeyDomain = ref<string>('')

const getKeyIdentifier = (): string => {
  const domains = keyDomains.value
  if (domains.length === 0) return resolveKeySlotId(selectedProvider.value)
  if (domains.length === 1) return domains[0]
  return selectedKeyDomain.value || domains[0]
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
const SETTINGS_TABS = ['models', 'mcp', 'agent', 'skills', 'knowledge', 'tools', 'desktop', 'relay', 'improvements']
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

  // 桌面操作审计留痕开关回显（opt-out：读不到/'true'=开，仅 'false' 为关）
  desktopAudit.value = evaluatorKv?.getItem('desktop_audit') !== 'false'

  // 委派资源限额回显（空 = 默认 6/200）
  delegationMaxConcurrent.value = evaluatorKv?.getItem('delegation_max_concurrent') ?? ''
  delegationMaxCumulative.value = evaluatorKv?.getItem('delegation_max_cumulative') ?? ''


  
  // 加载远程Agent数据（含资源列表）
  chatResourceStore.loadResources()

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

/* 滚动由 settings-main 独占；配置视图为自然流 */
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

/* 卡片行右槽控件定宽（契约 settings-input 默认 100% 宽，行内需收敛对齐演示稿规格） */
.settings-row .settings-input {
  width: 260px;
  flex-shrink: 0;
}

.api-key-input-group {
  display: flex;
  gap: var(--spacing-2);
  width: 340px;
  flex-shrink: 0;
}

/* 组内输入框撑满剩余宽度（置于行内定宽规则之后，同优先级后者胜出） */
.api-key-input-group .settings-input {
  flex: 1;
  width: auto;
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

/* deprecated 退役卡：置灰标注，仍可见可管理（取消选中），自动/默认路径不进 */
.model-card.deprecated {
  opacity: 0.55;
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

/* 侧栏（macOS 式：固定宽 + 图标文字并列；单消费者壳层，样式留在本组件 scoped 内） */
.settings-tabs-sidebar {
  width: 184px;
  flex-shrink: 0;
  background-color: var(--background-secondary);
  border-right: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  padding: var(--spacing-4) var(--spacing-3);
}

/* 关闭按钮：内容区右上角圆形幽灵按钮（内容区不滚动，滚动由 settings-main 承担，故定位不随内容漂移） */
.tabs-close-button {
  position: absolute;
  top: 14px;
  right: 16px;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: 50%;
  cursor: pointer;
  transition: background-color var(--transition-fast), color var(--transition-fast);
  background-color: transparent;
  color: var(--text-tertiary);
}

.tabs-close-button svg {
  width: 14px;
  height: 14px;
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
  gap: var(--spacing-3);
  padding: 7px 10px;
  margin-bottom: var(--spacing-1);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background-color var(--transition-fast), color var(--transition-fast);
  background-color: transparent;
  color: var(--text-secondary);
  position: relative;
}

.tab-item:hover {
  background-color: var(--background-tertiary);
  color: var(--text-primary);
}

/* 激活态：淡主色底 + 主色文字（macOS 侧栏语言），替代实心蓝底白字 */
.tab-item.active {
  background-color: rgba(var(--primary-color-rgb), 0.1);
  color: var(--primary-color);
  font-weight: 500;
}

.tab-icon {
  width: 17px;
  height: 17px;
  flex-shrink: 0;
  /* 部分图标（如扳手）描边贴 viewBox 边缘，svg 默认 overflow:hidden 会削掉边缘笔画 */
  overflow: visible;
}

.tab-label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.settings-content-area {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  min-width: 0; /* 防止flex子项溢出 */
  position: relative; /* 关闭按钮的定位锚 */
}

/* 关闭按钮遮挡预留：页面右 padding 加大到能容纳 28px 按钮（含子组件页，故 :deep） */
.settings-content-area :deep(.settings-page) {
  padding-right: 52px;
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

  /* 窄窗口：侧栏回退纯图标（隐藏文字标签、收窄） */
  .settings-tabs-sidebar {
    width: 64px;
    padding: var(--spacing-4) var(--spacing-2);
  }

  .tab-item {
    justify-content: center;
  }

  .tab-label {
    display: none;
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