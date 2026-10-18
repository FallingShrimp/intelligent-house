#!/usr/bin/env bash
# SSVEP 智能家居仿真平台一键启动
# 用法：./start.sh [--scf]   （--scf 可选，同时启动 PsychoPy 刺激呈现）
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGS="$ROOT/logs"
mkdir -p "$LOGS"

# ---------- 环境检查 ----------
need() { command -v "$1" >/dev/null 2>&1 || { echo "[错误] 未检测到 $1，请先安装"; exit 1; }; }
need bun
need npm
PY="${PYTHON:-python3}"
command -v "$PY" >/dev/null 2>&1 || PY=python
need "$PY"

echo "========================================"
echo "  SSVEP 智能家居仿真平台 - 一键启动"
echo "  PB:3000   PF:5173   SCB:mock 模式"
echo "========================================"

# ---------- 依赖安装（缺才装） ----------
[ -d "$ROOT/pb/node_modules" ] || { echo "[1/4] 安装 PB 依赖..."; (cd "$ROOT/pb" && bun install) || exit 1; }
[ -d "$ROOT/pf/node_modules" ] || { echo "[2/4] 安装 PF 依赖..."; (cd "$ROOT/pf" && npm install) || exit 1; }
"$PY" -c "import aiohttp,pydantic,numpy,scipy,sklearn" 2>/dev/null || { echo "[3/4] 安装 SCB 依赖..."; "$PY" -m pip install -r "$ROOT/scb/requirements.txt"; }

PIDS=()
cleanup() { echo; echo "正在停止服务..."; for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null; done; }
trap cleanup EXIT INT TERM

# ---------- 启动服务 ----------
echo "[4/4] 启动服务（日志写入 $LOGS）..."
(cd "$ROOT/pb" && exec bun run dev)       >"$LOGS/pb.log"  2>&1 & PIDS+=($!)
(cd "$ROOT/pf" && exec npm run dev)       >"$LOGS/pf.log"  2>&1 & PIDS+=($!)
(cd "$ROOT"    && exec "$PY" -m scb.main) >"$LOGS/scb.log" 2>&1 & PIDS+=($!)

# 等待 PB 端口就绪（最多 15s）
for _ in $(seq 1 15); do
  (exec 3<>/dev/tcp/127.0.0.1/3000) 2>/dev/null && { exec 3>&- 3<&-; break; }
  sleep 1
done

# 可选：--scf 同时启动刺激呈现（需 psychopy，Python 3.10-3.12）
if [ "${1:-}" = "--scf" ]; then
  "$PY" -c "import psychopy" 2>/dev/null || echo "[警告] 未安装 psychopy，SCF 将启动失败"
  (cd "$ROOT/scf" && exec "$PY" stimulus.py) & PIDS+=($!)
fi

echo "已启动：PB(:3000)  PF(:5173)  SCB(mock)   PID: ${PIDS[*]}"
echo "状态接口：http://localhost:3000/api/state    前端：http://localhost:5173"
echo "按 Ctrl+C 停止全部服务；实时日志：tail -F $LOGS/*.log"

# 浏览器打开前端（尽力而为）
( sleep 3; xdg-open http://localhost:5173 >/dev/null 2>&1 || open http://localhost:5173 >/dev/null 2>&1 ) &

tail -F "$LOGS/pb.log" "$LOGS/pf.log" "$LOGS/scb.log" 2>/dev/null & PIDS+=($!)
wait
