#!/usr/bin/env bash
# SSVEP 智能家居仿真平台 - 后端一键启动（PB + SCB）
# 用法：./start-backend.sh
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGS="$ROOT/logs"
mkdir -p "$LOGS"

# ---------- 环境检查 ----------
need() { command -v "$1" >/dev/null 2>&1 || { echo "[错误] 未检测到 $1，请先安装"; exit 1; }; }
need bun
PY="${PYTHON:-python3}"
command -v "$PY" >/dev/null 2>&1 || PY=python
need "$PY"

echo "========================================"
echo "  SSVEP 智能家居仿真平台 - 后端启动"
echo "  PB:3000   SCB:mock 模式"
echo "========================================"

# ---------- 依赖安装（缺才装） ----------
[ -d "$ROOT/pb/node_modules" ] || { echo "[1/2] 安装 PB 依赖..."; (cd "$ROOT/pb" && bun install) || exit 1; }
"$PY" -c "import aiohttp,pydantic,numpy,scipy,sklearn" 2>/dev/null || { echo "[2/2] 安装 SCB 依赖..."; "$PY" -m pip install -r "$ROOT/scb/requirements.txt"; }

PIDS=()
cleanup() { echo; echo "正在停止服务..."; for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null; done; }
trap cleanup EXIT INT TERM

# ---------- 启动服务 ----------
echo "启动服务（日志写入 $LOGS）..."
(cd "$ROOT/pb" && exec bun run dev)       >"$LOGS/pb.log"  2>&1 & PIDS+=($!)
sleep 2
(cd "$ROOT"    && exec "$PY" -m scb.main) >"$LOGS/scb.log" 2>&1 & PIDS+=($!)

# 等待 PB 端口就绪（最多 15s）
for _ in $(seq 1 15); do
  (exec 3<>/dev/tcp/127.0.0.1/3000) 2>/dev/null && { exec 3>&- 3<&-; break; }
  sleep 1
done

echo "已启动：PB(:3000)  SCB(mock)   PID: ${PIDS[*]}"
echo "状态接口：http://localhost:3000/api/state"
echo "前端请另运行 ./start-frontend.sh（预览模式，可局域网访问）"
echo "         或 ./start-frontend-dev.sh（开发模式，仅本机）"
echo "按 Ctrl+C 停止全部服务；实时日志：tail -F $LOGS/pb.log $LOGS/scb.log"

tail -F "$LOGS/pb.log" "$LOGS/scb.log" 2>/dev/null & PIDS+=($!)
wait
