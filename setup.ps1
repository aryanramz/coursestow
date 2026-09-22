$ErrorActionPreference = "Stop"
Write-Host "CourseStow setup"
Set-Location $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js 20+ is required. Install it from https://nodejs.org/ then rerun this script." -ForegroundColor Yellow
  exit 1
}

$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 20) {
  Write-Host "Node.js 20+ is required. Current version:" -ForegroundColor Red
  node --version
  exit 1
}

node --version
Write-Host "Installing locked dependencies..."
npm ci --no-audit --no-fund

Write-Host ""
Write-Host "Running environment checks..."
node (Join-Path $PSScriptRoot "src\launcher.mjs") doctor

Write-Host ""
Write-Host "Setup complete. The doctor output above shows the user configuration path." -ForegroundColor Green
Write-Host "Edit that configuration, then run SETUP_LOGIN.cmd followed by FULL_SYNC.cmd." -ForegroundColor Green
