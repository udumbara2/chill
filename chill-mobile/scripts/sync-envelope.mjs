#!/usr/bin/env node
/**
 * sync-envelope.mjs — 信封层单源同步（禁手写第二份，PROTOCOL-FROZEN 搬运纪律）。
 * 从 chill monorepo core 拷贝 envelope.ts 进 src/relay/，并生成 CA 捆绑件
 * （ca-bundle.ts：CA 证书 base64 + caFP——与 res/raw 的 CA 同源，供 QR caFP 校验）。
 * CA 源路径：CHILL_CA_PATH 环境变量，缺省 ../chill-relay/certs/ca.crt。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORE_ENVELOPE =
  process.env.CHILL_CORE_ENVELOPE ??
  resolve(root, '../chill/packages/core/src/services/relay/envelope.ts');
const CA_PATH = process.env.CHILL_CA_PATH ?? resolve(root, '../chill-relay/certs/ca.crt');

mkdirSync(join(root, 'src/relay'), { recursive: true });

const envelope = readFileSync(CORE_ENVELOPE, 'utf8');
const header = `// 本文件由 scripts/sync-envelope.mjs 从 chill core 拷贝生成，禁止手改（单源在 core/src/services/relay/envelope.ts）\n`;
writeFileSync(join(root, 'src/relay/envelope.ts'), header + envelope, 'utf8');

const caBytes = readFileSync(CA_PATH);
const caB64 = caBytes.toString('base64');
const caFP = createHash('sha256').update(caBytes).digest('base64url');
writeFileSync(
  join(root, 'src/relay/ca-bundle.ts'),
  // 注释只写文件名不写绝对路径——生成注释进源码树，绝对路径属 Tier1（本机路径）不得入库
  `// 由 sync-envelope.mjs 生成（源：${basename(CA_PATH)}，路径见 CHILL_CA_PATH 约定）\nexport const CA_BASE64 =\n  '${caB64}';\nexport const CA_FP = '${caFP}';\n`,
  'utf8',
);
console.log(`[sync-envelope] envelope.ts 已同步（${envelope.length}B）；CA caFP=${caFP}`);
