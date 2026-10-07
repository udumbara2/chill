import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WorkflowTemplateService } from '../../../src/services/workflow/WorkflowTemplateService.ts'
import type { IFileSystemProvider } from '../../../src/interfaces/IFileSystemProvider.ts'

/** 内存假 fs(目录结构用路径前缀模拟;入参路径统一规范化正斜杠,兼容 Windows path.join) */
function makeFakeFs(files: Record<string, string>) {
  const map = new Map(Object.entries(files))
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '').replace(/\/$/, '')
  const fs: IFileSystemProvider = {
    readFile: async (p: string) => {
      const key = norm(p)
      return map.has(key) ? { success: true, data: { content: map.get(key)! } } : { success: false, error: 'not found' }
    },
    writeFile: async (p: string, content: string) => {
      map.set(norm(p), content)
      return { success: true }
    },
    deleteFile: async (p: string) => {
      map.delete(norm(p))
      return { success: true }
    },
    listDirectory: async (dir: string) => {
      const prefix = `${norm(dir)}/`
      const names = [...map.keys()]
        .filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
        .map((k) => ({ name: k.slice(prefix.length), type: 'file' }))
      return { success: true, data: { files: names } }
    },
    getCurrentDirectory: () => null,
    fileExists: async (p: string) => {
      const key = norm(p)
      const exists = map.has(key) || [...map.keys()].some((k) => k.startsWith(`${key}/`))
      return { success: true, data: exists }
    },
    getPathType: async (p: string) => ({
      success: true,
      data: { type: map.has(norm(p)) ? ('file' as const) : ('not_found' as const) },
    }),
  }
  return { fs, map }
}

const WF_A = 'name: alpha\nversion: 1\nnodes: [{id: a, agent: {system_prompt: x}}]'
const WF_A_PROJECT = 'name: alpha\nversion: 1\ndescription: 项目版\nnodes: [{id: a, agent: {system_prompt: 项目}}]'
const WF_B = 'name: beta\nversion: 1\nnodes: [{id: b, agent: {system_prompt: y}}]'
const WF_BAD = 'name: bad file\nversion: 1\nnodes: []'

test('加载:用户级 + 项目级,项目覆盖用户,错误可见', async () => {
  const { fs } = makeFakeFs({
    '/home/user/.chill/workflows/alpha.yaml': WF_A,
    '/home/user/.chill/workflows/beta.yaml': WF_B,
    '/work/proj/.agents/workflows/alpha.yaml': WF_A_PROJECT,
    '/work/proj/.agents/workflows/broken.yaml': WF_BAD,
  })
  const service = new WorkflowTemplateService(fs, '/home/user/.chill/workflows')
  await service.initialize('/work/proj')

  const names = service.getAllWorkflows().map((w) => w.name).sort()
  assert.deepEqual(names, ['alpha', 'beta'])

  // 项目级覆盖用户级
  const alpha = service.getWorkflowByName('alpha')!
  assert.equal(alpha.description, '项目版')
  assert.equal(alpha.scope, 'project')
  assert.match(alpha.sourcePath ?? '', /alpha\.yaml$/)

  // 用户级未被覆盖的保留
  assert.equal(service.getWorkflowByName('beta')?.scope, 'user')

  // 非法文件带原因可见
  const errors = service.getErrors()
  assert.equal(errors.length, 1)
  assert.match(errors[0], /broken\.yaml/)
})

test('项目级向上递归:近者覆盖远者', async () => {
  const { fs } = makeFakeFs({
    '/work/.agents/workflows/a.yaml': 'name: a\nversion: 1\ndescription: 远\nnodes: [{id: n, agent: {system_prompt: x}}]',
    '/work/sub/.agents/workflows/a.yaml': 'name: a\nversion: 1\ndescription: 近\nnodes: [{id: n, agent: {system_prompt: x}}]',
  })
  const service = new WorkflowTemplateService(fs, '/home/user/.chill/workflows')
  await service.initialize('/work/sub/dir')
  assert.equal(service.getWorkflowByName('a')?.description, '近')
})

test('热生效:reload 后新文件立即可见', async () => {
  const { fs, map } = makeFakeFs({
    '/home/user/.chill/workflows/a.yaml': WF_A,
  })
  const service = new WorkflowTemplateService(fs, '/home/user/.chill/workflows')
  await service.initialize()
  assert.equal(service.getAllWorkflows().length, 1)

  map.set('/home/user/.chill/workflows/b.yaml', WF_B)
  await service.reload()
  assert.equal(service.getAllWorkflows().length, 2)
  assert.ok(service.getWorkflowByName('beta'))
})

test('无 workDir 时仅用户级;目录不存在返回空', async () => {
  const { fs } = makeFakeFs({})
  const service = new WorkflowTemplateService(fs, '/nonexistent')
  await service.initialize('/anywhere')
  assert.equal(service.getAllWorkflows().length, 0)
  assert.equal(service.getErrors().length, 0)
})
