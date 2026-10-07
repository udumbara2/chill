import { useProjectStore } from '../stores/projectStore'
import { tryGetHostAPI } from '../host/hostApi'

/**
 * 项目文件夹选择共享通道（原 WorkspacePanel 本地函数原样搬运）：
 * 面板「绑定/换绑文件夹」与新建会话选择器「新建项目…」行内表单共用。
 * 非宿主环境（HostAPI 缺失）返回 null，调用方按"未选"处理。
 */
export const useProjectFolderPicker = () => {
  const projectStore = useProjectStore()

  /** 系统对话框选目录 + 宿主侧存在/目录判定（零新增通道，复用 dialog:showOpenDialog / file:get-path-type） */
  const pickFolder = async (): Promise<string | null> => {
    const api = tryGetHostAPI()
    if (!api?.showOpenDialog || !api?.getPathType) return null
    const dialog = await api.showOpenDialog({ properties: ['openDirectory'] })
    const folderPath: string | undefined = dialog?.success ? dialog.result?.filePaths?.[0] : undefined
    if (!folderPath) return null // 取消或失败
    const check = await api.getPathType(folderPath)
    if (!check?.success || check.type !== 'directory') {
      alert(`所选路径不可用：${check?.error || '不是有效目录'}`)
      return null
    }
    return folderPath
  }

  /** 重复绑定检查：命中则告知已绑定项目名并阻止 */
  const isDuplicateFolder = (folderPath: string, excludeProjectId?: string): boolean => {
    const holder = projectStore.projectBoundToFolder(folderPath, excludeProjectId)
    if (holder) {
      alert(`该文件夹已被项目「${holder.name}」绑定`)
      return true
    }
    return false
  }

  return { pickFolder, isDuplicateFolder }
}
