param([Parameter(Mandatory=$true)][string]$Config)
$ErrorActionPreference = 'Stop'
$manager = Join-Path $PSScriptRoot 'manage-pro-tunnel.ps1'
# Logs are written outside version control (the evidence/ directory is never published).
$logDir = if ($env:CONTINUITY_LOG_DIR) { $env:CONTINUITY_LOG_DIR } else { Join-Path $PSScriptRoot '../evidence' }
if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$logFile = Join-Path $logDir 'pro-login-start.log'
# Login can precede networking or the user's proxy. Retry connection startup only;
# manage-pro-tunnel's preflight still refuses interrupted/unknown file operations.
for ($attempt = 1; $attempt -le 12; $attempt++) {
  try {
    $output = & powershell -NoProfile -File $manager start -Config $Config 2>&1
    $code = $LASTEXITCODE
    Add-Content -LiteralPath $logFile -Value ((Get-Date -Format o) + ' attempt=' + $attempt + ' exit=' + $code)
    if ($code -eq 0) { exit 0 }
  } catch { Add-Content -LiteralPath $logFile -Value ((Get-Date -Format o) + ' startup_failed') }
  Start-Sleep -Seconds 10
}
exit 1
