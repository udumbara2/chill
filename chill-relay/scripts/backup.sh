#!/usr/bin/env bash
# backup.sh — 【Linux-only】只备 mailboxes 表（systemd timer 每日，保留 14 天）。
#
# 依据设计文档 v1.1 §4.6：
# - messages 是"ACK 即删"的过手密文，备份它会戳破盲中继的合规叙事 → 不备
# - pair_tokens 不备（崩溃窗口内进行中配对丢失可接受，用户重试即可）
# - 恢复 runbook：恢复备份后全量信箱视为可疑 → 阶段 A 直接全量重配对（防已 revoke 信箱复活）
#
# 用法：./backup.sh [DB 路径（默认 /opt/chill-relay/relay.db）] [备份目录（默认 /var/backups/chill-relay）]
set -euo pipefail

DB="${1:-/opt/chill-relay/relay.db}"
DEST="${2:-/var/backups/chill-relay}"
mkdir -p "$DEST"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$DEST/mailboxes-$TS.sql.gz"

# WAL 下 .dump 走在线一致性读；只 dump mailboxes 一张表
sqlite3 "$DB" ".dump mailboxes" | gzip -9 > "$OUT"
chmod 600 "$OUT"

# 保留 14 天
find "$DEST" -name 'mailboxes-*.sql.gz' -mtime +14 -delete
echo "backup: $OUT ($(stat -c%s "$OUT") bytes)"
