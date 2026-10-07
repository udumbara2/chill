import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { BuiltInToolExecutor } from '../../src/services/builtInToolExecutor.ts'
import { getApprovalChannel, resetApprovalChannel } from '../../src/services/approvals.ts'
import { resetWriteBoundary } from '../../src/services/writeBoundary.ts'
import { eventBus, EVENTS } from '../../src/utils/eventBus.ts'
import type { ApprovalRequestPayload } from '../../src/services/approvals.ts'

/**
 * 5 写工具的统一写边界模型改造（T2）测试：
 * 界内直通 / 界外即时审批（先审后写），文件写暂存流已退役。
 * 真实 BuiltInToolExecutor + 内存 fsProvider + fake confirmationHandler/positionCalculator。
 *
 * workDir/界外目录/sourceRoot 一律取 realpath 后的真实临时目录——writeBoundary 的
 * realpath 双路径判定在 Windows 上会把短名解析为长名，不用 realpath 形式会误判圈外。
 */

const key = (p: string) => path.normalize(p)

/** 内存 fsProvider（IFileSystemProvider 形状；键 = path.normalize） */
function makeFsProvider(workDir: string) {
  const files = new Map<string, string>()
  const dirs = new Set<string>([key(workDir)])
  return {
    files,
    dirs,
    getCurrentDirectory: () => workDir,
    fileExists: async (p: string) => ({ success: true, data: files.has(key(p)) }),
    readFile: async (p: string) =>
      files.has(key(p))
        ? { success: true, data: { content: files.get(key(p)) } }
        : { success: false, error: 'not found' },
    writeFile: async (p: string, content: string) => {
      files.set(key(p), content)
      return { success: true }
    },
    deleteFile: async (p: string) => {
      if (dirs.delete(key(p))) return { success: true }
      if (!files.delete(key(p))) return { success: false, error: 'not found' }
      return { success: true }
    },
    getPathType: async (p: string) => {
      if (dirs.has(key(p))) return { success: true, data: { type: 'directory' } }
      if (files.has(key(p))) return { success: true, data: { type: 'file' } }
      return { success: true, data: { type: 'not_found' } }
    },
    listDirectory: async (p: string) => {
      const prefix = key(p) + path.sep
      const names = new Set<string>()
      for (const k of [...files.keys(), ...dirs]) {
        if (k.startsWith(prefix)) names.add(k.slice(prefix.length).split(path.sep)[0])
      }
      return { success: true, data: [...names].map((name) => ({ name })) }
    },
  }
}

/** fake confirmationHandler：快照 map + pendingOps 记录（无暂存残留的断言点） */
function makeConfirmationHandler() {
  const snapshots = new Map<string, any>()
  const pendingOps: any[] = []
  return {
    pendingOps,
    addPendingOperation: (op: any) => pendingOps.push(op),
    getPendingOperations: () => [],
    getDocumentSnapshot: (p: string) => snapshots.get(key(p)) ?? null,
    setDocumentSnapshot: (p: string, s: any) => {
      if (s === null) snapshots.delete(key(p))
      else snapshots.set(key(p), s)
    },
    clearAll: () => {},
  }
}

/** fake positionCalculator：indexOf 级别的位置计算（覆盖测试用例的锚点/内容匹配）；快照读内存 fs */
function makePositionCalculator(files: Map<string, string>) {
  return {
    getSnapshot: async (p: string) => ({ plainText: files.get(key(p)) ?? '' }),
    calculateInsertPosition: (snapshot: any, anchor: string, position?: string) => {
      const text: string = snapshot.plainText
      const idx = text.indexOf(anchor)
      if (idx === -1) return { success: false, error: `锚点未找到: ${anchor}` }
      const pos = position === 'before' ? idx : idx + anchor.length
      return { success: true, pos, plainTextPos: pos }
    },
    calculatePosition: async (snapshot: any, oldContent: string) => {
      const text: string = snapshot.plainText
      const idx = text.indexOf(oldContent)
      if (idx === -1) return { success: false, error: '内容未找到' }
      return {
        success: true,
        from: idx,
        to: idx + oldContent.length,
        plainTextFrom: idx,
        plainTextTo: idx + oldContent.length,
      }
    },
  }
}

interface Ctx {
  executor: BuiltInToolExecutor
  fsProvider: ReturnType<typeof makeFsProvider>
  handler: ReturnType<typeof makeConfirmationHandler>
  workDir: string
  outsideDir: string
  sourceRoot: string
  approvals: ApprovalRequestPayload[]
  inside: (name: string) => string
  outside: (name: string) => string
  cleanup: () => void
}

