# @assistant-ai/chill-cli（chill CLI）

终端 AI 助手：统一对话引擎（ChatEngine）、Subagent 委派、MCP、Skill、长期记忆、规划模式。

## 安装

```bash
npm install -g @assistant-ai/chill-cli
```

安装后即可使用 `chill` 命令，无需克隆仓库、无需桌面端。首次使用先配置模型 API Key：

```bash
chill
> /key set <provider> <apiKey>
> /model list
```

## 使用

```bash
chill                 # 交互式对话（REPL）
chill -p "任务"       # 非交互一次性执行（默认只读）
chill -p --auto "任务" # 非交互一次性执行（放开修改，无需确认）
```

常用命令（REPL 内）：

- `/help` 全部命令
- `/model` 选择对话模型；`/front` 选择会话前台（裸模型或本地 Agent）
- `/plan` 进入/退出规划模式（只读讨论规划，批准后才执行）
- `/session` 会话管理（list/new/rename/load/delete，逐轮自动保存到 `~/.chill/sessions/`）
- `/memory` 长期记忆；`/skill` 技能管理；`/mcp` MCP 服务器管理
- `@<文件路径>` 发送图片或视频（多模态模型）
- `Ctrl+X` 中断当前生成；`/exit` 退出

委派（无需切换模式）：对话中模型可直接通过 `task` 工具委派 Subagent，
并按任务性质为 Subagent 指定模型（多模态任务→多模态模型，小任务→小模型）。
委派进度以事件流实时打印。

## 会话与数据

全部状态（API Key、模型配置、会话、记忆、Skill、MCP 配置）保存在 `~/.chill/`。
与 chill 桌面 UI 共享同一份数据：一端建立的会话可在另一端继续。

## 自迭代（修改 chill 自身）

```text
/fetch-source   # 下载 chill 源码到 ~/.chill/workspace/ 并构建
```

随后可让 chill 修改自身源码（修改发生在 workcopy 内，完成后经 `/switch-version` 切换、
`/discard-version` 放弃）。`/use-self` / `/use-npm` 在自迭代版与 npm 官方版之间切换。

## 卸载

```bash
npm uninstall -g @assistant-ai/chill-cli
# 数据目录 ~/.chill/ 不会自动删除，按需手动清理
```
