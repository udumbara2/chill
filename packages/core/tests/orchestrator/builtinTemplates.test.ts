import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FileSystemTemplateLoader } from '../../src/orchestrator/FileSystemTemplateLoader.ts'
import type { IFileSystemProvider } from '../../src/interfaces/IFileSystemProvider.ts'

/** 基于 node:fs 的最小 IFileSystemProvider（FileSystemTemplateLoader 只用到 listDirectory / readFile） */
const nodeFs = {
  listDirectory: async (dir: string) => ({
    success: true,
    data: {
      files: fs
        .readdirSync(dir, { withFileTypes: true })
        .map((d) => ({ name: d.name, type: d.isDirectory() ? 'directory' : 'file' })),
    },
  }),
  readFile: async (p: string) => ({ success: true, data: { content: fs.readFileSync(p, 'utf8') } }),
} as unknown as IFileSystemProvider

const builtinDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../src/orchestrator/templates/builtin'
)

test('内置模板: 加载器加载 3 个内置模板，frontmatter 均无 model 字段（默认跟随会话模型）', async () => {
  const loader = new FileSystemTemplateLoader(nodeFs, builtinDir)
  const templates = await loader.loadBuiltinTemplates()
  assert.equal(templates.length, 3)
  assert.deepEqual(
    templates.map((t) => t.subagent_type).sort(),
    ['code-reviewer', 'document-writer', 'general-purpose']
  )
  for (const template of templates) {
    assert.equal(template.model, undefined, `${template.subagent_type} 不应硬编码 model`)
  }
})
