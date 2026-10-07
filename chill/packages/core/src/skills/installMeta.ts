import { join } from 'path'
import type { IFileSystemProvider } from '../interfaces/IFileSystemProvider'
import type { InstallMeta } from './installTypes'

const META_FILE = '.install-meta.json'

/**
 * 读取 skill 目录下的 .install-meta.json
 * @returns InstallMeta 或 null（不存在或读取失败）
 */
export async function readInstallMeta(
  dir: string,
  fsProvider: IFileSystemProvider,
): Promise<InstallMeta | null> {
  const metaPath = join(dir, META_FILE)
  const existsResult = await fsProvider.fileExists(metaPath)
  if (!existsResult?.success || existsResult?.data !== true) {
    return null
  }

  const readResult = await fsProvider.readFile(metaPath)
  if (!readResult?.success || !readResult?.data?.content) {
    return null
  }

  try {
    const meta: InstallMeta = JSON.parse(readResult.data.content)
    return meta
  } catch {
    return null
  }
}

/**
 * 写入 skill 目录下的 .install-meta.json
 */
export async function writeInstallMeta(
  dir: string,
  meta: InstallMeta,
  fsProvider: IFileSystemProvider,
): Promise<void> {
  const metaPath = join(dir, META_FILE)
  await fsProvider.writeFile(metaPath, JSON.stringify(meta, null, 2))
}
