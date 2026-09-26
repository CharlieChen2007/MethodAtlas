#!/bin/sh
# ── 容器启动脚本 ──
#
# 做三件事，顺序不能换：
#   1) 保证 /data 存在，且**首次启动时**把镜像里自带的演示库复制过去
#      （这样评委点开在线链接就能看到 8 篇论文的完整数据，而不是空库；
#        后续重启不会覆盖 /data 里已有的大库）
#   2) 同步 schema（db push：SQLite 下等价于"缺表就建表"，幂等）
#   3) 起服务
#
# 为什么用 `set -e`：任何一步失败都应该**立刻退出并报错**，
# 而不是带着半截状态硬起服务 —— 那样表现成"页面能开但到处报错"，更难查。
set -e

DATA_DIR="/data"
DB_FILE="$DATA_DIR/dev.db"
# 镜像内自带的演示数据。**故意用单独的文件名**（而不是直接读 prisma/dev.db）：
# `.dockerignore` 里把 `.db` 当作"本地数据"排除掉是常见做法，而这里需要它进镜像；
# 用一个语义明确的名字（seed-demo.db）把"这是要随镜像发布的种子库"和
# "这是开发时随手产生的本地库"区分开，避免以后有人加 `.db` 到 ignore 里时
# 静默把演示数据弄丢（那样上线就是空库，且很难发现）。
SEED_DB="/app/prisma/seed-demo.db"

mkdir -p "$DATA_DIR" /app/storage/papers

if [ ! -f "$DB_FILE" ]; then
  if [ -f "$SEED_DB" ]; then
    echo "[entrypoint] 首次启动：把镜像自带的演示数据复制到 $DB_FILE"
    cp "$SEED_DB" "$DB_FILE"
  else
    echo "[entrypoint] 未找到种子库，将创建空库（需要自行上传论文）"
  fi
else
  echo "[entrypoint] 复用已有数据库 $DB_FILE"
fi

echo "[entrypoint] 同步数据库 schema…"
npx prisma db push --skip-generate --accept-data-loss

echo "[entrypoint] 启动服务（端口 ${PORT:-3000}）"
exec node scripts/run-next.mjs start
