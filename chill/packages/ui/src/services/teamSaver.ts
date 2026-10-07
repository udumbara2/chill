/**
 * 团队文件保存/删除助手(TeamEditor 与侧栏共用;templateSaver 同模式)
 *
 * 用户级写 `~/.chill/teams/`(electron 主进程 teams watcher 自动重载推送);
 * 项目级写 `<workDir>/.agents/teams/` 后触发 reloadTeamAssets。
 */

import { ElectronIPCFileSystemProvider } from '../adapters/ElectronIPCFileSystemProvider'
import { getUserTeamsDir, reloadTeamAssets } from './teamAssetService'
import { getEngineWorkDir } from './chatEngine'

const fsProvider = new ElectronIPCFileSystemProvider()

/** 保存团队文件(用户级/项目级;保存后触发重扫生效) */
export async function saveTeamFile(payload: { slug: string; storage: 'user' | 'project'; content: string }): Promise<void> {
  const workDir = getEngineWorkDir()
  const dir = payload.storage === 'project' && workDir ? `${workDir}/.agents/teams` : await getUserTeamsDir()
  const result = await fsProvider.writeFile(`${dir}/${payload.slug}.yaml`, payload.content)
  if (!result.success) throw new Error(result.error ?? '团队保存失败')
  await reloadTeamAssets()
}

/** 删除团队文件(删除后触发重扫生效) */
export async function deleteTeamFile(path: string): Promise<void> {
  const result = await fsProvider.deleteFile(path)
  if (!result.success) throw new Error(result.error ?? '团队删除失败')
  await reloadTeamAssets()
}
