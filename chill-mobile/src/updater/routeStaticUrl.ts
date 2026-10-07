/**
 * routeStaticUrl.ts — 中继 static 产物链接的路由判定（纯函数，零依赖）。
 *
 * 第一性定案 5（URL 白名单防钓鱼）：只有本会话配对落定的中继地址（PhoneState.relay，
 * storage.ts 的 loadPhoneState——零 session.ts 改动）下 /static/apk/、/static/shots/
 * 前缀的链接才走 App 内通道；其余一律 external（照旧 Linking.openURL，保持诚实语义）。
 *
 * 归一化纪律：origin 经 URL 解析后比较（尾斜杠/默认端口/userinfo 变体全覆盖——
 * userinfo 例 https://evil@host/ 的 host 解析正确性由 URL 实现保证，入 jest 钉死）。
 */

export type StaticRoute = { kind: 'apk'; url: string } | { kind: 'shot'; url: string } | { kind: 'external'; url: string };

/** origin 归一化：URL 解析后取 protocol//host:port（默认端口消隐、尾斜杠消隐、userinfo 剥离） */
function normalizeOrigin(u: string): string | null {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
}

export function routeStaticUrl(rawUrl: string, relay: string | null | undefined): StaticRoute {
  const url = String(rawUrl ?? '');
  const fallback: StaticRoute = { kind: 'external', url };
  if (!relay) return fallback;
  const target = normalizeOrigin(url);
  const trusted = normalizeOrigin(relay);
  if (!target || !trusted || target !== trusted) return fallback;
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return fallback;
  }
  // 路径穿越/编码绕过：URL.pathname 已解码语义值；二次拒绝含 .. 的任何形态
  if (pathname.includes('..')) return fallback;
  if (pathname.startsWith('/static/apk/')) return { kind: 'apk', url };
  if (pathname.startsWith('/static/shots/')) return { kind: 'shot', url };
  return fallback;
}
