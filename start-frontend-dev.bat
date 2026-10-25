@echo off
chcp 65001 >nul
setlocal
set "ROOT=%~dp0"

echo ================================================
echo   SSVEP 智能家居仿真平台 - 前端启动（开发模式）
echo   PF dev:5173（vite 开发服务器，仅本机）  SCF:刺激呈现
echo ================================================
echo.

REM ---------- 环境检查 ----------
where npm >nul 2>&1 || (echo [错误] 未检测到 npm，请先安装 Node.js & pause & exit /b 1)
set "PY=python"
where python >nul 2>&1 || set "PY=py"
%PY% --version >nul 2>&1 || (echo [错误] 未检测到 Python（SCF 需要） & pause & exit /b 1)

REM ---------- 依赖安装 ----------
if not exist "%ROOT%pf\node_modules" (
  echo [1/1] 安装 PF 依赖...
  pushd "%ROOT%pf" && call npm install && popd
)

REM ---------- 启动服务 ----------
start "PF 开发服务器 :5173" cmd /k "cd /d "%ROOT%pf" && npm run dev"
%PY% -c "import psychopy" >nul 2>&1 && (
  start "SCF 刺激呈现" cmd /k "cd /d "%ROOT%scf" && %PY% stimulus.py"
) || echo [警告] 未安装 psychopy（需 Python 3.10-3.12），跳过 SCF 刺激呈现

timeout /t 3 /nobreak >nul
start "" http://localhost:5173

echo.
echo 已启动：PF dev(:5173)  SCF（若已安装 psychopy）
echo 前端地址：http://localhost:5173（vite dev 仅本机可访问）
echo 注意：请先运行 start-backend.bat 启动 PB/SCB，否则页面显示未连接
echo 注意：外部设备访问请改用 start-frontend.bat（预览模式）
echo.
pause
