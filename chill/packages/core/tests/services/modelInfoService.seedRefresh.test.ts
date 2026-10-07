import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ModelInfo, ModelParameter } from '../../src/types/models.ts'
import { refreshSeedMetadata } from '../../src/services/models/modelInfoService.ts'

const card = (over: Partial<ModelInfo>): ModelInfo =>
  ({ name: 'x', type: 'custom' as any, displayName: 'x', provider: 'p', builtIn: false, supportedModalities: [], availableModels: [], supportedParameters: [], supportsStreaming: true, supportsTools: false, supportsThinking: false, ...over }) as ModelInfo

const param = (name: string, extra: Partial<ModelParameter> = {}): ModelParameter =>
  ({ name, type: 'string' as any, description: '', required: false, ...extra })

test('refreshSeedMetadata：同名种子整体刷新 supportedParameters（物化副本拿到新声明）', () => {
  const user = card({ supportedParameters: [param('thinking'), param('temperature')] })
  const seed = card({ builtIn: true, supportedParameters: [param('reasoning_effort', { enumValues: ['low', 'high', 'max'] })] })
  refreshSeedMetadata(user, seed)
  assert.deepEqual(user.supportedParameters.map(p => p.name), ['reasoning_effort'])
  // 旧 thinking 声明随整体刷新消失（GLM-5.3 场景：弹窗不再复活退役开关）
})

test('refreshSeedMetadata：unsupportedParams 按并集合并（用户编写不被种子覆盖）', () => {
  const user = card({ adapterConfig: { protocol: 'openai-chat', baseURL: 'https://x', defaultModel: 'x', unsupportedParams: ['top_p'] } })
  const seed = card({ builtIn: true, adapterConfig: { protocol: 'openai-chat', baseURL: 'https://x', defaultModel: 'x', unsupportedParams: ['thinking'] } })
  refreshSeedMetadata(user, seed)
  assert.deepEqual([...user.adapterConfig!.unsupportedParams!].sort(), ['thinking', 'top_p'])
})

test('refreshSeedMetadata：非同名/非种子/缺省一律不动', () => {
  const user = card({ supportedParameters: [param('thinking')] })
  refreshSeedMetadata(user, undefined)
  refreshSeedMetadata(user, card({ builtIn: false })) // 同名但对方也是用户卡
  refreshSeedMetadata(card({}), card({ builtIn: true, adapterConfig: undefined }))
  assert.equal(user.supportedParameters.length, 1)
  assert.equal(user.supportedParameters[0].name, 'thinking')
})

test('refreshSeedMetadata：种子无 unsupportedParams 时不碰用户卡 adapterConfig', () => {
  const userAdapter = { protocol: 'openai-chat', baseURL: 'https://x', defaultModel: 'x' }
  const user = card({ adapterConfig: { ...userAdapter } })
  const seed = card({ builtIn: true })
  refreshSeedMetadata(user, seed)
  assert.deepEqual(user.adapterConfig, userAdapter)
})
