import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAgentMentions } from '../../src/engine/agentMention.ts'

const TYPES = new Set(['code-reviewer', 'document-writer', 'general-purpose'])

test('命中: 精确匹配模板名返回 explicitAgent', () => {
  assert.deepEqual(parseAgentMentions('@code-reviewer 审查一下最近的改动', TYPES), {
    explicitAgent: 'code-reviewer',
  })
  // 出现在消息任意位置均可命中
  assert.deepEqual(parseAgentMentions('请 @document-writer 写一段 README 摘要', TYPES), {
    explicitAgent: 'document-writer',
  })
})

test('未命中: 不匹配任何模板时返回 {}（按普通文本处理）', () => {
  assert.deepEqual(parseAgentMentions('@不存在的名 你好', TYPES), {})
  assert.deepEqual(parseAgentMentions('@security-reviewer 你好', TYPES), {})
  assert.deepEqual(parseAgentMentions('没有任何提及', TYPES), {})
})

test('多个提及: 取第一个命中的模板，其余按普通文本', () => {
  assert.deepEqual(parseAgentMentions('@code-reviewer @document-writer 一起干活', TYPES), {
    explicitAgent: 'code-reviewer',
  })
  // 前一个未命中、后一个命中：返回第一个"命中模板"的提及
  assert.deepEqual(parseAgentMentions('@not-exist @document-writer 写文档', TYPES), {
    explicitAgent: 'document-writer',
  })
})

test('与媒体样式 @a.png 共存: 点号文件名不误吞、也不阻碍后续 agent 命中', () => {
  // @a.png 中的 a 不在模板清单 → 不产生点名
  assert.deepEqual(parseAgentMentions('@a.png 你好', TYPES), {})
  // 媒体提及与 agent 提及同用：@a.png 被跳过，@code-reviewer 正常命中
  assert.deepEqual(parseAgentMentions('@a.png @code-reviewer 审查这张图', TYPES), {
    explicitAgent: 'code-reviewer',
  })
})
