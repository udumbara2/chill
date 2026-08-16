import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WriteBoundary, buildWriteBoundaryPrompt } from '../../src/services/writeBoundary.ts'
import type { IFileSystemProvider } from '../../src/interfaces/IFileSystemProvider.ts'

function makeBoundary(workDir: string | null, sourceRoot?: string): WriteBoundary {
  const b = new WriteBoundary()
  b.configure({
    fsProvider: { getCurrentDirectory: () => workDir } as unknown as IFileSystemProvider,
    sourceRoot: sourceRoot ?? null,
  })
  return b
}

function setup(t: import('node:test').TestContext): { dir: string; outside: string } {
  const dir = fs.mkdtempSync(join(tmpdir(), 'chill-wb-in-'))
  const outside = fs.mkdtempSync(join(tmpdir(), 'chill-wb-out-'))
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  })
  return { dir, outside }
}

test('边界判定: 嵌套路径在界内；../ 逃逸在界外', (t) => {
  const { dir } = setup(t)
  const b = makeBoundary(dir)

  // 嵌套（目标尚不存在也算界内——realpath 回退到最近存在祖先）
  assert.equal(b.isWithinWriteBoundary(join(dir, 'sub', 'deep', 'file.txt')), true)
  // 工作目录本身
  assert.equal(b.isWithinWriteBoundary(dir), true)
  // ../ 逃逸（未 resolve 的输入也防住）
  assert.equal(b.isWithinWriteBoundary(join(dir, '..', 'escape.txt')), false)
  // 完全不同根
  assert.equal(b.isWithinWriteBoundary('C:\\Windows\\System32\\x.dll'), false)
})

test('边界判定: 界内 symlink（junction）指向界外即圈外；指向界内放行', (t) => {
  const { dir, outside } = setup(t)
  const b = makeBoundary(dir)

  const linkOut = join(dir, 'link-out')
  const innerDir = join(dir, 'inner')
  fs.mkdirSync(innerDir)
  const linkIn = join(dir, 'link-in')
  try {
    // junction 无需管理员权限（Windows 目录链接）
    fs.symlinkSync(outside, linkOut, 'junction')
    fs.symlinkSync(innerDir, linkIn, 'junction')
  } catch (err) {
    t.skip(`当前环境不支持创建 junction: ${err}`)
    return
  }

  // 链接本身在界内、realpath 目标在界外 → 圈外（双路径判定）
  assert.equal(b.isWithinWriteBoundary(join(linkOut, 'f.txt')), false)
  // 链接指向界内 → 放行
  assert.equal(b.isWithinWriteBoundary(join(linkIn, 'f.txt')), true)
})

test('边界判定: workcopy 白名单（同级与源码目录内两种可能）', (t) => {
  const { dir } = setup(t)
  const sourceRoot = join(dir, 'src')
  const b = makeBoundary(join(dir, 'elsewhere'), sourceRoot)

  assert.equal(b.isWithinWriteBoundary(join(dir, 'chill-workcopy', 'x.ts')), true) // 同级
  assert.equal(b.isWithinWriteBoundary(join(sourceRoot, 'chill-workcopy', 'x.ts')), true) // 源码目录内
  // 白名单外的源码树仍是圈外（checkSourceRootGuard 是更严叠加层，与本判定正交）
  assert.equal(b.isWithinWriteBoundary(join(sourceRoot, 'packages', 'x.ts')), false)
})

test('边界判定: chill-archive 白名单（同级与源码目录内两种可能，自迭代档案库落在圈内）', (t) => {
  const { dir } = setup(t)
  const sourceRoot = join(dir, 'src')
  const b = makeBoundary(join(dir, 'elsewhere'), sourceRoot)

  assert.equal(b.isWithinWriteBoundary(join(dir, 'chill-archive', 'current-iteration.json')), true) // 同级
  assert.equal(b.isWithinWriteBoundary(join(sourceRoot, 'chill-archive', 'verify-current.md')), true) // 源码目录内
  // sourceRoot 为 null（npm 模式）时白名单不生效
  const npmMode = makeBoundary(join(dir, 'elsewhere'))
  assert.equal(npmMode.isWithinWriteBoundary(join(dir, 'chill-archive', 'x.json')), false)
})

test('边界判定: 空 workDir = 圈外（最保守）', (t) => {
  const { dir } = setup(t)
  const b = makeBoundary(null)
  assert.equal(b.isWithinWriteBoundary(join(dir, 'f.txt')), false)
  assert.equal(b.isWithinWriteBoundary(''), false)
})

test('add-dir: 校验存在 + realpath 规范化，加入后入圈；无效路径拒绝', (t) => {
  const { dir, outside } = setup(t)
  const b = makeBoundary(dir)

  // 加入前是圈外
  assert.equal(b.isWithinWriteBoundary(join(outside, 'f.txt')), false)

  // 经含 .. 的写法加入 → realpath 规范化存储
  const added = b.addWritableRoot(join(outside, 'sub', '..'))
  assert.equal(added.success, true)
  assert.equal(added.path, fs.realpathSync.native(outside))
  assert.equal(b.isWithinWriteBoundary(join(outside, 'f.txt')), true)
  assert.ok(b.listWritableRoots().includes(fs.realpathSync.native(outside)))

  // 不存在的路径不静默加入
  const bad = b.addWritableRoot(join(dir, 'no-such-dir'))
  assert.equal(bad.success, false)
  assert.ok(bad.error)

  // 文件（非目录）拒绝
  const f = join(dir, 'a.txt')
  fs.writeFileSync(f, 'x')
  assert.equal(b.addWritableRoot(f).success, false)
})

test('边界提示文本: readonly / fullAccess / 默认三分支', () => {
  assert.ok(buildWriteBoundaryPrompt([], { readonly: true }).includes('只读模式'))
  assert.ok(buildWriteBoundaryPrompt([], { fullAccess: true }).includes('全量直接写'))

  const withRoots = buildWriteBoundaryPrompt(['C:\\proj', 'D:\\lib'])
  assert.ok(withRoots.includes('C:\\proj'))
  assert.ok(withRoots.includes('D:\\lib'))
  assert.ok(withRoots.includes('圈内可直接写'))
  assert.ok(withRoots.includes('不要静默重试同一操作'))

  const empty = buildWriteBoundaryPrompt([])
  assert.ok(empty.includes('任何写入都视为圈外'))
})
