# allow-jaspreet.ps1 - run ONCE as Administrator on each office server PC (PC A = editor server, PC B = bridge / standby).
# Gives the coding PC (JASPREET, 192.168.0.210) lasting access to this PC, so code changes, fixes and checks can always
# be done from there - also by Claude on JASPREET:
#   1. OpenSSH Server: sign-in only with JASPREET's key (no passwords), PowerShell as its shell, starts with Windows
#   2. Remote Desktop: on, with Network Level Authentication
#   3. Windows Firewall: SSH (22) and Remote Desktop (3389) open ONLY to JASPREET (and the MeshLink range, for home)
# The key file next to this script is JASPREET's PUBLIC key - safe to keep on the NAS; the private half never leaves JASPREET.
# To take the access away again:  Remove-Item C:\ProgramData\ssh\administrators_authorized_keys; Stop-Service sshd
param([string]$From = '192.168.0.210')
$ErrorActionPreference = 'Stop'
function Say($t, $c = 'Gray') { Write-Host $t -ForegroundColor $c }
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Say 'Right-click "Allow JASPREET (run as Administrator).bat" and choose "Run as administrator".' Yellow; exit 1
}
$key = Join-Path $PSScriptRoot 'jaspreet.pub'
if (-not (Test-Path $key)) { Say "jaspreet.pub is missing next to this script." Red; exit 1 }
$remote = @($From, '100.64.0.0/10') # (JASPREET in the office; MeshLink addresses when working from home)

Say "`n1/3  OpenSSH Server..." Cyan
if (-not (Get-Service sshd -ErrorAction SilentlyContinue)) {
  # first from the installer next to this script (Microsoft's signed OpenSSH MSI) - no internet needed
  $msi = Get-ChildItem $PSScriptRoot -Filter 'OpenSSH-Win64-*.msi' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($msi -and (Get-AuthenticodeSignature $msi.FullName).Status -eq 'Valid') {
    Say "      installing from $($msi.Name) (no internet needed)..."
    $local = Join-Path $env:TEMP $msi.Name; Copy-Item $msi.FullName $local -Force
    Start-Process msiexec.exe -ArgumentList "/i `"$local`" ADDLOCAL=Server /qn /norestart" -Wait
  }
}
if (-not (Get-Service sshd -ErrorAction SilentlyContinue)) {
  Say '      installing (needs the internet, a minute or two)...'
  try {
    $cap = Get-WindowsCapability -Online -Name 'OpenSSH.Server*' | Select-Object -First 1
    Add-WindowsCapability -Online -Name $cap.Name | Out-Null
  } catch { Say "      Windows' own installer failed ($($_.Exception.Message)) - trying winget" Yellow }
  # (Windows Update blocked or slow: the same OpenSSH from Microsoft through winget)
  if (-not (Get-Service sshd -ErrorAction SilentlyContinue)) { & winget install -e --id Microsoft.OpenSSH.Preview --scope machine --silent --accept-package-agreements --accept-source-agreements | Out-Null }
  if (-not (Get-Service sshd -ErrorAction SilentlyContinue)) { Say '      OpenSSH could not be installed - send Claude a photo of this window.' Red; exit 1 }
}
Set-Service sshd -StartupType Automatic; Start-Service sshd
# (the first start writes sshd_config)
for ($i = 0; $i -lt 20 -and -not (Test-Path 'C:\ProgramData\ssh\sshd_config'); $i++) { Start-Sleep -Milliseconds 500 }
New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -PropertyType String -Force | Out-Null
# keys only: no password sign-in over SSH
$cfg = 'C:\ProgramData\ssh\sshd_config'
$t = Get-Content $cfg -Raw
if ($t -notmatch '(?m)^PasswordAuthentication no') { $t = $t -replace '(?m)^#?PasswordAuthentication .*$', 'PasswordAuthentication no'; if ($t -notmatch '(?m)^PasswordAuthentication no') { $t = "PasswordAuthentication no`r`n" + $t } }
Set-Content -Path $cfg -Value $t -Encoding ascii
# an administrator's keys live here (not in the user's .ssh); only SYSTEM and Administrators may read it, or sshd ignores it
$ak = 'C:\ProgramData\ssh\administrators_authorized_keys'
$pub = (Get-Content $key -Raw).Trim()
$have = if (Test-Path $ak) { Get-Content $ak } else { @() }
if ($have -notcontains $pub) { Add-Content -Path $ak -Value $pub -Encoding ascii }
& icacls.exe $ak /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F' | Out-Null
Restart-Service sshd
Say '      on - JASPREET signs in with its key' Green

Say "`n2/3  Remote Desktop..." Cyan
Set-ItemProperty 'HKLM:\System\CurrentControlSet\Control\Terminal Server' -Name fDenyTSConnections -Value 0
Set-ItemProperty 'HKLM:\System\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp' -Name UserAuthentication -Value 1
Say '      on (with Network Level Authentication)' Green

Say "`n3/3  Firewall: only JASPREET (and MeshLink)..." Cyan
Get-NetFirewallRule -DisplayName 'Limelight access *' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
# (Windows' own wide rules for these ports off - ours below allow only JASPREET)
Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue | Disable-NetFirewallRule
# (the MSI's own "OpenSSH SSH Server" rule, open to everyone, off too)
Get-NetFirewallRule -Direction Inbound -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'OpenSSH|sshd' -and $_.DisplayName -notlike 'Limelight access*' } | Disable-NetFirewallRule
Get-NetFirewallRule -DisplayGroup 'Remote Desktop' -ErrorAction SilentlyContinue | Disable-NetFirewallRule
New-NetFirewallRule -DisplayName 'Limelight access (SSH from JASPREET)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 22 -RemoteAddress $remote -Profile Any | Out-Null
New-NetFirewallRule -DisplayName 'Limelight access (Remote Desktop from JASPREET)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3389 -RemoteAddress $remote -Profile Any | Out-Null
Say "      SSH (22) and Remote Desktop (3389) open to $($remote -join ', ')" Green

Say "`nDone on $env:COMPUTERNAME ($env:USERNAME). From JASPREET:" Cyan
Say "   ssh -i %USERPROFILE%\.ssh\limelight_office $env:USERNAME@<this PC's IP>"
Say "   Remote Desktop: mstsc /v:<this PC's IP>"
