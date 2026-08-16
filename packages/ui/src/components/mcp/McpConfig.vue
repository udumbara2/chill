<template>
  <div class="settings-page">
    <div class="settings-page-header">
      <h2>MCP服务器配置</h2>
    </div>

    <div class="mcp-config-content">
      <!-- 简洁的服务器列表视图 -->
      <div v-if="!isConfiguring" class="server-list-view">
        <div class="settings-group-head">
          <h3>已配置的服务器</h3>
          <div v-if="configuredServers.length > 0" class="refresh-section">
            <!-- 刷新按钮 -->
            <div class="refresh-button-inline">
              <button 
                @click="refreshAllConnections" 
                class="refresh-btn-inline" 
                :class="{ 'loading': isRefreshing }"
                :disabled="isRefreshing"
                title="刷新连接状态"
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
                  <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
                  <path d="M3 3v5h5"></path>
                  <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"></path>
                  <path d="M21 21v-5h-5"></path>
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
                  <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
                  <path d="M3 3v5h5"></path>
                  <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"></path>
                  <path d="M21 21v-5h-5"></path>
                </svg>
              </button>
            </div>
            
            <!-- 刷新结果显示 -->
            <div 
              v-if="refreshResult.show" 
              class="refresh-result" 
              :class="`result-${refreshResult.type}`"
            >
              <span class="result-icon">
                <svg v-if="refreshResult.type === 'success'" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                  <path d="M9 12l2 2 4-4"></path>
                  <path d="M21 12c0 4.97-4.03 9-9 9s-9-4.03-9-9 4.03-9 9-9 9 4.03 9 9z"></path>
                </svg>
                <svg v-else-if="refreshResult.type === 'error'" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                  <path d="M12 2L2 7l10 5 10-5-10-5z"></path>
                  <path d="M2 17l10 5 10-5"></path>
                  <path d="M2 12l10 5 10-5"></path>
                </svg>
                <svg v-else width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                  <circle cx="12" cy="12" r="10"></circle>
                  <path d="M12 16v-4"></path>
                  <path d="M12 8h.01"></path>
                </svg>
              </span>
              <span class="result-message">{{ refreshResult.message }}</span>
            </div>
          </div>
        </div>
        
        <div v-if="configuredServers.length === 0" class="settings-empty">
          <div class="settings-empty-icon">🔌</div>
          <p class="settings-empty-title">暂无配置的服务器</p>
          <p class="settings-empty-hint">添加一个 MCP 服务器开始扩展助手能力</p>
          <button @click="startConfiguration" class="settings-btn settings-btn-primary">+ 添加</button>
        </div>
        <div v-else class="server-list">
          <div
            v-for="server in configuredServers"
            :key="server.name || 'unnamed-server'"
            class="settings-card server-item"
          >
            <div class="server-info">
              <div class="server-header">
                <span class="server-name">{{ server.name || 'unnamed-server' }}</span>
              </div>
              <div class="server-details">
                <span class="settings-badge settings-badge-primary" v-if="getServerTransportType(server)">
                  {{ getServerTransportType(server) }}
                </span>
                <span
                  class="settings-badge"
                  :class="{ 'status-connected': 'settings-badge-success', 'status-disconnected': 'settings-badge-danger', 'status-unknown': 'settings-badge-warning' }[getServerStatusClass(server)]"
                >
                  {{ getServerStatusText(server) }}
                </span>
                <!-- 工具、资源、提示词图标容器 -->
                <div class="content-icons" v-if="isServerConnected(server)">
                  <div 
                    v-if="getServerTools(server).length > 0" 
                    class="content-icon tools-icon" 
                    :title="`工具列表 (${getServerTools(server).length}个)`"
                    @mouseenter="showContentTooltip(server, 'tools', $event)"
                    @mouseleave="delayedHideContentTooltip"
                    @mousemove="showContentTooltip(server, 'tools', $event)"
                  >
                    <span class="icon-emoji">🔧</span>
                    <span class="icon-count">{{ getServerTools(server).length }}</span>
                  </div>
                  <div 
                    v-if="getServerResources(server).length > 0" 
                    class="content-icon resources-icon" 
                    :title="`资源列表 (${getServerResources(server).length}个)`"
                    @mouseenter="showContentTooltip(server, 'resources', $event)"
                    @mouseleave="delayedHideContentTooltip"
                    @mousemove="showContentTooltip(server, 'resources', $event)"
                  >
                    <span class="icon-emoji">📁</span>
                    <span class="icon-count">{{ getServerResources(server).length }}</span>
                  </div>
                  <div 
                    v-if="getServerPrompts(server).length > 0" 
                    class="content-icon prompts-icon" 
                    :title="`提示词列表 (${getServerPrompts(server).length}个)`"
                    @mouseenter="showContentTooltip(server, 'prompts', $event)"
                    @mouseleave="delayedHideContentTooltip"
                    @mousemove="showContentTooltip(server, 'prompts', $event)"
                  >
                    <span class="icon-emoji">✨</span>
                    <span class="icon-count">{{ getServerPrompts(server).length }}</span>
                  </div>
                </div>
              </div>
            </div>
            <div class="server-actions">
              <!-- 滑动开关组件（契约 settings-switch） -->
              <label
                class="settings-switch"
                :class="{ 'switch-disabled': isServerConnecting(server) || isServerDisconnecting(server) }"
              >
                <input
                  type="checkbox"
                  :checked="isServerConnected(server)"
                  :disabled="isServerConnecting(server) || isServerDisconnecting(server)"
                  @change="handleToggleChange(server, $event)"
                />
                <span class="settings-switch-slider"></span>
              </label>
              <button @click="editServer(server)" class="settings-btn settings-btn-primary">
                编辑
              </button>
              <button @click="showDeleteConfirmModal(server)" class="settings-btn settings-btn-danger">
                删除
              </button>
            </div>

            <!-- 删除确认对话框 -->
            <div v-if="showDeleteConfirm" class="modal-overlay" @click="cancelRemoveServer">
              <div class="modal-content" @click.stop>
                <div class="modal-header">
                  <h3>确认删除</h3>
                </div>
                <div class="modal-body">
                  <p>确定要删除服务器 "<strong>{{ serverToDelete?.name }}</strong>" 吗？</p>
                </div>
                <div class="modal-actions">
                  <button @click="cancelRemoveServer" class="settings-btn">
                    取消
                  </button>
                  <button @click="confirmRemoveServer(serverToDelete!)" class="settings-btn settings-btn-danger">
                    确认删除
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- 添加服务器按钮区域（仅在有服务器时显示） -->
          <div class="add-server-section">
            <button @click="startConfiguration" class="settings-btn settings-btn-primary">+ 添加</button>
          </div>
        </div>
      </div>

      <!-- 配置输入视图 -->
      <div v-else class="config-input-view">
        <div class="config-header">
          <button @click="cancelConfiguration" class="settings-btn">
            ← 返回服务器列表
          </button>
        </div>

        <!-- 配置输入区域 -->
        <div class="config-input-section">
          <div class="input-group">
            <label for="config-json" class="settings-label">配置JSON:</label>
            <textarea
              id="config-json"
              v-model="configJson"
              placeholder="请输入MCP服务器配置JSON..."
              rows="10"
              class="settings-input config-textarea"
            ></textarea>
          </div>

          <div class="button-group">
            <button @click="validateAndSave" class="settings-btn settings-btn-primary">
              保存
            </button>
            <button @click="clearConfig" class="settings-btn">
              清空
            </button>
          </div>
        </div>

        <!-- 验证结果区域 -->
        <div
          v-if="validationMessage"
          class="settings-notice"
          :class="validationType === 'success' ? 'settings-notice-success' : validationType === 'error' ? 'settings-notice-error' : 'settings-notice-info'"
        >
          {{ validationMessage }}
        </div>
      </div>

      <!-- 悬浮提示组件 -->
      <div 
        v-if="showTooltip && tooltipContent" 
        class="content-tooltip"
        :style="{ 
          left: tooltipPosition.x + 'px', 
          top: tooltipPosition.y + 'px' 
        }"
        @mouseenter="clearDelayedHide"
        @mouseleave="delayedHideContentTooltip"
      >
        <div class="tooltip-header">{{ tooltipContent.title }}</div>
        <div class="tooltip-items">
          <div 
            v-for="(item, index) in tooltipContent.items" 
            :key="index"
            class="tooltip-item"
            :class="{ 
              'more-item': item.type === 'expand-button',
              'collapse-item': item.type === 'collapse-button'
            }"
            :style="{ cursor: item.type === 'expand-button' || item.type === 'collapse-button' ? 'pointer' : 'default' }"
            @mouseenter="item.type === 'expand-button' || item.type === 'collapse-button' ? null : showItemDetail(item, $event)"
            @mouseleave="item.type === 'expand-button' || item.type === 'collapse-button' ? null : hideItemDetail"
            @click="item.type === 'expand-button' ? expandTooltipItems(item.serverName, item.contentType) : 
                    item.type === 'collapse-button' ? collapseTooltipItems(item.serverName, item.contentType) : null"
          >
            <span v-if="item.type === 'expand-button' || item.type === 'collapse-button'" class="expand-button-text">
              {{ item.text }}
            </span>
            <span v-else>
              {{ item.name }}
            </span>
            
            <!-- 二级悬浮框：项目详情 -->
            <div 
              v-if="detailTooltip.visible && detailTooltip.item === item && typeof item !== 'string'"
              class="item-detail-tooltip"
              :style="{ 
                left: detailTooltipPosition.x + 'px', 
                top: detailTooltipPosition.y + 'px' 
              }"
            >
              <div class="detail-header">{{ item.name }}</div>
              <div v-if="item.description" class="detail-description">
                {{ item.description }}
              </div>
              <div v-if="item.schema" class="detail-schema">
                <pre>{{ JSON.stringify(item.schema, null, 2) }}</pre>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onActivated, onDeactivated } from 'vue'
