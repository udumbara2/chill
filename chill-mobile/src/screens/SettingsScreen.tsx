/**
 * SettingsScreen.tsx — 设置屏（终端用户视角）。
 *
 * 只回答用户的两个问题：连接现在怎么样？要不要做点什么？
 * 纪律：文案只允许出现「手机上的 chill / 电脑上的 chill / 连接」三个概念——
 * 中继、信箱、令牌、前台服务、保活、对端、pairingMAC 等实现词一律不上屏。
 * 状态一律用「一句话」回答（内部状态机在本文件内翻译，不外泄枚举值）；
 * 一次性的后台设置默认折叠，只在用户点开时展开。
 */
import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, Switch, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import type { SessionState } from '../relay/session';
import { loadPhoneState } from '../relay/storage';
import { BUILD_STAMP } from '../updater/buildStamp';

interface LinkView {
  dot: string;
  title: string;
  lines: string[];
}

/** 内部配对状态机 → 用户能读懂的一句话（翻译层，不改变任何引擎状态） */
function resolveLink(
  state: SessionState,
  peerName: string,
  connected: boolean,
  desktopOnline: boolean,
): LinkView {
  if (state === 'paired') {
    if (!connected) {
      return { dot: '🔴', title: peerName, lines: ['手机没有网络', '恢复网络后会自动重连'] };
    }
    if (!desktopOnline) {
      return { dot: '🟡', title: peerName, lines: ['电脑当前不在线', '消息会先存着，等电脑开机后送达'] };
    }
    return { dot: '🟢', title: peerName, lines: ['已连接 · 消息可以即时送达'] };
  }
  if (state === 'redeeming' || state === 'waiting-confirm') {
    return { dot: '⏳', title: '正在与电脑建立连接…', lines: [] };
  }
  return {
    dot: '⚪',
    title: '还没连接电脑',
    lines: ['在电脑上打开 chill，用手机扫它的二维码就能连上'],
  };
}

const KEEPALIVE_STEPS = [
  '允许 chill 自启动、后台运行',
  '电池优化里给 chill 开绿灯',
  '在最近任务里给 chill 加锁',
  '允许通知',
];

/** 更新检查结果码 → 一句用户可读的话（发现环诊断行的翻译层，纯字典不含判定） */
function describeUpdateStatus(s: string | undefined): string {
  if (!s) return '';
  if (s.startsWith('found:')) return `发现新版本 ${s.slice(6)}`;
  if (s === 'up-to-date') return '已是最新';
  if (s === 'bad-manifest') return '更新信息无法识别';
  if (s === 'network-error') return '网络不通，下次打开自动重试';
  if (s.startsWith('http-')) return `检查失败（${s.slice(5)}）`;
  return '';
}

