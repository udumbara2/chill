<template>
  <div class="conditional-edge-config-overlay" v-if="isVisible" @click="handleCancel">
    <div class="conditional-edge-config" @click.stop>
      <div class="config-header">
        <h3>配置条件</h3>
        <button class="close-button" @click="handleCancel">×</button>
      </div>

      <div class="config-body">
        <div class="config-content">
          <!-- 主条件配置区域 -->
          <div class="main-condition-section" :class="{ 'is-collapsed': hasMultipleBranches && !expandedMain }">
            <!-- 折叠头部（多分支时显示） -->
            <div
              v-if="hasMultipleBranches"
              class="condition-card-header"
              @click="toggleMainExpand"
            >
              <div class="condition-card-title">
                <span class="branch-index">1</span>
                <span class="branch-name">分支 1</span>
              </div>
              <div class="condition-card-summary">{{ getConditionSummary(mainCondition) }}</div>
              <div class="condition-card-arrow" :class="{ 'is-expanded': expandedMain }"></div>
            </div>

            <!-- 展开内容 -->
            <div v-show="!hasMultipleBranches || expandedMain" class="condition-card-content">
              <!-- 单分支时显示标题 -->
              <div v-if="!hasMultipleBranches" class="main-condition-header">
                <label class="config-label">请选择条件</label>
              </div>

              <!-- 循环警告提示 -->
              <div v-if="isCycleConnection || isSelfLoop" class="self-loop-warning">
                <span class="warning-icon">⚠️</span>
                <span class="warning-text">当前为循环配置，建议设置最大迭代次数以防止无限循环</span>
              </div>

              <!-- 条件类型选择器 -->
              <div class="condition-row">
                <label class="row-label">条件类型</label>
                <select v-model="mainCondition.conditionType" class="condition-select">
                  <option value="tool_call">有工具调用</option>
                  <option value="content">消息内容条件</option>
                  <option value="state_field">状态字段条件</option>
                  <option value="expression">条件表达式</option>
                </select>
                <span v-if="isCycleConnection || isSelfLoop" class="field-hint">循环场景推荐使用"有工具调用"条件</span>
              </div>

              <!-- 条件配置组件 -->
              <BranchConditionConfig
                :condition-type="mainCondition.conditionType"
                :condition-config="getMainConditionConfig()"
                :available-fields="fieldOptions"
                @update:condition-config="updateMainConditionConfig"
              />

              <!-- 目标节点选择 -->
              <div class="condition-row">
                <label class="row-label">目标节点</label>
                <select v-model="mainCondition.targetNodeId" class="condition-select">
                  <option value="">请选择目标节点</option>
                  <option v-for="node in availableNodes" :key="node.id" :value="node.id">
                    {{ getNodeLabel(node) }}
                  </option>
                </select>
              </div>

              <!-- 最大迭代次数（在循环场景下显示） -->
              <div v-if="isCycleConnection || isSelfLoop" class="condition-row">
                <label class="row-label">最大迭代次数</label>
                <input
                  v-model.number="mainCondition.maxIterations"
                  type="number"
                  min="1"
                  class="condition-input"
                  placeholder="循环场景必填"
                  :required="true"
                />
                <span class="field-description is-required">
                  循环场景必须设置最大迭代次数
                </span>
              </div>
            </div>
          </div>

          <!-- 额外分支配置区域（可选） -->
          <div v-if="additionalBranches.length > 0" class="additional-branches-section">
            <div class="branches-list">
              <div
                v-for="(branch, index) in additionalBranches"
                :key="branch.id"
                class="branch-item"
                :class="{ 'is-collapsed': !isBranchExpanded(branch.id) }"
              >
                <!-- 折叠头部（包含操作按钮） -->
                <div class="condition-card-header">
                  <div class="condition-card-header-left" @click="toggleBranchExpand(branch.id)">
                    <div class="condition-card-title">
                      <span class="branch-index">{{ index + 2 }}</span>
                      <span class="branch-name">分支 {{ index + 2 }}</span>
                    </div>
                    <div class="condition-card-summary">{{ getConditionSummary(branch) }}</div>
                    <div class="condition-card-arrow" :class="{ 'is-expanded': isBranchExpanded(branch.id) }"></div>
                  </div>
                  <!-- 操作按钮（始终在头部显示） -->
                  <div class="condition-card-actions" @click.stop>
                    <button
                      type="button"
                      class="action-icon-button"
                      @click="moveBranchUp(index)"
                      :disabled="index === 0"
                      title="上移"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      class="action-icon-button"
                      @click="moveBranchDown(index)"
                      :disabled="index === additionalBranches.length - 1"
                      title="下移"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      class="action-icon-button delete"
                      @click="removeBranch(index)"
                      title="删除分支"
                    >
                      ×
                    </button>
                  </div>
                </div>

                <!-- 展开内容（仅显示配置表单） -->
                <div v-show="isBranchExpanded(branch.id)" class="condition-card-content">
                  <!-- 条件类型选择器 -->
                  <div class="condition-row">
                    <label class="row-label">条件类型</label>
                    <select v-model="branch.conditionType" class="condition-select">
                      <option value="tool_call">有工具调用</option>
                      <option value="content">消息内容条件</option>
                      <option value="state_field">状态字段条件</option>
                      <option value="expression">条件表达式</option>
                    </select>
                  </div>

                  <!-- 条件配置组件 -->
                  <BranchConditionConfig
                    :condition-type="branch.conditionType"
                    :condition-config="getBranchConditionConfig(branch)"
                    :available-fields="fieldOptions"
                    @update:condition-config="(config) => updateBranchConditionConfig(branch, config)"
                  />

                  <!-- 目标节点选择 -->
                  <div class="condition-row">
                    <label class="row-label">目标节点</label>
                    <select v-model="branch.targetNodeId" class="condition-select">
                      <option value="">请选择目标节点</option>
                      <option v-for="node in availableNodes" :key="node.id" :value="node.id">
                        {{ getNodeLabel(node) }}
                      </option>
                    </select>
                  </div>

                  <!-- 最大迭代次数（仅在该分支本身形成循环时显示） -->
                  <div v-if="branch.targetNodeId === props.sourceNodeId" class="condition-row">
                    <label class="row-label">最大迭代次数</label>
                    <input
                      v-model.number="branch.maxIterations"
                      type="number"
                      min="1"
                      class="condition-input"
                      placeholder="自循环必填"
                      :required="true"
                    />
                    <span class="field-description is-required">自循环场景必须设置最大迭代次数</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- 添加分支按钮 -->
          <div class="add-branch-section">
            <button type="button" class="add-branch-button" @click="addBranch">
              + 添加分支
            </button>
            <span class="add-branch-hint">添加更多条件分支以实现复杂的路由逻辑</span>
          </div>

          <!-- 全局回退节点选择器 -->
          <div class="config-section fallback-section">
            <label class="config-label">回退节点（可选）</label>
            <select v-model="selectedFallback" class="node-select">
              <option value="">请选择回退节点</option>
              <option v-for="node in availableNodes" :key="node.id" :value="node.id">
                {{ getNodeLabel(node) }}
              </option>
            </select>
            <p class="field-description">当所有分支条件都不匹配时，将路由到回退节点</p>
          </div>
        </div>
      </div>

      <div class="config-actions">
        <button type="button" class="btn-secondary" @click="handleCancel">取消</button>
        <button type="button" class="btn-primary" @click="handleConfirm" :disabled="!canConfirm">确认</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import type { Node, Edge } from '@vue-flow/core'
