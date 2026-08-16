import type { CliContext } from '../context/CliContext.js'
import {
  WorkflowPersistence,
  compileWorkflow,
  executeWorkflow,
} from '@assistant-ai/core'

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
        await this.run(parts[1])
        break
      default:
        process.stdout.write(`未知 workflow 命令: ${sub}\n`)
        process.stdout.write('可用命令: list, run <id>\n')
    }
  }

  private async list(): Promise<void> {
    const persistence = new WorkflowPersistence(this.ctx.pathProvider)
    const result = await persistence.listWorkflows()
    if (!result.success || !result.workflows || result.workflows.length === 0) {
      process.stdout.write('暂无保存的工作流\n')
      return
    }

    process.stdout.write('ID                          名称                    更新时间\n')
    process.stdout.write('--                          ----                    --------\n')
    for (const wf of result.workflows) {
      const date = new Date(wf.updatedAt).toLocaleString()
      process.stdout.write(`  ${wf.id.padEnd(26)} ${wf.name.padEnd(22)} ${date}\n`)
    }
  }

  private async run(id?: string): Promise<void> {
    if (!id) {
      process.stdout.write('用法: run <workflow ID>\n')
      return
    }

    const persistence = new WorkflowPersistence(this.ctx.pathProvider)
    const loadResult = await persistence.loadWorkflow(id)

    if (!loadResult.success || !loadResult.workflow) {
      process.stdout.write(`加载工作流失败: ${loadResult.error || '未找到'}\n`)
      return
    }

    const wf = loadResult.workflow as Record<string, any>

    if (!wf.nodes || !Array.isArray(wf.nodes)) {
      process.stdout.write('工作流中没有节点定义\n')
      return
    }

    try {
      const compiled = compileWorkflow(wf.nodes, wf.edges || [])
      process.stdout.write(`工作流 "${wf.metadata?.name || id}" 编译成功，开始执行...\n`)

      const sessionId = `cli_${Date.now()}`
      await executeWorkflow(compiled.graph, {}, sessionId)

      process.stdout.write('工作流执行完成\n')
    } catch (err: any) {
      process.stdout.write(`工作流执行失败: ${err?.message || err}\n`)
    }
  }
}
