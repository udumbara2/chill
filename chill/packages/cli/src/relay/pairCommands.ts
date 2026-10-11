/**
 * pairCommands.ts — CLI /pair 与 /relay 命令（M2a）。
 *
 * /pair        出配对二维码（隐含经 relay.lock 租约尝试启动 relay；配对要求桌面在线）
 * /pair list   已配对设备
 * /pair revoke <设备名|phonePub 前缀>  注销对向信箱 + 删本地记录
 * /pair config 配置 relay 地址/运营者密钥/CA 路径（CA 选填：wss 留空=公共证书；存 secureStorage；代码零默认地址）
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
  qrRenderPlan,
  type PairedDevice,
} from '@assistant-ai/core'
import type { CliRelayClient } from './relayClient.js'
import { saveCliRelayConfig } from './relayClient.js'
import { NodeRelayHttp } from './NodeRelayHttp.js'
import { isTuiActive, hasAskPresenter, presentAsk, hasQrPresenter, presentQr, closeQrView, presentPrint } from '../tui/tuiState.js'
import { qrHalfBlockLines, qrAnsiBlock } from '../tui/qrBlock.js'

export interface PairHandlerDeps {
  rl: Interface
  pairingManager: PairingManager
  relayClient: CliRelayClient
  /** 打印注入：TUI 下经消息区呈现（2026-10-11 配对原生化后 /pair 全程留在当前界面） */
  print?: (s: string) => void
}

const print = (s: string) => process.stdout.write(s + '\n')

/** 后台异步流程输出（命令已返回后续跑的尾巴）：TUI 经 presentPrint 进消息区——
 *  严禁裸写 stdout（绕开 Ink 帧所有权=重影根源，2026-10-12 实锤）；经典 CLI 直接打印。 */
const bgPrint = (s: string): void => {
  if (isTuiActive()) {
    if (!presentPrint(s)) process.stderr.write(s)
  } else {
    process.stdout.write(s)
  }
}

/** 当前后台配对等待的取代钩：新一轮 /pair 出码即调用——旧等待即刻退场
 *  （单活跃配对原则：防僵尸轮询、防两代流程交叉确认/错关新码） */
let supersedeActivePairWait: (() => void) | null = null

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

/**
 * 单行提问（2026-10-11 TUI 配对原生化）：TUI 下走问答卡自由文本通道（主输入行回车提交、
 * 输入 esc 取消→空串），经典 CLI 走 readline——/pair config 三问全程留在当前界面。
 */
function askLine(rl: Interface, question: string): Promise<string> {
  if (isTuiActive() && hasAskPresenter()) {
    const p = presentAsk(question, undefined, true, '输入后回车提交；输入 esc 取消')
    if (p) return p
  }
  return new Promise((resolve) => rl.question(question, (answer: string) => resolve(answer.trim())))
}

/**
 * QR 渲染：物理计划单源=core qrRenderPlan。三通道按环境择优（规划 R2.4 渲染器统一后）：
 * - TUI：全屏黑码白底半块视图（正方形模块+正确极性，扫屏幕即配对）；窗口不足回落 PNG
 * - 经典 CLI 小载荷：qrBlock 半块码 + SGR 黑码白底直印（与 TUI 同一渲染器）——终端码即显示
 * - PNG 弹窗：仅大载荷/装不下时的兜底（宽度随模块数自适应）
 *
 * 返回 viewClosed（仅 TUI 全屏视图路径）：视图关闭（手动 Esc/q 或扫码自动收码）时 resolve——
 * 调用方以此作 waitForRedeem 的取消谓词（手动关码=放弃本次出码，流程即刻退场，
 * 不再占着命令通道死等 10min 令牌过期）。经典 CLI/PNG 路径无此 handle（码不随视图消失，
 * 手机仍可扫 scrollback/PNG 窗口，等待语义维持原状）。
 */