import { OperatorType, ContentOperatorType } from '@assistant-ai/core'
import type { BranchConfig } from '@assistant-ai/core'

import BranchConditionConfig from './BranchConditionConfig.vue'

interface Props {
  isVisible: boolean
  nodes: Node[]
  edges: Edge[]
  sourceNodeId?: string
  targetNodeId?: string
  editingEdgeId?: string | null
  edgeData?: any
  isCycleConnection?: boolean
}

const props = defineProps<Props>()

const emit = defineEmits<{
  confirm: [config: { branches: BranchConfig[]; fallbackNodeId?: string }]
  update: [edgeId: string, config: { branches: BranchConfig[]; fallbackNodeId?: string }]
  cancel: []
}>()

const selectedFallback = ref('')

// 主条件（始终存在）
interface ConditionItem {
  id: string
  conditionType: 'tool_call' | 'content' | 'state_field' | 'expression'
  // content
  contentOperator?: ContentOperatorType
  contentValue?: string
  // state_field
  field?: string
  operator?: OperatorType
  value?: string
  // expression
  expression?: string
  // common
  targetNodeId: string
  maxIterations?: number
}

const mainCondition = ref<ConditionItem>(createDefaultCondition())
// 额外分支（可选）
const additionalBranches = ref<ConditionItem[]>([])

