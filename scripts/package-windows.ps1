param([string]$IsccPath,[switch]$SkipInstaller)
$ErrorActionPreference='Stop'
$appRoot=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$cacheRoot=Join-Path $appRoot 'build-cache'
$outputRoot=Join-Path $appRoot 'dist'
$dependencies=Get-Content -LiteralPath (Join-Path $appRoot 'packaging\dependencies.json') -Raw | ConvertFrom-Json
$package=Get-Content -LiteralPath (Join-Path $appRoot 'package.json') -Raw | ConvertFrom-Json
New-Item -ItemType Directory -Path $cacheRoot,$outputRoot -Force | Out-Null
function Write-Utf8([string]$file,[string]$value) {[IO.File]::WriteAllText($file,$value,[Text.UTF8Encoding]::new($false))}
function Get-VerifiedDownload([string]$url,[string]$destination,[string]$expected) {
  if(-not(Test-Path -LiteralPath $destination)) {
    & curl.exe --fail --location --silent --show-error --retry 3 --connect-timeout 20 --max-time 900 --output ($destination+'.partial') $url
    if($LASTEXITCODE -ne 0){throw ('Download failed: '+$url)}
    if((Get-FileHash -LiteralPath ($destination+'.partial') -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected){throw 'Downloaded prerequisite failed SHA-256 validation'}
    Move-Item -LiteralPath ($destination+'.partial') -Destination $destination
  }
  if((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected){throw ('Cached prerequisite failed SHA-256 validation: '+$destination)}
}
Push-Location $appRoot
try {
  $nodeArchive=Join-Path $cacheRoot ('node-'+$dependencies.node.version+'-win-x64.zip')
  $webview=Join-Path $cacheRoot 'MicrosoftEdgeWebView2RuntimeInstallerX64.exe'
  Get-VerifiedDownload $dependencies.node.url $nodeArchive $dependencies.node.sha256
  Get-VerifiedDownload $dependencies.webview.url $webview $dependencies.webview.sha256
  $signature=Get-AuthenticodeSignature -LiteralPath $webview
  if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation'){throw 'The WebView2 offline installer must have a valid Microsoft signature'}

  # Every build gets a new directory. Never copy or delete a user's app data.
  $buildRoot=Join-Path $cacheRoot ('package-'+$package.version+'-'+[guid]::NewGuid().ToString('N'))
  $payload=Join-Path $buildRoot 'payload'
  New-Item -ItemType Directory -Path $payload -Force | Out-Null
  & dotnet publish native/NetScope.Sensor.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=false -p:DebugType=None -p:DebugSymbols=false ('-p:RuntimeFrameworkVersion='+$dependencies.dotnetRuntimeVersion) -o (Join-Path $payload 'runtime\sensor')
  if($LASTEXITCODE -ne 0){throw 'Self-contained sensor publish failed'}
  & dotnet publish desktop-src/NetScope.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=false -p:DebugType=None -p:DebugSymbols=false ('-p:RuntimeFrameworkVersion='+$dependencies.dotnetRuntimeVersion) -o (Join-Path $payload 'desktop')
  if($LASTEXITCODE -ne 0){throw 'Self-contained desktop publish failed'}
  $nodeExtract=Join-Path $buildRoot 'node-extract'
  Expand-Archive -LiteralPath $nodeArchive -DestinationPath $nodeExtract
  $nodeSource=Join-Path $nodeExtract ('node-'+$dependencies.node.version+'-win-x64')
  $nodeTarget=Join-Path $payload 'runtime\node'
  New-Item -ItemType Directory -Path $nodeTarget -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $nodeSource 'node.exe') -Destination $nodeTarget
  $actualNode=& (Join-Path $nodeTarget 'node.exe') --version
  if($actualNode -ne $dependencies.node.version){throw 'Bundled Node version mismatch'}

  foreach($folder in @('lib','public')){Copy-Item -LiteralPath (Join-Path $appRoot $folder) -Destination (Join-Path $payload $folder) -Recurse}
  foreach($file in @('server.mjs','cli.mjs','mcp.mjs','netscope.cmd','start.ps1','打开墨流.cmd','package.json','README.md','HARNESS.md','RELEASE-1.1.md','LICENSE','THIRD_PARTY_NOTICES.md','SECURITY.md')){Copy-Item -LiteralPath (Join-Path $appRoot $file) -Destination $payload}
  $scriptsTarget=Join-Path $payload 'scripts'
  New-Item -ItemType Directory -Path $scriptsTarget -Force | Out-Null
  foreach($file in @('autostart.ps1','enable-system.ps1','identity.ps1','register-system.ps1','resume-system.ps1','run-system.ps1','install-lifecycle.ps1')){Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination $scriptsTarget}

  $licenses=Join-Path $payload 'licenses'
  New-Item -ItemType Directory -Path $licenses -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $nodeSource 'LICENSE') -Destination (Join-Path $licenses 'Node.js-LICENSE.txt')
  $nugetRoot=if($env:NUGET_PACKAGES){$env:NUGET_PACKAGES}else{Join-Path ([Environment]::GetFolderPath('UserProfile')) '.nuget\packages'}
  $licensePackages=@{}
  foreach($project in @('native','desktop-src')) {
    $assets=Get-Content -LiteralPath (Join-Path $appRoot ($project+'\obj\project.assets.json')) -Raw | ConvertFrom-Json
    foreach($entry in $assets.libraries.PSObject.Properties){if($entry.Value.type -eq 'package'){$licensePackages[$entry.Name]=$true}}
  }
  foreach($name in @('microsoft.netcore.app.runtime.win-x64','microsoft.windowsdesktop.app.runtime.win-x64')){$licensePackages[$name+'/'+$dependencies.dotnetRuntimeVersion]=$true}
  $mitTemplate=(Get-Content -LiteralPath (Join-Path $appRoot 'LICENSE') -Raw) -replace 'Copyright \(c\) 2026 NetScope contributors','{COPYRIGHT}'
  foreach($identity in $licensePackages.Keys) {
    $parts=$identity.Split('/')
    $packageRoot=Join-Path (Join-Path $nugetRoot $parts[0].ToLowerInvariant()) $parts[1].ToLowerInvariant()
    if(-not(Test-Path -LiteralPath $packageRoot)){throw ('Dependency license package missing: '+$identity)}
    $licenseTarget=Join-Path $licenses ($parts[0]+'-'+$parts[1])
    New-Item -ItemType Directory -Path $licenseTarget -Force | Out-Null
    $nuspec=Get-ChildItem -LiteralPath $packageRoot -Filter '*.nuspec' | Select-Object -First 1
    if($nuspec) {
      Copy-Item -LiteralPath $nuspec.FullName -Destination $licenseTarget
      [xml]$metadata=Get-Content -LiteralPath $nuspec.FullName -Raw
      $license=$metadata.package.metadata.license
      if($license.type -eq 'file') {
        $licenseFile=Join-Path $packageRoot ([string]$license.'#text')
        if(-not(Test-Path -LiteralPath $licenseFile)){throw ('Declared license missing: '+$identity)}
        Copy-Item -LiteralPath $licenseFile -Destination (Join-Path $licenseTarget 'LICENSE.txt')
      } elseif([string]$license.'#text' -eq 'MIT') {
        $copyright=[string]$metadata.package.metadata.copyright
        if(-not $copyright){$copyright='Authorship and copyright notices: see the adjacent original NuGet package metadata.'}
        Write-Utf8 (Join-Path $licenseTarget 'MIT-LICENSE.txt') $mitTemplate.Replace('{COPYRIGHT}',$copyright)
      } else {throw ('Dependency license requires review: '+$identity)}
    }
    foreach($notice in (Get-ChildItem -LiteralPath $packageRoot -File | Where-Object {$_.Name -match '^(LICENSE|THIRD.?PARTY|NOTICE)'})){Copy-Item -LiteralPath $notice.FullName -Destination $licenseTarget -Force}
  }
  $revision=(& git rev-parse HEAD).Trim()
  $buildInfo=[ordered]@{version=$package.version;architecture='win-x64';sourceRevision=$revision;builtAt=(Get-Date).ToUniversalTime().ToString('o');node=$dependencies.node.version;dotnet=$dependencies.dotnetRuntimeVersion;webviewInstallerSha256=$dependencies.webview.sha256;selfContained=$true;dataIncluded=$false;signed=$false}
  Write-Utf8 (Join-Path $payload 'build-info.json') ($buildInfo|ConvertTo-Json)
  $manifest=@()
  foreach($file in (Get-ChildItem -LiteralPath $payload -File -Recurse)) {
    $relative=$file.FullName.Substring($payload.Length+1).Replace('\','/')
    if($relative -match '(^|/)(data|qa-output|traffic-audit|test|node_modules)(/|$)|\.sqlite|\.(etl|dmp|pfx|key|pdb)$'){throw ('Unexpected private/development file in payload: '+$relative)}
    $manifest+=[ordered]@{path=$relative;size=$file.Length;sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
  }
  Write-Utf8 (Join-Path $payload 'payload-manifest.json') ($manifest|ConvertTo-Json -Depth 4)
  Write-Utf8 (Join-Path $outputRoot 'build-info.json') ($buildInfo|ConvertTo-Json)
  Write-Utf8 (Join-Path $cacheRoot 'last-package.json') ([ordered]@{payload=$payload;version=$package.version;fileCount=$manifest.Count}|ConvertTo-Json)
  if($SkipInstaller){Write-Output ('Verified payload: '+$payload);return}
  if(-not $IsccPath) {
    $candidate=Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if($candidate){$IsccPath=$candidate.Source}else{$IsccPath=Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'}
  }
  if(-not(Test-Path -LiteralPath $IsccPath)){throw 'Inno Setup 6.7+ is required. Use the preinstalled compiler on a GitHub windows-latest runner, or provide -IsccPath.'}
  & $IsccPath ('/DAppVersion='+$package.version) ('/DPayloadDir='+$payload) ('/DWebViewInstaller='+$webview) ('/DOutputDir='+$outputRoot) (Join-Path $appRoot 'packaging\NetScope.iss')
  if($LASTEXITCODE -ne 0){throw 'Installer compilation failed'}
  $setupName='NetScope-'+$package.version+'-windows-x64-setup.exe'
  $setup=Join-Path $outputRoot $setupName
  Write-Utf8 (Join-Path $outputRoot 'SHA256SUMS.txt') (((Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash.ToLowerInvariant())+'  '+$setupName+"`n")
  Write-Output ('Installer: '+$setup)
} finally {Pop-Location}
