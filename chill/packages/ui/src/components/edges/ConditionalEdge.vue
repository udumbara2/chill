<template>
  <BaseEdge
    :id="id"
    :path="path"
    :marker-end="markerEnd"
    :style="edgeStyle"
  />
  <EdgeLabelRenderer>
    <div
      v-if="label"
      :style="labelStyle"
      class="conditional-edge-label-wrapper"
      @mouseenter="showTooltipNow"
      @mouseleave="hideTooltipDelayed"
    >
      <div class="conditional-edge-label" :class="labelClass" @click.stop @dblclick.stop="handleDoubleClick" @contextmenu.stop="handleContextMenu" @mouseenter="showEditIcon = true; showDeleteIcon = true" @mouseleave="showEditIcon = false; showDeleteIcon = false">
        <div class="label-content">
          <svg v-if="conditionIcon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="3"/>
          </svg>
          <span>{{ label }}</span>
          <svg v-if="showEditIcon" class="edit-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" @click.stop="handleDoubleClick">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
          <svg v-if="showDeleteIcon" class="delete-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" @click.stop="handleDeleteClick">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
        </div>
      </div>
      <!-- 循环迭代次数显示 -->
      <div v-if="showLoopCounter" class="loop-counter">
        {{ loopCounter }}/{{ maxIterations }}
      </div>
      
      <div
        v-if="showTooltip"
        class="conditional-edge-tooltip"
        @mouseenter="showTooltipNow"
        @mouseleave="hideTooltipDelayed"
      >
        <div class="conditional-edge-tooltip-inner">
          <div class="tooltip-header">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="3"/>
            </svg>
            <span>{{ tooltipTitle }}</span>
          </div>
          <div class="tooltip-content">
            <div v-for="(item, index) in tooltipItems" :key="index" class="tooltip-item">
              <span class="tooltip-label">{{ item.label }}:</span>
              <span class="tooltip-value">{{ item.value }}</span>
            </div>
            <!-- 多分支列表，支持悬停显示连接线（仅当分支数量大于1时显示） -->
            <div v-if="branchItems.length > 1" class="branch-list">
              <div class="branch-list-label">分支列表 (悬停查看连接):</div>
              <div
                v-for="(branch, index) in branchItems"
                :key="branch.id || index"
                class="branch-item"
                @mouseenter="handleBranchHover(branch)"
                @mouseleave="handleBranchLeave"
              >
                <span class="branch-label">{{ branch.label }}</span>
                <span class="branch-arrow">→</span>
                <span class="branch-target">{{ branch.targetLabel }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </EdgeLabelRenderer>
</template>

<script setup lang="ts">
import { computed, ref, onUnmounted } from 'vue'
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@vue-flow/core'
import type { ConditionalEdgeData, ConditionExpression } from '@assistant-ai/core'
import { OperatorType, ContentOperatorType } from '@assistant-ai/core'
import { workflowEventBus, WORKFLOW_EVENTS } from '@assistant-ai/core'

const props = defineProps<EdgeProps<ConditionalEdgeData>>()

const showTooltip = ref(false)
const showDeleteIcon = ref(false)
const showEditIcon = ref(false)

// 循环迭代计数器
const showLoopCounter = ref(false)
const loopCounter = ref(0)
const maxIterations = ref(0)
const loopBranchId = ref('')

// tooltip 延迟关闭计时器
let tooltipHideTimer: ReturnType<typeof setTimeout> | null = null

// 显示 tooltip（立即）
const showTooltipNow = () => {
  if (tooltipHideTimer) {
    clearTimeout(tooltipHideTimer)
    tooltipHideTimer = null
  }
  showTooltip.value = true
}

// 延迟隐藏 tooltip（150ms 延迟，避免快速闪现）
const hideTooltipDelayed = () => {
  tooltipHideTimer = setTimeout(() => {
    showTooltip.value = false
  }, 150)
}

const handleDoubleClick = () => {
  workflowEventBus.emit(WORKFLOW_EVENTS.EDGE_EDIT, { edgeId: props.id })
}

const handleDeleteClick = () => {
  workflowEventBus.emit(WORKFLOW_EVENTS.EDGE_DELETE, { edgeId: props.id })
}

const handleContextMenu = (event: MouseEvent) => {
  event.preventDefault()
  event.stopPropagation()
  workflowEventBus.emit(WORKFLOW_EVENTS.EDGE_CONTEXT_MENU, { edgeId: props.id, clientX: event.clientX, clientY: event.clientY })
}

const pathParams = computed(() => getBezierPath(props))

const path = computed(() => pathParams.value[0])
const labelX = computed(() => pathParams.value[1])
const labelY = computed(() => pathParams.value[2])

const edgeStyle = computed(() => {
  const branches = props.data?.branches
  let color = '#3b82f6'

  // 如果有分支，根据第一个分支的条件类型决定颜色
  if (branches && branches.length > 0) {
    const firstCondition = branches[0].condition
    if (firstCondition?.type === 'tool_call') {
      color = '#3b82f6'
    } else if (firstCondition?.type === 'content') {
      color = '#8b5cf6'
    } else if (firstCondition?.type === 'state_field') {
      color = '#10b981'
    } else if (firstCondition?.type === 'expression') {
      color = '#f59e0b'
    }
  } else {
    // 向后兼容：检查旧版 condition
    const condition = props.data?.condition
    if (condition?.type === 'tool_call') {
      color = '#3b82f6'
    } else if (condition?.type === 'content') {
      color = '#8b5cf6'
    } else if (condition?.type === 'state_field') {
      color = '#10b981'
    } else if (condition?.type === 'expression') {
      color = '#f59e0b'
    }
  }

  // 循环高亮状态：使用活泼的绿色，优先级最高
  if (props.data?.isLoopHighlighted) {
    return {
      stroke: '#4ade80', // 活泼的绿色
      strokeWidth: 4,
      strokeDasharray: '5, 5',
      transition: 'stroke 0.2s ease, stroke-width 0.2s ease'
    }
  }

  return {
    stroke: props.selected ? '#2563eb' : color,
    strokeWidth: props.selected ? 3 : 2,
    strokeDasharray: '5, 5',
    transition: 'stroke 0.2s ease, stroke-width 0.2s ease'
  }
})

const labelStyle = computed(() => {
  const branches = props.data?.branches
  let color = '#3b82f6'

  // 如果有分支，根据第一个分支的条件类型决定颜色
  if (branches && branches.length > 0) {
    const firstCondition = branches[0].condition
    if (firstCondition?.type === 'tool_call') {
      color = '#3b82f6'
    } else if (firstCondition?.type === 'content') {
      color = '#8b5cf6'
    } else if (firstCondition?.type === 'state_field') {
      color = '#10b981'
    } else if (firstCondition?.type === 'expression') {
      color = '#f59e0b'
    }
  } else {
    // 向后兼容：检查旧版 condition
    const condition = props.data?.condition
    if (condition?.type === 'tool_call') {
      color = '#3b82f6'
    } else if (condition?.type === 'content') {
      color = '#8b5cf6'
    } else if (condition?.type === 'state_field') {
      color = '#10b981'
    } else if (condition?.type === 'expression') {
      color = '#f59e0b'
    }
  }

  return {
    position: 'absolute' as const,
    transform: `translate(-50%, -50%) translate(${labelX.value}px,${labelY.value}px)`,
    pointerEvents: 'none' as const,
    color
  }
})

const conditionIcon = computed(() => {
  const branches = props.data?.branches
  // 如果有分支，显示图标
  if (branches && branches.length > 0) {
    return true
  }
  // 向后兼容：检查旧版 condition
  const condition = props.data?.condition
  return condition?.type === 'tool_call' || condition?.type === 'content' || condition?.type === 'state_field' || condition?.type === 'expression'
})

const labelClass = computed(() => {
  const branches = props.data?.branches
  // 如果有分支，根据第一个分支的条件类型决定样式
  if (branches && branches.length > 0) {
    const firstCondition = branches[0].condition
    return {
      'tool-call': firstCondition?.type === 'tool_call',
      'content': firstCondition?.type === 'content',
      'state-field': firstCondition?.type === 'state_field',
      'expression': firstCondition?.type === 'expression'
    }
  }
  // 向后兼容：检查旧版 condition
  const condition = props.data?.condition
  return {
    'tool-call': condition?.type === 'tool_call',
    'content': condition?.type === 'content',
    'state-field': condition?.type === 'state_field',
    'expression': condition?.type === 'expression'
  }
})

const label = computed(() => {
  if (props.data?.label) {
    return props.data.label
  }

  const branches = props.data?.branches
  const branchId = props.data?.branchId

  // 优先使用新的 branches 格式
  if (branches && branches.length > 0) {
    // 如果有 branchId，找到对应的分支显示其条件详情
    if (branchId) {
      const currentBranch = branches.find(b => b.id === branchId)
      if (currentBranch) {
        const condition = currentBranch.condition
        return getConditionSummary(condition)
      }
    }

    // 单分支显示条件详情
    if (branches.length === 1) {
      const condition = branches[0].condition
      return getConditionSummary(condition)
    } else {
      // 多分支但没有 branchId 时，显示第一个分支的详情（兼容旧数据）
      const firstCondition = branches[0].condition
      return getConditionSummary(firstCondition)
    }
  }

  // 向后兼容：检查旧版 condition
  const condition = props.data?.condition

  if (condition?.type === 'tool_call') {
    return '有工具调用'
  } else if (condition?.type === 'content') {
    const contentCondition = condition as any
    const operatorSymbol = getContentOperatorSymbol(contentCondition.operator)
    return `内容${operatorSymbol}${formatValue(contentCondition.value)}`
  } else if (condition?.type === 'state_field') {
    const stateFieldCondition = condition as any
    // 检查是否使用多分支模式
    if (stateFieldCondition.branches && Object.keys(stateFieldCondition.branches).length > 0) {
      const branchCount = Object.keys(stateFieldCondition.branches).length
      return `${stateFieldCondition.field} · ${branchCount}分支`
    }
    const operatorSymbol = getOperatorSymbol(stateFieldCondition.operator)
    return `${stateFieldCondition.field} ${operatorSymbol} ${formatValue(stateFieldCondition.value)}`
  } else if (condition?.type === 'expression') {
    const expressionCondition = condition as any
    return formatExpression(expressionCondition.expression)
  }

  return '条件边'
})

const tooltipTitle = computed(() => {
  const branches = props.data?.branches

  // 优先使用新的 branches 格式
  if (branches && branches.length > 0) {
    if (branches.length === 1) {
      // 单分支显示条件类型
      const condition = branches[0].condition
      if (condition?.type === 'tool_call') {
        return '工具调用条件'
      } else if (condition?.type === 'content') {
        return '消息内容条件'
      } else if (condition?.type === 'state_field') {
        return '状态字段条件'
      } else if (condition?.type === 'expression') {
        return '条件表达式'
      }
    } else {
      // 多分支显示混合条件
      return `多分支条件 (${branches.length})`
    }
  }

  // 向后兼容：检查旧版 condition
  const condition = props.data?.condition
  if (condition?.type === 'tool_call') {
    return '工具调用条件'
  } else if (condition?.type === 'content') {
    return '消息内容条件'
  } else if (condition?.type === 'state_field') {
    return '状态字段条件'
  } else if (condition?.type === 'expression') {
    return '条件表达式'
  }
  return '条件边'
})

/**
 * 获取条件摘要，用于边标签显示
 * @param condition - 条件配置对象
 * @returns 条件摘要字符串
 */
function getConditionSummary(condition: any): string {
  if (!condition) return '条件'

  if (condition.type === 'tool_call') {
    return '有工具调用'
  } else if (condition.type === 'content') {
    const operatorSymbol = getContentOperatorSymbol(condition.operator)
    const value = formatValue(condition.value)
    // 限制显示长度
    const displayValue = value.length > 10 ? value.substring(0, 10) + '...' : value
    return `内容${operatorSymbol}${displayValue}`
  } else if (condition.type === 'state_field') {
    const operatorSymbol = getOperatorSymbol(condition.operator)
    const value = formatValue(condition.value)
    // 限制显示长度
    const displayValue = value.length > 8 ? value.substring(0, 8) + '...' : value
    return `${condition.field}${operatorSymbol}${displayValue}`
  } else if (condition.type === 'expression') {
    const expr = formatExpression(condition.expression)
    // 限制显示长度
    return expr.length > 15 ? expr.substring(0, 15) + '...' : expr
  }
  return '条件'
}

// 多分支列表（用于悬停显示连接线）
const branchItems = computed(() => {
  const branches = props.data?.branches

  // 优先使用新的 branches 格式
  if (branches && branches.length > 0) {
    return branches.map((branch, index) => ({
      id: branch.id,
      label: `分支 ${index + 1}`,
      targetId: branch.targetNodeId,
      targetLabel: branch.targetNodeId.substring(0, 20) + (branch.targetNodeId.length > 20 ? '...' : '')
    }))
  }

  // 向后兼容：检查旧版 condition.state_field.branches
  const condition = props.data?.condition
  if (condition?.type === 'state_field') {
    const stateFieldCondition = condition as any
    if (stateFieldCondition.branches && Object.keys(stateFieldCondition.branches).length > 0) {
      return Object.entries(stateFieldCondition.branches).map(([value, targetId]) => ({
        id: value,
        label: value,
        targetId: String(targetId),
        targetLabel: String(targetId).substring(0, 20) + (String(targetId).length > 20 ? '...' : '')
      }))
    }
  }
  return []
})

const tooltipItems = computed(() => {
  const branches = props.data?.branches
  const items: Array<{ label: string; value: string }> = []

  // 优先使用新的 branches 格式
  if (branches && branches.length > 0) {
    items.push({ label: '模式', value: branches.length === 1 ? '单一条件' : `多分支 (${branches.length})` })

    // 遍历显示每个分支的详情
    branches.forEach((branch, index) => {
      const condition = branch.condition
      const branchLabel = `分支 ${index + 1}`

      if (condition?.type === 'tool_call') {
        items.push({ label: `${branchLabel}`, value: '工具调用' })
      } else if (condition?.type === 'content') {
        const contentCondition = condition as any
        items.push({ label: `${branchLabel}`, value: `内容 ${getContentOperatorSymbol(contentCondition.operator)} ${formatValue(contentCondition.value)}` })
      } else if (condition?.type === 'state_field') {
        const stateFieldCondition = condition as any
        items.push({ label: `${branchLabel}`, value: `${stateFieldCondition.field} ${getOperatorSymbol(stateFieldCondition.operator)} ${formatValue(stateFieldCondition.value)}` })
      } else if (condition?.type === 'expression') {
        const expressionCondition = condition as any
        items.push({ label: `${branchLabel}`, value: formatExpression(expressionCondition.expression) })
      }
    })

    // 显示回退节点
    const fallbackNodeId = props.data?.fallbackNodeId
    if (fallbackNodeId) {
      items.push({ label: '回退节点', value: fallbackNodeId })
    } else {
      items.push({ label: '回退节点', value: '__end__' })
    }

    return items
  }

  // 向后兼容：检查旧版 condition
  const condition = props.data?.condition

  if (condition?.type === 'tool_call') {
    items.push({ label: '类型', value: '工具调用' })
    items.push({ label: '条件', value: '当模型返回工具调用时，路由到目标节点' })
    if (condition.fallback) {
      items.push({ label: '回退节点', value: condition.fallback })
    } else {
      items.push({ label: '回退节点', value: '__end__' })
    }
  } else if (condition?.type === 'content') {
    const contentCondition = condition as any
    items.push({ label: '类型', value: '消息内容' })
    items.push({ label: '操作符', value: getContentOperatorLabel(contentCondition.operator) })
    items.push({ label: '比较值', value: formatValue(contentCondition.value) })
    if (condition.fallback) {
      items.push({ label: '回退节点', value: condition.fallback })
    } else {
      items.push({ label: '回退节点', value: '__end__' })
    }
  } else if (condition?.type === 'state_field') {
    const stateFieldCondition = condition as any
    items.push({ label: '类型', value: '状态字段' })
    items.push({ label: '字段名', value: stateFieldCondition.field })

    // 检查是否使用多分支模式
    if (stateFieldCondition.branches && Object.keys(stateFieldCondition.branches).length > 0) {
      items.push({ label: '模式', value: `多分支 (${Object.keys(stateFieldCondition.branches).length})` })
      // 分支列表现在单独渲染，不再放在这里
    } else {
      items.push({ label: '操作符', value: getOperatorLabel(stateFieldCondition.operator) })
      items.push({ label: '比较值', value: formatValue(stateFieldCondition.value) })
    }

    if (condition.fallback) {
      items.push({ label: '回退节点', value: condition.fallback })
    } else {
      items.push({ label: '回退节点', value: '__end__' })
    }
  } else if (condition?.type === 'expression') {
    const expressionCondition = condition as any
    items.push({ label: '类型', value: '条件表达式' })
    items.push({ label: '表达式', value: formatExpression(expressionCondition.expression) })
    if (condition.fallback) {
      items.push({ label: '回退节点', value: condition.fallback })
    } else {
      items.push({ label: '回退节点', value: '__end__' })
    }
  }

  return items
})

// 处理分支悬停事件
const handleBranchHover = (branch: { id: string; label: string; targetId: string; targetLabel: string }) => {
  workflowEventBus.emit(WORKFLOW_EVENTS.BRANCH_HOVER, {
    sourceNodeId: props.source,
    targetNodeId: branch.targetId,
    branchId: branch.id
  })
}

// 处理分支离开事件
const handleBranchLeave = () => {
  workflowEventBus.emit(WORKFLOW_EVENTS.BRANCH_LEAVE)
}

// 循环开始事件处理
const handleLoopStarted = (event: { branchId: string; nodeId: string; maxIterations?: number }) => {
  // 检查是否是当前边对应的分支
  const branches = props.data?.branches
  if (branches && branches.length > 0) {
    // 直接匹配分支ID，并校验目标节点是否匹配当前边
    const matchingBranch = branches.find(b => b.id === event.branchId && b.targetNodeId === props.target)

    if (matchingBranch) {
      showLoopCounter.value = true
      loopCounter.value = 1
      maxIterations.value = event.maxIterations || matchingBranch.maxIterations || 0
      loopBranchId.value = event.branchId
    }
  }
}

// 循环迭代更新事件处理
const handleLoopIterationUpdated = (event: { branchId: string; nodeId: string; currentIteration: number; maxIterations?: number }) => {
  // 检查是否是当前边对应的分支
  if (event.branchId === loopBranchId.value) {
    loopCounter.value = event.currentIteration
    maxIterations.value = event.maxIterations || maxIterations.value
  }
}

// 循环结束事件处理
const handleLoopCompleted = (event: { branchId: string; nodeId: string; maxIterations?: number }) => {
  // 检查是否是当前边对应的分支
  if (event.branchId === loopBranchId.value) {
    showLoopCounter.value = false
    loopCounter.value = 0
    maxIterations.value = 0
    loopBranchId.value = ''
  }
}

// 订阅循环事件
workflowEventBus.on(WORKFLOW_EVENTS.LOOP_STARTED, handleLoopStarted)
workflowEventBus.on(WORKFLOW_EVENTS.LOOP_ITERATION_UPDATED, handleLoopIterationUpdated)
workflowEventBus.on(WORKFLOW_EVENTS.LOOP_COMPLETED, handleLoopCompleted)

// 组件卸载时清理
onUnmounted(() => {
  if (tooltipHideTimer) {
    clearTimeout(tooltipHideTimer)
    tooltipHideTimer = null
  }
  // 取消订阅循环事件
  workflowEventBus.off(WORKFLOW_EVENTS.LOOP_STARTED, handleLoopStarted)
  workflowEventBus.off(WORKFLOW_EVENTS.LOOP_ITERATION_UPDATED, handleLoopIterationUpdated)
  workflowEventBus.off(WORKFLOW_EVENTS.LOOP_COMPLETED, handleLoopCompleted)
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
    case OperatorType.NOT_CONTAINS:
      return '不包含'
    default:
      return '=='
  }
}

function getOperatorLabel(operator: OperatorType): string {
  switch (operator) {
    case OperatorType.EQ:
      return '等于 (==)'
    case OperatorType.NE:
      return '不等于 (!=)'
    case OperatorType.GT:
      return '大于 (>)'
    case OperatorType.LT:
      return '小于 (<)'
    case OperatorType.GTE:
      return '大于等于 (>=)'
    case OperatorType.LTE:
      return '小于等于 (<=)'
    case OperatorType.CONTAINS:
      return '包含'
    case OperatorType.NOT_CONTAINS:
      return '不包含'
    default:
      return '等于 (==)'
  }
}

function getContentOperatorSymbol(operator: ContentOperatorType): string {
  switch (operator) {
    case ContentOperatorType.EQUALS:
      return '='
    case ContentOperatorType.NOT_EQUALS:
      return '≠'
    case ContentOperatorType.CONTAINS:
      return '包含'
    case ContentOperatorType.NOT_CONTAINS:
      return '不包含'
    case ContentOperatorType.STARTS_WITH:
      return '开头='
    case ContentOperatorType.ENDS_WITH:
      return '结尾='
    case ContentOperatorType.REGEX:
      return '正则'
    default:
      return '='
  }
}

function getContentOperatorLabel(operator: ContentOperatorType): string {
  switch (operator) {
    case ContentOperatorType.EQUALS:
      return '等于'
    case ContentOperatorType.NOT_EQUALS:
      return '不等于'
    case ContentOperatorType.CONTAINS:
      return '包含'
    case ContentOperatorType.NOT_CONTAINS:
      return '不包含'
    case ContentOperatorType.STARTS_WITH:
      return '开头是'
    case ContentOperatorType.ENDS_WITH:
      return '结尾是'
    case ContentOperatorType.REGEX:
      return '正则匹配'
    default:
      return '等于'
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

function formatExpression(expression: ConditionExpression): string {
  if (expression.type === 'basic') {
    const basicExpr = expression as any
    const operatorSymbol = getOperatorSymbol(basicExpr.operator)
    return `${basicExpr.field} ${operatorSymbol} ${formatValue(basicExpr.value)}`
  } else if (expression.type === 'logical') {
    const logicalExpr = expression as any
    const leftStr = formatExpression(logicalExpr.left)
    const rightStr = formatExpression(logicalExpr.right)
    
    if (logicalExpr.operator === 'and') {
      return `(${leftStr} AND ${rightStr})`
    } else if (logicalExpr.operator === 'or') {
      return `(${leftStr} OR ${rightStr})`
    } else if (logicalExpr.operator === 'not') {
      return `NOT ${leftStr}`
    }
    return ''
  } else if (expression.type === 'group') {
    const groupExpr = expression as any
    return `(${formatExpression(groupExpr.expression)})`
  }
  return ''
}
</script>

<style scoped>
.conditional-edge-label-wrapper {
  position: absolute;
  transform: translate(-50%, -50%);
  pointer-events: none;
}

.conditional-edge-label {
  background: white;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  border: 1px solid currentColor;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  white-space: nowrap;
  transition: all 0.2s ease;
  cursor: pointer;
  pointer-events: auto;
}

.conditional-edge-label.tool-call {
  color: #3b82f6;
  border-color: #3b82f6;
}

.conditional-edge-label.content {
  color: #8b5cf6;
  border-color: #8b5cf6;
}

.conditional-edge-label.state-field {
  color: #10b981;
  border-color: #10b981;
}

.conditional-edge-label.expression {
  color: #f59e0b;
  border-color: #f59e0b;
}

.conditional-edge-label:hover {
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.15);
  transform: scale(1.05);
}

.label-content {
  display: flex;
  align-items: center;
  gap: 4px;
}

.label-content svg {
  flex-shrink: 0;
}

.label-content span {
  font-weight: 500;
}

.delete-icon {
  margin-left: 4px;
  color: #ef4444;
  cursor: pointer;
  transition: all 0.2s ease;
}

.delete-icon:hover {
  color: #dc2626;
  transform: scale(1.1);
}

.edit-icon {
  margin-left: 4px;
  color: #3b82f6;
  cursor: pointer;
  transition: all 0.2s ease;
}

.edit-icon:hover {
  color: #2563eb;
  transform: scale(1.1);
}

/* 循环迭代次数显示 */
.loop-counter {
  position: absolute;
  top: -20px;
  right: -10px;
  background: #4ade80;
  color: #000;
  font-size: 11px;
  font-weight: bold;
  padding: 2px 6px;
  border-radius: 10px;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
  white-space: nowrap;
  pointer-events: none;
  animation: pulse 1s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.05);
  }
}

