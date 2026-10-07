import type { SubagentTemplate, TemplatePriority, TemplateType } from '../../types'
import type { ITemplateLoader } from '../../../interfaces/ITemplateLoader'

/**
 * 硬编码的默认内置模板数据
 * 当 ITemplateLoader 未提供或加载失败时使用
 */
const DEFAULT_BUILTIN_TEMPLATES: SubagentTemplate[] = [
  {
    name: '通用基础模板',
    description: '系统预置通用模板，支持全量参数覆盖，可实例化自定义功能的Subagent',
    subagent_type: 'general-purpose',
    priority: 3 as TemplatePriority.BUILTIN, // BUILTIN = 3
    type: 'builtin' as TemplateType.BUILTIN,
    tools: ['all'], // 显式全量(省略=零工具的统一默认下保持原行为)
    parameters: {
      max_iterations: {
        name: 'max_iterations',
        type: 'number',
        description: '最大迭代次数',
        required: false,
        default: 10,
      },
      token_budget: {
        name: 'token_budget',
        type: 'number',
        description: 'Token预算',
        required: false,
        default: 200000,
      },
      timeout: {
        name: 'timeout',
        type: 'number',
        description: '超时时间（秒）',
        required: false,
        default: 600,
      },
      temperature: {
        name: 'temperature',
        type: 'number',
        description: '温度参数',
        required: false,
        default: 0.5,
      },
    },
    system_prompt: `通用基础 Subagent 的能力说明（角色由使用场景包装：被 task 委派时为子任务执行者，被选为前台时直接面对用户）：

1. **核心职责**：处理各类通用原子任务，适配文本处理、简单推理、工具调用等场景；
2. **参数约束**：迭代次数不超过{{max_iterations}}，token消耗不超过{{token_budget}}；
3. **输出要求**：结果简洁、结构化，符合调用方指定的格式；
4. **权限边界**：仅使用配置中允许的工具，不执行未授权操作。`,
    version: '1.0.0',
    author: 'system',
    tags: ['general', 'builtin', 'base'],
  },
  {
    name: '代码审查专家',
    description: '专注于代码审查、重构建议和最佳实践检查的Subagent',
    subagent_type: 'code-reviewer',
    priority: 3 as TemplatePriority.BUILTIN,
    type: 'builtin' as TemplateType.BUILTIN,
    tools: ['all'], // 显式全量(省略=零工具的统一默认下保持原行为)
    parameters: {
      max_iterations: {
        name: 'max_iterations',
        type: 'number',
        description: '最大迭代次数',
        required: false,
        default: 5,
      },
      token_budget: {
        name: 'token_budget',
        type: 'number',
        description: 'Token预算',
        required: false,
        default: 100000,
      },
      timeout: {
        name: 'timeout',
        type: 'number',
        description: '超时时间（秒）',
        required: false,
        default: 300,
      },
      temperature: {
        name: 'temperature',
        type: 'number',
        description: '温度参数',
        required: false,
        default: 0.3,
      },
      review_depth: {
        name: 'review_depth',
        type: 'string',
        description: '审查深度',
        required: false,
        default: 'detailed',
      },
      check_security: {
        name: 'check_security',
        type: 'boolean',
        description: '是否检查安全问题',
        required: false,
        default: true,
      },
      check_performance: {
        name: 'check_performance',
        type: 'boolean',
        description: '是否检查性能问题',
        required: false,
        default: true,
      },
    },
    system_prompt: `你是代码审查专家Subagent，专注于提供高质量的代码审查服务。

## 核心职责

1. **代码质量检查**：识别代码中的潜在问题、坏味道和技术债务
2. **安全审计**：检查常见的安全漏洞（SQL注入、XSS、敏感信息泄露等）
3. **性能优化**：识别性能瓶颈，提供优化建议
4. **最佳实践**：确保代码符合语言/框架的最佳实践

## 审查维度

- **可读性**：命名规范、代码结构、注释质量
- **可维护性**：模块化程度、耦合度、重复代码
- **安全性**：输入验证、权限控制、数据保护
- **性能**：算法复杂度、资源使用、缓存策略

## 输出格式

请以结构化方式输出审查结果：
- **严重问题**：必须修复的安全或功能问题
- **建议改进**：提升代码质量的建议
- **正面反馈**：代码中的优秀实践`,
    version: '1.0.0',
    author: 'system',
    tags: ['code', 'review', 'quality', 'security'],
  },
  {
    name: '文档撰写助手',
    description: '专注于技术文档、API文档和README撰写的Subagent',
    subagent_type: 'document-writer',
    priority: 3 as TemplatePriority.BUILTIN,
    type: 'builtin' as TemplateType.BUILTIN,
    tools: ['all'], // 显式全量(省略=零工具的统一默认下保持原行为)
    parameters: {
      max_iterations: {
        name: 'max_iterations',
        type: 'number',
        description: '最大迭代次数',
        required: false,
        default: 8,
      },
      token_budget: {
        name: 'token_budget',
        type: 'number',
        description: 'Token预算',
        required: false,
        default: 150000,
      },
      timeout: {
        name: 'timeout',
        type: 'number',
        description: '超时时间（秒）',
        required: false,
        default: 400,
      },
      temperature: {
        name: 'temperature',
        type: 'number',
        description: '温度参数',
        required: false,
        default: 0.4,
      },
      document_type: {
        name: 'document_type',
        type: 'string',
        description: '文档类型',
        required: false,
        default: 'technical',
      },
      include_examples: {
        name: 'include_examples',
        type: 'boolean',
        description: '是否包含示例',
        required: false,
        default: true,
      },
      language: {
        name: 'language',
        type: 'string',
        description: '文档语言',
        required: false,
        default: 'zh-CN',
      },
    },
    system_prompt: `你是文档撰写助手Subagent，专注于创建清晰、专业的技术文档。

## 核心职责

1. **技术文档**：API文档、架构文档、开发指南
2. **代码注释**：函数/类文档、复杂逻辑说明
3. **README撰写**：项目介绍、安装指南、使用示例
4. **变更日志**：版本更新说明、迁移指南

## 写作原则

- **清晰简洁**：使用简单明了的语言，避免冗余
- **结构清晰**：合理使用标题、列表、代码块
- **示例丰富**：提供实用的代码示例和用例
- **受众意识**：根据目标读者调整技术深度

## 文档结构

标准技术文档应包含：
1. **概述**：文档目的和适用范围
2. **前置条件**：环境要求、依赖项
3. **主要内容**：分步骤说明、API参考
4. **示例**：完整可运行的代码示例
5. **常见问题**：已知问题和解决方案

## 输出格式

使用Markdown格式，确保：
- 标题层级正确（H1-H6）
- 代码块标注语言类型
- 表格用于参数说明
- 链接可点击跳转`,
    version: '1.0.0',
    author: 'system',
    tags: ['documentation', 'writing', 'technical'],
  },
  {
    name: '结果评审者',
    description: '独立的对抗式评审者：对照任务成功标准核验交付物与验证证据，只认证据不认自述；用于 require_review 验证闭环，也可直接委派做 ad-hoc 评审',
    subagent_type: 'reviewer',
    priority: 3 as TemplatePriority.BUILTIN,
    type: 'builtin' as TemplateType.BUILTIN,
    tools: ['read_file', 'list_files', 'search_content', 'get_current_directory', 'execute_powershell'],
    parameters: {
      max_iterations: {
        name: 'max_iterations',
        type: 'number',
        description: '最大迭代次数',
        required: false,
        default: 8,
      },
      token_budget: {
        name: 'token_budget',
        type: 'number',
        description: 'Token预算',
        required: false,
        default: 100000,
      },
      timeout: {
        name: 'timeout',
        type: 'number',
        description: '超时时间（秒）',
        required: false,
        default: 300,
      },
      temperature: {
        name: 'temperature',
        type: 'number',
        description: '温度参数',
        required: false,
        default: 0.2,
      },
    },
    system_prompt: `你是一个独立的评审者。你没有被评审任务执行过程的任何记忆——你只认证据，不认自述。你的职责是对照成功标准，独立核验交付物是否真正达标。

## 评审纪律

1. **逐条对照**：把成功标准拆成条目，逐条给出"达标/不达标 + 依据"。
2. **独立复核**：不要轻信交付物中声称的验证结果——用可用工具亲自复核：重跑测试/构建命令、读取被修改的文件、检查 diff。你的工具调用与对方的"他说跑过"之间，只信前者。
3. **证据存疑即不达标**：交付物缺少验证证据、证据与结论对不上、或你无法复现其声称的验证结果时，按不达标处理并说明缺什么。
4. **不代工**：你只评审，不替对方修改；指出问题即可，修正由执行者完成。

## 结论契约（必须遵守）

评审完成后，在最终回复的**最后一行**单独输出结论：

- \`VERDICT: PASS\` —— 全部成功标准均有证据支撑；
- \`VERDICT: FAIL\` —— 存在不达标项。

若结论为 FAIL，必须在结论行之前列出每个不达标点的具体说明（哪条标准、缺什么证据或什么实际缺陷），使执行者能据此直接修正。`,
    version: '1.0.0',
    author: 'system',
    tags: ['review', 'verification', 'quality'],
  },
]

/**
 * 获取所有内置模板
 * 若传入 ITemplateLoader 则调用，非空返回结果，空/异常则降级到默认值
 * @returns 内置模板数组
 */
export async function getBuiltinTemplates(templateLoader?: ITemplateLoader): Promise<SubagentTemplate[]> {
  if (!templateLoader) {
    return DEFAULT_BUILTIN_TEMPLATES
  }

  try {
    const templates = await templateLoader.loadBuiltinTemplates()
    if (templates && templates.length > 0) {
      return templates
    }
    return DEFAULT_BUILTIN_TEMPLATES
  } catch {
    return DEFAULT_BUILTIN_TEMPLATES
  }
}

export async function getBuiltinTemplateByType(type: string, templateLoader?: ITemplateLoader): Promise<SubagentTemplate | undefined> {
  const templates = await getBuiltinTemplates(templateLoader)
  return templates.find(template => template.subagent_type === type)
}
