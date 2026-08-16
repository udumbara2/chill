import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ModelInfoService, getProviderDocUrl, getProviderEndpointTemplate } from '../../src/services/models/modelInfoService.ts'
import { SEED_PROVIDERS } from '../../src/services/models/providerManager.ts'

/**
 * 种子数据合同测试：内置卡是"代码所有"的事实，任何字段缺陷都会随启动扩散到
 * CLI/UI/委派全链路。此文件守住结构不变式；数值事实（上下文/输出上限等）
 * 由 experiGround/model-seed-probe 探测验证后在卡片内维护。
 */

const seeds = ModelInfoService.getBuiltInSeedModels()
const seedProviderNames = new Set(SEED_PROVIDERS.map(p => p.name))

test('种子卡名称唯一（重名会让磁盘自定义模型被合并视图静默遮蔽）', () => {
  const names = seeds.map(m => m.name)
  assert.equal(new Set(names).size, names.length)
})

test('每张种子卡：builtIn=true、provider 是种子供应商、名称与显示名非空', () => {
  for (const m of seeds) {
    assert.equal(m.builtIn, true, `${m.name}: builtIn 必须为 true（内置=代码所有）`)
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

test('每个种子供应商：至少一张卡、docUrl 与端点模板可派生', () => {
  for (const p of SEED_PROVIDERS) {
    const cards = seeds.filter(m => m.provider === p.name)
    assert.ok(cards.length > 0, `${p.name}: 种子供应商没有任何卡`)
    assert.ok(getProviderDocUrl(p.name), `${p.name}: getProviderDocUrl 应返回 documentation`)
    const tpl = getProviderEndpointTemplate(p.name)
    assert.ok(tpl?.baseURL?.startsWith('https://'), `${p.name}: 端点模板 baseURL 缺失`)
    assert.ok(tpl?.protocol, `${p.name}: 端点模板 protocol 缺失`)
  }
})

test('getProviderDocUrl/getProviderEndpointTemplate：未知供应商返回 undefined', () => {
  assert.equal(getProviderDocUrl('不存在的供应商'), undefined)
  assert.equal(getProviderEndpointTemplate('不存在的供应商'), undefined)
})
