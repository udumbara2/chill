/**
 * `chill-relay --init` 最小部署向导（0.0.2 范围：密钥 + systemd 单元 + 启动清单）。
 *
 * 原则：
 * - 只产出现成内容，不代执特权操作（cp 到 /etc/systemd/system 需要 sudo，打印命令由用户执行）
 * - 已有运营者密钥绝不覆盖（env > ./chill-relay.env > 生成新钥）
 * - 数据位与程序位分离：单元里 DB_PATH 指向 /var/lib/chill-relay（node_modules 是只读程序位）
 * - plain ws 如实警告（仅家庭网络信任域；公网裸奔会被扫描）
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ENV_FILE_NAME = 'chill-relay.env'

function existingOperatorKey(envFilePath: string): string | null {
  if (process.env['OPERATOR_KEY']) return process.env['OPERATOR_KEY']
  if (existsSync(envFilePath)) {
    const text = readFileSync(envFilePath, 'utf8')
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line.startsWith('OPERATOR_KEY')) continue
      const eq = line.indexOf('=')
      if (eq > 0) return line.slice(eq + 1).trim()
    }
  }
  return null
}

function systemdUnit(envFileAbs: string, execNode: string, execCli: string): string {
  return `\
[Unit]
Description=chill relay (blind relay for mobile remote)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${envFileAbs}
WorkingDirectory=/var/lib/chill-relay
Environment=DB_PATH=/var/lib/chill-relay/relay.db
ExecStart=${execNode} ${execCli}
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
`
}

export function runInit(): void {
  const here = dirname(fileURLToPath(import.meta.url)) // dist/src
  const envFilePath = join(process.cwd(), ENV_FILE_NAME)

  // 1. 运营者密钥：沿用优先，缺失才生成
  const existing = existingOperatorKey(envFilePath)
  const key = existing ?? randomBytes(32).toString('base64')
  if (existing) {
    console.log(`✓ 沿用已有 OPERATOR_KEY（${existing === process.env['OPERATOR_KEY'] ? '进程环境' : ENV_FILE_NAME}）`)
  } else {
    writeFileSync(envFilePath, `OPERATOR_KEY=${key}\n`, { mode: 0o600 })
    try { chmodSync(envFilePath, 0o600) } catch { /* Windows 开发环境无碍 */ }
    console.log(`✓ 已生成运营者密钥并写入 ${envFilePath}（权限 0600，勿提交任何仓库）`)
  }

  // 2. systemd 单元（程序位=安装树，数据位=/var/lib/chill-relay）
  const envFileAbs = resolve(envFilePath)
  const execCli = process.argv[1] ? resolve(process.argv[1]) : '/usr/local/lib/node_modules/@assistant-ai/chill-relay/dist/src/cli.js'
  const unit = systemdUnit(envFileAbs, process.execPath, execCli)
  console.log('\n=== systemd 单元（保存为 /etc/systemd/system/chill-relay.service）===')
  console.log(unit)
  console.log('安装并启动（需要 sudo）：')
  console.log('  sudo mkdir -p /var/lib/chill-relay')
  console.log(`  sudo cp ${envFileAbs} /etc/chill-relay.env   # env 文件挪到系统位（可选，单元 EnvironmentFile 同步改）`)
  console.log('  # 把上面的单元内容存为 /etc/systemd/system/chill-relay.service 后：')
  console.log('  sudo systemctl daemon-reload && sudo systemctl enable --now chill-relay')

  // 3. 启动清单（如实边界）
  const port = process.env['PORT'] ?? '8443'
  const hasTls = !!(process.env['TLS_KEY_PATH'] && process.env['TLS_CERT_PATH'])
  console.log('\n=== 清单 ===')
  console.log(`· 端口：${port}（防火墙放行：ufw allow ${port}/tcp 或 firewalld --add-port=${port}/tcp）`)
  if (!hasTls) {
    console.log('· ⚠ 当前为 plain ws（无 TLS）：仅限家庭网络/可信内网使用，请勿在公网裸奔')
    console.log('  公网部署请配置 TLS_KEY_PATH/TLS_CERT_PATH（自签证书）——注意：官方手机 APK 钉了官方 CA，')
    console.log('  自签 wss 需要重编 APK（源码在公开仓，res/raw/ca_crt.pem 替换为自己的证书）')
  }
  console.log('· 桌面端接入：chill → /pair config 填本中继地址与运营者密钥 → serve on → 扫码')
  console.log(`· 数据库：systemd 形态在 /var/lib/chill-relay/relay.db；直接前台运行则在当前目录 ${ENV_FILE_NAME} 旁`)
  console.log('· 升级：npm update -g @assistant-ai/chill-relay && sudo systemctl restart chill-relay')
}
