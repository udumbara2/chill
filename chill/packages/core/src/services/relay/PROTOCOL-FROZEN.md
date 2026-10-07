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

- 已定义 type：`pair.hello` / `pair.confirm` / `chat.user` / `chat.event` / `approval.request` / `approval.response` / `approval.resolved` / `ask.request` / `ask.response` / `ask.resolved` / `chat.sync` / `mode.set` / `mode.state` / `catalog.sync` / `catalog.state` / `history.request` / `history.page` / `session.attach` / `session.event` / `presence.ping` / `presence.pong` / `board.sync` / `board.state` / `workplan.sync` / `workplan.state` / `feed.subagent` / `cmd.sync` / `cmd.request` / `cmd.result` / `cmd.state` / `file.offer` / `file.chunk` / `file.abort` / `file.receipt`
  - `pair.hello|confirm` body：`{ "device": "<设备名>", "mac": "<pairingMAC>" }`
  - `chat.user` body：`{ "text": "...", "sessionId?": "<M6 发言目标会话——发言即附着+激活：桌面先切到该会话（引擎守卫：忙/有后台任务回 notice'桌面正忙，无法切换会话'）再注入；缺省=当前会话，旧端兼容。M6b 特殊值 'new'：守卫检查 → 引擎当前会话为空则复用、否则 startNewSession → 轮前切附着到新会话 → 注入（轮前附着是硬要求，否则出向门控挡掉第一轮流式；'轮末收编'仅适用无 sessionId 兼容路径）；守卫失败回 notice'桌面正忙，无法新建会话'不注入。additive，v=1 不变>", "attachments?": [{ "fileId", "name", "mime" }] }`（file.* 协议族 additive：≤5 个，引用已完成传输（file.receipt ok）；缺失/未装配/畸形 → 守卫拒绝 notice+ACK 不注入，**严禁"不 ACK+撤销去重"旧语义**）
  - file.* 文件传输信封（方向无关：发件方→收件方；端到端加密走既有信箱通道；**传输类型无关**——name/mime 只是元数据，消费语义全在接收端既有管线；additive v=1 不变，旧端安全丢弃）：
    - `file.offer`（发件方→收件方）body：`{ "fileId": "<uuid，传输关联键>", "name", "mime", "size": <m→d ≤5MB / d→m ≤100MB(v2)>, "sha256": "<整文件 sha256 hex>", "chunks": <m→d 信箱分块总数,seq 从 0 起,每块 ≤32KB 二进制(base64url)；static 路径恒 0>, "static?": { "name", "key", "fmt?": 2, "wireSize?", "nonce?" }, "expiresAt?": <epoch ms>, "sessionId?": "<发出方会话id>" }`（m→d=手机附件上传：预检单文件帽/并发未完成总量帽 20MB/参数合法性，拒绝即回 receipt{ok:false}，已完成 fileId 的重复 offer 幂等重发 receipt 不重复落盘；d→m=桌面发文件到手机：一律 v2 分片语义（密文在中继静态通道，offer 只携指针+密钥），expiresAt=PUT 完成时刻+48h（与中继成品 TTL 对齐，过期收件端本地可判），sessionId 供卡片按会话归属；expiresAt/sessionId 为 additive 可选字段，v=1 不变，旧端安全忽略）
    - `file.chunk`（m→d）body：`{ "fileId", "seq": <0起>, "data": "<base64url>" }`（按 (fileId,seq) 幂等，at-least-once 容忍重复/乱序；齐块重组+sha256 整体校验→恰好一次落盘→receipt；走快速路径不进串行链）
    - `file.abort`（m→d）body：`{ "fileId", "reason?" }`（丢弃未完成缓冲；已完成的不动）
    - `file.receipt`（收件方→发件方）body：`{ "fileId", "ok": <bool>, "error?" }`（传输终局的诚实回执——送达的唯一真相源。m→d：重组完成且已落盘 / 拒绝，error 自由文本，手机 receipt 门控=全部 ok 才发 chat.user；d→m：手机拉取+解密+落盘完成 / 失败，error 枚举=`expired`（要约过期）|`corrupt`（解密或 sha256 对账失败）|`io`（拉取网络失败 / 落盘失败含存储不足）|`aborted`（用户取消拉取））
  - `chat.sync` body：`{}`（M4e 订阅信号：手机每次连接建立且已配对后发送；桌面 ACK 后从真相源重推未决审批/提问，并重放近期落定终态（请求载荷随回放，接收端同 id 幂等收敛——丢失的 approval.resolved/ask.resolved 经此愈合）。幂等无需去重，additive v=1 不变，旧端安全丢弃）
  - `chat.event` body：`{ "kind": "delta|final|tool|notice|reasoning", "text": "...", "sessionId?": "<M6 会话归属戳：附着会话的镜像轮（本地轮）无 replyTo 锚，手机据此归位；缺省=手机发起轮，旧端忽略>", "beat?": <节拍序号,0起,生产时捕获>, "seq?": <轮内流式序号,0起单调增,kind=delta/reasoning 时携带>, "toolCallId?": "<kind=tool 时的块锚>", "detail?": { name, paramsSummary?, resultPreview?(≤1000字符), status: running|pending|success|failed|rejected }, "closed?": <kind=reasoning 的节拍关闭快照标志> }`（M4：启用预留的 `tool`＝轮次状态行；新增 `reasoning`＝思维链增量，additive 扩展 v=1 不变；M4b：beat/seq/detail/toolCallId 皆可选加法字段，旧端忽略。seq 缘由：信道 at-least-once 重投不保证顺序，接收端须按 seq 归位组装，不得依赖到达序。M4f：思考块无 final 全文兜底（正文块有），丢分片即成永久洞——节拍关闭时补发该节拍全文快照（closed:true），接收端长者胜整体覆盖收敛，洞/迟到/半截全部愈合）
  - M4 审批信封（二期 `approval.*` 命名空间字段已定）：
    - `approval.request` body：`{ "id": "<toolCallId>", "kind": "write|command", "summary": "...", "preview?": "...(≤1000字符)", "timeoutAt?": <epoch ms>, "sessionGrantable?": <bool> }`（`sessionGrantable?` 为 additive 可选：桌面操作（computer_use 主动作）审批携带 true，手机据此渲染「本次会话放行」第三钮——语义对齐 CLI `[s]`/桌面 UI 会话放行钮；缺省/旧端=普通命令审批两钮）
    - `approval.response` body：`{ "id": "<toolCallId>", "decision": "approve|reject", "allowSession?": <bool> }`（`allowSession?` 为 additive 可选：手机「本次会话放行」回答时 decision 仍为 `approve` 并附带 `allowSession: true`——**严禁发明 decision:'session' 新值**（旧桌面对未知 decision 判 reject，违反旧端安全）；桌面仅在 approve 时读取该字段，落定 ApprovalResolution.allowSession → executor 会话级放行（/desktop off 收回）。旧桌面忽略该字段=普通批准，安全降级）
    - `approval.resolved` body：`{ "id": "<toolCallId>", "approved": <bool>, "by": "phone|local|timeout|cancelled" }`
  - M4e 提问信封（`ask.*`，通用请示——与 approval.\* 骨架同构但语义分立：回答为选项 label 原文或自由文本，非 approve/reject 二元）：
    - `ask.request` body：`{ "id": "<提问id>", "question": "...(自带语境与规划预览)", "options?": [{ "label": "...", "description": "..." }], "allowFreeText?": <bool>, "hint?": "<自由文本提示文案>", "card?": <AskTriageCard> }`（`card?` 为 additive 可选：改进提案点选裁决卡载荷 `{ "digest", "clusters": [{ "id", "name", "count", "recent", "difficulty?", "latest", "entries?" }], "batch?", "inplace?" }`——batch={ offset, total, pageIndex?, pageCount? }（pageIndex/pageCount=布局前置的页索引/总页数["第 x/y 批"恒定分母]，旧端只认 offset/total 安全忽略）；未分组簇 id=固定哨兵 `__ungrouped__`；entries 元素带 additive `decided?`: confirm|close|skip=本庭已落账标注（原地翻页回翻已决页只读渲染）；`inplace?`: true=能力声明"本卡支持单卡原地翻页"（经 improve.page cmd 通道翻页，旧手机忽略走文本「下一批」路径）；预算防护全在构造侧[card 序列化字节+question 实际字节合计 ≤45KB，超则不带 card]，手机侧缺字段/形状校验失败落回纯文本提问卡）
    - `ask.response` body：`{ "id": "<提问id>", "answer": "<选项 label 原文 | 自由文本 | '跳过'>", "decisions?": [{ "action": "confirm|close|skip", "clusterId?": "...", "title?" : "..." }] }`（`decisions?` 为 additive 可选：点选卡结构化决策回传，与 answer 文本双通道并行——动作词表=账本词汇 confirm/close/skip；簇级=clusterId[整簇展开由桌面按开庭快照做]、单条=title[精确匹配]，两者至少其一，畸形整体丢弃走文本回退；旧端安全忽略走 answer 文本解析）
    - `ask.resolved` body：`{ "id": "<提问id>", "answer": "<落定回答>", "by": "phone|local|cancelled" }`
    - 语义骨架同 approval.*：到达即标记、先到先落、迟到回答回 resolved(cancelled)"该提问已失效"、连接建立时重推未决提问并重放近期落定终态；ask.response 同 approval.response 走快速路径（防"提问等待自己"死锁）。additive 扩展 v=1 不变，旧端忽略
  - M5 权限模式信封（单真相源同步：真相=桌面 core permissionMode，手机为视图+请求方）：
    - `mode.set` body：`{ "mode": "readonly|boundary|fullAccess" }`（手机请求变更；走快速路径；非法值 fail-closed 不写真相源并回推当前 mode.state）
    - `mode.state` body：`{ "mode": "..." }`（桌面广播当前档：变更时 + 连接/配对/chat.sync resync 补推；手机徽标的唯一落定触发——本地点击绝不假装落定）
    - additive 扩展 v=1 不变，旧端安全丢弃
  - M6 会话同步信封（双端会话同步：唯一真相源=桌面 `~/.chill/sessions/*.json` + `projects.json`，手机本地只存只读副本；additive v=1 不变，旧端安全丢弃）：
    - `catalog.sync`（m→d）body：`{ "projectsRev?": "<项目集合修订号>", "sessions?": { "<sessionId>": "<updatedAt>" } }`（手机连上/重连时上报已知版本触发对账；为空/异常 → 桌面回全量。会话数极多时 sessions map 同样受 45KB 明文预算约束，可分 chunk 或退化为请求全量）
    - `catalog.state`（d→m）body：`{ "projects": [...], "sessions": [...], "deletes?": ["<sessionId>"], "activeSessionId": "<id|null>", "projectsRev": "<修订号>", "full": <bool>, "chunk?": <n,0起>, "chunks?": <总数>, "runningSessionIds?": ["<sessionId>"] }`（full=true 全量，其后仅增量：sessions=upserts、deletes=消失会话 id 清单；projects 仅在 projectsRev 变化时携带全量整表，手机整表替换；超 45KB 明文预算分 chunk，同 replyTo 归组。M6b 注记：**activeSessionId 仅供信息，手机不跟随**——手机的"正在聊"锚是自己的 lastChatSessionId，桌面切会话不再驱动手机 UI。**runningSessionIds（2026-10-04 立，运行态标志）**：运行中会话全集快照，易变态语义与 activeSessionId 同类——手机收到即整替本地运行集合（列表"运行中"转圈的数据源）；缺省=宿主未装配，手机不动现状；分片时随 chunk 0 搭车）
    - 目录会话条目：`{ "id", "title", "titleSource?": "default|auto|manual", "projectId": "<id|null>", "workdir?", "createdAt", "updatedAt", "preview" }`（preview=首条 user 消息纯文本前 100 字）
    - **projectId 归一化规则（双端同一规则、两个执行点）**：会话 projectId 指向不存在/已删除项目时按未分组呈现——桌面 buildCatalog 输出即归一化为 null；手机对 projectId 不在已知项目集合的会话同样按未分组渲染。缘由：桌面删项目先逐个清会话 projectId 再删项目（清归属不动 updatedAt，updatedAt diff 看不见该变化），收敛 = projectsRev 变化触发项目整表重发 + 双端各自归一化
    - `history.request`（m→d）body：`{ "sessionId": "...", "before?": "<msgKey=手机已持有的最早一条>", "limit?": <≤20> }`（历史永不主动推，仅在手机打开会话/上翻时按需拉）
    - `history.page`（d→m）body：`{ "sessionId", "messages": [...], "nextBefore?": "<本页最早一条的 msgKey>", "done": <bool>, "notFound?": <bool> }`（页大小=min(20 条, ~32KB)；页内按时间升序；before 锚点找不到[被压缩/再生抹掉]回退最新一页，手机按 msgKey 幂等归并；单条超预算截断 + `truncated: true` 标注"请在桌面查看"）
    - 传输消息条目：`{ "msgKey", "role", "kind": "text|tool|notice|media", "ts", "text", "reasoningContent?", "thinkingDurationMs?", "toolName?", "toolStatus?", "truncated?", "refs?", "clientId?" }`（msgKey=core `SessionPersistence.messageKey`，手机幂等主键一部分；kind 映射：text=正文[含 reasoningContent/thinkingDurationMs]；tool=工具行精简载荷[工具名+状态+≤1000 字符结果预览]；notice=synthetic 合成消息提示行；media=图/视频/音频占位"请在桌面查看"。`refs?`=[{ "ref", "name", "mime" }] 为 file.* 协议族 additive 回填：媒体检测三通道或（contentBlocks 媒体块 ∥ attachmentRefs ∥ content 为 ContentPart[] 含媒体块——第三通道为既有隐性缺陷修正：桌面 @提及 媒体此前在手机上连占位都不显示）；手机据 refs 查本地登记表渲染缩略图/芯片，未命中或无 refs → 照旧占位行。`clientId?` 为 additive：仅 relay 来源用户消息携带，= 其 chat.user 信封 id——手机 overlay 气泡与 DB 行同 id 的回声确认匹配键；旧端忽略。**零载荷 assistant 行（空正文/无思考——纯工具调用轮占位）不上线**：pageHistory 拣选时跳过，不占条数/字节预算）
    - `session.attach`（m→d）body：`{ "sessionId": "<id|null>" }`（附着/脱离订阅，只决定推流不动桌面状态；请求-确认制，确认=`session.event` attached.changed，未收到确认前不假落定。**serve 单操作者宿主例外（2026-10-04 立，控制盲区根治）**：无头 serve 宿主内 attach 会切换宿主的"活跃会话"（打开哪个会话=控制哪个会话——turn.stop 等命令作用于它；仅当该会话已在宿主注册表才切，attach(null) 不动）——serve 宿主只有手机一个操作者，「正在看哪个会话」就是操作焦点的真实表达；多操作者宿主（UI 有桌面人）不受影响，本例外不改变协议线形，只记载宿主侧行为）
    - `session.event`（d→m）body：`{ "kind": "metadata.upsert|title.changed|session.created|session.deleted|active.changed|attached.changed|history.invalidated|round.settled|running.changed", "sessionId?": "<id|null>", "session?": <目录会话条目>, "title?": "...", "titleSource?": "...", "running?": <bool>, "runningAll?": ["<sessionId>"] }`（目录/元数据增量 + 附着确认 + 历史失效信号 + 轮次落定。**一律不携带正文**——正文只有两个通道：`history.page` 按需拉 / `chat.event` 附着会话实时流；history.invalidated 到达 → 手机清空该会话本地 messages 并重新拉取。发射源经代码核实：仅 regenerate 截断重建（replace 整盘覆写）是真·非追加变更；自动压缩只追加 compactions checkpoint、备份恢复只追加 synthetic 留痕，messages 均不动，不触发本信号。**round.settled（M6c）**：引擎 `TURN_SETTLED`（runTurn finally，成功/中断/异常全覆盖）→ 桥仅对附着会话推；手机的尾部拉齐**只在此刻发生**——轮中"最新页"是移动目标，拉回正在流式的内容会造成 DB 副本与 overlay 双份渲染（用户实测击穿，metadata.upsert 触发拉齐的旧契约由此作废）；本地镜像轮无 final，此信号同时是其 overlay 锚点闭合的唯一通路。**running.changed（2026-10-04 立，多会话运行态观察）**：引擎 `TURN_STARTED`/`TURN_SETTLED`（与 running 状态翻转构造性配对）→ 桥**对所有会话推**（本 kind 是镜像门控的唯一例外——后台会话的运行态正是本信号的意义所在，与 round.settled 的附着语义互不干扰）；`running`=单会话增量，`runningAll` 在场=手机整替全集（sessionId 省略+仅 runningAll=纯快照形态，宿主 5min 周期重申用——根治连接中最后一帧丢失且此后无转换的无限期残留）；手机侧消费只准碰 volatile 运行集合，禁触 liveRoundSessionId/overlay 记账（防串台同族污染）；catalog.state.runningSessionIds 是重连对账载体，与本 kind 三重收敛：后续转换/周期重申/重连对账）
  - M6c 在线探活信封（"桌面在线"是真话：绿点=手机与中继已连且**近期收到过桌面来信**；additive v=1 不变）：
    - `presence.ping`（m→d）body：`{ "caps?": ["<能力常量>", ...] }`（手机前台周期发出[~30s]，桌面立即回 pong，走快速路径不碰引擎；`caps` 为 additive 可选能力清单——已定义常量 `file-recv`=手机端支持接收桌面发来的文件（d→m 文件发送的桌面侧前置能力门，能力未知时诚实报错而非盲发）；缺省/旧端 = 空能力集，v=1 不变，旧端安全忽略）
    - `presence.pong`（d→m）body：`{}`（桌面应答；**手机侧"最近 45s 内收到任何桌面来信"= 在线**——pong 是空闲期的保活证据，任何真实流量同样计）
    - 机制注记：不采用"桌面周期心跳"——手机离线时心跳会堆满信箱（7 天 ≈ 40 万条，撑爆配额）；反向按需探活的堆积被"手机前台时长"严格限住，失败自动退避（30s→2min）。presence 只是又一种密文信封，中继零改动
  - M7 共享看板同步信封（会话级看板快照同步：真相源=桌面 `~/.chill/boards/<sessionId>.json` + 进程内存，手机为只读视图；additive v=1 不变，旧端安全丢弃）：
    - `board.sync`（m→d）body：`{ "sessionId": "<会话id>", "rev?": "<手机已知 revision 字符串/数字>" }`（拉某会话看板；带 rev 触发对账，空/异常 → 全量。走快速路径不碰引擎——看板是内存+快照读，排在被审批楔死的链后会让看板应答被无关轮次阻塞）
    - `board.state`（d→m）body：`{ "sessionId", "rev", "rows": [<投影行>], "strip": { "status": "running|settled", "countText", "settleText?": "...", "needsYou": <bool> }, "needsYou": { "needed": <bool>, "count": <n> }, "windowed": <bool>, "full": <bool>, "chunk?": <n,0起>, "chunks?": <总数> }`
    - 投影行线形（= desktop `boardProjection.rows` 的传输子集；detail 只带分态关键字段）：`{ "itemId", "title", "assignee": "<工位徽章文本|null>", "status": "pending|in_progress|blocked|completed|cancelled|failed", "label": "<行态徽章文案>", "progressText": "<进展行|null>", "claimedAt?": <epoch ms>, "clipped?": <bool>, "detail": { "blockedReason?": "<blocked 时=受阻原因>", "result?": "<全文,超 4KB 已截断并明示>", "resultTruncated?": <bool>, "releaseHistory?": [{ "by", "reason", "suggestedTo?", "at" }], "failCount?": <n> } }`
    - **快照同步、无增量事件通道**：看板变更频率低（任务 spawn/settle/人工操作），一行之差即整板语义之差；增量协议要维护行级 diff 与乱序愈合，收益不抵复杂度——每次 board.state 即完整投影，手机整表替换 latest-wins（rev 单调比较），乱序/重投自然收敛
    - **投影随 state 下发=core 算好壳零判定**：行序/徽章 label/进展行/限窗/strip/needsYou 全部由 desktop `buildBoardProjection` 单点算出，手机只渲染不判定（双端不各写一套状态机到显示的映射）
    - **要你行永不裁剪**：待认领∪需拍板∪待裁决行全量下发；终态行超窗标 `clipped:true` 保留最近 N 条（壳决定折叠展示），进行中行同样全量
    - rev 语义：桌面每次 mutation 自增的全局 CAS 计数（字符串传输）；手机上报已知 rev 触发对账——落后/未知回 `full:true` 全量行集，已一致回 `full:false` 纯确认（rows 空，strip/needsYou 标量照带供徽标收敛）；变更即推与 resync 补推一律 `full:true`
    - 投影行 detail 增 `claimedByTaskId`（只增）：认领任务绑定键 = feed.subagent.taskId，行↔feed 事实流的归属键
  - 工作计划树同步信封（`workplan.*`：主会话任务清单镜像的快照同步——真相源=桌面 wiring 层按 sessionId 分键的清单镜像（TASK_* 事件黑名单制过滤：拒 'subagent' worker 写入，undefined/'main'/'mobile'[手机发起轮次的主引擎调用]照收），手机为只读视图；additive v=1 不变，旧端安全丢弃）：
    - `workplan.sync`（m→d）body：`{ "sessionId": "<会话id>", "rev?": "<手机已知 revision 字符串|null>" }`（拉某会话工作计划树；带 rev 触发对账，空/异常 → 全量。走快速路径不碰引擎——镜像是内存读，排在被审批楔死的链后会让应答被无关轮次阻塞）
    - `workplan.state`（d→m）body：`{ "sessionId", "rev", "full": <bool>, "items": [<树项>], "chunk?": <n,0起>, "chunks?": <总数> }`
    - 树项线形（顶层项列表即树，children 嵌套）：`{ "id", "content", "status": "pending|in_progress|completed|failed|cancelled", "result?": "<完成/失败结果摘要>", "actor?": "<执行者名,缺省=主 Agent;看板行=认领成员名,未认领='待认领';徽章五色映射不上协议>", "needsYou?": <等你拍板,行级标记=**窄判定:仅 blocked 档**（待认领=灰调等待认领、失败=红字警示，二者自成一相不占中断位；桌面看板宽口径 boardRowNeedsYou 不用于此）,树级语义手机端递归扫>, "note?": "<父项'自动结项'派生标注/看板行受阻原因>", "children?": [<树项>] }`（'cancelled'=看板行已取消[灰点]，additive 增列，旧端按未知态安全降级；看板行六态映射：pending→pending、in_progress→in_progress、completed→completed、blocked/failed→failed[needsYou 区分相位]、cancelled→cancelled）
    - 树合并规则（迭代 2 起，投影 SSOT=core buildWorkPlanTree，手机零判定渲染）：①有链嵌套——看板行 parentTaskId 命中清单项 id → 嵌为该项 children；②无链根层——parentTaskId 缺失 → 顶层追加（清单项之后）；③断链孤儿提升——parentTaskId 指向不存在的清单项 → 提升为顶层（不丢行不猜新父）；④父项自动结项派生——有 children 且全部 completed → 父项输出 completed+note'自动结项'（纯投影派生不改清单真相），有 children 且至少一个在办 → in_progress，否则保持清单原状态；⑤行序稳定（清单序→无链行序）供手机端 DFS 取焦点叶子；⑥无链批次保留界 1（长条落定常驻迭代；与源码 workPlanTree.ts 头注释规则⑦同一条规则）——无链（含断链提升③）看板根行按 batchId 分批（无 batchId 行自成单行批=单独派活一单一批的自然退化）：批内存在任一 pending/in_progress/blocked/failed 行 → 整批投影（终态行为批内进度展示，失败回流拖住整批——同轮并行子任务完成一个不消失，整轮完成才一起让位）；批内全部 completed/cancelled=批结清 → 已结清批保留最近一代（settledAt=批内最晚 updatedAt 最大者，平局按组键稳定序）投影，更早的已结清代让位不投影（结构事件触发：新代结清即旧代让位；跨轮不累积、树规模恒有界）。有链行全态投影；已结清批不再因时间流逝退场（旧"定格窗口期满退场"机制已随手机端 settled 6s 收摊的删除一并退役；信封格式不变，仅投影行为规则迭代）
    - **快照同步、无增量事件通道**：每次 workplan.state 即完整树（full=true），手机整树替换 latest-wins（rev 单调比较），乱序/重投自然收敛；投影 SSOT 在 core（buildWorkPlanTree 纯函数），手机零判定渲染
    - rev 语义：桌面每次投影源变更（清单镜像或看板行，单计数器覆盖双源）按会话自增的计数（字符串传输；镜像+rev 持久化于 workplan-mirror.json，core 重启后恢复连续、rev 时间基单调不回退）；手机上报已知 rev 触发对账——落后/未知回 `full:true` 全量树，已一致回 `full:false` 纯确认（items 空）；变更即推（300ms 防抖合并+附着门控，只推手机附着会话；TASK_* 与 BOARD_CHANGED/TEAM_BOARD_CHANGED 同一防抖推送路径）与 resync 补推一律 `full:true`
    - 镜像启动时机边界：relay 在清单建好后才启动 → 镜像空 → sync 回诚实空态（不显示，绝不错误显示）；精确自愈条件=下一次 create_task_list（update/add/delete 对空镜像不建条目）
  - M7 subagent 事实流信封（`feed.subagent`（d→m），启用预留 `feed.*`：Worker 工具调用事实；additive v=1 不变，旧端安全丢弃）：
    - `feed.subagent`（d→m）body：`{ "taskId?": "<父任务 toolCall.id=看板行 claimedByTaskId>", "subagentType?": "...", "toolCallId": "<Worker 侧工具调用 id，归并主键>", "toolName": "...", "kind": "builtin|mcp|…", "argsSummary": "<≤4KB 发射点截断>", "status": "running|success|failed", "resultSummary?": "<≤4KB 发射点截断>", "durationMs?": <n>, "at": <epoch ms> }`
    - **按 toolCallId 归并的 status 流**（running→success|failed）：手机侧 latest-wins overlay（不落库——事实是过程态，真相在 board.state 行与 history.page）；乱序旧 at 丢弃、同 at 后写胜出
    - 桌面出向附着门控（isMirrorSession）：只推附着会话的 Worker 进展；出向 ~1s 合并窗口防刷屏（同窗口同 toolCallId 取最新一条，跨窗口逐批推送）
    - 归属链：事实经 `taskId` 挂到看板行（行 detail.claimedByTaskId）——进行中行展开「工具细节」= 该行 feed 的最近调用；**feed 不新增行级判定**，行态/徽章/行序仍唯一来自 board.state
    - `humantask.*` 维持预留（二期命名空间不动）
  - M8 命令面信封（`cmd.*`：命令=core 能力[注册表数据驱动——未来命令零协议改动]，呈现=壳本地；additive v=1 不变，旧端安全丢弃）：
    - `cmd.sync`（m→d）body：`{}`（手机连接/重连建立后发送：请求命令目录+全量状态；走快速路径不碰引擎——与 chat.sync 同族，手机主动触发防桌面周期推送堆信箱）
    - `cmd.request`（m→d）body：`{ "id": "<请求id>", "cmd": "<命令id>", "args?": {...} }`（信封层走快速路径分流器[handler 不碰引擎]，按注册表 channel 分发：**fast=不碰引擎串行链就地执行**[turn.stop/model.list/front.list——picker 在轮次运行中也能即时拉到选项]，**serial=改会话状态者入串行链排队**[plan.set/goal.*/front.set/compact/model.set/model.param/session.delete/session.rename——轮末生效=诚实语义]；args 为结构化 JSON 经注册表校验，永不插值进对话文本；未知命令/非法 args fail-closed 回 cmd.result error）
    - `cmd.result`（d→m）body：`{ "replyTo": "<请求id>", "ok": <bool>, "data?": {...}, "error?": { "code": "unsupported|invalid_args|guard|internal", "message": "..." } }`（命令应答：picker 选项/执行结果/引擎守卫错误[如压缩前置条件不满足]诚实回流；手机按 replyTo 幂等匹配）
    - `cmd.state`（d→m）body：`{ "state": { "sessionId", "running", "plan", "model": { "name", "effort?" }, "front", "goal": { "status", "objective", "round", "maxRounds" }, "ctx": { "used", "max?", "approx?" } }, "catalog?": [...] }`（状态快照 latest-wins；ctx 口径=engine getContextStatus[>80% 自动压缩阈值转黄/无数据 null 整体隐藏/压缩后 approx 估值"约"]，与桌面占用环/CLI statusline 同源；手机落定唯一来源——本地点击绝不假装落定；推送时机三保底=命令执行后必推+轮末全量推+cmd.sync resync，无周期心跳；catalog 仅 cmd.sync 应答携带，未知 presentation/section 旧端折叠为 console-row 或跳过[数据前向兼容]）
    - 多会话消歧：命令与状态一律作用于**桌面活动会话**（遥控语义，与 chat.user 的附着路由正交）；`state.sessionId` 供手机诚实提示（附着≠活动时不本地遮蔽）。**例外（首个"非活动会话"命令族）**：`session.delete`/`session.rename` 按 `args.sessionId` 作用于任意会话——internal 不进目录、由手机手势携带 id 调用；删活动会话执行器先 detachSession 铸新 id（防引擎下次 save 复活文件），活动会话运行中诚实拒绝
    - 命令目录条目线形：`{ "id", "title", "section": "answer|advance|maintain", "presentation": "console-row|picker|input-morph|strip|badge", "risk": "instant|confirm|input", "channel": "fast|serial", "options?": { "lazy": "<选项源命令id>" } }`
    - 二期扩展预留：流式进度（cmd.progress）等仍走加法
- 二期命名空间（字段二期再定）：`humantask.*` / `feed.*` / `report`（`approval.*` 已于 M4 定稿，见上；`feed.subagent` 已于 V2 启用）
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
