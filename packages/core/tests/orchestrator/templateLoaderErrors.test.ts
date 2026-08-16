import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FileSystemTemplateLoader } from '../../src/orchestrator/FileSystemTemplateLoader.ts'
import type { IFileSystemProvider } from '../../src/interfaces/IFileSystemProvider.ts'

/**
 * 模板解析错误可见化（T2）：loadTemplatesFromDirectory 的 onErrors 透传。
 * 坏文件跳过不中断（回归）；解析失败与读取失败都如实上报（读取失败不再伪装成"缺 name"）。
 */

const GOOD = `---\nname: 好模板\nsubagent_type: good-one\n---\n能力描述\n`
const BAD = `---\nname: 缺类型\n---\n没有 subagent_type\n`

function fakeFs(opts: { failRead?: string[] } = {}): IFileSystemProvider {
  return {
    listDirectory: async () => ({
      success: true,
      data: {
        files: [
          { name: 'good.md', type: 'file' },
          { name: 'bad.md', type: 'file' },
          { name: 'unreadable.md', type: 'file' },
          { name: 'note.txt', type: 'file' },
        ],
      },
    }),
    readFile: async (p: string) => {
      if (opts.failRead?.some((f) => p.endsWith(f))) {
        return { success: false, error: 'EPERM' } as any
      }
      return { success: true, data: { content: p.endsWith('good.md') ? GOOD : BAD } } as any
    },
  } as unknown as IFileSystemProvider
}

test('onErrors: 解析失败逐文件上报（路径 + 原因），坏文件跳过、好文件照常加载（回归）', async () => {
  const loader = new FileSystemTemplateLoader(fakeFs(), '')
  const errors: string[] = []
  const templates = await loader.loadTemplatesFromDirectory('/tpl', (errs) => errors.push(...errs))
  assert.equal(templates.length, 1)
  assert.equal(templates[0].subagent_type, 'good-one')
  assert.equal(errors.length, 2, 'bad.md 解析失败 + unreadable.md 读取失败')
  assert.ok(errors.some((e) => e.includes('bad.md') && e.includes('subagent_type')))
})

test('onErrors: 读取失败如实报"读取失败"，不伪装成"缺少必填字段 name"', async () => {
  const loader = new FileSystemTemplateLoader(fakeFs({ failRead: ['unreadable.md'] }), '')
  const errors: string[] = []
  await loader.loadTemplatesFromDirectory('/tpl', (errs) => errors.push(...errs))
  const readErr = errors.find((e) => e.includes('unreadable.md'))!
  assert.ok(readErr.includes('读取失败'))
  assert.ok(!readErr.includes('缺少必填字段'))
})

test('onErrors: 全部合法时不回调；不传 onErrors 行为不变（回归）', async () => {
  const onlyGood: IFileSystemProvider = {
    listDirectory: async () => ({ success: true, data: { files: [{ name: 'good.md', type: 'file' }] } }),
    readFile: async () => ({ success: true, data: { content: GOOD } }),
  } as unknown as IFileSystemProvider
  const loader = new FileSystemTemplateLoader(onlyGood, '')
  let called = 0
  const templates = await loader.loadTemplatesFromDirectory('/tpl', () => called++)
  assert.equal(templates.length, 1)
  assert.equal(called, 0)
  // 不传回调（旧签名）
  const again = await loader.loadTemplatesFromDirectory('/tpl')
  assert.equal(again.length, 1)
})
