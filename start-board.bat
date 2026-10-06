@echo off
title BQ Board - BaiQu Inventory (port 8792)
cd /d "%~dp0backend"

echo ============================================================
echo    BQ Board  -  one click start
echo    (BaiQu KuCun GuanLi kanban / port 8792)
echo ============================================================

rem ---- already running? just open the browser ----
netstat -ano | findstr ":8792" | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
  echo [OK] Board is already running. Opening browser...
  start "" http://localhost:8792
  exit /b 0
)

rem ---- first run: install backend deps ----
if not exist "node_modules" (
  echo [FIRST RUN] Installing backend dependencies, 1-2 min...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [ERROR] npm install failed. Check network and retry.
    pause
    exit /b 1
  )
)

rem ---- frontend missing: build it (normally not needed) ----
if not exist "public\index.html" (
  echo [FIX] Frontend not built. Building...
  if not exist "..\frontend\node_modules" (
    pushd ..\frontend
    call npm install --no-audit --no-fund
    popd
  )
  pushd ..\frontend
  call npm run build
  popd
)

echo [START] Local:   http://localhost:8792
echo [START] LAN:     use this PC's IP with port 8792 (see log below)
echo [NOTE]  Closing this window STOPS the board.
echo [NOTE]  To stop, run stop-board.bat or close this window.
echo ============================================================
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep 3; Start-Process 'http://localhost:8792'"
npx tsx src/index.ts
echo Board service exited.
pause
