/**
 * 会话级 agent 知识库绑定持有者（前台直聊的硬边界依据；agentMemoryContext 同模式单例）。
 *
 * 前台直聊跑主会话，工具调用没有 __origin 归属——知识库工具的绑定守卫需要一条
 * 会话级通道知道"当前前台 agent 绑定了哪些库"。setFrontAgent 切换时登记/清空
 * （模板无 knowledge 字段持有 null = 不划界）；切回裸模型即 null。
 * 委派通道不读这里（走 __origin.knowledgeBases，网关注入、Worker 不可伪造）。
 */

let currentAgentKnowledgeBases: string[] | null = null

export function setAgentKnowledgeBases(kbs: string[] | null): void {
  currentAgentKnowledgeBases = kbs && kbs.length > 0 ? [...kbs] : null
}

export function getAgentKnowledgeBases(): string[] | null {
  return currentAgentKnowledgeBases
}

export function clearAgentKnowledgeBases(): void {
  currentAgentKnowledgeBases = null
}