function setup(t: { after: (fn: () => void) => void }): Ctx {
  resetWriteBoundary()
  resetApprovalChannel()
  const workDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-in-')))
  const outsideDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-out-')))
  const sourceRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-src-')))
  const fsProvider = makeFsProvider(workDir)
  const handler = makeConfirmationHandler()
  const executor = new BuiltInToolExecutor(
    fsProvider as any,
    handler as any,
    makePositionCalculator(fsProvider.files) as any,
    {} as any,
    sourceRoot,
  )
  const approvals: ApprovalRequestPayload[] = []
  const listener = (p: ApprovalRequestPayload) => approvals.push(p)
  eventBus.on(EVENTS.APPROVAL_REQUESTED, listener)
  const cleanup = () => {
    eventBus.off(EVENTS.APPROVAL_REQUESTED, listener)
    resetWriteBoundary()
    resetApprovalChannel()
    for (const d of [workDir, outsideDir, sourceRoot]) {
      fs.rmSync(d, { recursive: true, force: true })
    }
  }
  t.after(cleanup)
  return {
    executor,
    fsProvider,
    handler,
    workDir,
    outsideDir,
    sourceRoot,
    approvals,
    inside: (name) => path.join(workDir, name),
    outside: (name) => path.join(outsideDir, name),
    cleanup,
  }
}

const call = (ctx: Ctx, tool: string, params: unknown, toolCallId: string) =>
  ctx.executor.executeAsync(tool, JSON.stringify(params), toolCallId)

test('界内直通: create_file/replace/insert/delete_content/delete_file 直接落盘、无审批、无暂存', async (t) => {
  const ctx = setup(t)
  ctx.fsProvider.files.set(key(ctx.inside('a.txt')), 'foo bar baz')

  // create_file（相对路径 → workDir 内）
  let result = await call(ctx, 'create_file', { path: 'note.txt', content: 'hello' }, 'tc-in-1')
  assert.equal(result.success, true)
  assert.equal(ctx.fsProvider.files.get(key(ctx.inside('note.txt'))), 'hello')

  // replace_content
  result = await call(ctx, 'replace_content', { path: 'a.txt', old_content: 'bar', new_content: 'qux' }, 'tc-in-2')
  assert.equal(result.success, true)
  assert.equal(ctx.fsProvider.files.get(key(ctx.inside('a.txt'))), 'foo qux baz')

  // insert_content
  result = await call(ctx, 'insert_content', { path: 'a.txt', anchor: 'qux', content: '-ins', position: 'after' }, 'tc-in-3')
  assert.equal(result.success, true)
  assert.equal(ctx.fsProvider.files.get(key(ctx.inside('a.txt'))), 'foo qux-ins baz')

  // delete_content
  result = await call(ctx, 'delete_content', { path: 'a.txt', content: 'qux-ins ' }, 'tc-in-4')
  assert.equal(result.success, true)
  assert.equal(ctx.fsProvider.files.get(key(ctx.inside('a.txt'))), 'foo baz')

  // delete_file
  result = await call(ctx, 'delete_file', { paths: ['note.txt'] }, 'tc-in-5')
  assert.equal(result.success, true)
  assert.equal(ctx.fsProvider.files.has(key(ctx.inside('note.txt'))), false)

  // 全程：无审批请求、无暂存操作
  assert.equal(ctx.approvals.length, 0, '界内不得触发审批')
  assert.equal(ctx.handler.pendingOps.length, 0, '文件写不得再产生暂存操作')
})

test('备份顺序: 界内直通先经 BackupStore 留存 pre-image 再落盘（集中存储，无同目录 .backup 散落）', async (t) => {
  const ctx = setup(t)
  const backupsRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-bk-')))
  t.after(() => fs.rmSync(backupsRoot, { recursive: true, force: true }))
  const { BackupStore } = await import('../../src/services/backupStore.ts')
  const store = new BackupStore({
    fs: ctx.fsProvider as any,
    rootDir: () => backupsRoot,
    context: () => ({ sessionId: 's-test', turnId: 'user:t-test' }),
  })
  ctx.executor.setBackupStore(store)
  ctx.fsProvider.files.set(key(ctx.inside('a.txt')), 'old content')

  const result = await call(ctx, 'replace_content', { path: 'a.txt', old_content: 'old', new_content: 'new' }, 'tc-bk-1')
  assert.equal(result.success, true)
  assert.equal(ctx.fsProvider.files.get(key(ctx.inside('a.txt'))), 'new content')
  // 集中存储后工作目录零 .backup-* 散落（旧同目录写逻辑已由 backupStore 取代）
  const scattered = [...ctx.fsProvider.files.keys()].filter((k) => k.includes('.backup-'))
  assert.equal(scattered.length, 0, '工作目录不得再有 .backup-* 散落')
  // 集中存储有一份 pre-image（内容为写前原文）+ index 归因齐全
  const entries = await store.list(ctx.inside('a.txt'))
  assert.equal(entries.length, 1, '落盘前应留存一份快照')
  assert.equal(entries[0].toolName, 'replace_content')
  assert.equal(entries[0].toolCallId, 'tc-bk-1')
  assert.equal(entries[0].sessionId, 's-test')
  assert.equal(entries[0].turnId, 'user:t-test')
  const snapKey = [...ctx.fsProvider.files.keys()].find((k) =>
    k.startsWith(key(backupsRoot)) && !k.endsWith('index.jsonl') && !k.includes('.sessions'))
  assert.ok(snapKey, '快照文件已写入集中存储')
  assert.equal(ctx.fsProvider.files.get(snapKey!), 'old content', '快照内容为写前原文')
})

