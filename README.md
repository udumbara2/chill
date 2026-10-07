# chill — AI 助手全家桶（四件套源码仓）

一个 AI 助手 = 一个会话引擎（ChatEngine）+ 多个壳。本仓是全部源码的公开之家，含四个组件：

| 目录 | 是什么 | 独立安装 |
|---|---|---|
| `chill/` | monorepo 本体：core（引擎）+ cli（终端壳）+ electron/ui/web（桌面与浏览器壳） | `npm install -g @assistant-ai/chill-cli`（轻档）/ `@assistant-ai/chill`（全档，含桌面窗口） |
| `chill-relay/` | 盲中继服务：手机遥控的配对信箱（只见密文，端到端加密在两端完成） | `npm install -g @assistant-ai/chill-relay`（装你自己的服务器） |
| `chill-guardian/` | 版本切换与自迭代守护工具（switcher / freeze / mobile-freeze / mobile-push） | 随 chill-cli 的 guardian/ 目录分发，无需单独安装 |
| `chill-mobile/` | 手机 App（React Native，Android） | GitHub Releases 下载 APK |

## 三条安装命令 + 一个 APK

```bash
npm install -g @assistant-ai/chill-cli     # 终端 + 浏览器全功能助手
npm install -g @assistant-ai/chill         # 同上 + 独立桌面窗口（TUI 内 /ui 启动）
npm install -g @assistant-ai/chill-relay   # 中继服务（部署到自己的 VPS；--init 向导）
```

手机 App 从 GitHub Releases 下载 APK 安装。装好后：

```
chill → /key set <provider> <apiKey> → /model    # 30 秒上手
chill web                                        # 浏览器完整界面
chill serve on                                   # 7×24 常驻（定时任务 + 手机遥控后端）
/desktop on                                      # AI 操控本机（仅 Windows x64）
/pair config → 扫码                               # 手机遥控（需自建中继）
```

## 自迭代：AI 能改 AI 自己

TUI 里一条命令开启（自动下载对版源码到 `~/.chill/workspace/`，无需 git）：

```
/fetch-source
```

拉下来的就是本仓四件套的同构布局——AI 既能改桌面端自己（`/switch-version` 切换生效），也能改手机端（内置技能 mobile-iterate：改码 → 快照固化 → 构建推送你自己的 APK）。详见 [chill/packages/cli/README.md](chill/packages/cli/README.md)。

## 自建中继（手机遥控）

```bash
# 你的 VPS 上：
npm install -g @assistant-ai/chill-relay
chill-relay --init        # 向导：运营者密钥、systemd 单元、端口清单
# 桌面端：
chill → /pair config 填中继地址 → chill serve on → 手机扫码
```

在家（同一 WiFi）可零成本：中继直接跑在桌面本机（`chill-relay` 一条命令），手机连 `ws://192.168.x.x:8443`。

**边界（如实）**：官方 APK 钉了官方 CA 指纹——自签证书的 wss 需要重编 APK（本仓 `chill-mobile/` 源码即可，替换 `res/raw/ca_crt.pem`）；plain ws 仅限家庭网络/可信内网，公网部署请配 TLS。

## 开发

```bash
git clone https://github.com/udumbara2/chill.git
cd chill/chill && pnpm install && pnpm build && pnpm build:cli
```

手机端构建需要 JDK 17 + Android SDK；Windows 用户名为中文时须配置纯 ASCII 构建场（如 `C:\dev\chill-mobile`）。各组件细节见各自目录的 README。

## 如实边界清单

1. 桌面控制（`/desktop on`）当前仅支持 Windows x64，其他平台明确提示不崩溃
2. 官方 APK 与自编 APK 签名不同，互不覆盖升级（自编 = 你自己的分叉）
3. 手机遥控默认无内置中继——零默认地址是安全设计，不是缺陷
4. 中继是盲中继：服务端只见密文；但 `static/` 发布通道下的产物对运营者可见（分层凭据模型见 chill-relay/README.md）

## 许可

MIT
