$ErrorActionPreference='Stop'
$appRoot=Split-Path -Parent $PSScriptRoot
$stopPath=Join-Path $appRoot 'data\system-stop.flag'
if(Test-Path -LiteralPath $stopPath){Remove-Item -LiteralPath $stopPath}
$ps=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$process=Start-Process -FilePath $ps -ArgumentList @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+(Join-Path $PSScriptRoot 'register-system.ps1')+'"')) -Verb RunAs -WindowStyle Hidden -PassThru -Wait
if($process.ExitCode -ne 0){throw 'Windows system sensor setup failed. See data\system-setup.json'}
[pscustomobject]@{requested=$true;registered=$true}|ConvertTo-Json -Compress