// 展开/折叠状态管理
const expandedMain = ref(true) // 主条件默认展开
const expandedBranches = ref<Record<string, boolean>>({}) // 各分支的展开状态

// 计算是否有多个分支（主条件 + 额外分支）
const hasMultipleBranches = computed(() => additionalBranches.value.length > 0)

// 切换主条件展开/折叠
const toggleMainExpand = () => {
  if (hasMultipleBranches.value) {
    expandedMain.value = !expandedMain.value
  }
}

// 切换分支展开/折叠
const toggleBranchExpand = (branchId: string) => {
  expandedBranches.value[branchId] = !expandedBranches.value[branchId]
}

// 获取分支的展开状态
const isBranchExpanded = (branchId: string): boolean => {
  return expandedBranches.value[branchId] ?? false
}

// 获取条件的简短描述
const getConditionSummary = (branch: ConditionItem): string => {
  const typeMap: Record<string, string> = {
    tool_call: '有工具调用',
    content: '消息内容',
    state_field: '状态字段',
    expression: '条件表达式'
  }
  const typeLabel = typeMap[branch.conditionType] || '未知类型'

  let targetLabel = '未选择目标'
  const targetNode = availableNodes.value.find(n => n.id === branch.targetNodeId)
  if (targetNode) {
    targetLabel = getNodeLabel(targetNode)
  }

  return `${typeLabel} → ${targetLabel}`
}

const fieldOptions = [
  { value: 'text', label: '用户输入文本', description: '用户最初输入的文本内容（开始节点的输入）' },
  { value: 'files', label: '文件列表', description: '上传的文件路径数组' },
  { value: 'iterationCount', label: '迭代计数', description: '当前迭代次数' }
]

const availableNodes = computed(() => {
  // 允许选择源节点自身，支持循环结构
  return props.nodes
})

const getNodeLabel = (node: Node) => {
  if (node.data?.label) {
    return node.data.label
  }
  return `节点 ${node.id}`
}

// 检测主条件是否为自循环（目标节点是源节点自身）
const isSelfLoop = computed(() => {
  return mainCondition.value.targetNodeId && 
         mainCondition.value.targetNodeId === props.sourceNodeId
})

const canConfirm = computed(() => {
  // 检查主条件是否有目标节点
  if (!mainCondition.value.targetNodeId) {
    return false
  }

  // 主条件循环场景：必须设置最大迭代次数
  if ((props.isCycleConnection || isSelfLoop.value) && !mainCondition.value.maxIterations) {
    return false
  }

  // 额外分支自循环场景：必须设置最大迭代次数
  for (const branch of additionalBranches.value) {
    if (branch.targetNodeId === props.sourceNodeId && !branch.maxIterations) {
      return false
    }
  }

  return true
})

