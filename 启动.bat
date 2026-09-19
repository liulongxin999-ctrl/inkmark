@echo off
chcp 65001 >nul
title 墨读 InkMark · 电子书批注与知识整理
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel%==0 (
  echo 正在启动墨读（Node 模式）...
  node server.mjs 8765 --open
  if errorlevel 1 (
    echo.
    echo  ============================================================
    echo   启动没有成功，请把上面的提示内容发给 Codex 帮你处理。
    echo  ============================================================
    pause
  )
  goto end
)

where python >nul 2>nul
if %errorlevel%==0 (
  echo 正在启动墨读（Python 模式）...
  start "" http://localhost:8765/
  python -m http.server 8765
  goto end
)

echo.
echo  [×] 没有找到 Node.js 或 Python，无法启动本地服务。
echo.
echo      请任选一种方式安装后重试：
echo        Node.js  https://nodejs.org
echo        Python   https://www.python.org/downloads/
echo.
echo      也可以直接把 index.html 拖进浏览器，但部分功能会受限。
echo.
pause

:end
