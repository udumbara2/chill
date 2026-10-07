/**
 * 字符串数组字段校验+归一化助手（tools/disallowed_tools/skills/knowledge 四字段共用）
 *
 * 单一规则源：TemplateParser（模板 frontmatter）与 workflowParser（工作流节点 agent）
 * 此前各抄一份且已漂移（skills/knowledge 漏查空数组），规则只允许存在于本文件。
 *
 * 语义格（toolPolicy.ts 头部注释为完整事实源；本文件负责解析层落地）：
 * - 非数组 / 含非字符串或空白元素 → error（语义不可判定）
 * - [] → 归一化为省略（value=undefined）+ warning
 * - tools: [none] → 与省略同义，归一化 + warning（none 仅委派层有意义）
 * - tools: [none, x] 混写 → error（语义矛盾）
 * - tools: [all, x] → all 生效，x 忽略 + warning
 * - none/all 出现在其余三字段 → error（无定义）
 */

import { TOOL_POLICY_ALL, TOOL_POLICY_NONE } from '../toolPolicy'

export type StringArrayFieldName = 'tools' | 'disallowed_tools' | 'skills' | 'knowledge'

export interface StringArrayFieldResult {
  /** 归一化后的值；undefined = 视为省略（调用方应删除该字段/按省略处理） */
  value?: string[]
  /** 行为相关警告（有损/可能与预期不同）→ UI 可见 */
  warning?: string
  /** 卫生通知（无损归一化，无需行动）→ 仅控制台日志，不上 UI */
  info?: string
  /** 语义不可判定 → 拒绝加载 */
  error?: string
}

/**
 * 校验并归一化一个字符串数组字段
 * @param field - 字段名
 * @param value - 原始值（undefined = 未声明，直接通过）
 * @param label - 错误/警告消息的定位前缀（如 `节点 "design" 的 agent.tools`）
 */
export function validateStringArrayField(
  field: StringArrayFieldName,
  value: unknown,
  label: string,
): StringArrayFieldResult {
  if (value === undefined) return {}

  if (!Array.isArray(value) || value.some((v: unknown) => typeof v !== 'string' || !v.trim())) {
    return { error: `${label} 必须是非空字符串数组` }
  }

  if (value.length === 0) {
    return {
      value: undefined,
      info: `${label} 空数组已按未声明处理（不需要时请删除该字段）`,
    }
  }

  const hasNone = value.includes(TOOL_POLICY_NONE)
  const hasAll = value.includes(TOOL_POLICY_ALL)

  if (field !== 'tools') {
    // none/all 关键字只在 tools 字段有定义
    if (hasNone || hasAll) {
      return { error: `${label} 不支持关键字 all/none（仅 tools 字段有意义）` }
    }
    return { value }
  }

  // tools 字段
  if (hasNone) {
    if (value.length > 1) {
      return { error: `${label} 语义矛盾：none（零工具）不能与其他值混写` }
    }
    return {
      value: undefined,
      info: `${label} 模板/节点层省略 tools 即零工具，none 仅在委派层（available_tools）有意义，已按未声明处理`,
    }
  }
  if (hasAll) {
    if (value.length > 1) {
      return {
        value: [TOOL_POLICY_ALL],
        warning: `${label} all 已表示全部工具，其余条目已忽略`,
      }
    }
    return { value: [TOOL_POLICY_ALL] }
  }
  return { value }
}

/**
 * hedged 警告：声明了 memory/knowledge 但 tools 为零（省略）时提醒可能部分不生效
 * （只警告不报错——存在只读注入即满足的合法用法）
 * @returns 警告文案；无需警告时 undefined
 */
export function warnIfZeroToolsWithMounts(
  fields: { tools?: string[]; memory?: string; knowledge?: string[] },
  label: string,
): string | undefined {
  const zeroTools = !fields.tools || fields.tools.length === 0
  const hasMounts = !!fields.memory || (!!fields.knowledge && fields.knowledge.length > 0)
  if (!zeroTools || !hasMounts) return undefined
  return `${label} 声明了 memory/knowledge 但 tools 为零（省略）：记忆/知识库的完整功能依赖工具调用，零工具下可能部分不生效；纯文本 agent 可忽略`
}
