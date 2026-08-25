#!/usr/bin/env bash
# aipack 可观测性服务一键启动脚本（macOS / Linux）
#
# 用法（在 packages/observability-server 目录下执行）:
#   ./start.sh            # 基础部署: MySQL + ClickHouse + collector
#   ./start.sh --full     # 平台模式: 全部容器 + collector + worker
#   ./start.sh --no-docker  # 容器已手动起好,只起 collector
#
# 停止: Ctrl+C 退出 collector/worker（容器保留数据继续运行）
#       docker compose -f infra/docker-compose.yml down        # 停止容器
#       docker compose -f infra/docker-compose.yml down -v     # 停止并清空数据

set -euo pipefail
cd "$(dirname "$0")"

FULL=0
NO_DOCKER=0
for arg in "$@"; do
  case "$arg" in
    --full)      FULL=1 ;;
    --no-docker) NO_DOCKER=1 ;;
    *) echo "未知参数: $arg（支持 --full / --no-docker）"; exit 1 ;;
  esac
done

# 从 .env 读取键值（KEY=VALUE 格式，无引号）
read_env() {
  local key="$1" default="$2" val
  if [ -f .env ]; then
    val=$(grep -E "^[[:space:]]*${key}=" .env | head -1 | cut -d= -f2 | tr -d '[:space:]')
    [ -n "$val" ] && { echo "$val"; return; }
  fi
  echo "$default"
}

# ── [1/4] 准备 .env ──────────────────────────────────────────────
echo "==> [1/4] 准备 .env"
if [ ! -f .env ]; then
  cp .env.example .env
  echo "    已从 .env.example 生成 .env（默认密码仅限本地开发）"
else
  echo "    使用现有 .env"
fi

# ── [2/4] 启动 Docker 基础设施 ──────────────────────────────────
if [ "$NO_DOCKER" -eq 1 ]; then
  echo "==> [2/4] 跳过容器启动（--no-docker）"
  echo "==> [3/4] 跳过就绪等待（--no-docker）"
else
  echo "==> [2/4] 启动 Docker 基础设施"
  if ! docker info >/dev/null 2>&1; then
    echo "错误: Docker 未运行，请先启动 Docker（或加 --no-docker 跳过容器）" >&2
    exit 1
  fi

  if [ "$FULL" -eq 1 ]; then
    docker compose -f infra/docker-compose.yml --env-file .env up -d
  else
    # 基础部署只需 MySQL + ClickHouse（Kafka/ZK/Redis 不起）
    docker compose -f infra/docker-compose.yml --env-file .env up -d mysql clickhouse
  fi

  # ── [3/4] 等待服务就绪 ────────────────────────────────────────
  echo "==> [3/4] 等待服务就绪（首次拉镜像/建库可能较慢）"
  deadline=$(( $(date +%s) + 120 ))

  # ClickHouse: HTTP /ping
  CH_PORT=$(read_env CLICKHOUSE_HTTP_PORT 8123)
  ch_ok=0
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -fsS -m 2 "http://localhost:${CH_PORT}/ping" 2>/dev/null | grep -q Ok; then
      ch_ok=1; break
    fi
    sleep 2
  done
  if [ "$ch_ok" -ne 1 ]; then
    echo "错误: ClickHouse 等待超时（http://localhost:${CH_PORT}/ping 120s）" >&2
    exit 1
  fi
  echo "    ClickHouse 就绪 (:${CH_PORT})"

  # MySQL: 容器 healthcheck 转 healthy
  my_ok=0
  while [ "$(date +%s)" -lt "$deadline" ]; do
    st=$(docker inspect --format '{{.State.Health.Status}}' aipack-mysql 2>/dev/null || true)
    if [ "$st" = "healthy" ]; then
      my_ok=1; break
    fi
    sleep 2
  done
  if [ "$my_ok" -ne 1 ]; then
    echo "错误: MySQL 等待超时（aipack-mysql healthcheck 120s）" >&2
    exit 1
  fi
  echo "    MySQL 就绪"
fi

# ── [4/4] 启动 collector（前台）+ 可选 worker ───────────────────
WORKER_PID=""
cleanup() {
  if [ -n "$WORKER_PID" ] && kill -0 "$WORKER_PID" 2>/dev/null; then
    echo ""
    echo "==> 停止 ingest-worker (pid ${WORKER_PID})"
    kill "$WORKER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

if [ "$FULL" -eq 1 ]; then
  if ! grep -Eq '^[[:space:]]*MQ_ENABLED[[:space:]]*=[[:space:]]*true' .env 2>/dev/null; then
    echo "    警告: .env 未启用 MQ_ENABLED=true，worker 启动会直接报错退出" >&2
    echo "    请在 .env 中取消注释 MQ_ENABLED=true 后重跑" >&2
  fi
  echo "==> [4/4] 启动 ingest-worker（后台）+ collector（前台）"
  pnpm --filter @aipack-ai/observability-server worker &
  WORKER_PID=$!
else
  echo "==> [4/4] 启动 collector（前台）"
fi

echo ""
echo "    面板:     http://localhost:8787  （默认 admin / admin123）"
echo "    上报:     POST http://localhost:8787/api/v1/ingest"
echo "    健康检查: GET  http://localhost:8787/healthz"
echo "    停止容器: docker compose -f infra/docker-compose.yml down"
echo ""

pnpm --filter @aipack-ai/observability-server dev
