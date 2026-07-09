$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$url = "http://localhost:5173/"

function Test-PortOpen {
  param([int]$Port)

  $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  return $null -ne $connection
}

if (-not (Test-PortOpen -Port 5173)) {
  $command = "cd `"$projectRoot`"; npm run dev -- --host localhost --port 5173"
  Start-Process powershell.exe `
    -ArgumentList "-NoExit", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $command `
    -WindowStyle Minimized

  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline) {
    if (Test-PortOpen -Port 5173) {
      break
    }
    Start-Sleep -Milliseconds 500
  }
}

Start-Process $url
