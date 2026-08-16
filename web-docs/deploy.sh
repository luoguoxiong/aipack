#!/usr/bin/env bash
#
# web-docs/deploy.sh
#
# 一键发布 web-docs 文档站到 Netlify (https://app.netlify.com/)
#
# 用法:
#   ./deploy.sh              # 部署到生产环境 (prod)
#   ./deploy.sh --preview    # 部署预览草稿 (生成临时预览链接,不影响生产)
#   ./deploy.sh --no-build   # 跳过构建,直接部署已有 dist/
#
# 首次运行会自动:
#   1. 安装 Netlify CLI (若无)
#   2. 引导登录 Netlify (若未登录)
#   3. 关联/创建站点 (若未关联)
#
# 后续运行直接构建并发布。
set -euo pipefail

DOC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DO_BUILD=1
MODE=prod

for arg in "$@"; do
  case "$arg" in
    --preview)  MODE=preview ;;
    --no-build) DO_BUILD=0 ;;
    *) echo "未知参数: $arg（支持 --preview / --no-build）" >&2; exit 1 ;;
  esac
done

log() { echo "[deploy] $*"; }

# ── 1. 确保 Netlify CLI ──────────────────────────────────────────
if ! command -v netlify >/dev/null 2>&1; then
  log "未检测到 Netlify CLI，正在全局安装..."
  npm install -g netlify-cli
else
  log "Netlify CLI: $(netlify --version 2>/dev/null | head -n1)"
fi

# ── 2. 确保已登录 ────────────────────────────────────────────────
# netlify status 在未登录时退出码非 0
if ! netlify status >/dev/null 2>&1; then
  log "未登录 Netlify，正在打开浏览器引导登录..."
  netlify login
else
  log "已登录 Netlify"
fi

# ── 3. 确保站点已关联 ────────────────────────────────────────────
# 若未关联站点，netlify deploy 会提示 --site；这里用 link 引导关联
SITE_ID="$(netlify status 2>/dev/null | grep -oE 'Site ID: +[a-z0-9-]+' | awk '{print $3}' || true)"
if [ -z "$SITE_ID" ]; then
  log "未关联站点，正在引导关联/创建站点..."
  netlify link
fi

# ── 4. 构建 ─────────────────────────────────────────────────────
if [ "$DO_BUILD" = 1 ]; then
  log "安装依赖并构建生产产物..."
  (cd "$DOC_DIR" && pnpm install --frozen-lockfile && pnpm build)
else
  log "跳过构建 (--no-build)"
  if [ ! -d "$DOC_DIR/dist" ]; then
    log "错误: dist/ 目录不存在，请先执行构建。" >&2
    exit 1
  fi
fi

# ── 5. 部署 ─────────────────────────────────────────────────────
cd "$DOC_DIR"
if [ "$MODE" = preview ]; then
  log "部署预览草稿..."
  URL="$(netlify deploy --build=false 2>&1 | grep -oE 'https://[a-z0-9-]+--[a-z0-9-]+\.netlify\.app' | head -n1 || true)"
else
  log "部署到生产环境..."
  URL="$(netlify deploy --build=false --prod 2>&1 | grep -oE 'https://[a-z0-9-]+\.netlify\.app' | head -n1 || true)"
fi

# ── 6. 输出 ─────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════"
if [ -n "$URL" ]; then
  echo "  部署成功！访问地址: $URL"
else
  echo "  部署命令已执行，请查看上方输出获取访问地址"
fi
echo "  站点管理: https://app.netlify.com/"
echo "════════════════════════════════════════════════════"
