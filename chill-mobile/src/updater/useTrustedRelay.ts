/**
 * useTrustedRelay.ts — 白名单锚点：本会话配对落定的中继地址（PhoneState.relay）。
 * 数据源 = storage.ts 的 loadPhoneState（零 session.ts 改动）；未配对/读取失败 = null
 * （路由判定 fail-closed：一切链接走 external 原语义）。
 */
import { useEffect, useState } from 'react';
import { loadPhoneState } from '../relay/storage';

export function useTrustedRelay(): string | null {
  const [relay, setRelay] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void loadPhoneState().then((s) => {
      if (alive) setRelay(s?.relay ?? null);
    });
    return () => {
      alive = false;
    };
  }, []);
  return relay;
}
