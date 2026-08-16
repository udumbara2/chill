---
name: self-iterate
description: 程序自迭代。当用户要求对本助手项目（chill）自身的源代码进行任何修改、改进、优化时必须使用。包括但不限于：修改UI界面、改变颜色风格、调整布局、修复bug、添加功能、重构代码、优化性能、修改配置等。只要修改的目标文件属于 chill 项目自身的代码，就必须使用此技能。
---

# 自迭代 SKILL

指导模型修改、测试并升级自身的源代码。每次自迭代必须严格遵循以下流程。

## 流程概览

```
检查 workcopy → 设计验证方案 → 创建 workcopy（排除 Rust 缓存）→ 接入共享编译缓存 → 安装编译 → 读档案库
→ 改代码 → 编译 → 测试 → 评估 → 成功/失败处理
```

Rust 构建缓存（native-desktop/target）不随拷贝旅行：由「第四步半」的 junction 统一接项目父目录的共享缓存，编译增量语义与拷贝携带时完全一致。

## 第一步：检查 workcopy 和恢复状态

用 execute_powershell 检查 workcopy 是否已存在：

```powershell
Test-Path "<workcopy绝对路径>"
```

- **若存在**：先用 read_file 检查 `<workcopy绝对路径>/.ready-for-switch` 文件是否存在：
  - **.ready-for-switch 存在**：说明上次自迭代已完成但未切换版本。读取文件内容，向用户报告：
    "检测到已完成的自迭代（目标：xxx），你可以：
      - 切换到新版本（输入 /switch-version 或确认切换）
      - 继续修改 workcopy 代码（修改后需重新编译并重启体验窗口）
      - 放弃（输入 /discard-version）"
    - 用户确认切换 → 调用 trigger_guardian 工具执行版本切换（参数从 .ready-for-switch 文件中读取）
    - 用户想继续修改 → 跳到第七步在 workcopy 中修改代码，修改后重新编译+测试+更新 .ready-for-switch，然后重新打开体验窗口
    - 用户放弃 → 删除 workcopy 和 `.ready-for-switch`，然后开始新迭代
  - **.ready-for-switch 不存在**：用 read_file 读取 `<chill-archive绝对路径>/current-iteration.json`，向用户报告：
    "检测到未完成的自迭代 workcopy，要在上次的基础上继续吗？"
    - 用户选"继续"：从中断点恢复执行。通过检查 workcopy 的 `dist/` 目录是否存在、是否有编译产物来推断中断点：
      - dist 不存在或为空 → 从安装编译步骤开始
      - dist 存在 → 继续上次未完成的步骤
    - 用户选"不继续"：删除 workcopy 和 `<chill-archive绝对路径>/current-iteration.json`，开始新迭代
  - **两者都不存在**：异常状态，向用户报告"workcopy 状态异常，建议放弃后重新开始"。删除 workcopy 后开始新迭代
- **若不存在**：开始新迭代

## 第二步：准备工作

1. 提示用户先执行 `/auto-apply on`，否则每个命令都需要手动确认
2. chill 项目路径、项目父目录、workcopy、chill-archive 的绝对路径已在系统提示的「当前运行状态」中给出，后续所有命令与文件操作一律使用这些绝对路径
3. auto-switch 状态已由系统提示词注入（`auto-switch：已开启` 或 `已关闭`），直接读取即可，无需额外命令。若为"已开启"，迭代完成后自动切换版本；若为"已关闭"，迭代完成后打开体验窗口。
4. 设计验证方案并**强制落盘**：用 create_file 写 `<chill-archive绝对路径>/verify-current.md`，包含：
   - **验收标准**：编号清单，每条含【测试输入 → 期望输出 → 通过判据】；必须覆盖 ① 用户目标本身 ② 不回归冒烟（CLI 正常启动）
   - **测试计划**：执行步骤、每条标准对应的验证方式（脚本/命令/人工判断）
   - 需要可执行脚本时，同目录用 create_file 写 `<chill-archive绝对路径>/verify-current.ps1`（或 `verify-current.mjs`）：**被测目标目录必须作为第一个参数传入**（路径无关，便于日后对任意版本复验），输出逐条 PASS/FAIL 与总结行
   - **未写出 `verify-current.md` 不得进入第四步**。此为硬性产物，不允许只在对话中口头描述验证方案

## 第三步：写入状态文件

用 create_file 写入 `<chill-archive绝对路径>/current-iteration.json`，内容格式：

```json
{
  "goal": "用户提出的自迭代目标",
  "verificationPlan": "验证方案的描述",
  "currentStep": "creating-workcopy",
  "failedCount": 0
}
```

每完成一个步骤后，用 replace_content 更新 `currentStep` 字段的值（可选值：`creating-workcopy`、`building`、`reading-archive`、`modifying-code`、`compiling`、`testing`、`evaluating`、`done`、`failed`）。

## 第四步：创建 workcopy（确定性命令）

执行以下确定命令（不让模型自由构造）：

```powershell
robocopy "<chill项目绝对路径>" "<workcopy绝对路径>" /E /XD node_modules dist target .backup-*; if ($LASTEXITCODE -ge 8) { exit $LASTEXITCODE } else { exit 0 }
```

