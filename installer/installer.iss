#define MyAppName "T Zync"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "T Zync"
#define MyAppExeName "Start-TZync.vbs"

[Setup]
AppId={{8F3B2C5A-7E1D-4A6F-9C2B-1D4E6F8A9B3C}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\TZync
DefaultGroupName=T Zync
DisableProgramGroupPage=yes
OutputDir=dist
OutputBaseFilename=TZync-Setup
SetupIconFile=logo.ico
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
DisableWelcomePage=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional icons:"

[Files]
Source: "payload\app\*"; DestDir: "{app}\app"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "payload\runtime\*"; DestDir: "{app}\runtime"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "payload\Start-TZync.vbs"; DestDir: "{app}"; Flags: ignoreversion
Source: "payload\Stop-TZync.vbs"; DestDir: "{app}"; Flags: ignoreversion
Source: "logo.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\T Zync"; Filename: "{app}\Start-TZync.vbs"; IconFilename: "{app}\logo.ico"; WorkingDir: "{app}"
Name: "{group}\Stop T Zync"; Filename: "{app}\Stop-TZync.vbs"; IconFilename: "{app}\logo.ico"; WorkingDir: "{app}"
Name: "{group}\Uninstall T Zync"; Filename: "{uninstallexe}"
Name: "{autodesktop}\T Zync"; Filename: "{app}\Start-TZync.vbs"; IconFilename: "{app}\logo.ico"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\Start-TZync.vbs"; Description: "Launch T Zync now"; Flags: postinstall nowait shellexec

[Code]
var
  DevicePage: TInputQueryWizardPage;

procedure InitializeWizard;
begin
  DevicePage := CreateInputQueryPage(wpSelectTasks,
    'Device Connection', 'Enter your ZKTeco attendance device details',
    'These are used to connect to your device. You can change them later from the app''s Settings page.');
  DevicePage.Add('Device IP Address:', False);
  DevicePage.Add('Port:', False);
  DevicePage.Add('Communication Password:', False);
  DevicePage.Add('Device Label:', False);
  DevicePage.Add('Timezone:', False);

  DevicePage.Values[1] := '4370';
  DevicePage.Values[2] := '0';
  DevicePage.Values[3] := 'Main Device';
  DevicePage.Values[4] := 'Asia/Karachi';
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = DevicePage.ID then
  begin
    if Trim(DevicePage.Values[0]) = '' then
    begin
      MsgBox('Please enter the device IP address. You can also leave setup unfinished and configure it later from the app.', mbInformation, MB_OK);
      Result := True;
    end;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  JsonText, IP, Port, Password, DeviceName, Timezone: string;
  SeedFile: string;
begin
  if CurStep <> ssPostInstall then exit;

  { Silent/unattended installs (IT deployment) can pass device details via
    /ip=... /port=... /password=... /devicename=... /timezone=... on the
    command line instead of the interactive wizard page. }
  IP := ExpandConstant('{param:ip|' + DevicePage.Values[0] + '}');
  Port := ExpandConstant('{param:port|' + DevicePage.Values[1] + '}');
  Password := ExpandConstant('{param:password|' + DevicePage.Values[2] + '}');
  DeviceName := ExpandConstant('{param:devicename|' + DevicePage.Values[3] + '}');
  Timezone := ExpandConstant('{param:timezone|' + DevicePage.Values[4] + '}');

  if Trim(IP) <> '' then
  begin
    JsonText := '{' +
      '"ip": "' + IP + '", ' +
      '"port": ' + Port + ', ' +
      '"password": "' + Password + '", ' +
      '"device_name": "' + DeviceName + '", ' +
      '"timezone": "' + Timezone + '"' +
      '}';
    SeedFile := ExpandConstant('{app}') + '\seed-config.json';
    SaveStringToFile(SeedFile, JsonText, False);
  end;
end;
