import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findProjectTemplateDirs } from '../../src/orchestrator/loaders/projectTemplateDirs.ts'
import type { IFileSystemProvider } from '../../src/interfaces/IFileSystemProvider.ts'

/** 基于 node:fs 的最小 IFileSystemProvider 实现（findProjectTemplateDirs 只用到 fileExists） */
const nodeFs = {
  fileExists: async (p: string) => ({ success: true, data: fs.existsSync(p) }),
} as unknown as IFileSystemProvider

function setup(): string {
  return fs.mkdtempSync(join(tmpdir(), 'chill-tpldirs-test-'))
}

/** 只关心临时目录内的结果，过滤掉向上递归时命中的真实磁盘上级目录（机器相关，不作断言） */
function underTmp(dirs: string[], dir: string): string[] {
  return dirs.filter((d) => d.startsWith(dir))
}

test('向上递归枚举: 返回存在的 .agents/agents/，按近→远排序', async (t) => {
  const dir = setup()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  // 目录结构：
  // dir/.agents/agents/        （远）
  // dir/proj/.agents/agents/   （近）
  // dir/proj/sub/deep/         （workDir，本级无）
  const far = join(dir, '.agents', 'agents')
  const near = join(dir, 'proj', '.agents', 'agents')
  const workDir = join(dir, 'proj', 'sub', 'deep')
  fs.mkdirSync(far, { recursive: true })
  fs.mkdirSync(near, { recursive: true })
  fs.mkdirSync(workDir, { recursive: true })

  const dirs = await findProjectTemplateDirs(nodeFs, workDir)
  assert.deepEqual(underTmp(dirs, dir), [near, far])
})

test('向上递归枚举: workDir 本级存在时排在最前', async (t) => {
  const dir = setup()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const far = join(dir, '.agents', 'agents')
  const self = join(dir, 'repo', '.agents', 'agents')
  const workDir = join(dir, 'repo')
  fs.mkdirSync(far, { recursive: true })
  fs.mkdirSync(self, { recursive: true })

  const dirs = await findProjectTemplateDirs(nodeFs, workDir)
  assert.deepEqual(underTmp(dirs, dir), [self, far])
})

test('向上递归枚举: 没有任何 .agents/agents/ 时返回空', async (t) => {
  const dir = setup()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const workDir = join(dir, 'plain', 'sub')
  fs.mkdirSync(workDir, { recursive: true })

  const dirs = await findProjectTemplateDirs(nodeFs, workDir)
  assert.deepEqual(underTmp(dirs, dir), [])
})

test('fileExists 契约: data 为 boolean,false 时不返回该目录(回归:对象形态曾致全层级误判)', async (t) => {
  const dir = setup()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  // 契约形态:data 直接是 boolean(IFileSystemProvider.fileExists → FileSystemResult<boolean>)
  const booleanFs = {
    fileExists: async (p: string) => ({ success: true, data: fs.existsSync(p) }),
  } as unknown as IFileSystemProvider

  const existing = join(dir, 'repo', '.agents', 'agents')
  fs.mkdirSync(existing, { recursive: true })
  const workDir = join(dir, 'repo')

  const dirs = await findProjectTemplateDirs(booleanFs, workDir)
  // 只有真实存在的目录被返回;向上各级不存在的 .agents/agents 不得混入
  assert.deepEqual(underTmp(dirs, dir), [existing])
})
