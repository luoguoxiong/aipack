# syntax=docker/dockerfile:1
# aipack Observability Server 容器镜像（P2-3 部署运维）。
#
# 构建上下文为仓库根目录（需要 pnpm workspace + @aipack/observability 源码）：
#   docker build -f packages/observability-server/Dockerfile -t aipack/observability-server .
#
# 运行示例（数据落卷 /data，SESSION_SECRET 保证面板 token 重启不失效）：
#   docker run -d --name obs --restart unless-stopped \
#     -p 8787:8787 -v obs-data:/data \
#     -e ADMIN_PASS=change-me \
#     -e SESSION_SECRET=$(openssl rand -hex 32) \
#     aipack/observability-server

# ── 构建阶段：pnpm install + SDK/server 构建（tsup + vite 面板） ────
FROM node:20-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
# lockfileVersion 9.0 → pnpm 9.x（corepack 固定主版本，保证可复现）
RUN corepack enable && corepack prepare pnpm@9 --activate

# better-sqlite3 原生编译依赖（构建期需要，运行期产物已编译）
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile
# 先构建 SDK（observability-server 类型依赖其 dist/），再构建 server（含面板）
RUN pnpm --filter @aipack/observability build \
 && pnpm --filter @aipack/observability-server build

# ── 运行阶段：仅保留产物 + 编译好的原生依赖 ─────────────────────────
FROM node:20-slim AS runtime
ENV NODE_ENV=production \
    PORT=8787 \
    DB_PATH=/data/collector.db \
    PRUNE_BACKUP_DIR=/data/backup \
    STATIC_DIR=/app/packages/observability-server/dist/public
WORKDIR /app
# node_modules 整段拷贝以保留 pnpm 符号链接 + better-sqlite3 原生绑定
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/packages/observability ./packages/observability
COPY --from=build /workspace/packages/observability-server ./packages/observability-server

EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "packages/observability-server/dist/cli.js"]
