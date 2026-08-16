import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { Edge } from '@vue-flow/core'
import type { SavedWorkflow, SavedAgent, WorkflowListItem, WorkflowNode, WorkflowMetadata, NodeData, OnExecuteFunction, AgentListItem } from '@assistant-ai/core'
import { eventBus } from '@assistant-ai/core'

/**
 * 将对象转换为可序列化的普通对象
 * 用于将 Vue 响应式对象转换为可 IPC 传递的对象
 */
function toSerializable<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj))
}

/**
 * 工作流持久化 store
 * 负责工作流的保存、加载、列表获取和草稿管理
 */
export const useWorkflowPersistenceStore = defineStore('workflowPersistence', () => {
  // State
  const currentWorkflow = ref<SavedWorkflow | null>(null)
  const isLoading = ref(false)
  const error = ref<string | null>(null)

  // Getters
  const hasCurrentWorkflow = computed(() => currentWorkflow.value !== null)

  // Actions

  /**
   * 保存工作流
   * @param name 工作流名称
   * @param nodes 工作流节点
   * @param edges 工作流边
   */
  async function saveWorkflow(name: string, nodes: WorkflowNode[], edges: Edge[]): Promise<void> {
    try {
      isLoading.value = true
      error.value = null

      // 生成唯一名称（自动处理重名）
      const uniqueName = await generateUniqueWorkflowName(name)

      // 生成ID（使用时间戳）
      const id = Date.now().toString()

      // 先将响应式对象转换为普通对象，再剔除 onExecute 函数
      const plainNodes = toSerializable(nodes)
      const plainEdges = toSerializable(edges)

      const sanitizedNodes = plainNodes.map((node: WorkflowNode) => ({
        ...node,
        data: sanitizeNodeData(node.data)
      }))

      // 构造元数据
      const metadata: WorkflowMetadata = {
        id,
        name: uniqueName,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        version: 1
      }

      // 构造 SavedWorkflow 对象
      const workflow: SavedWorkflow = {
        metadata,
        nodes: sanitizedNodes,
        edges: plainEdges
      }

      // 调用 IPC 保存
      const result = await window.electronAPI.workflowSave(workflow)

      if (result.success) {
        currentWorkflow.value = workflow
      } else {
        const errorMsg = result.error || '保存工作流失败'
        error.value = errorMsg
        throw new Error(errorMsg)
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : '保存工作流失败'
      throw err
    } finally {
      isLoading.value = false
    }
  }

  /**
   * 更新已有工作流
   * @param id 工作流ID
   * @param name 工作流名称
   * @param nodes 工作流节点
   * @param edges 工作流边
   * @param createdAt 创建时间（保留原值）
   * @param currentVersion 当前版本号
   * @param agentPersistenceStore 可选的AGENT持久化store实例，用于触发AGENT自动更新
   */
  async function updateWorkflow(
    id: string,
    name: string,
    nodes: WorkflowNode[],
    edges: Edge[],
    createdAt: number,
    currentVersion: number,
    agentPersistenceStore?: {
      getAgentsBySourceWorkflow: (id: string) => Promise<AgentListItem[]>
      loadAgent: (id: string) => Promise<SavedAgent | null>
      updateAgent: (
        id: string,
        name: string,
        description: string | undefined,
        nodes: WorkflowNode[],
        edges: Edge[],
        createdAt: number,
        sourceWorkflowId: string,
        sourceWorkflowVersion: number,
        autoSyncEnabled: boolean
      ) => Promise<void>
    }
  ): Promise<void> {
    try {
      isLoading.value = true
      error.value = null

      // 生成唯一名称（排除自身ID，避免与自己的工作流重名）
      const uniqueName = await generateUniqueWorkflowName(name, id)

      // 先将响应式对象转换为普通对象，再剔除 onExecute 函数
      const plainNodes = toSerializable(nodes)
      const plainEdges = toSerializable(edges)

      const sanitizedNodes = plainNodes.map((node: WorkflowNode) => ({
        ...node,
        data: sanitizeNodeData(node.data)
      }))

      // 构造元数据，保留原ID和创建时间，版本号递增
      const metadata: WorkflowMetadata = {
        id,
        name: uniqueName,
        createdAt,
        updatedAt: Date.now(),
        version: currentVersion + 1
      }

      // 构造 SavedWorkflow 对象
      const workflow: SavedWorkflow = {
        metadata,
        nodes: sanitizedNodes,
        edges: plainEdges
      }

      // 调用 IPC 保存
      const result = await window.electronAPI.workflowSave(workflow)

      if (result.success) {
        currentWorkflow.value = workflow

        // 触发AGENT自动更新（如果提供了agentPersistenceStore）
        if (agentPersistenceStore) {
          // 使用try-catch隔离错误，确保AGENT更新失败不影响工作流保存结果
          try {
            // 异步执行AGENT更新，不阻塞工作流保存
            setTimeout(async () => {
              try {
                // 获取需要更新的AGENT列表
                const agentsToUpdate = await checkAgentUpdates(id, agentPersistenceStore)

                if (agentsToUpdate.length === 0) {
                  return
                }

                // 更新每个AGENT
                const updateResults = []
                for (const agent of agentsToUpdate) {
                  try {
                    await updateAgentFromWorkflow(
                      agent.id,
                      sanitizedNodes,
                      plainEdges,
                      metadata.version,
                      agentPersistenceStore
                    )
                    updateResults.push({ agentId: agent.id, agentName: agent.name, success: true })
                  } catch (updateErr) {
                    updateResults.push({
                      agentId: agent.id,
                      agentName: agent.name,
                      success: false,
                      error: updateErr instanceof Error ? updateErr.message : '更新失败'
                    })
                  }
                }

                // 发送AGENT更新完成事件
                eventBus.emit('agent-update-completed', {
                  workflowId: id,
                  workflowName: uniqueName,
                  results: updateResults
                })
              } catch (err) {
                console.error('AGENT自动更新过程出错:', err)
                eventBus.emit('agent-update-completed', {
                  workflowId: id,
                  workflowName: uniqueName,
                  results: [],
                  error: err instanceof Error ? err.message : '更新过程出错'
                })
              }
            }, 0)
          } catch (err) {
            // 捕获同步错误（如setTimeout失败等极端情况）
            console.error('启动AGENT自动更新失败:', err)
          }
        }
      } else {
        const errorMsg = result.error || '更新工作流失败'
        error.value = errorMsg
        throw new Error(errorMsg)
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : '更新工作流失败'
      throw err
    } finally {
      isLoading.value = false
    }
  }

  /**
   * 检查需要更新的AGENT列表
   * @param sourceWorkflowId 源工作流ID
   * @param agentPersistenceStore AGENT持久化store实例
   * @returns 需要自动同步的AGENT列表
   */
  async function checkAgentUpdates(
    sourceWorkflowId: string,
    agentPersistenceStore: { getAgentsBySourceWorkflow: (id: string) => Promise<AgentListItem[]> }
  ): Promise<AgentListItem[]> {
    try {
      // 获取关联的AGENT列表
      const agents = await agentPersistenceStore.getAgentsBySourceWorkflow(sourceWorkflowId)
      
      // 过滤出启用了自动同步的AGENT
      const filtered = agents.filter(agent => agent.autoSyncEnabled)
      return filtered
    } catch (err) {
      console.error('检查AGENT更新失败:', err)
      return []
    }
  }

  /**
   * 从工作流更新AGENT
   * @param agentId AGENT ID
   * @param nodes 新的工作流节点
   * @param edges 新的工作流边
   * @param sourceWorkflowVersion 新的工作流版本
   * @param agentPersistenceStore AGENT持久化store实例
   */
  async function updateAgentFromWorkflow(
    agentId: string,
    nodes: WorkflowNode[],
    edges: Edge[],
    sourceWorkflowVersion: number,
    agentPersistenceStore: {
      loadAgent: (id: string) => Promise<SavedAgent | null>
      updateAgent: (
        id: string,
        name: string,
        description: string | undefined,
        nodes: WorkflowNode[],
        edges: Edge[],
        createdAt: number,
        sourceWorkflowId: string,
        sourceWorkflowVersion: number,
        autoSyncEnabled: boolean
      ) => Promise<void>
    }
  ): Promise<void> {
    try {
      // 加载AGENT完整数据
      const agent = await agentPersistenceStore.loadAgent(agentId)
      if (!agent) {
        throw new Error(`AGENT ${agentId} 不存在`)
      }

      const { metadata } = agent

      // 调用updateAgent同步工作流数据，保留AGENT原有属性
      await agentPersistenceStore.updateAgent(
        agentId,
        metadata.name,              // 保留原有名称
        metadata.description,       // 保留原有描述
        nodes,                      // 更新为新的工作流节点
        edges,                      // 更新为新的工作流边
        metadata.createdAt,         // 保留原有创建时间
        metadata.sourceWorkflowId,  // 保留源工作流ID
        sourceWorkflowVersion,      // 更新为新的工作流版本
        metadata.autoSyncEnabled    // 保留同步设置
      )
    } catch (err) {
      console.error(`更新AGENT ${agentId} 失败:`, err)
      throw err
    }
  }

  /**
   * 清理节点数据，剔除函数和临时数据
   * @param data 节点数据
   */
  function sanitizeNodeData(data: NodeData): NodeData {
    // 剔除 onExecute 函数和 executionResult 临时执行结果
    const { onExecute, executionResult, ...rest } = data as any
    return rest as NodeData
  }

  /**
   * 生成唯一的工作流名称
   * 如果名称已存在，自动添加序号后缀
   * @param name 原始名称
   * @param excludeId 需要排除的工作流ID（用于更新时排除自身）
   * @returns 唯一的名称
   */
  async function generateUniqueWorkflowName(name: string, excludeId?: string): Promise<string> {
    const existingList = await getWorkflowList()

    // 过滤掉需要排除的ID（更新时使用）
    const filteredList = excludeId
      ? existingList.filter(w => w.id !== excludeId)
      : existingList

    // 检查是否有同名
    let finalName = name
    let counter = 2
    const baseName = name

    // 提取基础名称（去掉已有的序号后缀）
    const match = name.match(/^(.+)\s*\((\d+)\)$/)
    if (match) {
      // 如果名称已经是 "名称 (数字)" 格式，使用括号前的部分作为基础名称
      // 但保留原始名称作为起点
    }

    while (filteredList.some(w => w.name === finalName)) {
      finalName = `${baseName} (${counter})`
      counter++
    }

    return finalName
  }

  /**
   * 加载工作流
   * @param id 工作流ID
   * @param onExecute 可选的 onExecute 函数，用于为 model 节点重新绑定执行函数
   */
  async function loadWorkflow(id: string, onExecute?: OnExecuteFunction): Promise<SavedWorkflow | null> {
    try {
      isLoading.value = true
      error.value = null

      const result = await window.electronAPI.workflowLoad(id)

      if (result.success && result.workflow) {
        let workflow: SavedWorkflow = result.workflow

        // 如果提供了 onExecute 函数，为 model 节点重新绑定
        if (onExecute) {
          const restoredNodes = workflow.nodes.map(node => {
            if (node.type === 'model') {
              return {
                ...node,
                data: {
                  ...node.data,
                  onExecute
                }
              }
            }
            return node
          })
          workflow = {
            ...workflow,
            nodes: restoredNodes
          }
        }

        currentWorkflow.value = workflow
        return workflow
      } else {
        const errorMsg = result.error || '加载工作流失败'
        error.value = errorMsg
        throw new Error(errorMsg)
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : '加载工作流失败'
      throw err
    } finally {
      isLoading.value = false
    }
  }

  /**
   * 获取工作流列表
   */
  async function getWorkflowList(): Promise<WorkflowListItem[]> {
    try {
      isLoading.value = true
      error.value = null

      const result = await window.electronAPI.workflowList()

      if (result.success) {
        return result.workflows || []
      } else {
        const errorMsg = result.error || '获取工作流列表失败'
        error.value = errorMsg
        throw new Error(errorMsg)
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : '获取工作流列表失败'
      throw err
    } finally {
      isLoading.value = false
    }
  }

  /**
   * 删除工作流
   * @param id 工作流ID
   */
  async function deleteWorkflow(id: string): Promise<void> {
    try {
      const result = await window.electronAPI.workflowDelete(id)
      if (!result.success) {
        throw new Error(result.error || '删除工作流失败')
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : '删除工作流失败'
      throw err
    }
  }

  /**
   * 保存草稿
   * @param nodes 工作流节点
   * @param edges 工作流边
   */
  async function saveDraft(nodes: WorkflowNode[], edges: Edge[]): Promise<void> {
    try {
      // 先将响应式对象转换为普通对象，再剔除 onExecute 函数
      const plainNodes = toSerializable(nodes)
      const plainEdges = toSerializable(edges)

      const sanitizedNodes = plainNodes.map((node: WorkflowNode) => ({
        ...node,
        data: sanitizeNodeData(node.data)
      }))

      // 构造草稿对象（不包含元数据，草稿不需要ID和名称）
      const draft = {
        nodes: sanitizedNodes,
        edges: plainEdges,
        savedAt: Date.now()
      }

      // 调用 IPC 保存草稿
      const result = await window.electronAPI.draftSave(draft)

      if (!result.success) {
        console.error('保存草稿失败:', result.error)
      }
    } catch (err) {
      console.error('保存草稿失败:', err)
    }
  }

  /**
   * 加载草稿
   * @param onExecute 可选的 onExecute 函数，用于为 model 节点重新绑定执行函数
   */
  async function loadDraft(onExecute?: OnExecuteFunction): Promise<{ nodes: WorkflowNode[]; edges: Edge[] } | null> {
    try {
      const result = await window.electronAPI.draftLoad()

      if (result.success && result.draft) {
        let { nodes, edges } = result.draft

        // 如果提供了 onExecute 函数，为 model 节点重新绑定
        if (onExecute) {
          nodes = nodes.map((node: WorkflowNode) => {
            if (node.type === 'model') {
              return {
                ...node,
                data: {
                  ...node.data,
                  onExecute
                }
              }
            }
            return node
          })
        }

        return { nodes, edges }
      }
      return null
    } catch (err) {
      console.error('加载草稿失败:', err)
      return null
    }
  }

  /**
   * 检查是否有草稿
   */
  async function hasDraft(): Promise<boolean> {
    try {
      const result = await window.electronAPI.draftExists()
      return result.success && result.exists === true
    } catch (err) {
      console.error('检查草稿失败:', err)
      return false
    }
  }

  /**
   * 清除草稿
   */
  async function clearDraft(): Promise<void> {
    try {
      await window.electronAPI.draftClear()
    } catch (err) {
      console.error('清除草稿失败:', err)
    }
  }

  /**
   * 导出工作流
   * @param id 工作流ID
   * @param filePath 导出文件路径
   */
  async function exportWorkflow(id: string, filePath: string): Promise<void> {
    try {
      isLoading.value = true
      error.value = null

      const result = await window.electronAPI.workflowExport(id, filePath)

      if (!result.success) {
        const errorMsg = result.error || '导出工作流失败'
        error.value = errorMsg
        throw new Error(errorMsg)
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : '导出工作流失败'
      throw err
    } finally {
      isLoading.value = false
    }
  }

  /**
   * 导入工作流
   * @param filePath 导入文件路径
   * @returns 导入的工作流列表项
   */
  async function importWorkflow(filePath: string): Promise<WorkflowListItem> {
    try {
      isLoading.value = true
      error.value = null

      const result = await window.electronAPI.workflowImport(filePath)

      if (result.success && result.workflow) {
        return result.workflow
      } else {
        const errorMsg = result.error || '导入工作流失败'
        error.value = errorMsg
        throw new Error(errorMsg)
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : '导入工作流失败'
      throw err
    } finally {
      isLoading.value = false
    }
  }

  /**
   * 重命名工作流
   * @param id 工作流ID
   * @param newName 新名称
   */
  async function renameWorkflow(id: string, newName: string): Promise<void> {
    try {
      isLoading.value = true
      error.value = null

      // 先加载工作流获取现有数据
      const workflow = await loadWorkflow(id)
      if (!workflow) {
        throw new Error('工作流不存在')
      }

      // 复用 updateWorkflow 保存（保留原节点和边，只更新名称）
      await updateWorkflow(
        id,
        newName,
        workflow.nodes,
        workflow.edges,
        workflow.metadata.createdAt,
        workflow.metadata.version
      )
    } catch (err) {
      error.value = err instanceof Error ? err.message : '重命名工作流失败'
      throw err
    } finally {
      isLoading.value = false
    }
  }

  return {
    // State
    currentWorkflow,
    isLoading,
    error,
    // Getters
    hasCurrentWorkflow,
    // Actions
    saveWorkflow,
    updateWorkflow,
    loadWorkflow,
    getWorkflowList,
    deleteWorkflow,
    saveDraft,
    loadDraft,
    hasDraft,
    clearDraft,
    exportWorkflow,
    importWorkflow,
    renameWorkflow
  }
})
