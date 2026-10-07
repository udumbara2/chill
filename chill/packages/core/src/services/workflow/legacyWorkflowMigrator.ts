/**
 * 旧资产一次性迁移器(M3)
 *
 * 把两类旧格式资产迁移为 YAML 工作流(唯一真相源):
 * - SavedWorkflow:<userData>/workflows/<id>.json(画布存档,模型不可见)
 * - 多节点 SavedAgent:<userData>/agents/local/<id>.json(execute_local_agent_* 通道)
 *   (单节点 SavedAgent 另有 savedAgentToTemplate → 单 Agent 模板迁移器,不在此处)
 *
 * 语义:转换成功 → 写 YAML 到用户级工作流目录 → 删除源 JSON(随迁不复制);
 * 同名 YAML 已存在时跳过写入但仍删除源?——不,跳过且保留源,交由用户处置(防误删)。
 * 幂等:源删除后重跑无副作用。
 */

import type { IFileSystemProvider } from '../../interfaces/IFileSystemProvider'
import { canvasToDefinition, definitionToYaml } from '../../workflow/dsl/workflowSerializer'
import { parseWorkflowDefinition } from '../../workflow/dsl/workflowParser'
import { WORKFLOW_DSL_VERSION, WORKFLOW_NAME_PATTERN, WORKFLOW_NODE_ID_PATTERN } from '../../workflow/dsl/types'
import type { WorkflowDefinition } from '../../workflow/dsl/types'
import type { Edge, ConditionalEdge } from '../../types/edge'
import { EdgeType } from '../../types/edge'
import type { WorkflowNode } from '../../types/workflow'
import { validateSubagentType } from '../../orchestrator/parsers/TemplateParser'
import { serializeTemplate } from '../../orchestrator/parsers/templateSerializer'
import { TemplatePriority, type SubagentTemplate } from '../../orchestrator/types'

export interface LegacyMigrationReport {
  migrated: string[]
  skipped: string[]
  errors: string[]
}

/** 名称 → kebab-case 调用键;无法推导(纯中文等)时用确定性兜底键 */
export function slugifyWorkflowKey(name: string, fallbackSeed: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
  if (slug && WORKFLOW_NAME_PATTERN.test(slug)) return slug
  const seed = fallbackSeed.toLowerCase().replace(/[^a-z0-9]+/g, '')
  return `wf-${seed || 'legacy'}`
}

/** 旧版条件边(data.condition 无 branches)归一化为 branches 格式(与引擎 legacy 路径同语义) */
function normalizeLegacyEdges(edges: any[]): Edge[] {
  return edges.map((e) => {
    if (e?.type === EdgeType.CONDITIONAL && e.data && !Array.isArray(e.data.branches) && e.data.condition) {
      return {
        ...e,
        data: {
          ...e.data,
          branches: [
            {
              id: 'legacy_branch',
              label: e.data.label ?? '条件分支',
              condition: e.data.condition,
              targetNodeId: e.target,
              priority: 0,
              maxIterations: e.data.maxIterations,
            },
          ],
          fallbackNodeId: e.data.condition.fallback ?? e.data.fallbackNodeId,
        },
      } as ConditionalEdge
    }
    return e
  })
}

/** 旧图(SavedWorkflow/SavedAgent 的 nodes+edges)→ WorkflowDefinition */
export function legacyGraphToDefinition(
  nodes: WorkflowNode[],
  edges: Edge[],
  meta: { name: string; title?: string; description?: string },
): WorkflowDefinition {
  const { nodes: saneNodes, edges: saneEdges } = sanitizeLegacyNodeIds(nodes, edges)
  return canvasToDefinition(saneNodes, normalizeLegacyEdges(saneEdges), {
    name: meta.name,
    title: meta.title,
    version: WORKFLOW_DSL_VERSION,
    description: meta.description,
    when_to_use: undefined,
    inputs: [{ name: 'input', type: 'text', required: false }],
  })
}

/**
 * 旧画布节点 id 合法化:真实存量里存在数字/时间戳 id(如 "2"),不满足 DSL 语义 id 规范。
 * 确定性映射为合法 id(字母开头、非法字符转下划线、冲突加后缀),并同步改写边的
 * source/target 与条件边的 branches.targetNodeId / fallbackNodeId 引用。
 */
