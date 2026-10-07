import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  buildCatalog,
  diffCatalog,
  pageHistory,
  toSyncMessage,
  HISTORY_PAGE_LIMIT,
  HISTORY_PAGE_BYTE_BUDGET,
  TOOL_RESULT_PREVIEW_CHARS,
  MEDIA_PLACEHOLDER,
  type SessionCatalog,
  type CatalogSessionMeta,
} from '../../src/services/SessionSyncService.ts'
import type { SessionRecord } from '../../src/persistence/SessionPersistence.ts'
import type { ProjectRecord } from '../../src/persistence/ProjectPersistence.ts'
import { ContentBlockType, MessageRole, ToolCallStatus, type Message } from '../../src/types/models.ts'

// ---------- 测试工具 ----------

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'session-sync-'))
}

function writeSession(dir: string, record: Partial<SessionRecord> & { id: string }): void {
  fs.writeFileSync(path.join(dir, `${record.id}.json`), JSON.stringify(record), 'utf-8')
}

function project(id: string, updatedAt = '2026-09-01T00:00:00.000Z'): ProjectRecord {
  return { id, name: `项目${id}`, createdAt: '2026-09-01T00:00:00.000Z', updatedAt, order: 1 }
}

/** 构造确定性消息序列：ts 从 base 起每条 +1s，msgKey = role:isoTs */
function makeMessages(count: number, role: MessageRole = MessageRole.USER): Message[] {
  const base = Date.parse('2026-09-10T00:00:00.000Z')
  return Array.from({ length: count }, (_, i) => ({
    role,
    content: `消息${i}`,
    timestamp: new Date(base + i * 1000).toISOString() as unknown as Date,
  }))
}

function keyOf(m: Message): string {
  return `${m.role}:${m.timestamp as unknown as string}`
}

function recordWith(messages: Message[]): SessionRecord {
  return {
    id: 's1',
    title: '测试会话',
    messages,
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
  }
}

function stubDeps(record: SessionRecord | null) {
  return { loadSession: async () => record }
}

function meta(id: string, updatedAt: string, projectId: string | null = null): CatalogSessionMeta {
  return { id, title: id, projectId, createdAt: updatedAt, updatedAt, preview: '' }
}

function catalogOf(sessions: CatalogSessionMeta[], projects: ProjectRecord[] = [], projectsRev = 'r1'): SessionCatalog {
  return { projects, sessions, activeSessionId: null, projectsRev }
}

// ---------- buildCatalog ----------

