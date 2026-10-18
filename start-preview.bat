@echo off
chcp 65001 >nul
setlocal
set "ROOT=%~dp0"

echo ================================================
echo   SSVEP 智能家居仿真平台 - 预览模式（可外网访问）
echo   构建产物经 vite preview 对局域网开放
echo   PB:3000   PF:5173   SCB:mock 模式
echo ================================================
echo.

REM ---------- 环境检查 ----------
where bun >nul 2>&1 || (echo [错误] 未检测到 bun，请先安装：https://bun.sh & pause & exit /b 1)
where npm >nul 2>&1 || (echo [错误] 未检测到 npm，请先安装 Node.js & pause & exit /b 1)
set "PY=python"
where python >nul 2>&1 || set "PY=py"
%PY% --version >nul 2>&1 || (echo [错误] 未检测到 Python & pause & exit /b 1)

REM ---------- 探测局域网 IP（供外部设备连接） ----------
set "LANIP="
for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -match '^(192\.168|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)' } | Select-Object -First 1 -ExpandProperty IPAddress)"`) do set "LANIP=%%a"
if not defined LANIP set "LANIP=127.0.0.1"
echo 局域网 IP: %LANIP%

REM ---------- 依赖安装（缺才装） ----------
if not exist "%ROOT%pb\node_modules" (
  echo [1/5] 安装 PB 依赖...
  pushd "%ROOT%pb" && bun install && popd
)
if not exist "%ROOT%pf\node_modules" (
  echo [2/5] 安装 PF 依赖...
  pushd "%ROOT%pf" && call npm install && popd
)
%PY% -c "import aiohttp,pydantic,numpy,scipy,sklearn" >nul 2>&1 || (
  echo [3/5] 安装 SCB 依赖...
  %PY% -m pip install -r "%ROOT%scb\requirements.txt"
)

REM ---------- 构建 PF（把 PB 的局域网地址烘焙进产物，外网设备才能连上） ----------
echo [4/5] 构建 PF（VITE_PB_URL=ws://%LANIP%:3000/ws/pf）...
set "VITE_PB_URL=ws://%LANIP%:3000/ws/pf"
pushd "%ROOT%pf" && call npm run build && popd

REM ---------- 启动服务（PB/SCB 本机即可，PF preview 监听 0.0.0.0） ----------
echo [5/5] 启动服务...
start "PB 仿真状态层 :3000" cmd /k "cd /d "%ROOT%pb" && bun run dev"
start "SCB 意图抽象层 mock" cmd /k "cd /d "%ROOT%" && %PY% -m scb.main"
start "PF 预览 :5174" cmd /k "cd /d "%ROOT%pf" && npm run preview"

timeout /t 3 /nobreak >nul
start "" http://localhost:5174

echo.
echo 已启动（预览模式）：PB(:3000)  PF preview(:5174)  SCB(mock)
echo.
echo   本机访问：  http://localhost:5174
echo   外部设备：  http://%LANIP%:5174   （手机/其他电脑连同一 Wi-Fi）
echo.
echo 注意：首次启动 Windows 防火墙可能弹窗，请对 Node.js/Bun 选择「允许访问」
echo       （专用网络）。外部设备通过 VITE_PB_URL 连接 PB 的 WebSocket。
echo.
pause
