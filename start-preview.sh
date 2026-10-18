#!/usr/bin/env bash
# SSVEP 智能家居仿真平台 - 预览模式一键启动（构建产物经 vite preview 对局域网开放）
# 用法：./start-preview.sh
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

# ---------- 探测局域网 IP（供外部设备连接） ----------
LANIP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -z "$LANIP" ] && LANIP="$(ip route get 1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1)"
[ -z "$LANIP" ] && LANIP="127.0.0.1"
echo "局域网 IP: $LANIP"

echo "========================================"
echo "  SSVEP 智能家居仿真平台 - 预览模式"
echo "  PB:3000   PF preview:5173   SCB:mock"
echo "========================================"

# ---------- 依赖安装（缺才装） ----------
[ -d "$ROOT/pb/node_modules" ] || { echo "[1/5] 安装 PB 依赖..."; (cd "$ROOT/pb" && bun install) || exit 1; }
[ -d "$ROOT/pf/node_modules" ] || { echo "[2/5] 安装 PF 依赖..."; (cd "$ROOT/pf" && npm install) || exit 1; }
"$PY" -c "import aiohttp,pydantic,numpy,scipy,sklearn" 2>/dev/null || { echo "[3/5] 安装 SCB 依赖..."; "$PY" -m pip install -r "$ROOT/scb/requirements.txt"; }

# ---------- 构建 PF（把 PB 的局域网地址烘焙进产物，外网设备才能连上） ----------
echo "[4/5] 构建 PF（VITE_PB_URL=ws://$LANIP:3000/ws/pf）..."
export VITE_PB_URL="ws://$LANIP:3000/ws/pf"
(cd "$ROOT/pf" && npm run build) || { echo "[错误] PF 构建失败"; exit 1; }

PIDS=()
cleanup() { echo; echo "正在停止服务..."; for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null; done; }
trap cleanup EXIT INT TERM

# ---------- 启动服务（PF preview 监听 0.0.0.0） ----------
echo "[5/5] 启动服务（日志写入 $LOGS）..."
(cd "$ROOT/pb" && exec bun run dev)       >"$LOGS/pb.log"         2>&1 & PIDS+=($!)
(cd "$ROOT"    && exec "$PY" -m scb.main) >"$LOGS/scb.log"        2>&1 & PIDS+=($!)
(cd "$ROOT/pf" && exec npm run preview)   >"$LOGS/pf-preview.log" 2>&1 & PIDS+=($!)

# 等待 PF 端口就绪（最多 15s）
for _ in $(seq 1 15); do
  (exec 3<>/dev/tcp/127.0.0.1/5174) 2>/dev/null && { exec 3>&- 3<&-; break; }
  sleep 1
done

echo "已启动（预览模式）  PID: ${PIDS[*]}"
echo "  本机访问：  http://localhost:5174"
echo "  外部设备：  http://$LANIP:5174   （手机/其他电脑连同一网络）"
echo "按 Ctrl+C 停止全部服务"

( sleep 3; xdg-open http://localhost:5174 >/dev/null 2>&1 || open http://localhost:5174 >/dev/null 2>&1 ) &

tail -F "$LOGS/pb.log" "$LOGS/pf-preview.log" "$LOGS/scb.log" 2>/dev/null & PIDS+=($!)
wait
