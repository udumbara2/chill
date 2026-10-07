# PROTOCOL-FROZEN — 协议冻结清单

**改本清单任何一项 = 协议 bump（信封 `v` 或新套件），双端必须同步升级。**
依据：设计文档 v1.1 §2/§3/§5。实现位置：`src/shared/envelope.ts`。

## 密码学套件

- 密钥协商：X25519 ECDH（`nacl.box.before`）
- 密钥派生：`HKDF-SHA256(ikm=shared_secret, salt="chill-relay-v1", info=用途标签, len=32)`
  - **salt 字面量冻结**：`chill-relay-v1`
  - info 标签冻结：`d2m` / `m2d` / `write` / `read` / `revoke`
- 加密：XSalsa20-Poly1305（`nacl.secretbox`，192-bit 随机 nonce）
- 哈希：SHA-256；密钥确认：HMAC-SHA256
- 库：tweetnacl + @noble/hashes@^1（pin 1.x，2.x ESM-only 禁用）+ tweetnacl-util

## 编码（冻结）

- 令牌 / 公钥 / 密文线上格式：**base64url**（无 padding）
- mailboxId：**hex** = `SHA-256(设备X25519公钥)` 前 32 字符
- 服务器凭据 = `SHA-256hex(token 的 utf8 字节)`，服务器永不落令牌明文

## 方向与 AAD（冻结）

- `mailboxId`：每台设备一个；手机→桌面投桌面信箱（`key_m2d` 加密），桌面→手机投手机信箱（`key_d2m`）
- AAD = `mailboxId‖direction‖v`（`direction ∈ {d2m, m2d}`，`|` 为分隔符字面量）
  - 实现：tweetnacl secretbox 无独立 AAD 形参，AAD 以**明文首行**（`aad\n` 前缀）嵌入认证明文，Poly1305 认证绑定等价；篡改必败
- 线格式：`base64url(nonce(24B)‖ciphertext)`

## 密钥确认（唯一信任锚，冻结）

`pairingMAC = base64url( HMAC-SHA256(key = token 的 utf8 字节, msg = deskPub 原始32B ‖ phonePub 原始32B) )`

- 在 `pair.hello` / `pair.confirm` 的 `body.mac` 中互验
- status 接口返回的 phonePub 只是传输通道，不是信任锚
- hello 解密失败 / MAC 校验失败：统一 fail-closed 报警，**禁止静默重试**

## 信封 v=1 字段表（冻结）

```json
{ "v": 1, "type": "...", "id": "<uuid v4>", "ts": 1735689600000,
  "from": "<设备id=mailboxId>", "to": "<设备id=mailboxId>",
  "replyTo": "<可选>", "body": {} }
```

- 已定义 type：`pair.hello` / `pair.confirm` / `chat.user` / `chat.event` / `approval.request` / `approval.response` / `approval.resolved` / `ask.request` / `ask.response` / `ask.resolved` / `chat.sync`
  - `pair.hello|confirm` body：`{ "device": "<设备名>", "mac": "<pairingMAC>" }`
  - `chat.user` body：`{ "text": "..." }`
  - `chat.sync` body：`{}`（M4e 订阅信号：手机每次连接建立且已配对后发送；桌面 ACK 后从真相源重推未决审批/提问。幂等无需去重，additive v=1 不变，旧端安全丢弃）
  - `chat.event` body：`{ "kind": "delta|final|tool|notice|reasoning", "text": "...", "beat?": <节拍序号,0起,生产时捕获>, "seq?": <轮内流式序号,0起单调增,kind=delta/reasoning 时携带>, "toolCallId?": "<kind=tool 时的块锚>", "detail?": { name, paramsSummary?, resultPreview?(≤1000字符), status: running|pending|success|failed|rejected }, "closed?": <kind=reasoning 的节拍关闭快照标志> }`（M4：启用预留的 `tool`＝轮次状态行；新增 `reasoning`＝思维链增量，additive 扩展 v=1 不变；两者带 replyTo=轮次锚点。M4b：beat/seq/detail/toolCallId 皆可选加法字段，旧端忽略。seq 缘由：信道 at-least-once 重投不保证顺序，接收端须按 seq 归位组装，不得依赖到达序。M4f：思考块无 final 全文兜底（正文块有），丢分片即成永久洞——节拍关闭时补发该节拍全文快照（closed:true），接收端长者胜整体覆盖收敛，洞/迟到/半截全部愈合）
  - M4 审批信封（二期 `approval.*` 命名空间字段已定）：
    - `approval.request` body：`{ "id": "<toolCallId>", "kind": "write|command", "summary": "...", "preview?": "...(≤1000字符)", "timeoutAt?": <epoch ms>, "sessionId?": "<发起会话归因，additive v=1——手机端按归因分流呈现；缺省=无归因全局请示>" }`
    - `approval.response` body：`{ "id": "<toolCallId>", "decision": "approve|reject" }`
    - `approval.resolved` body：`{ "id": "<toolCallId>", "approved": <bool>, "by": "phone|local|timeout|cancelled" }`
  - M4e 提问信封（`ask.*`，通用请示——与 approval.\* 骨架同构但语义分立：回答为选项 label 原文或自由文本，非 approve/reject 二元）：
    - `ask.request` body：`{ "id": "<提问id>", "question": "...(自带语境与规划预览)", "options?": [{ "label": "...", "description": "..." }], "allowFreeText?": <bool>, "hint?": "<自由文本提示文案>", "card?": "<改进提案点选裁决卡载荷，additive v=1（既有欠账补记）>", "sessionId?": "<发起会话归因，additive v=1——手机端按归因分流呈现；缺省=无归因全局请示>" }`
    - `ask.response` body：`{ "id": "<提问id>", "answer": "<选项 label 原文 | 自由文本 | '跳过'>" }`
    - `ask.resolved` body：`{ "id": "<提问id>", "answer": "<落定回答>", "by": "phone|local|cancelled" }`
    - 语义骨架同 approval.*：到达即标记、先到先落、迟到回答回 resolved(cancelled)"该提问已失效"、连接建立时重推未决提问；ask.response 同 approval.response 走快速路径（防"提问等待自己"死锁）。additive 扩展 v=1 不变，旧端忽略
