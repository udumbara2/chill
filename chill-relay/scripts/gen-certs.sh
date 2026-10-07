#!/usr/bin/env bash
# gen-certs.sh — 【Linux-only，ECS 上执行】生成 chill-relay 生产私有 CA 与服务器证书。
#
# 安全要求（设计文档 v1.1 §4.4）：
# - CA RSA-4096，10–20 年；CA 私钥 aes256 加密落盘，口令进密码管理器，加密私钥离线备份（U 盘）
# - 服务器证书 2 年，SAN 同含 IP（iPAddress 类型）与 DNS
# - 开发期（裸 IP:8443）与备案后（<RELAY_DOMAIN>:8443 + Caddy 喂同 CA 证书）用同一把 CA
#
# 用法：CA_PASS=<ca口令> ./gen-certs.sh <服务器IP> <域名> [输出目录（默认 ./certs）]
#   CA_PASS 可选：设置后非交互执行（openssl -passout/-passin env）；不设置则交互输口令
# 输出：ca.crt / ca.key（aes256 加密）/ server.crt / server.key + CA SPKI 指纹
#
# 应急三行令：
#   CA 丢失 → 新 CA + 全端重配对（接受）
#   CA 泄露 → 立即停服 → 换 CA + 换证书 + 全端重配对 + 复盘泄露源
set -euo pipefail

IP="${1:?usage: gen-certs.sh <ip> <domain> [outdir]}"
DOMAIN="${2:?usage: gen-certs.sh <ip> <domain> [outdir]}"
OUT="${3:-./certs}"
mkdir -p "$OUT"
chmod 700 "$OUT"

echo "== 1/4 生成 CA（RSA-4096，20 年，私钥 aes256 加密——口令进密码管理器）"
if [ -n "${CA_PASS:-}" ]; then
  PASSOUT=(-passout "env:CA_PASS")
  PASSIN=(-passin "env:CA_PASS")
else
  PASSOUT=()
  PASSIN=()
fi
openssl genrsa -aes256 "${PASSOUT[@]}" -out "$OUT/ca.key" 4096
chmod 600 "$OUT/ca.key"
openssl req -x509 -new -key "$OUT/ca.key" "${PASSIN[@]}" -out "$OUT/ca.crt" -days 7300 \
  -subj "/CN=chill-relay-private-ca" -sha256

echo "== 2/4 生成服务器私钥与 CSR"
openssl genrsa -out "$OUT/server.key" 4096
chmod 600 "$OUT/server.key"
openssl req -new -key "$OUT/server.key" -out "$OUT/server.csr" -subj "/CN=chill-relay-server"

echo "== 3/4 签发服务器证书（2 年，SAN 同含 IP:$IP 与 DNS:$DOMAIN）"
cat > "$OUT/san.ext" <<EOF
subjectAltName=IP:$IP,DNS:$DOMAIN
EOF
openssl x509 -req -in "$OUT/server.csr" -CA "$OUT/ca.crt" -CAkey "$OUT/ca.key" "${PASSIN[@]}" \
  -CAcreateserial -out "$OUT/server.crt" -days 730 -sha256 -extfile "$OUT/san.ext"
rm -f "$OUT/server.csr" "$OUT/san.ext" "$OUT/ca.srl"

echo "== 4/4 CA SPKI 指纹（双端 pinning 用；QR caFP 用证书 DER 的 SHA-256）"
openssl x509 -in "$OUT/ca.crt" -pubkey -noout \
  | openssl pkey -pubin -outform der \
  | openssl dgst -sha256
openssl x509 -in "$OUT/ca.crt" -outform der | openssl dgst -sha256
echo "完成。server.key/server.crt 部署到 ECS；ca.key 加密私钥即刻离线备份（U 盘）"