import { ConfigService, MCPService, MCPConfigPersistence } from '@assistant-ai/core'
import { ElectronMCPClient, IPCKeyValueStore, ElectronSecureStorage } from '@assistant-ai/ui/adapters'
import { eventBus, EVENTS } from '@assistant-ai/core'
import type { MCPServerConfig } from '@assistant-ai/core'
import { getMCPFilePersistence } from '../../main'

// 类型声明，使用已有的全局接口定义
declare const window: Window & {
  electronAPI: any
}

// 服务实例
const configService = new ConfigService()
const persistence = getMCPFilePersistence() || new MCPConfigPersistence(new IPCKeyValueStore(), new ElectronSecureStorage())

// 响应式数据
const configJson = ref('')
const validationMessage = ref('')
const validationType = ref<'success' | 'error' | ''>('')
const configuredServers = ref<MCPServerConfig[]>([])
// 移除了全局的 isConnecting 和 isDisconnecting，使用服务器级别的状态管理
const isConfiguring = ref(false) // 控制配置界面显示状态
const editingServer = ref<MCPServerConfig | null>(null) // 当前正在编辑的服务器配置

// 连接状态映射，存储每个服务器的唯一连接ID和状态
const serverConnections = ref<Map<string, {
  connectionId: string
  connected: boolean
  lastError?: string
  lastConnected?: number
  transportType?: string
  isConnecting?: boolean  // 新增：每个服务器独立的连接状态
  isDisconnecting?: boolean  // 新增：每个服务器独立的断开状态
  tools?: any[]           // 新增：工具列表
  resources?: any[]       // 新增：资源列表
  prompts?: any[]         // 新增：提示词列表
}>>(new Map())

// 删除确认相关状态
const showDeleteConfirm = ref(false)
const serverToDelete = ref<MCPServerConfig | null>(null)

// 悬浮提示相关状态
const showTooltip = ref(false)
const tooltipContent = ref<{ 
  type: 'tools' | 'resources' | 'prompts', 
  items: (any | string)[], 
  title: string 
} | null>(null)

// 生成稳定的连接ID，基于服务器名称
const getStableConnectionId = (serverName: string): string => {
  const cleanedName = serverName
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
  return `mcp-${cleanedName}`
}

const tooltipPosition = ref({ x: 0, y: 0 })

// 延迟隐藏相关状态
const hideDelayTimer = ref<NodeJS.Timeout | null>(null) // 添加延迟隐藏定时器

// 悬浮框展开状态管理
const expandedTooltips = ref<Map<string, boolean>>(new Map())

// 二级悬浮框状态管理
const detailTooltip = ref({
  visible: false,
  item: null as any,
  showTimer: null as number | null, // 添加显示定时器用于防抖
  hideTimer: null as number | null, // 添加隐藏定时器用于防抖
  isAnimating: false // 新增：动画状态标识
})

const detailTooltipPosition = ref({ 
  x: 100, // 默认x坐标，避免左上角(0,0)位置
  y: 100  // 默认y坐标，避免左上角(0,0)位置
})

// 刷新按钮状态管理
const isRefreshing = ref(false)
const refreshResult = ref<{
  show: boolean
  message: string
  type: 'success' | 'error' | 'info'
  timestamp: number
}>({
  show: false,
  message: '',
  type: 'info',
  timestamp: 0
})

// 显示悬浮提示
const showContentTooltip = (server: MCPServerConfig, type: 'tools' | 'resources' | 'prompts', event: MouseEvent) => {
  const items = type === 'tools' ? getServerTools(server) : 
                type === 'resources' ? getServerResources(server) : 
                getServerPrompts(server)
  
  if (items.length === 0) return
  
  // 清除延迟隐藏定时器
  if (hideDelayTimer.value) {
    clearTimeout(hideDelayTimer.value)
    hideDelayTimer.value = null
  }
  
  // 检查是否已展开
  const tooltipKey = `${server.name}-${type}`
  const isExpanded = expandedTooltips.value.get(tooltipKey) || false
  
  const titles = {
    tools: '工具列表',
    resources: '资源列表', 
    prompts: '提示词列表'
  }
  
  let displayItems: any[]
  
  if (isExpanded) {
    // 已展开状态，显示所有项目
    displayItems = [...items, {
      type: 'collapse-button',
      text: '收起',
      serverName: server.name,
      contentType: type
    }]
  } else {
    // 未展开状态，显示前5个 + 展开按钮
    displayItems = items.slice(0, 5)
    if (items.length > 5) {
      displayItems.push({
        type: 'expand-button',
        text: `等${items.length - 5}个更多...`,
        serverName: server.name,
        contentType: type,
        remainingCount: items.length - 5
      })
    }
  }
  
  tooltipContent.value = {
    type,
    items: displayItems,
    title: titles[type]
  }
  
  tooltipPosition.value = {
    x: event.clientX,
    y: event.clientY
  }
  
  showTooltip.value = true
}

