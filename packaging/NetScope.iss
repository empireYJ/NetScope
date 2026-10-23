#ifndef AppVersion
  #define AppVersion "1.1.2"
#endif
#ifndef PayloadDir
  #error PayloadDir must point at a freshly staged, verified application payload.
#endif
#ifndef WebViewInstaller
  #error WebViewInstaller must point at the verified Microsoft offline installer.
#endif
#ifndef OutputDir
  #define OutputDir "..\dist"
#endif

[Setup]
AppId={{13FBA8A0-7569-4B51-BFA2-78129CC87A72}
AppName=墨流 NetScope
AppVersion={#AppVersion}
AppPublisher=NetScope contributors
AppPublisherURL=https://github.com/empireYJ/NetScope
AppSupportURL=https://github.com/empireYJ/NetScope/issues
AppUpdatesURL=https://github.com/empireYJ/NetScope/releases
DefaultDirName={localappdata}\Programs\NetScope
DefaultGroupName=墨流 NetScope
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
LicenseFile=..\LICENSE
InfoBeforeFile=INSTALL-NOTES.txt
SetupIconFile=..\public\app.ico
UninstallDisplayIcon={app}\desktop\NetScope.exe
OutputDir={#OutputDir}
OutputBaseFilename=NetScope-{#AppVersion}-windows-x64-setup
VersionInfoVersion={#AppVersion}.0
VersionInfoDescription=NetScope Windows x64 Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
DisableProgramGroupPage=yes
CloseApplications=no
RestartApplications=no
Uninstallable=yes
UsePreviousAppDir=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式 / Create a desktop shortcut"; GroupDescription: "快捷方式 / Shortcuts:"
Name: "autostart"; Description: "登录后在托盘运行 / Start in the tray when I sign in"; Flags: unchecked

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#WebViewInstaller}"; DestName: "MicrosoftEdgeWebView2RuntimeInstallerX64.exe"; Flags: dontcopy nocompression

[Icons]
Name: "{group}\墨流 NetScope"; Filename: "{app}\desktop\NetScope.exe"; WorkingDir: "{app}"
Name: "{group}\卸载 NetScope"; Filename: "{uninstallexe}"
Name: "{autodesktop}\墨流 NetScope"; Filename: "{app}\desktop\NetScope.exe"; WorkingDir: "{app}"; Tasks: desktopicon
Name: "{userstartup}\墨流 NetScope"; Filename: "{app}\desktop\NetScope.exe"; Parameters: "--background"; WorkingDir: "{app}"; Tasks: autostart

[Run]
Filename: "{app}\desktop\NetScope.exe"; Description: "打开墨流 NetScope / Launch NetScope"; Flags: nowait postinstall skipifsilent

[Code]
const
  WebViewKey = 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

function HasWebViewIn(RootKey: Integer): Boolean;
var
  Version: String;
begin
  Result := RegQueryStringValue(RootKey, WebViewKey, 'pv', Version) and
    (Version <> '') and (Version <> '0.0.0.0');
end;

function HasWebViewRuntime: Boolean;
begin
  Result := HasWebViewIn(HKLM32) or HasWebViewIn(HKCU);
end;

function RunLifecycle(Mode: String): Boolean;
var
  Script: String;
  ExitCode: Integer;
begin
  Script := ExpandConstant('{app}\scripts\install-lifecycle.ps1');
  Result := True;
  if FileExists(Script) then
    Result := Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
      '-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + Script + '" -Mode ' + Mode,
      ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ExitCode) and (ExitCode = 0);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ExitCode, Attempt: Integer;
begin
  Result := '';
  if not RunLifecycle('Stop') then begin
    Result := 'Please exit NetScope from its tray menu and retry. Historical data will be preserved.';
    exit;
  end;
  if not HasWebViewRuntime then begin
    ExtractTemporaryFile('MicrosoftEdgeWebView2RuntimeInstallerX64.exe');
    if not Exec(ExpandConstant('{tmp}\MicrosoftEdgeWebView2RuntimeInstallerX64.exe'),
      '/silent /install', '', SW_HIDE, ewWaitUntilTerminated, ExitCode) then begin
      Result := 'Unable to start the bundled Microsoft WebView2 Runtime installer.';
      exit;
    end;
    if (ExitCode <> 0) and (ExitCode <> 3010) then begin
      Result := 'Microsoft WebView2 Runtime setup failed (code ' + IntToStr(ExitCode) + '). Please retry.';
      exit;
    end;
    NeedsRestart := ExitCode = 3010;
    for Attempt := 1 to 10 do begin
      if HasWebViewRuntime then break;
      Sleep(1000);
    end;
    if not HasWebViewRuntime then
      Result := 'WebView2 Runtime could not be detected after setup. Please restart Windows and retry.';
  end;
end;

function InitializeUninstall: Boolean;
begin
  Result := RunLifecycle('Uninstall');
  if not Result then
    MsgBox('NetScope could not shut down safely or remove its optional sensor task. Close the app, allow sensor cleanup if requested, and retry. Your history has not been deleted.', mbError, MB_OK);
end;
