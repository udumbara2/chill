/**
 * UpdateOverlay.tsx — 更新浮层（挂 App 根——更新发现是 App 级关切，任何屏可见；从 updater 单例恢复）。
 * 相位对应：available=发现新版卡（立即安装/稍后）；downloading=进度/取消；metered-confirm=流量确认；
 * downgrade-confirm=回退确认卡（显式"回退安装" + 迁移不可逆警示）；failed=可读原因/重试；done="重启 App 生效"。
 */
import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { updater, type UpdateState } from './updater';

const ERROR_TEXT: Record<string, string> = {
  canceled: '已取消',
  'not-our-package': '非本应用更新包，已拒绝安装',
  'need-install-permission': '需要"安装未知应用"授权（已为您跳设置页，回来点重试）',
  'install-failed': '系统安装失败',
  'length-mismatch': '下载校验失败（文件损坏）',
  'checksum-mismatch': '完整性校验失败（清单哈希不符）',
};

function errorText(e: string | null): string {
  if (!e) return '';
  // install-failed:<系统原始原因> —— PackageInstaller EXTRA_STATUS_MESSAGE 透出的真实拒绝原因
  if (e.startsWith('install-failed:')) return `系统安装失败：${e.slice('install-failed:'.length)}`;
  return ERROR_TEXT[e] ?? `失败：${e}`;
}

export function UpdateOverlay() {
  const [s, setS] = useState<UpdateState>(updater.getState());
  useEffect(() => updater.subscribe(setS), []);

  if (s.phase === 'idle' || s.phase === 'busy' || s.phase === 'ready' || s.phase === 'installing') {
    return null; // ready/installing 由系统页接管；busy 由调用方提示
  }

  const pct =
    s.totalBytes > 0 ? Math.min(100, Math.round((s.receivedBytes / s.totalBytes) * 100)) : 0;
  const mb = (n: number) => (n / 1024 / 1024).toFixed(1);

  return (
    <View style={styles.wrap}>
      {s.phase === 'available' && (
        <>
          <Text style={styles.title}>发现新版本 {s.snapshot ?? ''}</Text>
          <Text style={styles.meta}>
            {s.preloaded === true ? '已就绪，点按即装' : s.notes ? s.notes : '点"立即安装"下载并安装'}
          </Text>
          <View style={styles.row}>
            <Pressable onPress={() => updater.dismiss()} style={styles.btn}>
              <Text style={styles.btnText}>稍后</Text>
            </Pressable>
            <Pressable
              onPress={() => void updater.confirmInstall()}
              style={[styles.btn, styles.btnPrimary]}>
              <Text style={styles.btnText}>立即安装</Text>
            </Pressable>
          </View>
        </>
      )}
      {s.phase === 'downloading' && (
        <>
          <Text style={styles.title}>正在下载更新…</Text>
          <View style={styles.barTrack}>
            <View style={[styles.barFill, { width: `${pct}%` }]} />
          </View>
          <Text style={styles.meta}>
            {s.totalBytes > 0 ? `${mb(s.receivedBytes)} / ${mb(s.totalBytes)} MB` : `${mb(s.receivedBytes)} MB`}
          </Text>
          <Pressable onPress={() => updater.cancel()} style={styles.btn}>
            <Text style={styles.btnText}>取消</Text>
          </Pressable>
        </>
      )}
      {s.phase === 'metered-confirm' && (
        <>
          <Text style={styles.title}>当前是计量网络（蜂窝）</Text>
          <Text style={styles.meta}>下载更新包将消耗流量，继续吗？</Text>
          <View style={styles.row}>
            <Pressable onPress={() => updater.cancel()} style={styles.btn}>
              <Text style={styles.btnText}>取消</Text>
            </Pressable>
            <Pressable
              onPress={() => void updater.confirmProceed(s.url ?? '')}
              style={[styles.btn, styles.btnPrimary]}>
              <Text style={styles.btnText}>继续下载</Text>
            </Pressable>
          </View>
        </>
      )}
      {s.phase === 'downgrade-confirm' && (
        <>
          <Text style={styles.title}>这是一个较旧的版本（回退安装）</Text>
          <Text style={styles.warn}>数据库迁移可能不可逆——回退后旧代码可能无法正确读取新数据。确定要回退？</Text>
          <View style={styles.row}>
            <Pressable onPress={() => updater.reset()} style={styles.btn}>
              <Text style={styles.btnText}>取消</Text>
            </Pressable>
            <Pressable
              onPress={() => void updater.confirmProceed(s.url ?? '')}
              style={[styles.btn, styles.btnDanger]}>
              <Text style={styles.btnText}>回退安装</Text>
            </Pressable>
          </View>
        </>
      )}
      {s.phase === 'failed' && (
        <>
          <Text style={styles.title}>更新未完成</Text>
          <Text style={styles.warn}>{errorText(s.error)}</Text>
          <View style={styles.row}>
            <Pressable onPress={() => updater.reset()} style={styles.btn}>
              <Text style={styles.btnText}>关闭</Text>
            </Pressable>
            <Pressable onPress={() => updater.retry()} style={[styles.btn, styles.btnPrimary]}>
              <Text style={styles.btnText}>重试</Text>
            </Pressable>
          </View>
        </>
      )}
      {s.phase === 'done' && (
        <>
          <Text style={styles.title}>更新已安装</Text>
          <Text style={styles.meta}>重启 App 后生效</Text>
          <Pressable onPress={() => updater.reset()} style={styles.btn}>
            <Text style={styles.btnText}>知道了</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 84,
    backgroundColor: '#1f2937',
    borderRadius: 12,
    padding: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#374151',
  },
  title: { color: '#f9fafb', fontWeight: '700', marginBottom: 6 },
  meta: { color: '#9ca3af', fontSize: 12, marginBottom: 8 },
  warn: { color: '#fbbf24', fontSize: 12.5, lineHeight: 18, marginBottom: 8 },
  barTrack: { height: 4, backgroundColor: '#374151', borderRadius: 2, overflow: 'hidden' },
  barFill: { height: 4, backgroundColor: '#3b82f6' },
  row: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  btn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, backgroundColor: '#374151' },
  btnPrimary: { backgroundColor: '#2563eb' },
  btnDanger: { backgroundColor: '#b45309' },
  btnText: { color: '#f9fafb', fontWeight: '600' },
});