- 二期命名空间（字段二期再定）：`humantask.*` / `feed.*` / `report`（`approval.*` 已于 M4 定稿，见上）
- **未识别 type：一律丢弃并忽略**
- `from`/`to` 解密后校验 == 预期对端，不等即丢弃并告警
- 去重：信封 id 有界 LRU（默认 4096），持久化注入点 = `DedupeSet.snapshot()` / 构造恢复
- ts 粗筛：偏离本地时钟 ±5 分钟丢弃；不做单调计数器；不做应用层 ping

## 大小边界（冻结）

- 信封**明文预算 45KB**（`PLAINTEXT_BUDGET_BYTES`），超限截断 + `body.truncated=true`
- **64KB = 线上字节**（base64url 后，`MAX_WIRE_BYTES`）；HTTP body 硬上限 128KB；WS maxPayload 96KB

## 配对令牌与 QR（冻结）

- 一次性配对令牌：≥128bit 随机，base64url，10 分钟过期
- QR JSON schema：
  ```json
  { "v": 1, "relay": "wss://<host>:<port>", "deskPub": "<base64url>",
    "caFP": "<base64url 私有CA证书SHA-256指纹>", "token": "<base64url>", "name": "<桌面设备名>" }
  ```

## redeem 状态机（冻结，单向单调 pending→redeemed|expired）

1. token 不存在 → 401（不计数、不区分）
2. 已消费 + 同 phone_pub → 200 幂等重放（**无条件优先，任何状态不拦截**）
3. 已消费 + 异 phone_pub → 409 `{"error":"token_conflict"}`（裸 body；记日志）
4. 未消费 + 已过期 → 410（手机必须停止重试）
5. 未消费 + 有效 → 事务消费（token 置 redeemed + 双信箱插入同一事务）

无烧毁机制；探测行为只记日志。

## 错误码表（冻结）

| code | error | 语义 |
|---|---|---|
| 400 | `bad_request` | JSON 畸形 / 字段缺失或不合法 |
| 401 | `unauthorized` | 无令牌 / 令牌错 / 信箱不存在（不区分，防枚举） |
| 403 | `forbidden` | 令牌合法但不属于该信箱该操作 |
| 404 | `not_found` | 未知路由 |
| 409 | `token_conflict` | redeem 撞令牌 |
| 410 | `gone` | redeem 令牌已过期 |
| 413 | `too_large` | body>128KB 或 blob>64KB 线上字节 |
| 429 | `rate_limited` / `quota_exceeded` | 频控 / 信箱 5MB 配额 |

## 服务器语义（冻结）

- ACK = `DELETE WHERE box=? AND id=?`（双条件；幂等 204）；消息只凭 ACK 删除，无乐观标记
- 补投/直推竞态：先注册连接 → 同步块查未 ACK 记入 in-flight → 直推查重
- 单活跃读者踢旧；两套 id 命名空间（服务器消息 id vs 信封 id）禁止混用
