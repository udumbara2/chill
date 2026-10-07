/**
 * Agent 模板保存/删除助手（ModelSettings 的 Agent 编辑器与 WorkflowView 单节点改道共用）。
 *
 * 生效语义：用户级写 `~/.chill/agents/templates/`（electron 主进程 fs.watch 自动重载推送）；
 * 项目级写 `<workDir>/.agents/agents/` 后触发 rescanProjectTemplates。
 */

import { ElectronIPCFileSystemProvider } from '../adapters/ElectronIPCFileSystemProvider'
import { rescanProjectTemplates } from './agentTemplateService'
import { getEngineWorkDir } from './chatEngine'
import { getHostAPI } from '../host/hostApi'

const fsProvider = new ElectronIPCFileSystemProvider()
let userTemplatesDirCache: string | null = null

/** 用户级模板目录（`~/.chill/agents/templates/`；缓存） */
export async function getUserTemplatesDir(): Promise<string> {
  if (!userTemplatesDirCache) {
    // IPC 返回 { success, path } 对象（main.ts 同款解包）；直接插值会得到 "[object Object]/agents/templates"
    const res: any = await getHostAPI().getUserDataPath()
    const base = typeof res === 'string' ? res : res?.path
    userTemplatesDirCache = `${base}/agents/templates`
  }
  return userTemplatesDirCache
}

/** 保存模板文件（用户级/项目级；项目级保存后触发重扫生效） */
export async function saveTemplateFile(payload: { slug: string; storage: 'user' | 'project'; content: string }): Promise<void> {
  const workDir = getEngineWorkDir()
  const dir = payload.storage === 'project' && workDir ? `${workDir}/.agents/agents` : await getUserTemplatesDir()
  const result = await fsProvider.writeFile(`${dir}/${payload.slug}.md`, payload.content)
  if (!result.success) throw new Error(result.error ?? '模板保存失败')
  if (payload.storage === 'project') {
    await rescanProjectTemplates(workDir)
  }
}

/** 删除模板文件（项目级删除后触发重扫生效） */
export async function deleteTemplateFile(path: string, level: 'user' | 'project'): Promise<void> {
  const result = await fsProvider.deleteFile(path)
  if (!result.success) throw new Error(result.error ?? '模板删除失败')
  if (level === 'project') {
    await rescanProjectTemplates(getEngineWorkDir())
  }
}