// 隐藏悬浮提示
const hideContentTooltip = () => {
  // 清除延迟隐藏定时器
  if (hideDelayTimer.value) {
    clearTimeout(hideDelayTimer.value)
    hideDelayTimer.value = null
  }
  
  // 立即隐藏主悬浮框和二级悬浮框
  showTooltip.value = false
  tooltipContent.value = null
  hideItemDetail()
}

// 延迟隐藏悬浮提示（用于从图标移动到悬浮框的过渡）
const delayedHideContentTooltip = () => {
  // 设置200ms延迟隐藏
  hideDelayTimer.value = window.setTimeout(() => {
    hideContentTooltip()
  }, 200) as unknown as NodeJS.Timeout
}

// 清除延迟隐藏定时器
const clearDelayedHide = () => {
  if (hideDelayTimer.value) {
    clearTimeout(hideDelayTimer.value)
    hideDelayTimer.value = null
  }
}

// 专门用于更新悬浮框内容而不改变位置的函数
const updateTooltipContent = (server: MCPServerConfig, type: 'tools' | 'resources' | 'prompts') => {
  const items = type === 'tools' ? getServerTools(server) : 
                type === 'resources' ? getServerResources(server) : 
                getServerPrompts(server)
  
  if (items.length === 0) return
  
  // 检查是否已展开
  const tooltipKey = `${server.name}-${type}`
  const isExpanded = expandedTooltips.value.get(tooltipKey) || false
  
  const titles = {
    tools: '工具列表',
    resources: '资源列表', 
    prompts: '提示词列表'
  }
  
  let displayItems: any[]
  
  if (isExpanded) {
    // 已展开状态，显示所有项目
    displayItems = [...items, {
      type: 'collapse-button',
      text: '收起',
      serverName: server.name,
      contentType: type
    }]
  } else {
    // 未展开状态，显示前5个 + 展开按钮
    displayItems = items.slice(0, 5)
    if (items.length > 5) {
      displayItems.push({
        type: 'expand-button',
        text: `等${items.length - 5}个更多...`,
        serverName: server.name,
        contentType: type,
        remainingCount: items.length - 5
      })
    }
  }
  
  // 只更新内容，保持位置不变
  tooltipContent.value = {
    type,
    items: displayItems,
    title: titles[type]
  }
  
  // 确保悬浮框仍然可见
  showTooltip.value = true
}

// 展开悬浮框项目列表
const expandTooltipItems = (serverName: string, contentType: 'tools' | 'resources' | 'prompts') => {
  const tooltipKey = `${serverName}-${contentType}`
  expandedTooltips.value.set(tooltipKey, true)
  
  // 更新内容但不改变位置
  const server = configuredServers.value.find(s => s.name === serverName)
  if (server) {
    updateTooltipContent(server, contentType)
  }
}

// 收起悬浮框项目列表
const collapseTooltipItems = (serverName: string, contentType: 'tools' | 'resources' | 'prompts') => {
  const tooltipKey = `${serverName}-${contentType}`
  expandedTooltips.value.set(tooltipKey, false)
  
  // 更新内容但不改变位置
  const server = configuredServers.value.find(s => s.name === serverName)
  if (server) {
    updateTooltipContent(server, contentType)
  }
}



// 计算二级悬浮框位置
const calculateDetailTooltipPosition = (elementRect: DOMRect) => {
  const screenWidth = window.innerWidth
  const screenHeight = window.innerHeight
  const tooltipWidth = 350 // 二级悬浮框预估宽度
  const tooltipHeight = 250 // 二级悬浮框预估高度
  
  // 🔧 基于元素位置的智能定位算法
  let x, y
  
  // 首选位置：元素的右上方
  if (elementRect.right + tooltipWidth + 20 <= screenWidth) {
    x = elementRect.right + 10
    y = Math.max(10, elementRect.top - 5)
  }
  // 备选位置：元素的左上方
  else if (elementRect.left - tooltipWidth - 20 >= 0) {
    x = elementRect.left - tooltipWidth - 10
    y = Math.max(10, elementRect.top - 5)
  }
  // 备选位置：元素的右下方
  else if (elementRect.right + tooltipWidth + 20 <= screenWidth) {
    x = elementRect.right + 10
    y = Math.min(screenHeight - tooltipHeight - 10, elementRect.bottom + 5)
  }
  // 备选位置：元素的左下方
  else {
    x = elementRect.left - tooltipWidth - 10
    y = Math.min(screenHeight - tooltipHeight - 10, elementRect.bottom + 5)
  }
  
  // 边界检查和安全调整
  x = Math.max(10, Math.min(x, screenWidth - tooltipWidth - 10))
  y = Math.max(10, Math.min(y, screenHeight - tooltipHeight - 10))
  
  return { x, y }
}

// 项目悬停显示详情
const showItemDetail = (item: any, event: MouseEvent) => {
  // 展开/收起按钮不显示详情
  if (item.type === 'expand-button' || item.type === 'collapse-button') return
  
  // 清除之前的隐藏定时器
  if (detailTooltip.value.hideTimer) {
    clearTimeout(detailTooltip.value.hideTimer)
    detailTooltip.value.hideTimer = null
  }
  
  // 清除动画状态
  if (detailTooltip.value.isAnimating) {
    detailTooltip.value.isAnimating = false
  }
  
  // 设置显示定时器，防止频繁切换
  if (detailTooltip.value.showTimer) {
    clearTimeout(detailTooltip.value.showTimer)
  }
  
  detailTooltip.value.showTimer = window.setTimeout(() => {
    detailTooltip.value = {
      ...detailTooltip.value,
      visible: true,
      item,
      showTimer: null
    }
    
    // 🔧 修复：安全获取触发项目的实际位置信息
    const targetElement = event.currentTarget as HTMLElement
    let elementRect: DOMRect
    
    // 检查事件目标是否存在，如果不存在则使用鼠标位置作为备选
    if (targetElement && targetElement.getBoundingClientRect) {
      elementRect = targetElement.getBoundingClientRect()
    } else {
      // 🔧 改进的备选方案：使用鼠标位置创建虚拟的矩形区域
      const mouseX = event.clientX
      const mouseY = event.clientY
      
      // 创建真正的 DOMRect 实例
      elementRect = new DOMRect(
        mouseX - 50, // left
        mouseY - 20, // top  
        100,         // width
        30           // height
      )
    }
    
    // 计算并设置位置，基于元素位置而非鼠标位置
    const position = calculateDetailTooltipPosition(elementRect)
    
    // 如果有长文本描述，动态调整位置
    if (item.description && item.description.length > 100) {
      // 长文本描述，调整位置以确保可见性
      const screenHeight = window.innerHeight
      if (position.y > screenHeight * 0.6) {
        // 如果位置太靠下，尝试向上调整
        position.y = Math.max(10, elementRect.top - 150)
      }
    }
    
    detailTooltipPosition.value = position
  }, 100) as unknown as number // 100ms防抖延迟
}