async function renderQr(text: string): Promise<{ viewClosed?: Promise<void> }> {
  const plan = qrRenderPlan(text.length)
  const qrLib = (await import('qrcode')).default
  const qrObj = qrLib.create(text, { errorCorrectionLevel: plan.errorCorrectionLevel })
  const modules = qrObj.modules.size
  if (isTuiActive()) {
    const rows = process.stdout.rows ?? 0
    const cols = process.stdout.columns ?? 0
    // 两级设计（立法 §8）：装得下 → TUI 全屏内显（实心半块·扫描保证）；装不下 → PNG 兜底+提示。
    // （braille 4×密度点阵已实测淘汰：圆点字体不识别——立法留痕，勿再试）
    const blk = qrHalfBlockLines(qrObj.modules, plan.margin)
    const needRows = blk.rows + 5
    const needCols = blk.cols + 2
    if (rows >= needRows && cols >= needCols && hasQrPresenter()) {
      const p = presentQr({
        lines: blk.lines,
        cols: blk.cols,
        title: `配对二维码（${text.length}B · ${modules}×${modules} 模块 · 纠错 ${plan.errorCorrectionLevel}）`,
      })
      if (p) {
        // 非阻塞展示（真机实测教训：阻塞式会冻结整个 /pair 流程——视图开着时
        // waitForRedeem 不启动、确认卡不可见）：视图保持打开，扫码成功后由
        // closeQrView() 自动收码（Esc/q 手动关闭亦可）
        return { viewClosed: p }
      }
    }
    print(`（终端窗口不足以内显二维码（需约 ${needCols}×${needRows}，当前 ${cols}×${rows}）——最大化窗口后重试 /pair，或用下方 PNG/JSON 兜底）`)
  } else if (plan.terminalOk) {
    // 经典 CLI 小载荷：qrBlock 半块渲染 + SGR 黑码白底（规划 R2.4 渲染器统一——
    // 与 TUI 同一矩阵渲染器；qrcode-terminal 已退役：反色+纵横比失真两病消亡）。
    // 终端码即显示：不再叠 PNG 弹窗（弹窗只留给装不下的场景）
    const blk = qrHalfBlockLines(qrObj.modules, plan.margin)
    process.stdout.write(qrAnsiBlock(blk.lines) + '\n')
    return {}
  } else {
    print(`（配对码载荷 ${text.length}B——终端二维码密度超可扫范围已跳过；请扫自动打开的 PNG 图片，扫不动用下方 QR JSON 粘贴兜底）`)
  }
  // 标准黑块白底 PNG + 系统查看器打开：宽度随模块数自适应，杜绝固定宽度翻车
  try {
    const width = Math.min(1600, Math.max(480, modules * plan.pxPerModule))
    const pngPath = `${tmpdir()}${sep}chill-pair-qr.png`
    await qrLib.toFile(pngPath, text, { width, margin: plan.margin, errorCorrectionLevel: plan.errorCorrectionLevel })
    spawn('cmd', ['/c', 'start', '', pngPath], { detached: true, stdio: 'ignore' }).unref()
    print(`二维码图片已打开（${modules}×${modules} 模块 → ${width}px，纠错 ${plan.errorCorrectionLevel}）：${pngPath}`)
  } catch {
    print('（PNG 二维码生成失败，仅终端二维码可用）')
  }
  return {}
}

