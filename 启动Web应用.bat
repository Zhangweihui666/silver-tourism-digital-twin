@echo off
setlocal
cd /d "%~dp0"
set "EXPECTED_VERSION=3.5.0"
set "NODE_EXE="
where node >nul 2>nul
if %errorlevel%==0 set "NODE_EXE=node"
if not defined NODE_EXE if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not defined NODE_EXE (
  echo Node.js 20 or newer is required.
  pause
  exit /b 1
)
set "PORT=8092"
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8092" ^| findstr "LISTENING"') do taskkill /PID %%a /F >nul 2>nul
timeout /t 1 >nul
start "Silver Tourism Studio 3.5.0" /min "%NODE_EXE%" server.mjs
for /l %%i in (1,1,25) do (
  timeout /t 1 >nul
  powershell -NoProfile -Command "try { $v=(Invoke-RestMethod -TimeoutSec 2 ('http://127.0.0.1:8092/api/version?ts=' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())).version; if ($v -eq '%EXPECTED_VERSION%') { exit 0 } } catch {}; exit 1" >nul 2>nul
  if not errorlevel 1 goto ready
)
echo Current 3.5.0 server startup failed. Port 8092 or firewall may be blocking it.
pause
exit /b 1
:ready
start "" "http://127.0.0.1:8092/?v=3.5.0&refresh=%RANDOM%%RANDOM%"
exit /b 0
