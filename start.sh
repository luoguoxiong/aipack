#!/usr/bin/env bash

set -e

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" &>/dev/null && pwd)
cd "$SCRIPT_DIR"

MODE="${1:-webui}"
PORT="${2:-8000}"

info() {
  echo "[$(date +'%Y-%m-%d %H:%M:%S')] INFO: $*"
}

error() {
  echo "[$(date +'%Y-%m-%d %H:%M:%S')] ERROR: $*" >&2
  exit 1
}

check_node() {
  if ! command -v node &>/dev/null; then
    error "Node.js is not installed. Please install Node.js (>=18.0.0)."
  fi
  NODE_VERSION=$(node --version | cut -d'v' -f2)
  info "Node.js version: $NODE_VERSION"
}

check_npm() {
  if ! command -v npm &>/dev/null; then
    error "npm is not installed. Please install npm."
  fi
}

check_build() {
  if [ ! -d "dist" ] || [ -z "$(ls -A dist)" ]; then
    info "Build directory not found, running npm run build..."
    npm run build
    info "Build completed successfully"
  else
    info "Build directory exists, skipping build"
  fi
}

start_webui() {
  info "Starting nanobot WebUI on port $PORT..."
  exec node dist/cli/commands.js webui -p "$PORT"
}

start_chat() {
  info "Starting nanobot interactive chat..."
  exec node dist/cli/commands.js chat
}

start_run() {
  shift 2
  if [ -z "$*" ]; then
    error "Please provide a message for the run command"
  fi
  info "Running single message: $*"
  exec node dist/cli/commands.js run "$*"
}

start_dev_webui() {
  info "Starting nanobot WebUI in development mode..."
  exec npx tsx src/cli/commands.ts webui -p "$PORT"
}

start_dev_chat() {
  info "Starting nanobot chat in development mode..."
  exec npx tsx src/cli/commands.ts chat
}

case "$MODE" in
  webui)
    check_node
    check_npm
    check_build
    start_webui
    ;;
  chat)
    check_node
    check_npm
    check_build
    start_chat
    ;;
  run)
    check_node
    check_npm
    check_build
    start_run "$@"
    ;;
  dev-webui)
    check_node
    check_npm
    start_dev_webui
    ;;
  dev-chat)
    check_node
    check_npm
    start_dev_chat
    ;;
  *)
    error "Unknown mode: $MODE. Available modes: webui, chat, run, dev-webui, dev-chat"
    ;;
esac