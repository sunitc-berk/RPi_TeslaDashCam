# setup-share.ps1 - run ONCE on the Windows PC in an *Administrator* PowerShell:
#   powershell -ExecutionPolicy Bypass -File C:\work\RPi_TeslaDashCam\windows\setup-share.ps1
#
# Creates D:\TeslaCam, a local user "teslapi" that only the Pi uses, and a network share
# \\<this PC>\TeslaCam that the teslapi user can write to.
# (Moving an existing C:\TeslaCam to D: is done by move-teslacam-to-d.ps1 instead.)

$Folder    = "D:\TeslaCam"     # where the footage lives (was C:\TeslaCam until November 2026)
$ShareName = "TeslaCam"
$UserName  = "teslapi"

# 1. Folder
New-Item -ItemType Directory -Force -Path $Folder | Out-Null

# 2. Local user for the Pi
if (-not (Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue)) {
    $pw = Read-Host -AsSecureString "Choose a password for the '$UserName' account (the Pi will use it)"
    New-LocalUser -Name $UserName -Password $pw -PasswordNeverExpires -AccountNeverExpires `
        -Description "Raspberry Pi dashcam uploader" | Out-Null
    Write-Host "Created local user $UserName"
}

# 3. Share + folder permissions
if (-not (Get-SmbShare -Name $ShareName -ErrorAction SilentlyContinue)) {
    New-SmbShare -Name $ShareName -Path $Folder -ChangeAccess $UserName | Out-Null
    Write-Host "Created share \\$env:COMPUTERNAME\$ShareName"
}
icacls $Folder /grant "${UserName}:(OI)(CI)M" | Out-Null

# 4. Allow file sharing on the home network
Get-NetConnectionProfile | Where-Object NetworkCategory -eq 'Public' |
    Set-NetConnectionProfile -NetworkCategory Private
Enable-NetFirewallRule -DisplayGroup "File and Printer Sharing" -ErrorAction SilentlyContinue

# 5. Show the IP address the Pi should use
Write-Host ""
Write-Host "Done. This PC's IP address(es):"
Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    Format-Table InterfaceAlias, IPAddress -AutoSize
