@echo off
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8092" ^| findstr "LISTENING"') do taskkill /PID %%a /F >nul 2>nul
exit /b 0