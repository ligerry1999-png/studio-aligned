#!/bin/bash

# ============================================================
#  Interior Prompt Studio - 双击启动
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"
FRONTEND_DIR="$SCRIPT_DIR/frontend"
BACKEND_PORT=8899
FRONTEND_PORT=5174
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
  for pid in $pids; do
    ps -p "$pid" -o pid=,command=
  done

  kill $pids >/dev/null 2>&1 || true
  sleep 1

  pids="$(get_listen_pids_by_port "$port")"
  if [ -n "$pids" ]; then
    echo "⚠️  端口 $port 仍被占用，尝试强制结束..."
    kill -9 $pids >/dev/null 2>&1 || true
    sleep 1
  fi

  pids="$(get_listen_pids_by_port "$port")"
  if [ -n "$pids" ]; then
    echo "❌ 无法释放端口 $port，请手动检查后重试。"
    for pid in $pids; do
      ps -p "$pid" -o pid=,command=
    done
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

if [ ! -d "$BACKEND_DIR" ] || [ ! -d "$FRONTEND_DIR" ]; then
  echo "❌ 目录结构不完整，请确保脚本位于 studio_aligned 下"
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

force_release_port "$BACKEND_PORT" "后端" || pause_and_exit
force_release_port "$FRONTEND_PORT" "前端" || pause_and_exit

echo "🚀 正在启动后端..."
cd "$BACKEND_DIR" || pause_and_exit
if [ ! -d .venv ]; then
  python3 -m venv .venv
fi
source .venv/bin/activate
if ! python -c 'import uvicorn' >/dev/null 2>&1; then
  pip install -r requirements.txt
fi

python -m uvicorn main:app --host 127.0.0.1 --port "$BACKEND_PORT" --reload >/tmp/studio_aligned_backend.log 2>&1 &
BACKEND_PID=$!
sleep 1

if ! kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
  echo "❌ 后端启动失败，日志如下："
  tail -n 120 /tmp/studio_aligned_backend.log
  pause_and_exit
fi

echo "✅ 后端已启动: http://127.0.0.1:$BACKEND_PORT"
echo "🚀 正在启动前端..."
cd "$FRONTEND_DIR" || pause_and_exit
if [ ! -d node_modules ]; then
  npm install
fi

# 前端启动稍慢，延迟打开浏览器
(sleep 4 && open "http://127.0.0.1:$FRONTEND_PORT") >/dev/null 2>&1 &

echo "✅ 单窗口启动完成"
echo "   后端: http://127.0.0.1:$BACKEND_PORT"
echo "   前端: http://127.0.0.1:$FRONTEND_PORT"
echo ""
echo "关闭这个终端窗口即可停止服务。"

npm run dev -- --host 127.0.0.1 --port "$FRONTEND_PORT"
