@echo off
chcp 65001 >nul
title 墨读 · 找回旧存档
cd /d "%~dp0"

echo.
echo   墨读的存档跟"网址"绑在一起。如果你以前上传过书，
echo   但重新打开后书库是空的，很可能是因为当时打开的端口不是 8765。
echo.
echo   这个工具会在你指定的端口上启动墨读，用来把旧存档找回来。
echo.
echo   常见端口：8766 / 8767 / 8768
echo.

set "p="
set /p "p=请输入要检查的端口（直接回车 = 8766）: "
if "%p%"=="" set "p=8766"

echo.
echo   即将在端口 %p% 上启动墨读。
echo.
echo   打开后请看「书库」：
echo     · 如果看到了你以前的书  →  进入【设置 → 数据 → 导出备份】，
echo       然后关掉这个窗口，双击「启动.bat」回到标准地址（8765），
echo       再用【设置 → 数据 → 导入备份】把书导回来。
echo     · 如果还是空的       →  关掉窗口，用别的端口再试一次。
echo.
echo   （由于换网址后浏览器会把它当成另一个网站，所以必须这样搬运一次。）
echo.
pause

where node >nul 2>nul
if not %errorlevel%==0 (
  echo [x] 需要 Node.js 才能运行，请先安装：https://nodejs.org
  pause
  exit /b 1
)

rem 和「启动.bat」保持一致：支持的机器上带 --use-system-ca，
rem 否则有代理做 HTTPS 解密的用户会一直「连不上模型服务」
node --use-system-ca -e "0" >nul 2>nul
if errorlevel 1 (
  node server.mjs %p% --open --allow-port-change
) else (
  node --use-system-ca server.mjs %p% --open --allow-port-change
)
echo.
pause
