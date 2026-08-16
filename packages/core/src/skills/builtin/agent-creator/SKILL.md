---
name: agent-creator
description: 创建 Subagent(agent 模板)的完整指南。当用户要求创建/编写一个 agent、Subagent、模板,或把刚才讨论的业务逻辑/工作流程沉淀为一个可复用的 agent 时使用。Use when users want to create a new agent (subagent template).
---

# Agent Creator

帮用户创建一个 Subagent。**Subagent 就是一个 Markdown 文件**——不需要任何"安装"动作,把文件写进正确目录即完成创建,文件监听会自动热加载。

## 一、模板格式

模板 = frontmatter + 正文,一个文件一个 agent:

```markdown
---
name: 热点调研助手
subagent_type: news-researcher
description: 只读调研类 agent,负责联网检索并汇总某领域的热点新闻,输出带来源链接的要点清单
model: 某模型名        # 可选;不写则跟随当前会话模型
tools: [read_file, search_content]  # 可选;不写则委派时按任务分配
---

# 能力描述

你专注于热点新闻调研。工作流程:
1. 按用户给定的领域与时间段检索信息,优先官方来源;
2. 交叉验证至少两个来源,剔除重复与过时条目;
3. 按调用方要求的详尽度输出:每条热点一句话概括 + 来源链接,末尾附一段趋势总结。
```

- **必填**:`name`(显示名)、`subagent_type`(标识符,**只能小写字母/数字/连字符**,如 `news-researcher`);
- **可选**:`description`、`model`、`tools`、`memory`;
- **description 决定委派时能否被正确选中**——写清"什么时候该用它",职责窄而明确(反面:"一个很有用的助手");
- **正文写能力描述/工作方式/输出要求**,不写角色框架("你是执行子任务的 Subagent"之类由系统统一包装,不要重复)。

### memory 字段(per-agent 专属记忆,可选)

写一行 `memory: user`(或 `project` / `local`),该 agent 就拥有跨会话保留的专属记忆空间;不写 = 无专属空间(现状)。

| 作用域 | 存储位置 | 适用 |
|---|---|---|
| `user` | `~/.chill/agent-memory/<subagent_type>/` | 跨项目通用的专业积累(默认推荐) |
| `project` | `<项目根>/.agents/agent-memory/<subagent_type>/` | 项目相关沉淀,可入 git 团队共享 |
| `local` | `<项目根>/.agents/agent-memory-local/<subagent_type>/` | 项目相关但仅本人可见 |

- 语义(对齐 Claude Code):agent 在工作中经 `save_memory`/`delete_memory` 读写自己的空间——**想让 agent 能写记忆,`tools` 白名单必须含 `save_memory`**(需要删除再加 `delete_memory`);不在白名单则记忆只读;
- 写入分工:`save_memory` 缺省写自己的空间;用户偏好、用户纠正等"属于用户"的认知,工具会用 `scope: "global"` 写进全局共享记忆(所有 agent 可见,不重复不碎裂);
- agent 执行时还能看到全局共享记忆索引(只读);
- 非法值(如 `memory: global`)会在模板加载时报解析错误。

## 二、写到哪里(二选一)

| | 个人级 | 项目级 |
|---|---|---|
| 路径 | `~/.chill/agents/templates/<name>.md` | `<项目>/.agents/agents/<name>.md` |
| 生效范围 | 所有项目 | 仅当前项目(随 git 共享给团队) |
| 生效时机 | 文件监听,**下一轮对话即生效** | 仅监听启动时已存在的目录;**新建目录需重启 chill 生效** |
| 写入 | 在写边界外,会弹审批(用户可按 [d] 把目录加入边界) | 在写边界内,直接落盘 |

- 用户没有特别说明时,**默认写个人级**(即装即用、生效最快);
- 用户说"团队共享"/"随项目走"时写项目级;
- `~` 指用户主目录(Windows 如 `C:\Users\<用户名>`),不确定时用 execute_powershell 的 `$env:USERPROFILE` 确认。

## 三、同名优先级

`项目级 > 个人级 > 内置`。想定制内置 agent(如 general-purpose),在更高优先级目录写同名 `subagent_type` 即覆盖。

## 四、创建流程

1. 先弄清用途:这个 agent 负责什么、需要什么工具、只读还是可写;需求不明确先问用户;
2. 按第一节格式写文件(create_file);
3. 告知用户:文件位置、生效时机(个人级下轮生效/项目级新目录需重启)、如何试用(`@<subagent_type> 一句话任务`);
4. 写错(缺必填字段、`subagent_type` 命名违规)的模板会在重扫时打印解析失败警告——写完若用户反馈"看不到这个 agent",先检查终端警告与上述格式要求。

## 五、与 AGENTS.md 的分工

- **常设约束**(构建命令、代码风格、全员纪律)→ 写 `AGENTS.md`;
- **角色定义**(专职能力、专用模型/工具、可被委派的专家)→ 写 agent 模板(本指南)。

如果用户要创建的"agent"需要多个 Subagent 协作的固定流程,那不是单个模板能表达的——告知用户当前支持单个 Subagent 模板,多 agent 编排可先用对话中并行委派实现。
