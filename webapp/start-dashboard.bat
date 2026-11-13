@echo off
REM Start the TeslaCam dashboard (first run sets up Python packages)
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (
  echo First run: setting up the Python environment...
  py -3 -m venv .venv 2>nul || python -m venv .venv
  .venv\Scripts\python -m pip install --upgrade pip
  .venv\Scripts\python -m pip install -r requirements.txt
)
start "" http://localhost:8080
.venv\Scripts\python server.py
REM keep the window open only if something went wrong, so the error can be read
if errorlevel 1 pause
