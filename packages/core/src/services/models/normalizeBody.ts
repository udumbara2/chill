import type { ModelAdapterConfig } from '../../types/models'

/**
 * 请求体归一化：所有 handler 在发送前的统一收口
 * 应用顺序（后面的赢）：
 * 1. 剔除 unsupportedParams（模型不支持的参数）
 * 2. 合并 extraBodyParams（协议级附加参数）
 * 3. 覆盖 fixedParams（硬约束，最后应用——用户 /config 也压不过，如 kimi-k3 的 temperature=1）
 */
export function normalizeBody<T extends Record<string, any>>(body: T, adapterConfig?: ModelAdapterConfig): T {
  if (!adapterConfig) return body

  const result: Record<string, any> = { ...body }

  for (const key of adapterConfig.unsupportedParams ?? []) {
    delete result[key]
  }

  if (adapterConfig.extraBodyParams) {
    Object.assign(result, adapterConfig.extraBodyParams)
  }

  if (adapterConfig.fixedParams) {
    Object.assign(result, adapterConfig.fixedParams)
  }

  return result as T
}
