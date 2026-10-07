// keychain 文件桩（e2e harness 专用；持久化到 scripts/e2e-harness/.keystore.json 以支持跨进程 resume）
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '.keystore.json');

function load(): Record<string, string> {
  try {
    if (existsSync(FILE)) return JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, string>;
  } catch {
    /* 损坏视为空 */
  }
  return {};
}
function save(m: Record<string, string>): void {
  writeFileSync(FILE, JSON.stringify(m), 'utf8');
}

export async function setGenericPassword(_u: string, password: string, opts?: { service?: string }) {
  const m = load();
  m[opts?.service ?? 'default'] = password;
  save(m);
  return { service: opts?.service ?? 'default' };
}
export async function getGenericPassword(opts?: { service?: string }) {
  const v = load()[opts?.service ?? 'default'];
  return v === undefined ? false : { username: 'chill', password: v, service: opts?.service ?? 'default' };
}
export async function resetGenericPassword(opts?: { service?: string }) {
  const m = load();
  const existed = opts?.service ?? 'default' in m;
  delete m[opts?.service ?? 'default'];
  save(m);
  return existed;
}
