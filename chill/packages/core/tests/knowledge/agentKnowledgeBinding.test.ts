import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeRecursive } from '../helpers/recursiveDelete.ts'
import { KnowledgeStore } from '../../src/services/knowledge/knowledgeStore.ts'
import { BuiltInToolExecutor } from '../../src/services/builtInToolExecutor.ts'
import { setAgentKnowledgeBases, clearAgentKnowledgeBases } from '../../src/services/knowledge/agentKnowledgeContext.ts'

/**
 * per-agent 知识库硬边界：越界明确报错、list 过滤、无绑定不划界。
 * 守卫路径在检索/读写前短路，无需 embedding（库名用 ASCII——本机 Node 对 CJK 目录 rmSync 有环境 bug）。
 */

function makeEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kbbind-'))
  const fsProvider: any = {
    readFile: async (p: string) => {
      try { return { success: true, data: { content: fs.readFileSync(p, 'utf-8') } } } catch { return { success: false } }
    },
    writeFile: async (p: string, content: string) => {
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, content, 'utf-8')
      return { success: true }
    },
    deleteFile: async (p: string) => { try { removeRecursive(p); return { success: true } } catch { return { success: false } } },
    listDirectory: async (p: string) => {
      try {
        const files = fs.readdirSync(p, { withFileTypes: true }).map(e => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' }))
        return { success: true, data: { files } }
      } catch { return { success: false } }
    },
    getCurrentDirectory: () => home,
    fileExists: async (p: string) => ({ success: true, data: fs.existsSync(p) }),
    getPathType: async (p: string) => ({ success: true, data: null }),
  }
  const store = KnowledgeStore.getInstance()
  store.init(fsProvider, { getUserDataPath: () => path.join(home, '.chill'), getUserHomePath: () => home } as any)
  const executor = new BuiltInToolExecutor(fsProvider, {} as any, {} as any, {} as any, home)
  return { home, store, executor, cleanup: () => removeRecursive(home) }
}

test('硬边界: 前台持有者绑定后，显式越界 kb → 明确错误（search/read/add/rebuild 同规则）', async () => {
  const { executor, store, cleanup } = makeEnv()
  await store.createKnowledgeBase('frontend-notes')
  await store.createKnowledgeBase('arch-spec')
  setAgentKnowledgeBases(['frontend-notes'])
  try {
    const s = await executor.executeAsync('search_knowledge', JSON.stringify({ query: 'q', kb: 'arch-spec' }))
    assert.equal(s.success, false)
    assert.match(String(s.error), /未绑定知识库「arch-spec」/)
    const r = await executor.executeAsync('read_knowledge', JSON.stringify({ kb: 'arch-spec', doc_id: 'd1' }))
    assert.equal(r.success, false)
    assert.match(String(r.error), /未绑定知识库/)
    const a = await executor.executeAsync('add_knowledge', JSON.stringify({ kb: 'arch-spec', content: 'x', title: 't' }))
    assert.equal(a.success, false)
    assert.match(String(a.error), /未绑定知识库/)
    const b = await executor.executeAsync('rebuild_knowledge_index', JSON.stringify({ kb: 'arch-spec' }))
    assert.equal(b.success, false)
    assert.match(String(b.error), /未绑定知识库/)
  } finally {
    clearAgentKnowledgeBases()
    cleanup()
  }
})

test('硬边界: list_knowledge_bases 只列绑定集；绑定名单内调用放行', async () => {
  const { executor, store, cleanup } = makeEnv()
  await store.createKnowledgeBase('frontend-notes')
  await store.createKnowledgeBase('arch-spec')
  setAgentKnowledgeBases(['frontend-notes'])
  try {
    const list = await executor.executeAsync('list_knowledge_bases', '{}')
    assert.equal(list.success, true)
    const content = String(list.data?.content ?? '')
    assert.ok(content.includes('frontend-notes'))
    assert.ok(!content.includes('arch-spec'), '未绑定库不应出现在列表')
    // 绑定名单内：read 越过守卫、走到业务层（文档不存在的中文错误 = 放行证据）
    const r = await executor.executeAsync('read_knowledge', JSON.stringify({ kb: 'frontend-notes', doc_id: 'nope' }))
    assert.equal(r.success, false)
    assert.match(String(r.error), /未找到文档/)
  } finally {
    clearAgentKnowledgeBases()
    cleanup()
  }
})

test('硬边界: 委派 __origin.knowledgeBases 生效；无绑定（裸主会话）不划界', async () => {
  const { executor, store, cleanup } = makeEnv()
  await store.createKnowledgeBase('frontend-notes')
  await store.createKnowledgeBase('arch-spec')
  const origin = { source: 'subagent', subagentType: 'doc-writer', knowledgeBases: ['frontend-notes'] }
  const s = await executor.executeAsync('search_knowledge', JSON.stringify({ query: 'q', kb: 'arch-spec', __origin: origin }))
  assert.equal(s.success, false)
  assert.match(String(s.error), /未绑定知识库「arch-spec」/)
  // 裸主会话（无 __origin、持有者空）→ list 全量
  const list = await executor.executeAsync('list_knowledge_bases', '{}')
  const content = String(list.data?.content ?? '')
  assert.ok(content.includes('frontend-notes') && content.includes('arch-spec'))
  cleanup()
})
