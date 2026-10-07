import type { ISubagentExecutor, SubagentExecuteExtras } from './ISubagentExecutor'
import type { ISecureStorage } from '../interfaces/ISecureStorage'
import type { TemplateSubagentForkManager } from '../orchestrator/isolation/TemplateSubagentForkManager'
import type { ToolDefinition } from '../types/models'
import { modelInfoService } from '../services/models/modelInfoService'
import { resolveCredentialId } from '../services/models/providerManager'
import { resolveApiModelId } from '../services/models/modelIdentity'
import { SelectedModelsService } from '../services/selectedModelsService'
import { getTaskRegistry } from '../services/delegation/taskRegistry'
import { getTeamRuntimeService } from '../services/team/TeamRuntimeService'
import { getDelegationContext } from '../services/delegation/delegationTools'
import { getWriteBoundary } from '../services/writeBoundary'
import { MemoryStore, memoryStore } from '../services/memory/memoryStore'
import { agentInstructions } from '../services/agentInstructions'
import { getSkillRegistry } from '../skills/SkillRegistry'
import { buildSkillSystemMessage } from '../skills/skillPromptBuilder'
import { knowledgeStore } from '../services/knowledge/knowledgeStore'
import type { SubagentRequest, SubagentResponse } from '../orchestrator/isolation/types'
import type { SubagentTemplate } from '../orchestrator/types'
import { wrapSubtaskPrompt } from '../orchestrator/rolePrompt'
import { resolveAgentToolPolicy, TOOL_POLICY_NONE, PLAN_MODE_BLOCKED_TOOLS } from '../orchestrator/toolPolicy'
import { BOARD_NOTE_CONTRACT } from '../services/board/boardTool'
import { ORCHESTRATION_TOOL_NAMES } from '../orchestrator/types'
import { getTemplateManager } from '../orchestrator/managers/SubagentTemplateManager'
import { runReviewLoop, formatReviewTrail } from './reviewLoop'
import { eventBus, EVENTS } from '../utils/eventBus'
import { admitReviewSpawn } from '../services/collab/admission'

export class StandardSubagentExecutor implements ISubagentExecutor {
  private secureStorage: ISecureStorage
  private forkManagerFactory: () => TemplateSubagentForkManager

  constructor(
    secureStorage: ISecureStorage,
    forkManagerFactory: () => TemplateSubagentForkManager
  ) {
    this.secureStorage = secureStorage
    this.forkManagerFactory = forkManagerFactory
  }

  /**
   * 当前会话模型名；SelectedModelsService 未初始化或读取异常时返回 null（落到注册表默认）
   */
  private getSessionModelName(): string | null {
    try {
      return SelectedModelsService.getInstance().getCurrentModelName()
    } catch {
      return null
    }
  }

