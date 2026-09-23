param([ValidateSet('install','remove','status')][string]$Action = 'install', [string]$Config)
$ErrorActionPreference = 'Stop'
$startupDir = [Environment]::GetFolderPath('Startup')
$shortcutFile = Join-Path $startupDir 'Continuity Pro.lnk'
if ($Action -eq 'status') { [pscustomobject]@{installed=(Test-Path -LiteralPath $shortcutFile); path=$shortcutFile} | ConvertTo-Json; exit 0 }
if ($Action -eq 'remove') { if (Test-Path -LiteralPath $shortcutFile) { Remove-Item -LiteralPath $shortcutFile }; exit 0 }
if (-not $Config) { $Config = Join-Path $PSScriptRoot '../config/pro.local.json' }
$Config = (Resolve-Path -LiteralPath $Config).Path
$launcher = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'start-pro-at-login.ps1')).Path
if ($Config.Contains('"') -or $launcher.Contains('"')) { throw 'Invalid path' }
$shellObject = New-Object -ComObject WScript.Shell
$shortcut = $shellObject.CreateShortcut($shortcutFile)
$shortcut.TargetPath = (Get-Command powershell.exe -CommandType Application).Source
$shortcut.Arguments = '-NoProfile -WindowStyle Hidden -File "' + $launcher + '" -Config "' + $Config + '"'
$shortcut.WorkingDirectory = Split-Path -Parent $PSScriptRoot
$shortcut.WindowStyle = 7
$shortcut.Description = 'Start the configured local ChatGPT development bridge at login'
$shortcut.Save()
[pscustomobject]@{installed=(Test-Path -LiteralPath $shortcutFile); config=$Config; path=$shortcutFile; secrets_stored=$false} | ConvertTo-Json
