param([Parameter(Mandatory=$true)][string]$Installer)
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -ne 'true'){throw 'Run this installation/registry integration check only on a disposable GitHub Actions runner.'}
$appRoot=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$testRoot=Join-Path $env:RUNNER_TEMP ('NetScope-package-check-'+[guid]::NewGuid().ToString('N'))
$installRoot=Join-Path $testRoot 'NetScope install'
$outputRoot=Join-Path $appRoot 'dist'
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
function Write-Utf8([string]$file,[string]$value){[IO.File]::WriteAllText($file,$value,[Text.UTF8Encoding]::new($false))}
function Wait-Until([scriptblock]$condition,[string]$label) {
  for($attempt=0;$attempt -lt 90;$attempt++){if(& $condition){return};Start-Sleep -Milliseconds 500}
  throw ('Timed out: '+$label)
}
function Run-Setup([string]$log) {
  $process=Start-Process -FilePath $Installer -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/SP-',('/DIR="'+$installRoot+'"'),'/GROUP="NetScope Package Check"','/MERGETASKS="!desktopicon,!autostart"',('/LOG="'+$log+'"')) -WindowStyle Hidden -PassThru -Wait
  if($process.ExitCode -ne 0){throw ('Installer returned '+$process.ExitCode+'. See '+$log)}
}
$originalPath=$env:Path
$checks=[Collections.Generic.List[string]]::new()
try {
  # Neither system Node nor dotnet are discoverable while installing or running.
  $env:Path=$env:SystemRoot+'\System32;'+$env:SystemRoot+';'+$env:SystemRoot+'\System32\WindowsPowerShell\v1.0'
  $env:DOTNET_ROOT=Join-Path $testRoot 'no-global-dotnet'
  $env:DOTNET_MULTILEVEL_LOOKUP='0'
  $env:NETSCOPE_OFFLINE='1'
  $env:NETSCOPE_DATA_DIR=$null
  if((Get-Command node.exe,dotnet.exe -ErrorAction SilentlyContinue)){throw 'Global runtimes are still on PATH'}
  Run-Setup (Join-Path $testRoot 'install.log')
  $checks.Add('Per-user silent installation with global Node/.NET absent from PATH')
  $node=Join-Path $installRoot 'runtime\node\node.exe'
  $desktop=Join-Path $installRoot 'desktop\NetScope.exe'
  $uninstaller=Join-Path $installRoot 'unins000.exe'
  if(-not(Test-Path -LiteralPath $uninstaller)){throw 'Uninstaller was not registered'}
  $manifest=Get-Content -LiteralPath (Join-Path $installRoot 'payload-manifest.json') -Raw | ConvertFrom-Json
  foreach($entry in $manifest) {
    if((Get-FileHash -LiteralPath (Join-Path $installRoot $entry.path) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256){throw ('Installed file hash mismatch: '+$entry.path)}
  }
  $checks.Add('Every installed payload file matches the staged SHA-256 manifest')
  $sensor=& (Join-Path $installRoot 'runtime\sensor\NetScope.Sensor.exe') --version | ConvertFrom-Json
  if($LASTEXITCODE -ne 0 -or $sensor.app -ne 'NetScope.Sensor'){throw 'Self-contained sensor failed to launch'}
  $checks.Add('Self-contained native sensor starts without a global .NET runtime')
  $help=& $env:ComSpec /d /c ('call "'+(Join-Path $installRoot 'netscope.cmd')+'" help --json') | ConvertFrom-Json
  if($LASTEXITCODE -ne 0 -or $help.app -ne 'NetScope'){throw 'CLI launcher failed without a global Node installation'}
  $checks.Add('CLI launcher works from an installation path containing spaces without system Node')
  $dataRoot=Join-Path $installRoot 'data'
  New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null
  $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0);$listener.Start();$testPort=$listener.LocalEndpoint.Port;$listener.Stop()
  Write-Utf8 (Join-Path $dataRoot 'settings.json') (@{port=$testPort;systemEnabled=$false;autoStart=$false;aiDiagnosticsEnabled=$false;alertEnabled=$false;retentionDays=90}|ConvertTo-Json)
  $url='http://127.0.0.1:'+ $testPort+'/api/v1/'
  [Net.WebRequest]::DefaultWebProxy=$null
  $window=Start-Process -FilePath $desktop -ArgumentList '--verify-ui' -WorkingDirectory $installRoot -WindowStyle Hidden -PassThru
  Wait-Until {Test-Path -LiteralPath (Join-Path $dataRoot 'desktop-status.json')} 'WebView desktop first navigation'
  $navigation=Get-Content -LiteralPath (Join-Path $dataRoot 'desktop-status.json') -Raw | ConvertFrom-Json
  if(-not $navigation.ready -or $navigation.url -notlike ('http://127.0.0.1:'+$testPort+'/*')){throw 'Desktop WebView did not load the isolated backend'}
  $state=Invoke-RestMethod -Uri ($url+'status') -TimeoutSec 10
  $backend=Get-Process -Id $state.pid
  if([IO.Path]::GetFullPath($backend.Path) -ne [IO.Path]::GetFullPath($node)){throw 'Desktop selected a system Node instead of the bundled runtime'}
  if(-not $state.offline -or $state.version -ne (Get-Content -LiteralPath (Join-Path $installRoot 'package.json') -Raw | ConvertFrom-Json).version){throw 'Wrong backend version or offline isolation'}
  $checks.Add('Self-contained desktop renders the real local UI using its bundled Node backend')
  Wait-Until {Test-Path -LiteralPath (Join-Path $installRoot 'qa-output\desktop-ui.json')} 'WebView content capture'
  $capture=Get-Content -LiteralPath (Join-Path $installRoot 'qa-output\desktop-ui.json') -Raw | ConvertFrom-Json
  $dom=$capture.dom | ConvertFrom-Json
  if(-not $dom.rankings -or $dom.overflow){throw 'Desktop ranking content is missing or horizontally overflowing'}
  Write-Utf8 (Join-Path $dataRoot 'preserve-on-uninstall.txt') 'package-validation-sentinel'
  $token=(Get-Content -LiteralPath (Join-Path $dataRoot 'api-token') -Raw).Trim()
  # Seed one synthetic ledger row through the actual installed Store module.
  $seedFile=Join-Path $testRoot 'seed.mjs'
  $moduleUri=[Uri]::new((Join-Path $installRoot 'lib\store.mjs')).AbsoluteUri
  Write-Utf8 $seedFile ("import {Store} from '"+$moduleUri+"'; const s=new Store(process.argv[2]); s.append([{time:Date.now(),name:'installer-fixture.exe',path:'',pid:999,host:'fixture.example',route:'DIRECT',source:'fixture',up:12345,down:67890}]); s.close();")
  # Use the API to stop before the offline fixture write; never write a live DB.
  Invoke-RestMethod -Uri ($url+'control') -Method Post -Headers @{'X-NetScope-Key'=$token} -ContentType 'application/json' -Body '{"action":"stop"}' | Out-Null
  Wait-Until {-not(Get-Process -Id $backend.Id -ErrorAction SilentlyContinue)} 'backend stop'
  Wait-Until {$window.HasExited} 'desktop stop'
  & $node $seedFile (Join-Path $dataRoot 'traffic.sqlite')
  if($LASTEXITCODE -ne 0){throw 'Synthetic ledger setup failed'}
  $ledgerHash=(Get-FileHash -LiteralPath (Join-Path $dataRoot 'traffic.sqlite') -Algorithm SHA256).Hash
  Run-Setup (Join-Path $testRoot 'upgrade.log')
  if((Get-FileHash -LiteralPath (Join-Path $dataRoot 'traffic.sqlite') -Algorithm SHA256).Hash -ne $ledgerHash){throw 'Upgrade changed historical ledger bytes'}
  if((Get-Content -LiteralPath (Join-Path $dataRoot 'settings.json') -Raw | ConvertFrom-Json).retentionDays -ne 90){throw 'Upgrade reset retention settings'}
  $checks.Add('In-place reinstall/upgrade preserves ledger bytes and retention settings')
  $remove=Start-Process -FilePath $uninstaller -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',('/LOG="'+(Join-Path $testRoot 'uninstall.log')+'"')) -WindowStyle Hidden -PassThru -Wait
  if($remove.ExitCode -ne 0){throw ('Uninstaller returned '+$remove.ExitCode)}
  Wait-Until {-not(Test-Path -LiteralPath $desktop)} 'uninstaller removal of application binaries'
  if((Get-Content -LiteralPath (Join-Path $dataRoot 'preserve-on-uninstall.txt') -Raw) -ne 'package-validation-sentinel'){throw 'Uninstall removed user files'}
  if((Get-FileHash -LiteralPath (Join-Path $dataRoot 'traffic.sqlite') -Algorithm SHA256).Hash -ne $ledgerHash){throw 'Uninstall changed the preserved ledger'}
  $checks.Add('Uninstall removes application binaries while retaining the exact historical ledger')
  $report=[ordered]@{ok=$true;platform='GitHub-hosted Windows runner';windowsVersion=[Environment]::OSVersion.VersionString;globalRuntimesHidden=$true;checks=$checks.ToArray();checkCount=$checks.Count;webviewMissingRuntimeBranch='Executed only if WebView2 was absent on the runner; no claim of a clean Windows VM';limitations=@('No unsigned SmartScreen prompt automation','Optional elevated sensor registration and cleanup require interactive UAC and were not enabled in this isolation test');finishedAt=(Get-Date).ToUniversalTime().ToString('o')}
  Write-Utf8 (Join-Path $outputRoot 'verification-report.json') ($report|ConvertTo-Json -Depth 5)
  Write-Utf8 (Join-Path $outputRoot 'SHA256SUMS.txt') (((Get-ChildItem -LiteralPath $outputRoot -File | Where-Object {$_.Name -ne 'SHA256SUMS.txt'} | ForEach-Object {((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant())+'  '+$_.Name}) -join "`n")+"`n")
  Write-Output ($report|ConvertTo-Json -Depth 5)
} finally {$env:Path=$originalPath}