// 隐藏项目详情
const hideItemDetail = () => {
  // 清除之前的显示定时器
  if (detailTooltip.value.showTimer) {
    clearTimeout(detailTooltip.value.showTimer)
    detailTooltip.value.showTimer = null
  }
  
  // 如果已经在动画中，直接返回
  if (detailTooltip.value.isAnimating) {
    return
  }
  
  // 设置动画状态
  detailTooltip.value.isAnimating = true
  
  // 设置隐藏定时器，防止快速切换时闪烁
  detailTooltip.value.hideTimer = window.setTimeout(() => {
    // 先添加隐藏动画类
    const tooltipElement = document.querySelector('.item-detail-tooltip') as HTMLElement
    if (tooltipElement) {
      tooltipElement.classList.add('hide')
      
      // 动画结束后移除元素
      setTimeout(() => {
        detailTooltip.value = {
          ...detailTooltip.value,
          visible: false,
          item: null,
          hideTimer: null,
          isAnimating: false
        }
        
        // 移除隐藏动画类
        if (tooltipElement) {
          tooltipElement.classList.remove('hide')
        }
      }, 150) // 150ms对应CSS动画时长
    } else {
      // 如果元素不存在，直接隐藏
      detailTooltip.value = {
        ...detailTooltip.value,
        visible: false,
        item: null,
        hideTimer: null,
        isAnimating: false
      }
    }
  }, 100) as unknown as number // 100ms延迟隐藏，避免闪烁
}

// 滑动开关切换处理
const handleToggleChange = async (server: MCPServerConfig, event: Event) => {
  const target = event.target as HTMLInputElement
  const isChecked = target.checked
  
  if (isChecked) {
    // 开启连接
    await connectServer(server)
  } else {
    // 断开连接
    await disconnectServer(server)
  }
}

// 编辑服务器配置
const editServer = (server: MCPServerConfig) => {
  // 优先使用原始JSON，否则回退到序列化配置
  configJson.value = server.originalJson || JSON.stringify(server, null, 2)
  
  // 设置当前正在编辑的服务器
  editingServer.value = server
  
  // 切换到配置界面模式
  isConfiguring.value = true
  
  // 清空之前的验证消息
  clearValidation()
}

// 开始配置
const startConfiguration = () => {
  isConfiguring.value = true
  editingServer.value = null // 清除编辑状态，表示新建模式
  clearConfig()
}

// 取消配置
const cancelConfiguration = () => {
  isConfiguring.value = false
  editingServer.value = null // 清除编辑状态
  clearConfig()
}


// 验证并保存配置
const validateAndSave = async () => {
  clearValidation()
  
  try {
    const config = configService.parseConfig(configJson.value)
    const validation = configService.validateExtendedConfig(config)
    
    if (!validation.valid) {
      showValidationError(validation.error || '配置验证失败')
      return
    }
    
    // 将检测到的传输类型保存到配置对象中
    config.transportType = validation.transportType
    
    // 保存用户的原始JSON输入
    config.originalJson = configJson.value
    
    // 检查是否已存在同名服务器
    const serverName = config.name || 'unnamed-server'
    const existingIndex = configuredServers.value.findIndex(s => s.name === config.name)
    
    if (existingIndex >= 0) {
      configuredServers.value[existingIndex] = config
      showValidationSuccess(`服务器 "${config.name}" 配置已更新 - 检测到传输类型: ${validation.transportType}`)
    } else {
      configuredServers.value.push(config)
      showValidationSuccess(`服务器 "${config.name}" 配置已添加 - 检测到传输类型: ${validation.transportType}`)
    }
    
    // 立即更新连接状态以显示传输类型（不需要实际连接）
    serverConnections.value.set(serverName, {
      connectionId: '',
      connected: false,
      transportType: validation.transportType
    })
    
    // 自动保存状态
    await saveServersToPersistence()

    // 清理提示词缓存，确保下次获取时重新聚合
    new MCPService().clearAggregatedPromptsCache()
    
    // 通知其他组件prompt列表已发生变化
    eventBus.emit(EVENTS.MCP_PROMPTS_CHANGED)
    
    // 配置成功后返回服务器列表视图
    setTimeout(() => {
      cancelConfiguration()
    }, 2000)
    
  } catch (error) {
    showValidationError(error instanceof Error ? (error.message || '未知错误') : '未知错误')
  }
}

// 清空配置
const clearConfig = () => {
  configJson.value = ''
  clearValidation()
}

// 清除验证消息
const clearValidation = () => {
  validationMessage.value = ''
  validationType.value = ''
}

// 显示验证成功消息
const showValidationSuccess = (message: string) => {
  validationMessage.value = message
  validationType.value = 'success'
  setTimeout(clearValidation, 3000)
}

// 显示验证错误消息
const showValidationError = (message: string) => {
  validationMessage.value = message
  validationType.value = 'error'
  setTimeout(clearValidation, 5000)
}

// 处理主进程发送的状态更新
const updateServerStatusFromMainProcess = async (statusData: {
  connectionId: string
  status: 'connecting' | 'connected' | 'disconnected'
  serverName?: string
  timestamp: number
}) => {
  const { connectionId, status, serverName } = statusData
  
  // 直接使用事件中的serverName
  if (serverName) {
    // 获取当前服务器连接信息
    const existingStatus = serverConnections.value.get(serverName) || {
      connectionId: '',
      connected: false,
      isConnecting: false,
      isDisconnecting: false
    }
    
    // 根据状态更新连接信息
    const updatedStatus = {
      ...existingStatus,
      connectionId,
      connected: status === 'connected',
      isConnecting: status === 'connecting',
      isDisconnecting: status === 'disconnected',
      lastError: status === 'disconnected' ? '连接已断开' : undefined,
      lastConnected: status === 'connected' ? Date.now() : existingStatus.lastConnected
    }
    
    serverConnections.value.set(serverName, updatedStatus)
    
    // 自动保存状态
    await saveServersToPersistence()
    
    // 如果服务器断开连接，清理提示词缓存并通知其他组件
    if (status === 'disconnected') {
      new MCPService().clearAggregatedPromptsCache()
      eventBus.emit(EVENTS.MCP_PROMPTS_CHANGED)
      eventBus.emit(EVENTS.MCP_CONNECTION_CHANGED)
    }
    
    // 如果服务器连接成功，通知其他组件
    if (status === 'connected') {
      eventBus.emit(EVENTS.MCP_CONNECTION_CHANGED)
    }
  }
}

