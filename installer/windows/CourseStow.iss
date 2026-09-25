#include "includes\Product.iss"

#ifndef AppVersion
  #error AppVersion must be supplied by scripts\build-windows-installer.ps1
#endif
#ifndef SourceBundle
  #error SourceBundle must be supplied by scripts\build-windows-installer.ps1
#endif
#ifndef InstallerOutputDir
  #error InstallerOutputDir must be supplied by scripts\build-windows-installer.ps1
#endif
#ifndef ProjectLicenseFile
  #error ProjectLicenseFile must be supplied by scripts\build-windows-installer.ps1
#endif

[Setup]
AppId={#ProductAppId}
AppName={#ProductName}
AppVersion={#AppVersion}
AppVerName={#ProductName} {#AppVersion}
AppPublisher={#ProductPublisher}
AppPublisherURL={#ProductRepositoryUrl}
AppSupportURL={#ProductSupportUrl}
AppUpdatesURL={#ProductUpdatesUrl}
VersionInfoCompany={#ProductPublisher}
VersionInfoDescription={#ProductName} Setup
VersionInfoProductName={#ProductName}
VersionInfoProductVersion={#AppVersion}
VersionInfoVersion={#AppVersion}
DefaultDirName={localappdata}\Programs\{#ProductName}
DisableDirPage=yes
DisableProgramGroupPage=yes
UsePreviousAppDir=no
UsePreviousGroup=no
UsePreviousTasks=yes
PrivilegesRequired=lowest
SetupArchitecture=x64
ArchitecturesAllowed=x64compatible and not arm64
MinVersion=10.0.19045
LicenseFile={#ProjectLicenseFile}
OutputDir={#InstallerOutputDir}
OutputBaseFilename={#ProductName}-{#AppVersion}-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
DisableWelcomePage=no
DisableReadyPage=yes
CloseApplications=no
RestartApplications=no
SetupMutex=Local\CourseStow.InstallerLifecycle
UninstallDisplayIcon={app}\{#ProductExecutable}
UninstallDisplayName={#ProductName}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Messages]
WindowsVersionNotSupported={#ProductName} requires Windows 10 version 22H2 (build 19045) or later on an x64 PC. 32-bit Windows and Windows on ARM are not supported.

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: unchecked

[Files]
Source: "{#SourceBundle}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{userprograms}\{#ProductName}"; Filename: "{app}\{#ProductExecutable}"; WorkingDir: "{app}"
Name: "{userdesktop}\{#ProductName}"; Filename: "{app}\{#ProductExecutable}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#ProductExecutable}"; Parameters: "--installer-launch"; Description: "Launch {#ProductName}"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent

[Code]
const
  MaintenanceSuccess = 0;
  MaintenanceBusy = 10;
  MaintenanceInspectionFailure = 11;
  MaintenanceOperationFailure = 12;

var
  InstallMode: String;
  LifecycleStage: String;
  LifecycleStarted: Boolean;
  SetupCompleted: Boolean;
  PayloadBackupCreated: Boolean;
  RemovePrivateDataCheck: TNewCheckBox;
  RemovePrivateDataRequested: Boolean;
  UninstallCompleted: Boolean;

function IsUninstallerMetadata(const Name: String): Boolean;
var
  LowerName: String;
begin
  LowerName := LowerCase(Name);
  Result := (Copy(LowerName, 1, 5) = 'unins') and
    ((ExtractFileExt(LowerName) = '.exe') or
     (ExtractFileExt(LowerName) = '.dat') or
     (ExtractFileExt(LowerName) = '.msg'));
end;

function PayloadBackupDir(): String;
begin
  Result := ExpandConstant('{app}\.installer-rollback');
end;

procedure WriteLifecycleFailureLog(const Operation, Stage, Category: String);
var
  LogDir: String;
  LogFile: String;
  Timestamp: String;
  Content: String;
begin
  LogDir := ExpandConstant('{localappdata}\CourseStow\logs\installer');
  if not ForceDirectories(LogDir) then Exit;
  Timestamp := GetDateTimeString('yyyymmdd-hhnnss', '-', ':');
  LogFile := AddBackslash(LogDir) + 'failure-' + Timestamp + '.log';
  Content :=
    'timestamp=' + Timestamp + #13#10 +
    'version={#AppVersion}' + #13#10 +
    'operation=' + Operation + #13#10 +
    'stage=' + Stage + #13#10 +
    'result=failed' + #13#10 +
    'category=' + Category + #13#10;
  SaveStringToFile(LogFile, Content, False);
end;

function ReadInstalledVersion(var InstalledVersion: String): Boolean;
begin
  InstalledVersion := '';
  Result := RegQueryStringValue(
    HKCU,
    '{#ProductUninstallKey}',
    'DisplayVersion',
    InstalledVersion);
end;

function DetermineInstallMode(): String;
var
  InstalledVersion: String;
  IncomingPacked: Int64;
  InstalledPacked: Int64;
  Comparison: Integer;
begin
  if not RegKeyExists(HKCU, '{#ProductUninstallKey}') then
  begin
    Result := 'fresh-install';
    Exit;
  end;

  if not ReadInstalledVersion(InstalledVersion) then
  begin
    Result := 'repair';
    Exit;
  end;

  if not StrToVersion('{#AppVersion}', IncomingPacked) then
  begin
    Result := 'invalid-incoming-version';
    Exit;
  end;
  if not StrToVersion(InstalledVersion, InstalledPacked) then
  begin
    Result := 'repair';
    Exit;
  end;

  Comparison := ComparePackedVersion(IncomingPacked, InstalledPacked);
  if Comparison < 0 then Result := 'downgrade'
  else if Comparison = 0 then Result := 'repair'
  else Result := 'upgrade';
end;

function IncomingMaintenanceRoot(): String;
begin
  Result := AddBackslash(ExpandConstant('{tmp}')) + '{app}';
end;

function ExtractIncomingMaintenancePayload(): Boolean;
begin
  Result := False;
  try
    if not FileExists(AddBackslash(IncomingMaintenanceRoot()) + '{#ProductExecutable}') then
      ExtractTemporaryFiles('{app}\*');
    Result := FileExists(AddBackslash(IncomingMaintenanceRoot()) + '{#ProductExecutable}');
  except
    Result := False;
  end;
end;

function RunMaintenance(const Executable, Command: String; var ResultCode: Integer): Boolean;
begin
  ResultCode := MaintenanceInspectionFailure;
  Result := Exec(
    Executable,
    Command,
    ExtractFileDir(Executable),
    SW_HIDE,
    ewWaitUntilTerminated,
    ResultCode);
end;

function RunPreflightWithRetry(const Executable: String): Boolean;
var
  ResultCode: Integer;
  PromptResult: Integer;
begin
  Result := False;
  repeat
    if not RunMaintenance(Executable, '--installer-preflight', ResultCode) then
      ResultCode := MaintenanceInspectionFailure;

    if ResultCode = MaintenanceSuccess then
    begin
      Result := True;
      Exit;
    end;

    if ResultCode = MaintenanceBusy then
    begin
      PromptResult := MsgBox(
        'CourseStow is currently running.' + #13#10 +
        'Close CourseStow or wait for the current operation to finish, then click Retry.',
        mbError,
        MB_RETRYCANCEL);
      if PromptResult = IDRETRY then Continue;
      Exit;
    end;

    MsgBox(
      'CourseStow could not safely inspect its current activity. Setup will not replace or remove application files.',
      mbCriticalError,
      MB_OK);
    Exit;
  until False;
end;

function DeleteManagedPayloadExceptUninstaller(): Boolean;
var
  FindRec: TFindRec;
  ItemPath: String;
  IsDirectory: Boolean;
begin
  Result := True;
  if not DirExists(ExpandConstant('{app}')) then Exit;
  if FindFirst(ExpandConstant('{app}\*'), FindRec) then
  begin
    try
      repeat
        if (FindRec.Name <> '.') and (FindRec.Name <> '..') and
           (FindRec.Name <> '.installer-rollback') and
           not IsUninstallerMetadata(FindRec.Name) then
        begin
          ItemPath := AddBackslash(ExpandConstant('{app}')) + FindRec.Name;
          IsDirectory := (FindRec.Attributes and FILE_ATTRIBUTE_DIRECTORY) <> 0;
          if not DelTree(ItemPath, IsDirectory, True, True) then Result := False;
        end;
      until not FindNext(FindRec);
    finally
      FindClose(FindRec);
    end;
  end;
end;

function RestorePayloadBackup(): Boolean;
var
  FindRec: TFindRec;
  SourcePath: String;
  DestinationPath: String;
begin
  Result := True;
  if not PayloadBackupCreated and not DirExists(PayloadBackupDir()) then Exit;
  if not DeleteManagedPayloadExceptUninstaller() then Result := False;

  if FindFirst(AddBackslash(PayloadBackupDir()) + '*', FindRec) then
  begin
    try
      repeat
        if (FindRec.Name <> '.') and (FindRec.Name <> '..') then
        begin
          SourcePath := AddBackslash(PayloadBackupDir()) + FindRec.Name;
          DestinationPath := AddBackslash(ExpandConstant('{app}')) + FindRec.Name;
          if FileExists(DestinationPath) or DirExists(DestinationPath) or
             not RenameFile(SourcePath, DestinationPath) then Result := False;
        end;
      until not FindNext(FindRec);
    finally
      FindClose(FindRec);
    end;
  end;

  if Result then
  begin
    DelTree(PayloadBackupDir(), True, True, True);
    PayloadBackupCreated := False;
  end;
end;

function StageExistingPayload(): Boolean;
var
  FindRec: TFindRec;
  SourcePath: String;
  DestinationPath: String;
begin
  Result := False;
  if DirExists(PayloadBackupDir()) then Exit;
  if not DirExists(ExpandConstant('{app}')) then
  begin
    Result := True;
    Exit;
  end;
  if not ForceDirectories(PayloadBackupDir()) then Exit;
  PayloadBackupCreated := True;

  if FindFirst(ExpandConstant('{app}\*'), FindRec) then
  begin
    try
      repeat
        if (FindRec.Name <> '.') and (FindRec.Name <> '..') and
           (FindRec.Name <> '.installer-rollback') and
           not IsUninstallerMetadata(FindRec.Name) then
        begin
          SourcePath := AddBackslash(ExpandConstant('{app}')) + FindRec.Name;
          DestinationPath := AddBackslash(PayloadBackupDir()) + FindRec.Name;
          if not RenameFile(SourcePath, DestinationPath) then
          begin
            RestorePayloadBackup();
            Exit;
          end;
        end;
      until not FindNext(FindRec);
    finally
      FindClose(FindRec);
    end;
  end;
  Result := True;
end;

function RemovePayloadBackup(): Boolean;
begin
  Result := True;
  if DirExists(PayloadBackupDir()) then
    Result := DelTree(PayloadBackupDir(), True, True, True);
  if Result then PayloadBackupCreated := False;
end;

function InitializeSetup(): Boolean;
var
  ErrorCode: Integer;
begin
  InstallMode := DetermineInstallMode();
  if InstallMode = 'downgrade' then
  begin
    MsgBox(
      'A newer version of CourseStow is already installed.' + #13#10 +
      'This older installer cannot replace it.',
      mbCriticalError,
      MB_OK);
    Result := False;
    Exit;
  end;
  if InstallMode = 'invalid-incoming-version' then
  begin
    MsgBox('The CourseStow installer version is invalid.', mbCriticalError, MB_OK);
    Result := False;
    Exit;
  end;

  Result := IsDotNetInstalled(net48, 0);
  if not Result then
  begin
    if MsgBox(
      '{#ProductName} requires Microsoft .NET Framework 4.8 or newer.' + #13#10 + #13#10 +
      'Open Microsoft''s official .NET Framework 4.8 download page now?',
      mbCriticalError, MB_YESNO) = IDYES then
    begin
      ShellExec('open', '{#DotNet48DownloadUrl}', '', '', SW_SHOWNORMAL, ewNoWait, ErrorCode);
    end;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  MaintenanceExecutable: String;
begin
  Result := '';
  LifecycleStage := 'preflight';
  if not ExtractIncomingMaintenancePayload() then
  begin
    Result := 'CourseStow setup could not prepare its trusted lifecycle preflight.';
    Exit;
  end;
  MaintenanceExecutable := AddBackslash(IncomingMaintenanceRoot()) + '{#ProductExecutable}';
  if not RunPreflightWithRetry(MaintenanceExecutable) then
  begin
    Result := 'CourseStow setup was canceled because application activity could not be cleared safely.';
    Exit;
  end;

  LifecycleStarted := True;
  LifecycleStage := 'payload-backup';
  if not StageExistingPayload() then
  begin
    if not RestorePayloadBackup() then
      WriteLifecycleFailureLog(InstallMode, 'payload-backup', 'rollback-failed');
    Result := 'CourseStow could not stage the existing application payload safely. No private user data was changed.';
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
begin
  if CurStep = ssInstall then
    LifecycleStage := 'payload-install'
  else if CurStep = ssPostInstall then
  begin
    LifecycleStage := 'payload-cleanup';
    if not RemovePayloadBackup() then
    begin
      WriteLifecycleFailureLog(InstallMode, LifecycleStage, 'backup-cleanup-failed');
      MsgBox('CourseStow was installed, but payload cleanup needs repair.', mbError, MB_OK);
    end;

    LifecycleStage := 'schedule-reconcile';
    if not RunMaintenance(
      ExpandConstant('{app}\{#ProductExecutable}'),
      '--installer-reconcile-schedule',
      ResultCode) or (ResultCode <> MaintenanceSuccess) then
    begin
      WriteLifecycleFailureLog(InstallMode, LifecycleStage, 'schedule-reconcile-failed');
      MsgBox(
        'CourseStow was installed, but automatic sync scheduling could not be reconciled. Running setup again can repair it.',
        mbError,
        MB_OK);
    end;
    LifecycleStage := 'complete';
  end
  else if CurStep = ssDone then
    SetupCompleted := True;
end;

procedure DeinitializeSetup();
var
  Restored: Boolean;
begin
  if LifecycleStarted and not SetupCompleted then
  begin
    Restored := RestorePayloadBackup();
    if Restored then
      WriteLifecycleFailureLog(InstallMode, LifecycleStage, 'setup-failed-restored')
    else
      WriteLifecycleFailureLog(InstallMode, LifecycleStage, 'rollback-failed');
  end;
end;

function ShowUninstallOptions(): Boolean;
var
  OptionsForm: TSetupForm;
  PreservationText: TNewStaticText;
  ContinueButton: TNewButton;
  CancelButton: TNewButton;
begin
  OptionsForm := CreateCustomForm(ScaleX(500), ScaleY(210), False, False);
  try
    OptionsForm.Caption := 'Uninstall CourseStow';
    OptionsForm.Position := poScreenCenter;

    PreservationText := TNewStaticText.Create(OptionsForm);
    PreservationText.Parent := OptionsForm;
    PreservationText.SetBounds(ScaleX(20), ScaleY(20), ScaleX(460), ScaleY(76));
    PreservationText.AutoSize := False;
    PreservationText.WordWrap := True;
    PreservationText.Caption :=
      'CourseStow application files will be removed.' + #13#10 + #13#10 +
      'Your settings, browser session, saved credentials, local school mirror, and Google Drive copy will be preserved.';

    RemovePrivateDataCheck := TNewCheckBox.Create(OptionsForm);
    RemovePrivateDataCheck.Parent := OptionsForm;
    RemovePrivateDataCheck.SetBounds(ScaleX(20), ScaleY(108), ScaleX(460), ScaleY(24));
    RemovePrivateDataCheck.Caption := 'Also remove CourseStow settings and private app data';
    RemovePrivateDataCheck.Checked := False;

    ContinueButton := TNewButton.Create(OptionsForm);
    ContinueButton.Parent := OptionsForm;
    ContinueButton.Caption := 'Continue';
    ContinueButton.SetBounds(ScaleX(304), ScaleY(164), ScaleX(84), ScaleY(28));
    ContinueButton.Default := True;
    ContinueButton.ModalResult := mrOk;

    CancelButton := TNewButton.Create(OptionsForm);
    CancelButton.Parent := OptionsForm;
    CancelButton.Caption := 'Cancel';
    CancelButton.SetBounds(ScaleX(396), ScaleY(164), ScaleX(84), ScaleY(28));
    CancelButton.Cancel := True;
    CancelButton.ModalResult := mrCancel;

    OptionsForm.ActiveControl := ContinueButton;
    Result := OptionsForm.ShowModal() = mrOk;
    if Result then
      RemovePrivateDataRequested := RemovePrivateDataCheck.Checked;
  finally
    OptionsForm.Free();
    RemovePrivateDataCheck := nil;
  end;
end;

function InitializeUninstall(): Boolean;
begin
  Result := RunPreflightWithRetry(ExpandConstant('{app}\{#ProductExecutable}'));
  if Result then Result := ShowUninstallOptions();
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  ResultCode: Integer;
begin
  if CurUninstallStep = usUninstall then
  begin
    if not RunMaintenance(
      ExpandConstant('{app}\{#ProductExecutable}'),
      '--installer-remove-schedule',
      ResultCode) or (ResultCode <> MaintenanceSuccess) then
    begin
      WriteLifecycleFailureLog('uninstall', 'schedule-remove', 'schedule-remove-failed');
      RaiseException(
        'CourseStow could not remove its scheduled sync task, so uninstall was stopped. ' +
        'No CourseStow application or private data was removed. ' +
        'Try again after checking Windows Task Scheduler.');
    end;

    if RemovePrivateDataRequested then
    begin
      if not RunMaintenance(
        ExpandConstant('{app}\{#ProductExecutable}'),
        '--installer-remove-credential',
        ResultCode) or (ResultCode <> MaintenanceSuccess) then
      begin
        WriteLifecycleFailureLog('uninstall', 'credential-remove', 'credential-remove-failed');
        RaiseException('CourseStow could not safely remove its saved credential. Private app data was preserved.');
      end;
      if not RunMaintenance(
        ExpandConstant('{app}\{#ProductExecutable}'),
        '--installer-remove-private-data',
        ResultCode) or (ResultCode <> MaintenanceSuccess) then
      begin
        WriteLifecycleFailureLog('uninstall', 'private-data-remove', 'private-data-remove-failed');
        RaiseException('CourseStow could not safely remove its private app data. The school mirror and Google Drive copy were not changed.');
      end;
    end;
  end
  else if CurUninstallStep = usDone then
    UninstallCompleted := True;
end;

procedure DeinitializeUninstall();
begin
  if not UninstallCompleted then
    WriteLifecycleFailureLog('uninstall', 'uninstall', 'uninstall-incomplete');
end;
