# aipack 可观测性服务一键启动脚本（Windows / PowerShell 5+）
#
# 用法（在 packages/observability-server 目录下执行）:
#   powershell -ExecutionPolicy Bypass -File start.ps1            # 基础部署: MySQL + ClickHouse + collector
#   powershell -ExecutionPolicy Bypass -File start.ps1 -Full      # 平台模式: 全部容器 + collector + worker
#   powershell -ExecutionPolicy Bypass -File start.ps1 -NoDocker  # 容器已手动起好,只起 collector
#
# 停止: Ctrl+C 退出 collector（容器保留数据继续运行）
#       docker compose -f infra/docker-compose.yml down          # 停止容器
#       docker compose -f infra/docker-compose.yml down -v       # 停止并清空数据
param(
  [switch]$Full,      # 起全部基础设施（含 Kafka/ZK/Redis）并额外启动 ingest-worker
  [switch]$NoDocker   # 跳过容器启动与就绪等待
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# 从 .env 读取键值（无引号格式 KEY=VALUE；返回缺省值）
function Read-Env([string]$Key, [string]$Default) {
  $line = Select-String -Path .env -Pattern ("^\s*" + $Key + "\s*=\s*(\S+)") -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($line) { return $line.Matches[0].Groups[1].Value }
  return $Default
}

# ── [1/4] 准备 .env ──────────────────────────────────────────────
Write-Host "==> [1/4] 准备 .env" -ForegroundColor Cyan
if (-not (Test-Path .env)) {
  Copy-Item .env.example .env
  Write-Host "    已从 .env.example 生成 .env（默认密码仅限本地开发）" -ForegroundColor Yellow
} else {
  Write-Host "    使用现有 .env"
}

# ── [2/4] 启动 Docker 基础设施 ──────────────────────────────────
if ($NoDocker) {
  Write-Host "==> [2/4] 跳过容器启动（-NoDocker）" -ForegroundColor Cyan
  Write-Host "==> [3/4] 跳过就绪等待（-NoDocker）" -ForegroundColor Cyan
} else {
  Write-Host "==> [2/4] 启动 Docker 基础设施" -ForegroundColor Cyan
  $dockerErr = "Docker 未运行，请先启动 Docker Desktop（或加 -NoDocker 跳过容器）"
  try { docker info *> $null } catch { throw $dockerErr }
  if ($LASTEXITCODE -ne 0) { throw $dockerErr }

  if ($Full) {
    docker compose -f infra/docker-compose.yml --env-file .env up -d
  } else {
    # 基础部署只需 MySQL + ClickHouse（Kafka/ZK/Redis 不起）
    docker compose -f infra/docker-compose.yml --env-file .env up -d mysql clickhouse
  }
  if ($LASTEXITCODE -ne 0) { throw "docker compose 启动失败" }

  # ── [3/4] 等待服务就绪 ────────────────────────────────────────
  Write-Host "==> [3/4] 等待服务就绪（首次拉镜像/建库可能较慢）" -ForegroundColor Cyan
  $deadline = (Get-Date).AddSeconds(120)

  # ClickHouse: HTTP /ping（用 curl.exe，避免 Invoke-WebRequest 走系统代理超时）
  $chPort = Read-Env 'CLICKHOUSE_HTTP_PORT' '8123'
  $chOk = $false
  while ((Get-Date) -lt $deadline) {
    $ping = & curl.exe -s -m 2 ("http://localhost:" + $chPort + "/ping") 2>$null
    if ($LASTEXITCODE -eq 0 -and $ping -match 'Ok') { $chOk = $true; break }
    Start-Sleep -Seconds 2
  }
  if (-not $chOk) { throw "ClickHouse 等待超时（http://localhost:$chPort/ping 120s）" }
  Write-Host "    ClickHouse 就绪 (:$chPort)" -ForegroundColor Green

  # MySQL: 容器 healthcheck 转 healthy
  $myOk = $false
  while ((Get-Date) -lt $deadline) {
    $st = $null
    try { $st = (docker inspect --format '{{.State.Health.Status}}' aipack-mysql 2>$null) } catch { $st = $null }
    if ($st -eq 'healthy') { $myOk = $true; break }
    Start-Sleep -Seconds 2
  }
  if (-not $myOk) { throw "MySQL 等待超时（aipack-mysql healthcheck 120s）" }
  Write-Host "    MySQL 就绪" -ForegroundColor Green
}

# ── [4/4] 启动 collector（前台）+ 可选 worker ───────────────────
if ($Full) {
  $mqEnabled = Select-String -Path .env -Pattern '^\s*MQ_ENABLED\s*=\s*true' -ErrorAction SilentlyContinue
  if (-not $mqEnabled) {
    Write-Host "    警告: .env 未启用 MQ_ENABLED=true，worker 启动会直接报错退出" -ForegroundColor Yellow
    Write-Host "    请在 .env 中取消注释 MQ_ENABLED=true 后重跑" -ForegroundColor Yellow
  }
  Write-Host "==> [4/4] 启动 ingest-worker（新窗口）+ collector（前台）" -ForegroundColor Cyan
  Start-Process powershell -ArgumentList '-NoExit', '-Command', ("Set-Location '" + $PSScriptRoot + "'; pnpm --filter @aipack-ai/observability-server worker")
} else {
  Write-Host "==> [4/4] 启动 collector（前台）" -ForegroundColor Cyan
}

Write-Host ""
Write-Host "    面板:     http://localhost:8787  （默认 admin / admin123）" -ForegroundColor DarkGray
Write-Host "    上报:     POST http://localhost:8787/api/v1/ingest" -ForegroundColor DarkGray
Write-Host "    健康检查: GET  http://localhost:8787/healthz" -ForegroundColor DarkGray
Write-Host "    停止容器: docker compose -f infra/docker-compose.yml down" -ForegroundColor DarkGray
Write-Host ""

pnpm --filter @aipack-ai/observability-server dev
