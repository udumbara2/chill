/**
 * Orchestrator Store
 * 管理 Subagent 模板的状态
 *
 * 说明：
 * - orchestratorStore 独立于 chatStore/agentStore，避免模式间状态干扰
 * - 后续通过 sessionStore 实现跨模式上下文共享
 */

import { defineStore, storeToRefs } from 'pinia'
import { ref, computed, watch } from 'vue'
import type { SubagentTemplate } from '@assistant-ai/core'
import { getHostAPI, tryGetHostAPI } from '../host/hostApi'
import { TemplateType } from '@assistant-ai/core'
import { useChatResourceStore } from './chatResourceStore'
import { mergeAndApplyTemplates } from '../services/agentTemplateService'

/**
 * Orchestrator Store
 * 使用 Pinia 组合式 API（defineStore + 函数式写法）
 */
export const useOrchestratorStore = defineStore('orchestrator', () => {
  // ========== 状态 ==========

  /** 模板列表（合并后的所有模板） */
  const templates = ref<SubagentTemplate[]>([])

  /** 远程模板列表 */
  const remoteTemplates = ref<SubagentTemplate[]>([])

  /** 加载状态 */
  const loading = ref(false)

  /** 错误信息 */
  const error = ref<string | null>(null)

  // ========== 计算属性 ==========

  /** 内置模板 */
  const builtinTemplates = computed(() =>
    templates.value.filter((t) => t.type === TemplateType.BUILTIN)
  )

  /** 自定义模板 */
  const customTemplates = computed(() =>
    templates.value.filter((t) => t.type === TemplateType.CUSTOM)
  )

  // ========== Action ==========

  /**
   * 加载模板（通过 IPC 从主进程获取）
   * 主进程持有 TemplateManager 并管理模板生命周期
   */
  async function loadTemplates(): Promise<void> {
    loading.value = true
    error.value = null

    try {
      const result = await getHostAPI().orchestratorGetAllTemplates()

      if (result.success) {
        // 经 agentTemplateService 合并（基础模板 + 本地项目级覆盖同名）后回写渲染进程 manager 副本
        templates.value = mergeAndApplyTemplates(result.templates || [])
      } else {
        console.warn('[orchestratorStore] 获取模板失败:', result.error)
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : '加载模板失败'
      error.value = errorMessage
      console.error('[orchestratorStore] 加载模板失败:', err)
    } finally {
      loading.value = false
    }
  }

  /**
   * 设置 RemoteAgentRegistrar 监听（监听 remoteAgents 变化自动生成模板）
   */
  function setupAgentsWatcher(): void {
    const { remoteAgents } = storeToRefs(useChatResourceStore())

    watch(
      remoteAgents,
      async (newAgents) => {
        try {
          const plainArray = JSON.parse(JSON.stringify(newAgents))
          await getHostAPI().orchestratorNotifyAgentsChanged(plainArray)
        } catch (err) {
          console.error('[orchestratorStore] 通知主进程 Agents 变化失败:', err)
        }
      },
      { deep: true, immediate: true }
    )
  }

  /**
   * 监听主进程推送的模板变化事件
   */
  function setupTemplatesListener(): void {
    if (!tryGetHostAPI()?.onTemplatesReloaded) {
      console.warn('[orchestratorStore] 宿主 API 不可用，跳过模板推送监听')
      return
    }

    getHostAPI().onTemplatesReloaded((data) => {
      if (data.remoteTemplates) {
        remoteTemplates.value = data.remoteTemplates
      }
      if (data.allTemplates) {
        // 推送载荷 allTemplates = 主进程 remote+builtin+user 合并结果；
        // 与本地项目级在 manager 外合并（项目级覆盖同名）再 setAllTemplates 回写渲染进程 manager 副本，
        // 委派指南与 ModeSelector 前台候选随之刷新（渲染进程 manager 是裸实例，不能走 setCustomTemplates）
        templates.value = mergeAndApplyTemplates(data.allTemplates)
      }
    })
  }

  return {
    // 状态
    templates,
    remoteTemplates,
    loading,
    error,
    // 计算属性
    builtinTemplates,
    customTemplates,
    // 方法
    loadTemplates,
    setupAgentsWatcher,
    setupTemplatesListener,
  }
})
