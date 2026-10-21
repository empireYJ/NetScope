$ErrorActionPreference='Stop'
$appRoot=Split-Path -Parent $PSScriptRoot
Push-Location $appRoot
try {
  & dotnet publish native/NetScope.Sensor.csproj -c Release -o runtime/sensor
  if($LASTEXITCODE -ne 0){throw 'Native sensor build failed'}
  & dotnet publish desktop-src/NetScope.csproj -c Release -o desktop
  if($LASTEXITCODE -ne 0){throw 'Desktop build failed'}
  Write-Output 'Build complete. Run .\desktop\NetScope.exe'
} finally {Pop-Location}