  async execute(
    template: Record<string, unknown>,
    taskDescription: string,
    mergedParams: Record<string, unknown>,
    _startTime: number,
    tools?: ToolDefinition[],
    availableTools?: string[],
    apiKey?: string,
    baseURL?: string,
    environmentKey?: string,
    extras?: SubagentExecuteExtras
  ): Promise<Record<string, unknown>> {
    const subagentType = template.subagent_type as string
    if (!subagentType) {
      return { status: 'failed', final_output: '', error_info: { message: '模板缺少 subagent_type' } }
    }

    // 模型兜底链：委派 override > 模板 model > 当前会话模型 > 注册表默认
    const model =
      (mergedParams.model as string) ||
      (template.model as string) ||
      this.getSessionModelName() ||
      modelInfoService.getDefaultModelName()
    const info = modelInfoService.getModelInfoByName(model)
    if (!info) {
      throw new Error(
        `Model not found in ModelInfoService: ${model}. Ensure the model is registered before execution.`
      )
    }

    // 子任务场景角色包装（T3 角色与能力分离）：模板 system_prompt 只作能力描述，
    // 角色框架（"执行子任务的 Subagent"）由 wrapSubtaskPrompt 统一提供；
    // 写边界集合与状态分支随委派携带（Worker 不吃主会话注入器，与 write-boundary 注入同源）
    const writeBoundary = getWriteBoundary()
    let systemPrompt = wrapSubtaskPrompt(template as unknown as SubagentTemplate, {
      roots: writeBoundary.listWritableRoots(),
      readonly: writeBoundary.isReadonlyMode(),
      fullAccess: writeBoundary.isFullAccess(),
    })
    const userPromptTemplate = (template.user_prompt_template as string) || ''

    // AGENTS.md 项目/全局约束随委派携带（Worker 不吃主会话注入器，与写边界同源；
    // workDir 取经 DelegationContext；两级文件均不存在时返回空串、不注入机制介绍噪声）
    try {
      const agentsMd = await agentInstructions.buildSubagentInjection(getDelegationContext()?.workDir)
      if (agentsMd) systemPrompt += '\n\n' + agentsMd
    } catch { /* 读取失败不阻断任务 */ }

    // per-agent 记忆分层（委派通道：一次解析、随任务注册表登记，执行零查表）：
    // ① 全局共享记忆索引只读注入所有本地 subagent（含用户偏好层，写作/评审类任务需要贴合用户）；
    // ② 模板声明 memory 时解析三作用域目录（workDir 取经 DelegationContext——
    //    task 执行刻意不传参、由引擎按轮注册的语境通道），追加自身空间索引与读写指引
    const memoryScope = template.memory as 'user' | 'project' | 'local' | undefined
    let memoryDir: string | undefined
    const globalIndex = await memoryStore.buildIndexInjection().catch(() => null)
    if (globalIndex) {
      systemPrompt += '\n\n【全局共享记忆（只读参考）】以下是全局长期记忆索引，仅供你参考用户偏好与项目事实；不要写入它（你的写入应进自己的记忆空间，或由你判断确属用户偏好时用 scope: "global"）。\n' + globalIndex
    }
    if (memoryScope) {
      try {
        const workDir = getDelegationContext()?.workDir
        memoryDir = await memoryStore.resolveAgentMemoryDir(memoryScope, subagentType, workDir)
        const ownIndex = await MemoryStore.getScoped(memoryDir).buildIndexInjection().catch(() => null)
        systemPrompt +=
          `\n\n【你的专属记忆空间】你拥有跨会话保留的持久记忆空间（目录：${memoryDir}）。\n` +
          `- 写入/更新调用 save_memory、删除调用 delete_memory（缺省即写入你自己的空间）；用户偏好、用户纠正等"属于用户"的认知，用 scope: "global" 写入全局共享记忆。\n` +
          `- 索引中某条详情可用 read_file 读取 ${memoryDir}/<文件名>。\n` +
          (ownIndex ? `当前记忆索引：\n${ownIndex}` : '（暂无记忆）')
      } catch {
        memoryDir = undefined // 解析失败降级为无私域（不阻断任务）
      }
    }

    // per-agent 技能白名单（声明 = 有且仅有这些技能可见；元数据渐进披露——
    // 清单进上下文、read_file 读全文，与主会话同一套披露哲学，不做全文预载）
    const declaredSkills = template.skills as string[] | undefined
    if (declaredSkills && declaredSkills.length > 0) {
      try {
        const enabled = getSkillRegistry().getEnabled()
        const listed = enabled.filter((s) => declaredSkills.includes(s.name))
        const missing = declaredSkills.filter((n) => !enabled.some((s) => s.name === n))
        const skillMsg = buildSkillSystemMessage(listed)
        if (skillMsg) {
          systemPrompt += '\n\n【你可用的技能（仅以下这些）】\n' + skillMsg.content
        }
        if (missing.length > 0) {
          systemPrompt += `\n\n（模板声明的技能未安装或未启用：${missing.join(', ')}）`
        }
      } catch { /* 技能清单构建失败不阻断任务 */ }
    }

    // per-agent 知识库绑定（声明 = 仅可检索/读写绑定的库，硬边界由宿主侧知识工具复核；
    // 绑定名单随任务注册表登记 → 网关 __origin.knowledgeBases 注入，执行零查表）
    const knowledgeBases = template.knowledge as string[] | undefined
    if (knowledgeBases && knowledgeBases.length > 0) {
      try {
        const all = await knowledgeStore.listKnowledgeBases()
        const bound = all.filter((k) => knowledgeBases.includes(k.name))
        const missing = knowledgeBases.filter((n) => !all.some((k) => k.name === n))
        systemPrompt +=
          '\n\n【你绑定的知识库】你只能检索与读写以下知识库（硬边界，越界调用会被拒绝）：\n' +
          (bound.length > 0 ? bound.map((k) => `- ${k.name}${k.description ? `：${k.description}` : ''}`).join('\n') : '（暂无可用）') +
          '\n检索用 search_knowledge：不带 kb 参数时自动只在上述库内检索，或显式 kb 指定其中之一；某文档详情用 read_knowledge 读全文。' +
          (missing.length > 0 ? `\n（模板声明的知识库不存在：${missing.join(', ')}）` : '')
      } catch { /* 目录构建失败不阻断任务；绑定名单照常登记（硬边界仍生效） */ }
    }

    const resolvedBaseURL = baseURL || info.adapterConfig?.baseURL || null
    if (!resolvedBaseURL) {
      throw new Error(
        `No baseURL found for model: ${model}. adapterConfig.baseURL is required.`
      )
    }

    // key 解析与主对话同约定：统一经 resolveCredentialId（显式 credentialRealm 优先，缺省按
    // provider × 端点通道派生；P0 定域结果固化在绑定卡上，运行时不重推——与 add_model 存储名目一致）
    const resolvedApiKey =
      apiKey ||
      (await this.secureStorage.getApiKey(resolveCredentialId(info))) || ''

    // 思考控制跟模型走（宿主合并用户参数三键注入 worker；采样参数 temperature/maxTokens 仍跟任务走）
    const savedThinkingParams = (() => {
      try {
        const saved = SelectedModelsService.getInstance().getModelParameters(model) || {}
        const out: { thinking?: boolean; reasoning_effort?: string; enable_thinking?: boolean } = {}
        if (saved.thinking !== undefined) out.thinking = Boolean(saved.thinking)
        if (saved.reasoning_effort !== undefined) out.reasoning_effort = String(saved.reasoning_effort)
        if (saved.enable_thinking !== undefined) out.enable_thinking = Boolean(saved.enable_thinking)
        return out
      } catch { return {} }
    })()

    const config = {
      model,
      modelType: info.type,
      apiModelId: resolveApiModelId(info),
      adapterConfig: info.adapterConfig,
      temperature: (mergedParams.temperature as number | undefined) ?? 0.6,
      // thinking 模型的推理 token 与正文共享 maxTokens 配额——4000 会被思考耗尽导致空输出；
      // 默认按能力区分：thinking 模型 32000，其余 4000（mergedParams.maxTokens 优先）
      maxTokens: (mergedParams.maxTokens as number | undefined) ?? (info.supportsThinking ? 32000 : 4000),
      maxIterations: (mergedParams.max_iterations as number | undefined) ?? 10,
      // 模板 timeout 贯通到 fork 层（fork 硬超时与 pending 超时以此为据，缺省 600s）
      timeout: (mergedParams.timeout as number | undefined) ?? 600,
      systemPrompt,
      userPromptTemplate,
      apiKey: resolvedApiKey || undefined,
      baseURL: resolvedBaseURL,
      ...savedThinkingParams,
    }

    const forkManager = this.forkManagerFactory()
    const environment = await forkManager.createEnvironment(subagentType, config)

    // per-agent 工具解析(优先级链唯一解析点;语义事实源 = toolPolicy.ts 头部注释):
    //   Lead 显式指派(availableTools 非空)→ 覆盖模板默认;["none"] → 显式清零;混写报错
    //   未指派 → 模板默认(省略/[]/[none] = 零;[all] = 全量;名单 = 名单)
    //   模板约束(readonly/disallowed)在解析结果上再过滤(约束不参与覆盖轴)
    // typo 校验在本层:名单中的名字须存在于全量池——预过滤 toolDefinitions 后 Worker 的
    // mismatchError 拿不到原始名单会失效,故在此响亮报错(不执行)
    // 编排工具池豁免(迭代 3):授权快照授予该成员的编排工具(如 task)从编排过滤中放行——
    // 授权判定在 delegation 层(成员拉新门),此层只执行"池子别拦它"
    const grantedOrch = extras?.grantedOrchestrationTools ?? []
    const pool = (tools ?? []).map((t) => t.function?.name ?? '').filter((n) => n && (!ORCHESTRATION_TOOL_NAMES.includes(n) || grantedOrch.includes(n)))
    const toolPolicy = resolveAgentToolPolicy(template as unknown as SubagentTemplate)
    const failWithToolsError = async (message: string) => {
      await environment.destroy().catch(() => {})
      return { status: 'failed', final_output: '', error_info: { message } }
    }

    let effectiveTools: string[]
    if (availableTools && availableTools.length > 0) {
      // Lead 显式指派(覆盖模板默认)
      if (availableTools.includes(TOOL_POLICY_NONE)) {
        if (availableTools.length > 1) {
          return await failWithToolsError(
            `available_tools 语义矛盾:none(零工具)不能与其他值混写 [${availableTools.join(', ')}]。` +
            `要么 ["none"] 显式清零,要么列出具体工具名。`,
          )
        }
        effectiveTools = []
      } else {
        effectiveTools = availableTools.filter((n) => !ORCHESTRATION_TOOL_NAMES.includes(n) || grantedOrch.includes(n))
      }
    } else if (toolPolicy?.whitelist) {
      // 模板默认:名单(含零默认的空集)
      effectiveTools = [...toolPolicy.whitelist]
    } else {
      // 模板默认:不限制(policy null = 远程/[all];whitelist undefined = [all] 带约束)→ 全量剔编排
      effectiveTools = pool
    }

    // typo 校验:解析结果须全部存在于全量池
    const known = new Set(pool)
    const unknownTools = effectiveTools.filter((n) => !known.has(n))
    if (unknownTools.length > 0) {
      return await failWithToolsError(
        `工具 ${unknownTools.map((n) => `"${n}"`).join(', ')} 不存在或未在当前会话注册(注意:all/none 关键字须精确小写)。` +
        `可用工具: ${pool.join(', ')}`,
      )
    }

    // 编排豁免并集(迭代 3,授权=可用):快照授予的编排工具并入 effectiveTools——
    // 仅"过滤不剔"不够:Lead 未把 task 写进 available_tools、模板零默认时授权会落空(实测 bug)。
    // 并集在 typo 校验后(豁免名已在池内);模板约束(readonly/disallowed=模板天花板)与 plan 只读门在其后,对豁免同样生效
    if (grantedOrch.length > 0) {
      effectiveTools = [...new Set([...effectiveTools, ...grantedOrch])]
    }

    // 模板约束叠加(readonly 剔修改性工具、disallowed 黑名单;Lead 覆盖也受约束)
    if (toolPolicy) {
      effectiveTools = effectiveTools.filter(
        (n) => !(toolPolicy.readonly && PLAN_MODE_BLOCKED_TOOLS.includes(n)) && !toolPolicy.disallowed.has(n),
      )
    }
    // 计划批准门(阶段 1 只读规划):强制剔修改性工具——与模板 readonly 同款过滤,
    // 即使模板/Lead 给了修改性工具也剔(只读走确定性设施,不靠提示词祈求);
    // team 三件套(team_board/team_status/send_message)是 Worker 固定注入,不经此名单,有意保留
    if (extras?.requirePlan) {
      effectiveTools = effectiveTools.filter((n) => !PLAN_MODE_BLOCKED_TOOLS.includes(n))
    }
    // 会话看板工位契约(V1.6):board 定义经 buildWorkerToolDefinitions 进池,优先级链自然含它([all]/池默认);
    // 模板白名单/Lead 显式名单的"按名单"语义不动(toolPolicy.ts 头部注释是语义事实源)——名单未含 board 的
    // Worker 拿不到板工具,note 契约一并不注入(下方按有效集判定)

    const taskId = `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    // resume 种子续聊（extras.priorMessages 存在）时跳过 userPromptTemplate 预包装——
    // 追问是直白指令，不能再被当成新任务包装
    let userMessage = extras?.priorMessages
      ? taskDescription
      : userPromptTemplate
        ? userPromptTemplate.replace(/\{\{task_description\}\}/g, taskDescription)
        : taskDescription
    // success_criteria 贯通（此前在调度层被静默丢弃，Worker 从未收到）+ 交付证据契约：
    // 最终回复须含结果本体与验证证据——"看它证的"，不是"信它说的"
    if (extras?.successCriteria) {
      userMessage +=
        `\n\n【成功标准】\n${extras.successCriteria}` +
        '\n\n【交付要求】最终回复须包含：①结果本体（按任务描述要求的详尽度）；②验证证据（实际运行的验证命令及关键输出摘录；任务无法验证时说明原因）。'
    }
    // 团队信箱未读(种子注入的统一 drain 形态):成员开工即见全部积压消息
    if (extras?.inboxNote) {
      userMessage += extras.inboxNote
    }
    // 计划批准门(阶段 1 只读规划):规划指令——只出计划不动手,工具侧已剔修改性(双保险)
    if (extras?.requirePlan) {
      userMessage +=
        '\n\n【只读规划阶段】本阶段你只制定执行计划、不做任何修改性操作(修改性工具已被移除):' +
        '分析任务、给出执行步骤、关键取舍、风险与应对,以及预计产出形态。把完整计划作为最终回复交付——' +
        '计划经 Lead 批准后你才会带完整工具正式执行。'
    }

    // 会话看板 note 行为契约(V1.6:关键节点写 note,经 board update)——只注入 Worker 环境(fork 子进程生效),
    // 主会话不注入(ContextAssembler 侧零改动);board 经 Worker 固定注入恒可用,契约无条件注入(escalate 同款)
    systemPrompt += '\n\n' + BOARD_NOTE_CONTRACT

    // 工具定义预过滤为最终集合下发(Worker 侧严格复核为双保险;零结果 = 空定义下放,
    // Worker 见空定义直接空注册表——模型看不到任何工具,正常文本收尾)
    const effectiveDefs = effectiveTools.length === 0
      ? []
      : (tools ?? []).filter((t) => effectiveTools.includes(t.function?.name ?? ''))
    const request: SubagentRequest = {
      taskId,
      subagentType,
      subagentConfig: config,
      userMessage,
      systemPrompt,
      toolDefinitions: effectiveDefs,
      authorizedTools: effectiveTools,
      // resume 种子（原任务 transcript）：Worker 以此为对话起点续聊
      ...(extras?.priorMessages ? { priorMessages: extras.priorMessages } : {}),
      // 团队成员标记：Worker 固定注入 team_board/team_status 定义(成员资格安全判定在宿主网关)
      ...(extras?.teamMember ? { teamMember: true } : {}),
    }

    // Worker 标识上抛（cancel_task 的前提）：sendRequest await 前把 绑定键 → environment
    // 登记进任务注册表，settle 时清项；执行完自行 destroy 的现成语义不变。
    // 绑定键优先用上游透传的 toolCall.id（environmentKey，注册表条目的主键，
    // cancel_task 由此直达环境），缺省回退执行器内部 taskId（兼容未透传的调用方）
    const bindKey = environmentKey ?? taskId
    const taskRegistry = getTaskRegistry()
    taskRegistry.bindEnvironment(bindKey, environment, { memoryDir, knowledgeBases })
    // 团队信箱第三触发点(spawn 窗口闭合):环境绑定后把该成员未读逐条入 steer 队列,
    // 首个工具响应即捎带送达——spawn 窗口内到达的消息不等"下一次互动"
    const teamSvc = getTeamRuntimeService()
    if (teamSvc?.isMemberTask(bindKey)) {
      const memberName = teamSvc.getMemberNameByTaskId(bindKey)
      if (memberName) {
        const unread = await teamSvc.drainInbox(memberName)
        for (const m of unread) {
          taskRegistry.enqueueSteer(bindKey, m.content)
        }
      }
    }
    try {
      const response: SubagentResponse = await environment.sendRequest(request)
      await environment.destroy()
      if (!response.success) {
        return {
          status: 'failed',
          final_output: '',
          error_info: { message: response.error || '未知错误' },
        }
      }

      let finalOutput = response.output || ''
      let finalTranscript = response.conversation

      // 验证闭环（require_review）：独立评审 agent 核验证据，不达标打回修正（transcript 续聊），
      // 轮次封顶。评审/修正的子执行直接复用本类（不经 delegation 层，resume 空间不留痕）
      // 统一协作基板(迭代 3):caller='system:review' 显式准入——不计配额不计账本(现状语义钉死,MAX_REVIEW_ROUNDS 封顶)
      admitReviewSpawn()
      if (extras?.requireReview) {
        const loopResult = await runReviewLoop({
          taskDescription,
          successCriteria: extras.successCriteria,
          initialOutput: finalOutput,
          initialTranscript: finalTranscript ?? [],
          runReview: async (reviewTask) => {
            const reviewerTemplate = getTemplateManager().getTemplateByType('reviewer')
            if (!reviewerTemplate) {
              return { success: false, error: '内置 reviewer 模板不存在' }
            }
            const reviewResult = await this.execute(
              reviewerTemplate as unknown as Record<string, unknown>,
              reviewTask,
              {},
              _startTime,
              tools,
              undefined,
              apiKey,
              baseURL
            )
            return reviewResult.status === 'completed'
              ? { success: true, output: reviewResult.final_output as string }
              : { success: false, error: (reviewResult.error_info as { message?: string })?.message || '评审执行失败' }
          },
          runRework: async (priorMessages, reworkInstruction) => {
            const reworkResult = await this.execute(
              template,
              reworkInstruction,
              mergedParams,
              _startTime,
              tools,
              availableTools,
              apiKey,
              baseURL,
              undefined,
              { priorMessages }
            )
            return reworkResult.status === 'completed'
              ? {
                  success: true,
                  output: reworkResult.final_output as string,
                  conversation: reworkResult.conversation as unknown[] | undefined,
                }
              : { success: false, error: (reworkResult.error_info as { message?: string })?.message || '修正执行失败' }
          },
          onReviewRound: (round) => {
            eventBus.emit(EVENTS.SUBAGENT_TASK_REVIEW, {
              taskId,
              subagentType,
              round: round.round,
              verdict: round.verdict,
              feedback: round.feedback,
            })
          },
        })
        finalOutput = loopResult.finalOutput + formatReviewTrail(loopResult.trail, loopResult.passed)
        if (loopResult.finalTranscript.length > 0) {
          finalTranscript = loopResult.finalTranscript
        }
      }

      // 计划批准门:阶段 1 输出加"待批准"语义前缀与批准动词指引——
      // settle 通知不把"待批准"误读为"已完成",Lead 也知道用哪个动词(引导路径)
      if (extras?.requirePlan) {
        finalOutput =
          `【待批准的计划】以下为只读规划阶段的计划,尚未执行。\n\n${finalOutput}` +
          `\n\n——\nLead 请用 approve_plan(task_id, approved, feedback?) 批准开工或打回修订(最多两轮);不处理则保持待批准。`
      }

      return {
        status: 'completed',
        final_output: finalOutput,
        // transcript 顺流带出（resume_task 留存载体；评审回路后为含修正轮的最新对话）
        ...(finalTranscript ? { conversation: finalTranscript } : {}),
        // 计量中间件:Worker tokenUsage 顺流带出让 settle 统一回写入账(断点修复:此前成功返回丢弃计量数据);
        // 估值标记透传(账本 estimated 单向置位);失败路径不带 resource_usage(无入账语义)
        resource_usage: {
          tokens_used: response.tokenUsage?.total,
          ...(response.tokenUsage?.estimated ? { tokens_estimated: true } : {}),
          iterations: response.iterations,
          execution_time: Date.now() - _startTime,
        },
      }
    } catch (err) {
      await environment.destroy().catch(() => {})
      return {
        status: 'failed',
        final_output: '',
        error_info: {
          message: err instanceof Error ? err.message : String(err),
        },
      }
    } finally {
      taskRegistry.unbindEnvironment(bindKey)
    }
  }
}
