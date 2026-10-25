@echo off
chcp 65001 >nul
setlocal
set "ROOT=%~dp0"

echo ================================================
echo   SSVEP 智能家居仿真平台 - 后端启动
echo   PB:3000   SCB:mock 模式
echo ================================================
echo.

REM ---------- 环境检查 ----------
where bun >nul 2>&1 || (echo [错误] 未检测到 bun，请先安装：https://bun.sh & pause & exit /b 1)
set "PY=python"
where python >nul 2>&1 || set "PY=py"
%PY% --version >nul 2>&1 || (echo [错误] 未检测到 Python，请先安装 Python 3.10+ & pause & exit /b 1)

REM ---------- 依赖安装（缺才装） ----------
if not exist "%ROOT%pb\node_modules" (
  echo [1/2] 安装 PB 依赖...
  pushd "%ROOT%pb" && bun install && popd
)
%PY% -c "import aiohttp,pydantic,numpy,scipy,sklearn" >nul 2>&1 || (
  echo [2/2] 安装 SCB 依赖...
  %PY% -m pip install -r "%ROOT%scb\requirements.txt"
)

REM ---------- 启动服务（各自独立窗口，便于查看日志） ----------
echo 启动服务...
start "PB 仿真状态层 :3000" cmd /k "cd /d "%ROOT%pb" && bun run dev"
timeout /t 2 /nobreak >nul
start "SCB 意图抽象层 mock" cmd /k "cd /d "%ROOT%" && %PY% -m scb.main"

echo.
echo 已启动：PB(:3000)  SCB(mock)
echo 状态接口：http://localhost:3000/api/state
echo 前端请另运行 start-frontend.bat（预览模式，可局域网访问）
echo          或 start-frontend-dev.bat（开发模式，仅本机）
echo 关闭：逐个关闭弹出的命令行窗口（或窗口内 Ctrl+C）
echo.
pause
