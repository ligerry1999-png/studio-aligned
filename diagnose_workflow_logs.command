#!/bin/bash

# ============================================================
#  Workflow Canvas - 日志快速诊断
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
BACKEND_LOG="$LOG_DIR/latest-backend.log"
FRONTEND_LOG="$LOG_DIR/latest-frontend.log"

if [ ! -f "$BACKEND_LOG" ]; then
  BACKEND_LOG="$(ls -t "$LOG_DIR"/backend-*.log 2>/dev/null | head -n 1 || true)"
fi
if [ ! -f "$FRONTEND_LOG" ]; then
  FRONTEND_LOG="$(ls -t "$LOG_DIR"/frontend-*.log 2>/dev/null | head -n 1 || true)"
fi

if [ -z "${BACKEND_LOG:-}" ] || [ -z "${FRONTEND_LOG:-}" ] || [ ! -f "$BACKEND_LOG" ] || [ ! -f "$FRONTEND_LOG" ]; then
  echo "❌ 没有可用日志文件。请先运行 start_workflow_canvas_debug.command"
  exit 1
fi

echo "📍 backend log: $BACKEND_LOG"
echo "📍 frontend log: $FRONTEND_LOG"
echo ""

echo "================ backend error hints ================"
rg -n -i "error|exception|traceback|failed|status=5[0-9]{2}|http 5[0-9]{2}" "$BACKEND_LOG" | tail -n 120 || true
echo ""

echo "================ frontend error hints ================"
rg -n -i "error|exception|failed|uncaught|vite" "$FRONTEND_LOG" | tail -n 120 || true
echo ""

echo "================ backend tail (80) ================"
tail -n 80 "$BACKEND_LOG" || true
echo ""

echo "================ frontend tail (80) ================"
tail -n 80 "$FRONTEND_LOG" || true
