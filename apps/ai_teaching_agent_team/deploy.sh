#!/usr/bin/env bash
#
# apps/ai_teaching_agent_team/deploy.sh
#
# 一键部署 AI Teaching Agent Team 到外网：
#   1. 自动下载/复用 cloudflared（保存到 ~/.local/bin）
#   2. 构建生产产物（vite build + tsc，可 --no-build 跳过）
#   3. 后台启动后端（单端口，默认 3001，可用 PORT=xxxx 覆盖）
#   4. 建立 Cloudflare 快速隧道并打印公网地址
#
# 用法:
#   ./deploy.sh             # 完整部署（build + 启动 + 隧道）
#   ./deploy.sh --no-build  # 跳过构建
#   ./deploy.sh --stop      # 停止后端与隧道
#
# 说明:
#   - 后端以 nohup 后台运行，日志在 .deploy/server.log
#   - 隧道以 nohup 后台运行，日志在 .deploy/tunnel.log，公网地址随机生成
#   - 停止时通过 pkill 匹配本应用的进程命令行，若你同时用相同命令
#     （node dist/server.js / cloudflared tunnel）跑其它项目需注意
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$APP_DIR/../.." && pwd)"
DEPLOY_DIR="$APP_DIR/.deploy"
PORT="${PORT:-3001}"
CLOUDFLARED_BIN="${CLOUDFLARED_BIN:-$HOME/.local/bin/cloudflared}"

DO_BUILD=1
MODE=deploy
for arg in "$@"; do
  case "$arg" in
    --no-build) DO_BUILD=0 ;;
    --stop) MODE=stop ;;
    *) echo "未知参数: $arg（支持 --no-build / --stop）" >&2; exit 1 ;;
  esac
done

mkdir -p "$DEPLOY_DIR"

log() { echo "[deploy] $*"; }

# ── 停止旧进程（本应用模式的后端 + 隧道）────────────────────────
stop_all() {
  log "停止旧后端进程 (node dist/server.js)..."
  pkill -f "node dist/server.js" 2>/dev/null || true
  log "停止旧隧道进程 (cloudflared quick tunnel)..."
  pkill -f "cloudflared tunnel --url http://localhost:$PORT" 2>/dev/null || true
  rm -f "$DEPLOY_DIR/server.pid" "$DEPLOY_DIR/tunnel.pid"
  sleep 1
}

if [ "$MODE" = stop ]; then
  stop_all
  log "已停止。"
  exit 0
fi

# ── 1. 确保 cloudflared ─────────────────────────────────────────
if [ ! -x "$CLOUDFLARED_BIN" ]; then
  log "未找到 cloudflared，自动下载到 $CLOUDFLARED_BIN ..."
  mkdir -p "$(dirname "$CLOUDFLARED_BIN")"
  case "$(uname -m)" in
    x86_64) CF_ARCH=amd64 ;;
    arm64)  CF_ARCH=arm64 ;;
    *)      log "不支持的 CPU 架构: $(uname -m)"; exit 1 ;;
  esac
  TMP_DIR="$(mktemp -d)"
  curl -L --fail -sS -o "$TMP_DIR/cloudflared.tgz" \
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${CF_ARCH}.tgz"
  tar -xzf "$TMP_DIR/cloudflared.tgz" -C "$TMP_DIR"
  mv "$TMP_DIR/cloudflared" "$CLOUDFLARED_BIN"
  chmod +x "$CLOUDFLARED_BIN"
  rm -rf "$TMP_DIR"
else
  log "cloudflared: $($CLOUDFLARED_BIN --version | head -n1)"
fi

# ── 2. 停止旧进程 ───────────────────────────────────────────────
stop_all

# ── 3. 构建 ─────────────────────────────────────────────────────
if [ "$DO_BUILD" = 1 ]; then
  log "构建生产产物 (vite build + tsc)..."
  (cd "$REPO_DIR" && pnpm --filter ai-teaching-agent-team build)
else
  log "跳过构建 (--no-build)"
fi

# ── 4. 启动后端 ─────────────────────────────────────────────────
log "启动后端 (端口 $PORT, 日志: $DEPLOY_DIR/server.log)..."
(
  cd "$APP_DIR"
  nohup node dist/server.js > "$DEPLOY_DIR/server.log" 2>&1 &
  echo $! > "$DEPLOY_DIR/server.pid"
)

READY=0
for _ in $(seq 1 30); do
  if curl -s -o /dev/null -m 2 "http://localhost:$PORT/api/config" 2>/dev/null; then
    READY=1
    break
  fi
  sleep 1
done
if [ "$READY" = 0 ]; then
  log "后端未就绪，请查看 $DEPLOY_DIR/server.log"
  exit 1
fi
log "后端就绪"

# ── 5. 启动隧道（DNS 注册偶发失败，未生效则自动重启重试）────────
# 启动一次快速隧道并返回其公网 URL（解析自日志，最多等 90s）
start_tunnel() {
  pkill -f "cloudflared tunnel --url http://localhost:$PORT" 2>/dev/null || true
  sleep 2
  (
    nohup "$CLOUDFLARED_BIN" tunnel --url "http://localhost:$PORT" \
      --protocol http2 --no-autoupdate > "$DEPLOY_DIR/tunnel.log" 2>&1 &
    echo $! > "$DEPLOY_DIR/tunnel.pid"
  )
  local url=""
  for _ in $(seq 1 90); do
    url="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$DEPLOY_DIR/tunnel.log" 2>/dev/null | head -n1 || true)"
    [ -n "$url" ] && break
    sleep 1
  done
  echo "$url"
}

log "建立 Cloudflare 快速隧道 (日志: $DEPLOY_DIR/tunnel.log)..."
TUNNEL_URL=""
for attempt in 1 2 3; do
  TUNNEL_URL="$(start_tunnel)"
  if [ -z "$TUNNEL_URL" ]; then
    log "第 $attempt 次尝试未能获取隧道 URL，重试..."
    continue
  fi
  log "隧道: $TUNNEL_URL (尝试 $attempt/3)，等待 DNS 生效并验证..."
  OK=0
  for _ in $(seq 1 90); do
    if curl -s -o /dev/null -m 10 "$TUNNEL_URL/api/config" 2>/dev/null; then
      OK=1
      break
    fi
    sleep 1
  done
  if [ "$OK" = 1 ]; then break; fi
  log "隧道 DNS 未生效，重启隧道重试..."
  TUNNEL_URL=""
done

# ── 6. 输出 ─────────────────────────────────────────────────────
if [ -z "$TUNNEL_URL" ]; then
  log "3 次尝试后公网仍不可达，请检查 $DEPLOY_DIR/tunnel.log"
  exit 1
fi
EXTERN="[OK] 已可访问"

echo ""
echo "════════════════════════════════════════════════════"
echo "  公网地址: $TUNNEL_URL  $EXTERN"
echo "  本地地址: http://localhost:$PORT"
echo "════════════════════════════════════════════════════"
echo "  停止部署: ./deploy.sh --stop"
echo "  查看日志: tail -f $DEPLOY_DIR/server.log"
echo "            tail -f $DEPLOY_DIR/tunnel.log"
