/**
 * 委派资源限额（P1.6：防失控闸门）
 *
 * 本质：对"登记"这一动作的准入判定——登记前说"不"，与 preflight 同点同形态
 * （不登记/无占位/无幽灵通知），不做执行中节流/排队（对齐官方拒绝语义）。
 *
 * 维度盘点：
 * - 并发上限（本模块，默认 6，Codex max_threads 参照）；
 * - 累计上限（本模块，默认 200，Claude Code 会话累计参照；进程内计数含已落地）；
 * - 委派深度（已有：结构性 = 1，Worker 永不获得编排工具，网关永不放行）；
 * - 单 agent 轮数（已有：模板 max_iterations + 委派 override）；
 * - 评审回路内部 spawn 不计入（executor 内生命周期，MAX_REVIEW_ROUNDS=2 天然封顶）。
 *
 * 配置读取走提供者注入（setDelegationQuotaProvider），壳从 configStore 读
 * delegation_max_concurrent / delegation_max_cumulative；未注入/键缺失/非法值回退默认。
 * core 零存储依赖。
 */

import { getTaskRegistry } from './taskRegistry'

/** 并发上限默认值（Codex max_threads=6 参照；官方警告勿调高） */
export const DEFAULT_DELEGATION_MAX_CONCURRENT = 6
/** 累计上限默认值（Claude Code 会话累计 200 参照；进程内计数含已落地） */
export const DEFAULT_DELEGATION_MAX_CUMULATIVE = 200

export interface DelegationQuota {
  maxConcurrent: number
  maxCumulative: number
}

export type DelegationQuotaProvider = () => Partial<DelegationQuota> | null

let quotaProvider: DelegationQuotaProvider | null = null

/** 壳注入配额提供者（CLI=configStore FileKeyValueStore；UI=IPCKeyValueStore；同两键） */
export function setDelegationQuotaProvider(provider: DelegationQuotaProvider | null): void {
  quotaProvider = provider
}

/** 读当前生效配额（提供者缺键/非法值/未注入均回退默认） */
export function getDelegationQuota(): DelegationQuota {
  let partial: Partial<DelegationQuota> | null = null
  try {
    partial = quotaProvider?.() ?? null
  } catch {
    partial = null
  }
  return {
    maxConcurrent:
      typeof partial?.maxConcurrent === 'number' && partial.maxConcurrent > 0
        ? Math.floor(partial.maxConcurrent)
        : DEFAULT_DELEGATION_MAX_CONCURRENT,
    maxCumulative:
      typeof partial?.maxCumulative === 'number' && partial.maxCumulative > 0
        ? Math.floor(partial.maxCumulative)
        : DEFAULT_DELEGATION_MAX_CUMULATIVE,
  }
}

/**
 * 限额判定（纯函数，三入口共用的单一事实源）。
 * @param stats - 当前计数：running = 并发在跑数；total = 进程内累计（含已落地）
 * @param quota - 生效配额
 * @param incoming - 本次要登记的任务数（单 task/resume = 1；batch = 成员数）
 * @returns 超限时报错文案（即模型指引）；未超限返回 null
 */
export function checkDelegationQuota(
  stats: { running: number; total: number },
  quota: DelegationQuota,
  incoming = 1
): string | null {
  if (stats.running + incoming > quota.maxConcurrent) {
    return (
      `并发委派超限：当前已有 ${stats.running} 个后台任务在跑，本次再派 ${incoming} 个将突破并发上限（${quota.maxConcurrent}）。` +
      '可等部分任务落地（query_task_status 查看）、用 /tasks cancel 或 Ctrl+K 释放额度、或用 /limits 调整上限；' +
      '请不要盲试重派——按可用额度串行分批。'
    )
  }
  if (stats.total + incoming > quota.maxCumulative) {
    return (
      `累计委派超限：进程内累计委派 ${stats.total} 次（含已落地），本次再派 ${incoming} 个将突破累计上限（${quota.maxCumulative}）。` +
      '累计计数随进程生命周期，重启进程重置；或用 /limits 调大上限。'
    )
  }
  return null
}

/** 入口便捷函数：读注册表现值 + 提供者配额，返回超限报错或 null（incoming 缺省 1） */
export function getDelegationQuotaError(incoming = 1): string | null {
  const registry = getTaskRegistry()
  return checkDelegationQuota(
    { running: registry.listRunning().length, total: registry.list().length },
    getDelegationQuota(),
    incoming
  )
}