// 创建默认条件配置
function createDefaultCondition(): ConditionItem {
  return {
    id: `branch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    conditionType: 'tool_call',
    targetNodeId: ''
  }
}

// 获取主条件的配置对象
const getMainConditionConfig = (): Record<string, any> => {
  const branch = mainCondition.value
  switch (branch.conditionType) {
    case 'content':
      return {
        operator: branch.contentOperator || 'equals',
        value: branch.contentValue || ''
      }
    case 'state_field':
      return {
        field: branch.field || '',
        operator: branch.operator || 'eq',
        value: branch.value || ''
      }
    case 'expression':
      return {
        expression: branch.expression || ''
      }
    case 'tool_call':
    default:
      return {}
  }
}

// 更新主条件的配置
const updateMainConditionConfig = (config: Record<string, any>) => {
  const branch = mainCondition.value
  switch (branch.conditionType) {
    case 'content':
      branch.contentOperator = config.operator as ContentOperatorType
      branch.contentValue = config.value
      break
    case 'state_field':
      branch.field = config.field
      branch.operator = config.operator as OperatorType
      branch.value = config.value
      break
    case 'expression':
      branch.expression = config.expression
      break
    case 'tool_call':
    default:
      // tool_call 不需要额外配置
      break
  }
}

// 获取分支的条件配置对象
const getBranchConditionConfig = (branch: ConditionItem): Record<string, any> => {
  switch (branch.conditionType) {
    case 'content':
      return {
        operator: branch.contentOperator || 'equals',
        value: branch.contentValue || ''
      }
    case 'state_field':
      return {
        field: branch.field || '',
        operator: branch.operator || 'eq',
        value: branch.value || ''
      }
    case 'expression':
      return {
        expression: branch.expression || ''
      }
    case 'tool_call':
    default:
      return {}
  }
}

// 更新分支的条件配置
const updateBranchConditionConfig = (branch: ConditionItem, config: Record<string, any>) => {
  switch (branch.conditionType) {
    case 'content':
      branch.contentOperator = config.operator as ContentOperatorType
      branch.contentValue = config.value
      break
    case 'state_field':
      branch.field = config.field
      branch.operator = config.operator as OperatorType
      branch.value = config.value
      break
    case 'expression':
      branch.expression = config.expression
      break
    case 'tool_call':
    default:
      // tool_call 不需要额外配置
      break
  }
}

// ==================== 分支管理逻辑 ====================

/**
 * 添加新分支到列表末尾
 */
const addBranch = () => {
  // 如果主条件已设置好（有目标节点），则自动折叠主条件
  if (mainCondition.value.targetNodeId) {
    expandedMain.value = false
  }
  const newBranch = createDefaultCondition()
  additionalBranches.value.push(newBranch)
  // 新添加的分支默认展开
  expandedBranches.value[newBranch.id] = true
}

/**
 * 从列表中移除指定索引的分支
 * @param index - 要移除的分支索引
 */
const removeBranch = (index: number) => {
  if (index < 0 || index >= additionalBranches.value.length) return
  additionalBranches.value.splice(index, 1)
}

/**
 * 交换两个位置的分支
 * @param fromIndex - 源索引
 * @param toIndex - 目标索引
 */
const swapBranches = (fromIndex: number, toIndex: number) => {
  if (fromIndex < 0 || fromIndex >= additionalBranches.value.length) return
  if (toIndex < 0 || toIndex >= additionalBranches.value.length) return

  const temp = additionalBranches.value[fromIndex]
  additionalBranches.value[fromIndex] = additionalBranches.value[toIndex]
  additionalBranches.value[toIndex] = temp
}

/**
 * 将分支向上移动一位
 * @param index - 要移动的分支索引
 */
const moveBranchUp = (index: number) => {
  if (index <= 0 || index >= additionalBranches.value.length) return
  swapBranches(index, index - 1)
}

/**
 * 将分支向下移动一位
 * @param index - 要移动的分支索引
 */
const moveBranchDown = (index: number) => {
  if (index < 0 || index >= additionalBranches.value.length - 1) return
  swapBranches(index, index + 1)
}

// ==================== 分支管理逻辑结束 ====================

// 将 ConditionItem 转换为 BranchConfig
const convertToBranchConfig = (item: ConditionItem, index: number): BranchConfig | null => {
  if (!item.targetNodeId) return null

  let condition: any

  switch (item.conditionType) {
    case 'tool_call':
      condition = { type: 'tool_call' as const }
      break
    case 'content':
      condition = {
        type: 'content' as const,
        operator: item.contentOperator || ContentOperatorType.EQUALS,
        value: item.contentValue || ''
      }
      break
    case 'state_field':
      condition = {
        type: 'state_field' as const,
        field: item.field || '',
        operator: item.operator || OperatorType.EQ,
        value: item.value || ''
      }
      break
    case 'expression':
      condition = {
        type: 'expression' as const,
        expression: item.expression || ''
      }
      break
    default:
      condition = { type: 'tool_call' as const }
  }

  const config: BranchConfig = {
    id: item.id,
    label: `分支 ${index + 1}`,
    condition,
    targetNodeId: item.targetNodeId,
    priority: index
  }

  // 添加最大迭代次数（如果设置了）
  if (item.maxIterations && item.maxIterations > 0) {
    config.maxIterations = item.maxIterations
  }

  return config
}

const handleConfirm = () => {
  // 收集所有条件（主条件 + 额外分支）
  const allConditions: ConditionItem[] = [mainCondition.value, ...additionalBranches.value]

  // 转换为 BranchConfig 数组（过滤掉没有目标节点的）
  const branchConfigs = allConditions
    .map((item, index) => convertToBranchConfig(item, index))
    .filter((config): config is BranchConfig => config !== null)

  if (branchConfigs.length === 0) {
    return // 至少需要一个有效分支
  }

  const config = {
    branches: branchConfigs,
    fallbackNodeId: selectedFallback.value || undefined
  }

  if (props.editingEdgeId) {
    emit('update', props.editingEdgeId, config)
  } else {
    emit('confirm', config)
  }
}

const handleCancel = () => {
  emit('cancel')
}

// 从 BranchConfig 加载数据到 ConditionItem
const loadConditionFromBranchConfig = (branchConfig: any): ConditionItem => {
  const condition = branchConfig.condition
  const item: ConditionItem = {
    id: branchConfig.id || `branch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    conditionType: condition?.type || 'tool_call',
    targetNodeId: branchConfig.targetNodeId || ''
  }

  // 加载最大迭代次数
  if (branchConfig.maxIterations) {
    item.maxIterations = branchConfig.maxIterations
  }

  switch (condition?.type) {
    case 'content':
      item.contentOperator = condition.operator
      item.contentValue = condition.value
      break
    case 'state_field':
      item.field = condition.field
      item.operator = condition.operator
      item.value = String(condition.value)
      break
    case 'expression':
      item.expression = typeof condition.expression === 'string'
        ? condition.expression
        : formatExpressionToString(condition.expression)
      break
    case 'tool_call':
    default:
      // tool_call 不需要额外配置
      break
  }

  return item
}

