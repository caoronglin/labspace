@echo off
rem Tailscale 入口端口自检（Windows 客户端运行）
rem 用法：把本文件放到任意目录，双击运行；或在 CMD 里 tailscale-port-check.bat
setlocal enabledelayedexpansion
set HOST=198.51.100.71
if not "%~1"=="" set HOST=%~1

echo === Tailscale 入口端口自检 ===
echo 目标：%HOST%
echo.

echo [1] Tailscale 连接状态
where tailscale >nul 2>nul
if %errorlevel%==0 (
  tailscale status --self | findstr /i "100." >nul && (echo   已连上 tailnet) || (echo   未连接 tailnet，请先登录 Tailscale)
) else (
  echo   未找到 tailscale 命令（若已装 App 可忽略）
)
echo.

echo [2] 端口连通性（Test-NetConnection）
for %%P in (80 8090 3000 8080 8082 8084 8086 8091 8092 8102 445) do (
  powershell -NoProfile -Command "$t=Test-NetConnection -ComputerName %HOST% -Port %%P -WarningAction SilentlyContinue; if($t.TcpTestSucceeded){Write-Output '  [ OK   ] %%P'}else{Write-Output '  [ FAIL ] %%P'}"
)
echo.

echo [3] HTTP 抽样
for %%U in ("http://%HOST%/" "http://%HOST%:8090/" "http://%HOST%:3000/" "http://%HOST%/cropgenome/") do (
  powershell -NoProfile -Command "try{$r=Invoke-WebRequest -Uri %%U -UseBasicParsing -TimeoutSec 8;Write-Output ('  %%U -> '+$r.StatusCode)}catch{Write-Output '  %%U -> 无响应'}"
)

echo.
echo 判读：全部 OK = Tailscale 入口正常；全部 FAIL = 没连上 tailnet 或 tailnet ACL 拦截；个别 FAIL = 服务端该端口未监听。
pause
