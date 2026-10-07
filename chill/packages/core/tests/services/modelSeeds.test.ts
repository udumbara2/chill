import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ModelInfoService, getProviderDocUrl, getProviderEndpointTemplate } from '../../src/services/models/modelInfoService.ts'
import { SEED_PROVIDERS } from '../../src/services/models/providerManager.ts'
import { getModelSeeds, getProviderProfiles, getProviderProfileByName } from '../../src/services/models/catalog/modelCatalog.ts'
import rawSeeds from '../../src/services/models/catalog/modelSeeds.ts'

/**
 * 种子数据合同测试：内置卡是出厂数据文件（catalog/modelSeeds.ts），任何字段缺陷
 * 都会随启动扩散到 CLI/UI/委派全链路。断言对象 = JSON 原始数据 + 折叠产物（getModelSeeds()）。
 * 此文件守住结构不变式；数值事实（上下文/输出上限等）
 * 由 experiGround/model-seed-probe 探测验证后在卡片内维护。
 */

const seeds = getModelSeeds()
const seedProviderNames = new Set(SEED_PROVIDERS.map(p => p.name))

test('getBuiltInSeedModels 与 catalog getModelSeeds 同源（消费方签名不变）', () => {
  assert.deepEqual(ModelInfoService.getBuiltInSeedModels(), seeds)
})

test('原始种子数据（modelSeeds.ts）：厂商级字段已上移，卡上不再携带', () => {
  assert.ok(rawSeeds.length > 0, 'modelSeeds.ts 不能为空')
  for (const m of rawSeeds) {
    assert.equal(m.builtIn, true, `${m.name}: builtIn 必须为 true（内置=出厂数据）`)
    const ac = m.adapterConfig as Record<string, unknown>
    for (const key of ['baseURL', 'protocol', 'extraBodyParams', 'fixedParams']) {
      assert.ok(!(key in ac), `${m.name}: 厂商级字段 ${key} 应上移 providerProfiles.ts，不在卡上`)
    }
    assert.ok(ac.defaultModel, `${m.name}: defaultModel 是模型级字段，必须保留`)
  }
})

test('种子卡名称唯一（重名会让磁盘自定义模型被合并视图静默遮蔽）', () => {
  const names = seeds.map(m => m.name)
  assert.equal(new Set(names).size, names.length)
})

test('每张种子卡：builtIn=true、provider 是种子供应商、名称与显示名非空', () => {
  for (const m of seeds) {
    assert.equal(m.builtIn, true, `${m.name}: builtIn 必须为 true（内置=出厂数据）`)
    assert.ok(m.provider, `${m.name}: provider 不能为空`)
    assert.ok(seedProviderNames.has(m.provider), `${m.name}: provider "${m.provider}" 不在 SEED_PROVIDERS 中`)
    assert.ok(m.name, 'name 不能为空')
    assert.ok(m.displayName, `${m.name}: displayName 不能为空`)
  }
})

test('每张种子卡：端点与 token 上限为合法值', () => {
  for (const m of seeds) {
    assert.ok(m.adapterConfig?.baseURL?.startsWith('https://'), `${m.name}: baseURL 必须是 https URL`)
    assert.ok(m.adapterConfig?.protocol, `${m.name}: protocol 不能为空`)
    assert.ok(Number.isInteger(m.maxContextTokens) && m.maxContextTokens > 0, `${m.name}: maxContextTokens 必须是正整数`)
    assert.ok(Number.isInteger(m.maxOutputTokens) && m.maxOutputTokens > 0, `${m.name}: maxOutputTokens 必须是正整数`)
    assert.ok(m.maxOutputTokens <= m.maxContextTokens, `${m.name}: maxOutputTokens 不能超过 maxContextTokens`)
  }
})

test('每张种子卡：availableModels 非空且包含自身名称（同族卡共享该数组）', () => {
  for (const m of seeds) {
    assert.ok(m.availableModels?.length, `${m.name}: availableModels 不能为空`)
    assert.ok(m.availableModels!.includes(m.name), `${m.name}: availableModels 必须包含自身`)
  }
})

test('每张种子卡：描述不含定价（BYO-key 产品，价格随官方调整易过期）', () => {
  const pricingMarkers = ['$', '￥', '美元', '每百万', '定价', '计费', '价格', '免费']
  for (const m of seeds) {
    const desc = m.description ?? ''
    for (const marker of pricingMarkers) {
      assert.ok(!desc.includes(marker), `${m.name}: 描述包含定价标记 "${marker}"（desc="${desc}"）`)
    }
  }
})

