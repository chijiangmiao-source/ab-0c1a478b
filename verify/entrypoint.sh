#!/bin/sh
# verify 入口：规则测试 -> 页面构建检查 -> HTTP 冒烟。任一失败即以非零退出码交付结论。
# 在容器内 /work 与本地仓库根均可运行（CODE_DIR 默认 /work）。
set -eu

CODE_DIR="${CODE_DIR:-/work}"
VERIFY_DIR="${VERIFY_DIR:-$CODE_DIR/verify}"
[ -d "$VERIFY_DIR" ] || VERIFY_DIR=/opt/verify

echo "== [1/3] 规则测试（node:test） =="
node --test "$CODE_DIR"/test/*.test.mjs

echo
echo "== [2/3] 页面构建检查（语法 / 引用完整 / 核心模块可导入） =="
node "$VERIFY_DIR/build-check.mjs" "$CODE_DIR/site"

echo
echo "== [3/3] HTTP 冒烟（静态站点 + /health） =="
SITE_URL="${SITE_URL:-http://site}" node "$VERIFY_DIR/http-smoke.mjs"

echo
echo "ALL VERIFY CHECKS PASSED"
