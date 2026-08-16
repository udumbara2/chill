import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SecureStorageService } from '../../src/services/secureStorageService.ts'
import { EMBEDDING_KEY_PROVIDER } from '../../src/services/knowledge/embeddingClient.ts'
import { KnowledgeStore } from '../../src/services/knowledge/knowledgeStore.ts'
import { BuiltInToolExecutor } from '../../src/services/builtInToolExecutor.ts'
import { PLAN_MODE_BLOCKED_TOOLS, TOOL_CAPABILITY, BUILTIN_TOOLS, ASYNC_BUILTIN_TOOLS } from '../../src/services/builtInTools.ts'

/** 内联 Node fsProvider（同 knowledgeStore.test.ts 的形状，额外实现 readFileBase64） */
function makeEnv(opts: { withBase64?: boolean } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kbtools-'))
  const fsProvider: any = {
    readFile: async (p: string) => {
      try { return { success: true, data: { content: fs.readFileSync(p, 'utf-8') } } } catch { return { success: false, error: '读取失败' } }
    },
    writeFile: async (p: string, content: string) => {
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, content, 'utf-8')
      return { success: true }
    },
    deleteFile: async (p: string) => { try { fs.rmSync(p, { recursive: true, force: true }); return { success: true } } catch { return { success: false } } },
    listDirectory: async (p: string) => {
      try {
        const files = fs.readdirSync(p, { withFileTypes: true }).map(e => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' }))
        return { success: true, data: { files } }
      } catch { return { success: false } }
    },
    getCurrentDirectory: () => home,
    fileExists: async (p: string) => ({ success: fs.existsSync(p) }),
    getPathType: async (p: string) => ({ success: true, data: fs.existsSync(p) ? (fs.statSync(p).isDirectory() ? 'directory' : 'file') : null }),
  }
  if (opts.withBase64 !== false) {
    fsProvider.readFileBase64 = async (p: string) => {
      try { return { success: true, data: { base64: fs.readFileSync(p).toString('base64') } } } catch { return { success: false, error: '读取失败' } }
    }
  }
  const store = KnowledgeStore.getInstance()
  store.init(fsProvider, { getUserDataPath: () => path.join(home, '.chill'), getUserHomePath: () => home } as any)
  const executor = new BuiltInToolExecutor(fsProvider, {} as any, {} as any, {} as any, home)
  return { home, store, fsProvider, executor, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) }
}

/** 内存版 ISecureStorage */
function makeSecureStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    storeApiKey: async (provider: string, apiKey: string) => { map.set(provider, apiKey); return true },
    getApiKey: async (provider: string) => map.get(provider) ?? null,
    hasApiKey: async (provider: string) => map.has(provider),
    deleteApiKey: async (provider: string) => map.delete(provider),
    getAllProviders: async () => [...map.keys()],
  }
}

/** mock 全局 fetch：全部文本给同一伪向量（余弦=1，必过默认阈值）；rerank 配置默认关闭 */
function mockFetch() {
  const g = globalThis as any
  g.__origFetch = g.fetch
  g.fetch = async (_url: string, init: any) => {
    const body = JSON.parse(init.body)
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: body.input.map((_: string, i: number) => ({ embedding: [1, 0, 0], index: i })) }),
      text: async () => '',
    } as Response
  }
}

/** 构造最小 hello-world PDF（同 ingestPipeline.test.ts） */
function buildHelloPdf(text: string): Uint8Array {
  const enc = new TextEncoder()
  const content = `BT /F1 24 Tf 100 700 Td (${text}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ]
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = [0]
  objects.forEach((body, i) => {
    offsets.push(enc.encode(pdf).length)
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xrefStart = enc.encode(pdf).length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (let i = 1; i <= objects.length; i++) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`
  return enc.encode(pdf)
}

const KNOWLEDGE_TOOLS = [
  'list_knowledge_bases', 'create_knowledge_base', 'delete_knowledge_base',
  'add_knowledge', 'search_knowledge', 'read_knowledge', 'distill_knowledge', 'delete_knowledge',
]

let env: ReturnType<typeof makeEnv>

