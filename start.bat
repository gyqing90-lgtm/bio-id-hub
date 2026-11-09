@echo off
setlocal
title 物种鉴定聚合台

cd /d "%~dp0"

rem 已经在跑就直接开浏览器，别再来一个进程抢 8791
netstat -an | findstr ":8791" | findstr "LISTENING" >nul
if not errorlevel 1 (
  echo.
  echo   聚合台已经在运行了，正在打开浏览器...
  start "" http://127.0.0.1:8791
  exit /b 0
)

set NODE=
where node >nul 2>nul
if not errorlevel 1 set "NODE=node"
if defined NODE goto run

set "FALLBACK=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if exist "%FALLBACK%" (
  set "NODE=%FALLBACK%"
  goto run
)

echo.
echo   没找到 Node.js。先装一个再双击这个文件：
echo   https://nodejs.org  （选 LTS 版，一路下一步）
echo.
pause
exit /b 1

:run
echo.
echo   物种鉴定聚合台 · 正在启动...
echo   浏览器会自动打开；关掉这个黑窗口就是退出程序。
echo.

%NODE% server.js

echo.
echo   程序已退出。
echo.
pause