export async function handlePair(input: string, deps: PairHandlerDeps): Promise<void> {
  const { rl, pairingManager: pm, relayClient } = deps
  const rest = input.slice('/pair'.length).trim()

  // ---- /pair config ----
  if (rest === 'config') {
    print('\n中继配置（存 secureStorage；未配置的子命令会提示先 config；esc 取消）')
    const relayUrl = await askLine(rl, '  relay 地址（ws:// 或 wss://host:port）: ')
    if (!relayUrl) {
      print('  （已取消）\n')
      return
    }
    if (!/^wss?:\/\//.test(relayUrl)) {
      print('  ❌ 地址须以 ws:// 或 wss:// 开头\n')
      return
    }
    const operatorKey = await askLine(rl, '  运营者密钥（服务器 operator.env 的 OPERATOR_KEY）: ')
    if (!operatorKey) {
      print('  （已取消）\n')
      return
    }
    let caPath = ''
    let caFP = ''
    if (relayUrl.startsWith('wss://')) {
      // CA 选填（2026-10-11 规划迭代 A）：留空=公共证书（Let's Encrypt 等）——caFP 为空，
      // 手机端（新 APK）走系统 CA 信任态；填了则钉住该 CA（QR 随码分发，迭代 C）。
      caPath = await askLine(rl, '  私有 CA 证书路径（.crt/.pem；留空=公共证书）: ')
      if (caPath) {
        try {
          // caFP = CA 证书文件字节的 SHA-256（与手机端读取同一文件计算的口径一致）
          caFP = caFingerprint(new Uint8Array(readFileSync(caPath)))
        } catch (err) {
          print(`  ❌ CA 证书读取失败: ${String(err)}\n`)
          return
        }
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
    // 指纹寻址缓存上传（配对小码规划 R2）：配置了私有 CA → 材料随铸造上传中继（GET /pair/ca/:fp
    // 寻址取材），QR 只承载锚=小码。信任锚不静默降级：文件读不到/锚漂移 → 硬错误（重新 /pair config）
    let caMaterial: { caB64: string } | undefined
    const caPath = await pm.getCaPath()
    if (caPath) {
      let bytes: Buffer
      try {
        bytes = readFileSync(caPath)
      } catch (err) {
        print(`\n❌ CA 证书文件读取失败（${String(err)}）——配置的信任锚已丢失，拒绝出无锚之码；请重新 /pair config\n`)
        return
      }
      if (config.caFP && caFingerprint(new Uint8Array(bytes)) !== config.caFP) {
        print('\n❌ CA 文件内容与配置时不一致（信任锚漂移）——请重新 /pair config 后再出码\n')
        return
      }
      caMaterial = { caB64: bytes.toString('base64') }
    }
    let qr: Awaited<ReturnType<typeof pm.startPairing>>['qr']
    let expires: number
    try {
      ;({ qr, expires } = await pm.startPairing(http, config, hostname() || 'chill 桌面', caMaterial))
    } catch (err) {
      print(`\n❌ 出码失败: ${String(err)}\n`)
      return
    }
    // 配对令牌即刻落 secureStorage：跨端配对时当前在线端的 bridge 懒读它验 pairingMAC
    await pm.savePairingToken(qr.token)

    print('\n用手机 chill App 扫码配对（QR 会留在终端 scrollback，配对完成后请清屏）:')
    const { viewClosed } = await renderQr(JSON.stringify(qr))
    print(`QR JSON: ${JSON.stringify(qr)}`)

    // TUI 路径（含窗口不足的 PNG 兜底）：命令出码即返回（命令通道零占用——/pair 任何时候
    // 再入都即刻出新码，不再吃"命令执行中"门）；等待与落定转后台尾巴，输出走 bgPrint（TUI 消息区）。
    // 单活跃配对：新出码先取代上一轮后台等待（旧令牌作废、旧轮询停、旧视图归新流程）。
    if (isTuiActive()) {
      supersedeActivePairWait?.()
      let giveUp!: () => void
      const superseded = new Promise<void>((r) => (giveUp = r))
      let supersededByNewer = false
      const hook = (): void => {
        supersededByNewer = true
        giveUp()
      }
      supersedeActivePairWait = hook
      const cancelled = viewClosed ? Promise.race([viewClosed, superseded]) : superseded
      print(viewClosed ? '等待手机 redeem（Esc 关码取消；随时重新 /pair 出新码）…' : '等待手机 redeem（随时重新 /pair 出新码）…')
      void (async () => {
        try {
          const result = await pm.waitForRedeem(http, qr.token, expires, cancelled)
          if (supersededByNewer) return // 被新出码取代：静默退场（closeQrView 归新流程，误关=事故）
          closeQrView() // 扫码成功/用户关码：自动收码——确认卡与流程消息回到眼前
          if (result.state === 'aborted') {
            bgPrint('\n（已取消本次出码——随时重新 /pair 出新码）\n')
            return
          }
          if (result.state === 'expired') {
            bgPrint('\n配对令牌已过期，请重新 /pair 出码\n')
            return
          }
          if (result.state === 'timeout') {
            bgPrint('\n配对超时，请重新 /pair 出码\n')
            return
          }
          bgPrint(`\n手机已登记：${result.device}（等待 pair.hello 密钥确认…）\n`)
          await pm.completePairing(result.phonePub, result.device, qr.token)
          if (relayClient.isRunning()) {
            const device: PairedDevice = { phonePub: result.phonePub, device: result.device, pairedAt: new Date().toISOString() }
            await relayClient.attachPeer(device, qr.token, false)
            bgPrint('本端 relay 在线：请在下方确认配对（显示手机设备名 + 装饰性指纹）\n')
          } else {
            bgPrint('配对确认将出现在当前在线的 chill 端\n')
          }
        } catch (err) {
          if (!supersededByNewer) bgPrint(`\n❌ 配对流程异常: ${String(err)}\n`)
        } finally {
          if (supersedeActivePairWait === hook) supersedeActivePairWait = null
        }
      })()
      return
    }

    // 经典 CLI（含其大载荷 PNG 兜底）：同步阻塞流维持原状（码留在 scrollback/独立窗口可
    // 继续扫；REPL 语义不拆——rl 提问与提示符不兼容后台化）
    print('等待手机 redeem（轮询 /pair/status）…')
    const result = await pm.waitForRedeem(http, qr.token, expires)
    closeQrView() // 扫码成功/超时/过期：自动收码——确认卡与流程消息回到眼前（真机实测教训：不收码则全屏码糊死界面）
    if (result.state === 'aborted') {
      print('\n（已取消本次出码——二维码视图已关闭；随时重新 /pair 出新码）\n')
      return
    }
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
