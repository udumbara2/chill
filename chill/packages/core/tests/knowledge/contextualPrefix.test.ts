import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { ModelServiceFactory } from '../../src/services/models/modelServiceFactory.ts'
import { SelectedModelsService } from '../../src/services/selectedModelsService.ts'
import { embeddingText } from '../../src/services/knowledge/chunker.ts'
import { processDocument } from '../../src/services/knowledge/ingestPipeline.ts'
import { resolveActiveEnrichers, runEnrichers, DEFAULT_ENRICHERS } from '../../src/services/knowledge/enrich.ts'
import { contextualPrefixEnricher } from '../../src/services/knowledge/contextualPrefixEnricher.ts'
import { computeEnhancementsFingerprint } from '../../src/services/knowledge/knowledgeStore.ts'
import {
  DEFAULT_KNOWLEDGE_CONFIG,
  resolveChunkKind,
  type ChunkRecord,
  type DocType,
  type KnowledgeBaseConfig,
  type KnowledgeGlobalConfig,
} from '../../src/services/knowledge/types.ts'

// ==================== mock LLM（ModelServiceFactory.sendChatMessage，同 summaryLayer.test.ts 的做法） ====================

let llmCalls: string[] = []
let llmBehavior: (userContent: string) => Promise<{ content: string }> = async () => ({ content: '此块出自测试文档，讲的是 mock 定位。' })
let currentModel: string | null = 'test-model'
const origSendChatMessage = ModelServiceFactory.getInstance().sendChatMessage
const origGetCurrentModelName = SelectedModelsService.getInstance().getCurrentModelName

/** 安装 LLM mock：记录调用、按 llmBehavior 响应；currentModel 为 null 模拟未选模型 */
function installLlmMock() {
  llmCalls = []
  llmBehavior = async () => ({ content: '此块出自测试文档，讲的是 mock 定位。' })
  currentModel = 'test-model'
  ModelServiceFactory.getInstance().sendChatMessage = async (_model: string, messages: any[]) => {
    const user = String(messages[messages.length - 1]?.content ?? '')
    llmCalls.push(user)
    return llmBehavior(user)
  }
  const sel = SelectedModelsService.getInstance()
  sel.getCurrentModelName = () => currentModel
}

afterEach(() => {
  ModelServiceFactory.getInstance().sendChatMessage = origSendChatMessage
  SelectedModelsService.getInstance().getCurrentModelName = origGetCurrentModelName
})

// ==================== 测试配置（processDocument 不触存储，直接构造） ====================

function makeConfig(contextualPrefix: boolean): { config: KnowledgeGlobalConfig; kbConfig: KnowledgeBaseConfig } {
  const config = structuredClone(DEFAULT_KNOWLEDGE_CONFIG)
  config.enhancements.contextualPrefix = contextualPrefix
  const kbConfig: KnowledgeBaseConfig = {
    name: 'kb1',
    description: '',
    createdAt: '2026-08-17T00:00:00.000Z',
    embeddingModel: config.embedding.model,
    embeddingDimensions: config.embedding.dimensions,
  }
  return { config, kbConfig }
}

const NOTE_MD = [
  '# 笔记', '',
  '## 第一章', '',
  '第一章的内容，讲苹果。', '',
  '## 第二章', '',
  '第二章的内容，讲橘子。',
].join('\n')

const childrenOf = (records: ChunkRecord[]) => records.filter(c => resolveChunkKind(c) === 'child')

// ==================== embeddingText 组装 ====================

test('embeddingText：定位前缀 + 标题路径 + 正文的组装顺序，缺省逐段省略', () => {
  const base = { id: 'c', docId: 'd', parentId: 'p', charStart: 0, charEnd: 2, text: '正文' }
  assert.equal(
    embeddingText({ ...base, contextPrefix: '此块出自某文档', headingPath: 'React > Hooks' }),
    '此块出自某文档\nReact > Hooks\n正文',
    '三段齐全时：前缀在最前，标题路径居中'
  )
  assert.equal(embeddingText({ ...base, headingPath: 'React > Hooks' }), 'React > Hooks\n正文', '无前缀时保持一期行为')
  assert.equal(embeddingText({ ...base, contextPrefix: '此块出自某文档' }), '此块出自某文档\n正文')
  assert.equal(embeddingText(base), '正文', '两者皆无就是纯正文')
})

test('embeddingText 不改写 chunk：text 始终是干净正文', () => {
  const chunk: ChunkRecord = {
    id: 'c', docId: 'd', parentId: 'p', charStart: 0, charEnd: 2,
    text: '正文', contextPrefix: '此块出自某文档', headingPath: '章节',
  }
  embeddingText(chunk)
  assert.equal(chunk.text, '正文')
})

// ==================== 前缀生成 ====================

