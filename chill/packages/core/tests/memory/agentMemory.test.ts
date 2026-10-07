import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryStore, memoryStore } from '../../src/services/memory/memoryStore.ts'
import { setAgentMemoryDir, clearAgentMemoryDir } from '../../src/services/memory/agentMemoryContext.ts'
import { parseTemplate } from '../../src/orchestrator/parsers/TemplateParser.ts'
import { BuiltInToolExecutor } from '../../src/services/builtInToolExecutor.ts'

/** 内联 Node fsProvider（同目录其他测试形状） */
function makeFsProvider() {
  return {
    readFile: async (p: string) => {
      try { return { success: true, data: { content: fs.readFileSync(p, 'utf-8') } } } catch { return { success: false } }
    },
    writeFile: async (p: string, content: string) => {
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, content, 'utf-8')
      return { success: true }
    },
    deleteFile: async (p: string) => { try { fs.unlinkSync(p); return { success: true } } catch { return { success: false } } },
    listDirectory: async (p: string) => {
      try {
        const files = fs.readdirSync(p, { withFileTypes: true }).map(e => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' }))
        return { success: true, data: { files } }
      } catch { return { success: false } }
    },
    getCurrentDirectory: () => null,
    fileExists: async (p: string) => ({ success: true, data: fs.existsSync(p) }),
    getPathType: async (p: string) => ({ success: true, data: fs.existsSync(p) ? (fs.statSync(p).isDirectory() ? 'directory' : 'file') : null }),
  } as any
}

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmem-'))
  memoryStore.init(makeFsProvider(), { getUserDataPath: () => path.join(home, '.chill'), getUserHomePath: () => home } as any)
  return { home, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) }
}

/** 轻量构造执行器（四个依赖打桩；save_memory/delete_memory 不触达） */
function makeExecutor(): BuiltInToolExecutor {
  return new BuiltInToolExecutor(makeFsProvider(), {} as any, {} as any, {} as any, os.tmpdir())
}

const saveArgs = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'user', title: '测试记忆', content: '正文', ...extra })

// ==================== 模板解析：memory 字段 ====================

test('parser: memory 三合法值落入模板对象', () => {
  for (const scope of ['user', 'project', 'local']) {
    const r = parseTemplate(`---\nname: t\nsubagent_type: doc-writer\nmemory: ${scope}\n---\n正文`, 'm.md')
    assert.equal(r.success, true)
    assert.equal(r.template?.memory, scope)
  }
})

test('parser: 非法 memory 值报明确错误', () => {
  const r = parseTemplate('---\nname: t\nsubagent_type: doc-writer\nmemory: global\n---\n正文', 'm.md')
  assert.equal(r.success, false)
  assert.match(r.error!, /无效的 memory 值 "global"/)
})

test('parser: 不写 memory 字段 → undefined（向后兼容）', () => {
  const r = parseTemplate('---\nname: t\nsubagent_type: doc-writer\n---\n正文', 'm.md')
  assert.equal(r.success, true)
  assert.equal(r.template?.memory, undefined)
})

// ==================== resolveAgentMemoryDir：三作用域 ====================

test('resolve: user 作用域 → 用户数据目录', async () => {
  const { home, cleanup } = makeHome()
  const dir = await memoryStore.resolveAgentMemoryDir('user', 'doc-writer', undefined)
  assert.equal(dir, path.join(home, '.chill', 'agent-memory', 'doc-writer'))
  cleanup()
})

test('resolve: project 作用域向上递归定位 .agents 根', async () => {
  const { home, cleanup } = makeHome()
  const root = path.join(home, 'proj')
  fs.mkdirSync(path.join(root, '.agents', 'agents'), { recursive: true })
  const nested = path.join(root, 'src', 'deep')
  fs.mkdirSync(nested, { recursive: true })
  const dir = await memoryStore.resolveAgentMemoryDir('project', 'doc-writer', nested)
  assert.equal(dir, path.join(root, '.agents', 'agent-memory', 'doc-writer'))
  cleanup()
})

