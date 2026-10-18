@echo off
chcp 65001 >nul
setlocal
set "ROOT=%~dp0"

echo ================================================
echo   SSVEP 智能家居仿真平台 - 一键启动
echo   PB:3000   PF:5173   SCB:mock 模式
echo ================================================
echo.

REM ---------- 环境检查 ----------
where bun >nul 2>&1 || (echo [错误] 未检测到 bun，请先安装：https://bun.sh & pause & exit /b 1)
where npm >nul 2>&1 || (echo [错误] 未检测到 npm，请先安装 Node.js & pause & exit /b 1)
set "PY=python"
where python >nul 2>&1 || set "PY=py"
%PY% --version >nul 2>&1 || (echo [错误] 未检测到 Python，请先安装 Python 3.10+ & pause & exit /b 1)

REM ---------- 依赖安装（缺才装） ----------
if not exist "%ROOT%pb\node_modules" (
  echo [1/4] 安装 PB 依赖...
  pushd "%ROOT%pb" && bun install && popd
)
if not exist "%ROOT%pf\node_modules" (
  echo [2/4] 安装 PF 依赖...
  pushd "%ROOT%pf" && npm install && popd
)
%PY% -c "import aiohttp,pydantic,numpy,scipy,sklearn" >nul 2>&1 || (
  echo [3/4] 安装 SCB 依赖...
  %PY% -m pip install -r "%ROOT%scb\requirements.txt"
)

REM ---------- 启动服务（各自独立窗口，便于查看日志） ----------
echo [4/4] 启动服务...
start "PB 仿真状态层 :3000" cmd /k "cd /d "%ROOT%pb" && bun run dev"
start "PF 仿真渲染层 :5173" cmd /k "cd /d "%ROOT%pf" && npm run dev"
timeout /t 2 /nobreak >nul
start "SCB 意图抽象层 mock" cmd /k "cd /d "%ROOT%" && %PY% -m scb.main"

REM 可选：传入 scf 参数同时启动刺激呈现（需 psychopy，Python 3.10-3.12）
if /i "%~1"=="scf" (
  %PY% -c "import psychopy" >nul 2>&1 || echo [警告] 未安装 psychopy（Python 3.13 无发行版，请用 3.10-3.12 环境），SCF 将启动失败
  start "SCF 刺激呈现" cmd /k "cd /d "%ROOT%scf" && %PY% stimulus.py"
)

timeout /t 4 /nobreak >nul
start "" http://localhost:5173

echo.
echo 已启动：PB(:3000)  PF(:5173)  SCB(mock)，浏览器将自动打开 PF 页面
echo 关闭：逐个关闭弹出的命令行窗口（或窗口内 Ctrl+C）
echo 状态接口：http://localhost:3000/api/state
echo.
pause