async function call(tool: string, args: Record<string, unknown> = {}) {
  return env.executor.executeAsync(tool, JSON.stringify(args), 'tc-test')
}

/** 建库 + 小维度全局配置（rerank 关闭避免第二次网络调用） */
async function setup() {
  env = makeEnv()
  const config = await env.store.getGlobalConfig()
  config.embedding.dimensions = 3
  config.rerank.enabled = false
  await env.store.saveGlobalConfig(config)
}

beforeEach(() => {
  SecureStorageService.initialize(makeSecureStorage({ [EMBEDDING_KEY_PROVIDER]: 'sk-test' }) as any)
  mockFetch()
})

afterEach(() => {
  const g = globalThis as any
  if (g.__origFetch) g.fetch = g.__origFetch
  env?.cleanup()
})

test('工具清单约定：8 个知识工具已注册、走异步分发、不进规划模式拦截、不需要 Node fs', () => {
  for (const t of KNOWLEDGE_TOOLS) {
    assert.ok(BUILTIN_TOOLS.includes(t as any), `${t} 应在 BUILTIN_TOOLS`)
    assert.ok(ASYNC_BUILTIN_TOOLS.includes(t), `${t} 应在 ASYNC_BUILTIN_TOOLS`)
    assert.ok(!PLAN_MODE_BLOCKED_TOOLS.includes(t), `${t} 不应进 PLAN_MODE_BLOCKED_TOOLS（save_memory 先例）`)
    assert.ok(!TOOL_CAPABILITY[t]?.requiresNodeFs, `${t} 不应声明 requiresNodeFs（走注入 provider）`)
  }
})

test('create/list/delete_knowledge_base：建库、列库、重名与非法名报错、删库', async () => {
  await setup()
  const created = await call('create_knowledge_base', { name: '前端笔记', description: 'React 相关' })
  assert.equal(created.success, true, created.error)
  assert.match(created.data.content, /已创建知识库「前端笔记」/)

  const dup = await call('create_knowledge_base', { name: '前端笔记' })
  assert.equal(dup.success, false)
  assert.match(dup.error!, /已存在/)

  const bad = await call('create_knowledge_base', { name: 'a/b' })
  assert.equal(bad.success, false)
  assert.match(bad.error!, /非法知识库名/)

  const list = await call('list_knowledge_bases')
  assert.equal(list.success, true)
  assert.match(list.data.content, /前端笔记/)
  assert.match(list.data.content, /React 相关/)

  const del = await call('delete_knowledge_base', { name: '前端笔记' })
  assert.equal(del.success, true, del.error)
  const list2 = await call('list_knowledge_bases')
  assert.match(list2.data.content, /没有任何知识库/)
})

test('add_knowledge（content + title）：摄入、幂等跳过、缺 title 报错', async () => {
  await setup()
  await call('create_knowledge_base', { name: 'kb' })

  const noTitle = await call('add_knowledge', { kb: 'kb', content: '一些内容' })
  assert.equal(noTitle.success, false)
  assert.match(noTitle.error!, /title/)

  const both = await call('add_knowledge', { kb: 'kb', path: 'a.md', content: 'x', title: 't' })
  assert.equal(both.success, false)
  assert.match(both.error!, /只能提供一个/)

  const ingested = await call('add_knowledge', { kb: 'kb', content: '# React 笔记\n\nuseEffect 在依赖变化时执行副作用。', title: 'react-effect' })
  assert.equal(ingested.success, true, ingested.error)
  assert.match(ingested.data.content, /已摄入「react-effect」/)
  assert.match(ingested.data.content, /docId: d-/)

  const again = await call('add_knowledge', { kb: 'kb', content: '# React 笔记\n\nuseEffect 在依赖变化时执行副作用。', title: 'react-effect' })
  assert.equal(again.success, true)
  assert.match(again.data.content, /内容未变化/)
})

test('add_knowledge（path）：相对路径按工作目录解析摄入文本文件', async () => {
  await setup()
  await call('create_knowledge_base', { name: 'kb' })
  fs.writeFileSync(path.join(env.home, 'note.md'), '# 笔记\n\n递归字符切块按自然边界降级。', 'utf-8')

  const result = await call('add_knowledge', { kb: 'kb', path: 'note.md' })
  assert.equal(result.success, true, result.error)
  assert.match(result.data.content, /已摄入/)
})

