@echo off
setlocal
if exist "%~dp0runtime\node\node.exe" (
  "%~dp0runtime\node\node.exe" --disable-warning=ExperimentalWarning "%~dp0cli.mjs" %*
) else (
  node --disable-warning=ExperimentalWarning "%~dp0cli.mjs" %*
)
exit /b %errorlevel%
