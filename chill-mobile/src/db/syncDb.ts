/**
 * syncDb.ts — M6 手机端同步副本库（op-sqlite 封装）。
 *
 * 定位：手机本地只是桌面真相（~/.chill/sessions/*.json + projects.json）的只读副本，
 * 永不直写历史上行；一切变更经信封下行落库。schema 全部按 agentId 维度
 * （本期单 Agent="我的桌面"，agentId = 对端 deskPub 指纹 = deskBox；阶段 B 多 Agent 零返工）。
 *
 * 纪律：
 * - 写入一律 INSERT OR REPLACE / UPSERT（幂等：重投/乱序/重连补投不产生重复）；
 *   sessions 目录行按 updatedAt 后写胜出（桌面真相；UPSERT WHERE 守护，原子免读回）。
 * - 每页/每 chunk 一个事务（transaction 包裹一批写入）。
 * - 版本演进走 PRAGMA user_version：v1 = 本期首版 schema；v2 = syncState.lastChatSessionId；v3 = M7 看板副本；
 *   v4 = file.* 上行附件登记；v5 = d→m 收件登记（receivedFiles 五态状态机）；v6 = messages.clientId；
 *   v7 = 工作计划树副本（workPlanMeta 整树快照）；v8 = 孤儿收件行一次性清扫（无 DDL，数据修复）。
 */
import { open, type DB } from '@op-engineering/op-sqlite';

// ---------- 行类型（与 core envelope 线形对齐，DB 层自包含不跨层 import） ----------

export interface AgentRow {
  agentId: string;
  name: string;
  deskPub: string;
  /** ISO 时间串 */
  addedAt: string;
}

export interface ProjectRow {
  agentId: string;
  projectId: string;
  name: string;
  updatedAt: string;
}

export interface SessionRow {
  agentId: string;
  sessionId: string;
  /** 归"未分组"为 null；悬空 projectId（指向不存在项目）由 listSessions 查询侧归一化 */
  projectId: string | null;
  title: string;
  titleSource: string | null;
  workdir: string | null;
  createdAt: string;
  updatedAt: string;
  preview: string;
}

export interface MessageRow {
  agentId: string;
  sessionId: string;
  /** 消息身份键（= core SessionPersistence.messageKey），幂等主键一部分 */
  msgKey: string;
  role: string;
  /** ISO 时间串 */
  ts: string;
  /** text 正文 / tool 工具行 / notice 提示行 / media 占位 */
  kind: string;
  text: string;
  /** kind 相关附属载荷（reasoningContent/thinkingDurationMs/toolName/toolStatus/truncated）JSON */
  payloadJson: string | null;
  /** file.* 协议族（v4）：kind=media 行的附件引用回填 JSON（[{ref,name,mime}]）——缩略图/芯片渲染联查源。DB 读出恒有值（无则为 null）；构造侧可省 */
  refsJson?: string | null;
  /** 客户端消息身份（v6；仅 relay 来源用户消息携带，= chat.user 信封 id）——overlay 气泡与 DB 行同 id 的回声确认匹配键。DB 读出恒有值（无则为 null）；构造侧可省 */
  clientId?: string | null;
}

/** sentAttachments 行（v4：手机上传附件的本地登记；fileId=传输关联键） */
export interface SentAttachmentRow {
  fileId: string;
  /** image | file（渲染分支：图片查本地字节出缩略图；文档/视频出芯片） */
  kind: string;
  name: string;
  mime: string;
  size: number;
  /** App 私有目录内的本地副本 URI（拷贝时机=选中即拷，防系统清缓存丢字节） */
  localUri: string;
  sentAt: string;
}

/** receivedFiles 行（v5：d→m 收件登记——桌面发来的文件要约与拉取状态机；fileId=传输关联键）。
 *  state 五态：offered（待接收）/ pulling（拉取中）/ done（已保存）/ failed（失败可重试）/ expired（已过期）。
 *  归属不可变：sessionId = offer.sessionId 落库原值，此后永不改写；会话删除时行随内容级联消亡（deleteSession）。
 *  非终态行才持有暂存文件（chill-recv/ 下 .part/staging）——对账判主源见 listReceivedFileIds。 */
export interface ReceivedFileRow {
  fileId: string;
  /** 归属会话（offer.sessionId；null=要约未带） */
  sessionId: string | null;
  /** sanitizeFileName 清洗后的展示/落盘名（不携路径） */
  name: string;
  mime: string;
  size: number;
  sha256: string;
  /** offer.static 指针 JSON（含每附件随机密钥——重试/断点续拉的数据源；本表在 App 私有沙箱）。
   *  阅后即焚：done/expired 落定即清空（clearReceivedFileSecret），密钥不随历史卡片持久化 */
  staticJson: string;
  /** 要约过期时刻（epoch ms；null=未带） */
  expiresAt: number | null;
  state: string;
  /** 拉取完成的暂存明文路径（交付后清空列并删文件） */
  stagingPath: string | null;
  /** MediaStore 交付产物 content URI（done 态 [打开] 用） */
  contentUri: string | null;
  /** failed 态原因（人类可读） */
  error: string | null;
  createdAt: string;
  updatedAt: string;
  /** ②B（v9）：锚定基线快照（桌面钟——新卡落库时该会话 DB 末条消息 ts；永不改写；有效性门唯一输入。
   *  null=空会话首卡（无消息可取）或 v9 回填前的存量卡——均不参与门、保持现状位） */
  anchorFloorTs: number | null;
  /** ②B（v9）：显式锚定态（null=未锚；非 null=已锚，值为排序键）。已锚与否由本列判别，
   *  绝不依赖与尾条大小关系推导；v9 迁移回填存量卡 = epoch(createdAt)（现状位置，渲染零变化） */
  anchorTs: number | null;
}

