param([ValidateSet('Stop','Uninstall','RemoveTask')][string]$Mode='Stop')
$ErrorActionPreference='Stop'
$env:PSModulePath=(Join-Path $PSHOME 'Modules')+[IO.Path]::PathSeparator+$env:PSModulePath
[Net.WebRequest]::DefaultWebProxy=$null
$appRoot=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$dataRoot=Join-Path $appRoot 'data'
. (Join-Path $PSScriptRoot 'identity.ps1')
function Is-SamePath([string]$left,[string]$right) {
  if(-not $left -or -not $right){return $false}
  return [string]::Equals([IO.Path]::GetFullPath($left),[IO.Path]::GetFullPath($right),[StringComparison]::OrdinalIgnoreCase)
}
function Get-OwnedProcesses {
  foreach($process in (Get-Process -Name NetScope,'NetScope.Sensor',node -ErrorAction SilentlyContinue)) {
    try {
      if((Is-SamePath $process.Path (Join-Path $appRoot 'desktop\NetScope.exe')) -or
         (Is-SamePath $process.Path (Join-Path $appRoot 'runtime\sensor\NetScope.Sensor.exe')) -or
         (Is-SamePath $process.Path (Join-Path $appRoot 'runtime\node\node.exe'))){$process}
    }catch{}
  }
}
function Remove-OwnedSensorTask {
  $task=Get-ScheduledTask -TaskName $NetScopeSensorTask -ErrorAction SilentlyContinue
  if(-not $task){return}
  $expected=Join-Path $PSScriptRoot 'run-system.ps1'
  foreach($action in $task.Actions) {
    if($action.Arguments -match '-File\s+"([^"]+)"' -and (Is-SamePath $Matches[1] $expected)) {
      Unregister-ScheduledTask -TaskName $NetScopeSensorTask -Confirm:$false -ErrorAction Stop
      return
    }
  }
  # A task owned by another installation is never modified.
}
try {
  if($Mode -eq 'RemoveTask'){Remove-OwnedSensorTask;exit 0}
  $descriptor=Join-Path $dataRoot 'server.json'
  if(Test-Path -LiteralPath $descriptor) {
    $server=Get-Content -LiteralPath $descriptor -Raw | ConvertFrom-Json
    $backend=Get-Process -Id $server.pid -ErrorAction SilentlyContinue
    if($backend -and (Is-SamePath $backend.Path (Join-Path $appRoot 'runtime\node\node.exe')) -and
       [Math]::Abs(($backend.StartTime.ToUniversalTime()-[DateTime]::Parse($server.startedAt).ToUniversalTime()).TotalSeconds) -lt 10) {
      $base='http://127.0.0.1:'+([int]$server.port)+'/api/v1/'
      $state=Invoke-RestMethod -Uri ($base+'status') -TimeoutSec 5
      if($state.app -ne 'NetScope' -or $state.pid -ne $backend.Id){throw 'The local server identity did not match this installation.'}
      $key=(Get-Content -LiteralPath (Join-Path $dataRoot 'api-token') -Raw).Trim()
      Invoke-RestMethod -Uri ($base+'control') -Method Post -Headers @{'X-NetScope-Key'=$key} -ContentType 'application/json' -Body '{"action":"stop"}' -TimeoutSec 15 | Out-Null
    }
  }
  if(Test-Path -LiteralPath $dataRoot){[IO.File]::WriteAllText((Join-Path $dataRoot 'desktop-stop.flag'),'stop')}
  for($attempt=0;$attempt -lt 30;$attempt++) {
    if(-not @(Get-OwnedProcesses).Count){break}
    Start-Sleep -Milliseconds 500
  }
  if(@(Get-OwnedProcesses).Count){throw 'Please exit this NetScope installation from its tray menu, then retry. No process was force-terminated.'}
  if($Mode -eq 'Uninstall') {
    try {Remove-OwnedSensorTask} catch {
      $shell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
      $cleanup=Start-Process -FilePath $shell -ArgumentList @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$PSCommandPath+'"'),'-Mode','RemoveTask') -Verb RunAs -WindowStyle Hidden -PassThru -Wait
      if($cleanup.ExitCode -ne 0){throw 'Unable to remove the optional elevated sensor task.'}
    }
    $linkPath=Join-Path ([Environment]::GetFolderPath('Startup')) '墨流 NetScope.lnk'
    if(Test-Path -LiteralPath $linkPath) {
      $link=(New-Object -ComObject WScript.Shell).CreateShortcut($linkPath)
      if((Is-SamePath $link.TargetPath (Join-Path $appRoot 'desktop\NetScope.exe')) -or $link.Arguments.Contains('"'+(Join-Path $appRoot 'start.ps1')+'"')){Remove-Item -LiteralPath $linkPath}
    }
    $settingsPath=Join-Path $dataRoot 'settings.json'
    if(Test-Path -LiteralPath $settingsPath) {
      $settings=Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
      $settings | Add-Member -NotePropertyName autoStart -NotePropertyValue $false -Force
      $settings | Add-Member -NotePropertyName systemEnabled -NotePropertyValue $false -Force
      [IO.File]::WriteAllText($settingsPath,($settings | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
    }
  }
  [pscustomobject]@{ok=$true;mode=$Mode;dataPreserved=$true}|ConvertTo-Json -Compress
} catch {Write-Error $_.Exception.Message;exit 1}
