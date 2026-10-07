/**
 * Worker 出账 tokenUsage 映射(纯函数,可单测)
 *
 * 量纲:cumulativeUsage(任务累计消耗,团队账本用)优先;缺失(asyncTask 不计量)回退
 * 末轮 usage(现状语义,量纲不准但优于无数据);estimated 透传(账本/展示据此标注 ~)。
 * 空输出截断检测不在此处——它继续吃末轮 usage,与账本量纲隔离。
 */

import type { ModelResponse } from '../../../types/models'
import type { SubagentResponse } from '../types'

export function buildTokenUsage(response: ModelResponse): SubagentResponse['tokenUsage'] {
  const billing = response.cumulativeUsage ?? response.usage
  return {
    input: billing?.promptTokens || 0,
    output: billing?.completionTokens || 0,
    total: billing?.totalTokens || 0,
    ...(response.cumulativeUsage?.estimated ? { estimated: true } : {}),
  }
}