export interface SyncStateRow {
  agentId: string;
  /** 附着意图锚（对账规则的数据源；手机发起 attach/发言即附着时先行更新，attached.changed 回流确认） */
  attachedSessionId: string | null;
  /** 桌面最近一期 catalog.state 的项目集合修订号（下次 catalog.sync 上报） */
  projectsRev: string | null;
  /** 最近一次目录对账完成时刻（ISO） */
  catalogSyncedAt: string | null;
  /** 会话列表分区展开状态（类五 UI 本地记忆；JSON map: projectId|'ungrouped' → bool） */
  expandedProjectsJson: string | null;
  /**
   * M6b：入口记忆（点"我的桌面"进哪个会话）——与附着（attachedSessionId，管实时流订阅）
   * 职责分离：进入聊天屏=附着+记入口；离开=脱离附着，入口记忆保留。悬空处理：
   * catalog deletes 命中即清 + 进入前校验存在性（syncReducer/路由决策两层）。
   */
  lastChatSessionId: string | null;
}

/** boardItems 行（投影行线形的库内形态；行序=协议 rows 序，sortOrder 保序——零判定渲染） */
export interface BoardItemRow {
  agentId: string;
  sessionId: string;
  itemId: string;
  title: string;
  /** 工位徽章文本；无主 null */
  assignee: string | null;
  /** 六态（pending/in_progress/blocked/completed/cancelled/failed） */
  status: string;
  /** 协议 label 徽章文案（直用，手机零判定） */
  label: string;
  /** 进展行（纯文本） */
  progressText: string | null;
  /** "认领 N 分钟"计时基线（epoch ms） */
  claimedAt: number | null;
  /** 限窗裁剪标记（1=裁剪） */
  clipped: number;
  /** detail 子对象 JSON（blockedReason/result/resultTruncated/releaseHistory/failCount） */
  detailJson: string | null;
  /** 协议 rows 序号（行序唯一事实源；查询 ORDER BY） */
  sortOrder: number;
  /** 本行落库时刻（ISO） */
  updatedAt: string;
}

/** workPlanMeta 行（v7：工作计划树副本——树整体 JSON 存一行[树体量小、全量替换语义，无需拆行表]；
 *  rev LWW 对账照 boardMeta 先例；treeJson=WorkPlanStateBody.items 的 JSON） */
export interface WorkPlanMetaRow {
  agentId: string;
  sessionId: string;
  /** 桌面树 revision（字符串；LWW 比较用 Number） */
  rev: string;
  /** 顶层项数组 JSON（WorkPlanItemWire[]；children 嵌套随行——手机零判定渲染） */
  treeJson: string;
  updatedAt: string;
}

/** boardMeta 行（board.state 标量随行物：rev LWW 对账 + strip/needsYou 显示源） */
export interface BoardMetaRow {
  agentId: string;
  sessionId: string;
  /** 桌面板 revision（字符串；LWW 比较用 Number） */
  rev: string;
  /** strip 视图模型 JSON（status/countText/settleText?/needsYou） */
  stripJson: string | null;
  /** needsYou 信号 JSON（needed/count） */
  needsYouJson: string | null;
  windowed: number;
  updatedAt: string;
}

