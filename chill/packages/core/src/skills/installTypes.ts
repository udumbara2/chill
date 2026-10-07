/**
 * 安装元信息类型
 * 存储在 skill 目录下的 .install-meta.json 中，用于区分外部安装的 skill 和本地手动创建的 skill
 */
export interface InstallMeta {
  /** 安装来源类型：本地路径或 Git 仓库 */
  sourceType: 'local' | 'git' | 'archive'
  /** 来源路径（本地路径或 Git URL） */
  sourcePath: string
  /** 安装时间（ISO 8601 格式） */
  installedAt: string
  /** Git 仓库中的子目录路径（仅 sourceType='git' 时有效） */
  subPath?: string
}
