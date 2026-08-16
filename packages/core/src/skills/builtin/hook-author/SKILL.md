---
name: hook-author
description: 创建/修改/删除生命周期 hook 的完整工作手册。当用户表达"加个 hook""每次 X 时自动做 Y""不许做 Z""以后别问我 X"等意图时使用——把自定义逻辑确定性地钉进 chill 的运行链路。Use when users want to add a lifecycle hook, automate an action on events, or block/allow specific behaviors.
---

# Hook Author

帮用户创建 hook。**hook = 一个单文件 Node 脚本 + hooks.json 里的一条配置**——不需要任何"安装"动作，脚本与配置落盘即完成创建，配置按 mtime 惰性重载，下一轮对话即生效。

用户不需要会写脚本、不需要懂协议——你理解意图后按本手册生成全部产物，安装前向用户展示"脚本全文 + 挂在哪个事件 + matcher 是什么"，用户确认才落盘。

## 一、何时使用

用户表达以下意图时使用本 skill：

- "加个 hook""每次写完文件帮我跑一遍 eslint""开会话时把 git 状态告诉我"
- "不许执行 rm -rf 这类命令""拦截含密钥的输入"
- "npm test、git status 这类命令以后别问我了"（白名单自动批准）
- "chill 说做完了先跑测试，不过就让它继续干"（强制验收）
- "目标达成时通知我""委派前后记审计日志"

反向判断：用户要的是"常设纪律/规范"且不需要确定性拦截时，建议写 `AGENTS.md`；要的是"可复用的角色能力"时，建议创建 agent 模板。hook 的定位是**确定性护栏**——确定性的事交给确定性设施。

## 二、事件总表（13 个事件，三种语义）

三种语义：**审批式**（可 deny/allow/改写，串行决策链）、**注入式**（`additionalContext` 回灌上下文）、**通知式**（fire-and-forget，输出忽略）。

| 事件 | 触发时机 | 语义 | matcher |
|---|---|---|---|
| `SessionStart` | 开会话/续会话 | 注入式 | 子类型枚举：`startup`/`resume` |
| `UserPromptSubmit` | 用户提交 prompt 后、处理前 | 审批+注入（deny 丢弃消息） | 无（全量触发） |
| `PreToolUse` | 工具执行前、内置门之前 | 审批式：deny 拦截 / ask 升级审批 / `updatedInput` 改写入参 / `additionalContext` | 工具名正则 |
| `PermissionRequest` | 内置门全部通过后、审批弹窗之前 | 审批式：allow 自动批准（白名单减码）/ deny 拒绝 | 工具名正则 |
| `PostToolUse` | 工具执行后 | 注入式（可改写回传结果） | 工具名正则 |
| `Stop` | 回合结束（chill 宣称"做完了"） | 审批式：deny 强制继续 | 无 |
| `SessionEnd` | 会话结束/退出 | 通知式（共享短超时预算） | 无 |
| `Notification` | 系统通知（审批请求、goal 熔断请示等） | 通知式 | 无 |
| `PreCompact` | 上下文压缩前 | 审批式（可阻断） | 无 |
| `PostCompact` | 上下文压缩落盘后 | 注入式 | 无 |
| `GoalTransition` | 目标模式状态转换 | 通知式 | 子类型枚举：`started`/`achieved`/`cleared`/`paused`/`resumed`/`budget_exhausted` |
| `PreDelegation` | 委派 Subagent 前（preflight 前） | 审批式（可拒绝委派） | 工具名正则 |
| `PostDelegation` | 委派任务落地（settle）后 | 通知式 | 工具名正则 |

选事件要点：

- **拦工具/改参数 → `PreToolUse`**；**免审批白名单 → `PermissionRequest`**（注意：`autoApply on` / `-p --auto` 直通时无审批环节，本事件不触发——收紧类需求永远用 `PreToolUse`，它在所有权限模式下保底生效）。
- **做事后检查/自动格式化并把结果喂回模型 → `PostToolUse`**。
- **`PreToolUse` 与 `PermissionRequest` 是两个独立槽位、不重复执行**：PreToolUse 无结论时才走到 PermissionRequest。
- `save_memory`/`delete_memory` 等直写工具不经过写边界/审批，**`PreToolUse` 是拦截它们的唯一关卡**。
- 部分事件在后续版本陆续接线；`/hooks` 可查看当前生效的事件与 hook 列表。

### matcher 语法

- **工具事件**（`PreToolUse`/`PostToolUse`/`PermissionRequest`/`PreDelegation`/`PostDelegation`）：对工具名的**正则表达式**，如 `write_file|execute_powershell`。
- **生命周期事件**：**子类型枚举精确匹配**，如 `SessionStart` 的 `startup`/`resume`、`GoalTransition` 的 `achieved`。
- 省略 matcher 或留空 = 全量触发。

## 三、协议规范（脚本与 chill 之间的契约）

### 通信方式

chill 以子进程执行脚本：**stdin 传 JSON 输入，stdout 传 JSON 输出，stderr 作日志/阻断原因**。环境变量提供 `CHILL_PROJECT_DIR`（项目根）与 `CLAUDE_PROJECT_DIR`（兼容别名，社区 Claude 生态脚本可直接复用）。

