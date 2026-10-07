import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { BuiltInToolExecutor } from '../../src/services/builtInToolExecutor.ts'
import { resetApprovalChannel } from '../../src/services/approvals.ts'
import { resetWriteBoundary } from '../../src/services/writeBoundary.ts'

/**
 * 迭代 5 ensureSnapshot 时效对账测试：
 * - statFile 可用：外部修改（mtime 变化）→ 重读新内容（误报失败消除）；
 *   mtime 未变 → 缓存命中（不重复读盘）。
 * - statFile 不可用：退化为每次重读（正确性优先）。
 */

const key = (p: string) => path.normalize(p)

function makeFsProvider(workDir: string, withStat: boolean) {
  const files = new Map<string, string>()
  const versions = new Map<string, number>()
  const dirs = new Set<string>([key(workDir)])
  const base: any = {
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
      versions.set(key(p), (versions.get(key(p)) ?? 0) + 1)
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
  if (withStat) {
    base.statFile = async (p: string) =>
      files.has(key(p))
        ? { success: true, data: { mtimeMs: versions.get(key(p)) ?? 0, size: files.get(key(p))!.length } }
        : { success: false, error: 'not found' }
  }
  return base
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
  const counter = { getSnapshotCalls: 0 }
  return {
    counter,
    getSnapshot: async (p: string) => {
      counter.getSnapshotCalls++
      return { plainText: files.get(key(p)) ?? '' }
    },
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

function setup(t: { after: (fn: () => void) => void }, withStat: boolean) {
  resetWriteBoundary()
  resetApprovalChannel()
  const workDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sf-in-')))
  const sourceRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sf-src-')))
  const fsProvider = makeFsProvider(workDir, withStat)
  const handler = makeConfirmationHandler()
  const positionCalculator = makePositionCalculator(fsProvider.files)
  const executor = new BuiltInToolExecutor(
    fsProvider as any,
    handler as any,
    positionCalculator as any,
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
    positionCalculator,
    inside: (name: string) => path.join(workDir, name),
    call: (tool: string, params: unknown, id: string) =>
      executor.executeAsync(tool, JSON.stringify(params), id),
  }
}

test('statFile 对账：外部修改后重读新内容，替换唯一文本成功（实验 A 场景反转）', async (t) => {
  const ctx = setup(t, true)
  const f = ctx.inside('a.txt')
  const v1 = 'alpha beta gamma delta'
  ctx.fsProvider.files.set(key(f), v1)

  // 预置缓存：失败匹配留下 v1 快照
  const r1 = await ctx.call('replace_content', { path: f, old_content: 'NOT_EXIST', new_content: 'x' }, 'S-1')
  assert.equal(r1.success, false)
  const callsAfterPrime = ctx.positionCalculator.counter.getSnapshotCalls

  // 外部通道改文件（绕过 invalidateSnapshot；statFile 版本号已变）
  const v2 = 'alpha beta UNIQUE_TARGET delta'
  await ctx.fsProvider.writeFile(f, v2)

  // 根因一旧行为：误报"内容未找到"；时效对账后：重读 v2，匹配成功
  const r2 = await ctx.call('replace_content', { path: f, old_content: 'UNIQUE_TARGET', new_content: 'REPLACED' }, 'S-2')
  assert.equal(r2.success, true, r2.success ? '' : r2.error)
  assert.ok(ctx.positionCalculator.counter.getSnapshotCalls > callsAfterPrime, 'mtime 变化触发了重读')
  assert.equal(ctx.fsProvider.files.get(key(f)), 'alpha beta REPLACED delta')
})

test('statFile 对账：mtime 未变时缓存命中，不重复读盘', async (t) => {
  const ctx = setup(t, true)
  const f = ctx.inside('b.txt')
  ctx.fsProvider.files.set(key(f), 'alpha beta gamma')

  // 两次失败匹配（不写盘 → 不失效缓存；mtime 未变）
  await ctx.call('replace_content', { path: f, old_content: 'NO1', new_content: 'x' }, 'C-1')
  const callsAfterFirst = ctx.positionCalculator.counter.getSnapshotCalls
  await ctx.call('replace_content', { path: f, old_content: 'NO2', new_content: 'x' }, 'C-2')
  assert.equal(ctx.positionCalculator.counter.getSnapshotCalls, callsAfterFirst, '第二次调用命中缓存，未重读')
})

test('statFile 缺失：退化为每次重读（正确性优先，结果仍正确）', async (t) => {
  const ctx = setup(t, false)
  const f = ctx.inside('c.txt')
  ctx.fsProvider.files.set(key(f), 'alpha beta gamma')

  await ctx.call('replace_content', { path: f, old_content: 'NO1', new_content: 'x' }, 'D-1')
  const callsAfterFirst = ctx.positionCalculator.counter.getSnapshotCalls
  await ctx.call('replace_content', { path: f, old_content: 'NO2', new_content: 'x' }, 'D-2')
  assert.ok(ctx.positionCalculator.counter.getSnapshotCalls > callsAfterFirst, '无 statFile 时每次重读')

  // 外部修改后同样不误报（重读兜底）
  await ctx.fsProvider.writeFile(f, 'alpha beta UNIQUE delta')
  const r = await ctx.call('replace_content', { path: f, old_content: 'UNIQUE', new_content: 'REPLACED' }, 'D-3')
  assert.equal(r.success, true, r.success ? '' : r.error)
})