export function sanitizeLegacyNodeIds(
  nodes: WorkflowNode[],
  edges: Edge[],
): { nodes: WorkflowNode[]; edges: Edge[] } {
  const idMap = new Map<string, string>()
  const used = new Set<string>()
  for (const n of nodes) {
    const id = String(n.id)
    if (WORKFLOW_NODE_ID_PATTERN.test(id) && !used.has(id)) {
      used.add(id)
      continue
    }
    let candidate = `n${id.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase()}`
    if (!/^[a-z]/.test(candidate)) candidate = `n${candidate}`
    let final = candidate
    let suffix = 2
    while (used.has(final)) {
      final = `${candidate}_${suffix++}`
    }
    idMap.set(id, final)
    used.add(final)
  }
  if (idMap.size === 0) return { nodes, edges }

  const mappedNodes = nodes.map((n) => (idMap.has(String(n.id)) ? { ...n, id: idMap.get(String(n.id))! } : n))
  const mapRef = (ref: any) => (typeof ref === 'string' && idMap.has(ref) ? idMap.get(ref)! : ref)
  const mappedEdges = edges.map((e: any) => {
    const next = { ...e, source: mapRef(e.source), target: mapRef(e.target) }
    if (e.data) {
      next.data = {
        ...e.data,
        fallbackNodeId: mapRef(e.data.fallbackNodeId),
        branches: Array.isArray(e.data.branches)
          ? e.data.branches.map((b: any) => ({ ...b, targetNodeId: mapRef(b.targetNodeId) }))
          : e.data.branches,
      }
    }
    return next
  })
  return { nodes: mappedNodes, edges: mappedEdges }
}

interface JsonAsset {
  path: string
  data: any
}

/** 判定:仅含单个 model 节点的旧 SavedAgent 图(归单 Agent 模板通道) */
function isSingleModelNodeGraph(nodes: any[]): boolean {
  return nodes.length === 1 && nodes[0]?.type === 'model'
}

/**
 * 单节点 SavedAgent(原始 JSON 形态)→ 单 Agent 模板 Markdown
 * (自 savedAgentMigrator 移植,随 SavedAgent 类型退役收编到本迁移器)
 */
function singleNodeAgentToTemplateMarkdown(data: any): { slug: string; content: string } {
  const node = data.nodes[0]
  const d = node.data ?? {}
  const toolNames = (d.selectedTools ?? [])
    .map((t: any) => t?.function?.name)
    .filter((n: unknown): n is string => typeof n === 'string' && n.length > 0)
  const name: string = data?.metadata?.name ?? 'migrated-agent'
  const slugRaw = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
  const slug = validateSubagentType(slugRaw) ? slugRaw : 'migrated-agent'
  const template: SubagentTemplate = {
    name,
    description: data?.metadata?.description ?? data?.metadata?.agentCard?.description ?? '',
    subagent_type: slug,
    system_prompt: d.systemPrompt ?? '',
    priority: TemplatePriority.BUILTIN, // 与 parseTemplate 缺省一致(用户级模板经 setCustomTemplates 规范化覆盖)
    ...(d.selectedModel?.name ? { model: d.selectedModel.name } : {}),
    ...(toolNames.length > 0 ? { tools: toolNames } : {}),
  }
  return { slug, content: serializeTemplate(template) }
}

async function readJsonAssets(fs: IFileSystemProvider, dir: string): Promise<{ assets: JsonAsset[]; errors: string[] }> {
  const assets: JsonAsset[] = []
  const errors: string[] = []
  const list = await fs.listDirectory(dir)
  if (!list.success || !list.data) return { assets, errors }
  const files: Array<{ name: string }> = list.data.files || []
  for (const f of files.filter((f) => f.name.endsWith('.json'))) {
    const path = `${dir}/${f.name}`
    const read = await fs.readFile(path)
    if (!read.success || !read.data) {
      errors.push(`旧资产读取失败: ${path}`)
      continue
    }
    try {
      assets.push({ path, data: JSON.parse(read.data.content) })
    } catch (e: any) {
      errors.push(`旧资产 JSON 解析失败: ${path}(${e?.message ?? e})`)
    }
  }
  return { assets, errors }
}

/**
 * 执行迁移:legacyWorkflowsDir(SavedWorkflow)+ legacyAgentsDir(SavedAgent)→ targetDir(YAML);
 * agentsDir 中的单节点 SavedAgent → templatesDir(单 Agent 模板 .md;未提供时跳过)。
 * 语义:转换成功 → 写目标 → 删除源 JSON(随迁不复制);目标已存在则跳过且保留源。
 * 幂等:源删除后重跑无副作用。
 */