退出码 0-7 表示成功（1 代表已复制文件），8+ 表示错误。包装确保 exec 不误判成功为失败。`target` 是 Rust 构建缓存（约 1.5GB），不拷贝，由下一步的 junction 接回共享缓存。

## 第四步半：接入 Rust 共享编译缓存（确定性命令）

workcopy 不携带 Rust 构建缓存，用 junction 把 workcopy 的 target 接到项目父目录下的共享缓存（全局一份，跨迭代/跨 workcopy 复用；不改 Rust 时代码时增量编译秒级命中）。执行以下确定命令：

```powershell
$cache = "<chill项目父目录绝对路径>\chill-rust-target"; $jt = "<workcopy绝对路径>\packages\native-desktop\target"
New-Item -ItemType Directory -Force -Path $cache | Out-Null
cmd /c rmdir "$jt" 2>$null
if (-not (Test-Path $jt)) { try { New-Item -ItemType Junction -Path $jt -Target $cache -ErrorAction Stop | Out-Null; Write-Output "junction 已创建" } catch { Write-Output "警告: junction 创建失败($_)，cargo 将冷编译，流程继续" } } else { Write-Output "target 为真实目录（冷缓存场景），保持原样" }
```

- `New-Item -Force` 幂等：共享缓存被误删后残留的悬挂 junction 也会被自愈（缓存目录重建）
- `cmd /c rmdir` 只摘链接/空目录：非空真实目录会失败保留，走"保持原样"分支
- junction 创建失败仅警告不阻断：cargo 会自建真实 target 目录冷编译，流程照常
- **后续清理 workcopy 前，必须先摘掉该 junction**（见失败处理与 /discard-version：`cmd /c rmdir` 对 junction 保证只删链接，防止 PowerShell 5.1 的 `Remove-Item -Recurse` 遍历进共享缓存）

## 第五步：安装依赖和编译 workcopy

执行以下确定命令：

安装依赖：
```powershell
pnpm install
```
- working_directory：设为 `<workcopy绝对路径>`
- timeout：300000（5 分钟）

编译：
```powershell
pnpm build; pnpm build:cli
```
- working_directory：同上
- timeout：300000
- 注意：`pnpm build` 只编译 core + electron，不含 CLI。`pnpm build:cli` 单独编译 CLI 包，生成 `packages/cli/dist/cli.js`，体验窗口和冒烟测试都依赖此文件。

## 第六步：读取档案库

用 read_file 读取 `<chill-archive绝对路径>/` 目录中的历史迭代记录（如果存在），了解之前尝试过什么、为什么成功或失败。

## 第七步：在 workcopy 中修改代码

1. 用 read_file 读取 workcopy 中需要修改的源码文件
2. 在 workcopy 中修改代码（路径必须在 `<workcopy绝对路径>/packages/` 下）
3. 评估项目结构或模块职责是否发生变化，如有变化则更新 workcopy 中的 `.self.md`；如无变化，无需更新（该文件已自动注入到系统提示词中）

## 第八步：编译 workcopy

```powershell
pnpm build
```
- working_directory：`<workcopy绝对路径>`
- timeout：300000

编译失败时分析错误、修复代码后重新编译，此修复算在 3 次重试限制内。

## 第九步：启动测试

按第二步设计的验证方案，对 workcopy 进行测试。

### 脚本化测试（优先）

若 `<chill-archive绝对路径>/verify-current.ps1`（或 `.mjs`）存在，优先执行它，**第一个参数传 workcopy 的绝对路径**：

```powershell
powershell -ExecutionPolicy Bypass -File "<chill-archive绝对路径>\verify-current.ps1" "<workcopy绝对路径>"
```
（.mjs 则用 `node "<chill-archive绝对路径>\verify-current.mjs" "<workcopy绝对路径>"`）
- working_directory：`<chill项目父目录绝对路径>`
- timeout：按脚本复杂度设定（默认 60000）
- 逐条核对输出的 PASS/FAIL，全部 PASS 才视为脚本测试通过

### 默认冒烟测试

如果验证方案没有指定特殊测试命令，执行以下冒烟测试（启动 workcopy 的 CLI，5 秒内不崩溃即视为通过）：

```powershell
$proc = Start-Process -FilePath "node" -ArgumentList "<workcopy绝对路径>\packages\cli\dist\cli.js" -PassThru -NoNewWindow; Start-Sleep -Seconds 5; if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force; Write-Output "PASS: CLI 启动成功" } else { Write-Output "FAIL: CLI 启动失败，退出码 $($proc.ExitCode)" }
```
- working_directory：`<chill项目父目录绝对路径>`
- timeout：30000

### 自定义测试

或者根据验证方案设计的具体测试命令。例如：
- TypeScript 类型检查：`pnpm tsc --noEmit`（在 workcopy 目录下执行）
- 功能验证：根据修改内容设计具体的测试命令

## 第十步：评估结果

根据验证方案和测试输出，判断是否通过：

### 成功

1. 清理备份文件（replace_content 等工具产生的 `.backup-*` 不应进入新版本，也不应留在档案库）：

