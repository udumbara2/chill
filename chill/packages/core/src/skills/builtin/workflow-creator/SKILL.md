---
name: workflow-creator
description: 创建命名工作流(YAML 工作流资产)的完整指南。当用户要求创建/编写一个工作流、把多步骤流程固化下来、或把"先 A 再 B 再 C"的分工编排保存为可复用流程时使用。Use when users want to create a named workflow (multi-step orchestration).
---

# Workflow Creator

帮用户创建一个**命名工作流**。工作流就是一个 YAML 文件——不需要任何"安装"动作,把文件写进正确目录即完成创建,文件监听自动热加载;UI 里会立即出现在侧栏并自动在画布上打开整张图。

## 〇、先判断:该不该建工作流

- **单步任务不要用工作流**——那是单 Agent 模板的场景(见 agent-creator skill);工作流是给"两个以上节点、或需要固定数据流"的编排用的;
- 工作流里可以引用单 Agent 模板作为节点(`agent.template`),这是两类资产的组合接口;
- 工作流**不能嵌套**(节点不能引用其他工作流);多个工作流的组合由你在对话里顺序调用 `run_workflow` 完成。

## 一、文件格式(DSL)

一个文件一个工作流,`<name>.yaml`:

```yaml
name: tech-article           # 必填;调用键,只能小写字母/数字/连字符
version: 1                   # 必填;DSL 版本,当前为 1
title: 技术文章生产线         # 可选;显示名(中文随意),给人看
description: 调研→撰写→评审,产出技术文档   # 可选但强烈建议;决定能否被正确选中
when_to_use: 用户要求写技术文章/教程时     # 可选;驱动模型自动匹配的一等字段
inputs:                      # 可选;入参契约(运行时要用户提供什么)
  - { name: topic, type: text, description: 文章主题, required: true }   # type: text | file
nodes:                       # 必填;至少 1 个
  - id: research             # 语义 id:字母开头,小写字母/数字/下划线/连字符
    label: 调研              # 可选;画布显示名
    agent:                   # agent 节点:内联定义或引用模板(二选一,互斥)
      system_prompt: 你是调研专员,负责联网检索并汇总...
      model: { name: gpt-5, parameters: { temperature: 0.3 } }   # 可选;不写走默认
      tools: [web_search]    # 可选;工具名数组
  - id: write
    agent: { template: document-writer }   # 引用单 Agent 模板(subagent_type)
  - id: lint
    tool: { name: run_code, params: { language: shell } }   # tool 节点:确定性执行工具
edges:                       # 可选(单节点工作流可空);定义数据流
  - { from: research, to: write }     # 普通边
  - from: write                       # 条件边:满足 when 才走
    to: lint
    when: { type: content, operator: contains, value: "代码" }
    priority: 1
  - { from: write, to: research, fallback: true }   # 兜底边(与 when 互斥;每个 from 至多一条)
```

### 节点规则

- 每节点**恰好** `agent` 或 `tool` 其一;
- `agent.template` 与内联字段(system_prompt/model/tools)**互斥**;内联时 `system_prompt` 必填;
- `tool.name = run_code` 是代码执行节点(执行上游输出的代码;params 支持 `language`、`interactive: true`);
- `position: {x, y}` 不要写——坐标是画布的事,画布打开时自动布局。

### 条件边 when 的四种条件

| type | 字段 | 语义 |
|---|---|---|
| `tool_call` | 无 | 上游最后一条消息含工具调用 |
| `content` | `operator` + `value` | 上游输出内容匹配(equals/not_equals/contains/not_contains/starts_with/ends_with/regex) |
| `state_field` | `field` + `operator` + `value` | 状态字段比较(eq/ne/gt/lt/gte/lte/contains/not_contains) |
| `expression` | `expression`(basic/logical/group 嵌套) | 复合表达式 |

循环回边(如评审打回)就是"指回上游节点的边";`max_iterations: N` 限制循环次数,防死循环。

## 二、写到哪里(二选一)

