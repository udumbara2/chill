/**
 * claimGate.ts —— 定时任务跨进程触发抢占闸（M6，规划《定时任务 serve 持钟与定向路由》）。
 *
 * 问题：serve 24/7 持钟 + 用户开交互 CLI/桌面 UI → 双钟并存常态化；lastFireAt 乐观判重的
 * 窗口=整轮时长（markFired 落定后才写），同任务可能双跑整轮（token 双耗、可能注入两个会话）。
 *
 * 方案：每任务触发前独占创建 claim 文件（O_EXCL 语义经 IFileSystemProvider.createFileExclusive
 * 鸭子类型注入——跨进程原子抢占唯一胜者，不碰任务整表故不加剧 lost-update）。生命周期：
 * 触发时 acquire → markFired 落定时 release（主路径）；TTL 仅兜崩溃残留——**TTL 必须大于
 * 常态轮次时长**（初值 30min）：合法长轮次跑到第 11/29 分钟时，另一进程不得把未过期的
 * 执行误判为崩溃残留而夺取 claim（那会复现 M6 要根治的双跑）。崩溃场景损失=延迟至 TTL
 * 后重触发，at-least-once 语义保持。
 *
 * 优雅降级：宿主 fs 未实现 createFileExclusive（无该原语）→ enabled=false，一切照旧
 * （乐观判重现状）。Node-free（全部经注入）。
 */

import type { IFileSystemProvider } from '../../interfaces/IFileSystemProvider'

export const CLAIM_TTL_MS = 30 * 60 * 1000

export interface ClaimGateDeps {
  fs: IFileSystemProvider
  /** claim 文件目录（宿主装配时创建；如 ~/.chill/scheduled-claims/） */
  claimsDir: string
  /** 时钟源（测试注入；缺省 Date.now） */
  now?: () => number
  /** TTL（缺省 CLAIM_TTL_MS；须大于常态轮次时长） */
  ttlMs?: number
}

export interface ClaimGate {
  /** 是否生效（宿主缺 createFileExclusive 原语时 false——降级为无闸） */
  enabled: boolean
  /** 尝试抢占：true=获得本轮触发权；false=他进程持有（未过期）或抢占失败（fail-closed 跳过本轮） */
  acquire(taskId: string): Promise<boolean>
  /** 释放（markFired 落定时调用；不存在容忍） */
  release(taskId: string): Promise<void>
}

function claimPathOf(dir: string, taskId: string): string {
  // taskId 由此进程生成（t-<base36>-<rand>），盘上手改的非常规 id 做字符清洗防路径逃逸
  const safe = taskId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return `${dir}/${safe}.json`
}

export function createClaimGate(deps: ClaimGateDeps): ClaimGate {
  const now = deps.now ?? (() => Date.now())
  const ttlMs = deps.ttlMs ?? CLAIM_TTL_MS
  const enabled = typeof deps.fs.createFileExclusive === 'function'
  if (!enabled) {
    return {
      enabled: false,
      acquire: async () => true, // 无闸=放行（乐观判重现状），release 无操作
      release: async () => {},
    }
  }
  const fs = deps.fs
  const pathOf = (taskId: string) => claimPathOf(deps.claimsDir, taskId)

  const acquire = async (taskId: string): Promise<boolean> => {
    const p = pathOf(taskId)
    const content = JSON.stringify({ pid: typeof process !== 'undefined' ? process.pid : null, at: now() })
    const first = await fs.createFileExclusive!(p, content)
    if (!first.success) return false // 创建失败（IO/权限）→ fail-closed 跳过本轮
    if (first.data === true) return true // 抢占成功
    // 已存在（EEXIST）→ TTL 判定：读内容 at；读不了/损坏按未过期处理（宁等勿抢）
    const read = await fs.readFile(p)
    let claimedAt: number | null = null
    if (read.success && typeof read.data?.content === 'string') {
      try {
        const parsed = JSON.parse(read.data.content) as { at?: unknown }
        if (typeof parsed.at === 'number') claimedAt = parsed.at
      } catch {
        /* 损坏按未过期 */
      }
    }
    if (claimedAt === null || now() - claimedAt < ttlMs) return false
    // 过期（崩溃残留）：删除后重试一次独占创建——并发夺取者仍只有一个赢
    await fs.deleteFile(p)
    const retry = await fs.createFileExclusive!(p, JSON.stringify({ pid: typeof process !== 'undefined' ? process.pid : null, at: now() }))
    return retry.success && retry.data === true
  }

  const release = async (taskId: string): Promise<void> => {
    try {
      await fs.deleteFile(pathOf(taskId))
    } catch {
      /* 不存在=已释放 */
    }
  }

  return { enabled, acquire, release }
}
