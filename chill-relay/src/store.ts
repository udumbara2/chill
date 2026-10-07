/**
 * store.ts — SQLite（better-sqlite3，WAL）存储层。
 * schema 终稿见设计文档 v1.1 §4.2；扩展记载：
 * - mailboxes.reads 列（孤儿信箱 GC「创建 24h 零次成功读」需要跨重启的成功读计数，schema 未覆盖，
 *  本列为最小补足，语义不改变既有字段）；
 * - messages.deliver_attempts 列 + dead_messages 表（M7增量3·决策32：死信上限——同一消息
 *   投递 ≥20 次仍无 ACK 即移入死信表不再重投，防毒消息永驻信箱重投循环；2026-09-26 事故根治项）。
 */
import Database from 'better-sqlite3';

export const MESSAGE_TTL_MS = 7 * 24 * 3600 * 1000; // messages 7 天
export const BOX_QUOTA_BYTES = 5 * 1024 * 1024; // 单信箱 5MB
export const MAILBOX_ORPHAN_MS = 24 * 3600 * 1000; // 信箱创建 24h 零次成功读 → GC
export const TOKEN_UNUSED_GRACE_MS = 3600 * 1000; // 未消费令牌过期后再留 1h
export const TOKEN_REDEEMED_GRACE_MS = 24 * 3600 * 1000; // redeemed 行留 24h（覆盖重试+轮询窗口）
/** 死信阈值：同一消息投递该次数仍无 ACK → 移入 dead_messages 不再重投 */
export const DEAD_LETTER_ATTEMPTS = 20;

export interface MailboxRow {
  box: string;
  write_hash: string;
  read_hash: string;
  revoke_hash: string;
  device: string;
  created: number;
  reads: number;
}

export interface TokenRow {
  hash: string;
  used: number;
  expires: number;
  phone_pub: string | null;
  device: string | null;
}

export interface MessageRow {
  id: number;
  box: string;
  ts: number;
  ttl: number;
  blob: string;
  /** 投递尝试次数（每次 WS 连接重发 +1；≥ DEAD_LETTER_ATTEMPTS 移入 dead_messages） */
  deliver_attempts: number;
}

export class Store {
  private db: Database.Database;
  private now: () => number;

