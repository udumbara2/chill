---
name: mobile-iterate
description: 手机端自迭代。修改 chill-mobile 手机端源码（界面/样式/逻辑/修 bug/加屏幕）时必须使用；手机端版本回退、补验、配对续期（"回退手机端"/"补验手机端"/"重配手机端"）、远程推送（"推送到手机"）也必须使用本技能。系统提示未注入 chill-mobile 路径 = 源码未就位，如实告知用户获取方式，勿猜路径。
---

# 手机端自迭代 SKILL

指导模型修改、验证、固化、回退 chill-mobile 手机端代码，并远程推送到用户手机。机制：活树直接改（无 workcopy），用户说"可以"后调 mobile-freeze.js 固化快照 = 回退点，永不删除。脚本路径见系统提示「当前运行状态」的 chill 项目父目录下 `chill-guardian/`（mobile-freeze.js / mobile-push.js）。

## 规矩一：定位与授权

路径以系统提示注入的「chill-mobile 路径」行为准（未注入 = 源码未就位，如实告知用户，勿猜路径）。chill-mobile 在 chill 项目写边界之外——开工前引导用户执行 `/add-dir <chill-mobile路径>`（或确认 auto-apply 已开）。

**开工配对比对**：读 `<父目录>/chill-mobile-versions/m-current.json` 的 pair 与 `<父目录>/chill-versions/current.json` 的 current——不一致时先向用户报告"手机端配对 chill=<X>，当前运行 chill=<Y>"，涉及消息契约的改动必须先对齐（切换 chill 或回退手机端）再开工。

## 规矩二：层级判定（改码前）

判断本轮改动落在哪层，策略随之分流：

- **JS/TS 层**（`src/**`、`App.tsx`）：Fast Refresh 秒级内环（规矩五流程）
- **原生层**（`android/**`、`ios/**`、`package.json` 原生依赖增删）：**无热更新**——预览 = 重建重装（分钟级，需设备）；固化前门禁 = **构建成功**（`gradlew assembleDebug` 编译级验证无需设备；运行时验证必须设备，无设备挂 pendingVisual）；回退后需再重建重装
- **混合**：按原生层策略执行

**中文路径纪律**：本机 chill-mobile 路径含非 ASCII 时原生构建有三重死路（AGP 批处理编码、ninja 中文 chdir、gradle 路径规范化击穿 junction/subst——实测全灭）。出路 = **纯 ASCII 构建场**（`C:\dev\chill-mobile`，mobile-push.js 经配置 `buildDir` 自动单向镜像活树 → 构建场再构建；构建场禁改码，一切改动回活树；node_modules/build 缓存留在构建场保增量速度）。已固化在 `android/gradle.properties` 的 `-Dfile.encoding=GBK` 勿删（AGP 以 file.encoding 写批处理、cmd 按 GBK 解码）。

## 规矩三：开工检查

1. `mobile-freeze.js` 存在（缺失如实报告并停止——严禁无快照能力裸奔改码）
2. `adb devices` 有设备（改 UI 时）。设备三档，任一可达即可：
   - **USB 真机**：数据线连接
   - **无线 adb**：同局域网，Android 11+ 无线调试配对后 `adb connect <手机IP>`
   - **模拟器**（常在档）：`"$ANDROID_HOME/emulator/emulator" -avd Medium_Phone_API_36.1 -no-window -gpu swiftshader_indirect` 后台拉起 → `adb devices` 识别 `emulator-*`；**多设备并存时一切 adb 命令带 `-s <id>`、构建装应用用 `--deviceId <id>` 显式指定**
3. JS 层改动查 Metro 活着（`curl -s http://localhost:8081/status` = `packager-status:running`），无则**自行后台拉起**（chill-mobile 下 `npm start`，常驻免超时）——模拟器同理自行拉起，失败才如实报告，不等人
4. `adb --version` 可用（无则如实请用户装 platform-tools，严禁装样子）

②③④纯逻辑改动可跳过。设备在而不刷新：`adb -s <id> reverse tcp:8081 tcp:8081` + `adb -s <id> shell input keyevent 82` reload。

## 规矩四：改码前残留检测

调 `node mobile-freeze.js --status <chill-mobile路径>`——有未固化残留先报告用户：固化残留还是丢弃（回退到最新快照），不静默叠改；无差异则开工。

## 规矩五：改码后验证与固化

**有真机可达** → 用户确认效果（JS 层 = Fast Refresh 实时可见；原生层 = 重建重装后可见）→ 确认后调 `node mobile-freeze.js <路径> "<本轮目标一句话>"` 固化（本轮已验证，不带欠账标志）——每份快照就是一个回退点（原生层固化前必须构建成功）。

**无真机（模拟器常在档）** → 自行确保模拟器+Metro 在 → 装应用（ASCII 盘符下 `gradlew app:installDebug`，或 `npm run android`）→ **导航到目标屏**（`adb -s emulator-* shell input tap/swipe x y`，先截屏确认落位；App 主界面不锁配对、五屏全可达）→ 截图自查 `adb -s emulator-* exec-out screencap -p > <父目录>/tmp/mobile-iter-<n>.png`（模型读图自评）→ 需要用户远程验收时调 `node mobile-push.js shot <png路径>` 上传，把返回的 URL 以 markdown 链接放进回复（手机端聊天可点、浏览器看图）→ 用户看图确认 → 固化。

