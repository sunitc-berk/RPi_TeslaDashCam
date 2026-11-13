# install-autostart.ps1 - start the TeslaCam dashboard automatically (hidden) when you log in to Windows.
# Run once from PowerShell AFTER start-dashboard.bat has run at least once:
#   powershell -ExecutionPolicy Bypass -File D:\TeslaCam\webapp\install-autostart.ps1
# To remove:  Unregister-ScheduledTask -TaskName "TeslaCam Dashboard" -Confirm:$false

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$py  = Join-Path $dir ".venv\Scripts\pythonw.exe"
if (-not (Test-Path $py)) { Write-Host "Run start-dashboard.bat once first (it sets up Python)."; exit 1 }

$action   = New-ScheduledTaskAction -Execute $py -Argument "server.py" -WorkingDirectory $dir
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
            -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "TeslaCam Dashboard" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName "TeslaCam Dashboard"
Write-Host "TeslaCam Dashboard will now start at every login. Open http://localhost:8080"