.conditional-edge-tooltip {
  position: absolute;
  top: 100%;
  left: 50%;
  transform: translateX(-50%);
  padding: 8px 12px 12px 12px;  /* 上padding 8px 替代 margin-top */
  background: transparent;      /* 背景透明，让内部容器显示白色背景 */
  min-width: 200px;
  z-index: 1000;
  pointer-events: auto;
}

.conditional-edge-tooltip-inner {
  background: rgba(255, 255, 255, 0.55);
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
  padding: 12px;
  border: 1px solid rgba(255, 255, 255, 0.3);
}

.tooltip-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid #e5e7eb;
  margin-bottom: 8px;
  font-size: 14px;
  font-weight: 600;
  color: #111827;
}

.tooltip-header svg {
  flex-shrink: 0;
}

.tooltip-content {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.tooltip-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
}

.tooltip-label {
  color: #6b7280;
  font-weight: 500;
}

.tooltip-value {
  color: #111827;
  font-weight: 600;
}

/* 分支列表样式 */
.branch-list {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid #e5e7eb;
  pointer-events: auto;
}

.branch-list-label {
  font-size: 12px;
  color: #6b7280;
  font-weight: 500;
  margin-bottom: 6px;
}

.branch-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  margin: 2px 0;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s ease;
  background-color: #f3f4f6;
}

.branch-item:hover {
  background-color: #dbeafe;
  transform: translateX(4px);
}

.branch-value {
  color: #059669;
  font-weight: 600;
}

.branch-arrow {
  color: #9ca3af;
}

.branch-target {
  color: #111827;
  font-weight: 500;
}
</style>
