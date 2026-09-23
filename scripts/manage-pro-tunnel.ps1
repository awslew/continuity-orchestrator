param([ValidateSet('start','status','stop')][string]$Action = 'start', [string]$Config, [switch]$Force)
$ErrorActionPreference = 'Stop'
$workspaceRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$tunnelRoot = if ($env:CONTINUITY_TUNNEL_CLIENT_ROOT) { $env:CONTINUITY_TUNNEL_CLIENT_ROOT } else { Join-Path $workspaceRoot 'tunnel-client' }
$exe = Join-Path $tunnelRoot 'tunnel-client.exe'
$profiles = Join-Path $tunnelRoot 'profiles'
$entry = Join-Path $PSScriptRoot 'start-pro-local.mjs'
if (-not $Config) { $Config = Join-Path $PSScriptRoot '../config/pro.local.json' }
$Config = (Resolve-Path -LiteralPath $Config).Path
$normalizedEntry = $entry.Replace('\', '/')
$normalizedConfig = $Config.Replace('\', '/')
if ($normalizedEntry.Contains('"') -or $normalizedConfig.Contains('"')) { throw 'Invalid launch path' }
$mcpCommand = 'node "' + $normalizedEntry + '" "' + $normalizedConfig + '"'
if (-not $env:CONTROL_PLANE_API_KEY) {
  $env:CONTROL_PLANE_API_KEY = [Environment]::GetEnvironmentVariable('CONTROL_PLANE_API_KEY', 'User')
}
# A proxy is only used when the operator has already configured one. There is no built-in
# default: this script must not assume any particular local proxy port.
if ($env:CONTROL_PLANE_HTTP_PROXY -and -not $env:HTTPS_PROXY) { $env:HTTPS_PROXY = $env:CONTROL_PLANE_HTTP_PROXY }
if ($Action -eq 'stop') {
  $localConfig = Get-Content -Raw -LiteralPath $Config | ConvertFrom-Json
  # A round runs in its own process, but it is started BY the Pro entry below, and its
  # output is written into state_dir/tasks.json — the same file, not a copy of it. So the
  # kill below takes every in-flight round with it. That is not something the worker can be
  # made to survive; it is something the operator should be told before it happens, because
  # a round stopped mid-apply leaves files half-written and the task flagged for local
  # inspection. An interrupted VALIDATION is harmless (nothing was written yet) and is
  # reported the same way rather than being hidden.
  if ($localConfig.editor) {
    $tasksFile = Join-Path $localConfig.editor.state_dir 'tasks.json'
    if (Test-Path -LiteralPath $tasksFile) {
      $inFlight = @((Get-Content -Raw -LiteralPath $tasksFile | ConvertFrom-Json).tasks |
        Where-Object { $_.state -in @('validating', 'applying', 'rolling_back') })
      if ($inFlight.Count -gt 0 -and -not $Force) {
        $listed = ($inFlight | ForEach-Object { $_.id.Substring(0, 8) + '=' + $_.state }) -join ', '
        throw ("A round is still running ($listed). Stopping now kills it and can leave files half-written. " +
          "Wait for it to reach a final state, or read it with continuity_local_result, then stop. " +
          "Re-run with -Force to stop anyway and reconcile the task locally.")
      }
      if ($inFlight.Count -gt 0) { Write-Warning "Stopping with a round in flight: $(($inFlight | ForEach-Object { $_.id.Substring(0, 8) }) -join ', ')" }
    }
  }
  $leaseFiles = @()
  if ($localConfig.bridge) { $leaseFiles += ($localConfig.bridge.workspaces_config + '.pro-state.json.lock/owner.json') }
  if ($localConfig.editor) { $leaseFiles += (Join-Path $localConfig.editor.state_dir 'instance.lock/owner.json') }
  $ownerIds = @($leaseFiles | Where-Object { Test-Path -LiteralPath $_ } | ForEach-Object { (Get-Content -Raw -LiteralPath $_ | ConvertFrom-Json).pid } | Select-Object -Unique)
  $result = & $exe runtimes stop continuity-pro --json | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or $result.process_running) { throw 'Tunnel did not stop' }
  # tunnel-client on Windows can leave its stdio grandchildren alive. Stop only
  # the exact Pro entry owned by these leases, after its Tunnel has stopped.
  $proEntry = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../dist/src/project-reader/pro.js'))
  $nodeExecutable = (Get-Command node -CommandType Application).Source
  foreach ($ownerId in $ownerIds) {
    $ownedProcess = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$ownerId)
    if (-not $ownedProcess) { continue }
    $expected = '"' + $nodeExecutable + '" ' + $proEntry
    $expectedQuoted = '"' + $nodeExecutable + '" "' + $proEntry + '"'
    if ($ownedProcess.Name -ne 'node.exe' -or ($ownedProcess.CommandLine -ne $expected -and $ownedProcess.CommandLine -ne $expectedQuoted)) { throw 'Lease PID does not match this Pro entry; refusing to stop it' }
    & taskkill /PID ([string]$ownerId) /T /F | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not stop the owned Pro process tree' }
  }
  [pscustomobject]@{ alias='continuity-pro'; stopped=$true; edits_replayed=$false } | ConvertTo-Json
  exit 0
}
if ($Action -eq 'start') {
  if (-not $env:CONTROL_PLANE_API_KEY) { throw 'No existing Tunnel runtime credential in process/user environment. Never paste credentials into chat.' }
  $original = Get-Content -Raw (Join-Path $profiles 'local-stdio.yaml')
  $match = [regex]::Match($original, 'tunnel_id:\s*"?([^"\s]+)')
  if (-not $match.Success) { throw 'Existing Tunnel ID missing' }
  $before = & $exe runtimes status continuity-pro --json | ConvertFrom-Json
  if (-not $before.process_running) {
    & node (Join-Path $PSScriptRoot 'prepare-pro-start.mjs') $Config
    if ($LASTEXITCODE -ne 0) { throw 'Local state needs reconciliation; no runtime started' }
  }
  $result = & $exe runtimes connect --alias continuity-pro --tunnel-id $match.Groups[1].Value --profile continuity-pro --profile-dir $profiles --mcp-command $mcpCommand --runtime-api-key 'env:CONTROL_PLANE_API_KEY' --json | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { throw 'Managed Tunnel startup failed' }
}
$state = & $exe runtimes status continuity-pro --json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Managed Tunnel status failed' }
[pscustomobject]@{ alias='continuity-pro'; running=$state.process_running; healthy=$state.healthy; ready=$state.ready; remote_error=$state.remote_error; ui_url=$state.ui_url } | ConvertTo-Json
if (-not ($state.process_running -and $state.healthy -and $state.ready) -or $state.remote_error) { exit 1 }
