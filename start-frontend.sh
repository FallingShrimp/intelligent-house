#!/usr/bin/env bash
# SSVEP 智能家居仿真平台 - 前端一键启动（预览模式：PF preview + SCF）
# 用法：./start-frontend.sh
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

# ---------- 探测局域网 IP（烘焙进 PF 产物，外部设备才能连上 PB） ----------
LANIP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -z "$LANIP" ] && LANIP="$(ip route get 1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1)"
[ -z "$LANIP" ] && LANIP="127.0.0.1"
echo "局域网 IP: $LANIP"

echo "========================================"
echo "  SSVEP 智能家居仿真平台 - 前端启动（预览模式）"
echo "  PF preview:5174   SCF:刺激呈现"
echo "========================================"

# ---------- 依赖安装 / 构建（WS 走 5174 同源代理转发到本机 PB，无需烘焙地址） ----------
[ -d "$ROOT/pf/node_modules" ] || { echo "[1/2] 安装 PF 依赖..."; (cd "$ROOT/pf" && npm install) || exit 1; }
echo "[2/2] 构建 PF..."
(cd "$ROOT/pf" && npm run build) || { echo "[错误] PF 构建失败"; exit 1; }

PIDS=()
cleanup() { echo; echo "正在停止服务..."; for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null; done; }
trap cleanup EXIT INT TERM

# ---------- 启动服务 ----------
(cd "$ROOT/pf" && exec npm run preview) >"$LOGS/pf-preview.log" 2>&1 & PIDS+=($!)

# SCF：已安装 psychopy 才启动（需 Python 3.10-3.12）
if "$PY" -c "import psychopy" 2>/dev/null; then
  (cd "$ROOT/scf" && exec "$PY" stimulus.py) >"$LOGS/scf.log" 2>&1 & PIDS+=($!)
else
  echo "[警告] 未安装 psychopy（需 Python 3.10-3.12），跳过 SCF 刺激呈现"
fi

# 等待 PF 端口就绪（最多 15s）
for _ in $(seq 1 15); do
  (exec 3<>/dev/tcp/127.0.0.1/5174) 2>/dev/null && { exec 3>&- 3<&-; break; }
  sleep 1
done

echo "已启动（预览模式）  PID: ${PIDS[*]}"
echo "  本机访问：  http://localhost:5174"
echo "  外部设备：  http://$LANIP:5174   （手机/其他电脑连同一网络）"
echo "注意：请先运行 ./start-backend.sh 启动 PB/SCB，否则页面显示未连接"
echo "按 Ctrl+C 停止全部服务"

( sleep 3; xdg-open http://localhost:5174 >/dev/null 2>&1 || open http://localhost:5174 >/dev/null 2>&1 ) &

tail -F "$LOGS/pf-preview.log" "$LOGS/scf.log" 2>/dev/null & PIDS+=($!)
wait