test('resolve: project 作用域找不到 .agents 根 → 回退 workDir 本身（fileExists 全否打桩，隔离宿主真实目录树）', async () => {
  const { home, cleanup } = makeHome()
  // 打桩：任何 .agents 都不存在 → findAgentsRoot 返回 null → 回退 workDir 本身
  const stub = makeFsProvider()
  stub.fileExists = async () => ({ success: true, data: false })
  memoryStore.init(stub, { getUserDataPath: () => path.join(home, '.chill'), getUserHomePath: () => home } as any)
  const workDir = path.join(home, 'nowhere')
  const dir = await memoryStore.resolveAgentMemoryDir('project', 'doc-writer', workDir)
  assert.equal(dir, path.join(workDir, '.agents', 'agent-memory', 'doc-writer'))
  cleanup()
})

test('resolve: 最近的 .agents 根优先（嵌套两级，深者胜出）', async () => {
  const { home, cleanup } = makeHome()
  const root = path.join(home, 'proj')
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true })
  const deep = path.join(root, 'sub')
  fs.mkdirSync(path.join(deep, '.agents'), { recursive: true })
  const dir = await memoryStore.resolveAgentMemoryDir('project', 'doc-writer', path.join(deep, 'src'))
  assert.equal(dir, path.join(deep, '.agents', 'agent-memory', 'doc-writer'))
  cleanup()
})

test('resolve: local 作用域目录名为 agent-memory-local；workDir 缺省回退 user', async () => {
  const { home, cleanup } = makeHome()
  const workDir = path.join(home, 'p2')
  fs.mkdirSync(path.join(workDir, '.agents'), { recursive: true })
  const dirLocal = await memoryStore.resolveAgentMemoryDir('local', 'doc-writer', workDir)
  assert.equal(dirLocal, path.join(workDir, '.agents', 'agent-memory-local', 'doc-writer'))
  const dirFallback = await memoryStore.resolveAgentMemoryDir('project', 'doc-writer', undefined)
  assert.equal(dirFallback, path.join(home, '.chill', 'agent-memory', 'doc-writer'))
  cleanup()
})

// ==================== scoped store 隔离 ====================

test('scoped store：两个 agent 互不可见，全局不受影响', async () => {
  const { home, cleanup } = makeHome()
  const dirA = path.join(home, '.chill', 'agent-memory', 'agent-a')
  const dirB = path.join(home, '.chill', 'agent-memory', 'agent-b')
  const storeA = MemoryStore.getScoped(dirA)
  const storeB = MemoryStore.getScoped(dirB)
  await storeA.save({ type: 'user', title: 'A 的记忆', content: 'a' })
  await memoryStore.save({ type: 'user', title: '全局记忆', content: 'g' })

  assert.deepEqual((await storeA.list()).map(e => e.name), ['A 的记忆'])
  assert.equal((await storeB.list()).length, 0, 'B 空间应为空')
  assert.deepEqual((await memoryStore.list()).map(e => e.name), ['全局记忆'], '全局不应含 A 的记忆')
  assert.ok(fs.existsSync(path.join(dirA, 'MEMORY.md')), 'A 空间索引已生成')
  cleanup()
})

// ==================== save_memory / delete_memory 路由 ====================

test('路由: 委派 origin 带 memoryDir + 缺省 scope → 写入 agent 私域', async () => {
  const { home, cleanup } = makeHome()
  const executor = makeExecutor()
  const memoryDir = path.join(home, '.chill', 'agent-memory', 'doc-writer')
  const r = await executor.executeAsync('save_memory', saveArgs({ __origin: { source: 'subagent', subagentType: 'doc-writer', memoryDir } }))
  assert.equal(r.success, true)
  assert.match(String(r.data?.content ?? ''), /agent 专属/)
  assert.deepEqual((await MemoryStore.getScoped(memoryDir).list()).map(e => e.name), ['测试记忆'])
  assert.equal((await memoryStore.list()).length, 0, '全局不应被写入')
  cleanup()
})

