@echo off
chcp 65001 >nul
setlocal
set "ROOT=%~dp0"

echo ================================================
echo   SSVEP 智能家居仿真平台 - 前端启动（预览模式）
echo   PF preview:5174（构建产物，可局域网访问）  SCF:刺激呈现
echo ================================================
echo.

REM ---------- 环境检查 ----------
where npm >nul 2>&1 || (echo [错误] 未检测到 npm，请先安装 Node.js & pause & exit /b 1)
set "PY=python"
where python >nul 2>&1 || set "PY=py"
%PY% --version >nul 2>&1 || (echo [错误] 未检测到 Python（SCF 需要） & pause & exit /b 1)

REM ---------- 探测局域网 IP（烘焙进 PF 产物，外部设备才能连上 PB） ----------
set "LANIP="
for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -match '^(192\.168|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)' } | Select-Object -First 1 -ExpandProperty IPAddress)"`) do set "LANIP=%%a"
if not defined LANIP set "LANIP=127.0.0.1"
echo 局域网 IP: %LANIP%

REM ---------- 依赖安装 / 构建（把 PB 的局域网地址烘焙进产物） ----------
if not exist "%ROOT%pf\node_modules" (
  echo [1/2] 安装 PF 依赖...
  pushd "%ROOT%pf" && call npm install && popd
)
echo [2/2] 构建 PF（VITE_PB_URL=ws://%LANIP%:3000/ws/pf）...
set "VITE_PB_URL=ws://%LANIP%:3000/ws/pf"
pushd "%ROOT%pf" && call npm run build && popd || (echo [错误] PF 构建失败 & pause & exit /b 1)

REM ---------- 启动服务 ----------
start "PF 预览 :5174" cmd /k "cd /d "%ROOT%pf" && npm run preview"
%PY% -c "import psychopy" >nul 2>&1 && (
  start "SCF 刺激呈现" cmd /k "cd /d "%ROOT%scf" && %PY% stimulus.py"
) || echo [警告] 未安装 psychopy（需 Python 3.10-3.12），跳过 SCF 刺激呈现

timeout /t 3 /nobreak >nul
start "" http://localhost:5174

echo.
echo 已启动：PF preview(:5174)  SCF（若已安装 psychopy）
echo.
echo   本机访问：  http://localhost:5174
echo   外部设备：  http://%LANIP%:5174   （手机/其他电脑连同一 Wi-Fi）
echo.
echo 注意：请先运行 start-backend.bat 启动 PB/SCB，否则页面显示未连接
echo 注意：首次启动 Windows 防火墙可能弹窗，请对 Node.js 选择「允许访问」
echo.
pause
