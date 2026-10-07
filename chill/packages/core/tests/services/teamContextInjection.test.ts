import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BaseModelService } from '../../src/services/models/baseModelService.ts'
import { ModelServiceFactory } from '../../src/services/models/modelServiceFactory.ts'
import { modelInfoService } from '../../src/services/models/modelInfoService.ts'
import { MessageRole, ModelType, type Message, type ToolDefinition } from '../../src/types/models.ts'
import type { MCPService } from '../../src/services/mcp/mcpService.ts'

/**
 * 团队状态上下文注入(迭代 1):baseModelService.processMessageForRequest 头部 SYSTEM 注入
 * + modelServiceFactory initialize 转发。
 */

/** 暴露 protected processMessageForRequest 的测试替身 */
class TestModelService extends BaseModelService {
  public process(messages: Message[], tools?: ToolDefinition[]) {
    return this.processMessageForRequest(messages, tools)
  }
}

const mcpStub = {
  detectAndProcessMCPTools: async (messages: Message[], tools: unknown) => ({ processedMessages: messages, processedTools: tools }),
} as unknown as MCPService

function makeService(): TestModelService {
  return new TestModelService({ apiKey: 'k', baseURL: 'http://x', model: 'm' }, ModelType.CUSTOM, mcpStub)
}

function userMsg(text: string): Message {
  return { role: MessageRole.USER, content: text, timestamp: new Date() }
}

const taskStoreStub = {
  hasTasks: () => true,
  buildTaskStatusSummary: () => '任务状态摘要',
  buildCompletedTasksSummary: () => '',
}

test('getter 注入:团队行构成头部 SYSTEM 消息(无任务时单独一条)', async () => {
  const svc = makeService()
  svc.setTeamContextGetter(() => '当前没有活动团队(测试行)')
  const { processedMessages } = await svc.process([userMsg('hi')])
  assert.equal(processedMessages.length, 2)
  assert.equal(processedMessages[0].role, MessageRole.SYSTEM)
  assert.equal(processedMessages[0].content, '当前没有活动团队(测试行)')
  assert.equal(processedMessages[1].content, 'hi')
})

test('未装配 getter:不注入,消息列表原样(Worker/workflow 零变化路径)', async () => {
  const svc = makeService()
  const { processedMessages } = await svc.process([userMsg('hi')])
  assert.equal(processedMessages.length, 1)
})

test('getter 返回 null/空串:不注入', async () => {
  const svc = makeService()
  svc.setTeamContextGetter(() => null)
  const a = await svc.process([userMsg('hi')])
  assert.equal(a.processedMessages.length, 1)
  svc.setTeamContextGetter(() => '')
  const b = await svc.process([userMsg('hi')])
  assert.equal(b.processedMessages.length, 1)
})

test('与任务上下文并存:团队行作为追加段落,消息条数不新增', async () => {
  const svc = makeService()
  svc.setTaskListStoreGetter(() => taskStoreStub)
  svc.setTeamContextGetter(() => '团队「news」 · 成员 2')
  const { processedMessages } = await svc.process([userMsg('hi')])
  assert.equal(processedMessages.length, 2, '只新增一条头部 SYSTEM 消息')
  assert.equal(processedMessages[0].role, MessageRole.SYSTEM)
  assert.match(processedMessages[0].content as string, /多步骤任务/)
  assert.match(processedMessages[0].content as string, /任务状态摘要/)
  assert.match(processedMessages[0].content as string, /团队「news」 · 成员 2/)
})

test('工厂转发: initialize 的 teamContextGetter 转发到新建 service;不传则不装配', async () => {
  modelInfoService.addModelInfo({
    name: 'team-context-factory-test-model',
    provider: 'test-provider',
    adapterConfig: { protocol: 'openai-chat', baseURL: 'http://x', defaultModel: 'm' },
  } as any)
  const secureStorageStub = { getApiKey: async () => 'k' } as any
  const getter = () => '团队行'
  ModelServiceFactory.initialize(secureStorageStub, undefined, undefined, getter)
  const svc: any = await ModelServiceFactory.getInstance().createModelService(ModelType.CUSTOM, undefined, 'team-context-factory-test-model')
  assert.equal(svc.teamContextGetter, getter)
})