// 连接服务器
const connectServer = async (server: MCPServerConfig) => {
  // 确保服务器有名称
  const serverName = server.name || 'unnamed-server'
  
  // 获取当前服务器连接信息，如果不存在则初始化
  let connectionInfo = serverConnections.value.get(serverName)
  if (!connectionInfo) {
    connectionInfo = {
      connectionId: '',
      connected: false,
      isConnecting: false,
      isDisconnecting: false
    }
    serverConnections.value.set(serverName, connectionInfo)
  }
  
  // 检查该服务器是否正在连接，避免重复操作
  if (connectionInfo.isConnecting) return
  
  // 设置当前服务器为连接中状态
  connectionInfo.isConnecting = true
  
  try {
    // 将Vue响应式对象转换为普通JavaScript对象，解决IPC序列化问题
    const serverConfig = JSON.parse(JSON.stringify(server))
    
    // 使用稳定连接ID
    const connectionId = getStableConnectionId(serverName)
    
    // 使用ElectronMCPClient适配器进行连接（使用支持连接ID的方法）
    const electronClient = new ElectronMCPClient()
    const connectResult = await electronClient.connectWithId(serverConfig, connectionId)
    
    if (!connectResult.success) {
        // 如果连接已存在（已由 autoReconnect 连接），视为已连接状态
        if (connectResult.error?.includes('已存在')) {
          serverConnections.value.set(serverName, {
            ...connectionInfo,
            connectionId,
            connected: true,
            isConnecting: false,
            lastError: undefined,
            lastConnected: Date.now()
          })
          await saveServersToPersistence()
          return
        }

        // 更新连接状态为失败
        serverConnections.value.set(serverName, {
          ...connectionInfo,
          connectionId,
          connected: false,
          isConnecting: false,
          lastError: connectResult.error || '连接失败'
        })
        
        // 自动保存状态
          await saveServersToPersistence()
          
          return
    }
    
    // 成功连接，更新状态
    serverConnections.value.set(serverName, {
      ...connectionInfo,
      connectionId,
      connected: true,
      isConnecting: false,
      lastConnected: Date.now(),
      transportType: connectResult.transportType
    })
    
    // 自动保存状态
    await saveServersToPersistence()
    
    // 获取工具列表、资源列表和提示词列表并保存到状态
    try {
      // 并行获取工具、资源和提示词列表
      const [toolsResult, resourcesResult, promptsResult] = await Promise.allSettled([
        electronClient.listTools(connectionId),
        electronClient.listResources(connectionId),
        electronClient.listPrompts(connectionId)
      ])

      // 提取成功的结果，确保类型安全
      const tools = toolsResult.status === 'fulfilled' && toolsResult.value.success ? (toolsResult.value.tools || []) : []
      const resources = resourcesResult.status === 'fulfilled' && resourcesResult.value.success ? (resourcesResult.value.resources || []) : []
      const prompts = promptsResult.status === 'fulfilled' && promptsResult.value.success ? (promptsResult.value.prompts || []) : []

      // 更新连接状态并保存所有列表
      serverConnections.value.set(serverName, {
        ...connectionInfo,
        connectionId,
        connected: true,
        isConnecting: false,
        tools,
        resources,
        prompts
      })
      
      // 自动保存状态
      await saveServersToPersistence()

      // 清理提示词缓存，确保下次获取时重新聚合
      new MCPService().clearAggregatedPromptsCache()
      
      // 通知其他组件prompt列表已发生变化
      eventBus.emit(EVENTS.MCP_PROMPTS_CHANGED)

    } catch (error) {
      console.warn(`获取服务器信息失败，但连接已建立:`, error)
      // 更新连接状态，即使部分信息获取失败
      serverConnections.value.set(serverName, {
        ...connectionInfo,
        connectionId,
        connected: true,
        isConnecting: false,
        tools: [],
        resources: [],
        prompts: []
      })
    }
    
  } catch (error) {
    // 更新连接状态为失败
    serverConnections.value.set(serverName, {
      ...connectionInfo,
      connectionId: '',
      connected: false,
      isConnecting: false,
      lastError: error instanceof Error ? (error.message || '连接异常') : '连接异常'
    })
    
    // 自动保存状态
    await saveServersToPersistence()
    
    console.error('MCP服务器连接异常:', error)
  }
}

// 断开服务器连接
const disconnectServer = async (server: MCPServerConfig) => {
  // 确保服务器有名称
  const serverName = server.name || 'unnamed-server'
  
  // 获取当前服务器连接信息，如果不存在则初始化
  let connectionInfo = serverConnections.value.get(serverName)
  if (!connectionInfo) {
    connectionInfo = {
      connectionId: '',
      connected: false,
      isConnecting: false,
      isDisconnecting: false
    }
    serverConnections.value.set(serverName, connectionInfo)
  }
  
  // 检查该服务器是否正在断开，避免重复操作
  if (connectionInfo.isDisconnecting) return
  
  // 设置当前服务器为断开中状态
  connectionInfo.isDisconnecting = true
  
  try {
    // 使用ElectronMCPClient适配器断开连接
    const electronClient = new ElectronMCPClient()
    
    let disconnectSuccess = false
    let errorMessage = ''
    
    // 使用稳定ID进行断开操作
    const stableConnectionId = getStableConnectionId(serverName)
    
    // 清理所有相关连接（旧的连接ID和当前稳定ID）
    const connectionIdsToCleanup = [connectionInfo.connectionId, stableConnectionId].filter(Boolean)
    
    for (const connectionId of connectionIdsToCleanup) {
      try {
        const disconnectResult = await electronClient.disconnectWithId(connectionId)
        
        if (disconnectResult.success) {
          disconnectSuccess = true
        } else {
          errorMessage = disconnectResult.error || '断开连接失败'
          console.warn('断开连接失败:', connectionId, errorMessage)
          
          // 检查是否是"连接不存在"错误，如果是则跳过
          if (errorMessage.includes('不存在') || errorMessage.includes('not found')) {
            disconnectSuccess = true
          }
        }
      } catch (error) {
        console.warn('断开连接异常:', connectionId, error)
        errorMessage = error instanceof Error ? error.message : '断开连接异常'
      }
      
      // 如果至少有一个连接断开成功，就认为断开操作成功
      if (disconnectSuccess) break
    }
    
    // 如果连接ID断开失败，记录错误信息
    if (!disconnectSuccess) {
      console.warn('所有断开方法都失败了，连接可能处于不一致状态')
      // 不再提供回退方案，统一使用 disconnectWithId
    }
    
    // 无论哪种断开方法，只要没有明确的错误，都认为断开成功
    if (!errorMessage || errorMessage.includes('不存在') || errorMessage.includes('not found')) {
      disconnectSuccess = true
    }
    
    // 更新状态为断开
    serverConnections.value.set(serverName, {
      ...connectionInfo,
      connectionId: '', // 清除连接ID
      connected: false,
      isDisconnecting: false,
      lastError: errorMessage || undefined,
      tools: [], // 清除缓存的工具列表
      resources: [], // 清除缓存的资源列表
      prompts: [] // 清除缓存的提示词列表
    })
    
    // 自动保存状态
    await saveServersToPersistence()
    
    // 清理提示词缓存，确保下次获取时重新聚合
    new MCPService().clearAggregatedPromptsCache()
    
    // 通知其他组件prompt列表已发生变化
    eventBus.emit(EVENTS.MCP_PROMPTS_CHANGED)
    
    // 通知其他组件连接状态已发生变化
    eventBus.emit(EVENTS.MCP_CONNECTION_CHANGED)
    
  } catch (error) {
    // 更新连接状态为断开（即使异常也认为已断开）
    serverConnections.value.set(serverName, {
      ...connectionInfo,
      connectionId: connectionInfo.connectionId || '',
      connected: false,
      isDisconnecting: false,
      lastError: error instanceof Error ? (error.message || '断开连接异常') : '断开连接异常'
    })
    
    // 自动保存状态
    await saveServersToPersistence()
    
    // 通知其他组件连接状态已发生变化（即使异常也认为已断开）
    eventBus.emit(EVENTS.MCP_CONNECTION_CHANGED)
    
    console.error('MCP服务器断开连接异常:', error)
  }
}

// 删除服务器配置
const removeServer = async (server: MCPServerConfig) => {
  // 先检查是否已连接，如果已连接则先断开
  const serverName = server.name || 'unnamed-server'
  const connectionInfo = serverConnections.value.get(serverName)
  
  if (connectionInfo?.connected) {
    try {
      const electronClient = new ElectronMCPClient()
      // 统一使用 disconnectWithId，假设连接都有对应的connectionId
      if (connectionInfo.connectionId) {
        await electronClient.disconnectWithId(connectionInfo.connectionId)
      } else {
        console.warn(`删除服务器 "${serverName}" 时缺少connectionId，无法精确断开连接`)
        // 在这种情况下，可以尝试使用服务器名称作为连接标识符
        await electronClient.disconnectWithId(serverName)
      }
    } catch (error) {
      console.warn(`删除服务器 "${serverName}" 前断开连接失败:`, error)
    }
  }
  
  // 从本地状态移除连接记录
  serverConnections.value.delete(serverName)
  
  // 从服务器列表移除
  const index = configuredServers.value.findIndex(s => s.name && serverName && s.name === serverName)
  if (index >= 0) {
    configuredServers.value.splice(index, 1)
    await saveServersToPersistence()
    showValidationSuccess(`服务器 "${serverName}" 已删除`)
  }
}

