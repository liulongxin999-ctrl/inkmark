@echo off
chcp 65001 >nul
title 墨读 · 保存并推送到 GitHub
cd /d "%~dp0"

where git >nul 2>nul
if errorlevel 1 (
  echo [x] 没有找到 git，请先安装 Git for Windows。
  pause
  exit /b 1
)

echo [1/3] 运行快速自检 ...
where node >nul 2>nul
if errorlevel 1 (
  echo     跳过（未安装 Node.js）
) else (
  node tests/check-imports.mjs
  if errorlevel 1 (
    echo.
    echo [x] 自检未通过，已中止提交。请把上面的报错发给 Codex 排查。
    pause
    exit /b 1
  )
)

git add -A
git diff --cached --quiet
if not errorlevel 1 (
  echo.
  echo [i] 没有检测到任何改动，无需提交。
  goto end
)

echo.
echo 本次改动的文件：
git diff --cached --name-only
echo.
set "msg="
set /p "msg=请用一句话描述本次改动（直接回车用默认）: "
if "%msg%"=="" set "msg=chore: 更新内容"

echo.
echo [2/3] 提交 ...
git commit -m "%msg%"
if errorlevel 1 goto error

echo.
echo [3/3] 推送到 GitHub ...
git push
if errorlevel 1 goto error

echo.
echo [√] 完成！改动已同步到 GitHub 仓库。
goto end

:error
echo.
echo [x] 出错了，请把上面的错误信息发给 Codex。
pause
exit /b 1

:end
echo.
pause
