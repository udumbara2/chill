/**
 * Skill元数据，对应SKILL.md解析后的完整信息
 */
export interface SkillMeta {
  /** SKILL.md中name字段 */
  name: string
  /** SKILL.md中description字段 */
  description: string
  /** SKILL.md正文内容（Markdown body） */
  body: string
  /** SKILL.md文件的绝对路径，供AI通过read_file读取 */
  sourcePath: string
  /** skill目录的绝对路径（即SKILL.md所在目录） */
  basePath: string
  /** skill目录下实际存在的资源子目录名（scripts、references、assets的组合），无资源时为空数组或undefined */
  availableDirs?: string[]
  /** SKILL.md中compatibility字段——技能需要的环境条件（≤500字符），AI自行判断是否满足 */
  compatibility?: string
  /** SKILL.md中allowed-tools字段——预授权的工具白名单（Codex模式：免审批，非硬约束） */
  allowedTools?: string[]
}