export default function SettingsScreen(props: {
  peerName: string;
  state: SessionState;
  connected: boolean;
  desktopOnline: boolean;
  /** 已配对：换一台电脑，扫码重配 */
  onRePair: () => void;
  /** 未配对：去扫码连接 */
  onPair: () => void;
  /** 解除配对（确认框在本屏，执行由调用方负责） */
  onResetPairing: () => void;
  /** 记点子功能可用（桌面已开自迭代）——false 时开关行整行隐藏（非置灰） */
  ideaBallAvailable: boolean;
  /** 悬浮球当前可见性（开关值） */
  ideaBallVisible: boolean;
  /** 悬浮球开关（持久化由调用方负责） */
  onToggleIdeaBall: (visible: boolean) => void;
  onBack: () => void;
}) {
  const [tipsOpen, setTipsOpen] = useState(false);
  /** 版本诊断行（当前版本 + 上次更新检查结果；更新发现是静默失败面，这里一行看出断在哪环） */
  const [verLine, setVerLine] = useState<string | null>(null);
  useEffect(() => {
    let on = true;
    loadPhoneState()
      .then((st) => {
        if (!on || !st) return; // 未配对无状态 → 不显示
        const stamp = BUILD_STAMP === 'unknown' ? '开发版' : BUILD_STAMP;
        if (!st.lastUpdateCheckAt) {
          setVerLine(`当前版本 ${stamp} · 尚未检查更新`);
          return;
        }
        const d = new Date(st.lastUpdateCheckAt);
        const p2 = (n: number) => String(n).padStart(2, '0');
        const t = `${d.getMonth() + 1}/${d.getDate()} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
        const desc = describeUpdateStatus(st.lastUpdateStatus);
        setVerLine(`当前版本 ${stamp} · 上次检查 ${t}${desc ? ` · ${desc}` : ''}`);
      })
      .catch(() => {});
    return () => {
      on = false;
    };
  }, []);
  const link = resolveLink(props.state, props.peerName, props.connected, props.desktopOnline);
  const paired = props.state === 'paired';
  const linking = props.state === 'redeeming' || props.state === 'waiting-confirm';

  const confirmUnpair = () => {
    Alert.alert(
      '解除配对？',
      '将断开与这台电脑的连接，并清除本机保存的聊天记录副本。之后需要重新扫码才能连接。',
      [
        { text: '取消', style: 'cancel' },
        { text: '解除配对', style: 'destructive', onPress: props.onResetPairing },
      ],
    );
  };

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Text style={styles.title}>设置</Text>
        <TouchableOpacity onPress={props.onBack}>
          <Text style={styles.link}>返回</Text>
        </TouchableOpacity>
      </View>

      {/* 连接卡：状态 + 能做的事 */}
      <View style={styles.card}>
        <View style={styles.cardTop}>
          <Text style={styles.dot}>{link.dot}</Text>
          <Text style={styles.cardTitle} numberOfLines={1}>
            {link.title}
          </Text>
        </View>
        {link.lines.map((t) => (
          <Text key={t} style={styles.cardLine}>
            {t}
          </Text>
        ))}

        {paired ? (
          <View style={styles.btnRow}>
            <TouchableOpacity style={styles.btnGhost} onPress={props.onRePair}>
              <Text style={styles.btnGhostText}>重新配对</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.btnGhost} onPress={confirmUnpair}>
              <Text style={styles.btnDangerText}>解除配对</Text>
            </TouchableOpacity>
          </View>
        ) : linking ? null : (
          <View style={styles.btnRow}>
            <TouchableOpacity style={styles.btnPrimary} onPress={props.onPair}>
              <Text style={styles.btnPrimaryText}>去配对</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      {/* 版本卡（一行诊断：更新发现静默失败时，从这里看出断在哪一环） */}
      {verLine !== null ? (
        <View style={styles.verCard}>
          <Text style={styles.verText}>{verLine}</Text>
        </View>
      ) : null}

      {/* 记点子悬浮球开关（桌面开自迭代才有——available=false 整行隐藏） */}
      {props.ideaBallAvailable ? (
        <View style={styles.card}>
          <View style={styles.switchRow}>
            <View style={styles.switchTextCol}>
              <Text style={styles.cardTitle}>💡 记点子悬浮球</Text>
              <Text style={styles.cardLine}>任意界面一键记录改进点子，可拖动调整位置</Text>
            </View>
            <Switch
              value={props.ideaBallVisible}
              onValueChange={props.onToggleIdeaBall}
              trackColor={{ false: '#374151', true: '#3b82f6' }}
              thumbColor="#fff"
            />
          </View>
        </View>
      ) : null}

      {/* 后台设置：一次性任务，默认折叠 */}
      {paired ? (
        <View style={styles.tips}>
          <TouchableOpacity style={styles.tipsHead} onPress={() => setTipsOpen((v) => !v)}>
            <Text style={styles.tipsTitle}>让消息不漏</Text>
            <Text style={styles.tipsMeta}>后台设置 {tipsOpen ? '▾' : '▸'}</Text>
          </TouchableOpacity>
          {tipsOpen ? (
            <View style={styles.tipsBody}>
              <Text style={styles.tipsIntro}>部分手机会在后台断开连接。设置一次，以后消息就不会漏：</Text>
              {KEEPALIVE_STEPS.map((t, i) => (
                <View key={t} style={styles.stepRow}>
                  <Text style={styles.stepNo}>{i + 1}</Text>
                  <Text style={styles.stepText}>{t}</Text>
                </View>
              ))}
              <Text style={styles.tipsNote}>
                小提示：手机管家"一键清理"可能断开连接；重新打开 chill 后消息会自动补上，不会丢。
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0b0f14' },
  content: { padding: 20, paddingBottom: 40 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 36 },
  title: { color: '#fff', fontSize: 22, fontWeight: '600' },
  link: { color: '#3b82f6', fontSize: 15 },

  card: { backgroundColor: '#151b24', borderRadius: 14, padding: 16, marginTop: 24 },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dot: { fontSize: 16 },
  cardTitle: { color: '#fff', fontSize: 17, fontWeight: '600', flex: 1 },
  cardLine: { color: '#9aa4b2', fontSize: 13, marginTop: 6, lineHeight: 19 },

  btnRow: { flexDirection: 'row', gap: 10, marginTop: 16 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  switchTextCol: { flex: 1 },
  btnGhost: {
    flex: 1,
    borderColor: '#2b3646',
    borderWidth: 1,
    borderRadius: 9,
    paddingVertical: 11,
    alignItems: 'center',
  },
  btnGhostText: { color: '#e5e7eb', fontSize: 14 },
  btnDangerText: { color: '#ef4444', fontSize: 14 },
  btnPrimary: { flex: 1, backgroundColor: '#3b82f6', borderRadius: 9, paddingVertical: 11, alignItems: 'center' },
  btnPrimaryText: { color: '#fff', fontSize: 14, fontWeight: '600' },

  verCard: { backgroundColor: '#151b24', borderRadius: 12, padding: 14, marginTop: 22 },
  verText: { color: '#6b7280', fontSize: 12, lineHeight: 18 },

  tips: { marginTop: 22 },
  tipsHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12 },
  tipsTitle: { color: '#e5e7eb', fontSize: 15 },
  tipsMeta: { color: '#9aa4b2', fontSize: 13 },
  tipsBody: { backgroundColor: '#151b24', borderRadius: 12, padding: 14 },
  tipsIntro: { color: '#9aa4b2', fontSize: 13, lineHeight: 20 },
  stepRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12 },
  stepNo: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#1f2937',
    color: '#93c5fd',
    fontSize: 12,
    lineHeight: 20,
    textAlign: 'center',
    overflow: 'hidden',
  },
  stepText: { color: '#d1d5db', fontSize: 14, flex: 1 },
  tipsNote: { color: '#6b7280', fontSize: 12, lineHeight: 18, marginTop: 14 },
});