// 确认删除服务器
const confirmRemoveServer = async (server: MCPServerConfig) => {
  await removeServer(server)
  showDeleteConfirm.value = false
  serverToDelete.value = null
}

// 取消删除
const cancelRemoveServer = () => {
  showDeleteConfirm.value = false
  serverToDelete.value = null
}

// 显示删除确认对话框
const showDeleteConfirmModal = (server: MCPServerConfig) => {
  serverToDelete.value = server
  showDeleteConfirm.value = true
}

// 获取服务器状态样式类
const getServerStatusClass = (server: MCPServerConfig) => {
  const serverName = server.name || 'unnamed-server'
  const status = serverConnections.value.get(serverName)
  if (!status) {
    return 'status-disconnected'
  }
  return status.connected ? 'status-connected' : 'status-disconnected'
}

// 获取服务器状态文本
const getServerStatusText = (server: MCPServerConfig) => {
  const serverName = server.name || 'unnamed-server'
  const status = serverConnections.value.get(serverName)
  if (!status) {
    return '未连接'
  }
  
  // 优先检查连接中状态
  if (status.isConnecting) {
    return '连接中'
  }
  
  if (status.connected) {
    return '已连接'
  } else {
    return status.lastError ? `连接失败: ${status.lastError}` : '未连接'
  }
}

// 检查服务器是否已连接
const isServerConnected = (server: MCPServerConfig) => {
  const serverName = server.name || 'unnamed-server'
  const status = serverConnections.value.get(serverName)
  return status?.connected || false
}

// 检查服务器是否正在连接
const isServerConnecting = (server: MCPServerConfig) => {
  const serverName = server.name || 'unnamed-server'
  const status = serverConnections.value.get(serverName)
  return status?.isConnecting || false
}

// 检查服务器是否正在断开
const isServerDisconnecting = (server: MCPServerConfig) => {
  const serverName = server.name || 'unnamed-server'
  const status = serverConnections.value.get(serverName)
  return status?.isDisconnecting || false
}

// 获取服务器传输类型
const getServerTransportType = (server: MCPServerConfig) => {
  const serverName = server.name || 'unnamed-server'
  const status = serverConnections.value.get(serverName)
  
  // 如果服务器有配置传输类型信息，无论是否已连接都显示
  if (status?.transportType && status.transportType !== 'unknown') {
    return status.transportType
  }
  
  // 回退到配置的传输类型（如果状态中没有信息）
  if (server.transportType && server.transportType !== 'auto') {
    return server.transportType
  }
  
  // 没有传输类型信息时不显示任何内容
  return null
}

// 获取服务器工具列表
const getServerTools = (server: MCPServerConfig) => {
  const serverName = server.name || 'unnamed-server'
  const status = serverConnections.value.get(serverName)
  return status?.tools || []
}

// 获取服务器资源列表
const getServerResources = (server: MCPServerConfig) => {
  const serverName = server.name || 'unnamed-server'
  const status = serverConnections.value.get(serverName)
  return status?.resources || []
}

// 获取服务器提示词列表
const getServerPrompts = (server: MCPServerConfig) => {
  const serverName = server.name || 'unnamed-server'
  const status = serverConnections.value.get(serverName)
  return status?.prompts || []
}

// 刷新所有连接状态
const refreshAllConnections = async () => {
  if (isRefreshing.value) return // 防止重复点击
  
  isRefreshing.value = true
  refreshResult.value = {
    show: false,
    message: '',
    type: 'info',
    timestamp: 0
  }
  
  try {
    let connectedCount = 0
    let totalCount = 0
    
    // 使用ElectronMCPClient获取所有连接列表
    const electronClient = new ElectronMCPClient()
    const connectionsResult = await electronClient.listConnections()
    
    if (connectionsResult.success && connectionsResult.connections) {
      // 更新本地状态映射
      const freshConnections = new Map<string, {
        connectionId: string
        connected: boolean
        lastError?: string
        lastConnected?: number
        transportType?: string
      }>()
      
      // 使用Set记录已处理的稳定ID，避免重复统计
      const processedConnections = new Set<string>()
      
      for (const connection of connectionsResult.connections) {
        // 这里需要根据实际返回的连接数据结构来调整
        const connectionId = connection.id || connection.connectionId || ''
        const transportType = connection.transportType || 'unknown'
        const isConnected = connection.status === 'connected'
        
        // 从connectionId推断服务器名称
        let serverName = connection.serverName || connection.name || 'unknown'
        if (serverName === 'unknown' && connectionId && connectionId.startsWith('mcp-')) {
          // 从稳定ID推断服务器名称
          const cleanName = connectionId.replace(/^mcp-/, '').replace(/-/g, ' ').replace(/\b\w/g, (l: string) => l.toUpperCase())
          serverName = cleanName
        }
        
        // 使用稳定ID作为键值，避免重复统计
        const stableConnectionId = getStableConnectionId(serverName)
        if (!processedConnections.has(stableConnectionId)) {
          processedConnections.add(stableConnectionId)
          
          freshConnections.set(serverName, {
            connectionId,
            connected: isConnected,
            transportType
          })
          
          if (isConnected) {
            connectedCount++
          }
          totalCount++
        }
      }
      
      // 合并到现有状态，保留错误信息和连接时间
      for (const [serverName, newInfo] of freshConnections) {
        const existingInfo = serverConnections.value.get(serverName)
        serverConnections.value.set(serverName, {
          ...newInfo,
          lastError: existingInfo?.lastError,
          lastConnected: existingInfo?.lastConnected
        })
      }

      // 对新检测到的已连接服务器，自动拉取工具/资源/提示词
      for (const [serverName, newInfo] of freshConnections) {
        const existingInfo = serverConnections.value.get(serverName)
        if (newInfo.connected && (!existingInfo?.tools || existingInfo.tools.length === 0)) {
          try {
            const [toolsResult, resourcesResult, promptsResult] = await Promise.allSettled([
              electronClient.listTools(newInfo.connectionId),
              electronClient.listResources(newInfo.connectionId),
              electronClient.listPrompts(newInfo.connectionId)
            ])
            const tools = toolsResult.status === 'fulfilled' && toolsResult.value.success ? (toolsResult.value.tools || []) : []
            const resources = resourcesResult.status === 'fulfilled' && resourcesResult.value.success ? (resourcesResult.value.resources || []) : []
            const prompts = promptsResult.status === 'fulfilled' && promptsResult.value.success ? (promptsResult.value.prompts || []) : []
            serverConnections.value.set(serverName, {
              ...serverConnections.value.get(serverName)!,
              tools,
              resources,
              prompts
            })
          } catch { /* 静默失败，用户可手动刷新 */ }
        }
      }
      
      // 生成刷新结果消息（使用最直接的数据源）
      const configuredCount = configuredServers.value.length
      const offlineCount = Math.max(0, configuredCount - connectedCount)
      const message = `已刷新 ${configuredCount} 台服务器，${connectedCount} 台在线，${offlineCount} 台离线`
      
      refreshResult.value = {
        show: true,
        message,
        type: connectedCount > 0 ? 'success' : 'info',
        timestamp: Date.now()
      }
      
    } else {
      // 当没有活跃连接时，清理本地连接状态
      if (connectionsResult.success && (!connectionsResult.connections || connectionsResult.connections.length === 0)) {
        serverConnections.value.clear()
        await saveServersToPersistence()
        
        refreshResult.value = {
          show: true,
          message: '已清除所有连接状态（当前无活跃连接）',
          type: 'info',
          timestamp: Date.now()
        }
      } else {
        refreshResult.value = {
          show: true,
          message: '刷新失败：无法获取服务器连接状态',
          type: 'error',
          timestamp: Date.now()
        }
      }
    }
  } catch (error) {
    console.error('刷新连接状态异常:', error)
    
    refreshResult.value = {
      show: true,
      message: '刷新失败：网络或系统错误',
      type: 'error',
      timestamp: Date.now()
    }
  } finally {
    isRefreshing.value = false
    
    // 3秒后自动隐藏结果消息
    setTimeout(() => {
      if (Date.now() - refreshResult.value.timestamp >= 3000) {
        refreshResult.value.show = false
      }
    }, 3000)
  }
}