test('buildCatalog：元数据字段映射 + 按 updatedAt 降序 + activeSessionId 注入', async () => {
  const dir = tmpDir()
  try {
    writeSession(dir, {
      id: 's-old', title: '旧会话', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
      projectId: 'p1', workdir: '/tmp/w',
      messages: [{ role: 'user', content: '  首句\n预览  文本 ', timestamp: '2026-09-01T00:00:00.000Z' }],
    })
    writeSession(dir, {
      id: 's-new', title: '新会话', createdAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z',
      titleSource: 'manual', messages: [],
    })
    const catalog = await buildCatalog({
      sessionsDir: dir,
      listProjects: async () => [project('p1')],
      activeSessionId: 's-old',
    })
    assert.equal(catalog.activeSessionId, 's-old')
    assert.deepEqual(catalog.sessions.map(s => s.id), ['s-new', 's-old'])
    const old = catalog.sessions[1]!
    assert.equal(old.title, '旧会话')
    assert.equal(old.projectId, 'p1')
    assert.equal(old.workdir, '/tmp/w')
    assert.equal(old.preview, '首句 预览 文本')
    assert.equal(catalog.sessions[0]!.titleSource, 'manual')
    assert.equal(catalog.sessions[0]!.projectId, null)
    assert.ok(catalog.projectsRev)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('buildCatalog：悬空 projectId（指向不存在/已删除项目）归一化为 null', async () => {
  const dir = tmpDir()
  try {
    writeSession(dir, {
      id: 's-dangling', title: 't', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
      projectId: 'p-gone', messages: [],
    })
    const catalog = await buildCatalog({ sessionsDir: dir, listProjects: async () => [project('p1')] })
    assert.equal(catalog.sessions[0]!.projectId, null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('buildCatalog：空目录产出空目录，activeSessionId 缺省为 null', async () => {
  const dir = tmpDir()
  try {
    const catalog = await buildCatalog({ sessionsDir: dir, listProjects: async () => [] })
    assert.deepEqual(catalog.sessions, [])
    assert.deepEqual(catalog.projects, [])
    assert.equal(catalog.activeSessionId, null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- diffCatalog ----------

test('diffCatalog：known 为空/异常 → full 全量', () => {
  const catalog = catalogOf([meta('s1', '2026-09-01T00:00:00.000Z')], [project('p1')])
  for (const known of [null, undefined, {}, { sessions: 'bad' } as never]) {
    const diff = diffCatalog(known, catalog)
    assert.equal(diff.full, true)
    assert.equal(diff.upserts.sessions.length, 1)
    assert.equal(diff.upserts.projects.length, 1)
    assert.deepEqual(diff.deletes.sessions, [])
  }
})

test('diffCatalog：增量——updatedAt 变化 upsert、未变跳过、新会话 upsert、消失会话 delete', () => {
  const catalog = catalogOf([
    meta('s-changed', '2026-09-02T00:00:00.000Z'),
    meta('s-same', '2026-09-01T00:00:00.000Z'),
    meta('s-new', '2026-09-03T00:00:00.000Z'),
  ])
  const diff = diffCatalog({
    projectsRev: 'r1',
    sessions: {
      's-changed': '2026-09-01T00:00:00.000Z',
      's-same': '2026-09-01T00:00:00.000Z',
      's-deleted': '2026-09-01T00:00:00.000Z',
    },
  }, catalog)
  assert.equal(diff.full, false)
  assert.deepEqual(diff.upserts.sessions.map(s => s.id).sort(), ['s-changed', 's-new'])
  assert.deepEqual(diff.deletes.sessions, ['s-deleted'])
})

test('diffCatalog：projectsRev 一致 → projects 空；不一致 → 全量项目表', () => {
  const catalog = catalogOf([meta('s1', '2026-09-01T00:00:00.000Z')], [project('p1')], 'r2')
  const same = diffCatalog({ projectsRev: 'r2', sessions: {} }, catalog)
  assert.deepEqual(same.upserts.projects, [])
  const changed = diffCatalog({ projectsRev: 'r1', sessions: {} }, catalog)
  assert.equal(changed.upserts.projects.length, 1)
  assert.equal(changed.upserts.projects[0]!.id, 'p1')
})

// ---------- pageHistory：游标边界 ----------

test('pageHistory：会话不存在 → notFound + done', async () => {
  const page = await pageHistory(stubDeps(null), 'ghost')
  assert.equal(page.notFound, true)
  assert.equal(page.done, true)
  assert.deepEqual(page.messages, [])
})

test('pageHistory：空会话 → done 且无消息', async () => {
  const page = await pageHistory(stubDeps(recordWith([])), 's1')
  assert.equal(page.done, true)
  assert.deepEqual(page.messages, [])
  assert.equal(page.nextBefore, undefined)
})

test('pageHistory：不足一页 → 全量 + done', async () => {
  const msgs = makeMessages(5)
  const page = await pageHistory(stubDeps(recordWith(msgs)), 's1')
  assert.equal(page.messages.length, 5)
  assert.equal(page.done, true)
  assert.equal(page.nextBefore, undefined)
  assert.deepEqual(page.messages.map(m => m.msgKey), msgs.map(keyOf))
})

test('pageHistory：恰好一页 → done（无 nextBefore）', async () => {
  const msgs = makeMessages(HISTORY_PAGE_LIMIT)
  const page = await pageHistory(stubDeps(recordWith(msgs)), 's1')
  assert.equal(page.messages.length, HISTORY_PAGE_LIMIT)
  assert.equal(page.done, true)
  assert.equal(page.nextBefore, undefined)
})

test('pageHistory：翻到底——首页取最新 20 条，before 续取更早一页直至 done', async () => {
  const msgs = makeMessages(25)
  const deps = stubDeps(recordWith(msgs))
  const p1 = await pageHistory(deps, 's1')
  assert.equal(p1.messages.length, 20)
  assert.equal(p1.done, false)
  // 页内升序，首页覆盖 msgs[5..24]，nextBefore = msgs[5] 的键
  assert.deepEqual(p1.messages.map(m => m.msgKey), msgs.slice(5).map(keyOf))
  assert.equal(p1.nextBefore, keyOf(msgs[5]!))
  const p2 = await pageHistory(deps, 's1', p1.nextBefore)
  assert.equal(p2.done, true)
  assert.deepEqual(p2.messages.map(m => m.msgKey), msgs.slice(0, 5).map(keyOf))
})

test('pageHistory：before 锚点不存在（被压缩/再生抹掉）→ 回退最新一页', async () => {
  const msgs = makeMessages(25)
  const page = await pageHistory(stubDeps(recordWith(msgs)), 's1', 'user:1999-01-01T00:00:00.000Z')
  assert.equal(page.done, false)
  assert.deepEqual(page.messages.map(m => m.msgKey), msgs.slice(5).map(keyOf))
})

test('pageHistory：limit 参数封顶 HISTORY_PAGE_LIMIT，且可缩小', async () => {
  const msgs = makeMessages(30)
  const deps = stubDeps(recordWith(msgs))
  const small = await pageHistory(deps, 's1', undefined, 3)
  assert.equal(small.messages.length, 3)
  const clamped = await pageHistory(deps, 's1', undefined, 999)
  assert.equal(clamped.messages.length, HISTORY_PAGE_LIMIT)
})

// ---------- 类型映射 ----------

test('类型映射：普通 user/assistant → text 正文（reasoningContent/thinkingDurationMs 透传）', async () => {
  const msgs: Message[] = [
    { role: MessageRole.USER, content: '你好', timestamp: '2026-09-10T00:00:00.000Z' as unknown as Date },
    {
      role: MessageRole.ASSISTANT, content: '回答', timestamp: '2026-09-10T00:00:01.000Z' as unknown as Date,
      reasoningContent: '思考过程', thinkingDurationMs: 1234,
    },
  ]
  const page = await pageHistory(stubDeps(recordWith(msgs)), 's1')
  assert.equal(page.messages[0]!.kind, 'text')
  assert.equal(page.messages[0]!.text, '你好')
  assert.equal(page.messages[1]!.kind, 'text')
  assert.equal(page.messages[1]!.reasoningContent, '思考过程')
  assert.equal(page.messages[1]!.thinkingDurationMs, 1234)
})

test('类型映射：synthetic 合成消息 → notice 提示行', async () => {
  const msgs: Message[] = [
    {
      role: MessageRole.USER, content: '[后台任务] 已完成', timestamp: '2026-09-10T00:00:00.000Z' as unknown as Date,
      synthetic: 'settledNotice',
    },
  ]
  const page = await pageHistory(stubDeps(recordWith(msgs)), 's1')
  assert.equal(page.messages[0]!.kind, 'notice')
  assert.equal(page.messages[0]!.text, '[后台任务] 已完成')
})

test('类型映射：tool 消息 → 工具行精简载荷（名+状态+≤1000 字符预览），toolCallId 作 msgKey', async () => {
  const longResult = 'r'.repeat(TOOL_RESULT_PREVIEW_CHARS + 500)
  const msgs: Message[] = [
    {
      role: MessageRole.ASSISTANT, content: '', timestamp: '2026-09-10T00:00:00.000Z' as unknown as Date,
      toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
    },
    {
      role: MessageRole.TOOL, content: longResult, timestamp: '2026-09-10T00:00:01.000Z' as unknown as Date,
      toolCallId: 'call-1', toolCallStatus: ToolCallStatus.SUCCESS,
    },
  ]
  const page = await pageHistory(stubDeps(recordWith(msgs)), 's1')
  // 空正文 assistant（纯工具调用轮占位）不上线——页内只剩工具行（零载荷行源头过滤）
  const tool = page.messages.find((m) => m.kind === 'tool')!
  assert.equal(tool.kind, 'tool')
  assert.equal(tool.msgKey, 'tool:call-1')
  assert.equal(tool.toolName, 'read_file')
  assert.equal(tool.toolStatus, 'success')
  assert.equal(tool.text.length, TOOL_RESULT_PREVIEW_CHARS)
  assert.equal(tool.truncated, true)
})

test('类型映射：contentBlocks 含图/视频/音频 + role=user → media 保留用户文字（新语义）', async () => {
  const msgs: Message[] = [
    {
      role: MessageRole.USER, content: '看图', timestamp: '2026-09-10T00:00:00.000Z' as unknown as Date,
      contentBlocks: [
        { id: 'b1', type: ContentBlockType.TEXT, position: 0, content: '看图' },
        { id: 'b2', type: ContentBlockType.IMAGE, position: 1, url: 'file:///x.png' },
      ],
    },
    // tool 消息带媒体 → 占位（桌面侧媒体语义不变）
    {
      role: MessageRole.TOOL, content: '工具结果', timestamp: '2026-09-10T00:00:01.000Z' as unknown as Date, toolCallId: 'tc1',
      contentBlocks: [
        { id: 'b3', type: ContentBlockType.IMAGE, position: 0, url: 'file:///y.png' },
      ],
    },
  ]
  const page = await pageHistory(stubDeps(recordWith(msgs)), 's1')
  const userRow = page.messages.find((m) => m.role === 'user')!
  assert.equal(userRow.kind, 'media')
  assert.equal(userRow.text, '看图')  // 用户文字保留（不再是占位）
  const toolRow = page.messages.find((m) => m.role === 'tool')!
  assert.equal(toolRow.kind, 'media')
  assert.equal(toolRow.text, MEDIA_PLACEHOLDER)  // 工具媒体仍占位
})

test('类型映射：ContentPart[] 正文取 text 部分拼接', () => {
  const m: Message = {
    role: MessageRole.USER,
    content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }],
    timestamp: '2026-09-10T00:00:00.000Z' as unknown as Date,
  }
  const sm = toSyncMessage(m, [m])
  assert.equal(sm.kind, 'text')
  assert.equal(sm.text, '第一段 第二段')
})

test('类型映射（file.*）：attachmentRefs → media 行回填 refs + 保留用户文字', () => {
  const m: Message = {
    role: MessageRole.USER,
    content: [{ type: 'text', text: '看看这张图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,xxx' } }],
    timestamp: '2026-09-10T00:00:00.000Z' as unknown as Date,
    attachmentRefs: [{ ref: 'f1', name: 'photo.jpg', mime: 'image/jpeg' }],
  }
  const sm = toSyncMessage(m, [m])
  assert.equal(sm.kind, 'media')
  assert.equal(sm.text, '看看这张图')  // 用户文字保留（不再是占位）
  assert.deepEqual(sm.refs, [{ ref: 'f1', name: 'photo.jpg', mime: 'image/jpeg' }])
})

test('类型映射（file.*）：仅附件无文字 → text=占位（空串回退）', () => {
  const m: Message = {
    role: MessageRole.USER,
    content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,xxx' } }],
    timestamp: '2026-09-10T00:00:00.000Z' as unknown as Date,
    attachmentRefs: [{ ref: 'f2', name: 'photo.png', mime: 'image/png' }],
  }
  const sm = toSyncMessage(m, [m])
  assert.equal(sm.kind, 'media')
  assert.equal(sm.text, MEDIA_PLACEHOLDER)  // 无用户文字 → 占位兜底
  assert.deepEqual(sm.refs, [{ ref: 'f2', name: 'photo.png', mime: 'image/png' }])
})

test('类型映射（file.* 修正既有缺陷）：content 为 ContentPart[] 含媒体块 → media + 保留用户文字', () => {
  // 桌面 @提及 的媒体在 content 字段里——旧判据只查 contentBlocks 导致这类消息在手机上连占位都不显示
  const m: Message = {
    role: MessageRole.USER,
    content: [{ type: 'text', text: '看图' }, { type: 'video_url', video_url: { url: '2026/09/uuid.mp4' } }],
    timestamp: '2026-09-10T00:00:00.000Z' as unknown as Date,
  }
  const sm = toSyncMessage(m, [m])
  assert.equal(sm.kind, 'media')
  assert.equal(sm.text, '看图')  // 用户文字保留
  assert.equal(sm.refs, undefined, '桌面侧媒体无 refs'
  )
})

test('类型映射（file.*）：纯文本消息不受三通道判据影响（无 refs 字段产出）', () => {
  const m: Message = { role: MessageRole.USER, content: '普通消息', timestamp: '2026-09-10T00:00:00.000Z' as unknown as Date }
  const sm = toSyncMessage(m, [m])
  assert.equal(sm.kind, 'text')
  assert.equal(sm.refs, undefined)
})

// ---------- 超预算截断 ----------

test('pageHistory：单条消息超页预算 → 截断 + truncated 标注，页字节不超预算', async () => {
  const big = 'a'.repeat(100 * 1024)
  const msgs: Message[] = [
    { role: MessageRole.USER, content: '早先消息', timestamp: '2026-09-10T00:00:00.000Z' as unknown as Date },
    { role: MessageRole.ASSISTANT, content: big, timestamp: '2026-09-10T00:00:01.000Z' as unknown as Date },
  ]
  const page = await pageHistory(stubDeps(recordWith(msgs)), 's1')
  assert.equal(page.messages.length, 1)
  const sm = page.messages[0]!
  assert.equal(sm.truncated, true)
  assert.ok(new TextEncoder().encode(JSON.stringify(sm)).length <= HISTORY_PAGE_BYTE_BUDGET)
  assert.ok(sm.text.length < big.length)
})

test('pageHistory：多消息累计超页预算 → 提前截页（条数未到上限）', async () => {
  // 每条 ~8KB，4 条即超 32KB 预算
  const chunk = 'b'.repeat(8 * 1024)
  const base = Date.parse('2026-09-10T00:00:00.000Z')
  const msgs: Message[] = Array.from({ length: 10 }, (_, i) => ({
    role: MessageRole.ASSISTANT,
    content: chunk,
    timestamp: new Date(base + i * 1000).toISOString() as unknown as Date,
  }))
  const page = await pageHistory(stubDeps(recordWith(msgs)), 's1')
  assert.ok(page.messages.length < 10)
  assert.ok(page.messages.length >= 1)
  assert.equal(page.done, false)
  assert.ok(page.nextBefore)
})

// ---------- clientId 贯穿 + 零载荷 assistant 行源头过滤 ----------

test('类型映射：clientId 透传（relay 来源用户消息），无 clientId 不产出字段', () => {
  const withId: Message = {
    role: MessageRole.USER, content: '手机来的', timestamp: '2026-09-10T00:00:00.000Z' as unknown as Date,
    clientId: 'env-uuid-1',
  }
  const sm1 = toSyncMessage(withId, [withId])
  assert.equal(sm1.clientId, 'env-uuid-1')
  const without: Message = {
    role: MessageRole.USER, content: '本地的', timestamp: '2026-09-10T00:00:01.000Z' as unknown as Date,
  }
  const sm2 = toSyncMessage(without, [without])
  assert.equal(sm2.clientId, undefined)
})

test('pageHistory：零载荷 assistant 行（空正文/无思考）跳过，user 空消息不跳过', async () => {
  const base = Date.parse('2026-09-10T00:00:00.000Z')
  const at = (i: number) => new Date(base + i * 1000).toISOString() as unknown as Date
  const msgs: Message[] = [
    { role: MessageRole.USER, content: '干活的指令', timestamp: at(0) },
    // 纯工具调用轮的占位 assistant（空正文、无 reasoning）→ 应跳过
    { role: MessageRole.ASSISTANT, content: '', timestamp: at(1), toolCalls: [{ id: 'tc1', type: 'function', function: { name: 'execute_powershell', arguments: '{}' } }] },
    { role: MessageRole.TOOL, content: '工具结果', timestamp: at(2), toolCallId: 'tc1' },
    { role: MessageRole.ASSISTANT, content: '干完了', timestamp: at(3) },
    // 空 user 消息 → 不跳过（user 永不跳过）
    { role: MessageRole.USER, content: '', timestamp: at(4) },
  ]
  const page = await pageHistory(stubDeps(recordWith(msgs)), 's1')
  assert.equal(page.messages.length, 4)
  assert.deepEqual(page.messages.map((m) => m.msgKey), [keyOf(msgs[0]!), 'tool:tc1', keyOf(msgs[3]!), keyOf(msgs[4]!)])
  assert.equal(page.done, true)
})

test('pageHistory：跳过行不占条数预算（15 实 + 10 空 → 一页全收 done）', async () => {
  const base = Date.parse('2026-09-10T00:00:00.000Z')
  const msgs: Message[] = Array.from({ length: 25 }, (_, i) => {
    const timestamp = new Date(base + i * 1000).toISOString() as unknown as Date
    // 偶数位放零载荷 assistant，奇数位放实消息
    return i % 2 === 0
      ? { role: MessageRole.ASSISTANT, content: '', timestamp }
      : { role: MessageRole.USER, content: `实消息${i}`, timestamp }
  })
  const page = await pageHistory(stubDeps(recordWith(msgs)), 's1')
  assert.equal(page.messages.length, 12, '25 条里 12 条实消息（奇数位），若空行占预算则只能收 20 条且不 done')
  assert.equal(page.done, true)
})

test('pageHistory：页首是空 assistant 行时 start 照常推进——翻页到底 done（防原地死循环拉页）', async () => {
  const base = Date.parse('2026-09-10T00:00:00.000Z')
  const msgs: Message[] = [
    { role: MessageRole.ASSISTANT, content: '', timestamp: new Date(base).toISOString() as unknown as Date }, // 首条=空行
    ...Array.from({ length: 25 }, (_, i) => ({
      role: MessageRole.USER, content: `消息${i}`, timestamp: new Date(base + (i + 1) * 1000).toISOString() as unknown as Date,
    })),
  ]
  const deps = stubDeps(recordWith(msgs))
  const p1 = await pageHistory(deps, 's1')
  assert.equal(p1.done, false)
  const p2 = await pageHistory(deps, 's1', p1.nextBefore)
  // 第二页含剩余实消息；首条空 assistant 被跳过但 start 推进到 0 → done
  assert.equal(p2.done, true)
  assert.equal(p2.messages.every((m) => m.text.trim() !== ''), true)
})