```powershell
Get-ChildItem -Path "<workcopy绝对路径>" -Recurse -Filter "*.backup-*" | Remove-Item -Force
Get-ChildItem -Path "<chill-archive绝对路径>" -Filter "*.backup-*" | Remove-Item -Force
```

2. 用 create_file 保存本轮记录到 `<chill-archive绝对路径>/iteration-v<yyyyMMdd-HHmmss>.json`（时间取写入时刻，例如 `iteration-v20260717-155039.json`；版本切换时 switcher 会把该记录改名为与版本目录相同的时间戳，形成一一对应），内容包含：时间、目标、验证方案、评分（如果有）、执行日志。同时将 `<chill-archive绝对路径>/verify-current.*` 改名为与记录同一时间戳的 `iteration-v<yyyyMMdd-HHmmss>.verify.*`（用 execute_powershell 的 Rename-Item），并把验收标准逐条 ✓/✗ 结果补记进该 .md 文件
3. 在 workcopy 根目录创建 `.ready-for-switch` 文件，内容格式：
```
<迭代目标>
时间: <YYYY-MM-DD HH:mm:ss>
project_path=<chill 绝对路径>
guardian_path=<项目父目录>/chill-guardian/switcher.js
```
4. 删除 `<chill-archive绝对路径>/current-iteration.json`
5. **更新改进提案状态**：如果本轮自迭代对应 `~/.chill/improvement-proposals.md` 中「已确认」区的某条改进，用 read_file 读取该文件，将该条目从「已确认」移动到「已实现」，附实施日期。用 replace_content 更新。如果找不到对应条目则跳过。
6. 评估项目结构和模块职责是否变化，如有变化则更新 workcopy 中的 `.self.md`；如无变化，跳过此步（该文件已自动注入到系统提示词中）
7. 根据第二步读取的 autoSwitchAfterIteration 配置选择：
   - **开启（"true"）** → 调用 trigger_guardian 工具执行版本切换（参数：guardian_path 和 project_path 从 .ready-for-switch 文件中读取）。该工具会**同步等待切换完成并返回真实结果**：
     - **成功** → 向用户输出告别提示："版本切换成功，新窗口已打开，当前窗口即将自动关闭。"（系统会在你说完后自动关闭当前窗口，无需手动操作，也无需预设倒计时）
     - **失败** → 工具返回失败步骤、诊断原因与处理建议，当前窗口**不会**关闭。向用户说明失败情况并按建议指导处理（如关闭占用 chill 的终端、重启电脑、解除 OneDrive 钉住等），处理后可重新调用 trigger_guardian 重试，或提示用户执行 /switch-version
   - **关闭（其他值）** → 用 execute_powershell 打开体验窗口：
     ```powershell
     Start-Process powershell -ArgumentList '-NoExit', '-Command', 'node "<workcopy绝对路径>\packages\cli\dist\cli.js"'
     ```
     - working_directory：**必须**设为 `<chill项目父目录绝对路径>`，禁止设为 workcopy 或其内任意路径（体验窗口 CWD 落在 workcopy 内会锁定目录，阻碍版本切换后的 workcopy 清理）
     然后提示用户："新版本已在独立窗口启动。你可以：
       - 输入 /switch-version 切换到新版本
       - 继续对话让我修改 workcopy 中的代码（修改后需重新编译并重启体验窗口）
       - 输入 /discard-version 放弃"

### 失败

1. 保存本轮日志和失败原因到 `<chill-archive绝对路径>/iteration-v<yyyyMMdd-HHmmss>.json`（时间取写入时刻；失败记录保留写入时刻命名，切换时不会被改名）。同时将 `<chill-archive绝对路径>/verify-current.*` 改名为与记录同一时间戳的 `iteration-v<yyyyMMdd-HHmmss>.verify.*`（作为失败分析材料保留，不删除）
2. 清理档案库中的备份文件：

```powershell
Get-ChildItem -Path "<chill-archive绝对路径>" -Filter "*.backup-*" | Remove-Item -Force
```

3. 更新 `<chill-archive绝对路径>/current-iteration.json` 中的 `failedCount` 字段
4. 删除 `<workcopy绝对路径>` 目录（此命令被标记为危险命令，即使用户开启了 autoApply 也需要用户确认）。**删除前必须先摘掉 target junction**（防 `Remove-Item -Recurse` 遍历进共享缓存误删）：

```powershell
cmd /c rmdir "<workcopy绝对路径>\packages\native-desktop\target"
Remove-Item -Recurse -Force "<workcopy绝对路径>"
```

5. 如果 `failedCount < 3`：回到第四步重新开始
6. 如果 `failedCount >= 3`：删除 `current-iteration.json`，通知用户"连续失败 3 次，自迭代已停止"

## 重要规则

- 所有路径操作必须使用绝对路径（chill 项目路径、项目父目录、workcopy、chill-archive 的绝对路径见系统提示的「当前运行状态」）
- workcopy 中的文件修改可使用 read_file + replace_content / insert_content / delete_content / create_file
- 只用内置工具操作，不要尝试手工命令
- 每轮最多重试 3 次，超过后通知用户