### stdin 输入字段

```json
{
  "session_id": "当前会话 ID",
  "cwd": "当前工作目录",
  "hook_event_name": "PreToolUse",
  "tool_name": "工具名（工具事件）",
  "tool_input": "工具入参对象（工具事件）"
}
```

不同事件在此基础上有各自附加字段（如 `Stop` 带 `stop_hook_active`）；脚本对未知字段要容错忽略。

### stdout 输出字段

```json
{
  "decision": "allow | deny",
  "reason": "deny 时的原因（反馈给模型/用户）",
  "hookSpecificOutput": {
    "permissionDecision": "allow | deny | ask",
    "updatedInput": "改写入参对象（PreToolUse）",
    "additionalContext": "注入上下文的文本"
  },
  "systemMessage": "直接显示给用户的文本",
  "continue": "false 时终止整个 agent 循环"
}
```

脚本只需输出用到的字段；无动作时输出 `{}` 或什么都不输出均可。

### exit code 语义（与 stdout 二选一或配合使用）

| exit code | 语义 |
|---|---|
| `0` | 放行；stdout 若有 JSON 则解析决策 |
| `2` | 阻断；**stderr 内容作为原因反馈给模型**（审批式事件的硬阻断通道） |
| 其他 | fail-open：警告用户，按原始参数继续 |

**推荐**：逻辑判定用 exit 0 + stdout JSON（`decision`/`permissionDecision`）；exit 2 留给脚本级硬阻断。

### timeout 与 failClosed

- 每个 hook 可配 `timeout`（秒，默认 30；`SessionEnd` 共享 1.5s 短预算）。
- 超时/崩溃默认 **fail-open**（警告但不卡住对话）；配 `failClosed: true` 则失败即阻断——只给安全护栏类 hook 用。
- 同一事件多个 hook：审批式**串行**（deny 即熔断 bail，`updatedInput` 逐级 waterfall）；通知式**并行**忽略输出；`additionalContext` 全部拼接。

## 四、产物约定

| 产物 | 路径 | 说明 |
|---|---|---|
| 脚本 | `~/.chill/hooks/scripts/<kebab-name>.mjs` | 单文件 Node `.mjs`、零依赖、跨平台 |
| 配置（用户级） | `~/.chill/hooks.json` | 所有项目生效 |
| 配置（项目级） | `<项目>/.agents/hooks.json` | 仅当前项目，随 git 共享给团队 |
| 启用状态 | `~/.chill/state.json` | 由 `/hooks enable/disable` 管理，**不要写进 hooks.json** |

- **脚本必须是 `.mjs` 单文件 Node 脚本，零 npm 依赖**——chill 用户必有 Node 运行时；严禁生成 bash/PowerShell 脚本（shell 差异是 Windows 兼容的最大踩坑点，脚本内也不要 `exec` 依赖 shell 特性的命令）。
- 脚本名用 kebab-case（如 `block-dangerous-cmd.mjs`）。
- 同名优先级：**项目级 > 用户级**。用户说"团队共享/随项目走"时写项目级，否则默认用户级。

### 配置格式

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "write_file|execute_powershell",
        "hooks": [
          {
            "type": "command",
            "command": "node ~/.chill/hooks/scripts/<kebab-name>.mjs",
            "timeout": 30,
            "failClosed": false
          }
        ]
      }
    ]
  }
}
```

- 写 hooks.json 时**读-合并-写**：保留既有事件与条目，只追加/修改目标条目，绝不整体覆盖。
- `command` 中的 `~` 按用户主目录展开；不确定时用 execute_powershell 的 `$env:USERPROFILE` 确认。

## 五、创建/修改/删除流程

### 创建

1. **理解意图**：用户想拦什么/自动做什么/免什么审批；对应到哪个事件；需求不明确先问用户。
2. **选事件与 matcher**：查第二节事件表；matcher 尽量收窄（命中才起子进程，无匹配零开销）。
3. **生成脚本**：按第六节模板写 `<kebab-name>.mjs`（用 create_file）。
4. **写配置**：向 hooks.json 追加条目（用 create_file，读-合并-写）。
5. **安装确认**：写 `~/.chill/` 在写边界之外，会弹当场审批——**审批展示的就是信任确认**：向用户明示脚本全文、挂在哪个事件、matcher 是什么。项目级 hooks 走哈希信任流程（首见/变更当场询问，批准前不执行）。
6. **告知验证方式**：触发一次对应动作，用 `/hooks log` 查触发记录（事件/matcher/耗时/exit code/决策）。

### 修改/删除

同样对话式：用户说"把刚才那个 hook 改成……""删掉它"时，先 read_file 定位脚本与 hooks.json 条目，修改走同一审批链；删除 = 删配置条目 + 删脚本文件（删配置即失效，脚本文件可留可删，询问用户）。

## 六、脚本模板

### 基础范式：读 stdin JSON

```js
#!/usr/bin/env node
// 所有 hook 脚本的公共开头：读 stdin、容错解析
let raw = ''
for await (const chunk of process.stdin) raw += chunk
let input = {}
try { input = JSON.parse(raw) } catch { /* 容错：空输入按 {} 处理 */ }

