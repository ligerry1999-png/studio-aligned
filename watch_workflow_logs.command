#!/bin/bash

# ============================================================
#  Workflow Canvas - 双击实时看日志
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

find_project_root_from() {
  local dir="$1"
  while [ -n "$dir" ]; do
    if [ -d "$dir/backend" ] && [ -d "$dir/frontend" ]; then
      echo "$dir"
      return 0
    fi
    if [ "$dir" = "/" ]; then
      break
    fi
    dir="$(dirname "$dir")"
  done
  return 1
}

if [ -n "${STUDIO_ALIGNED_ROOT:-}" ]; then
  PROJECT_ROOT="$STUDIO_ALIGNED_ROOT"
else
  PROJECT_ROOT="$(find_project_root_from "$SCRIPT_DIR" || true)"
  if [ -z "$PROJECT_ROOT" ]; then
    PROJECT_ROOT="$(find_project_root_from "$PWD" || true)"
  fi
fi

if [ -z "${PROJECT_ROOT:-}" ]; then
  echo "❌ 未找到项目根目录"
  exit 1
fi

LOG_DIR="$PROJECT_ROOT/.logs"
if [ ! -d "$LOG_DIR" ]; then
  echo "❌ 未找到日志目录：$LOG_DIR"
  echo "请先双击 start_workflow_canvas_debug.command 启动。"
  exit 1
fi

BACKEND_LOG="$LOG_DIR/latest-backend.log"
FRONTEND_LOG="$LOG_DIR/latest-frontend.log"

if [ ! -f "$BACKEND_LOG" ]; then
  BACKEND_LOG="$(ls -t "$LOG_DIR"/backend-*.log 2>/dev/null | head -n 1 || true)"
fi
if [ ! -f "$FRONTEND_LOG" ]; then
  FRONTEND_LOG="$(ls -t "$LOG_DIR"/frontend-*.log 2>/dev/null | head -n 1 || true)"
fi

if [ -z "${BACKEND_LOG:-}" ] || [ -z "${FRONTEND_LOG:-}" ] || [ ! -f "$BACKEND_LOG" ] || [ ! -f "$FRONTEND_LOG" ]; then
  echo "❌ 没有可用日志文件。请先启动再查看。"
  exit 1
fi

echo "📍 backend log: $BACKEND_LOG"
echo "📍 frontend log: $FRONTEND_LOG"
echo ""
echo "按 Ctrl + C 退出日志观察。"
echo ""

tail -n 120 -F "$BACKEND_LOG" | sed -u 's/^/[backend] /' &
PID1=$!

tail -n 120 -F "$FRONTEND_LOG" | sed -u 's/^/[frontend] /' &
PID2=$!

cleanup() {
  kill "$PID1" >/dev/null 2>&1 || true
  kill "$PID2" >/dev/null 2>&1 || true
}

trap cleanup EXIT INT TERM
wait
