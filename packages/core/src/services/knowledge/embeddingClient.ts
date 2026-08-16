import { SecureStorageService } from '../secureStorageService'
import type { EmbeddingConfig } from './types'

/**
 * 可配置 embedding 客户端（OpenAI 兼容协议，纯 fetch 零依赖，三端同码）
 *
 * 默认服务为阿里百炼 text-embedding-v4（1024 维），用户可在 knowledge.json 换任意
 * OpenAI 兼容 embedding 服务（provider/baseURL/model/dimensions）。API key 不落盘，
 * 走 SecureStorageService（provider id `knowledge-embedding`）。
 */

/** embedding API key 在 SecureStorageService 中的 provider id */
export const EMBEDDING_KEY_PROVIDER = 'knowledge-embedding'

/** 单次请求最大文本数（超限自动分批，结果顺序与输入一致） */
export const EMBEDDING_BATCH_SIZE = 10

/** 读取 embedding API key；未配置时抛出带配置指引的中文错误（指引默认走阿里百炼 dashscope） */
export async function getEmbeddingApiKey(): Promise<string> {
  let key: string | null = null
  try {
    key = await SecureStorageService.getApiKey(EMBEDDING_KEY_PROVIDER)
  } catch {
    // SecureStorageService 未初始化等情况一并按"未配置"处理，给出指引而非裸错
    key = null
  }
  if (!key || !key.trim()) {
    throw new Error(
      '知识库 embedding 的 API key 未配置。默认使用阿里百炼（DashScope）embedding 服务，'
      + '请先到 https://bailian.console.aliyun.com/ 开通并获取 API key，'
      + '然后通过模型/密钥配置界面把 key 存入 provider 为 "knowledge-embedding" 的条目。'
      + '如改用其他 OpenAI 兼容 embedding 服务，请在 knowledge.json 中配置 provider/baseURL/model/dimensions。'
    )
  }
  return key.trim()
}

/** OpenAI 兼容 /embeddings 响应中单条结果 */
interface EmbeddingResponseItem {
  embedding: number[]
  index: number
}

/** 摘要响应体用于报错（截断，避免把超长 HTML 错误页塞进错误信息） */
function summarizeBody(text: string): string {
  const t = (text ?? '').trim().replace(/\s+/g, ' ')
  return t.length > 200 ? `${t.slice(0, 200)}…` : t
}

/** 单批请求：POST {baseURL}/embeddings，body {model, input, dimensions} */
async function embedBatch(texts: string[], config: EmbeddingConfig, apiKey: string): Promise<number[][]> {
  const url = `${config.baseURL.replace(/\/+$/, '')}/embeddings`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        input: texts,
        dimensions: config.dimensions,
      }),
    })
  } catch (e) {
    throw new Error(`embedding 请求失败（${config.provider} ${url}）：${e instanceof Error ? e.message : String(e)}`)
  }
  if (!res.ok) {
    let body = ''
    try { body = await res.text() } catch { /* 读不出响应体就算了 */ }
    throw new Error(
      `embedding 服务返回 HTTP ${res.status}（${config.provider} ${config.model}）：${summarizeBody(body) || '无响应体'}`
    )
  }
  let parsed: { data?: EmbeddingResponseItem[] }
  try {
    parsed = (await res.json()) as { data?: EmbeddingResponseItem[] }
  } catch {
    throw new Error(`embedding 服务返回了无法解析的响应（${config.provider} ${config.model}）`)
  }
  const data = parsed?.data
  if (!Array.isArray(data) || data.length !== texts.length) {
    throw new Error(
      `embedding 服务返回条数异常：请求 ${texts.length} 条，返回 ${Array.isArray(data) ? data.length : '非数组'}（${config.provider} ${config.model}）`
    )
  }
  // 按 index 排序回填，防御部分服务不按输入顺序返回
  const vectors: number[][] = new Array(texts.length)
  for (const item of data) {
    if (!Array.isArray(item?.embedding) || typeof item.index !== 'number' || item.index < 0 || item.index >= texts.length) {
      throw new Error(`embedding 服务返回格式异常（${config.provider} ${config.model}）`)
    }
    vectors[item.index] = item.embedding
  }
  return vectors
}

/**
 * 批量获取文本向量。超过 EMBEDDING_BATCH_SIZE 自动分批串行请求，
 * 返回顺序与输入 texts 一一对应。
 */
export async function embedTexts(texts: string[], config: EmbeddingConfig, apiKey: string): Promise<number[][]> {
  if (texts.length === 0) return []
  const result: number[][] = []
  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE)
    const vectors = await embedBatch(batch, config, apiKey)
    result.push(...vectors)
  }
  return result
}
