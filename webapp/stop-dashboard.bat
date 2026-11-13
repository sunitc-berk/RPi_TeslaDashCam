@echo off
REM Stop the TeslaCam dashboard, whether it was started with start-dashboard.bat or runs hidden at login
schtasks /End /TN "TeslaCam Dashboard" >nul 2>&1
set found=
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R /C:":8080 .*LISTENING"') do (
  taskkill /PID %%p /F >nul 2>&1
  set found=1
)
if defined found (echo TeslaCam dashboard stopped.) else (echo The dashboard was not running.)
timeout /t 3 >nul
