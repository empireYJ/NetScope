param([switch]$Open)
$ErrorActionPreference='Stop'
[Net.WebRequest]::DefaultWebProxy=$null
$appRoot=$PSScriptRoot
$dataRoot=Join-Path $appRoot 'data'
$desktopStop=Join-Path $dataRoot 'desktop-stop.flag'
if(Test-Path -LiteralPath $desktopStop){Remove-Item -LiteralPath $desktopStop}
$port=47831
$configPath=Join-Path $dataRoot 'settings.json'
if(Test-Path -LiteralPath $configPath){$port=(Get-Content -LiteralPath $configPath -Raw|ConvertFrom-Json).port}
$address='http://127.0.0.1:'+$port
$alive=$false
try {$r=Invoke-RestMethod -Uri ($address+'/api/v1/status') -TimeoutSec 2; $alive=$r.app -eq 'NetScope'}catch{}
if(-not $alive) {
  [System.IO.Directory]::CreateDirectory($dataRoot)|Out-Null
  $desktopExe=Join-Path $appRoot 'desktop\NetScope.exe'
  if(Test-Path -LiteralPath $desktopExe){
    $p=Start-Process -FilePath $desktopExe -ArgumentList '--background' -WorkingDirectory $appRoot -WindowStyle Hidden -PassThru
  }else{
    $nodePath=(Get-Command node.exe -ErrorAction Stop).Source
    $p=Start-Process -FilePath $nodePath -ArgumentList @('--disable-warning=ExperimentalWarning',('"'+(Join-Path $appRoot 'server.mjs')+'"')) -WorkingDirectory $appRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $dataRoot 'server.log') -RedirectStandardError (Join-Path $dataRoot 'server-error.log')
  }
  for($i=0;$i -lt 30;$i++){Start-Sleep -Milliseconds 200;try{$r=Invoke-RestMethod -Uri ($address+'/api/v1/status') -TimeoutSec 1;if($r.app -eq 'NetScope'){$alive=$true;break}}catch{}}
  if(-not $alive){throw 'NetScope failed to start. See data\server-error.log'}
}
if($Open){$desktopExe=Join-Path $appRoot 'desktop\NetScope.exe';if(Test-Path -LiteralPath $desktopExe){Start-Process -FilePath $desktopExe}else{Start-Process $address}}
[pscustomobject]@{ok=$true;url=$address;pid=$r.pid}|ConvertTo-Json -Compress