test('前缀生成（note）：每个子块一次 LLM 调用并写入 contextPrefix，text 无污染、父块不动', async () => {
  installLlmMock()
  const { config, kbConfig } = makeConfig(true)
  const result = await processDocument(NOTE_MD, 'note', 'd1', config, kbConfig)

  const children = childrenOf(result.records)
  assert.ok(children.length >= 2, '两个章节应各至少出一个子块')
  assert.equal(llmCalls.length, children.length, '每个子块一次 LLM 调用')
  for (const c of children) {
    assert.equal(c.contextPrefix, '此块出自测试文档，讲的是 mock 定位。')
    assert.ok(!c.text.includes('定位'), 'chunk.text 不混入前缀')
  }
  // 喂给模型的 user 消息带文档摘录/章节/块内容分节，章节为真实标题路径
  assert.match(llmCalls[0], /【文档摘录】/)
  assert.match(llmCalls[0], /【章节】\n笔记 > 第一章/)
  assert.match(llmCalls[0], /【块内容】\n[\s\S]*第一章的内容/)

  const parents = result.records.filter(c => resolveChunkKind(c) === 'parent')
  assert.ok(parents.every(p => p.contextPrefix === undefined), '父块不嵌向量，不加前缀')
  assert.deepEqual(result.warnings, [])

  // embedding 文本组装验证（管线外用 embeddingText 组装同一子块）
  assert.match(embeddingText(children[0]), /^此块出自测试文档，讲的是 mock 定位。\n笔记 > 第一章\n/)
})

test('前缀生成（pdf）：无标题路径的子块同样加前缀（章节节记为"（无标题）"）', async () => {
  installLlmMock()
  const { config, kbConfig } = makeConfig(true)
  const pdfText = Array.from({ length: 30 }, (_, i) => `第${i}段纯文本内容，模拟 PDF 抽取。`).join('\n\n')
  const result = await processDocument(pdfText, 'pdf', 'd2', config, kbConfig)

  const children = childrenOf(result.records)
  assert.ok(children.length >= 1)
  assert.ok(children.every(c => c.contextPrefix === '此块出自测试文档，讲的是 mock 定位。'))
  assert.match(llmCalls[0], /【章节】\n（无标题）/)
})

test('distilled：跳过增强，零 LLM 调用、无前缀', async () => {
  installLlmMock()
  const { config, kbConfig } = makeConfig(true)
  const result = await processDocument('一条沉淀知识。', 'distilled', 'd3', config, kbConfig)
  assert.equal(result.records.length, 1)
  assert.equal(result.records[0].contextPrefix, undefined)
  assert.equal(llmCalls.length, 0)
})

// ==================== 开关门控 ====================

test('开关关闭：零 LLM 调用、无前缀（门控 + enricher 自检双保险）', async () => {
  installLlmMock()
  const { config, kbConfig } = makeConfig(false)

  assert.deepEqual(resolveActiveEnrichers(config.enhancements), DEFAULT_ENRICHERS, '门控：不在启用链里')
  const result = await processDocument(NOTE_MD, 'note', 'd1', config, kbConfig)
  assert.equal(llmCalls.length, 0)
  assert.ok(result.records.every(c => c.contextPrefix === undefined))

  // 自检：直接把 enricher 塞进链里也不应调用（双保险）
  const outcome = await runEnrichers(
    { chunks: [], text: 't', docId: 'd', docType: 'note', enhancements: config.enhancements, config, kbConfig },
    [contextualPrefixEnricher]
  )
  assert.equal(llmCalls.length, 0)
  assert.deepEqual(outcome.chunks, [])
})

test('开关开启：resolveActiveEnrichers 追加定位前缀 enricher（两开关同开时摘要层在前）', () => {
  const { config } = makeConfig(true)
  const onlyPrefix = resolveActiveEnrichers(config.enhancements)
  assert.equal(onlyPrefix.length, DEFAULT_ENRICHERS.length + 1)
  assert.equal(onlyPrefix[onlyPrefix.length - 1].name, '定位前缀')

  const both = resolveActiveEnrichers({ summaryLayer: true, contextualPrefix: true })
  assert.deepEqual(both.map(e => e.name), ['摘要层', '定位前缀'])
})

// ==================== 失败降级 ====================

test('失败降级：LLM 抛错/空响应/未选模型 → 告警 + 无前缀摄入，不阻塞', async () => {
  installLlmMock()
  const { config, kbConfig } = makeConfig(true)
  // 无增强基线：同文档、开关关闭（与降级结果对比）
  const configOff = structuredClone(config)
  configOff.enhancements.contextualPrefix = false
  const baseline = await processDocument(NOTE_MD, 'note', 'd1', configOff, kbConfig)

  // LLM 抛错
  llmBehavior = async () => { throw new Error('LLM 超时') }
  const failed = await processDocument(NOTE_MD, 'note', 'd1', config, kbConfig)
  assert.equal(failed.warnings.length, 1)
  assert.match(failed.warnings[0], /定位前缀/)
  assert.match(failed.warnings[0], /LLM 超时/)
  assert.match(failed.warnings[0], /降级/)
  assert.deepEqual(failed.records, baseline.records, '降级后 records 与无增强一致')
  assert.deepEqual(failed.children, baseline.children)

  // 空响应
  llmBehavior = async () => ({ content: '  ' })
  const empty = await processDocument(NOTE_MD, 'note', 'd1', config, kbConfig)
  assert.equal(empty.warnings.length, 1)
  assert.match(empty.warnings[0], /空定位前缀/)

  // 未选模型
  currentModel = null
  const callsBefore = llmCalls.length
  const noModel = await processDocument(NOTE_MD, 'note', 'd1', config, kbConfig)
  assert.equal(noModel.warnings.length, 1)
  assert.match(noModel.warnings[0], /未选择聊天模型/)
  assert.equal(llmCalls.length, callsBefore, '未选模型时不发起调用')
})

// ==================== 快照指纹 ====================

test('快照指纹：contextualPrefix 开关翻转即变', () => {
  const off = computeEnhancementsFingerprint({ summaryLayer: false, contextualPrefix: false })
  const on = computeEnhancementsFingerprint({ summaryLayer: false, contextualPrefix: true })
  assert.notEqual(off, on)
})
