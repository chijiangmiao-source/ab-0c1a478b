# verify 容器：node:test 规则测试 + 页面构建检查 + HTTP 冒烟。
# 不依赖 npm 安装：站点为原生 ES 模块，全部检查仅用 Node 内置能力。
FROM node:20-alpine

WORKDIR /work

COPY entrypoint.sh /entrypoint.sh
COPY build-check.mjs /opt/verify/build-check.mjs
COPY http-smoke.mjs /opt/verify/http-smoke.mjs
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
