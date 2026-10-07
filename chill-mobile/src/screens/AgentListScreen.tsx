/**
 * AgentListScreen.tsx — 屏 1：Agent 列表（首屏永远是它，含未配对空态）。
 * 本期一行"我的桌面"（Agent 层 = 信任边界；阶段 B 信任好友预留，未开发不显示占位）。
 * M6b 主路径：点"我的桌面" → 直接进入聊天屏（手机自己的会话上下文 lastChatSessionId /
 * 新会话界面），会话管理收进聊天屏"历史"按钮。
 * 未配对 → 空态引导（"尚未连接桌面" + "去配对"直达配对屏，不绕道设置屏）。
 * 闪念捕获（迭代 2）：header 💡（走路掏手机 2 步直达）——显隐由命令目录有无 'idea' 决定
 * （桌面 managed 布局才注册；npm 模式目录无此行 → 入口不存在而非禁用）。
 */
import React, { useCallback, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { getSyncDb } from '../db/syncDb';
import type { RelaySession } from '../relay/session';

function timeAgo(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const diff = Date.now() - ms;
  if (diff < 60_000) return '刚刚活跃';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前活跃`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前活跃`;
  return `${Math.floor(diff / 86_400_000)} 天前活跃`;
}

export default function AgentListScreen(props: {
  session: RelaySession;
  connected: boolean;
  /** M6c：桌面在线（近期有桌面来信）——绿点=connected && desktopOnline */
  desktopOnline: boolean;
  paired: boolean;
  /** 目录/入口记忆刷新信号（catalog/lastChat 事件序号）：变化即重读副本库摘要 */
  catalogTick: number;
  /** 点"我的桌面"：直达默认聊天屏（lastChat 或新会话界面，路由决策在 App） */
  onOpenChat: () => void;
  onOpenPairing: () => void;
  onOpenSettings: () => void;
}) {
  const { session } = props;
  const [summary, setSummary] = useState<{ projectCount: number; latest: string; lastChatTitle: string }>({
    projectCount: 0,
    latest: '',
    lastChatTitle: '',
  });

  const reload = useCallback(async () => {
    try {
      const db = getSyncDb();
      const agentId = session.getAgentId();
      if (!agentId) return;
      const [sessions, projects] = await Promise.all([db.listSessions(agentId), db.listProjects(agentId)]);
      const lastChatId = session.getLastChatSessionId();
      setSummary({
        projectCount: projects.length,
        latest: sessions[0]?.updatedAt ?? '',
        lastChatTitle: sessions.find((s) => s.sessionId === lastChatId)?.title ?? '',
      });
    } catch {
      /* 副本库不可用时摘要留空 */
    }
  }, [session]);

  // catalogTick 变化（目录落库/入口记忆变化）即重读摘要；首挂载也读一次
  React.useEffect(() => {
    void reload();
  }, [reload, props.catalogTick]);

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>chill</Text>
        <TouchableOpacity onPress={props.onOpenSettings}>
          <Text style={styles.headerLink}>设置</Text>
        </TouchableOpacity>
      </View>
      <TouchableOpacity
        style={styles.agentRow}
        onPress={props.paired ? props.onOpenChat : props.onOpenPairing}
        activeOpacity={0.7}
      >
        <View style={styles.agentIcon}>
          <Text style={styles.agentIconText}>💻</Text>
        </View>
        <View style={styles.agentBody}>
          <View style={styles.agentTitleRow}>
            <Text style={styles.agentName}>我的桌面</Text>
            {/* M6c 绿点不骗人：绿=已连中继且近期有桌面来信；黄=连上中继但桌面未在线；红=本身离线 */}
            <Text style={styles.statusDot}>
              {!props.connected ? '🔴' : props.desktopOnline ? '🟢' : '🟡'}
            </Text>
          </View>
          {props.paired ? (
            <>
              {props.connected && !props.desktopOnline ? (
                <Text style={styles.agentWarn} numberOfLines={1}>
                  桌面未在线 · 消息会暂存，等它开机后送达
                </Text>
              ) : null}
              <Text style={styles.agentSub} numberOfLines={1}>
                {summary.lastChatTitle ? `正在聊：${summary.lastChatTitle}` : '还没聊过——点进来直接说第一句'}
              </Text>
              <Text style={styles.agentSub} numberOfLines={1}>
                {summary.projectCount} 个项目{summary.latest ? ` · ${timeAgo(summary.latest)}` : ''} ›
              </Text>
            </>
          ) : (
            <Text style={styles.agentSub}>尚未连接桌面</Text>
          )}
        </View>
      </TouchableOpacity>
      {!props.paired ? (
        <TouchableOpacity style={styles.pairBtn} onPress={props.onOpenPairing}>
          <Text style={styles.pairBtnText}>去配对（扫桌面二维码）</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0b0f14' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 14,
    marginTop: 36,
  },
  headerTitle: { color: '#fff', fontSize: 20, fontWeight: '700' },
  headerLink: { color: '#9aa4b2', fontSize: 15 },
  agentRow: {
    flexDirection: 'row',
    marginHorizontal: 14,
    marginTop: 10,
    padding: 14,
    backgroundColor: '#151b24',
    borderRadius: 12,
    gap: 12,
  },
  agentIcon: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: '#1f2937',
    alignItems: 'center',
    justifyContent: 'center',
  },
  agentIconText: { fontSize: 22 },
  agentBody: { flex: 1, justifyContent: 'center', gap: 2 },
  agentTitleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  agentName: { color: '#fff', fontSize: 16, fontWeight: '600' },
  statusDot: { fontSize: 12 },
  agentWarn: { color: '#fbbf24', fontSize: 12 },
  agentSub: { color: '#9aa4b2', fontSize: 12 },
  pairBtn: {
    marginHorizontal: 14,
    marginTop: 16,
    backgroundColor: '#3b82f6',
    borderRadius: 10,
    padding: 12,
    alignItems: 'center',
  },
  pairBtnText: { color: '#fff', fontWeight: '600' },
});