test('路由: scope: global 显式指定 → 写入全局（即使在 agent 上下文）', async () => {
  const { home, cleanup } = makeHome()
  const executor = makeExecutor()
  const memoryDir = path.join(home, '.chill', 'agent-memory', 'doc-writer')
  const r = await executor.executeAsync('save_memory', saveArgs({ scope: 'global', __origin: { source: 'subagent', subagentType: 'doc-writer', memoryDir } }))
  assert.equal(r.success, true)
  assert.deepEqual((await memoryStore.list()).map(e => e.name), ['测试记忆'])
  assert.equal((await MemoryStore.getScoped(memoryDir).list()).length, 0)
  cleanup()
})

test('路由: 前台持有值 + 缺省 scope → 私域；清空持有者后 → 全局', async () => {
  const { home, cleanup } = makeHome()
  const executor = makeExecutor()
  const memoryDir = path.join(home, '.chill', 'agent-memory', 'front-agent')
  setAgentMemoryDir(memoryDir)
  const r1 = await executor.executeAsync('save_memory', saveArgs())
  assert.equal(r1.success, true)
  assert.deepEqual((await MemoryStore.getScoped(memoryDir).list()).map(e => e.name), ['测试记忆'])
  assert.equal((await memoryStore.list()).length, 0)

  clearAgentMemoryDir()
  const r2 = await executor.executeAsync('save_memory', saveArgs({ title: '裸模型记忆' }))
  assert.equal(r2.success, true)
  assert.deepEqual((await memoryStore.list()).map(e => e.name), ['裸模型记忆'])
  cleanup()
})

test('路由: 委派未声明 memory（origin 无 memoryDir）+ 缺省 → 明确错误', async () => {
  const { cleanup } = makeHome()
  const executor = makeExecutor()
  const r = await executor.executeAsync('save_memory', saveArgs({ __origin: { source: 'subagent', subagentType: 'no-mem' } }))
  assert.equal(r.success, false)
  assert.match(String(r.error ?? ''), /未声明 memory 字段/)
  cleanup()
})

test('路由: 裸主会话显式 scope: agent → 明确错误；非法 scope 值 → 明确错误', async () => {
  const { cleanup } = makeHome()
  clearAgentMemoryDir()
  const executor = makeExecutor()
  const r1 = await executor.executeAsync('save_memory', saveArgs({ scope: 'agent' }))
  assert.equal(r1.success, false)
  assert.match(String(r1.error ?? ''), /未声明 memory 字段/)
  const r2 = await executor.executeAsync('save_memory', saveArgs({ scope: 'weird' }))
  assert.equal(r2.success, false)
  assert.match(String(r2.error ?? ''), /无效的 scope 值/)
  cleanup()
})

test('路由: delete_memory 同样按 scope 路由', async () => {
  const { home, cleanup } = makeHome()
  const executor = makeExecutor()
  const memoryDir = path.join(home, '.chill', 'agent-memory', 'doc-writer')
  const scoped = MemoryStore.getScoped(memoryDir)
  await scoped.save({ type: 'user', title: '私域记忆', content: 'x' })
  await memoryStore.save({ type: 'user', title: '全局记忆', content: 'x' })
  const origin = { source: 'subagent', subagentType: 'doc-writer', memoryDir }
  const r1 = await executor.executeAsync('delete_memory', JSON.stringify({ title: '私域记忆', __origin: origin }))
  assert.equal(r1.success, true)
  assert.equal((await scoped.list()).length, 0)
  assert.equal((await memoryStore.list()).length, 1, '全局记忆不应被误删')
  const r2 = await executor.executeAsync('delete_memory', JSON.stringify({ title: '全局记忆', scope: 'global', __origin: origin }))
  assert.equal(r2.success, true)
  assert.equal((await memoryStore.list()).length, 0)
  cleanup()
})
