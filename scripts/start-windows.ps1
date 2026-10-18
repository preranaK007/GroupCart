# Keeps GroupCart running on a Windows computer that hosts it: starts it with .env and restarts it if it stops.
# Output goes to data\groupcart.log. Register it to run at sign-in (see README, "Host it on your own computer"):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-windows.ps1 -PublicUrl https://your-host.example
param([string]$PublicUrl = "")

$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
# The public address (a tunnel such as Tailscale Funnel) is used for links, sign-in, and the AI connector.
if ($PublicUrl) { $env:GROUP_CART_PUBLIC_URL = $PublicUrl }
New-Item -ItemType Directory -Force (Join-Path $repo "data") | Out-Null
$log = Join-Path $repo "data\groupcart.log"

while ($true) {
  Add-Content $log "$(Get-Date -Format s) starting GroupCart"
  & node --env-file=.env --import=tsx src/index.ts *>> $log
  Add-Content $log "$(Get-Date -Format s) GroupCart stopped (exit $LASTEXITCODE); restarting in 5 seconds"
  Start-Sleep -Seconds 5
}
