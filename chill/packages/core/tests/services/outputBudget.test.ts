import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  estimatePromptTokens,
  estimateTokensForText,
  clampOutputBudget,
  clampModelConfig,
  effectiveContextWindow,
  resolveDeclaredMaxTokens,
  admissionMargin,
  OUTPUT_BUDGET_FLOOR,
} from '../../src/services/models/outputBudget.ts'
import type { Message, MessageRole, ToolDefinition, ModelConfig } from '../../src/types/models.ts'

/**
 * 窗口准入定律（outputBudget SSOT）测试——系数与触发边界的依据见
 * 《max_tokens挤占上下文窗口-根治-实施规划.md》（2026-10-07 探针：随机 CJK 0.97 token/字、
 * 1280×853 截图 677 token、879,153 token 纯文本 + 196,608 预算 → 400）。
 */

const USER = 'user' as MessageRole
const ASSISTANT = 'assistant' as MessageRole

test('estimateTokensForText：CJK 1 字/token、ASCII 0.35/token、代理对按码点、全角入 CJK 桶', () => {
  assert.equal(estimateTokensForText('你好世界'), 4)
  assert.equal(estimateTokensForText('abcd'), 4 * 0.35)
  assert.equal(estimateTokensForText('你a你a'), 2 + 2 * 0.35)
  assert.equal(estimateTokensForText('😀'), 0.35) // 代理对 = 1 码点
  assert.equal(estimateTokensForText('！？'), 2) // 全角标点（FF00 区）
  assert.equal(estimateTokensForText(''), 0)
})

test('estimatePromptTokens：媒体块 +2000、reasoningContent/toolCalls/tools 计入、结构开销 500', () => {
  const msg = {
    role: USER,
    content: [
      { type: 'text', text: '你好' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ],
    timestamp: new Date(),
    reasoningContent: '思考',
    toolCalls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
  } as unknown as Message
  const est = estimatePromptTokens([msg])
  assert.ok(est >= 500 + 2 + 2000 + 2, `媒体/reasoning/结构开销均计入（est=${est}）`)
  const tools = [{ type: 'function', function: { name: 't', description: '工具说明', parameters: {} } }] as unknown as ToolDefinition[]
  assert.ok(estimatePromptTokens([msg], tools) > est, 'tools JSON 计入')
  const plain = estimatePromptTokens([{ role: ASSISTANT, content: 'ok', timestamp: new Date() }])
  assert.ok(plain > 500 && plain < 520, '字符串 content 正常路径 + 固定开销')
})

test('clampOutputBudget：缺失/非正透传、常态原样（字节不变）、触发收窄、地板', () => {
  assert.equal(clampOutputBudget(undefined, 1048576, 5000), undefined, '未申报 → 不添加 max_tokens')
  assert.equal(clampOutputBudget(196608, undefined, 5000), 196608, '窗口未登记 → legacy 行为')
  assert.equal(clampOutputBudget(0, 1048576, 5000), 0, '非正透传（卡数据异常维持现状）')
  assert.equal(clampOutputBudget(196608, 1048576, 5000), 196608, '常态：余量充足原样通过')

  // 探针事故形态：879,153 估算 + 196,608 申报 → 收窄到窗口−估算−余量
  assert.equal(admissionMargin(1048576), 20972, '余量 = max(8192, 2%×窗口)')
  assert.equal(clampOutputBudget(196608, 1048576, 879153), 1048576 - 879153 - 20972)

  // 差 1 token 的触发边界：恰好压线的申报原样通过
  const allowed = 1048576 - 5000 - admissionMargin(1048576)
  assert.equal(clampOutputBudget(allowed, 1048576, 5000), allowed)
  assert.equal(clampOutputBudget(allowed + 1, 1048576, 5000), allowed)

  // 地板：估算逼近窗口 → 4096；申报本小于地板时不放大
  assert.equal(clampOutputBudget(196608, 1048576, 1048576), OUTPUT_BUDGET_FLOOR)
  assert.equal(clampOutputBudget(1000, 1048576, 1048576), 1000)
})

test('effectiveContextWindow：卡面/用户覆盖优先/退化卡 50% 地板/未登记 undefined', () => {
  const deepseek = { maxContextTokens: 1048576, adapterConfig: { defaultMaxTokens: 196608 } }
  assert.equal(effectiveContextWindow(deepseek), 851968, '事故卡：1M − 192K')
  assert.equal(effectiveContextWindow(deepseek, 32768), 1048576 - 32768, '用户 /model 覆盖优先于卡面')
  assert.equal(effectiveContextWindow({ maxContextTokens: 10000 }), 10000, '无申报预算 = 全窗口')
  assert.equal(effectiveContextWindow(undefined), undefined, '窗口未登记 → undefined')
  assert.equal(effectiveContextWindow({ maxContextTokens: 0 }), undefined)
  assert.equal(
    effectiveContextWindow({ maxContextTokens: 100000, adapterConfig: { defaultMaxTokens: 90000 } }),
    50000,
    '退化卡：申报超半窗 → 50% 地板',
  )
})

test('resolveDeclaredMaxTokens：显示分子预留与压力分母同一解析（永不漂移）', () => {
  const deepseek = { adapterConfig: { defaultMaxTokens: 196608 } }
  assert.equal(resolveDeclaredMaxTokens(deepseek), 196608, '卡面缺省')
  assert.equal(resolveDeclaredMaxTokens(deepseek, 32768), 32768, '用户覆盖优先')
  assert.equal(resolveDeclaredMaxTokens(deepseek, 0), 196608, '非法覆盖（0）回退卡面')
  assert.equal(resolveDeclaredMaxTokens({}), 0, '无申报 = 0')
  assert.equal(resolveDeclaredMaxTokens(undefined), 0)
})

test('clampModelConfig：未触发返回原对象（引用恒等 → 线缆字节不变），触发返回副本且不污染原 config', () => {
  const config = { model: 'deepseek-flash', apiKey: 'k', maxTokens: 196608, temperature: 0.7 } as ModelConfig
  const small: Message[] = [{ role: USER, content: '你好', timestamp: new Date() }]
  assert.equal(clampModelConfig(config, 1048576, small, []), config, '常态：同一引用')

  const huge: Message[] = [{ role: USER, content: '字'.repeat(900000), timestamp: new Date() }]
  const clamped = clampModelConfig(config, 1048576, huge, [])
  assert.notEqual(clamped, config, '触发：新副本')
  assert.ok(clamped.maxTokens! < 196608 && clamped.maxTokens! >= OUTPUT_BUDGET_FLOOR, `收窄到合理区间（${clamped.maxTokens}）`)
  assert.equal(config.maxTokens, 196608, '原 config 不被污染')
})