test('界外批准落盘: 审批请求含 kind/path/diffPreview/归属, 批准后写入', async (t) => {
  const ctx = setup(t)
  const target = ctx.outside('out.txt')

  const pending = call(ctx, 'create_file', { path: target, content: 'outside' }, 'tc-out-1')
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(ctx.approvals.length, 1, '界外应触发审批')
  assert.equal(ctx.approvals[0].kind, 'write')
  assert.equal(ctx.approvals[0].path, target)
  assert.ok(ctx.approvals[0].diffPreview?.includes('outside'), 'diff 预览即时生成（新内容全文）')
  assert.equal(ctx.approvals[0].origin.source, 'main', '缺省归属主会话')

  getApprovalChannel().resolve('tc-out-1', { approved: true })
  const result = await pending
  assert.equal(result.success, true)
  assert.equal(ctx.fsProvider.files.get(key(target)), 'outside')
  assert.equal(ctx.handler.pendingOps.length, 0)
})

test('界外拒绝: 不落盘且返回拒绝原因', async (t) => {
  const ctx = setup(t)
  const target = ctx.outside('out.txt')

  const pending = call(ctx, 'create_file', { path: target, content: 'outside' }, 'tc-out-2')
  await new Promise((r) => setTimeout(r, 0))
  getApprovalChannel().resolve('tc-out-2', { approved: false, reason: '不允许写桌面' })
  const result = await pending

  assert.equal(result.success, false)
  assert.ok(result.error!.includes('用户拒绝写入'))
  assert.ok(result.error!.includes('不允许写桌面'), '拒绝原因返回给模型')
  assert.equal(ctx.fsProvider.files.has(key(target)), false, '拒绝不落盘')
})

test('create_file 先审后写: 批准前文件不存在, 批准后才落盘', async (t) => {
  const ctx = setup(t)
  const target = ctx.outside('pending.txt')

  const pending = call(ctx, 'create_file', { path: target, content: 'pending-content' }, 'tc-out-3')
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(ctx.approvals.length, 1)
  assert.equal(ctx.fsProvider.files.has(key(target)), false, '审批挂起期间不得落盘（preApplied 退役）')

  getApprovalChannel().resolve('tc-out-3', { approved: true })
  const result = await pending
  assert.equal(result.success, true)
  assert.equal(ctx.fsProvider.files.get(key(target)), 'pending-content')
})

test('[d] 选项: addDir 加入会话可写根后, 同目录后续写直通', async (t) => {
  const ctx = setup(t)
  const first = ctx.outside('first.txt')
  const second = ctx.outside('second.txt')

  // 第一次界外写:批准 + addDir
  const pending = call(ctx, 'create_file', { path: first, content: '1' }, 'tc-dir-1')
  await new Promise((r) => setTimeout(r, 0))
  getApprovalChannel().resolve('tc-dir-1', { approved: true, addDir: ctx.outsideDir })
  const result = await pending
  assert.equal(result.success, true)

  // 第二次同目录写:直通,无新审批
  const result2 = await call(ctx, 'create_file', { path: second, content: '2' }, 'tc-dir-2')
  assert.equal(result2.success, true)
  assert.equal(ctx.fsProvider.files.get(key(second)), '2')
  assert.equal(ctx.approvals.length, 1, 'addDir 后同目录不得再问')
})

test('delete_file 逐路径判定: 界内直接删、界外逐个审批, 部分拒绝时汇总给模型', async (t) => {
  const ctx = setup(t)
  const inFile = ctx.inside('in.txt')
  const outFile = ctx.outside('out.txt')
  ctx.fsProvider.files.set(key(inFile), 'in')
  ctx.fsProvider.files.set(key(outFile), 'out')

  const pending = call(ctx, 'delete_file', { paths: [inFile, outFile] }, 'tc-del-1')
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(ctx.approvals.length, 1, '仅界外路径触发审批')
  assert.equal(ctx.approvals[0].path, outFile)

  getApprovalChannel().resolve('tc-del-1', { approved: false, reason: '不许删' })
  const result = await pending

  assert.equal(result.success, true, '部分批准仍执行获批部分')
  assert.equal(ctx.fsProvider.files.has(key(inFile)), false, '界内已删')
  assert.equal(ctx.fsProvider.files.has(key(outFile)), true, '界外被拒绝未删')
  assert.ok(result.data.content.includes('未删除'), '拒绝原因附在结果后')
  assert.ok(result.data.content.includes('不许删'))
})

test('guard 优先于边界: 源码树保护先于边界判定与审批生效', async (t) => {
  const ctx = setup(t)
  // 目标在 sourceRoot 下（相对 workDir 属圈外；guard 无 workcopy 时拦截）
  const target = path.join(ctx.sourceRoot, 'x.ts')

  const result = await call(ctx, 'create_file', { path: target, content: 'code' }, 'tc-guard-1')
  assert.equal(result.success, false)
  assert.ok(result.error!.includes('workcopy'), '返回 guard 文案')
  assert.equal(ctx.approvals.length, 0, 'guard 拦截先于审批,不弹审批')
  assert.equal(ctx.fsProvider.files.has(key(target)), false)
})
