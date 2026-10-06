@echo off
title BQ Board - stop
echo Stopping BQ Board (port 8792)...
set FOUND=0
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8792" ^| findstr "LISTENING"') do (
  taskkill /PID %%p /F >nul 2>&1
  echo   killed PID %%p
  set FOUND=1
)
if "%FOUND%"=="0" echo   Board is not running.
pause
