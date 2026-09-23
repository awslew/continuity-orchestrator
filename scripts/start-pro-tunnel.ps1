$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent $projectRoot
$tunnelRoot = if ($env:CONTINUITY_TUNNEL_CLIENT_ROOT) { $env:CONTINUITY_TUNNEL_CLIENT_ROOT } else { Join-Path $workspaceRoot 'tunnel-client' }
$tunnelExe = Join-Path $tunnelRoot 'tunnel-client.exe'
$profile = Join-Path $tunnelRoot 'profiles/local-stdio.yaml'
$entry = Join-Path $PSScriptRoot 'start-pro-local.mjs'
if (-not $env:CONTROL_PLANE_API_KEY) {
  $env:CONTROL_PLANE_API_KEY = [Environment]::GetEnvironmentVariable('CONTROL_PLANE_API_KEY', 'User')
}
if (-not $env:CONTROL_PLANE_API_KEY) {
  throw 'Existing tunnel profile requires CONTROL_PLANE_API_KEY in the process or actual Windows user environment. Configure it locally; do not paste credentials into chat.'
}
if (Get-Process -Name tunnel-client -ErrorAction SilentlyContinue) {
  throw 'A tunnel-client is already running. Review it before starting another instance for the same tunnel.'
}
# Flag overrides the MCP command without editing the original relay profile.
& $tunnelExe run --profile-file $profile --mcp.command ('command=node "' + $entry + '",channel=main')