test('reasoning_effort 声明不变式：enumValues 必带、按强度升序（首档=最低档）、defaultValue 在枚举内', () => {
  for (const m of seeds) {
    const effort = (m.supportedParameters ?? []).find(p => p.name === 'reasoning_effort')
    if (!effort) continue
    assert.ok(Array.isArray(effort.enumValues) && effort.enumValues.length >= 2,
      `${m.name}: reasoning_effort 必须声明 enumValues（至少两档）`)
    assert.equal(new Set(effort.enumValues).size, effort.enumValues!.length, `${m.name}: enumValues 不得重复`)
    assert.ok(effort.defaultValue !== undefined && effort.enumValues!.includes(effort.defaultValue as string),
      `${m.name}: defaultValue 必须是 enumValues 之一`)
    // 升序约定：压缩降档取 enumValues[0]，各家枚举必须按已知强度排布
    const ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
    const ranks = effort.enumValues!.map(v => ORDER.indexOf(v))
    assert.ok(ranks.every(r => r >= 0), `${m.name}: enumValues 含未知档位 ${effort.enumValues}`)
    for (let i = 1; i < ranks.length; i++) {
      assert.ok(ranks[i] > ranks[i - 1], `${m.name}: enumValues 必须按强度升序（${effort.enumValues}）`)
    }
  }
})

test('剥除配置不变式：卡上声明了 unsupportedParams 就不得同名声明该参数', () => {
  for (const m of seeds) {
    const stripped = m.adapterConfig?.unsupportedParams ?? []
    for (const name of stripped) {
      const declared = (m.supportedParameters ?? []).some(p => p.name === name)
      assert.ok(!declared, `${m.name}: ${name} 已被剥除却仍出现在 supportedParameters`)
    }
  }
})

test('每个种子供应商：至少一张卡、有厂商预设、docUrl 与端点模板可派生', () => {
  for (const p of SEED_PROVIDERS) {
    const cards = seeds.filter(m => m.provider === p.name)
    assert.ok(cards.length > 0, `${p.name}: 种子供应商没有任何卡`)
    const profile = getProviderProfileByName(p.name)
    assert.ok(profile, `${p.name}: providerProfiles.ts 中缺少对应预设`)
    assert.equal(profile.id, p.id, `${p.name}: 预设 id 与 SEED_PROVIDERS 不一致`)
    assert.ok(getProviderDocUrl(p.name), `${p.name}: getProviderDocUrl 应返回 documentation`)
    const tpl = getProviderEndpointTemplate(p.name)
    assert.ok(tpl?.baseURL?.startsWith('https://'), `${p.name}: 端点模板 baseURL 缺失`)
    assert.ok(tpl?.protocol, `${p.name}: 端点模板 protocol 缺失`)
  }
})

test('厂商预设（providerProfiles.ts）：id 唯一、name 与 SEED_PROVIDERS 一一对应、字段合法', () => {
  const profiles = getProviderProfiles()
  assert.equal(new Set(profiles.map(p => p.id)).size, profiles.length, '预设 id 必须唯一')
  assert.equal(profiles.length, SEED_PROVIDERS.length, '预设数量应与种子供应商一致')
  for (const p of profiles) {
    assert.ok(p.id && p.name, `${p.id}: id/name 不能为空`)
    assert.ok(p.docUrl?.startsWith('https://'), `${p.name}: docUrl 必须是 https URL`)
    assert.ok(p.endpoint?.baseURL?.startsWith('https://'), `${p.name}: endpoint.baseURL 必须是 https URL`)
    assert.ok(p.endpoint?.protocol, `${p.name}: endpoint.protocol 不能为空`)
    // 折叠产物中的厂商级字段必须等于预设值（验证 applyProviderProfile 折叠正确性）
    for (const m of seeds.filter(s => s.provider === p.name)) {
      assert.equal(m.adapterConfig?.baseURL, p.endpoint.baseURL, `${m.name}: 卡上 baseURL 与预设不一致`)
      assert.equal(m.adapterConfig?.protocol, p.endpoint.protocol, `${m.name}: 卡上 protocol 与预设不一致`)
      if (p.constraints?.fixedParams) {
        assert.deepEqual(m.adapterConfig?.fixedParams, p.constraints.fixedParams, `${m.name}: 卡上 fixedParams 与预设不一致`)
      }
      if (p.constraints?.extraBodyParams) {
        assert.deepEqual(m.adapterConfig?.extraBodyParams, p.constraints.extraBodyParams, `${m.name}: 卡上 extraBodyParams 与预设不一致`)
      }
    }
  }
  // getProviderProfileByName 按 id 或 name 均可命中
  for (const p of profiles) {
    assert.equal(getProviderProfileByName(p.id)?.name, p.name)
    assert.equal(getProviderProfileByName(p.name)?.id, p.id)
  }
  assert.equal(getProviderProfileByName('不存在的供应商'), undefined)
})

test('getProviderDocUrl/getProviderEndpointTemplate：未知供应商返回 undefined', () => {
  assert.equal(getProviderDocUrl('不存在的供应商'), undefined)
  assert.equal(getProviderEndpointTemplate('不存在的供应商'), undefined)
})