// 保存到持久化存储
const saveServersToPersistence = async () => {
  try {
    await persistence.saveServers(configuredServers.value)
    const connectionsObject = Object.fromEntries(serverConnections.value)
    persistence.saveStates(connectionsObject)
  } catch (error) {
    console.warn('保存MCP配置失败:', error)
  }
}

// 从持久化存储加载
const loadServersFromPersistence = async () => {
  try {
    const stored = await persistence.loadServers()
    if (stored.length > 0) {
      configuredServers.value = stored
    }
    const connectionsStored = persistence.loadStates()
    if (Object.keys(connectionsStored).length > 0) {
      serverConnections.value = new Map(Object.entries(connectionsStored as any))
    }
  } catch (error) {
    console.warn('加载MCP配置失败:', error)
  }
}

// 组件挂载时加载保存的配置
onMounted(async () => {
  await loadServersFromPersistence()
  
  // 清理所有历史时间戳ID连接，为稳定ID机制铺路
  await cleanupHistoricalConnections()
  
  // 注意：自动重连逻辑已移至独立服务 mcpAutoReconnectService
  // 程序启动时会自动执行，无需在此重复处理
  
  // 添加MCP状态更新监听
  if (window.electronAPI) {
    window.electronAPI.onMCPStatusUpdate((data: any) => {
      updateServerStatusFromMainProcess(data)
    })
  }

  // 同步主进程中已由 autoReconnect 连接的实际状态
  await refreshAllConnections()
})

// 清理所有历史时间戳ID连接
const cleanupHistoricalConnections = async () => {
  try {
    const electronClient = new ElectronMCPClient()
    const connectionsResult = await electronClient.listConnections()
    
    if (connectionsResult.success && connectionsResult.connections) {
      const historicalConnections = connectionsResult.connections.filter(connection => {
        // 识别时间戳ID格式: servername-timestamp
        const connectionId = connection.id || connection.connectionId || ''
        const timestampPattern = /^[a-zA-Z0-9-]+-\d+$/
        return timestampPattern.test(connectionId) && !connectionId.startsWith('mcp-')
      })
      
      if (historicalConnections.length > 0) {
        for (const connection of historicalConnections) {
          const connectionId = connection.id || connection.connectionId || ''
          try {
            const result = await electronClient.disconnectWithId(connectionId)
            if (!result.success) {
              console.warn('历史连接清理失败:', connectionId, result.error)
            }
          } catch (error) {
            console.warn('清理历史连接异常:', connectionId, error)
          }
        }
      }
    }
  } catch (error) {
    console.warn('清理历史连接时发生错误:', error)
  }
}

// 组件激活时恢复连接状态并同步
onActivated(async () => {
  // 同步真实的连接状态
  await refreshAllConnections()
})

// 组件失活时保存状态
onDeactivated(async () => {
  await saveServersToPersistence()
  
  // 移除MCP状态更新监听
  if (window.electronAPI) {
    window.electronAPI.removeAllListeners('mcp-status-update')
  }
})
</script>

<style scoped>
/* 视觉规格来自契约层 settings.css（settings-page/page-header/group-head/card/badge/btn/input/switch/empty/notice）；
   此处只保留页内结构性布局；滚动由外层 settings-main 独占（组件不再自带容器卡与内滚） */
