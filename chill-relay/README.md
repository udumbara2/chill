# @assistant-ai/chill-relay

chill **盲中继**：手机遥控电脑的配对信箱中继服务。服务端只见密文（端到端加密在桌面/手机两端完成），自建部署，一条命令。

## 安装与部署

装在你自己的服务器（VPS）上：

```bash
npm install -g @assistant-ai/chill-relay
chill-relay --init
```

`--init` 向导会：生成运营者密钥（写入 `chill-relay.env`，权限 0600）、打印 systemd 单元（数据目录指向 `/var/lib/chill-relay`，程序位与数据位分离）、打印端口/防火墙清单。

直接前台运行（调试）：`chill-relay`（env 来源：进程环境 > `./chill-relay.env` > `/etc/chill-relay/env`）。

### 在家零成本形态（可选）

人在家、手机与电脑同一 WiFi 时，中继可以直接跑在桌面电脑本机：

```bash
npm install -g @assistant-ai/chill-relay
chill-relay            # 本机起服务
# 桌面 chill → /pair config 填 ws://192.168.x.x:8443 → serve on → 扫码
```

⚠ **plain ws 仅限家庭网络/可信内网**。公网部署请配置 TLS，且注意官方手机 APK 钉了官方 CA 指纹——自签证书的 wss 需要重编 APK（源码在公开仓，替换 `res/raw/ca_crt.pem`）。

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `OPERATOR_KEY` | ✅ | 运营者密钥（信任根，门配对令牌签发；`--init` 可代生成，等价 `openssl rand 32 \| base64`） |
| `PORT` | | 监听端口，默认 8443 |
| `DB_PATH` | | SQLite 路径，默认 `relay.db`（systemd 形态建议 `/var/lib/chill-relay/relay.db`） |
| `TLS_KEY_PATH` / `TLS_CERT_PATH` | | 配置后启用 wss；不配为 plain ws |
| `PUBLISH_TOKEN` | | 启用静态发布通道（`PUT /publish` + `GET /static/*`） |
| `STATIC_DIR` | | 静态产物目录，缺省 DB 同目录 `static/` |

## 静态发布通道安全模型（运营者须知）

- **分层凭据**：`PUBLISH_TOKEN` 是独立低权凭据（仅可按白名单写 `static/`，受单文件/总量/频次三重配额约束，改 env 即撤销）；`OPERATOR_KEY` 门配对令牌签发（信任根），**永不落地客户端**——两者不得互换或复用
- **静态文件非盲**：`static/` 下是明文产物，运营者可读——与信箱的盲性是两回事，如实承认；访问凭据 = 不可猜文件名
- **shots/ 短保留**：默认 48h 过期；**apk/ 保留最近 20 版**（feed 清单引用的包豁免；回退走源码层重建重推）
- **防枚举**：成功访问不打含路径的日志；无目录列举
- **凭据栖息地**：服务器 systemd EnvironmentFile；客户端 `~/.chill/`。均不进任何 git 仓库

## 桌面端接入

```
chill → /pair config 填中继地址与运营者密钥 → chill serve on → 手机扫码
```

## 升级

```bash
npm update -g @assistant-ai/chill-relay && sudo systemctl restart chill-relay
```

## 许可

MIT
