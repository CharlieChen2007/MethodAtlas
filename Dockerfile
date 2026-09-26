# ── MethodAtlas 生产镜像 ──
#
# 为什么给 Dockerfile：
#   这个项目用 **SQLite 单文件**做数据库，而 Vercel 那类无状态 Serverless
#   平台的磁盘是临时的 —— 写进去的数据下次请求就没了。评委点开一看是空库。
#   所以在线部署要选**带持久磁盘**的容器型平台（Railway / Render / Fly /
#   自己的云主机都行），而它们都吃 Dockerfile。
#
# 构建（在项目根，即含 package.json 的那一层）：
#   docker build -t methodatlas .
# 运行：
#   docker run -p 3000:3000 \
#     -e DATABASE_URL="file:/data/dev.db" \
#     -e LLM_PROVIDER=mock \
#     -v methodatlas-data:/data \
#     methodatlas
#
# 说明：镜像里**自带演示数据**（prisma/seed-demo.db，8 篇论文的完整流水线结果）。
#       首次启动时若 /data/dev.db 不存在，entrypoint 会从镜像内的种子库复制一份，
#       所以评委点开就能看到内容，不需要现场跑 20 分钟的抽取流程。

FROM node:22-bookworm-slim AS base
# openssl 是 Prisma 引擎在 slim 镜像上的运行依赖，不装会在启动时报引擎加载失败
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ── 依赖层（独立出来，改代码时可复用缓存）──
FROM base AS deps
COPY package.json package-lock.json ./
# npm ci 需要 lock 文件且要求两者一致；本仓库两者都在
RUN npm ci --no-audit --no-fund

# ── 构建层 ──
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# 构建期 Prisma 需要一个 DATABASE_URL，但它不连库（只生成 client），给个占位值即可
ENV DATABASE_URL="file:/data/dev.db"
RUN npx prisma generate && npm run build

# ── 运行层 ──
FROM base AS runner
ENV NODE_ENV=production
# 注意端口用 3000；多数平台会通过 PORT 覆盖，run-next.mjs 会读它
ENV PORT=3000

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json ./package-lock.json
COPY --from=builder /app/next.config.mjs ./next.config.mjs
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/src ./src
COPY --from=builder /app/public ./public
COPY --from=builder /app/storage ./storage
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

# SQLite + 上传的 PDF 要落在这两个位置；平台把这俩挂成持久卷
VOLUME ["/data"]
EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
