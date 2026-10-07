import type { CliContext } from '../context/CliContext.js'
import { executeRunWorkflow } from '@assistant-ai/core'

/**
 * CLI /workflow 模式(M5 改道 YAML 真相源):
 * list = 列出命名工作流(用户级+项目级);run <name> [输入文本] = 按名执行。
 * run 复用 run_workflow 工具的 sync 执行路径(同一引擎、同一工具执行器、同一校验),
 * 不另造执行通道。
 */
export class CliWorkflowService {
  private ctx: CliContext

  constructor(ctx: CliContext) {
    this.ctx = ctx
  }

  async handleCommand(input: string): Promise<void> {
    const parts = input.trim().split(/\s+/)
    const sub = parts[0]

    switch (sub) {
      case 'list':
        await this.list()
        break
      case 'run':
        await this.run(parts[1], parts.slice(2).join(' '))
        break
      case 'runs':
        await this.runs()
        break
      default:
        process.stdout.write(`未知 workflow 命令: ${sub}\n`)
        process.stdout.write('可用命令: list, run <name> [输入文本], runs\n')
    }
  }

  /** 运行记录(M6 执行历史;断点续跑的 resume_from 来源) */
  private async runs(): Promise<void> {
    const store = this.ctx.workflowRunStore
    const records = (await store?.list()) ?? []
    if (records.length === 0) {
      process.stdout.write('暂无运行记录\n')
      return
    }
    for (const r of records.slice(0, 20)) {
      const done = r.completedNodes.length
      process.stdout.write(
        `  ${r.runId}  ${r.workflowName}  [${r.status}]  已完成节点 ${done}  ${new Date(r.startedAt).toLocaleString()}\n`,
      )
    }
    process.stdout.write('续跑:在对话中说"用 run_workflow 续跑 <runId>"(resume_from 参数)\n')
  }

  private async list(): Promise<void> {
    const svc = this.ctx.workflowTemplateService
    const workflows = svc?.getAllWorkflows() ?? []
    if (workflows.length === 0) {
      process.stdout.write('暂无命名工作流(~/.chill/workflows/ 或项目 .agents/workflows/ 下的 .yaml)\n')
    } else {
      for (const w of workflows) {
        const scope = w.scope === 'project' ? '项目' : '个人'
        const inputs = (w.inputs ?? []).map((i: any) => `${i.name}${i.required ? '(必填)' : ''}`).join(', ')
        process.stdout.write(`  ${w.name}  ${w.title ?? ''}  [${scope}]  ${w.description ?? ''}${inputs ? `  入参: ${inputs}` : ''}\n`)
      }
    }
    for (const err of svc?.getErrors() ?? []) {
      process.stdout.write(`⚠ ${err}\n`)
    }
  }

  private async run(name?: string, inputText?: string): Promise<void> {
    if (!name) {
      process.stdout.write('用法: run <工作流调用键> [输入文本]\n')
      return
    }
    // 入参:第一个 text 入参收命令行文本
    const def = this.ctx.workflowTemplateService?.getWorkflowByName(name)
    const input: Record<string, any> = {}
    if (def && inputText) {
      const firstText = (def.inputs ?? []).find((i: any) => i.type !== 'file')
      if (firstText) input[firstText.name] = inputText
    }

    process.stdout.write(`工作流 "${name}" 开始执行...\n`)
    const result = await executeRunWorkflow(`cli_wf_${Date.now()}`, { name, input }, { sync: true })
    if (result.success) {
      process.stdout.write(`工作流执行完成\n${result.content ?? '(无输出)'}\n`)
    } else {
      process.stdout.write(`工作流执行失败: ${result.error}\n`)
    }
  }
}
