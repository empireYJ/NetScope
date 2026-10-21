$ErrorActionPreference='Stop'
$appRoot=Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'identity.ps1')
$taskName=$NetScopeSensorTask
$statusPath=Join-Path $appRoot 'data\system-setup.json'
try {
  $who=[Security.Principal.WindowsIdentity]::GetCurrent().Name
  $ps=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $action=New-ScheduledTaskAction -Execute $ps -Argument ('-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+(Join-Path $PSScriptRoot 'run-system.ps1')+'"') -WorkingDirectory $appRoot
  $trigger=New-ScheduledTaskTrigger -AtLogOn -User $who
  $principal=New-ScheduledTaskPrincipal -UserId $who -LogonType Interactive -RunLevel Highest
  $settings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Read-only network events for NetScope. Obeys its systemEnabled and autoStart settings.' -Force|Out-Null
  Start-ScheduledTask -TaskName $taskName
  [pscustomobject]@{ok=$true;task=$taskName;time=(Get-Date -Format o)}|ConvertTo-Json|Set-Content -LiteralPath $statusPath -Encoding UTF8
} catch {
  [pscustomobject]@{ok=$false;error=$_.Exception.Message}|ConvertTo-Json|Set-Content -LiteralPath $statusPath -Encoding UTF8
  exit 1
}
