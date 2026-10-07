/**
 * pairCommands.ts — CLI /pair 与 /relay 命令（M2a）。
 *
 * /pair        出配对二维码（隐含经 relay.lock 租约尝试启动 relay；配对要求桌面在线）
 * /pair list   已配对设备
 * /pair revoke <设备名|phonePub 前缀>  注销对向信箱 + 删本地记录
 * /pair config 配置 relay 地址/运营者密钥/CA 路径（存 secureStorage；代码零默认地址）
 * /relay start|stop|status  中继手动控制（经租约仲裁）
 *
 * 协议义务：QR 会留在终端 scrollback → 提示配对完成后清屏（设计 §3.3）。
 */
import type { Interface } from 'node:readline'
import { readFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { sep } from 'node:path'
import { spawn } from 'node:child_process'
import {
  PairingManager,
  caFingerprint,
  type PairedDevice,
} from '@assistant-ai/core'
import type { CliRelayClient } from './relayClient.js'
import { saveCliRelayConfig } from './relayClient.js'
import { NodeRelayHttp } from './NodeRelayHttp.js'
import { isTuiActive, hasAskPresenter, presentAsk } from '../tui/tuiState.js'

export interface PairHandlerDeps {
  rl: Interface
  pairingManager: PairingManager
  relayClient: CliRelayClient
  /** 备用单行输入（TUI 暂停 rl 时由调用方保证不走此路；/pair config 标 interactive 回 CLI 执行） */
  print?: (s: string) => void
}

const print = (s: string) => process.stdout.write(s + '\n')

/** y/n 提问（配对确认/操作确认；TUI 经消息区，CLI 经 rl.question——同审批通道范式） */
function askYn(rl: Interface, question: string): Promise<boolean> {
  if (isTuiActive() && hasAskPresenter()) {
    const p = presentAsk(question, [
      { label: 'y', description: '确认' },
      { label: 'n', description: '拒绝' },
    ], false)
    if (p) return p.then((a) => a.trim().toLowerCase() === 'y')
  }
  return new Promise((resolve) => {
    rl.question(`\n${question} (y/n): `, (answer: string) => resolve(answer.trim().toLowerCase() === 'y'))
  })
}

function askLine(rl: Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, (answer: string) => resolve(answer.trim())))
}

async function renderQr(text: string): Promise<void> {
  const qrcode = (await import('qrcode-terminal')).default
  await new Promise<void>((resolve) => qrcode.generate(text, { small: true }, (qr: string) => {
    process.stdout.write(qr + '\n')
    resolve()
  }))
  // 终端 QR 是白块黑底（反色），ML Kit 等扫描器常常读不出；
  // 同时生成标准黑块白底 PNG 并用系统查看器打开，手机扫图片窗口
  try {
    const qrPng = (await import('qrcode')).default
    const pngPath = `${tmpdir()}${sep}chill-pair-qr.png`
    await qrPng.toFile(pngPath, text, { width: 480, margin: 2 })
    spawn('cmd', ['/c', 'start', '', pngPath], { detached: true, stdio: 'ignore' }).unref()
    print(`二维码图片已打开（扫不出终端二维码时扫图片）：${pngPath}`)
  } catch {
    print('（PNG 二维码生成失败，仅终端二维码可用）')
  }
}

