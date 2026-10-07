import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { BuiltInToolExecutor } from '../../src/services/builtInToolExecutor.ts'
import { resetApprovalChannel } from '../../src/services/approvals.ts'
import { resetWriteBoundary } from '../../src/services/writeBoundary.ts'

/**
 * 迭代 4 写时重匹配（防陈旧基底覆写）测试：
 * 复刻根因实验 B 的场景——匹配/审批后、落盘前文件被外部通道修改，
 * 写入必须基于磁盘新内容重匹配：目标区未受影响 → 应用且保留外部修改；
 * 目标区受影响 → 整体中止、磁盘原样、报"外部修改"，绝不静默吞内容。
 */

const key = (p: string) => path.normalize(p)

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
    listDirectory: async () => ({ success: true, data: [] }),
  }
}

function makeConfirmationHandler() {
  const snapshots = new Map<string, any>()
  return {
    addPendingOperation: () => {},
    getPendingOperations: () => [],
    getDocumentSnapshot: (p: string) => snapshots.get(key(p)) ?? null,
    setDocumentSnapshot: (p: string, s: any) => {
      if (s === null) snapshots.delete(key(p))
      else snapshots.set(key(p), s)
    },
    clearAll: () => {},
  }
}

function makePositionCalculator(files: Map<string, string>) {
  return {
    getSnapshot: async (p: string) => ({ plainText: files.get(key(p)) ?? '' }),
    calculateInsertPosition: (snapshot: any, anchor: string, position?: string) => {
      const idx = snapshot.plainText.indexOf(anchor)
      if (idx === -1) return { success: false, error: `锚点未找到: ${anchor}` }
      const pos = position === 'before' ? idx : idx + anchor.length
      return { success: true, pos, plainTextPos: pos }
    },
    calculatePosition: async (snapshot: any, oldContent: string) => {
      const idx = snapshot.plainText.indexOf(oldContent)
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

function setup(t: { after: (fn: () => void) => void }) {
  resetWriteBoundary()
  resetApprovalChannel()
  const workDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wr-in-')))
  const sourceRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wr-src-')))
  const fsProvider = makeFsProvider(workDir)
  const handler = makeConfirmationHandler()
  const executor = new BuiltInToolExecutor(
    fsProvider as any,
    handler as any,
    makePositionCalculator(fsProvider.files) as any,
    {} as any,
    sourceRoot,
  )
  t.after(() => {
    resetWriteBoundary()
    resetApprovalChannel()
    for (const d of [workDir, sourceRoot]) fs.rmSync(d, { recursive: true, force: true })
  })
  return {
    executor,
    fsProvider,
    workDir,
    inside: (name: string) => path.join(workDir, name),
    call: (tool: string, params: unknown, id: string) =>
      executor.executeAsync(tool, JSON.stringify(params), id),
  }
}

test('外部修改未触及目标区：replace 应用成功且外部追加被保留（不再被吞）', async (t) => {
  const ctx = setup(t)
  const f = ctx.inside('a.txt')
  const v1 = 'line1\nline2\nline3'
  ctx.fsProvider.files.set(key(f), v1)

  // 预置缓存：一次失败匹配让 v1 快照留在缓存（生产中最常见的缓存入口）
  await ctx.call('replace_content', { path: f, old_content: 'NOT_EXIST', new_content: 'x' }, 'W-1')

  // 外部通道追加一行（模拟 execute_code，绕过 invalidateSnapshot）
  ctx.fsProvider.files.set(key(f), v1 + '\nEXTERNAL_APPEND')

  const r = await ctx.call('replace_content', { path: f, old_content: 'line2', new_content: 'LINE2' }, 'W-2')
  assert.equal(r.success, true, r.success ? '' : r.error)
  const disk = ctx.fsProvider.files.get(key(f))!
  assert.ok(disk.includes('LINE2'), '替换生效')
  assert.ok(disk.includes('EXTERNAL_APPEND'), '外部追加被保留（根因一恶化形态已消除）')
})

test('外部修改触及目标区：replace 整体中止、磁盘原样、报外部修改', async (t) => {
  const ctx = setup(t)
  const f = ctx.inside('b.txt')
  const v1 = 'line1\nline2\nline3'
  ctx.fsProvider.files.set(key(f), v1)
  await ctx.call('replace_content', { path: f, old_content: 'NOT_EXIST', new_content: 'x' }, 'X-1')

  // 外部通道把目标行改掉了
  const v2 = 'line1\nline2-changed\nline3'
  ctx.fsProvider.files.set(key(f), v2)

  const r = await ctx.call('replace_content', { path: f, old_content: 'line2\n', new_content: 'LINE2\n' }, 'X-2')
  // 匹配期吃的是新内容（缓存已被失败匹配留下的是 v1；v2 中 "line2\n" 不存在了）
  // 无论匹配期还是写时发现，结果必须是：不写盘、报错可见
  assert.equal(r.success, false)
  assert.equal(ctx.fsProvider.files.get(key(f)), v2, '磁盘保持外部修改后的原样')
})

test('insert 直通：外部追加后锚点重匹配，插入成功且追加保留', async (t) => {
  const ctx = setup(t)
  const f = ctx.inside('c.txt')
  const v1 = 'alpha\nbeta\ngamma'
  ctx.fsProvider.files.set(key(f), v1)
  await ctx.call('replace_content', { path: f, old_content: 'NOT_EXIST', new_content: 'x' }, 'I-1')

  ctx.fsProvider.files.set(key(f), v1 + '\nEXTERNAL_APPEND')

  const r = await ctx.call('insert_content', { path: f, anchor: 'beta', content: '\nINSERTED', position: 'after' }, 'I-2')
  assert.equal(r.success, true, r.success ? '' : r.error)
  const disk = ctx.fsProvider.files.get(key(f))!
  assert.ok(disk.includes('INSERTED'))
  assert.ok(disk.includes('EXTERNAL_APPEND'))
})

test('autoBatch flush：外部修改触及目标区 → 该文件整批失败且磁盘原样', async (t) => {
  const ctx = setup(t)
  const f = ctx.inside('d.txt')
  const v1 = 'one\ntwo\nthree'
  ctx.fsProvider.files.set(key(f), v1)
  ctx.executor.setAutoApply(true)

  // 收集两个批次操作（均基于 v1 匹配成功）
  const r1 = await ctx.call('replace_content', { path: f, old_content: 'one', new_content: 'ONE' }, 'B-1')
  assert.equal(r1.success, true)
  const r2 = await ctx.call('replace_content', { path: f, old_content: 'three', new_content: 'THREE' }, 'B-2')
  assert.equal(r2.success, true)

  // flush 前外部通道把 'three' 整行改写（目标字符串不复存在）
  ctx.fsProvider.files.set(key(f), 'one\ntwo\nTHREE-EXTERNAL')

  const results = await ctx.executor.applyAutoApplyBatch()
  assert.equal(results.get('B-1')!.success, false, '整批失败（按文件全成或全败）')
  assert.equal(results.get('B-2')!.success, false)
  assert.match(results.get('B-2')!.error!, /外部修改/)
  assert.equal(ctx.fsProvider.files.get(key(f)), 'one\ntwo\nTHREE-EXTERNAL', '磁盘原样未写')
})

test('autoBatch flush：无外部修改 → 顺序重匹配应用成功', async (t) => {
  const ctx = setup(t)
  const f = ctx.inside('e.txt')
  ctx.fsProvider.files.set(key(f), 'one\ntwo\nthree')
  ctx.executor.setAutoApply(true)

  await ctx.call('replace_content', { path: f, old_content: 'one', new_content: 'ONE' }, 'C-1')
  await ctx.call('insert_content', { path: f, anchor: 'two', content: '-INS', position: 'after' }, 'C-2')

  const results = await ctx.executor.applyAutoApplyBatch()
  assert.equal(results.get('C-1')!.success, true, JSON.stringify(results.get('C-1')))
  assert.equal(results.get('C-2')!.success, true, JSON.stringify(results.get('C-2')))
  const disk = ctx.fsProvider.files.get(key(f))!
  assert.ok(disk.includes('ONE'))
  assert.ok(disk.includes('-INS'))
})