watch(() => props.edgeData, (newData) => {
  if (newData) {
    // 处理新的数据格式：{ branches: BranchConfig[], fallbackNodeId?: string }
    if (newData.branches && Array.isArray(newData.branches) && newData.branches.length > 0) {
      // 第一个分支作为主条件
      mainCondition.value = loadConditionFromBranchConfig(newData.branches[0])
      // 其余分支作为额外分支
      additionalBranches.value = newData.branches.slice(1).map((branchConfig: any) =>
        loadConditionFromBranchConfig(branchConfig)
      )
      // 设置回退节点
      selectedFallback.value = newData.fallbackNodeId || ''

      // 如果是多分支（有额外分支），则默认折叠所有分支
      if (newData.branches.length > 1) {
        expandedMain.value = false
        // 折叠所有额外分支
        expandedBranches.value = {}
        additionalBranches.value.forEach(branch => {
          expandedBranches.value[branch.id] = false
        })
      } else {
        // 单分支时默认展开主条件
        expandedMain.value = true
      }
    } else if (newData.condition) {
      // 处理旧的数据格式（向后兼容）
      const condition = newData.condition

      if (condition.type === 'tool_call') {
        mainCondition.value = {
          id: `branch_${Date.now()}_0`,
          conditionType: 'tool_call',
          targetNodeId: newData.targetNodeId || ''
        }
        additionalBranches.value = []
        selectedFallback.value = condition.fallback || ''
      } else if (condition.type === 'content') {
        mainCondition.value = {
          id: `branch_${Date.now()}_0`,
          conditionType: 'content',
          contentOperator: condition.operator || ContentOperatorType.EQUALS,
          contentValue: String(condition.value || ''),
          targetNodeId: newData.targetNodeId || ''
        }
        additionalBranches.value = []
        selectedFallback.value = condition.fallback || ''
      } else if (condition.type === 'state_field') {
        selectedFallback.value = condition.fallback || ''

        if (condition.branches && Object.keys(condition.branches).length > 0) {
          // 将旧格式分支数据（Record<string, string>）转换为新的格式
          const entries = Object.entries(condition.branches)
          mainCondition.value = {
            id: `branch_${Date.now()}_0`,
            conditionType: 'state_field',
            field: condition.field || '',
            operator: OperatorType.EQ,
            value: entries[0][0],
            targetNodeId: entries[0][1] as string
          }
          additionalBranches.value = entries.slice(1).map(([value, targetNodeId], index) => ({
            id: `branch_${Date.now()}_${index + 1}`,
            conditionType: 'state_field',
            field: condition.field || '',
            operator: OperatorType.EQ,
            value: value,
            targetNodeId: targetNodeId as string
          }))
        } else {
          // 单分支模式
          mainCondition.value = {
            id: `branch_${Date.now()}_0`,
            conditionType: 'state_field',
            field: condition.field || '',
            operator: condition.operator || OperatorType.EQ,
            value: String(condition.value || ''),
            targetNodeId: newData.targetNodeId || ''
          }
          additionalBranches.value = []
        }
      } else if (condition.type === 'expression') {
        mainCondition.value = {
          id: `branch_${Date.now()}_0`,
          conditionType: 'expression',
          expression: typeof condition.expression === 'string'
            ? condition.expression
            : formatExpressionToString(condition.expression),
          targetNodeId: newData.targetNodeId || ''
        }
        additionalBranches.value = []
        selectedFallback.value = condition.fallback || ''
      }
    }
  } else {
    // 没有数据时重置为默认状态（新建条件边）
    // 使用 props.targetNodeId 作为默认目标节点（用户拖拽连接的目标节点）
    mainCondition.value = {
      id: `branch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      conditionType: 'tool_call',
      targetNodeId: props.targetNodeId || ''
    }
    additionalBranches.value = []
    selectedFallback.value = ''
    // 新建时默认展开主条件
    expandedMain.value = true
  }
}, { immediate: true })

// 监听目标节点变化，循环场景下自动切换到 tool_call 条件类型
watch(() => mainCondition.value.targetNodeId, (newTargetId) => {
  if (newTargetId && newTargetId === props.sourceNodeId) {
    // 循环场景：如果当前不是 tool_call，自动切换为 tool_call（最安全的选择）
    if (mainCondition.value.conditionType !== 'tool_call') {
      mainCondition.value.conditionType = 'tool_call'
    }
  }
})

function getOperatorSymbol(operator: OperatorType): string {
  switch (operator) {
    case OperatorType.EQ:
      return '=='
    case OperatorType.NE:
      return '!='
    case OperatorType.GT:
      return '>'
    case OperatorType.LT:
      return '<'
    case OperatorType.GTE:
      return '>='
    case OperatorType.LTE:
      return '<='
    case OperatorType.CONTAINS:
      return '包含'
    default:
      return '=='
  }
}

function formatValue(value: string | number | boolean): string {
  if (typeof value === 'string') {
    return `"${value}"`
  } else if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  } else {
    return String(value)
  }
}

function formatExpressionToString(expression: any): string {
  if (expression.type === 'basic') {
    const operatorSymbol = getOperatorSymbol(expression.operator)
    return `${expression.field} ${operatorSymbol} ${formatValue(expression.value)}`
  } else if (expression.type === 'logical') {
    const leftStr = formatExpressionToString(expression.left)
    const rightStr = formatExpressionToString(expression.right)

    if (expression.operator === 'and') {
      return `(${leftStr} AND ${rightStr})`
    } else if (expression.operator === 'or') {
      return `(${leftStr} OR ${rightStr})`
    } else if (expression.operator === 'not') {
      return `NOT ${leftStr}`
    }
    return ''
  } else if (expression.type === 'group') {
    return `(${formatExpressionToString(expression.expression)})`
  }
  return ''
}
</script>

<style scoped>
.conditional-edge-config-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2000;
}

.conditional-edge-config {
  background: white;
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
  width: 416px;
  max-width: 90vw;
  max-height: 75vh;
  display: flex;
  flex-direction: column;
}

.config-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 16px;
  border-bottom: 1px solid #e5e7eb;
}

.config-header h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: #111827;
}

.close-button {
  background: none;
  border: none;
  font-size: 18px;
  color: #6b7280;
  cursor: pointer;
  padding: 0;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}

.close-button:hover {
  color: #111827;
}

.config-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.config-content {
  padding: 16px;
  overflow-y: auto;
  flex: 1;
  min-width: 0;
  max-width: 600px;
}

.config-section {
  margin-bottom: 14px;
}

.config-section:last-child {
  margin-bottom: 0;
}

.config-label {
  display: block;
  font-size: 12px;
  font-weight: 500;
  color: #374151;
  margin-bottom: 6px;
}

.field-description {
  font-size: 11px;
  color: #6b7280;
  margin-top: 4px;
  line-height: 1.5;
}

.field-description.is-required {
  color: #dc2626;
  font-weight: 500;
}

.field-hint {
  font-size: 11px;
  color: #3b82f6;
  margin-top: 4px;
}

/* 自循环警告样式 */
.self-loop-warning {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  background-color: #fef3c7;
  border: 1px solid #f59e0b;
  border-radius: 6px;
  margin-bottom: 12px;
}

.warning-icon {
  font-size: 16px;
  flex-shrink: 0;
}

.warning-text {
  font-size: 12px;
  color: #92400e;
  line-height: 1.5;
}

.node-select {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  font-size: 12px;
  color: #374151;
  background-color: white;
  cursor: pointer;
}

.node-select:focus {
  outline: none;
  border-color: #3b82f6;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
}

.config-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid #e5e7eb;
}

.btn-secondary {
  padding: 6px 12px;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  background-color: white;
  color: #374151;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-secondary:hover {
  background-color: #f9fafb;
  border-color: #9ca3af;
}

.btn-primary {
  padding: 6px 12px;
  border: none;
  border-radius: 4px;
  background-color: #3b82f6;
  color: white;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-primary:hover:not(:disabled) {
  background-color: #2563eb;
}

.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 主条件配置区域样式 */
.main-condition-section {
  margin-bottom: 12px;
  background: linear-gradient(135deg, #f9fafb 0%, #f3f4f6 100%);
  border: 2px solid #3b82f6;
  border-radius: 8px;
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
  overflow: hidden;
}

.main-condition-section.is-collapsed {
  border-color: #d1d5db;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
}

.main-condition-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
  padding-bottom: 10px;
  border-bottom: 1px solid #e5e7eb;
}

.main-condition-header .config-label {
  margin-bottom: 0;
  font-size: 13px;
  font-weight: 600;
  color: #111827;
}

/* 条件卡片样式（折叠/展开） */
.condition-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  transition: all 0.2s ease;
  user-select: none;
}

.condition-card-header-left {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
  cursor: pointer;
}

.condition-card-header-left:hover {
  background-color: rgba(59, 130, 246, 0.05);
  margin: -10px 0 -10px -12px;
  padding: 10px 0 10px 12px;
  border-radius: 8px 0 0 8px;
}

.condition-card-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  margin-left: 8px;
}

.action-icon-button {
  width: 24px;
  height: 24px;
  border: 1px solid #e5e7eb;
  border-radius: 4px;
  background-color: white;
  color: #6b7280;
  font-size: 12px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
}

.action-icon-button:hover:not(:disabled) {
  background-color: #f3f4f6;
  border-color: #d1d5db;
  color: #374151;
}

.action-icon-button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  background-color: #f9fafb;
}

.action-icon-button.delete {
  border-color: #fecaca;
  background-color: #fef2f2;
  color: #ef4444;
}

.action-icon-button.delete:hover {
  background-color: #ef4444;
  border-color: #ef4444;
  color: white;
}

.condition-card-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.branch-index {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  background-color: #3b82f6;
  color: white;
  font-size: 11px;
  font-weight: 600;
  border-radius: 50%;
}

.branch-name {
  font-size: 12px;
  font-weight: 600;
  color: #374151;
}

.condition-card-summary {
  flex: 1;
  font-size: 11px;
  color: #6b7280;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  margin-left: 8px;
}

.condition-card-arrow {
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.condition-card-arrow::before {
  content: '';
  width: 6px;
  height: 6px;
  border-right: 1.5px solid #9ca3af;
  border-bottom: 1.5px solid #9ca3af;
  transform: rotate(45deg);
  transition: transform 0.2s ease;
  margin-top: -2px;
}

.condition-card-arrow.is-expanded::before {
  transform: rotate(-135deg);
  margin-top: 2px;
}

.condition-card-content {
  padding: 10px 14px 14px 14px;
}

/* 单分支时的标题区域样式 */
.condition-card-content > .main-condition-header:first-child {
  margin-bottom: 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid #e5e7eb;
}

/* 优先级徽章 */
.priority-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  background-color: #dbeafe;
  color: #1d4ed8;
  font-size: 11px;
  font-weight: 600;
  border-radius: 12px;
  border: 1px solid #93c5fd;
}

.condition-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 10px;
}

.condition-row:last-child {
  margin-bottom: 0;
}

.row-label {
  font-size: 12px;
  font-weight: 500;
  color: #374151;
}

.condition-select {
  width: 100%;
  padding: 6px 10px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 12px;
  color: #374151;
  background-color: white;
  cursor: pointer;
}

.condition-select:focus {
  outline: none;
  border-color: #3b82f6;
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.1);
}

/* 额外分支区域样式 */
.additional-branches-section {
  margin-bottom: 12px;
}

.additional-branches-header {
  margin-bottom: 10px;
}

/* 添加分支按钮区域 */
.add-branch-section {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  margin-bottom: 16px;
  padding: 0 4px;
}

.add-branch-button {
  padding: 6px 12px;
  border: 1px dashed #3b82f6;
  border-radius: 4px;
  background-color: white;
  color: #3b82f6;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.add-branch-button:hover {
  background-color: #3b82f6;
  color: white;
  border-style: solid;
}

.add-branch-hint {
  font-size: 11px;
  color: #6b7280;
}

/* 分支列表样式 */
.branches-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.branch-item {
  background-color: white;
  border-radius: 8px;
  border: 1px solid #e5e7eb;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
  transition: all 0.2s ease;
  overflow: hidden;
}

.branch-item:hover {
  border-color: #3b82f6;
  box-shadow: 0 2px 4px rgba(59, 130, 246, 0.1);
}

.branch-item.is-collapsed:hover {
  border-color: #9ca3af;
}

.branch-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid #e5e7eb;
}

.branch-title {
  font-size: 12px;
  font-weight: 600;
  color: #374151;
}

.branch-title-wrapper {
  display: flex;
  align-items: center;
  gap: 8px;
}

.branch-title-wrapper .priority-badge {
  background-color: #f3f4f6;
  color: #6b7280;
  border-color: #d1d5db;
}



.fallback-section {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid #e5e7eb;
}
</style>