export async function handlePair(input: string, deps: PairHandlerDeps): Promise<void> {
  const { rl, pairingManager: pm, relayClient } = deps
  const rest = input.slice('/pair'.length).trim()

  // ---- /pair config ----
  if (rest === 'config') {
    print('\n中继配置（存 secureStorage；未配置的子命令会提示先 config）')
    const relayUrl = await askLine(rl, '  relay 地址（ws:// 或 wss://host:port）: ')
    if (!/^wss?:\/\//.test(relayUrl)) {
      print('  ❌ 地址须以 ws:// 或 wss:// 开头\n')
      return
    }
    const operatorKey = await askLine(rl, '  运营者密钥（服务器 operator.env 的 OPERATOR_KEY）: ')
    let caPath = ''
    let caFP = ''
    if (relayUrl.startsWith('wss://')) {
      caPath = await askLine(rl, '  私有 CA 证书路径（.crt/.pem）: ')
      try {
        // caFP = CA 证书文件字节的 SHA-256（与手机端读取同一文件计算的口径一致）
        caFP = caFingerprint(new Uint8Array(readFileSync(caPath)))
      } catch (err) {
        print(`  ❌ CA 证书读取失败: ${String(err)}\n`)
        return
      }
    }
    await saveCliRelayConfig(pm, { relayUrl, operatorKey, caFP, caPath })
    print('  ✅ 配置已保存\n')
    return
  }

  // ---- /pair list ----
  if (rest === 'list') {
    const devices = await pm.listDevices()
    if (devices.length === 0) {
      print('\n（无已配对设备）\n')
      return
    }
    print('\n已配对设备:')
    for (const d of devices) {
      print(`  ${d.device}  pairedAt=${d.pairedAt}  phonePub=${d.phonePub.slice(0, 12)}…`)
    }
    print('')
    return
  }

  // ---- /pair deskpub ----（手机自动更新发现：feed 路径派生自本机设备公钥——独立 guardian 脚本
  // 读不到加密密钥库，运营者经此导出一次性配入 mobile-push.json 的 deskPub 字段）
  if (rest === 'deskpub') {
    const desk = await pm.getOrCreateDeviceKey()
    print('\n本机设备公钥（base64url）——配入 ~/.chill/mobile-push.json 的 "deskPub" 字段:')
    print(`  ${desk.publicKey}\n`)
    return
  }

  // ---- /pair revoke <设备> ----
  if (rest.startsWith('revoke')) {
    const query = rest.slice('revoke'.length).trim()
    if (!query) {
      print('\n用法: /pair revoke <设备名|phonePub 前缀>\n')
      return
    }
    const devices = await pm.listDevices()
    const target = devices.find((d) => d.device === query || d.phonePub.startsWith(query))
    if (!target) {
      print(`\n未找到设备: ${query}（/pair list 查看）\n`)
      return
    }
    const config = await pm.getRelayConfig()
    if (!config) {
      print('\n请先 /pair config 配置中继\n')
      return
    }
    const http = new NodeRelayHttp(config.relayUrl, (await pm.getCaPath()) ?? undefined)
    const r = await pm.revokeDevice(http, target.phonePub)
    print(r.ok ? `\n✅ 已注销设备 ${target.device}（对向信箱已注销，本地记录已删除）\n` : `\n⚠️ 服务器响应 HTTP ${r.status}；本地记录已删除\n`)
    return
  }

  // ---- /pair（出码） ----
  if (rest === '') {
    const config = await pm.getRelayConfig()
    if (!config) {
      print('\n请先 /pair config 配置中继（relay 地址/运营者密钥/CA 路径）\n')
      return
    }
    // 隐含启动 relay：配对要求桌面在线（hello 投进桌面信箱，须有人读）
    const startResult = await relayClient.start()
    if (startResult === 'held-by-other') {
      const st = await relayClient.status()
      print(`\nrelay 由当前在线的另一 chill 端运行（holder: ${st.holder ?? '?'}）——配对确认将出现在当前在线的 chill 端`)
    }
    const http = new NodeRelayHttp(config.relayUrl, (await pm.getCaPath()) ?? undefined)
    let qr: Awaited<ReturnType<typeof pm.startPairing>>['qr']
    let expires: number
    try {
      ;({ qr, expires } = await pm.startPairing(http, config, hostname() || 'chill 桌面'))
    } catch (err) {
      print(`\n❌ 签发配对令牌失败: ${String(err)}\n`)
      return
    }
    // 配对令牌即刻落 secureStorage：跨端配对时当前在线端的 bridge 懒读它验 pairingMAC
    await pm.savePairingToken(qr.token)

    print('\n用手机 chill App 扫码配对（QR 会留在终端 scrollback，配对完成后请清屏）:')
    await renderQr(JSON.stringify(qr))
    print(`QR JSON: ${JSON.stringify(qr)}`)
    print('等待手机 redeem（轮询 /pair/status）…')

    const result = await pm.waitForRedeem(http, qr.token, expires)
    if (result.state === 'expired') {
      print('\n配对令牌已过期，请重新 /pair 出码\n')
      return
    }
    if (result.state === 'timeout') {
      print('\n配对超时，请重新 /pair 出码\n')
      return
    }
    print(`\n手机已登记：${result.device}（等待 pair.hello 密钥确认…）`)
    await pm.completePairing(result.phonePub, result.device, qr.token)
    if (relayClient.isRunning()) {
      const device: PairedDevice = { phonePub: result.phonePub, device: result.device, pairedAt: new Date().toISOString() }
      await relayClient.attachPeer(device, qr.token, false)
      print('本端 relay 在线：请在下方确认配对（显示手机设备名 + 装饰性指纹）\n')
    } else {
      print('配对确认将出现在当前在线的 chill 端\n')
    }
    return
  }

  print('\n用法: /pair [list | revoke <设备> | config]\n')
}

export async function handleRelay(input: string, deps: PairHandlerDeps): Promise<void> {
  const { relayClient } = deps
  const rest = input.slice('/relay'.length).trim()
  if (rest === 'start') {
    const r = await relayClient.start()
    if (r === 'held-by-other') {
      const st = await relayClient.status()
      print(`\nrelay 已在另一 chill 端运行（holder: ${st.holder ?? '?'}），本端进入等待——对方退出后自动接管（/relay stop 取消）\n`)
    }
    return
  }
  if (rest === 'stop') {
    await relayClient.stop()
    return
  }
  if (rest === 'status') {
    const st = await relayClient.status()
    print(`\nrelay 状态: running=${st.running}  holder=${st.holder ?? '无'}  connected=${st.connected}  peer=${st.peerDevice ?? '无'}${st.waiting ? '  waiting=等待租约中（自动重试）' : ''}\n`)
    return
  }
  print('\n用法: /relay start|stop|status（中继手动控制）\n')
}

/** 配对确认提问（RelayClient 的 askConfirm 接线） */
export function makeAskConfirm(rl: Interface): (device: string, fingerprint: string) => Promise<boolean> {
  // 无头/自动化测试通道：CHILL_RELAY_AUTO_CONFIRM=1 时跳过人工确认（仅测试用，勿在生产设置）
  if (process.env['CHILL_RELAY_AUTO_CONFIRM'] === '1') {
    return async (device, fingerprint) => {
      console.log(`\n[relay] 自动确认配对（CHILL_RELAY_AUTO_CONFIRM=1）：${device} 指纹 ${fingerprint}`)
      return true
    }
  }
  return (device, fingerprint) =>
    askYn(rl, `手机「${device}」请求配对（装饰性指纹 ${fingerprint}，请与手机显示核对）——确认配对?`)
}
