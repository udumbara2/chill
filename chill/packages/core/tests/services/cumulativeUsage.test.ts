import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BaseModelService } from '../../src/services/models/baseModelService.ts'
import { approxTokensForRound } from '../../src/services/models/approxTokens.ts'
import { MessageRole, ModelType, type Message, type ModelResponse, type ToolCall } from '../../src/types/models.ts'
import type { MCPService } from '../../src/services/mcp/mcpService.ts'
import { setBuiltInToolExecutor } from '../../src/services/builtInToolExecutor.ts'

// 工具循环路径访问 builtInToolExecutor 全局(autoApply 批量冲刷判定),安装关闭态 stub(同 Worker 的 stub 做法)
setBuiltInToolExecutor({ getAutoApply: () => false, getNonInteractiveMode: () => 'off' } as any)

/** 脚本化 callModelAPI 的测试替身(不经网络、不经 MCP) */
class TestModelService extends BaseModelService {
  public scripted: ModelResponse[] = []
  protected async callModelAPI(): Promise<ModelResponse> {
    const r = this.scripted.shift()
    if (!r) throw new Error('脚本响应已耗尽')
    return r
  }
}

const mcpStub = {
  detectAndProcessMCPTools: async (messages: Message[], tools: unknown) => ({ processedMessages: messages, processedTools: tools }),
} as unknown as MCPService

const registryStub = { execute: async () => ({ success: true, data: 'ok' }) } as any

function makeService(scripted: ModelResponse[]): TestModelService {
  const svc = new TestModelService({ apiKey: 'k', baseURL: 'http://x', model: 'm' }, ModelType.CUSTOM, mcpStub)
  svc.scripted = scripted
  return svc
}

function userMsg(text: string): Message {
  return { role: MessageRole.USER, content: text, timestamp: new Date() }
}

function toolCall(id: string): ToolCall {
  return { id, type: 'function', function: { name: 'read_file', arguments: '{}' } }
}

test('多轮累加:两轮实测 usage 求和;usage 保持末轮(末轮语义回归)', async () => {
  const svc = makeService([
    { content: '', toolCalls: [toolCall('c1')], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
    { content: '最终答复', usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 } },
  ])
  const r = await svc.sendChatMessage([userMsg('任务')], [], registryStub)
  assert.deepEqual(r.cumulativeUsage, { promptTokens: 30, completionTokens: 15, totalTokens: 45 })
  // 末轮语义一字不动:usage 仍是末轮值(上下文占用),contextPressure/TUI 消费方不受影响
  assert.deepEqual(r.usage, { promptTokens: 20, completionTokens: 10, totalTokens: 30 })
})

test('部分轮估值:首轮实测 + 次轮无 usage 估值 → estimated:true 单向置位', async () => {
  const svc = makeService([
    { content: '', toolCalls: [toolCall('c1')], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
    { content: '完成' }, // 无 usage(glm 系形态)
  ])
  const input = [userMsg('任务')]
  const r = await svc.sendChatMessage(input, [], registryStub)
  assert.equal(r.cumulativeUsage!.estimated, true)
  // 实测部分原样保留;估值部分为次轮完整输入的近似值,总和 > 实测部分
  assert.ok(r.cumulativeUsage!.promptTokens > 10)
  assert.ok(r.cumulativeUsage!.completionTokens > 5)
})

test('全估值:单轮无 usage → 整轮估值并标 estimated', async () => {
  const svc = makeService([{ content: '答'.repeat(20) }])
  const input = [userMsg('问'.repeat(40))]
  const r = await svc.sendChatMessage(input, [], registryStub)
  const expect = approxTokensForRound(input, { content: '答'.repeat(20) })
  assert.deepEqual(r.cumulativeUsage, { ...expect, estimated: true })
})

test('usage 全 0 视为缺失 → 估值(glm 系回 0 边界)', async () => {
  const svc = makeService([{ content: 'ok', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }])
  const r = await svc.sendChatMessage([userMsg('hi')], [], registryStub)
  assert.equal(r.cumulativeUsage!.estimated, true)
  assert.ok(r.cumulativeUsage!.totalTokens > 0)
})

test('sendSingleMessage:有 usage → 实测复制(无 estimated 标记)', async () => {
  const svc = makeService([{ content: '答', usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 } }])
  const r = await svc.sendSingleMessage([userMsg('问')])
  assert.deepEqual(r.cumulativeUsage, { promptTokens: 7, completionTokens: 3, totalTokens: 10 })
})

test('sendSingleMessage:无 usage → 估值;输出侧含 reasoningContent+toolCalls 计费载荷', async () => {
  const response: ModelResponse = {
    content: 'c'.repeat(6),
    reasoningContent: 't'.repeat(4),
    toolCalls: [toolCall('c1')],
  }
  const svc = makeService([response])
  const input = [userMsg('q'.repeat(10))]
  const r = await svc.sendSingleMessage(input)
  const expect = approxTokensForRound(input, response)
  assert.deepEqual(r.cumulativeUsage, { ...expect, estimated: true })
  // 显式验证输出侧把推理与工具参数计入了(纯 content 6 字符只会得 3)
  assert.ok(r.cumulativeUsage!.completionTokens > 3)
})

test('sendSingleMessage:usage 全 0 → 估值 estimated', async () => {
  const svc = makeService([{ content: 'ok', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }])
  const r = await svc.sendSingleMessage([userMsg('hi')])
  assert.equal(r.cumulativeUsage!.estimated, true)
})
