#!/usr/bin/env bash
# SSVEP 智能家居仿真平台 - 前端一键启动（开发模式：PF vite dev + SCF）
# 用法：./start-frontend-dev.sh
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGS="$ROOT/logs"
mkdir -p "$LOGS"

# ---------- 环境检查 ----------
need() { command -v "$1" >/dev/null 2>&1 || { echo "[错误] 未检测到 $1，请先安装"; exit 1; }; }
need npm
PY="${PYTHON:-python3}"
command -v "$PY" >/dev/null 2>&1 || PY=python
need "$PY"

echo "========================================"
echo "  SSVEP 智能家居仿真平台 - 前端启动（开发模式）"
echo "  PF dev:5173   SCF:刺激呈现"
echo "========================================"

# ---------- 依赖安装 ----------
[ -d "$ROOT/pf/node_modules" ] || { echo "[1/1] 安装 PF 依赖..."; (cd "$ROOT/pf" && npm install) || exit 1; }

PIDS=()
cleanup() { echo; echo "正在停止服务..."; for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null; done; }
trap cleanup EXIT INT TERM

# ---------- 启动服务 ----------
(cd "$ROOT/pf" && exec npm run dev) >"$LOGS/pf-dev.log" 2>&1 & PIDS+=($!)

# SCF：已安装 psychopy 才启动（需 Python 3.10-3.12）
if "$PY" -c "import psychopy" 2>/dev/null; then
  (cd "$ROOT/scf" && exec "$PY" stimulus.py) >"$LOGS/scf.log" 2>&1 & PIDS+=($!)
else
  echo "[警告] 未安装 psychopy（需 Python 3.10-3.12），跳过 SCF 刺激呈现"
fi

# 等待 PF 端口就绪（最多 15s）
for _ in $(seq 1 15); do
  (exec 3<>/dev/tcp/127.0.0.1/5173) 2>/dev/null && { exec 3>&- 3<&-; break; }
  sleep 1
done

echo "已启动（开发模式）  PID: ${PIDS[*]}"
echo "前端地址：http://localhost:5173（vite dev 仅本机可访问）"
echo "注意：请先运行 ./start-backend.sh 启动 PB/SCB，否则页面显示未连接"
echo "注意：外部设备访问请改用 ./start-frontend.sh（预览模式）"
echo "按 Ctrl+C 停止全部服务"

( sleep 3; xdg-open http://localhost:5173 >/dev/null 2>&1 || open http://localhost:5173 >/dev/null 2>&1 ) &

tail -F "$LOGS/pf-dev.log" "$LOGS/scf.log" 2>/dev/null & PIDS+=($!)
wait
