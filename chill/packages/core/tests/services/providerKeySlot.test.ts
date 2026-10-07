import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeEndpointUrl,
  resolveKeySlotId,
  listKeySlotDomains,
  providerManager,
} from '../../src/services/models/providerManager.ts'

test('normalizeEndpointUrl：同端点不同书写形态归一到同一指纹', () => {
  const base = normalizeEndpointUrl('https://api.xiaomimimo.com/v1')
  assert.equal(normalizeEndpointUrl('https://api.xiaomimimo.com/v1/'), base)
  assert.equal(normalizeEndpointUrl('https://API.XiaoMiMiMo.com/v1'), base)
  assert.equal(normalizeEndpointUrl('https://api.xiaomimimo.com:443/v1'), base)
  assert.equal(normalizeEndpointUrl('  https://api.xiaomimimo.com/v1  '), base)
  assert.notEqual(normalizeEndpointUrl('https://api.xiaomimimo.com/v1'), normalizeEndpointUrl('https://api.xiaomimimo.com/v2'))
})

test('resolveKeySlotId：模板端点（含书写差异）→ 裸 providerId（存量 Key 零迁移）', () => {
  assert.equal(resolveKeySlotId('小米MiMo', 'https://api.xiaomimimo.com/v1'), 'xiaomi')
  assert.equal(resolveKeySlotId('小米MiMo', 'https://api.xiaomimimo.com/v1/'), 'xiaomi')
  assert.equal(resolveKeySlotId('xiaomi', 'https://api.xiaomimimo.com/v1'), 'xiaomi')
  assert.equal(resolveKeySlotId('DeepSeek', 'https://api.deepseek.com'), 'deepseek')
  // baseURL 缺省 → 裸 id
  assert.equal(resolveKeySlotId('小米MiMo'), 'xiaomi')
})

test('resolveKeySlotId：内置供应商 + 非模板端点 → 独立槽位（#分隔、可读指纹）', () => {
  assert.equal(
    resolveKeySlotId('小米MiMo', 'https://token-plan-cn.xiaomimimo.com/v1'),
    'xiaomi#token-plan-cn.xiaomimimo.com/v1'
  )
  assert.equal(
    resolveKeySlotId('小米MiMo', 'https://token-plan-sgp.xiaomimimo.com/v1'),
    'xiaomi#token-plan-sgp.xiaomimimo.com/v1'
  )
  // 书写差异不影响槽位
  assert.equal(
    resolveKeySlotId('小米MiMo', 'https://token-plan-cn.xiaomimimo.com/v1/'),
    'xiaomi#token-plan-cn.xiaomimimo.com/v1'
  )
})

test('resolveKeySlotId：无模板的自定义供应商 → 恒裸 id（多模型多端点共享 Key 的现状语义不破坏）', () => {
  assert.equal(resolveKeySlotId('我的中转站', 'https://a.example.com/v1'), '我的中转站')
  assert.equal(resolveKeySlotId('我的中转站', 'https://b.example.com/v1'), '我的中转站')
  assert.equal(resolveKeySlotId('My Relay', 'https://a.example.com'), 'myrelay')
})

test('idFor/resolveId：内置供应商名不依赖 Map 初始化（SEED 静态兜底，防启动窗口期漂移）', () => {
  // 单测环境未跑 loadProviders——Map 为空，历史版本此处会 slug 成 '小米mimo' 分叉
  assert.equal(providerManager.idFor('小米MiMo'), 'xiaomi')
  assert.equal(providerManager.resolveId('阿里云百炼'), 'dashscope')
  assert.equal(providerManager.idFor('智谱AI'), 'zhipu') // 旧名映射优先级不变
})

test('listKeySlotDomains：/key set 定域语义——单域直写、多域列出、无绑定缺省模板域', () => {
  // 与 add_model 同参同槽位：token-plan 卡 → 通道域；模板卡 → 裸域
  const cards = [
    { provider: '小米MiMo', adapterConfig: { baseURL: 'https://token-plan-cn.xiaomimimo.com/v1' } },
  ]
  assert.deepEqual(listKeySlotDomains('小米MiMo', cards), ['xiaomi#token-plan-cn.xiaomimimo.com/v1'])

  const multi = [
    { provider: '智谱AI', adapterConfig: { baseURL: 'https://open.bigmodel.cn/api/paas/v4' } },
    { provider: '智谱AI', adapterConfig: { baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4' } },
  ]
  const domains = listKeySlotDomains('智谱AI', multi)
  assert.equal(domains.length, 2, '多域必须列出（调用方禁静默缺省）')
  assert.ok(domains.includes('zhipu'))
  assert.ok(domains.includes('zhipu#open.bigmodel.cn/api/coding/paas/v4'))

  // 无任何绑定 → 模板域（裸 id）缺省
  assert.deepEqual(listKeySlotDomains('DeepSeek', []), ['deepseek'])
})
