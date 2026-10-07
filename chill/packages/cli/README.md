# @assistant-ai/chill-cli（chill CLI）

终端 AI 助手：统一对话引擎（ChatEngine）、Subagent 委派、MCP、Skill、长期记忆、规划模式。

## Web UI（chill web）

装了 chill 的机器上运行 `chill web`，启动后**自动用默认浏览器打开** Web UI（`--no-open` 可禁用，改用手动复制终端打印的 `http://127.0.0.1:<端口>/?token=...` 地址），即可获得与桌面 UI 同一份代码的完整体验（无需安装桌面端）。

- `chill web` — 启动 Web 宿主 daemon（在项目目录运行 = 写边界即该目录；Ctrl+C 停止）
- 家目录启动自动降级为只读（读取/聊天不受影响；写入需 `chill web --allow-home` 显式提升）
- 与 CLI / 桌面 UI 共享同一份 `~/.chill/`（会话、密钥、配置、记忆、MCP）
- 首次使用模型需在设置页配置 API Key（与桌面共享密钥库）

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
chill                 # 交互式对话（REPL，TUI 显示）
chill -p "任务"       # 非交互一次性执行（默认只读）
chill -p --auto "任务" # 非交互一次性执行（放开修改，无需确认）
chill web             # 浏览器完整界面（自动打开，--no-open 禁用）
chill serve on        # 7×24 常驻宿主（定时任务持钟 + 手机遥控后端；off/status 同款）
```

想要**独立桌面窗口**？安装全档包 `npm install -g @assistant-ai/chill`，然后在 REPL 内输入
`/ui`——Electron 窗口打开并接力当前会话（轻档下 `/ui` 会给出升级指引，其余功能完全一致）。
**手机遥控**：`npm install -g @assistant-ai/chill-relay` 部署自己的中继（详见其 README），
`/pair config` 配好后 `chill serve on` + 扫码即用。

常用命令（REPL 内）：

- `/help` 全部命令
- `/model` 选择对话模型；`/front` 选择会话前台（裸模型或本地 Agent）
- `/plan` 进入/退出规划模式（只读讨论规划，批准后才执行）
- `/session` 会话管理（list/new/rename/load/delete，逐轮自动保存到 `~/.chill/sessions/`）
- `/memory` 长期记忆；`/skill` 技能管理；`/mcp` MCP 服务器管理
- `/hooks` 生命周期 hook 管理（list/enable/disable/log；`/hooks add <描述>` 自然语言创建）
- `@<文件路径>` 发送图片或视频（多模态模型）
- `Ctrl+X` 中断当前生成；`Ctrl+K` 双击（3 秒内第二次确认）停止全部后台任务；`/exit` 退出

委派（无需切换模式）：对话中模型可直接通过 `task` 工具委派 Subagent，
并按任务性质为 Subagent 指定模型（多模态任务→多模态模型，小任务→小模型）。
委派进度以事件流实时打印。后台任务管理：`/tasks` 查看清单（运行中任务带序号），
`/tasks cancel <序号|taskId>` 取消指定任务，`Ctrl+K` 双击停止全部。
委派资源限额：并发上限（默认 6）与进程内累计上限（默认 200），超限拒绝新委派；
`/limits` 查看，`/limits set <key> <正整数>` 调整，`/limits unset <key>` 恢复默认
（UI 设置页 AGENT tab「委派限额」同键设置）。委派深度固定为 1（Subagent 不能再向下委派），
单 agent 轮数由模板 max_iterations 或委派 override_parameters.max_iterations 配置。

## 生命周期 hooks

在运行链路的确定性点位执行自定义脚本：直接对 chill 说需求（如"每次写完文件跑一遍 eslint""不许执行 rm -rf"），或用 `/hooks add <描述>`，chill 自动生成脚本与配置、安装前展示确认。典型用法：安全护栏、白名单免审批、自动格式化、会话开场注入上下文、完成前跑测试。

- 管理：`/hooks list` 查看、`/hooks enable|disable <id>` 启停、`/hooks log` 查最近 50 次触发记录
- 配置：用户级 `~/.chill/hooks.json`（与桌面 UI 共享）；项目级 `<项目>/.agents/hooks.json`（随仓库分发，首见/变更需信任批准）
- 协议对齐 Claude Code 事实标准（事件名、stdin/stdout JSON、exit code 语义、`CLAUDE_PROJECT_DIR` 别名），社区 hook 脚本可复用

详细说明见[根 README 的生命周期 hooks 章节](../README.md#生命周期-hooks说一句话就有的确定性护栏)。

## 会话与数据

全部状态（API Key、模型配置、会话、记忆、Skill、MCP 配置）保存在 `~/.chill/`。
与 chill 桌面 UI 共享同一份数据：一端建立的会话可在另一端继续。

## 自迭代（修改 chill 自身）

```text
/fetch-source   # 下载 chill 源码到 ~/.chill/workspace/ 并构建
```

随后可让 chill 修改自身源码（修改发生在 workcopy 内，完成后经 `/switch-version` 切换、
`/discard-version` 放弃）。`/use-self` / `/use-npm` 在自迭代版与 npm 官方版之间切换。

源码归档为四件套（chill / chill-guardian / chill-relay / chill-mobile），`/fetch-source`
一次拉齐到 `~/.chill/workspace/`——AI 亦可自迭代手机端（内置技能 mobile-iterate：改码、
快照固化、构建推送出自己的 APK，需 JDK + Android SDK + 真机）。

## 卸载

```bash
npm uninstall -g @assistant-ai/chill-cli
# 数据目录 ~/.chill/ 不会自动删除，按需手动清理
```
