$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'identity.ps1')
[Net.WebRequest]::DefaultWebProxy=$null
$appRoot=Split-Path -Parent $PSScriptRoot
$configPath=Join-Path $appRoot 'data\settings.json'
if(-not(Test-Path -LiteralPath $configPath)){exit}
$config=Get-Content -LiteralPath $configPath -Raw|ConvertFrom-Json
if(-not $config.systemEnabled){exit}
$exe=Join-Path $appRoot 'runtime\sensor\NetScope.Sensor.exe'
$stopPath=Join-Path $appRoot 'data\system-stop.flag'
$ready=$false
for($i=0;$i -lt 60;$i++) {
  if(Test-Path -LiteralPath $stopPath){exit}
  try{$r=Invoke-RestMethod -Uri ('http://127.0.0.1:'+$config.port+'/api/v1/status') -TimeoutSec 1;if($r.app -eq 'NetScope'){$ready=$true;break}}catch{}
  if(-not $config.autoStart){exit}
  Start-Sleep -Milliseconds 1000
}
if(-not $ready){exit}
$process=Start-Process -FilePath $exe -ArgumentList @('--etw','--pipe',$NetScopeSensorPipe,'--stop-file',('"'+$stopPath+'"')) -WindowStyle Hidden -PassThru -Wait
exit $process.ExitCode