// ……判定逻辑……

// 无动作：输出空对象（或什么都不输出），exit 0
process.stdout.write('{}')
```

### 范式 1：exit 2 硬阻断（PreToolUse 拦危险命令）

```js
// stdin 基础范式（略，同上）之后：
const command = input.tool_input?.command ?? ''
const DANGEROUS = [/rm\s+-rf/, /git\s+push\s+.*--force/]
const hit = DANGEROUS.find(re => re.test(command))
if (hit) {
  // stderr 作为原因反馈给模型，让它换方案
  process.stderr.write(`已拦截危险命令: ${command}（命中 ${hit}）`)
  process.exit(2)
}
process.stdout.write('{}')
```

等价 JSON 写法：`process.stdout.write(JSON.stringify({ decision: 'deny', reason: '……' }))`，exit 0。

### 范式 2：additionalContext 注入（SessionStart 注入 git 状态 / PostToolUse 回灌检查结果）

```js
import { execSync } from 'node:child_process'
// stdin 基础范式（略）之后：
let context = ''
try {
  context = execSync('git status --short --branch', { cwd: input.cwd, encoding: 'utf8', timeout: 5000 })
} catch { /* 非 git 仓库等场景静默降级 */ }
process.stdout.write(JSON.stringify({
  hookSpecificOutput: { additionalContext: `当前 git 状态：\n${context || '（不可用）'}` }
}))
```

### 范式 3：PermissionRequest 白名单（命中免审批）

```js
// stdin 基础范式（略）之后：
const command = input.tool_input?.command ?? ''
const SAFE = [/^\s*git\s+status\b/, /^\s*npm\s+test\b/]
if (SAFE.some(re => re.test(command))) {
  // allow = 自动批准，不再弹审批；未命中输出 {}，照常弹窗
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { permissionDecision: 'allow' }
  }))
} else {
  process.stdout.write('{}')
}
```

### 范式 4：Stop 强制继续（必须防死循环）

```js
// stdin 基础范式（略）之后：
// stop_hook_active 防循环：本轮已是 hook 强制的续跑，不再阻断
if (input.stop_hook_active) {
  process.stdout.write('{}')
} else {
  const passed = runAcceptanceCheck(input) // 你的验收逻辑，如跑测试
  if (!passed) {
    process.stdout.write(JSON.stringify({
      decision: 'deny',
      reason: '验收未通过：测试有失败用例，请修复后再完成'
    }))
  } else {
    process.stdout.write('{}')
  }
}
```

注意：无 goal 时 Stop 连续强制继续有上限（5 次）；goal 激活时强制续跑计入 goal 熔断预算。脚本侧必须检查 `stop_hook_active`，否则会造成对抗循环。

## 七、调试方法

- **`/hooks log`**：查最近 50 次触发记录（事件/matcher/耗时/exit code/决策）——hook 没生效时第一步就看它。
- **matcher 踩坑点**（行业最常见故障）：
  - matcher **大小写敏感**，工具名以 chill 实际注册名为准（如 `write_file`，不是 `WriteFile`）；
  - `|` 两侧**不要留空格**（`a|b` 正确，`a | b` 匹配不到）；
  - 正则将直接用于匹配，含特殊字符要转义；不确定就先放宽 matcher 确认触发，再收窄。
- **fail-open 行为**：脚本崩溃/超时/输出非法 JSON 都不会卡死对话——只警告并按原参数继续。调试期可在脚本里把诊断写 stderr（exit 0 时 stderr 仅入日志，不反馈模型）。
- **手动测试**：`echo '{"hook_event_name":"PreToolUse","tool_name":"execute_powershell","tool_input":{"command":"rm -rf /"}}' | node ~/.chill/hooks/scripts/<name>.mjs`，看 stdout 与 `echo $?` 的 exit code。
- 改 hooks.json 后下一轮对话即生效（mtime 惰性重载）；改脚本文件立即生效。

## 八、安全须知（生成脚本时务必遵守）

- **项目级 hooks（`.agents/hooks.json`）首见或内容变更时需用户当场信任批准**（按 name+command 哈希），批准前一律不执行——你帮用户写项目级 hook 时，要预期并解释这次信任询问。
- **hook 子进程不受 chill 写边界约束**：hook 以用户凭据执行任意命令，是用户自装的受信代码——安装确认（diff 审批/哈希信任）即边界。因此：
  - 生成的脚本要**最小权限**：只做声明的那一件事，不读无关文件、不联网、不递归删除；
  - 脚本行为要**明确可见**：名字即意图，安装确认时向用户讲清"它会做什么、什么时候触发"；
  - 不生成收集/外发用户数据的逻辑；不生成混淆代码。
- 硬安全层（commandSafety 黑名单）在决策管线最前、不可覆盖——hook 的 allow 减码只作用于审批环节，碰不到硬安全层；不要试图用 hook 绕过它。
