/**
 * deliverFile.ts — d→m 收件交付薄封装（原生 MediaStoreModule 调用 + 失败分类）。
 *
 * Android：MediaStore.Downloads（API 29+ 写自建条目零权限；RELATIVE_PATH="Download/chill/"）。
 * API<29 原生侧诚实 reject unsupported_api——不做 FileProvider 兜底链（为十年前系统背复杂度不值）。
 * iOS：不实现（项目不构建 iOS）——未来路径 = 解密落私有目录 + RN Share.share({url}) 交系统分享面板。
 *
 * 失败分类纪律：拉取层（mediaFetcher）的错误枚举是 expired/corrupt/io/aborted；
 * 交付层失败一律归 io（落盘失败含存储不足），unsupported_api 单独成类供卡片诚实文案。
 */
import { NativeModules, Platform } from 'react-native';

interface MediaStoreNativeModule {
  saveToDownloads(srcPath: string, displayName: string, mime: string): Promise<string>;
  openFile(uri: string, mime: string): Promise<void>;
}

function nativeModule(): MediaStoreNativeModule | null {
  if (Platform.OS !== 'android') return null;
  const m = (NativeModules as Record<string, unknown>)['MediaStoreModule'] as MediaStoreNativeModule | undefined;
  return m ?? null;
}

export type DeliverOutcome =
  | { ok: true; contentUri: string }
  | { ok: false; error: 'io' | 'unsupported_api'; detail: string };

/** 暂存明文 → 系统下载目录（Download/chill/）；DISPLAY_NAME 冲突原生侧自动改名 "name (1).ext"（不覆盖既有文件） */
export async function deliverToDownloads(srcPath: string, displayName: string, mime: string): Promise<DeliverOutcome> {
  const m = nativeModule();
  if (!m) return { ok: false, error: 'unsupported_api', detail: '当前平台不支持保存到下载目录' };
  try {
    const contentUri = await m.saveToDownloads(srcPath, displayName, mime);
    return { ok: true, contentUri };
  } catch (e) {
    const code = (e as { code?: string } | null)?.code ?? '';
    if (code === 'unsupported_api') {
      return { ok: false, error: 'unsupported_api', detail: '系统版本过低（Android 10 以下），无法保存到下载目录' };
    }
    return { ok: false, error: 'io', detail: e instanceof Error ? e.message : String(e) };
  }
}

export type OpenOutcome = { ok: true } | { ok: false; error: 'no_handler' | 'gone' | 'io'; detail: string };

/** [打开]：ACTION_VIEW 系统分发；无应用可开 → no_handler；文件已被用户删掉 → gone（不闪退） */
export async function openDeliveredFile(uri: string, mime: string): Promise<OpenOutcome> {
  const m = nativeModule();
  if (!m) return { ok: false, error: 'io', detail: '当前平台不支持打开已保存文件' };
  try {
    await m.openFile(uri, mime);
    return { ok: true };
  } catch (e) {
    const code = (e as { code?: string } | null)?.code ?? '';
    if (code === 'no_handler') return { ok: false, error: 'no_handler', detail: '没有能打开此类型文件的应用' };
    if (code === 'gone') return { ok: false, error: 'gone', detail: '文件已不在下载目录（可能已被删除）' };
    return { ok: false, error: 'io', detail: e instanceof Error ? e.message : String(e) };
  }
}