  constructor(path: string, now: () => number = Date.now) {
    this.now = now;
    this.db = new Database(path);
    if (path !== ':memory:') this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        box TEXT NOT NULL,
        ts INTEGER NOT NULL,
        ttl INTEGER NOT NULL,
        blob TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_box ON messages(box);
      CREATE TABLE IF NOT EXISTS mailboxes(
        box TEXT PRIMARY KEY,
        write_hash TEXT NOT NULL,
        read_hash TEXT NOT NULL,
        revoke_hash TEXT NOT NULL,
        device TEXT NOT NULL,
        created INTEGER NOT NULL,
        reads INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_mailboxes_write ON mailboxes(write_hash);
      CREATE TABLE IF NOT EXISTS pair_tokens(
        hash TEXT PRIMARY KEY,
        used INTEGER NOT NULL DEFAULT 0,
        expires INTEGER NOT NULL,
        phone_pub TEXT,
        device TEXT
      );
      CREATE TABLE IF NOT EXISTS dead_messages(
        id INTEGER PRIMARY KEY,
        box TEXT NOT NULL,
        ts INTEGER NOT NULL,
        ttl INTEGER NOT NULL,
        blob TEXT NOT NULL,
        deliver_attempts INTEGER NOT NULL,
        dead_at INTEGER NOT NULL
      );
    `);
    // 最小迁移（沿 mailboxes.reads 先例）：老库补 deliver_attempts 列，幂等
    const cols = this.db.prepare('PRAGMA table_info(messages)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'deliver_attempts')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN deliver_attempts INTEGER NOT NULL DEFAULT 0');
    }
  }

  // ---------- messages ----------
  /** 投递：id 服务器生成（响应返回、ACK 凭它）。返回 id。 */
  insertMessage(box: string, blob: string, ttlMs: number = MESSAGE_TTL_MS): number {
    const r = this.db
      .prepare('INSERT INTO messages(box, ts, ttl, blob) VALUES (?, ?, ?, ?)')
      .run(box, this.now(), ttlMs, blob);
    return Number(r.lastInsertRowid);
  }

  /** 未 ACK 消息（ACK 即删，表内即未 ACK），按 id 升序。 */
  pendingMessages(box: string): MessageRow[] {
    return this.db
      .prepare('SELECT id, box, ts, ttl, blob, deliver_attempts FROM messages WHERE box = ? ORDER BY id ASC')
      .all(box) as MessageRow[];
  }

  /** 投递尝试 +1（每次 WS 连接重发时调用）。返回累加后的次数。 */
  bumpDeliverAttempt(box: string, id: number): number {
    this.db
      .prepare('UPDATE messages SET deliver_attempts = deliver_attempts + 1 WHERE box = ? AND id = ?')
      .run(box, id);
    const r = this.db
      .prepare('SELECT deliver_attempts FROM messages WHERE box = ? AND id = ?')
      .get(box, id) as { deliver_attempts: number } | undefined;
    return r?.deliver_attempts ?? 0;
  }

  /** 死信：移入 dead_messages（保留可查）并从投递表删除。返回是否存在过。 */
  deadLetter(box: string, id: number, deadAt: number = this.now()): boolean {
    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT id, box, ts, ttl, blob, deliver_attempts FROM messages WHERE box = ? AND id = ?')
        .get(box, id) as MessageRow | undefined;
      if (!row) return false;
      this.db
        .prepare(
          'INSERT OR REPLACE INTO dead_messages(id, box, ts, ttl, blob, deliver_attempts, dead_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(row.id, row.box, row.ts, row.ttl, row.blob, row.deliver_attempts, deadAt);
      this.db.prepare('DELETE FROM messages WHERE box = ? AND id = ?').run(box, id);
      return true;
    });
    return tx();
  }

  /** 死信清单（运维可查；按 dead_at 降序）。 */
  listDeadMessages(box?: string): Array<MessageRow & { dead_at: number }> {
    return (box === undefined
      ? this.db.prepare('SELECT * FROM dead_messages ORDER BY dead_at DESC').all()
      : this.db.prepare('SELECT * FROM dead_messages WHERE box = ? ORDER BY dead_at DESC').all(box)
    ) as Array<MessageRow & { dead_at: number }>;
  }

  /** ACK = DELETE WHERE box=? AND id=?（双条件缺一不可）。返回是否删到。 */
  ackMessage(box: string, id: number): boolean {
    return this.db.prepare('DELETE FROM messages WHERE box = ? AND id = ?').run(box, id).changes > 0;
  }

  /** 配额实时算：ACK 删除立即释放。 */
  boxBytes(box: string): number {
    const r = this.db
      .prepare('SELECT COALESCE(SUM(LENGTH(blob)), 0) AS n FROM messages WHERE box = ?')
      .get(box) as { n: number };
    return r.n;
  }

  boxCount(box: string): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE box = ?').get(box) as {
      n: number;
    };
    return r.n;
  }

  /** TTL 清扫。返回删除条数。 */
  sweepMessages(now: number = this.now()): number {
    return this.db.prepare('DELETE FROM messages WHERE ts + ttl < ?').run(now).changes;
  }

  // ---------- mailboxes ----------
  createMailbox(
    box: string,
    writeHash: string,
    readHash: string,
    revokeHash: string,
    device: string,
    created: number = this.now(),
  ): void {
    // UPSERT：重配对（密钥轮换=重新配对）会用同一对公钥建新信箱，
    // 已有信箱时刷新令牌哈希与 created（视为新生命周期，孤儿 GC 重新计）
    this.db
      .prepare(
        'INSERT INTO mailboxes(box, write_hash, read_hash, revoke_hash, device, created) VALUES (?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(box) DO UPDATE SET write_hash=excluded.write_hash, read_hash=excluded.read_hash, revoke_hash=excluded.revoke_hash, device=excluded.device, created=excluded.created',
      )
      .run(box, writeHash, readHash, revokeHash, device, created);
  }

  getMailbox(box: string): MailboxRow | undefined {
    return this.db.prepare('SELECT * FROM mailboxes WHERE box = ?').get(box) as
      | MailboxRow
      | undefined;
  }

  /** media 路由鉴权：按 write_token 哈希反查信箱（配对令牌即凭据——零新凭据）。
   *  撤销信箱 = 行已被 dropMailbox 删除 → 反查未命中即 401（不区分不存在/已撤销，防枚举）。 */
  findBoxByWriteHash(writeHash: string): MailboxRow | undefined {
    return this.db.prepare('SELECT * FROM mailboxes WHERE write_hash = ?').get(writeHash) as
      | MailboxRow
      | undefined;
  }

  /** 记一次成功读（WS 鉴权通过 / 成功 ACK），供孤儿 GC 判定。 */
  markRead(box: string): void {
    this.db.prepare('UPDATE mailboxes SET reads = reads + 1 WHERE box = ?').run(box);
  }

  /** 注销信箱：连消息一起删。返回是否存在过。 */
  dropMailbox(box: string): boolean {
    const tx = this.db.transaction((b: string) => {
      const c = this.db.prepare('DELETE FROM mailboxes WHERE box = ?').run(b).changes;
      this.db.prepare('DELETE FROM messages WHERE box = ?').run(b);
      return c;
    });
    return tx(box) > 0;
  }

  listMailboxes(): MailboxRow[] {
    return this.db.prepare('SELECT * FROM mailboxes ORDER BY created ASC').all() as MailboxRow[];
  }

  /** 孤儿信箱 GC：创建 24h 零次成功读 → 自动注销。返回被注销的 box 列表。 */
  gcMailboxes(now: number = this.now()): string[] {
    const orphans = this.db
      .prepare('SELECT box FROM mailboxes WHERE reads = 0 AND created < ?')
      .all(now - MAILBOX_ORPHAN_MS) as { box: string }[];
    for (const o of orphans) this.dropMailbox(o.box);
    return orphans.map((o) => o.box);
  }

  // ---------- pair_tokens ----------
  createToken(hash: string, expires: number): void {
    this.db.prepare('INSERT INTO pair_tokens(hash, used, expires) VALUES (?, 0, ?)').run(hash, expires);
  }

  getToken(hash: string): TokenRow | undefined {
    return this.db.prepare('SELECT * FROM pair_tokens WHERE hash = ?').get(hash) as
      | TokenRow
      | undefined;
  }

  /**
   * 事务消费：token 置 redeemed + 双信箱插入，同一事务。
   * 返回 false 表示并发下已被别处消费（调用方走状态机重判）。
   */
  redeemTokenTransaction(
    hash: string,
    phonePub: string,
    device: string,
    mailboxes: { box: string; writeHash: string; readHash: string; revokeHash: string; device: string }[],
  ): boolean {
    const tx = this.db.transaction(() => {
      const c = this.db
        .prepare('UPDATE pair_tokens SET used = 1, phone_pub = ?, device = ? WHERE hash = ? AND used = 0')
        .run(phonePub, device, hash).changes;
      if (c === 0) return false;
      for (const m of mailboxes) {
        // UPSERT（同 createMailbox）：重配对刷新既有信箱的令牌哈希
        this.db
          .prepare(
            'INSERT INTO mailboxes(box, write_hash, read_hash, revoke_hash, device, created) VALUES (?, ?, ?, ?, ?, ?) ' +
              'ON CONFLICT(box) DO UPDATE SET write_hash=excluded.write_hash, read_hash=excluded.read_hash, revoke_hash=excluded.revoke_hash, device=excluded.device, created=excluded.created',
          )
          .run(m.box, m.writeHash, m.readHash, m.revokeHash, m.device, this.now());
        // 重配对 = 新密钥生命周期：旧密钥加密的残留消息在新密钥下必然不可解，
        // 不清理会被对端 fail-closed 拒收后无限重投（实测触发 reconnect-重投循环）
        this.db.prepare('DELETE FROM messages WHERE box = ?').run(m.box);
      }
      return true;
    });
    return tx();
  }

  /**
   * pair_tokens 行保留：used=0 且 expires < now-1h 才清扫；redeemed 行保留 24h。
   * （expires = 签发+10min，故 redeemed 行实际保留至过期后 24h，覆盖重试+轮询窗口。）
   */
  sweepTokens(now: number = this.now()): number {
    return this.db
      .prepare('DELETE FROM pair_tokens WHERE (used = 0 AND expires < ?) OR (used = 1 AND expires < ?)')
      .run(now - TOKEN_UNUSED_GRACE_MS, now - TOKEN_REDEEMED_GRACE_MS).changes;
  }

  close(): void {
    this.db.close();
  }
}