.mcp-config-content {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

/* 服务器列表视图 */
.server-list-view {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.refresh-button-inline {
  display: flex;
  align-items: center;
}

.refresh-section {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.refresh-btn-inline {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
  padding: 2px;
  border-radius: 3px;
}

.refresh-btn-inline:hover {
  background: var(--background-secondary);
  color: var(--text-primary);
}

.refresh-btn-inline:active {
  background: var(--background-tertiary);
}

.refresh-btn-inline.loading {
  color: var(--primary-color);
  cursor: not-allowed;
}

.refresh-btn-inline.loading:hover {
  background: transparent;
  color: var(--primary-color);
}

.refresh-btn-inline svg {
  display: block;
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
  gap: 0.375rem;
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 500;
  animation: fadeIn 0.2s ease-out;
}

.refresh-result.result-success {
  background: rgba(var(--success-color-rgb), 0.08);
  color: var(--success-color);
  border: 1px solid rgba(var(--success-color-rgb), 0.3);
}

.refresh-result.result-error {
  background: rgba(var(--error-color-rgb), 0.06);
  color: var(--error-color);
  border: 1px solid rgba(var(--error-color-rgb), 0.3);
}

.refresh-result.result-info {
  background: rgba(var(--primary-color-rgb), 0.08);
  color: var(--primary-color);
  border: 1px solid rgba(var(--primary-color-rgb), 0.25);
}

.result-icon {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.result-message {
  white-space: nowrap;
}

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* 配置输入视图 */
.config-input-view {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.config-header {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid var(--border-color);
}

.config-input-section {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.input-group {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

/* 契约 settings-input 之上的本地布局修饰 */
.config-textarea {
  min-height: 200px;
  font-family: var(--font-mono);
}

.button-group {
  display: flex;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.server-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

/* 条目卡片之上的行布局（视觉走契约 settings-card） */
.server-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.75rem;
}

.server-info {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  flex: 1;
}

.server-header {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.server-name {
  font-weight: 600;
  color: var(--text-primary);
  font-size: var(--font-size-base);
}

.server-details {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
}

/* 内容图标容器样式 */
.content-icons {
  display: flex;
  gap: 0.25rem;
  align-items: center;
}

.content-icon {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.25rem 0.5rem;
  border-radius: 16px;
  background: rgba(0, 0, 0, 0.05);
  cursor: pointer;
  transition: all 0.2s ease;
  border: 1px solid transparent;
  font-size: 0.75rem;
  min-height: 1.5rem;
}

.content-icon:hover {
  transform: translateY(-1px);
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  border-color: rgba(0, 0, 0, 0.1);
}

.icon-emoji {
  font-size: 0.875rem;
  line-height: 1;
}

.icon-count {
  font-weight: 500;
  color: var(--text-secondary);
  min-width: 0.5rem;
  text-align: center;
}

/* 不同类型图标的颜色主题 */
.tools-icon {
  background: rgba(59, 130, 246, 0.1);
  border-color: rgba(59, 130, 246, 0.2);
  color: #1d4ed8;
}

.tools-icon:hover {
  background: rgba(59, 130, 246, 0.15);
  border-color: rgba(59, 130, 246, 0.3);
}

.resources-icon {
  background: rgba(16, 185, 129, 0.1);
  border-color: rgba(16, 185, 129, 0.2);
  color: #059669;
}

.resources-icon:hover {
  background: rgba(16, 185, 129, 0.15);
  border-color: rgba(16, 185, 129, 0.3);
}

.prompts-icon {
  background: rgba(245, 158, 11, 0.1);
  border-color: rgba(245, 158, 11, 0.2);
  color: #d97706;
}

.prompts-icon:hover {
  background: rgba(245, 158, 11, 0.15);
  border-color: rgba(245, 158, 11, 0.3);
}

.server-actions {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

/* 连接/断开进行中的开关禁用态（契约 settings-switch 的局部修饰） */
.settings-switch.switch-disabled {
  opacity: 0.5;
  pointer-events: none;
}

/* 模态框样式 */
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  backdrop-filter: blur(2px);
}

.modal-content {
  background: white;
  border-radius: 8px;
  padding: 0;
  box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
  max-width: 400px;
  width: 90%;
  max-height: 90vh;
  overflow: hidden;
  animation: modalShow 0.3s ease-out;
}

@keyframes modalShow {
  from {
    opacity: 0;
    transform: translateY(-20px) scale(0.95);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

.modal-header {
  padding: 1.5rem 1.5rem 1rem;
  border-bottom: 1px solid var(--border-color);
}

.modal-header h3 {
  margin: 0;
  color: var(--text-primary);
  font-size: 1.125rem;
  font-weight: 600;
  text-align: center;
}

.modal-body {
  padding: 1.5rem;
  text-align: center;
}

.modal-body p {
  margin: 0;
  color: var(--text-secondary);
  font-size: 0.875rem;
  line-height: 1.5;
}

.modal-body strong {
  color: var(--text-primary);
  font-weight: 600;
}

.modal-warning {
  color: #dc2626 !important;
  font-size: 0.75rem !important;
  margin-top: 0.75rem !important;
  padding: 0.5rem;
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 4px;
}

.modal-actions {
  padding: 1rem 1.5rem 1.5rem;
  display: flex;
  gap: 0.75rem;
  justify-content: center;
}

/* 悬浮提示样式 */
.content-tooltip {
  position: fixed;
  z-index: 1001;
  background: white;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
  padding: 0;
  max-width: 300px;
  min-width: 200px;
  overflow: hidden;
  animation: tooltipShow 0.2s ease-out;
}

@keyframes tooltipShow {
  from {
    opacity: 0;
    transform: translateY(-4px) scale(0.95);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

.tooltip-header {
  background: #f8fafc;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid #e2e8f0;
  font-size: 0.875rem;
  font-weight: 600;
  color: #1e293b;
}

.tooltip-items {
  padding: 0.5rem 0;
  max-height: 200px;
  overflow-y: auto;
}

.tooltip-item {
  padding: 0.5rem 1rem;
  font-size: 0.875rem;
  color: var(--text-primary);
  border-bottom: 1px solid #f1f5f9;
  transition: background-color 0.15s ease;
  cursor: default;
}

.tooltip-item:last-child {
  border-bottom: none;
}

.tooltip-item:hover:not(.more-item) {
  background: #f8fafc;
}

.tooltip-item.more-item {
  color: var(--text-secondary);
  font-style: italic;
  background: var(--background-secondary);
  cursor: pointer;
}

.tooltip-item.more-item:hover {
  background: var(--background-tertiary);
}

.tooltip-item.collapse-item {
  color: var(--text-secondary);
  font-style: italic;
  background: var(--background-secondary);
  cursor: pointer;
  border-top: 1px solid var(--border-color);
  margin-top: 4px;
  padding-top: 8px;
}

.tooltip-item.collapse-item:hover {
  background: var(--background-tertiary);
}

.expand-button-text {
  font-size: 12px;
  color: var(--text-tertiary);
}

/* 滚动条样式 */
.tooltip-items::-webkit-scrollbar {
  width: 4px;
}

.tooltip-items::-webkit-scrollbar-track {
  background: #f1f5f9;
}

.tooltip-items::-webkit-scrollbar-thumb {
  background: #cbd5e1;
  border-radius: 2px;
}

.tooltip-items::-webkit-scrollbar-thumb:hover {
  background: #94a3b8;
}

/* 二级悬浮框样式 */
.item-detail-tooltip {
  position: fixed;
  z-index: 1002;
  background: white;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
  animation: detailTooltipShow 0.2s ease-out;
  max-width: 350px;
  max-height: 250px;
  overflow-y: auto;
  font-size: 12px;
  transition: all 0.15s ease-out;
}

@keyframes detailTooltipShow {
  from {
    opacity: 0;
    transform: translateY(-6px) scale(0.95);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@keyframes detailTooltipHide {
  from {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
  to {
    opacity: 0;
    transform: translateY(-6px) scale(0.95);
  }
}

.item-detail-tooltip.hide {
  animation: detailTooltipHide 0.15s ease-in;
}

.item-detail-tooltip .detail-header {
  font-weight: 600;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border-color);
  background: #f8fafc;
  color: #1e293b;
  font-size: 0.8125rem;
  line-height: 1.4;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.item-detail-tooltip .detail-header::before {
  content: '';
  width: 3px;
  height: 12px;
  background: #3b82f6;
  border-radius: 2px;
  flex-shrink: 0;
}

.item-detail-tooltip .detail-description {
  padding: 0.75rem 1rem;
  color: var(--text-secondary);
  line-height: 1.5;
  font-size: 0.8125rem;
  word-wrap: break-word;
  overflow-wrap: break-word;
  hyphens: auto;
}

.item-detail-tooltip .detail-schema {
  padding: 0.75rem 1rem;
  background: #f8fafc;
  border-top: 1px solid #e2e8f0;
  border-radius: 0 0 8px 8px;
}

.item-detail-tooltip .detail-schema pre {
  margin: 0;
  font-size: 0.6875rem;
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: break-word;
  color: var(--text-primary);
  background: #f1f5f9;
  padding: 0.5rem;
  border-radius: 4px;
  border: 1px solid #e2e8f0;
  max-height: 120px;
  overflow-y: auto;
}

/* 响应式设计优化 */
@media (max-width: 768px) {
  .item-detail-tooltip {
    max-width: min(350px, calc(100vw - 40px));
    max-height: min(250px, calc(100vh - 100px));
    font-size: 11px;
  }
  
  .item-detail-tooltip .detail-header {
    font-size: 0.75rem;
    padding: 0.625rem 0.875rem;
  }
  
  .item-detail-tooltip .detail-description {
    font-size: 0.75rem;
    padding: 0.625rem 0.875rem;
  }
  
  .item-detail-tooltip .detail-schema {
    padding: 0.625rem 0.875rem;
  }
  
  .item-detail-tooltip .detail-schema pre {
    font-size: 0.625rem;
    max-height: 100px;
  }
}

@media (max-width: 480px) {
  .item-detail-tooltip {
    max-width: calc(100vw - 20px);
    max-height: calc(100vh - 60px);
    font-size: 10px;
  }
  
  .item-detail-tooltip .detail-header {
    font-size: 0.6875rem;
    padding: 0.5rem 0.75rem;
  }
  
  .item-detail-tooltip .detail-description {
    font-size: 0.6875rem;
    padding: 0.5rem 0.75rem;
  }
  
  .item-detail-tooltip .detail-schema {
    padding: 0.5rem 0.75rem;
  }
  
  .item-detail-tooltip .detail-schema pre {
    font-size: 0.5625rem;
    max-height: 80px;
  }
}
</style>