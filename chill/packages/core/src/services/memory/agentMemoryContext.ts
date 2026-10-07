/**
 * 会话级 agent 记忆目录持有者（前台直聊写路由用；writeBoundary 同模式单例）。
 *
 * 前台直聊跑主会话，工具调用没有 __origin 归属——save_memory/delete_memory 的
 * scope 路由需要一条会话级通道知道"当前前台 agent 的记忆目录"。
 * setFrontAgent 切换时登记/清空（模板无 memory 字段持有 null）；切回裸模型即 null。
 * 委派通道不读这里（走 __origin.memoryDir，网关注入、Worker 不可伪造）。
 */

let currentAgentMemoryDir: string | null = null

export function setAgentMemoryDir(dir: string | null): void {
  currentAgentMemoryDir = dir
}

export function getAgentMemoryDir(): string | null {
  return currentAgentMemoryDir
}

export function clearAgentMemoryDir(): void {
  currentAgentMemoryDir = null
}
