#!/usr/bin/env bash
# 重新生成 tests/fixtures 测试证书（一次性测试 CA，与生产 CA 互不相干）。
# Git Bash / Linux 均可运行。生成物提交进 git。
set -euo pipefail
cd "$(dirname "$0")"
export MSYS2_ARG_CONV_EXCL='*'  # Git Bash 防 /CN= 被路径转换
openssl req -x509 -newkey rsa:2048 -keyout ca.key -out ca.crt -days 3650 -nodes -subj "/CN=chill-relay-test-ca"
openssl req -newkey rsa:2048 -keyout server.key -out server.csr -nodes -subj "/CN=localhost"
printf "subjectAltName=DNS:localhost,IP:127.0.0.1\n" > san.ext
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 3650 -extfile san.ext
openssl req -x509 -newkey rsa:2048 -keyout wrong-ca.key -out wrong-ca.crt -days 3650 -nodes -subj "/CN=wrong-test-ca"
rm -f server.csr san.ext ca.srl
echo "fixtures regenerated"
