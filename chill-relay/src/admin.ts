/**
 * admin.ts — relay-admin 本地 CLI（SSH 隧道/服务器本地，不公网暴露管理端口）。
 *   relay-admin list-boxes
 *   relay-admin drop-box <mailboxId>
 * DB 路径：--db <path> 或 DB_PATH 环境变量（默认 relay.db）。
 */
import { pathToFileURL } from 'node:url';
import { Store } from './store.js';

function main(argv: string[]): void {
  const args = [...argv];
  let dbPath = process.env['DB_PATH'] ?? 'relay.db';
  const dbIdx = args.indexOf('--db');
  if (dbIdx >= 0) {
    dbPath = args[dbIdx + 1] ?? dbPath;
    args.splice(dbIdx, 2);
  }
  const cmd = args[0];
  const store = new Store(dbPath);
  try {
    if (cmd === 'list-boxes') {
      const rows = store.listMailboxes();
      if (rows.length === 0) {
        console.log('(no mailboxes)');
        return;
      }
      for (const r of rows) {
        console.log(
          `${r.box}  device=${r.device}  created=${new Date(r.created).toISOString()}  reads=${r.reads}  pending=${store.boxCount(r.box)}  bytes=${store.boxBytes(r.box)}`,
        );
      }
      return;
    }
    if (cmd === 'drop-box') {
      const box = args[1];
      if (!box || !/^[0-9a-f]{32}$/.test(box)) {
        console.error('usage: relay-admin drop-box <mailboxId(32hex)>');
        process.exit(2);
      }
      const existed = store.dropMailbox(box);
      console.log(existed ? `dropped ${box}` : `not found: ${box}`);
      process.exit(existed ? 0 : 1);
    }
    console.error('usage: relay-admin [--db path] list-boxes | drop-box <mailboxId>');
    process.exit(2);
  } finally {
    store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
