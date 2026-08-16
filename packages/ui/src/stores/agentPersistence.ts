import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { Edge } from '@vue-flow/core'
import type { SavedAgent, AgentListItem, WorkflowNode, AgentMetadata, AgentCard, AgentSkill } from '@assistant-ai/core'

/**
 * 将对象转换为可序列化的普通对象
 * 用于将 Vue 响应式对象转换为可 IPC 传递的对象
 */
function toSerializable<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj))
}

/**
 * AGENT持久化 store
 * 负责AGENT的保存、加载、列表获取和删除
 */
export const useAgentPersistenceStore = defineStore('agentPersistence', () => {
  // State
  const currentAgent = ref<SavedAgent | null>(null)
  const isLoading = ref(false)
  const error = ref<string | null>(null)

  // Getters
  const hasCurrentAgent = computed(() => currentAgent.value !== null)

  // Actions

  /**
   * 保存AGENT
   * @param name AGENT名称
   * @param description AGENT描述
   * @param nodes 工作流节点
   * @param edges 工作流边
   * @param sourceWorkflowId 源工作流ID
   * @param sourceWorkflowVersion 源工作流版本
   * @param autoSyncEnabled 是否启用自动同步
   */
  async function saveAgent(
    name: string,
    description: string | undefined,
    nodes: WorkflowNode[],
    edges: Edge[],
    sourceWorkflowId: string,
    sourceWorkflowVersion: number,
    autoSyncEnabled: boolean = false
  ): Promise<void> {
    try {
      isLoading.value = true
      error.value = null

      // 生成唯一名称（自动处理重名）
      const uniqueName = await generateUniqueAgentName(name)

      // 生成ID（使用时间戳）
      const id = Date.now().toString()

      // 将响应式对象转换为普通对象
      const plainNodes = toSerializable(nodes)
      const plainEdges = toSerializable(edges)

      // 清理节点数据
      const sanitizedNodes = plainNodes.map((node: WorkflowNode) => ({
        ...node,
        data: sanitizeNodeData(node.data)
      }))

      // 构建Agent Card
      const agentCard: AgentCard = {
        name: uniqueName,
        description,
        version: '1.0.0',
        capabilities: {
          streaming: false,
          pushNotifications: false,
          stateTransitionHistory: false
        },
        skills: extractSkillsFromNodes(sanitizedNodes)
      }

      // 构造元数据
      const metadata: AgentMetadata = {
        id,
        name: uniqueName,
        description,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        version: 1,
        agentCard,
        sourceWorkflowId,
        sourceWorkflowVersion,
        autoSyncEnabled
      }

      // 构造 SavedAgent 对象
      const agent: SavedAgent = {
        metadata,
        nodes: sanitizedNodes,
        edges: plainEdges
      }

      // 调用 IPC 保存
      const result = await window.electronAPI.agentSave(agent)

      if (result.success) {
        currentAgent.value = agent
      } else {
        const errorMsg = result.error || '保存AGENT失败'
        error.value = errorMsg
        throw new Error(errorMsg)
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : '保存AGENT失败'
      throw err
    } finally {
      isLoading.value = false
    }
  }

  /**
   * 更新已有AGENT
   * @param id AGENT ID
   * @param name AGENT名称
   * @param description AGENT描述
   * @param nodes 工作流节点
   * @param edges 工作流边
   * @param createdAt 创建时间（保留原值）
   * @param sourceWorkflowId 源工作流ID
   * @param sourceWorkflowVersion 源工作流版本
   * @param autoSyncEnabled 是否启用自动同步
   */
  async function updateAgent(
    id: string,
    name: string,
    description: string | undefined,
    nodes: WorkflowNode[],
    edges: Edge[],
    createdAt: number,
    sourceWorkflowId: string,
    sourceWorkflowVersion: number,
    autoSyncEnabled: boolean
  ): Promise<void> {
    try {
      isLoading.value = true
      error.value = null

      // 生成唯一名称（排除自身ID，避免与自身的AGENT重名）
      const uniqueName = await generateUniqueAgentName(name, id)

      // 将响应式对象转换为普通对象
      const plainNodes = toSerializable(nodes)
      const plainEdges = toSerializable(edges)

      // 清理节点数据
      const sanitizedNodes = plainNodes.map((node: WorkflowNode) => ({
        ...node,
        data: sanitizeNodeData(node.data)
      }))

      // 构建Agent Card
      const agentCard: AgentCard = {
        name: uniqueName,
        description,
        version: '1.0.0',
        capabilities: {
          streaming: false,
          pushNotifications: false,
          stateTransitionHistory: false
        },
        skills: extractSkillsFromNodes(sanitizedNodes)
      }

      // 构造元数据，保留原ID和创建时间
      const metadata: AgentMetadata = {
        id,
        name: uniqueName,
        description,
        createdAt,
        updatedAt: Date.now(),
        version: 1,
        agentCard,
        sourceWorkflowId,
        sourceWorkflowVersion,
        autoSyncEnabled
      }

      // 构造 SavedAgent 对象
      const agent: SavedAgent = {
        metadata,
        nodes: sanitizedNodes,
        edges: plainEdges
      }

      // 调用 IPC 保存
      const result = await window.electronAPI.agentSave(agent)

      if (result.success) {
        currentAgent.value = agent
      } else {
        const errorMsg = result.error || '更新AGENT失败'
        error.value = errorMsg
        throw new Error(errorMsg)
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : '更新AGENT失败'
      throw err
    } finally {
      isLoading.value = false
    }
  }

  /**
   * 加载AGENT
   * @param id AGENT ID
   */
  async function loadAgent(id: string): Promise<SavedAgent | null> {
    try {
      isLoading.value = true
      error.value = null

      const result = await window.electronAPI.agentLoad(id)

      if (result.success && result.agent) {
        const agent: SavedAgent = result.agent
        currentAgent.value = agent
        return agent
      } else {
        const errorMsg = result.error || '加载AGENT失败'
        error.value = errorMsg
        throw new Error(errorMsg)
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : '加载AGENT失败'
      throw err
    } finally {
      isLoading.value = false
    }
  }

  /**
   * 获取AGENT列表
   */
  async function getAgentList(): Promise<AgentListItem[]> {
    try {
      isLoading.value = true
      error.value = null

      const result = await window.electronAPI.agentList()

      if (result.success) {
        return result.agents || []
      } else {
        const errorMsg = result.error || '获取AGENT列表失败'
        error.value = errorMsg
        throw new Error(errorMsg)
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : '获取AGENT列表失败'
      throw err
    } finally {
      isLoading.value = false
    }
  }

  /**
   * 删除AGENT
   * @param id AGENT ID
   */
  async function deleteAgent(id: string): Promise<void> {
    try {
      const result = await window.electronAPI.agentDelete(id)
      if (!result.success) {
        throw new Error(result.error || '删除AGENT失败')
      }
      // 如果删除的是当前AGENT，清空currentAgent
      if (currentAgent.value?.metadata.id === id) {
        currentAgent.value = null
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : '删除AGENT失败'
      throw err
    }
  }

  /**
   * 根据源工作流ID获取关联的AGENT列表
   * @param sourceWorkflowId 源工作流ID
   */
  async function getAgentsBySourceWorkflow(sourceWorkflowId: string): Promise<AgentListItem[]> {
    try {
      const allAgents = await getAgentList()
      const filtered = allAgents.filter(agent => agent.sourceWorkflowId === sourceWorkflowId)
      return filtered
    } catch (err) {
      error.value = err instanceof Error ? err.message : '获取关联AGENT失败'
      throw err
    }
  }

  /**
   * 清理节点数据，剔除函数和临时数据
   * @param data 节点数据
   */
  function sanitizeNodeData(data: any): any {
    // 剔除 onExecute 函数和 executionResult 临时执行结果
    const { onExecute, executionResult, ...rest } = data
    return rest
  }

  /**
   * 生成唯一的AGENT名称
   * 如果名称已存在，自动添加序号后缀
   * @param name 原始名称
   * @param excludeId 需要排除的AGENT ID（用于更新时排除自身）
   * @returns 唯一的名称
   */
  async function generateUniqueAgentName(name: string, excludeId?: string): Promise<string> {
    const existingList = await getAgentList()

    // 过滤掉需要排除的ID（更新时使用）
    const filteredList = excludeId
      ? existingList.filter(a => a.id !== excludeId)
      : existingList

    // 检查是否有同名
    let finalName = name
    let counter = 2
    const baseName = name

    while (filteredList.some(a => a.name === finalName)) {
      finalName = `${baseName} (${counter})`
      counter++
    }

    return finalName
  }

  /**
   * 从节点中提取技能列表
   * @param nodes 工作流节点
   */
  function extractSkillsFromNodes(nodes: WorkflowNode[]): AgentSkill[] {
    const skills: AgentSkill[] = []
    
    nodes.forEach((node, index) => {
      if (node.type === 'model') {
        skills.push({
          id: `skill-${index}`,
          name: node.data.label || '模型节点',
          description: '模型推理能力'
        })
      } else if (node.type === 'start') {
        skills.push({
          id: `skill-${index}`,
          name: '输入处理',
          description: '处理用户输入'
        })
      }
    })

    return skills
  }

  return {
    // State
    currentAgent,
    isLoading,
    error,
    // Getters
    hasCurrentAgent,
    // Actions
    saveAgent,
    updateAgent,
    loadAgent,
    getAgentList,
    deleteAgent,
    getAgentsBySourceWorkflow
  }
})
