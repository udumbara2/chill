/**
 * wsKeepalive.ts — 读长连主动探活策略（纯函数，Node-free）。
 *
 * 背景（2026-10-03 根治"手机端显示桌面离线"僵尸事故）：`/box/:id` 读 WS 是纯接收向，
 * 唯一出向流量是被动 pong——网络路径静默死亡（NAT 空闲回收/公网 IP 漂移）后无来包触发
 * 应答、无 TCP 出向重传、无 close 帧，客户端永远发现不了。服务器侧 30s ping 心跳救不了
 * 这一侧（ping 过不来就无 pong 可回）。**长连接的存活证明必须是双向义务**，客户端必须
 * 主动出声。
 *
 * 策略归 core 单源（仿 nextLeaseRetryMs 先例）：常数 + 判死判定在此，定时器编排归壳
 * （CLI NodeWsTransport / electron NodeRelayTransport，ping→pong 超时判死 terminate →
 * 壳侧 onClose 单环重连；服务器 onWsAuthed 重放积压，端到端自愈）。
 * 手机端（chill-mobile）走 OkHttp 单例 pingInterval 同值同义务（30s），由约定钉住。
 *
 * 协议 ping/pong 属传输层卫生，不违反服务器"客户端帧一律忽略"（那只约束应用层 message 帧）。
 */

/** 探活 ping 周期：与服务器心跳同值（30s 双向流量，保住常见 ≥60s 的 NAT 表项） */
export const WS_KEEPALIVE_PING_INTERVAL_MS = 30_000

/** 判死阈值：连续错过 ~2 个 pong（75s）视为路径已死 */
export const WS_KEEPALIVE_STALE_MS = 75_000

export type KeepaliveAction = 'ping' | 'terminate'

/**
 * 每个探活周期调用一次：上次活跃（收到 pong）距今超过 WS_KEEPALIVE_STALE_MS → 判死
 * terminate（terminate 不发 close 帧——对端路径已死收不到；本地立即触发 close(1006)
 * 走重连）；否则 ping（附带的出向数据段同时让 OS 重传机制成为第二重探测）。
 */
export function keepaliveAction(lastAliveAt: number, now: number): KeepaliveAction {
  return now - lastAliveAt > WS_KEEPALIVE_STALE_MS ? 'terminate' : 'ping'
}