test('add_knowledge（PDF 路径）：走 readFileBase64 二进制通道摄入', async () => {
  await setup()
  await call('create_knowledge_base', { name: 'kb' })
  const pdfPath = path.join(env.home, 'hello.pdf')
  fs.writeFileSync(pdfPath, buildHelloPdf('Hello Knowledge'))

  const result = await call('add_knowledge', { kb: 'kb', path: pdfPath })
  assert.equal(result.success, true, result.error)
  assert.match(result.data.content, /已摄入/)

  const docs = await env.store.listDocs('kb')
  assert.equal(docs.length, 1)
  const doc = await env.store.readDoc('kb', docs[0])
  assert.equal(doc!.frontmatter.type, 'pdf')
  assert.match(doc!.body, /Hello Knowledge/)
})

test('add_knowledge（PDF）：provider 无 readFileBase64 时返回明确中文降级提示', async () => {
  await setup()
  // 换成无 readFileBase64 的 provider（store 与 executor 同步换，模拟未实现的宿主）
  const noBin = makeEnv({ withBase64: false })
  try {
    const config = await noBin.store.getGlobalConfig()
    config.embedding.dimensions = 3
    config.rerank.enabled = false
    await noBin.store.saveGlobalConfig(config)
    const created = await noBin.executor.executeAsync('create_knowledge_base', JSON.stringify({ name: 'kb' }), 'tc-1')
    assert.equal(created.success, true, created.error)
    const result = await noBin.executor.executeAsync('add_knowledge', JSON.stringify({ kb: 'kb', path: 'x.pdf' }), 'tc-2')
    assert.equal(result.success, false)
    assert.match(result.error!, /不支持读取二进制文件/)
  } finally {
    noBin.cleanup()
  }
})

test('search_knowledge → read_knowledge → delete_knowledge 闭环', async () => {
  await setup()
  await call('create_knowledge_base', { name: 'kb' })
  await call('add_knowledge', { kb: 'kb', content: '# 排错手册\n\n端口被占用时先查监听进程再杀。', title: 'trouble' })

  const search = await call('search_knowledge', { query: '端口占用怎么办', kb: 'kb' })
  assert.equal(search.success, true, search.error)
  assert.match(search.data.content, /排错手册|端口/)
  const docId = /docId: (d-[0-9a-f]+)/.exec(search.data.content)![1]

  const read = await call('read_knowledge', { kb: 'kb', doc_id: docId })
  assert.equal(read.success, true, read.error)
  assert.match(read.data.content, /类型: note/)
  assert.match(read.data.content, /端口被占用时先查监听进程再杀。/)

  const del = await call('delete_knowledge', { kb: 'kb', doc_id: docId })
  assert.equal(del.success, true, del.error)
  const gone = await call('read_knowledge', { kb: 'kb', doc_id: docId })
  assert.equal(gone.success, false)
  assert.match(gone.error!, /未找到文档/)

  const delAgain = await call('delete_knowledge', { kb: 'kb', doc_id: docId })
  assert.equal(delAgain.success, false)
})

test('distill_knowledge：沉淀入库且可检索；search_knowledge 未找到库时报错', async () => {
  await setup()
  await call('create_knowledge_base', { name: 'kb' })
  const distilled = await call('distill_knowledge', { kb: 'kb', title: '发版检查清单', content: '发版前必须跑全量测试并核对 changelog。' })
  assert.equal(distilled.success, true, distilled.error)
  assert.match(distilled.data.content, /已把「发版检查清单」沉淀/)

  const search = await call('search_knowledge', { query: '发版前要做什么' })
  assert.equal(search.success, true, search.error)
  assert.match(search.data.content, /发版检查清单|发版前必须跑全量测试/)

  const missingKb = await call('search_knowledge', { query: 'x', kb: '不存在' })
  assert.equal(missingKb.success, false)
  assert.match(missingKb.error!, /未找到知识库/)
})
