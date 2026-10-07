/**
 * PairingScreen.tsx — 扫码配对屏（vision-camera V5 + ML Kit barcode-scanner 插件）。
 * 注：V5 的 Object Output 仅 iOS 有（Android 端 createObjectOutput 显式抛错）；
 * V4 的 codeScanner 在 RN 0.87 bridgeless 下拿不到 legacy getConstants（模块为空）。
 * 因此 Android 上走官方 ML Kit 插件路径（Margelo 2026 指南的推荐做法）。
 * 流程：扫 QR JSON → caFP 校验 → 显示对端设备名确认 → redeem → hello/confirm → 完成。
 * 409 全屏错误 / 410 提示重扫 / orphan-revoked 提示 / error 展示，由父组件按 state 渲染分支。
 */
import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { Camera, useCameraPermission } from 'react-native-vision-camera';
import { useBarcodeScannerOutput } from 'react-native-vision-camera-barcode-scanner';

export default function PairingScreen(props: {
  onQr: (qrJson: string) => void;
  statusText: string;
  /** M6b：push 路由模式——返回按钮（外层全屏态时缺省不显示） */
  onBack?: () => void;
}) {
  const { hasPermission, requestPermission } = useCameraPermission();
  const [paste, setPaste] = useState('');
  const [scanned, setScanned] = useState(false);

  const scannerOutput = useBarcodeScannerOutput({
    barcodeFormats: ['qr-code'],
    // 屏幕上的终端二维码密度高，preview 分辨率可能采样不足 → 用全分辨率缓冲
    outputResolution: 'full',
    onBarcodeScanned: (barcodes) => {
      if (scanned) return;
      const v = barcodes[0]?.rawValue;
      if (v) {
        setScanned(true);
        props.onQr(v);
      }
    },
    onError: () => {},
  });

  return (
    <View style={styles.root}>
      <View style={styles.titleRow}>
        {props.onBack ? (
          <TouchableOpacity onPress={props.onBack}>
            <Text style={styles.backLink}>‹</Text>
          </TouchableOpacity>
        ) : null}
        <Text style={styles.title}>扫码配对</Text>
      </View>
      <Text style={styles.desc}>扫描桌面端 chill 的配对二维码（配对令牌一次性，10 分钟有效）</Text>
      <View style={styles.cameraBox}>
        {hasPermission ? (
          <Camera
            style={styles.camera}
            device="back"
            isActive={!scanned}
            outputs={[scannerOutput]}
          />
        ) : (
          <TouchableOpacity
            style={styles.permBtn}
            onPress={() => {
              void requestPermission().then((ok) => {
                if (!ok) Alert.alert('相机权限被拒', '可用下方粘贴框手动配对');
              });
            }}
          >
            <Text style={styles.permText}>点这里授予相机权限</Text>
          </TouchableOpacity>
        )}
      </View>
      <Text style={styles.status}>{props.statusText}</Text>
      <Text style={styles.desc}>联调/无相机回退：粘贴 QR JSON 文本</Text>
      <TextInput
        style={styles.paste}
        multiline
        placeholder='{"v":1,"relay":"wss://…",…}'
        placeholderTextColor="#666"
        value={paste}
        onChangeText={setPaste}
      />
      <TouchableOpacity style={styles.btn} onPress={() => paste.trim() && props.onQr(paste.trim())}>
        <Text style={styles.btnText}>粘贴配对</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0b0f14', padding: 20 },
  titleRow: { flexDirection: 'row', alignItems: 'center', marginTop: 40, gap: 8 },
  backLink: { color: '#3b82f6', fontSize: 28, paddingHorizontal: 4 },
  title: { color: '#fff', fontSize: 22, fontWeight: '600' },
  desc: { color: '#9aa4b2', fontSize: 13, marginTop: 8 },
  cameraBox: { height: 260, marginTop: 16, borderRadius: 12, overflow: 'hidden', backgroundColor: '#151b24' },
  camera: { flex: 1 },
  permBtn: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  permText: { color: '#3b82f6' },
  status: { color: '#f59e0b', fontSize: 13, marginTop: 12, minHeight: 18 },
  paste: { backgroundColor: '#151b24', color: '#fff', borderRadius: 8, minHeight: 70, marginTop: 8, padding: 8, fontSize: 12 },
  btn: { backgroundColor: '#3b82f6', borderRadius: 8, padding: 12, alignItems: 'center', marginTop: 12 },
  btnText: { color: '#fff', fontWeight: '600' },
});