export async function migrateLegacyWorkflowAssets(
  fs: IFileSystemProvider,
  opts: {
    legacyWorkflowsDir: string
    legacyAgentsDir?: string
    targetDir: string
    /** 单 Agent 模板目录(~/.chill/agents/templates/);提供时单节点 SavedAgent 迁移为模板 */
    templatesDir?: string
  },
): Promise<LegacyMigrationReport> {
  const report: LegacyMigrationReport = { migrated: [], skipped: [], errors: [] }

  const sources: Array<{ dir: string; kind: 'workflow' | 'agent' }> = [
    { dir: opts.legacyWorkflowsDir, kind: 'workflow' },
  ]
  if (opts.legacyAgentsDir) sources.push({ dir: opts.legacyAgentsDir, kind: 'agent' })

  for (const source of sources) {
    const { assets, errors } = await readJsonAssets(fs, source.dir)
    report.errors.push(...errors)

    for (const asset of assets) {
      try {
        const data = asset.data
        const nodes: WorkflowNode[] = data?.nodes ?? []
        const edges: Edge[] = data?.edges ?? []
        const displayName: string = data?.metadata?.name ?? '未命名工作流'
        const legacyId: string = String(data?.metadata?.id ?? 'legacy')

        // SavedAgent 单节点 → 单 Agent 模板通道(收编自 savedAgentMigrator)
        if (source.kind === 'agent' && isSingleModelNodeGraph(nodes)) {
          if (!opts.templatesDir) {
            report.skipped.push(`${displayName}(单节点,未提供模板目录)`)
            continue
          }
          const { slug, content } = singleNodeAgentToTemplateMarkdown(data)
          const templatePath = `${opts.templatesDir}/${slug}.md`
          const exists = await fs.fileExists(templatePath)
          if (exists.success && exists.data === true) {
            // 目标模板已存在 = 源已被取代:删除源 JSON 收敛(防"删了模板又被复活")
            await fs.deleteFile(asset.path)
            report.skipped.push(`${displayName}(模板 ${slug}.md 已存在,源已收敛)`)
            continue
          }
          const write = await fs.writeFile(templatePath, content)
          if (!write.success) {
            report.errors.push(`迁移写入失败: ${templatePath}${write.error ? `(${write.error})` : ''}`)
            continue
          }
          await fs.deleteFile(asset.path)
          report.migrated.push(`${displayName} → 模板 ${slug}.md`)
          continue
        }
        if (nodes.filter((n) => n.type !== 'start').length === 0) {
          report.skipped.push(`${displayName}(空图)`)
          continue
        }

        const key = slugifyWorkflowKey(displayName, legacyId)
        const targetPath = `${opts.targetDir}/${key}.yaml`

        // 目标已存在:校验目标可解析 → 源已被取代,删除源 JSON 收敛(防"删了 YAML 又被迁移器复活");
        // 目标解析失败(用户改坏了)才保留源、报错误可见
        const exists = await fs.fileExists(targetPath)
        if (exists.success && exists.data === true) {
          const targetRead = await fs.readFile(targetPath)
          const targetOk = targetRead.success && targetRead.data && parseWorkflowDefinition(targetRead.data.content, targetPath).success
          if (targetOk) {
            await fs.deleteFile(asset.path)
            report.skipped.push(`${displayName}(目标 ${key}.yaml 已存在,源已收敛)`)
          } else {
            report.errors.push(`目标 ${key}.yaml 已存在但解析失败,迁移跳过且源保留: ${displayName}`)
          }
          continue
        }

        const def = legacyGraphToDefinition(nodes, edges, {
          name: key,
          title: displayName,
          description: data?.metadata?.description,
        })
        const yaml = definitionToYaml(def)

        // 写后校验:能解析回来才落盘删源
        const check = parseWorkflowDefinition(yaml, targetPath)
        if (!check.success) {
          report.errors.push(`迁移校验失败: ${displayName} → ${targetPath}:${check.error}`)
          continue
        }

        const write = await fs.writeFile(targetPath, yaml)
        if (!write.success) {
          report.errors.push(`迁移写入失败: ${targetPath}${write.error ? `(${write.error})` : ''}`)
          continue
        }
        await fs.deleteFile(asset.path)
        report.migrated.push(`${displayName} → ${key}.yaml`)
      } catch (e: any) {
        report.errors.push(`迁移失败: ${asset.path}(${e?.message ?? e})`)
      }
    }
  }

  return report
}
