#!/bin/bash

# ============================================================
#  Workflow Canvas - 双击调试启动（含日志）
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

BACKEND_DIR="$PROJECT_ROOT/backend"
FRONTEND_DIR="$PROJECT_ROOT/frontend"
BACKEND_PORT="${BACKEND_PORT:-8899}"
FRONTEND_PORT="${FRONTEND_PORT:-5174}"
START_ROUTE="${START_ROUTE:-/workflow}"
LOG_DIR="$PROJECT_ROOT/.logs"
TS="$(date +"%Y%m%d-%H%M%S")"
BACKEND_LOG="$LOG_DIR/backend-$TS.log"
FRONTEND_LOG="$LOG_DIR/frontend-$TS.log"
BACKEND_PID=""

get_listen_pids_by_port() {
  local port="$1"
  lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | sort -u
}

force_release_port() {
  local port="$1"
  local label="$2"
  local pids
  pids="$(get_listen_pids_by_port "$port")"
  if [ -z "$pids" ]; then
    return 0
  fi

  echo "⚠️  检测到 $label 端口 $port 被占用，正在释放..."
  kill $pids >/dev/null 2>&1 || true
  sleep 1

  pids="$(get_listen_pids_by_port "$port")"
  if [ -n "$pids" ]; then
    kill -9 $pids >/dev/null 2>&1 || true
    sleep 1
  fi

  pids="$(get_listen_pids_by_port "$port")"
  if [ -n "$pids" ]; then
    echo "❌ 无法释放端口 $port，请手动检查。"
    return 1
  fi

  echo "✅ 端口 $port 已释放"
  return 0
}

pause_and_exit() {
  echo ""
  read -n 1 -s -r -p "按任意键退出..."
  echo ""
  exit 1
}

cleanup() {
  if [ -n "$BACKEND_PID" ] && kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
    pkill -TERM -P "$BACKEND_PID" >/dev/null 2>&1 || true
    kill "$BACKEND_PID" >/dev/null 2>&1 || true
    sleep 0.5
    pkill -KILL -P "$BACKEND_PID" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT INT TERM

if [ -z "$PROJECT_ROOT" ] || [ ! -d "$BACKEND_DIR" ] || [ ! -d "$FRONTEND_DIR" ]; then
  echo "❌ 未找到项目目录（需同时包含 backend 和 frontend）"
  echo "   当前脚本位置: $SCRIPT_DIR"
  pause_and_exit
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "❌ 未找到 python3，请先安装 Python 3"
  pause_and_exit
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "❌ 未找到 npm，请先安装 Node.js (含 npm)"
  pause_and_exit
fi

mkdir -p "$LOG_DIR"
ln -sfn "$(basename "$BACKEND_LOG")" "$LOG_DIR/latest-backend.log"
ln -sfn "$(basename "$FRONTEND_LOG")" "$LOG_DIR/latest-frontend.log"

force_release_port "$BACKEND_PORT" "后端" || pause_and_exit
force_release_port "$FRONTEND_PORT" "前端" || pause_and_exit

cd "$BACKEND_DIR" || pause_and_exit
VENV_DIR="$BACKEND_DIR/.venv"
VENV_PYTHON="$VENV_DIR/bin/python"

if [ ! -x "$VENV_PYTHON" ]; then
  echo "⚠️  检测到后端虚拟环境不可用，正在重建..."
  rm -rf "$VENV_DIR"
  python3 -m venv "$VENV_DIR" || {
    echo "❌ 创建虚拟环境失败"
    pause_and_exit
  }
fi

if ! "$VENV_PYTHON" -m pip --version >/dev/null 2>&1; then
  "$VENV_PYTHON" -m ensurepip --upgrade >/dev/null 2>&1 || {
    echo "❌ 修复 pip 失败"
    pause_and_exit
  }
fi

if ! "$VENV_PYTHON" -c 'import uvicorn' >/dev/null 2>&1; then
  "$VENV_PYTHON" -m pip install -r requirements.txt || {
    echo "❌ 安装后端依赖失败"
    pause_and_exit
  }
fi

echo "🚀 启动后端（debug 日志）..."
"$VENV_PYTHON" -m uvicorn main:app --host 127.0.0.1 --port "$BACKEND_PORT" --reload --log-level debug >"$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!
sleep 1

if ! kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
  echo "❌ 后端启动失败，最近日志："
  tail -n 120 "$BACKEND_LOG" || true
  pause_and_exit
fi

cd "$FRONTEND_DIR" || pause_and_exit
if [ ! -d node_modules ]; then
  npm install
fi

(sleep 4 && open "http://127.0.0.1:$FRONTEND_PORT$START_ROUTE") >/dev/null 2>&1 &

echo "✅ Workflow 调试启动完成"
echo "   前端: http://127.0.0.1:$FRONTEND_PORT$START_ROUTE"
echo "   后端: http://127.0.0.1:$BACKEND_PORT"
echo ""
echo "🧾 日志文件："
echo "   $BACKEND_LOG"
echo "   $FRONTEND_LOG"
echo ""
echo "🔎 建议测试时再双击 watch_workflow_logs.command 实时看日志"
echo ""
echo "关闭这个终端窗口即可停止服务。"

npm run dev -- --host 127.0.0.1 --port "$FRONTEND_PORT" 2>&1 | tee "$FRONTEND_LOG"
