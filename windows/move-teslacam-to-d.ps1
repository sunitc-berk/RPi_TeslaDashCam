# move-teslacam-to-d.ps1 - move C:\TeslaCam (footage + dashboard) to D:\TeslaCam and send new uploads there.
#
# Run in an *Administrator* PowerShell (right-click PowerShell > Run as administrator):
#   powershell -ExecutionPolicy Bypass -File C:\work\RPi_TeslaDashCam\windows\move-teslacam-to-d.ps1
#
# What it does:
#   1. checks that D: has room and asks you to confirm
#   2. stops the dashboard
#   3. points the \\<PC>\TeslaCam network share at D:\TeslaCam - from this moment the Pi uploads to D:
#      (the Pi only knows the share name "TeslaCam", so nothing changes on the Pi)
#   4. moves everything from C:\TeslaCam to D:\TeslaCam. Each file is deleted from C: only after it has
#      been copied to D:. Safe to stop (Ctrl+C) and run again - it continues where it left off.
#   5. sets the dashboard up in D:\TeslaCam\webapp and starts it again (if it was set to start at login)
# A log is written to D:\TeslaCam-move.log.

param([string]$From = "C:\TeslaCam", [string]$To = "D:\TeslaCam")

$ErrorActionPreference = "Stop"
$ShareName = "TeslaCam"
$UserName  = "teslapi"
$TaskName  = "TeslaCam Dashboard"
$Drive     = Split-Path -Qualifier $To              # "D:"
$Log       = "$Drive\TeslaCam-move.log"
$Venv      = "$From\webapp\.venv"                   # not moved - Python environments can't be moved; rebuilt on D:

function Say($msg) { Write-Host ""; Write-Host "== $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host ""; Write-Host $msg -ForegroundColor Red; exit 1 }
function Files($dir) {                              # every file under $dir except the Python environment
    if (-not (Test-Path $dir)) { return @() }
    @(Get-ChildItem -LiteralPath $dir -Recurse -File -Force -ErrorAction SilentlyContinue |
      Where-Object { -not $_.FullName.StartsWith("$Venv\", [StringComparison]::OrdinalIgnoreCase) })
}

# ---------------------------------------------------------------- 1. checks
$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Fail "Please run this in an Administrator PowerShell (right-click PowerShell > Run as administrator)."
}
$vol = Get-Volume -DriveLetter $Drive.Substring(0, 1) -ErrorAction SilentlyContinue
if (-not $vol) { Fail "Drive $Drive was not found. Is the D: drive connected?" }

$todo = Files $From
$bytes = ($todo | Measure-Object -Property Length -Sum).Sum
if (-not $bytes) { $bytes = 0 }
$gb = [math]::Round($bytes / 1GB, 1)
$freeGb = [math]::Round($vol.SizeRemaining / 1GB, 1)

Say "Move $From to $To"
Write-Host "  To move:     $($todo.Count) files, $gb GB"
Write-Host "  Free on ${Drive}    $freeGb GB ($($vol.FileSystemType))"
if ($bytes -gt 0 -and $vol.SizeRemaining -lt $bytes + 10GB) {
    Fail "Not enough room on $Drive - it needs $gb GB plus 10 GB to spare. Free some space and run again."
}
if ($vol.FileSystemType -ne "NTFS") {
    Write-Host "  Note: $Drive is $($vol.FileSystemType), not NTFS. It works, but Favorites will take extra space" -ForegroundColor Yellow
    Write-Host "  (NTFS lets them share space with the original footage)." -ForegroundColor Yellow
}
Write-Host ""
Write-Host "  The dashboard is stopped during the move. Large moves take a while (roughly an hour per 300-500 GB)."
if ((Read-Host "  Type YES to start") -ne "YES") { Write-Host "Cancelled - nothing was changed."; exit 1 }

# ---------------------------------------------------------------- 2. stop the dashboard
Say "Stopping the dashboard"
$port = 8080
foreach ($sf in @("$From\webapp\settings.json", "$To\webapp\settings.json")) {
    if (Test-Path $sf) { try { $p = (Get-Content $sf -Raw | ConvertFrom-Json).port; if ($p) { $port = [int]$p } } catch {} }
}
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 3
Write-Host "  Stopped (it was listening on port $port)."

# ---------------------------------------------------------------- 3. point the share at D:
Say "Pointing the \\$env:COMPUTERNAME\$ShareName share at $To"
New-Item -ItemType Directory -Force -Path $To | Out-Null
icacls $To /grant "${UserName}:(OI)(CI)M" | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host "  Could not give '$UserName' write access to $To (icacls exit $LASTEXITCODE)." -ForegroundColor Yellow }
$old = Get-SmbShare -Name $ShareName -ErrorAction SilentlyContinue
if ($old -and $old.Path -eq $To) {
    Write-Host "  Already points at $To."
} else {
    $access = @()
    if ($old) {
        $access = @(Get-SmbShareAccess -Name $ShareName | Where-Object { "$($_.AccessControlType)" -eq "Allow" })
        Remove-SmbShare -Name $ShareName -Force
    }
    New-SmbShare -Name $ShareName -Path $To -ChangeAccess $UserName | Out-Null
    foreach ($a in $access) {                       # keep any other access the old share had
        Grant-SmbShareAccess -Name $ShareName -AccountName $a.AccountName -AccessRight $a.AccessRight -Force -ErrorAction SilentlyContinue | Out-Null
    }
    Write-Host "  Done - new uploads from the Pi now go to $To."
}

# ---------------------------------------------------------------- 4. move the files
if (Test-Path $From) {
    Say "Moving files (log: $Log)"
    # Footage is never changed after it is written, so a normal move is right (it also redoes a file that
    # was half-copied when a previous run was stopped).
    robocopy $From $To /E /MOVE /COPY:DAT /DCOPY:T /J /R:2 /W:5 /XD $Venv "$From\PiMetrics" /NDL /NP /TEE "/LOG+:$Log"
    if ($LASTEXITCODE -ge 8) { Fail "Some files could not be moved (robocopy exit $LASTEXITCODE). See $Log, then run this script again." }
    # Pi metrics and logs: the Pi may already have written newer copies to D: - never overwrite those (/XO).
    if (Test-Path "$From\PiMetrics") {
        robocopy "$From\PiMetrics" "$To\PiMetrics" /E /MOVE /XO /COPY:DAT /DCOPY:T /R:2 /W:5 /NDL /NP /TEE "/LOG+:$Log"
        if ($LASTEXITCODE -ge 8) { Fail "Some Pi metrics files could not be moved (robocopy exit $LASTEXITCODE). See $Log, then run again." }
    }

    # Anything left on C: is a file robocopy skipped because D: already has it (or a newer copy from the Pi).
    # Delete the C: copy only when the D: copy is at least as big and at least as new.
    foreach ($f in (Files $From)) {
        $d = Get-Item -LiteralPath ($To + $f.FullName.Substring($From.Length)) -Force -ErrorAction SilentlyContinue
        if ($d -and $d.Length -ge $f.Length -and $d.LastWriteTime -ge $f.LastWriteTime) {
            Remove-Item -LiteralPath $f.FullName -Force
        }
    }
    $left = Files $From
    if ($left.Count -gt 0) {
        Write-Host ""
        Write-Host "$($left.Count) file(s) are still on C: (maybe open in another program):" -ForegroundColor Yellow
        $left | Select-Object -First 10 | ForEach-Object { Write-Host "  $($_.FullName)" }
        Fail "Close whatever has them open and run this script again. The dashboard stays stopped until then."
    }
    Remove-Item -LiteralPath $From -Recurse -Force -ErrorAction SilentlyContinue   # only the old Python environment and empty folders remain
    if (Test-Path $From) { Write-Host "  $From is empty now - delete it yourself if Windows would not let this script." -ForegroundColor Yellow }
    else { Write-Host "  $From removed." }
} else {
    Say "$From is already gone - nothing left to move"
}

# ---------------------------------------------------------------- 5. dashboard on D:
$Web = "$To\webapp"
if (-not (Test-Path "$Web\server.py")) { Fail "$Web\server.py is missing - the dashboard files did not arrive on $Drive." }
$sf = "$Web\settings.json"
if (Test-Path $sf) {                                # the dashboard finds its footage in the folder above it; drop any old C: path
    $s = Get-Content $sf -Raw | ConvertFrom-Json
    if ($s.root -and "$($s.root)" -like "C:*") {
        $s.root = $null
        $s | ConvertTo-Json | Set-Content -Path $sf -Encoding ASCII
        Write-Host "  settings.json: footage folder is now the folder above webapp ($To)."
    }
}
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Say "Setting up the dashboard on $Drive (this takes a minute)"
    if (-not (Test-Path "$Web\.venv\Scripts\python.exe")) {
        if (Get-Command py -ErrorAction SilentlyContinue) { & py -3 -m venv "$Web\.venv" } else { & python -m venv "$Web\.venv" }
        & "$Web\.venv\Scripts\python.exe" -m pip install -q -r "$Web\requirements.txt"
        if ($LASTEXITCODE -ne 0) { Fail "Installing the dashboard's Python packages failed. Run $Web\start-dashboard.bat once, then $Web\install-autostart.ps1." }
    }
    & "$Web\install-autostart.ps1"                 # re-points the login task at D: and starts it
    Say "All done. Footage and dashboard are in $To; open http://localhost:$port"
} else {
    Say "All done. Footage and dashboard are in $To"
    Write-Host "  Start the dashboard by double-clicking $Web\start-dashboard.bat"
    Write-Host "  (the first start takes a minute while it sets up Python)."
}
