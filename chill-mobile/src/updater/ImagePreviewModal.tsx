/**
 * ImagePreviewModal.tsx — shot 链接的 App 内全屏预览（经同一下载原语取本地再显示——
 * Fresco 不走证书固定的 client，外链图会失败；本地 file:// 无此问题）。零警告零跳转。
 */
import React, { useEffect, useState } from 'react';
import { Image, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { fetchShotToCache } from './updater';

export function ImagePreviewModal({ url, onClose }: { url: string | null; onClose: () => void }) {
  const [localPath, setLocalPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!url) return;
    setLocalPath(null);
    setError(null);
    let alive = true;
    void fetchShotToCache(url)
      .then((p) => {
        if (alive) setLocalPath(p);
      })
      .catch(() => {
        if (alive) setError('图片加载失败');
      });
    return () => {
      alive = false;
    };
  }, [url]);

  return (
    <Modal visible={!!url} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <View style={styles.center}>
          {localPath && <Image source={{ uri: 'file://' + localPath }} style={styles.img} resizeMode="contain" />}
          {!localPath && !error && <Text style={styles.meta}>加载中…</Text>}
          {error && <Text style={styles.meta}>{error}</Text>}
          <Text style={styles.hint}>点任意处关闭</Text>
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  img: { width: '100%', height: '85%' },
  meta: { color: '#9ca3af' },
  hint: { color: '#6b7280', fontSize: 12, marginTop: 12 },
});
