$identityBytes=[Text.Encoding]::UTF8.GetBytes([Environment]::UserName.ToLowerInvariant())
$identityHash=[Security.Cryptography.SHA256]::Create()
try {
  $NetScopeUserId=([BitConverter]::ToString($identityHash.ComputeHash($identityBytes))).Replace('-','').ToLowerInvariant().Substring(0,16)
} finally {$identityHash.Dispose()}
$NetScopeSensorPipe='NetScope-System-'+$NetScopeUserId
$NetScopeSensorTask='NetScope Network Sensor ('+$NetScopeUserId+')'
