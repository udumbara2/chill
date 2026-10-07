# chill-relay 部署手册（M1b）

目标机：任意 Linux x64 服务器（示例：阿里云 ECS / Alinux3，<RELAY_IP>）。生产 = tsc 构建 + 纯 node 跑 dist/。

## 1. 系统确认

```bash
cat /etc/os-release && ldd --version   # 预期 Alinux3 / glibc 2.32；若是 2 换镜像
# 编译兜底（实测必需，见 §3 注）：
dnf install -y gcc-c++ make python38   # Alinux3 默认 python3=3.6 太旧，node-gyp 需 ≥3.8
```

## 2. Node 24 tarball

```bash
cd /tmp && curl -fsSLO https://nodejs.org/dist/v24.20.0/node-v24.20.0-linux-x64.tar.xz
tar -xJf node-v24.20.0-linux-x64.tar.xz -C /usr/local --strip-components=1
ln -sf /usr/local/bin/node /usr/bin/node && ln -sf /usr/local/bin/npm /usr/bin/npm
node -v   # v24.20.0
```

## 3. 部署

```bash
useradd -r -s /sbin/nologin chillrelay || true
cd /opt && git clone <repo> chill-relay && cd chill-relay
npm ci
npm run build
```

**实测坑（2026-09-02 首部署）**：
1. **better-sqlite3 v13 自带 prebuilds 要求 glibc ≥2.33，Alinux3（2.32）不兼容**——运行时 binding.js 优先选 prebuild 会报 `GLIBC_2.33 not found`。处理：`rm -rf node_modules/better-sqlite3/prebuilds` 强制走源码编译。
2. **npm v11 默认拦截 install scripts**（"not covered by allowScripts"），npm ci/rebuild 可能显示成功但实际没编译。处理：直接 node-gyp 手动编：
   ```bash
   cd node_modules/better-sqlite3
   /usr/local/bin/node /usr/local/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js rebuild --python=/usr/bin/python3.8
   ls build/Release/better_sqlite3.node   # 必须存在
   ```
3. 验证：`runuser -u chillrelay -- node -e "require('better-sqlite3')"`

```bash
# 运营者密钥：openssl rand 32 生成，EnvironmentFile 权限 600
install -d -m 700 /etc/chill-relay/certs
( umask 077; cat > /etc/chill-relay/operator.env <<EOF
OPERATOR_KEY=$(openssl rand 32 | base64)
PORT=8443
DB_PATH=/opt/chill-relay/relay.db
TLS_KEY_PATH=/etc/chill-relay/certs/server.key
TLS_CERT_PATH=/etc/chill-relay/certs/server.crt
EOF
)

# 证书（在服务器上直接生成，CA_PASS 环境变量非交互）：
CA_PASS=$(openssl rand -base64 24) bash scripts/gen-certs.sh <RELAY_IP> <RELAY_DOMAIN> /etc/chill-relay/certs
# CA_PASS 记入密码管理器；ca.key 加密私钥离线备份（U 盘）
chgrp chillrelay /etc/chill-relay/certs && chmod 750 /etc/chill-relay/certs
chgrp chillrelay /etc/chill-relay/certs/server.key && chmod 640 /etc/chill-relay/certs/server.key
chown -R chillrelay:chillrelay /opt/chill-relay

install -m 644 scripts/chill-relay.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now chill-relay
systemctl status chill-relay
curl --cacert /etc/chill-relay/certs/ca.crt --resolve <RELAY_DOMAIN>:8443:127.0.0.1 https://<RELAY_DOMAIN>:8443/health   # {"ok":true}
```

## 4. 安全组与 SSH

- 只放 22（限常用 IP 段，或改用阿里云 Workbench 登录）+ 8443
- SSH 禁密码登录（`PasswordAuthentication no`）

## 5. 备份（只备 mailboxes 表）

```bash
install -m 755 scripts/backup.sh /opt/chill-relay/backup.sh
# systemd timer 每日执行，gzip 保留 14 天
```

恢复 runbook：恢复备份后**全量信箱视为可疑 → 阶段 A 直接全量重配对**（防已 revoke 信箱复活）。

## 6. 日志口径

- 连接元数据日志保留 6 个月；应用日志 logrotate 30 天
- 任何日志不落信封 blob、不落令牌明文、不落请求路径中的敏感参数

## 7. 云监控告警

入带宽 >80%、出方向流量突增（肉鸡检测）、黑洞事件通知。
黑洞预案：被打进黑洞 = 等解封（默认约 2.5 小时），期间手机提示"中继不可达"。书面接受。

## 8. OPERATOR_KEY 轮换五步

1. `openssl rand 32 | base64` 生成新钥 → 写 `/etc/chill-relay/operator.env`
2. `systemctl restart chill-relay`
3. 桌面侧更新本地保存的密钥（M1 demo 读环境变量，勿提交；M2 进 secureStorage）
4. `relay-admin list-boxes` 审计现有信箱无异常
5. 旧钥确认失效（`curl -H "Authorization: Bearer <旧钥>" .../pair/tokens` 应 401）

## 9. 换机 runbook

DNS TTL 提前调低 → 新机部署 → 停旧机 → 拷 SQLite → 切解析。mailboxId 不变则设备无感。
注意：换云厂商/换账号需备案接入变更，有中断风险；relay 地址写死在配对 QR，换地址 = 全端重配对。

## 10. M1b 验收

真机 wss+pinning 全链路：demo 带 CA pin 连 <RELAY_IP>；错 CA 必拒。