**模拟器保真边界（如实告知）**：导航全可达但数据是空态（无配对/会话记录）；摄像头/扫码不覆盖——真实数据态与硬件相关改动，模拟器验证 + 真机交付终验（规矩十）。

**模拟器与 Metro 均拉不起** → JS 逻辑改动照常固化收尾；原生改动先编译级验证通过后固化并告知欠账；纯视觉改动照常固化并告知欠账——此类未验证固化一律带 `--pending-visual`（机械挂账，`--list` 可见），并明确告知"运行时效果未验证，设备可达后补验"，**严禁宣称视觉/运行时已验证**。

## 规矩六：回退与补验

- **回退**（用户说"回退手机端"）：调 `--list` 展示快照清单（时间/goal/pair）让用户选 → `--rollback <路径> [选中的快照名]`（自动先留底当前态，可来回跳；缺省回 previous）→ JS 层 Metro 重载即生效；脚本提示依赖清单变化时需 `npm install`，原生层需重建重装
- **补验**（用户说"补验手机端"）：设备档含模拟器——确认连接（必要时 adb reverse + reload / 模拟器起屏导航）→ 截图或远程看图对照该轮目标 → 通过则告知欠账已清（下次固化自然清除），不通过则进内环继续改（改完重新固化）

## 规矩七：红线

`src/relay/envelope.ts` 是从 chill core 同步生成的（禁手改）；协议/密码学常量改动必须从 core 出发三端同步（core → relay → 手机 sync-envelope），本技能一律拒绝并说明原因。

## 规矩八：跨端配对（触碰消息契约时）

改动涉及 `src/relay/session.ts`、`src/db/syncReducer.ts` 或新增消息类型 → 固化前在**当前 junction 指向的 chill 版本**上跑 e2e 全链路，全绿才收尾（**双进程**：先起 desk 侧 `node --experimental-transform-types --import ./scripts/e2e-harness/registerHook.mjs scripts/e2e-harness/e2e-sync-desktop.mts <临时目录>`，等 `qr.json` 出现后另起手机侧 `… e2e-node.mts sync <qr.json路径> <同一临时目录>`，两侧退出码均 0 才算绿）：

**联合迭代顺序铁律**：一次迭代同时改 core 与手机端时，必须先完成 core 侧（self-iterate → /switch-version），再动手机端——保证 e2e 永远跑在新 core 上。**消息类型只增不改不删**（旧端收未知类型按协议丢弃，错配=降级非崩溃；要改既有类型语义 = 必须再来一次先 core 后手机的联合迭代）。

**配对续期**（core 独立更新触碰契约并切换版本后，用户说"重配手机端"）：用现有手机代码对新 core 跑上述 e2e → 绿则 `node mobile-freeze.js --repair <路径>` 更新 pair；红则该 core 改动破坏兼容，回到联合迭代。core 改动不碰契约 → 手机端零动作（pair 滞后无害，比对仅对契约类改动拦截）。

## 规矩九：配对错配提醒

任一端回退后，比对 m-current.json 的 pair 与 chill-versions/current.json 的 current——不一致且涉及契约 → 提醒"两端版本错配，建议同步回退/升级另一端"。

## 规矩十：远程推送（"推送到手机"）

用户想把改动装到真机上时（远程交付）：

1. 确认已固化（`mobile-freeze.js --status` 零差异——**推送必先固化**，mobile-push.js 会机械拒绝未固化推送）
2. `node mobile-push.js apk <chill-mobile路径>`：自动经 ASCII 盘符跑 `gradlew assembleRelease`（**嵌 JS 的交付变体**；debug 变体不嵌 JS、离了 Metro 就是空壳，不可作交付物）→ 上传中继 → 打印下载 URL
3. 把 URL 以 markdown 链接发给用户 → **手机点链接即走 App 内更新器**（自动下载→包名预检→自动弹系统安装页；同 debug.keystore 签名覆盖安装、数据保留；首次需给本 App"安装未知应用"授权一次——浏览器/装 CA 一概不再需要）。**降级闸**：链接快照号早于当前构建戳时 App 停在"回退安装"知情确认（数据库迁移可能不可逆）——安全回退=源码层 `--rollback` 重建重推，兜底=清数据重装
4. 原生层改动远程交付同路（assembleRelease 已含 native）
5. **改 `src/db/syncDb.ts` schema 必须走既有 PRAGMA user_version 迁移纪律且向下兼容（旧库可升入）**——覆盖安装带用户真实数据升级，坏迁移=数据事故；固化前 `npm test` 必绿
6. 推送的产物以快照 id 命名（`app-<快照名>.apk`）永存服务器——远程回退 = 重推旧 APK 链接（App 侧降级闸会要求知情确认）

## 重要规则

- 所有路径操作用绝对路径（chill-mobile / chill 项目父目录 / mobile-freeze.js / mobile-push.js 均见系统提示或由其推导）
- pair 语义：记录"这版手机对着哪版 chill 验证过"（兼容性实证），不是两边版本号同步走——纯手机端迭代时 core 零动作，pair 由脚本自动沿用
- 严禁在快照仓（chill-mobile-versions/）内手工增删文件——快照不可变，一切经 mobile-freeze.js
- mobile-push.js 的配置在 `~/.chill/mobile-push.json`（relayBase/bearer=PUBLISH_TOKEN/caPath），缺失时脚本会给一次性创建指引，如实转告用户，勿自造凭据
