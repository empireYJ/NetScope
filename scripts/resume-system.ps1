$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'identity.ps1')
$taskName=$NetScopeSensorTask
$appRoot=Split-Path -Parent $PSScriptRoot
$config=Get-Content -LiteralPath (Join-Path $appRoot 'data\settings.json') -Raw|ConvertFrom-Json
for($attempt=0;$attempt -lt 20;$attempt++) {
  $task=Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
  if($task.State -ne 'Running'){Start-ScheduledTask -TaskName $taskName}
  try {
    $request=[Net.WebRequest]::Create('http://127.0.0.1:'+$config.port+'/api/v1/status');$request.Proxy=$null;$request.Timeout=1000
    $response=$request.GetResponse();$reader=[IO.StreamReader]::new($response.GetResponseStream())
    try{$status=$reader.ReadToEnd()|ConvertFrom-Json}finally{$reader.Dispose();$response.Dispose()}
    if($status.systemOnline){exit 0}
    if(-not $status.settings.systemEnabled){exit 0}
  }catch{}
  Start-Sleep -Milliseconds 1000
}
throw 'Windows sensor did not reconnect within 20 seconds.'
