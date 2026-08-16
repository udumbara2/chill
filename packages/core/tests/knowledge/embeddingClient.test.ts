import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { SecureStorageService } from '../../src/services/secureStorageService.ts'
import {
  EMBEDDING_BATCH_SIZE,
  EMBEDDING_KEY_PROVIDER,
  embedTexts,
  getEmbeddingApiKey,
} from '../../src/services/knowledge/embeddingClient.ts'
import { DEFAULT_KNOWLEDGE_CONFIG } from '../../src/services/knowledge/types.ts'

const config = DEFAULT_KNOWLEDGE_CONFIG.embedding

/** 内存版 ISecureStorage（同接口形状） */
function makeSecureStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    storeApiKey: async (provider: string, apiKey: string) => { map.set(provider, apiKey); return true },
    getApiKey: async (provider: string) => map.get(provider) ?? null,
    hasApiKey: async (provider: string) => map.has(provider),
    deleteApiKey: async (provider: string) => map.delete(provider),
    getAllProviders: async () => [...map.keys()],
  }
}

/** fetch 调用记录 */
interface FetchCall { url: string; body: { model: string; input: string[]; dimensions: number }; auth: string }

/** mock 全局 fetch：按 input 生成可辨识的伪向量（值 = 文本序号），记录每次调用 */
function mockFetch(calls: FetchCall[], responder?: (body: FetchCall['body']) => { status: number; payload: unknown }) {
  const g = globalThis as any
  g.__origFetch = g.fetch
  g.fetch = async (url: string, init: any) => {
    const body = JSON.parse(init.body)
    calls.push({ url, body, auth: init.headers.Authorization })
    const r = responder
      ? responder(body)
      : {
          status: 200,
          payload: { data: body.input.map((_: string, i: number) => ({ embedding: [i, i + 0.5], index: i })) },
        }
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.payload,
      text: async () => (typeof r.payload === 'string' ? r.payload : JSON.stringify(r.payload)),
    } as Response
  }
}

beforeEach(() => {
  SecureStorageService.initialize(makeSecureStorage({ [EMBEDDING_KEY_PROVIDER]: 'sk-test' }) as any)
})

afterEach(() => {
  const g = globalThis as any
  if (g.__origFetch) { g.fetch = g.__origFetch; delete g.__origFetch }
})

test('正常批量：URL/body/鉴权正确，向量按输入顺序返回', async () => {
  const calls: FetchCall[] = []
  mockFetch(calls)
  const vectors = await embedTexts(['甲', '乙', '丙'], config, 'sk-test')

  assert.equal(calls.length, 1, '3 条文本应只发 1 个请求')
  assert.equal(calls[0].url, 'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings')
  assert.equal(calls[0].auth, 'Bearer sk-test')
  assert.deepEqual(calls[0].body, { model: 'text-embedding-v4', input: ['甲', '乙', '丙'], dimensions: 1024 })
  assert.deepEqual(vectors, [[0, 0.5], [1, 1.5], [2, 2.5]])
})

test('自动分批：23 条文本分 3 批（10/10/3），结果顺序与输入一致', async () => {
  const calls: FetchCall[] = []
  mockFetch(calls)
  const texts = Array.from({ length: 23 }, (_, i) => `文本${i}`)
  const vectors = await embedTexts(texts, config, 'sk-test')

  assert.equal(calls.length, 3)
  assert.deepEqual(calls.map(c => c.body.input.length), [EMBEDDING_BATCH_SIZE, EMBEDDING_BATCH_SIZE, 3])
  assert.equal(vectors.length, 23)
  // 每批内 index 从 0 开始，拼接后第 i 条应取其在批内的序号
  for (let i = 0; i < 23; i++) assert.deepEqual(vectors[i], [i % 10, (i % 10) + 0.5])
})

test('响应乱序：按 index 回填保持输入顺序', async () => {
  const calls: FetchCall[] = []
  mockFetch(calls, body => ({
    status: 200,
    // 故意倒序返回
    payload: { data: body.input.map((_, i) => ({ embedding: [i], index: i })).reverse() },
  }))
  const vectors = await embedTexts(['a', 'b', 'c'], config, 'sk-test')
  assert.deepEqual(vectors, [[0], [1], [2]])
})

test('空输入：不发请求，返回空数组', async () => {
  const calls: FetchCall[] = []
  mockFetch(calls)
  assert.deepEqual(await embedTexts([], config, 'sk-test'), [])
  assert.equal(calls.length, 0)
})

test('HTTP 错误：报错含 status 与响应摘要', async () => {
  const calls: FetchCall[] = []
  mockFetch(calls, () => ({ status: 401, payload: '{"error":{"message":"Invalid API key"}}' }))
  await assert.rejects(
    () => embedTexts(['x'], config, 'sk-bad'),
    /HTTP 401[\s\S]*Invalid API key/
  )
})

test('网络异常：报错含 provider 与 URL', async () => {
  const g = globalThis as any
  g.__origFetch = g.fetch
  g.fetch = async () => { throw new Error('fetch failed') }
  await assert.rejects(() => embedTexts(['x'], config, 'sk-test'), /embedding 请求失败[\s\S]*fetch failed/)
})

test('key 缺失：抛出带配置指引的中文错误', async () => {
  SecureStorageService.initialize(makeSecureStorage() as any)
  await assert.rejects(
    () => getEmbeddingApiKey(),
    (e: Error) => {
      assert.match(e.message, /API key 未配置/)
      assert.match(e.message, /百炼|DashScope/, '指引应提到默认阿里百炼')
      assert.match(e.message, /knowledge-embedding/, '指引应给出 provider id')
      return true
    }
  )
})

test('key 存在：原样返回', async () => {
  assert.equal(await getEmbeddingApiKey(), 'sk-test')
})
