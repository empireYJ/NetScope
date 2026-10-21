param([ValidateSet('enable','disable','status')][string]$Mode='status')
$ErrorActionPreference='Stop'
$appRoot=Split-Path -Parent $PSScriptRoot
$startup=[Environment]::GetFolderPath('Startup')
$linkPath=Join-Path $startup '墨流 NetScope.lnk'
if($Mode -eq 'enable') {
  $shell=New-Object -ComObject WScript.Shell
  $link=$shell.CreateShortcut($linkPath)
  $desktopExe=Join-Path $appRoot 'desktop\NetScope.exe'
  if(Test-Path -LiteralPath $desktopExe){
    $link.TargetPath=$desktopExe
    $link.Arguments='--background'
    $link.IconLocation=$desktopExe+',0'
  }else{
    $link.TargetPath=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $link.Arguments='-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+(Join-Path $appRoot 'start.ps1')+'"'
  }
  $link.WorkingDirectory=$appRoot
  $link.WindowStyle=7
  $link.Description='墨流 NetScope：登录后在本机记录流量'
  $link.Save()
} elseif($Mode -eq 'disable' -and (Test-Path -LiteralPath $linkPath)) {Remove-Item -LiteralPath $linkPath}
[pscustomobject]@{autoStart=(Test-Path -LiteralPath $linkPath);path=$linkPath}|ConvertTo-Json -Compress