export interface SyncDb {
  upsertAgent(a: AgentRow): Promise<void>;
  /** 项目整表替换（catalog.state 携带 projects = 全量整表语义；projectsRev 变化才携带） */
  replaceProjects(agentId: string, rows: ProjectRow[]): Promise<void>;
  /** 目录行 upsert（updatedAt 后写胜出） */
  upsertSession(s: SessionRow): Promise<void>;
  updateSessionTitle(agentId: string, sessionId: string, title: string, titleSource: string | null): Promise<void>;
  deleteSession(agentId: string, sessionId: string): Promise<void>;
  /** catalog.sync 上报用的已知版本 map：{ [sessionId]: updatedAt } */
  getSessionsVersionMap(agentId: string): Promise<Record<string, string>>;
  /** 会话列表查询（含"projectId 不在已知项目集合 → 未分组"的手机侧归一化——双端同一规则两个执行点之一） */
  listSessions(agentId: string): Promise<SessionRow[]>;
  /** 历史页落库：单事务 INSERT OR REPLACE（幂等归并） */
  insertMessages(rows: MessageRow[]): Promise<void>;
  /** 命中计数（尾部拉齐连续性链接的重叠判据：页 msgKeys 与落库前副本的交集数） */
  countMessagesByKeys(agentId: string, sessionId: string, keys: string[]): Promise<number>;
  /** 消息读取（类五 ChatScreen 数据源）：时间升序返回；before=已持有最早 msgKey（取比它更早的一页）；limit 缺省 50 */
  listMessages(agentId: string, sessionId: string, before?: string, limit?: number): Promise<MessageRow[]>;
  /** 项目读取（类五 SessionList 分区头数据源；order 升序） */
  listProjects(agentId: string): Promise<ProjectRow[]>;
  clearMessages(agentId: string, sessionId: string): Promise<void>;
  getSyncState(agentId: string): Promise<SyncStateRow | null>;
  putSyncState(state: SyncStateRow): Promise<void>;
  // ---------- M7 共享看板（board.state 投影副本；行序=协议 rows 序） ----------
  /** 行 upsert（INSERT OR REPLACE 幂等） */
  upsertBoardItems(rows: BoardItemRow[]): Promise<void>;
  /** 整表替换（full=true 语义：清残留 + 写入全量行，单事务） */
  replaceBoardItems(agentId: string, sessionId: string, rows: BoardItemRow[]): Promise<void>;
  /** 行读取（协议序 = sortOrder 升序） */
  listBoardItems(agentId: string, sessionId: string): Promise<BoardItemRow[]>;
  clearBoardItems(agentId: string, sessionId: string): Promise<void>;
  getBoardMeta(agentId: string, sessionId: string): Promise<BoardMetaRow | null>;
  putBoardMeta(meta: BoardMetaRow): Promise<void>;
  // ---------- v7：工作计划树副本（workplan.state 整树快照；树整体 JSON 一行） ----------
  getWorkPlanMeta(agentId: string, sessionId: string): Promise<WorkPlanMetaRow | null>;
  setWorkPlanMeta(meta: WorkPlanMetaRow): Promise<void>;
  // ---------- v4：file.* 本地登记表（历史缩略图/芯片渲染的联查源） ----------
  putSentAttachment(row: SentAttachmentRow): Promise<void>;
  getSentAttachment(fileId: string): Promise<SentAttachmentRow | null>;
  /** 批量联查（历史渲染热路径） */
  getSentAttachments(fileIds: string[]): Promise<SentAttachmentRow[]>;
  // ---------- v5：d→m 收件登记（receivedFiles 五态状态机的持久真相源） ----------
  putReceivedFile(row: ReceivedFileRow): Promise<void>;
  getReceivedFile(fileId: string): Promise<ReceivedFileRow | null>;
  /** 状态推进（updatedAt 联动；extra 未给的列置 null——状态机每跃迁显式交代全部附属列） */
  updateReceivedFileState(
    fileId: string,
    state: string,
    extra?: { stagingPath?: string | null; contentUri?: string | null; error?: string | null },
  ): Promise<void>;
  /** 阅后即焚：清 staticJson 密钥列（done/expired 落定后密钥不再持久化；行保留——done 卡 [打开] 只靠 contentUri。
   *  failed 态严禁调用——重试需要 staticJson 里的指针+密钥） */
  clearReceivedFileSecret(fileId: string): Promise<void>;
  /** 会话收件卡查询（历史渲染）：精确匹配归属本会话（归属不可变；无归属/归属已删的行不显示，行随会话级联消亡） */
  listReceivedFilesForSession(sessionId: string): Promise<ReceivedFileRow[]>;
  /** 未决收件（启动/重连清扫：offered 过期判定 + pulling 复位） */
  listPendingReceivedFiles(): Promise<ReceivedFileRow[]>;
  /** ②B（v9）：未锚卡扫描（锚定钩子唯一入口；anchorTs IS NULL 显式谓词） */
  listUnanchoredReceivedFiles(sessionId: string): Promise<ReceivedFileRow[]>;
  /** ②B（v9）：批量锚定写（唯一调用方=RelaySession.anchorPendingReceivedFiles） */
  updateReceivedFileAnchors(entries: Array<{ fileId: string; anchorTs: number }>): Promise<void>;
  /** ②B（v9）：会话末条消息 ts（epoch ms 桌面钟；空会话 null） */
  getSessionLastMessageTs(sessionId: string): Promise<number | null>;
  /** 非终态行 fileId 全集（暂存目录对账判主源：offered/pulling/failed 才可能有暂存文件；终态行残留由对账判无主清除） */
  listReceivedFileIds(): Promise<string[]>;
  /** 会话存在性（通用查询；原 d→m 文件卡归属判定消费方已随孤儿回退设计退役，接口保留） */
  hasSession(agentId: string, sessionId: string): Promise<boolean>;
  /** resetPairing 数据生命周期闭环：清空全部副本（agents/projects/sessions/messages/syncState/boards/attachments） */
  wipeAll(): Promise<void>;
  close(): void;
}

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS agents (
  agentId TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  deskPub TEXT NOT NULL,
  addedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  agentId TEXT NOT NULL,
  projectId TEXT NOT NULL,
  name TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (agentId, projectId)
);
CREATE TABLE IF NOT EXISTS sessions (
  agentId TEXT NOT NULL,
  sessionId TEXT NOT NULL,
  projectId TEXT,
  title TEXT NOT NULL,
  titleSource TEXT,
  workdir TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  preview TEXT NOT NULL,
  PRIMARY KEY (agentId, sessionId)
);
CREATE TABLE IF NOT EXISTS messages (
  agentId TEXT NOT NULL,
  sessionId TEXT NOT NULL,
  msgKey TEXT NOT NULL,
  role TEXT NOT NULL,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  payloadJson TEXT,
  refsJson TEXT,
  clientId TEXT,
  PRIMARY KEY (agentId, sessionId, msgKey)
);
CREATE TABLE IF NOT EXISTS syncState (
  agentId TEXT PRIMARY KEY,
  attachedSessionId TEXT,
  projectsRev TEXT,
  catalogSyncedAt TEXT,
  expandedProjectsJson TEXT,
  lastChatSessionId TEXT
);
`;

/** sessions 行的列序（INSERT/UPSERT/SELECT 共用，防字段清单漂移） */
const SESSION_COLS = 'agentId, sessionId, projectId, title, titleSource, workdir, createdAt, updatedAt, preview';

/** boardItems 行的列序（同上防漂移） */
const BOARD_ITEM_COLS = 'agentId, sessionId, itemId, title, assignee, status, label, progressText, claimedAt, clipped, detailJson, sortOrder, updatedAt';

/** v3：M7 共享看板副本表（boardItems=投影行[协议序]；boardMeta=rev/strip/needsYou 标量） */
const SCHEMA_V3 = `
CREATE TABLE IF NOT EXISTS boardItems (
  agentId TEXT NOT NULL,
  sessionId TEXT NOT NULL,
  itemId TEXT NOT NULL,
  title TEXT NOT NULL,
  assignee TEXT,
  status TEXT NOT NULL,
  label TEXT NOT NULL,
  progressText TEXT,
  claimedAt INTEGER,
  clipped INTEGER NOT NULL DEFAULT 0,
  detailJson TEXT,
  sortOrder INTEGER NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (agentId, sessionId, itemId)
);
CREATE TABLE IF NOT EXISTS boardMeta (
  agentId TEXT NOT NULL,
  sessionId TEXT NOT NULL,
  rev TEXT NOT NULL,
  stripJson TEXT,
  needsYouJson TEXT,
  windowed INTEGER NOT NULL DEFAULT 0,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (agentId, sessionId)
);
`;

/** v4：file.* 协议族——sentAttachments 本地登记表（历史缩略图/芯片渲染的联查源） */
const SCHEMA_V4 = `
CREATE TABLE IF NOT EXISTS sentAttachments (
  fileId TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  localUri TEXT NOT NULL,
  sentAt TEXT NOT NULL
);
`;

/** v5：d→m 收件登记表（receivedFiles——要约/拉取五态/断点与交付产物的持久真相源） */
const SCHEMA_V5 = `
CREATE TABLE IF NOT EXISTS receivedFiles (
  fileId TEXT PRIMARY KEY,
  sessionId TEXT,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  staticJson TEXT NOT NULL,
  expiresAt INTEGER,
  state TEXT NOT NULL,
  stagingPath TEXT,
  contentUri TEXT,
  error TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  anchorFloorTs INTEGER,
  anchorTs INTEGER
);
`;

/** receivedFiles 行的列序（INSERT/SELECT 共用，防字段清单漂移） */
const RECEIVED_FILE_COLS = 'fileId, sessionId, name, mime, size, sha256, staticJson, expiresAt, state, stagingPath, contentUri, error, createdAt, updatedAt, anchorFloorTs, anchorTs';

/** v7：工作计划树副本表（树整体 JSON 存一行——树体量小、全量替换语义，比照 boardItems 平表更省迁移面） */
const SCHEMA_V7 = `
CREATE TABLE IF NOT EXISTS workPlanMeta (
  agentId TEXT NOT NULL,
  sessionId TEXT NOT NULL,
  rev TEXT NOT NULL,
  treeJson TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (agentId, sessionId)
);
`;

class OpSyncDb implements SyncDb {
  private db: DB;

  constructor(name: string) {
    this.db = open({ name });
    // WAL：读写不互堵（流式落库与列表查询并发）
    this.db.executeSync('PRAGMA journal_mode = WAL;');
    const v = this.db.executeSync('PRAGMA user_version;');
    const current = Number((v.rows[0] as Record<string, number> | undefined)?.['user_version'] ?? 0);
    applySyncDbMigrations(this.db, current);
  }

  async upsertAgent(a: AgentRow): Promise<void> {
    await this.db.execute('INSERT OR REPLACE INTO agents (agentId, name, deskPub, addedAt) VALUES (?, ?, ?, ?)', [
      a.agentId, a.name, a.deskPub, a.addedAt,
    ]);
  }

  async replaceProjects(agentId: string, rows: ProjectRow[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute('DELETE FROM projects WHERE agentId = ?', [agentId]);
      for (const p of rows) {
        await tx.execute('INSERT OR REPLACE INTO projects (agentId, projectId, name, updatedAt) VALUES (?, ?, ?, ?)', [
          p.agentId, p.projectId, p.name, p.updatedAt,
        ]);
      }
    });
  }

  async upsertSession(s: SessionRow): Promise<void> {
    // updatedAt 后写胜出（桌面真相）：盘上行更新则拒绝旧写入（重投/乱序收敛）
    await this.db.execute(
      `INSERT INTO sessions (${SESSION_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agentId, sessionId) DO UPDATE SET
         projectId = excluded.projectId, title = excluded.title, titleSource = excluded.titleSource,
         workdir = excluded.workdir, createdAt = excluded.createdAt, updatedAt = excluded.updatedAt,
         preview = excluded.preview
       WHERE excluded.updatedAt >= sessions.updatedAt`,
      [s.agentId, s.sessionId, s.projectId, s.title, s.titleSource, s.workdir, s.createdAt, s.updatedAt, s.preview],
    );
  }

  async updateSessionTitle(agentId: string, sessionId: string, title: string, titleSource: string | null): Promise<void> {
    // 改名不动 updatedAt（对齐桌面 patchTitle 语义：改名非会话活动，不动列表排序）
    await this.db.execute('UPDATE sessions SET title = ?, titleSource = ? WHERE agentId = ? AND sessionId = ?', [
      title, titleSource, agentId, sessionId,
    ]);
  }

  async deleteSession(agentId: string, sessionId: string): Promise<void> {
    // 级联清（M7）：会话消失（catalog deletes / session.deleted / history notFound）连带看板副本；v7 连带工作计划树副本；
    // v8+ 连带收件登记（卡片=消息，随会话内容级联消亡；传输在飞时 UPDATE 对已删行零行幂等，文件照常交付）
    await this.db.transaction(async (tx) => {
      await tx.execute('DELETE FROM sessions WHERE agentId = ? AND sessionId = ?', [agentId, sessionId]);
      await tx.execute('DELETE FROM messages WHERE agentId = ? AND sessionId = ?', [agentId, sessionId]);
      await tx.execute('DELETE FROM boardItems WHERE agentId = ? AND sessionId = ?', [agentId, sessionId]);
      await tx.execute('DELETE FROM boardMeta WHERE agentId = ? AND sessionId = ?', [agentId, sessionId]);
      await tx.execute('DELETE FROM workPlanMeta WHERE agentId = ? AND sessionId = ?', [agentId, sessionId]);
      await tx.execute('DELETE FROM receivedFiles WHERE sessionId = ?', [sessionId]);
    });
  }

  async getSessionsVersionMap(agentId: string): Promise<Record<string, string>> {
    const r = await this.db.execute('SELECT sessionId, updatedAt FROM sessions WHERE agentId = ?', [agentId]);
    const map: Record<string, string> = {};
    for (const row of r.rows) map[String(row['sessionId'])] = String(row['updatedAt']);
    return map;
  }

  async listSessions(agentId: string): Promise<SessionRow[]> {
    // 悬空归一化：LEFT JOIN 项目集合，引用不存在项目的 projectId 归 null（未分组）
    const r = await this.db.execute(
      `SELECT s.${SESSION_COLS.split(', ').join(', s.')},
         CASE WHEN s.projectId IS NOT NULL AND p.projectId IS NULL THEN NULL ELSE s.projectId END AS normProjectId
       FROM sessions s
       LEFT JOIN projects p ON p.agentId = s.agentId AND p.projectId = s.projectId
       WHERE s.agentId = ?
       ORDER BY s.updatedAt DESC, s.sessionId ASC`,
      [agentId],
    );
    return r.rows.map((row) => ({
      agentId: String(row['agentId']),
      sessionId: String(row['sessionId']),
      projectId: (row['normProjectId'] as string | null) ?? null,
      title: String(row['title']),
      titleSource: (row['titleSource'] as string | null) ?? null,
      workdir: (row['workdir'] as string | null) ?? null,
      createdAt: String(row['createdAt']),
      updatedAt: String(row['updatedAt']),
      preview: String(row['preview']),
    }));
  }

  async insertMessages(rows: MessageRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db.transaction(async (tx) => {
      for (const m of rows) {
        await tx.execute(
          'INSERT OR REPLACE INTO messages (agentId, sessionId, msgKey, role, ts, kind, text, payloadJson, refsJson, clientId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [m.agentId, m.sessionId, m.msgKey, m.role, m.ts, m.kind, m.text, m.payloadJson, m.refsJson ?? null, m.clientId ?? null],
        );
      }
    });
  }

  /** 命中计数（尾部拉齐连续性链接的重叠判据：页 msgKeys 与落库前副本的交集数） */
  async countMessagesByKeys(agentId: string, sessionId: string, keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    const marks = keys.map(() => '?').join(',');
    const r = await this.db.execute(
      `SELECT COUNT(*) AS n FROM messages WHERE agentId = ? AND sessionId = ? AND msgKey IN (${marks})`,
      [agentId, sessionId, ...keys],
    );
    return Number((r.rows[0] as Record<string, number> | undefined)?.['n'] ?? 0);
  }

  async listMessages(agentId: string, sessionId: string, before?: string, limit?: number): Promise<MessageRow[]> {
    // 游标语义对齐协议：before = 已持有的最早 msgKey，取比它更早的一页（ts 倒序取后翻回升序）
    const r = before === undefined
      ? await this.db.execute(
          'SELECT agentId, sessionId, msgKey, role, ts, kind, text, payloadJson, refsJson, clientId FROM messages WHERE agentId = ? AND sessionId = ? ORDER BY ts DESC, msgKey DESC LIMIT ?',
          [agentId, sessionId, limit ?? 50],
        )
      : await this.db.execute(
          `SELECT agentId, sessionId, msgKey, role, ts, kind, text, payloadJson, refsJson, clientId FROM messages
           WHERE agentId = ? AND sessionId = ?
             AND (ts, msgKey) < (SELECT ts, msgKey FROM messages WHERE agentId = ? AND sessionId = ? AND msgKey = ?)
           ORDER BY ts DESC, msgKey DESC LIMIT ?`,
          [agentId, sessionId, agentId, sessionId, before, limit ?? 50],
        );
    return r.rows.reverse().map((row) => ({
      agentId: String(row['agentId']),
      sessionId: String(row['sessionId']),
      msgKey: String(row['msgKey']),
      role: String(row['role']),
      ts: String(row['ts']),
      kind: String(row['kind']),
      text: String(row['text']),
      payloadJson: (row['payloadJson'] as string | null) ?? null,
      refsJson: (row['refsJson'] as string | null) ?? null,
      clientId: (row['clientId'] as string | null) ?? null,
    }));
  }

  // ---------- v4：file.* 本地登记表（历史缩略图/芯片渲染的联查源） ----------

  async putSentAttachment(row: SentAttachmentRow): Promise<void> {
    await this.db.execute(
      'INSERT OR REPLACE INTO sentAttachments (fileId, kind, name, mime, size, localUri, sentAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [row.fileId, row.kind, row.name, row.mime, row.size, row.localUri, row.sentAt],
    );
  }

  async getSentAttachment(fileId: string): Promise<SentAttachmentRow | null> {
    const r = await this.db.execute('SELECT fileId, kind, name, mime, size, localUri, sentAt FROM sentAttachments WHERE fileId = ?', [fileId]);
    const row = r.rows[0];
    if (!row) return null;
    return {
      fileId: String(row['fileId']),
      kind: String(row['kind']),
      name: String(row['name']),
      mime: String(row['mime']),
      size: Number(row['size']),
      localUri: String(row['localUri']),
      sentAt: String(row['sentAt']),
    };
  }

  /** 批量联查（历史渲染热路径：一次 SQL 取整页 refs 的本地副本） */
  async getSentAttachments(fileIds: string[]): Promise<SentAttachmentRow[]> {
    if (fileIds.length === 0) return [];
    const r = await this.db.execute(
      `SELECT fileId, kind, name, mime, size, localUri, sentAt FROM sentAttachments WHERE fileId IN (${fileIds.map(() => '?').join(',')})`,
      fileIds,
    );
    return r.rows.map((row) => ({
      fileId: String(row['fileId']),
      kind: String(row['kind']),
      name: String(row['name']),
      mime: String(row['mime']),
      size: Number(row['size']),
      localUri: String(row['localUri']),
      sentAt: String(row['sentAt']),
    }));
  }

  // ---------- v5：d→m 收件登记（receivedFiles 五态状态机的持久真相源） ----------

  async putReceivedFile(row: ReceivedFileRow): Promise<void> {
    await this.db.execute(
      `INSERT OR REPLACE INTO receivedFiles (${RECEIVED_FILE_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.fileId, row.sessionId, row.name, row.mime, row.size, row.sha256, row.staticJson, row.expiresAt, row.state, row.stagingPath, row.contentUri, row.error, row.createdAt, row.updatedAt, row.anchorFloorTs, row.anchorTs],
    );
  }

  async getReceivedFile(fileId: string): Promise<ReceivedFileRow | null> {
    const r = await this.db.execute(`SELECT ${RECEIVED_FILE_COLS} FROM receivedFiles WHERE fileId = ?`, [fileId]);
    const row = r.rows[0];
    if (!row) return null;
    return receivedFileRowOf(row);
  }

  async updateReceivedFileState(
    fileId: string,
    state: string,
    extra?: { stagingPath?: string | null; contentUri?: string | null; error?: string | null },
  ): Promise<void> {
    await this.db.execute(
      'UPDATE receivedFiles SET state = ?, stagingPath = ?, contentUri = ?, error = ?, updatedAt = ? WHERE fileId = ?',
      [state, extra?.stagingPath ?? null, extra?.contentUri ?? null, extra?.error ?? null, new Date().toISOString(), fileId],
    );
  }

  async clearReceivedFileSecret(fileId: string): Promise<void> {
    await this.db.execute("UPDATE receivedFiles SET staticJson = '', updatedAt = ? WHERE fileId = ?", [
      new Date().toISOString(),
      fileId,
    ]);
  }

  async listReceivedFilesForSession(sessionId: string): Promise<ReceivedFileRow[]> {
    // 精确匹配：卡片钉死在归属会话（归属不可变 = offer.sessionId 落库原值）；
    // 无归属（要约未带 sessionId）或归属会话已删的行不显示——行随会话级联消亡，不再兜底串场
    const r = await this.db.execute(
      `SELECT ${RECEIVED_FILE_COLS} FROM receivedFiles
       WHERE sessionId = ?
       ORDER BY createdAt ASC, fileId ASC`,
      [sessionId],
    );
    return r.rows.map(receivedFileRowOf);
  }

  async listPendingReceivedFiles(): Promise<ReceivedFileRow[]> {
    const r = await this.db.execute(
      `SELECT ${RECEIVED_FILE_COLS} FROM receivedFiles WHERE state IN ('offered', 'pulling') ORDER BY createdAt ASC`,
    );
    return r.rows.map(receivedFileRowOf);
  }

  async listReceivedFileIds(): Promise<string[]> {
    // 判主收窄非终态行：done 落库在交付清场之后、expired 终态化前必经 discard——终态行的暂存文件
    // 已是应清残留，判无主由目录对账兜底清除；failed 必须在列（断点保留态，重试续拉数据源）
    const r = await this.db.execute(
      `SELECT fileId FROM receivedFiles WHERE state IN ('offered', 'pulling', 'failed')`,
    );
    return r.rows.map((row) => String(row['fileId']));
  }

  // ---------- ②B（v9）：迟到锚定支撑（扫描谓词/批量锚定写/会话末条消息 ts） ----------

  /** 未锚卡扫描（锚定钩子唯一入口；显式谓词 anchorTs IS NULL——已锚卡永不重扫，纯 SQL 零歧义） */
  async listUnanchoredReceivedFiles(sessionId: string): Promise<ReceivedFileRow[]> {
    const r = await this.db.execute(
      `SELECT ${RECEIVED_FILE_COLS} FROM receivedFiles WHERE sessionId = ? AND anchorTs IS NULL ORDER BY createdAt ASC, fileId ASC`,
      [sessionId],
    );
    return r.rows.map(receivedFileRowOf);
  }

  /** 批量锚定写（唯一调用方=session.anchorPendingReceivedFiles；receivedFiles 单一写入者纪律内） */
  async updateReceivedFileAnchors(entries: Array<{ fileId: string; anchorTs: number }>): Promise<void> {
    if (entries.length === 0) return;
    const nowIso = new Date().toISOString();
    for (const e of entries) {
      await this.db.execute('UPDATE receivedFiles SET anchorTs = ?, updatedAt = ? WHERE fileId = ?', [
        e.anchorTs,
        nowIso,
        e.fileId,
      ]);
    }
  }

  /** 会话末条消息 ts（epoch ms；桌面钟坐标系——锚定 floor 快照与有效性门同源输入；空会话 null） */
  async getSessionLastMessageTs(sessionId: string): Promise<number | null> {
    const r = await this.db.execute('SELECT ts FROM messages WHERE sessionId = ? ORDER BY ts DESC LIMIT 1', [sessionId]);
    const row = r.rows[0];
    if (!row) return null;
    const t = Date.parse(String(row['ts']));
    return Number.isFinite(t) ? t : null;
  }

  async hasSession(agentId: string, sessionId: string): Promise<boolean> {
    const r = await this.db.execute('SELECT 1 AS x FROM sessions WHERE agentId = ? AND sessionId = ?', [agentId, sessionId]);
    return r.rows.length > 0;
  }

  async listProjects(agentId: string): Promise<ProjectRow[]> {
    const r = await this.db.execute('SELECT agentId, projectId, name, updatedAt FROM projects WHERE agentId = ?', [agentId]);
    return r.rows.map((row) => ({
      agentId: String(row['agentId']),
      projectId: String(row['projectId']),
      name: String(row['name']),
      updatedAt: String(row['updatedAt']),
    }));
  }

  async clearMessages(agentId: string, sessionId: string): Promise<void> {
    await this.db.execute('DELETE FROM messages WHERE agentId = ? AND sessionId = ?', [agentId, sessionId]);
  }

  async upsertBoardItems(rows: BoardItemRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db.transaction(async (tx) => {
      for (const r of rows) {
        await tx.execute(
          `INSERT OR REPLACE INTO boardItems (${BOARD_ITEM_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [r.agentId, r.sessionId, r.itemId, r.title, r.assignee, r.status, r.label, r.progressText, r.claimedAt, r.clipped, r.detailJson, r.sortOrder, r.updatedAt],
        );
      }
    });
  }

  async replaceBoardItems(agentId: string, sessionId: string, rows: BoardItemRow[]): Promise<void> {
    // full=true 整表替换 + 残留清除（单事务：清旧 → 写全量，仿 replaceProjects 先例）
    await this.db.transaction(async (tx) => {
      await tx.execute('DELETE FROM boardItems WHERE agentId = ? AND sessionId = ?', [agentId, sessionId]);
      for (const r of rows) {
        await tx.execute(
          `INSERT OR REPLACE INTO boardItems (${BOARD_ITEM_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [r.agentId, r.sessionId, r.itemId, r.title, r.assignee, r.status, r.label, r.progressText, r.claimedAt, r.clipped, r.detailJson, r.sortOrder, r.updatedAt],
        );
      }
    });
  }

  async listBoardItems(agentId: string, sessionId: string): Promise<BoardItemRow[]> {
    // 行序唯一事实源=协议 rows 序（sortOrder），零判定渲染
    const r = await this.db.execute(
      `SELECT ${BOARD_ITEM_COLS} FROM boardItems WHERE agentId = ? AND sessionId = ? ORDER BY sortOrder ASC`,
      [agentId, sessionId],
    );
    return r.rows.map((row) => ({
      agentId: String(row['agentId']),
      sessionId: String(row['sessionId']),
      itemId: String(row['itemId']),
      title: String(row['title']),
      assignee: (row['assignee'] as string | null) ?? null,
      status: String(row['status']),
      label: String(row['label']),
      progressText: (row['progressText'] as string | null) ?? null,
      claimedAt: row['claimedAt'] === null || row['claimedAt'] === undefined ? null : Number(row['claimedAt']),
      clipped: Number(row['clipped'] ?? 0),
      detailJson: (row['detailJson'] as string | null) ?? null,
      sortOrder: Number(row['sortOrder'] ?? 0),
      updatedAt: String(row['updatedAt']),
    }));
  }

  async clearBoardItems(agentId: string, sessionId: string): Promise<void> {
    await this.db.execute('DELETE FROM boardItems WHERE agentId = ? AND sessionId = ?', [agentId, sessionId]);
  }

  async getBoardMeta(agentId: string, sessionId: string): Promise<BoardMetaRow | null> {
    const r = await this.db.execute(
      'SELECT agentId, sessionId, rev, stripJson, needsYouJson, windowed, updatedAt FROM boardMeta WHERE agentId = ? AND sessionId = ?',
      [agentId, sessionId],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      agentId: String(row['agentId']),
      sessionId: String(row['sessionId']),
      rev: String(row['rev']),
      stripJson: (row['stripJson'] as string | null) ?? null,
      needsYouJson: (row['needsYouJson'] as string | null) ?? null,
      windowed: Number(row['windowed'] ?? 0),
      updatedAt: String(row['updatedAt']),
    };
  }

  async putBoardMeta(meta: BoardMetaRow): Promise<void> {
    await this.db.execute(
      'INSERT OR REPLACE INTO boardMeta (agentId, sessionId, rev, stripJson, needsYouJson, windowed, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [meta.agentId, meta.sessionId, meta.rev, meta.stripJson, meta.needsYouJson, meta.windowed, meta.updatedAt],
    );
  }

  // ---------- v7：工作计划树副本（workplan.state 整树快照） ----------

  async getWorkPlanMeta(agentId: string, sessionId: string): Promise<WorkPlanMetaRow | null> {
    const r = await this.db.execute(
      'SELECT agentId, sessionId, rev, treeJson, updatedAt FROM workPlanMeta WHERE agentId = ? AND sessionId = ?',
      [agentId, sessionId],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      agentId: String(row['agentId']),
      sessionId: String(row['sessionId']),
      rev: String(row['rev']),
      treeJson: String(row['treeJson']),
      updatedAt: String(row['updatedAt']),
    };
  }

  async setWorkPlanMeta(meta: WorkPlanMetaRow): Promise<void> {
    await this.db.execute(
      'INSERT OR REPLACE INTO workPlanMeta (agentId, sessionId, rev, treeJson, updatedAt) VALUES (?, ?, ?, ?, ?)',
      [meta.agentId, meta.sessionId, meta.rev, meta.treeJson, meta.updatedAt],
    );
  }

  async getSyncState(agentId: string): Promise<SyncStateRow | null> {
    const r = await this.db.execute(
      'SELECT agentId, attachedSessionId, projectsRev, catalogSyncedAt, expandedProjectsJson, lastChatSessionId FROM syncState WHERE agentId = ?',
      [agentId],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      agentId: String(row['agentId']),
      attachedSessionId: (row['attachedSessionId'] as string | null) ?? null,
      projectsRev: (row['projectsRev'] as string | null) ?? null,
      catalogSyncedAt: (row['catalogSyncedAt'] as string | null) ?? null,
      expandedProjectsJson: (row['expandedProjectsJson'] as string | null) ?? null,
      lastChatSessionId: (row['lastChatSessionId'] as string | null) ?? null,
    };
  }

  async putSyncState(state: SyncStateRow): Promise<void> {
    await this.db.execute(
      'INSERT OR REPLACE INTO syncState (agentId, attachedSessionId, projectsRev, catalogSyncedAt, expandedProjectsJson, lastChatSessionId) VALUES (?, ?, ?, ?, ?, ?)',
      [state.agentId, state.attachedSessionId, state.projectsRev, state.catalogSyncedAt, state.expandedProjectsJson, state.lastChatSessionId],
    );
  }

  async wipeAll(): Promise<void> {
    await this.db.transaction(async (tx) => {
      for (const t of ['messages', 'sessions', 'projects', 'agents', 'syncState', 'boardItems', 'boardMeta', 'workPlanMeta', 'sentAttachments', 'receivedFiles']) {
        await tx.execute(`DELETE FROM ${t}`);
      }
    });
  }

  close(): void {
    this.db.close();
  }
}

/** receivedFiles 行映射（SELECT 出口单点——列序与 RECEIVED_FILE_COLS 对齐） */
function receivedFileRowOf(row: Record<string, unknown>): ReceivedFileRow {
  return {
    fileId: String(row['fileId']),
    sessionId: (row['sessionId'] as string | null) ?? null,
    name: String(row['name']),
    mime: String(row['mime']),
    size: Number(row['size']),
    sha256: String(row['sha256']),
    staticJson: String(row['staticJson']),
    expiresAt: row['expiresAt'] === null || row['expiresAt'] === undefined ? null : Number(row['expiresAt']),
    state: String(row['state']),
    stagingPath: (row['stagingPath'] as string | null) ?? null,
    contentUri: (row['contentUri'] as string | null) ?? null,
    error: (row['error'] as string | null) ?? null,
    createdAt: String(row['createdAt']),
    updatedAt: String(row['updatedAt']),
    anchorFloorTs: row['anchorFloorTs'] === null || row['anchorFloorTs'] === undefined ? null : Number(row['anchorFloorTs']),
    anchorTs: row['anchorTs'] === null || row['anchorTs'] === undefined ? null : Number(row['anchorTs']),
  };
}

let instance: SyncDb | null = null;

/**
 * 版本迁移执行器（构造器调用；导出以便 jest 用记录型假执行器断言迁移序列——原生 SQL 正确性由真机/e2e 兜底）。
 * 纪律：PRAGMA user_version 只升不降；每级迁移对旧库向下兼容（新表 CREATE IF NOT EXISTS / 旧库才 ALTER）。
 */
export function applySyncDbMigrations(exec: { executeSync(sql: string): unknown }, current: number): void {
  if (current < 1) {
    for (const stmt of SCHEMA_V1.split(';').map((s) => s.trim()).filter(Boolean)) {
      exec.executeSync(stmt);
    }
  }
  if (current < 2) {
    // v2：syncState 增 lastChatSessionId（M6b 入口记忆）。v1→v2 最小迁移（ALTER 加列）；
    // 全新安装上方建表已含该列，只在旧库上 ALTER
    if (current >= 1) {
      exec.executeSync('ALTER TABLE syncState ADD COLUMN lastChatSessionId TEXT');
    }
    exec.executeSync('PRAGMA user_version = 2;');
  }
  if (current < 3) {
    // v3：M7 共享看板副本（boardItems 投影行 + boardMeta 标量/rev）。新表 CREATE IF NOT EXISTS——
    // 全新安装与 v2 旧库同路径幂等建表（向下兼容：旧库可升入，不动既有表）
    for (const stmt of SCHEMA_V3.split(';').map((s) => s.trim()).filter(Boolean)) {
      exec.executeSync(stmt);
    }
    exec.executeSync('PRAGMA user_version = 3;');
  }
  if (current < 4) {
    // v4：file.* 协议族——①sentAttachments 本地登记表（fileId→本地副本；历史缩略图/芯片渲染的联查源，
    // 字节拷入 App 私有目录防系统清缓存）；②messages 加 refsJson 列（refs 必须落库——否则重启后
    // 历史行无 refs、本地有副本的图片也会误降级占位）。新表 IF NOT EXISTS 幂等；ALTER 仅旧库执行。
    for (const stmt of SCHEMA_V4.split(';').map((s) => s.trim()).filter(Boolean)) {
      exec.executeSync(stmt);
    }
    if (current >= 1) {
      exec.executeSync('ALTER TABLE messages ADD COLUMN refsJson TEXT');
    }
    exec.executeSync('PRAGMA user_version = 4;');
  }
  if (current < 5) {
    // v5：d→m 收件登记表（receivedFiles：要约/五态/断点/交付产物）。新表 CREATE IF NOT EXISTS——
    // 全新安装与 v4 旧库同路径幂等建表（向下兼容：旧库可升入，不动既有表）
    for (const stmt of SCHEMA_V5.split(';').map((s) => s.trim()).filter(Boolean)) {
      exec.executeSync(stmt);
    }
    exec.executeSync('PRAGMA user_version = 5;');
  }
  if (current < 6) {
    // v6：messages 加 clientId 列（客户端消息身份——relay 来源用户消息=其 chat.user 信封 id；
    // overlay 气泡与 DB 行同 id 的回声确认匹配键）。新装 SCHEMA_V1 已含该列，只在旧库上 ALTER
    if (current >= 1) {
      exec.executeSync('ALTER TABLE messages ADD COLUMN clientId TEXT');
    }
    exec.executeSync('PRAGMA user_version = 6;');
  }
  if (current < 7) {
    // v7：工作计划树副本表（workPlanMeta：workplan.state 整树快照 JSON 一行 + rev LWW 对账）。
    // 新表 CREATE IF NOT EXISTS——全新安装与 v6 旧库同路径幂等建表（向下兼容：旧库可升入，不动既有表）
    for (const stmt of SCHEMA_V7.split(';').map((s) => s.trim()).filter(Boolean)) {
      exec.executeSync(stmt);
    }
    exec.executeSync('PRAGMA user_version = 7;');
  }
  if (current < 8) {
    // v8：孤儿收件行一次性清扫（归属会话不存在或无归属——历史"孤儿回退"设计退役，卡片只长在归属会话）。
    // 无 DDL 纯数据修复：全新库 v5 建表为空、DELETE 零行幂等；v7 现库升级即清掉历史孤儿卡
    exec.executeSync(
      "DELETE FROM receivedFiles WHERE sessionId IS NULL OR sessionId NOT IN (SELECT sessionId FROM sessions)",
    );
    exec.executeSync('PRAGMA user_version = 8;');
  }
  if (current < 9) {
    // v9：②B 迟到锚定双列（anchorFloorTs=桌面钟基线快照；anchorTs=显式锚定态）+ 存量卡回填。
    // 新装库（current<5 走更新后的 SCHEMA_V5 建表）已含双列，只在 v5+ 旧库 ALTER；
    // 回填 anchorTs=epoch(createdAt)：存量卡即刻显式已锚于现状位置（渲染 anchorTs ?? createdAt 两者相等、
    // anchorTs IS NULL 扫描天然排除、无魔法时间戳、幂等）；floor 存量留 null（不参与门，保持现状语义）
    if (current >= 5) {
      exec.executeSync('ALTER TABLE receivedFiles ADD COLUMN anchorFloorTs INTEGER');
      exec.executeSync('ALTER TABLE receivedFiles ADD COLUMN anchorTs INTEGER');
    }
    exec.executeSync(
      "UPDATE receivedFiles SET anchorTs = CAST((julianday(createdAt) - 2440587.5) * 86400000 AS INTEGER) WHERE anchorTs IS NULL",
    );
    exec.executeSync('PRAGMA user_version = 9;');
  }
}

/** 副本库单例（惰性打开；应用私有沙箱目录，栖息地即微信同级） */
export function getSyncDb(): SyncDb {
  if (!instance) instance = new OpSyncDb('chill-sync.db');
  return instance;
}

/** 测试/ teardown 用：关闭并释放单例 */
export function closeSyncDb(): void {
  instance?.close();
  instance = null;
}
