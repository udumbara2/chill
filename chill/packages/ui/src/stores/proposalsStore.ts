import { defineStore } from 'pinia'
import { ref } from 'vue'
import {
  improvementLedger,
  type ClusterSummary,
  type DecisionDigest,
  type Decision,
  type ParsedProposals,
  type ProposalEntry,
} from '@assistant-ai/core'

/**
 * 改进提案账本 store（决策闭环 · 迭代 3）
 *
 * 数据全走 core ImprovementLedger 单例（main.ts 装配 uiFsProvider + pathProvider），
 * 本 store 零文件 IO、零解析——只是 Pinia 响应式包装（药丸/设置面板共用）。
 * 决策直构 Decision[]（R2：结构化面不经 parseDecisionInput）。
 */
export const useProposalsStore = defineStore('proposals', () => {
  /** 账本摘要（药丸/统计条数据源；null=无文件或未装配） */
  const digest = ref<DecisionDigest | null>(null)
  /** 待确认簇视图（showAll=false 时为 TopN 截取） */
  const clusters = ref<ClusterSummary[]>([])
  /** 簇总数（TopN 截取后 totalClusters>clusters.length 时显示"显示全部"） */
  const totalClusters = ref(0)
  /** 四区完整数据（设置面板四区 tab） */
  const zones = ref<ParsedProposals | null>(null)
  /** 打开面板时的老化摘要（置顶提示，可关闭） */
  const agingNote = ref<string | null>(null)
  /** 首刷落定（全零判断用，防闪隐） */
  const loaded = ref(false)
  const loading = ref(false)
  const showAll = ref(false)
  const lastError = ref<string | null>(null)
  let agingDone = false

  const refresh = async (): Promise<void> => {
    if (!improvementLedger.isInitialized()) return
    loading.value = true
    try {
      const [d, z] = await Promise.all([improvementLedger.getDigest(), improvementLedger.getParsed()])
      digest.value = d
      zones.value = z
      if (z) {
        const view = await improvementLedger.getView({ topN: showAll.value ? undefined : 5 })
        clusters.value = view?.clusters ?? []
        totalClusters.value = view?.clusters.length ?? 0
      } else {
        clusters.value = []
        totalClusters.value = 0
      }
      loaded.value = true
    } catch (err: any) {
      lastError.value = String(err?.message ?? err)
    } finally {
      loading.value = false
    }
  }

  /** 打开面板：进程内首次执行老化（置顶提示，可恢复），随后刷新 */
  const open = async (): Promise<void> => {
    if (!agingDone) {
      agingDone = true
      try {
        const r = await improvementLedger.applyAging()
        agingNote.value = r.ok ? r.summary : null
      } catch {
        agingNote.value = null
      }
    }
    await refresh()
  }

  /** 应用决策（唯一写入口；成功后刷新视图与摘要） */
  const decide = async (decisions: Decision[]): Promise<boolean> => {
    if (decisions.length === 0) return true
    const res = await improvementLedger.decide(decisions)
    if (!res.ok) {
      lastError.value = res.error ?? '写入失败'
      return false
    }
    lastError.value = null
    await refresh()
    return true
  }

  /** 闪念捕获（不经模型；回执语义见 CaptureResult：duplicated=幂等成功未写入） */
  const capture = async (text: string, source: string): Promise<{ ok: boolean; duplicated?: boolean; truncated?: boolean; error?: string }> => {
    const r = await improvementLedger.capture(text, source)
    if (r.ok && !r.duplicated && r.applied > 0) await refresh()
    return r
  }

  const toggleShowAll = async (): Promise<void> => {
    showAll.value = !showAll.value
    await refresh()
  }

  /** 药丸/摘要可见性：无文件或全零时隐匿（原则：零噪音） */
  const hasContent = () => !!digest.value && (digest.value.pending > 0 || digest.value.confirmed > 0)

  const confirmedEntries = (): ProposalEntry[] => zones.value?.confirmed ?? []
  const implementedEntries = (): ProposalEntry[] => zones.value?.closed ?? []
  const discardedEntries = (): ProposalEntry[] => zones.value?.discarded ?? []

  return {
    digest, clusters, totalClusters, zones, agingNote, loaded, loading, showAll, lastError,
    refresh, open, decide, capture, toggleShowAll, hasContent,
    confirmedEntries, implementedEntries, discardedEntries,
  }
})
