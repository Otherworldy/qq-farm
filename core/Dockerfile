# 基础镜像可通过 build arg 覆盖，便于切换国内加速源或本地已有镜像：
#   docker compose build --build-arg NODE_IMAGE=node:20-alpine
ARG NODE_IMAGE=docker.1ms.run/library/node:20-alpine

# ==========================================
# core 生产依赖
# ==========================================
FROM ${NODE_IMAGE} AS prod-deps

WORKDIR /app

ENV COREPACK_NPM_REGISTRY=https://registry.npmmirror.com
ENV npm_config_registry=https://registry.npmmirror.com

RUN corepack enable

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY core/package.json ./core/
COPY web/package.json ./web/

RUN pnpm -C core install --prod --frozen-lockfile

# ==========================================
# 运行镜像
#
# 前端产物走本地构建：仓库不追踪 web/dist（见 .gitignore），
# 构建前请先在本机执行 `pnpm build:web`，compose 会把该目录
# 作为构建上下文的一部分复制进来，容器内不再安装前端依赖或跑 vite。
# ==========================================
FROM ${NODE_IMAGE} AS runner

WORKDIR /app/core

ENV NODE_ENV=production
ENV TZ=Asia/Shanghai

RUN apk add --no-cache tzdata && \
    cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo "Asia/Shanghai" > /etc/timezone && \
    apk del tzdata

COPY --from=prod-deps /app/node_modules ../node_modules/
COPY --from=prod-deps /app/core/node_modules ./node_modules/
COPY --from=prod-deps /app/package.json ../package.json

COPY core ./
COPY web/dist ../web/dist

# 前端产物缺失时给出可执行的提示，而不是让面板 404。
RUN test -f ../web/dist/index.html || ( \
        echo "error: ../web/dist/index.html 不存在。请先在仓库根目录执行 pnpm build:web 后再构建镜像。" >&2; \
        exit 1)

RUN mkdir -p data/logs && chmod -R 755 data

VOLUME ["/app/core/data"]

EXPOSE 3007

# 探活不能写 localhost：容器内 localhost 优先解到 IPv6 ::1，而服务只监听
# 0.0.0.0（IPv4），会直接 Connection refused 变成永假 unhealthy。
# 也不能探 /api/status：那个端点要认证，401 会被 wget --spider 判失败。
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD wget -q --spider http://127.0.0.1:3007/ || exit 1

CMD ["node", "client.js"]