| | 个人级 | 项目级 |
|---|---|---|
| 路径 | `~/.chill/workflows/<name>.yaml` | `<项目>/.agents/workflows/<name>.yaml` |
| 生效范围 | 所有项目 | 仅当前项目(随 git 共享给团队) |
| 生效时机 | 文件监听,**立即生效**(侧栏出现、可被调用) | 同左(已监听目录);新建目录可能需重启 |
| 写入 | 在写边界外,会弹审批 | 在写边界内,直接落盘 |

- 用户没有特别说明时,**默认写个人级**;说"团队共享"/"随项目走"时写项目级;
- 同名优先级:**项目级 > 个人级**。

## 三、创建流程

1. 先弄清流程:几个步骤、每步谁干(内联 agent 还是引用模板)、步骤间的数据怎么流、有没有条件分支/循环;需求不明确先问用户;
2. 按第一节格式写文件(create_file);**name 用 kebab-case**,title 放中文显示名;
3. 写完必须自检:重读文件,确认 name/version 必填在、节点 id 唯一、边的 from/to 都指向存在的节点、agent/template 没混写;
4. 告知用户:文件位置、画布会自动打开整张图可直接调整、如何试用("跑一下 <name>,主题是 X" 或侧栏点运行);
5. 写错的文件会在侧栏显示"⚠ 无效 + 原因"——若用户反馈"看不到这个工作流",先检查该错误提示。

## 四、深绑定:节点即模板

**agent 节点 = 一个单 Agent 的具象化**——字段就是模板全集(身份字段除外):

```yaml
nodes:
  - id: research
    agent:
      template: news-researcher     # 引用已有单 Agent:Worker 独立上下文执行(记忆/技能/权限全生效)
  - id: summarize
    agent:
      system_prompt: 压成三条要点     # 内联匿名:默认共享上下文循环(便宜、就地加工)
  - id: refactor
    agent:
      system_prompt: 你是重构专家
      tools: [read_file, replace_content]
      memory: user                    # 驮具字段(memory/skills/knowledge)→ 升级 Worker 执行
      max_turns: 5                    # 工具循环上限(防失控;模型自己停则不到顶)
      prompt: "基于{{nodes.research}}重构{{input.module}}"   # 任务说明;缺省={{prev}}
```

- **执行层判定**(写 YAML 时自觉):`template:` 引用 → 一律 Worker(独立上下文+全装备);内联 → 默认共享上下文循环;内联声明 memory/skills/knowledge → 升级 Worker;
- **prompt 变量**:`{{prev}}`(上游最后一条输出)/ `{{input.<name>}}`(入参)/ `{{nodes.<id>}}`(指定节点产出);优先级:节点 prompt > 模板 user_prompt_template > {{prev}};
- **max_turns 是保险丝不是档位**:模型干完会自己停,上限只是防失控;
- **权限字段两层生效**:readonly/disallowed_tools 在两层都会过滤工具清单;
- **tools 语义(与单 Agent 模板同规则)**:省略 = 零工具(纯文本节点直接不写);`[all]` = 全部工具(仅深绑定节点支持;浅节点的工具就是画布勾选清单,写 [all] 会报错);`[a, b]` = 默认名单;`[]` 或 `[none]` 按省略处理(仅日志提示,不上 UI)——零工具直接省略整行;
- **图级循环 vs 节点内循环**:质量门(评审打回)用条件边 max_iterations;自主探索用节点内循环,别混用;
- **配置错误集中预检**:模板名打错、工具不存在,运行前一次性报全,不会跑一半才炸。

## 五、与其他资产的分工

- **单个专家角色**(专职能力、可被委派的 agent)→ 单 Agent 模板(agent-creator skill);
- **固定的多步骤编排**(本指南)→ 命名工作流;
- **常设约束**(构建命令、代码风格)→ AGENTS.md;
- 工作流被调用的方式:用户口语触发(你调 `run_workflow`)或 UI 侧栏"运行"——创建时不需要关心触发器,触发与资产解耦。
