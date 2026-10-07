# @assistant-ai/chill（全档包）

AI 助手 **全档** 安装包：一条命令得到 chill CLI 的全部能力，外加 **Electron 独立桌面窗口**。

```bash
npm install -g @assistant-ai/chill
```

## 装完你会得到什么

- 一个命令 `chill`（与轻档 `@assistant-ai/chill-cli` 用法完全一致）：
  - `chill` —— 终端 TUI 完整助手（`chill --help` 查看全部用法）
  - `chill web` —— 浏览器完整界面
  - `chill serve on` —— 7×24 常驻宿主（定时任务 / 手机遥控后端）
- **桌面窗口**：TUI 里输入 `/ui` —— 打开 Electron 独立窗口，并把当前会话接力过去
  （终端聊到一半，窗口里接着聊）。开窗后配置、聊天、看板全部在窗口内，可以不再碰终端。

## 与轻档的关系

| | 轻档 `@assistant-ai/chill-cli` | 全档 `@assistant-ai/chill` |
|---|---|---|
| 体积 | 十几 MB | 安装时另拉 Electron 运行时（约 100MB） |
| 桌面窗口（`/ui`） | ❌（提示升级路径） | ✅ |
| 其余功能 | ✅ 全部 | ✅ 全部（逐字相同） |

两档共用同一份 `~/.chill` 数据（Key/会话/记忆/定时任务），轻档升全档无缝。

**不要同时安装两档**（`chill` 命令名冲突，npm 会报 EEXIST；卸掉一个即可）。

## 国内安装提示

Electron 运行时默认从 GitHub 下载，国内网络建议先设置镜像：

```bash
# PowerShell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
# CMD
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
# 然后执行 npm install -g @assistant-ai/chill
```

## 桌面控制（Windows）

TUI 里 `/desktop on` 可让 AI 直接操控本机（截屏/点按/输入）。原生模块随依赖自动安装，
免编译即用；当前仅支持 Windows x64，其他平台会得到明确提示。

## 许可

MIT
