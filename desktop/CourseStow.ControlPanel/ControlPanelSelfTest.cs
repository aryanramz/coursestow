using CourseStow.Security;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace CourseStow.ControlPanel
{
    internal static class ControlPanelSelfTest
    {
        internal static int Run(string outputFile)
        {
            WindowsFormsSynchronizationContext.AutoInstall = false;
            SynchronizationContext.SetSynchronizationContext(null);
            return RunAsync(outputFile).GetAwaiter().GetResult();
        }

        private static async Task<int> RunAsync(string outputFile)
        {
            string stage = "initialize";
            try
            {
                stage = "resolve backend";
                var backend = new BackendClient();
                ProcessStartInfo startInfo = backend.CreateStartInfo("status", "--json");
                ProcessStartInfo quickStartInfo = backend.CreateStartInfo("quick");
                ProcessStartInfo fullStartInfo = backend.CreateStartInfo("full");
                ProcessStartInfo refreshLoginStartInfo = backend.CreateStartInfo("refresh-login");
                ProcessStartInfo scheduledStartInfo = backend.CreateStartInfo("scheduled");
                ProcessStartInfo settingsSaveStartInfo = backend.CreateSettingsSaveStartInfo();
                ProcessStartInfo browserProbeStartInfo = backend.CreateBrowserProbeStartInfo();
                ProcessStartInfo sourceImportStartInfo = backend.CreateSourceImportStartInfo();
                stage = "load initial settings";
                DesktopSettings initialSettings = await backend.GetSettingsAsync();
                if (initialSettings.configured)
                    throw new InvalidDataException("Packaged settings self-test requires an initially unconfigured data directory.");
                var settingsRequest = new SettingsSaveRequest
                {
                    schemaVersion = 1,
                    baseUrl = "https://example.test",
                    mirrorDir = initialSettings.mirrorDir,
                    drive = new DesktopDriveSettings { enabled = false, destination = String.Empty },
                    authentication = new DesktopAuthenticationSettings { automaticLoginEnabled = false },
                    schedule = new DesktopScheduleSettings { enabled = false, intervalHours = 6, fullIntervalDays = 7 }
                };
                if (settingsSaveStartInfo.Arguments.Contains(settingsRequest.baseUrl) || settingsSaveStartInfo.Arguments.Contains(settingsRequest.mirrorDir))
                    throw new InvalidDataException("Settings payload appeared in backend process arguments.");
                stage = "save settings through private backend";
                SettingsSaveResponse savedSettingsResponse = await backend.SaveSettingsAsync(settingsRequest);
                if (!savedSettingsResponse.ok || !savedSettingsResponse.settings.configured)
                    throw new InvalidDataException("Packaged settings could not be saved through the private Node backend.");
                stage = "reload settings and status";
                DesktopSettings currentSettings = await backend.GetSettingsAsync();
                BackendStatus status = await backend.GetStatusAsync();

                stage = "first-run and cancel behavior";
                BackendStatus firstRunStatus = CloneStatus(status);
                firstRunStatus.configured = false;
                firstRunStatus.baseUrlConfigured = false;
                var firstRunBackend = new ScriptedBackendClient(firstRunStatus, new BackendProcessResult { ExitCode = 0 });
                var firstRunDialog = new ScriptedSettingsDialogService(false);
                bool firstRunSetupTriggered;
                bool firstRunCancelDisabledSync;
                using (var firstRunForm = new MainForm(firstRunBackend, MainForm.StatusRefreshIntervalMilliseconds, firstRunDialog))
                {
                    SynchronizationContext.SetSynchronizationContext(null);
                    await firstRunForm.InitializeForSelfTestAsync();
                    firstRunSetupTriggered = firstRunForm.FirstRunSetupOfferedForSelfTest
                        && firstRunDialog.ShowCalls == 1
                        && firstRunDialog.LastFirstRun;
                    firstRunCancelDisabledSync = !firstRunForm.SyncButtonsEnabledForSelfTest;
                }

                BackendStatus successfulFirstRunStatus = CloneStatus(status);
                successfulFirstRunStatus.configured = false;
                successfulFirstRunStatus.baseUrlConfigured = false;
                var successfulFirstRunBackend = new ScriptedBackendClient(successfulFirstRunStatus, new BackendProcessResult { ExitCode = 0 });
                var successfulFirstRunDialog = new ScriptedSettingsDialogService(true, delegate
                {
                    successfulFirstRunStatus.configured = true;
                    successfulFirstRunStatus.baseUrlConfigured = true;
                });
                using (var successfulFirstRunForm = new MainForm(successfulFirstRunBackend, MainForm.StatusRefreshIntervalMilliseconds, successfulFirstRunDialog))
                {
                    await successfulFirstRunForm.InitializeForSelfTestAsync();
                }
                bool firstRunSignInThenFullSync = successfulFirstRunBackend.RefreshLoginCalls == 1
                    && successfulFirstRunBackend.SyncCalls == 1
                    && successfulFirstRunBackend.Operations.Count == 2
                    && successfulFirstRunBackend.Operations[0] == "refresh-login"
                    && successfulFirstRunBackend.Operations[1] == "full";

                BackendStatus failedSignInStatus = CloneStatus(status);
                failedSignInStatus.configured = false;
                failedSignInStatus.baseUrlConfigured = false;
                var failedSignInBackend = new ScriptedBackendClient(failedSignInStatus, new BackendProcessResult { ExitCode = 0 });
                failedSignInBackend.RefreshLoginResult = new BackendProcessResult { ExitCode = 1, StandardError = "Synthetic sign-in cancellation." };
                var failedSignInDialog = new ScriptedSettingsDialogService(true, delegate
                {
                    failedSignInStatus.configured = true;
                    failedSignInStatus.baseUrlConfigured = true;
                });
                using (var failedSignInForm = new MainForm(failedSignInBackend, MainForm.StatusRefreshIntervalMilliseconds, failedSignInDialog))
                {
                    await failedSignInForm.InitializeForSelfTestAsync();
                }
                bool failedSignInSkipsInitialFullSync = failedSignInBackend.RefreshLoginCalls == 1
                    && failedSignInBackend.SyncCalls == 0
                    && failedSignInStatus.configured;

                BackendStatus failedInitialSyncStatus = CloneStatus(status);
                failedInitialSyncStatus.configured = false;
                failedInitialSyncStatus.baseUrlConfigured = false;
                var failedInitialSyncBackend = new ScriptedBackendClient(failedInitialSyncStatus, new BackendProcessResult { ExitCode = 0 });
                failedInitialSyncBackend.SyncResult = new BackendProcessResult { ExitCode = 1, StandardError = "Synthetic initial sync failure." };
                var failedInitialSyncDialog = new ScriptedSettingsDialogService(true, delegate
                {
                    failedInitialSyncStatus.configured = true;
                    failedInitialSyncStatus.baseUrlConfigured = true;
                });
                using (var failedInitialSyncForm = new MainForm(failedInitialSyncBackend, MainForm.StatusRefreshIntervalMilliseconds, failedInitialSyncDialog))
                {
                    await failedInitialSyncForm.InitializeForSelfTestAsync();
                }
                bool failedInitialFullSyncPreservesConfiguration = failedInitialSyncBackend.RefreshLoginCalls == 1
                    && failedInitialSyncBackend.SyncCalls == 1
                    && failedInitialSyncStatus.configured;

                BackendStatus existingConfiguredStatus = CloneStatus(status);
                var existingConfiguredBackend = new ScriptedBackendClient(existingConfiguredStatus, new BackendProcessResult { ExitCode = 0 });
                var existingConfiguredDialog = new ScriptedSettingsDialogService(false);
                using (var existingConfiguredForm = new MainForm(existingConfiguredBackend, MainForm.StatusRefreshIntervalMilliseconds, existingConfiguredDialog))
                {
                    await existingConfiguredForm.InitializeForSelfTestAsync();
                }
                bool configuredInstallSkipsFirstRun = existingConfiguredDialog.ShowCalls == 0
                    && existingConfiguredBackend.RefreshLoginCalls == 0
                    && existingConfiguredBackend.SyncCalls == 0;

                var cancelBackend = new ScriptedBackendClient(status, new BackendProcessResult { ExitCode = 0 });
                using (var settingsForm = new SetupSettingsForm(cancelBackend, currentSettings, false, new NullFolderPicker()))
                {
                    settingsForm.CancelForSelfTest();
                }
                bool settingsCancelSavesNothing = cancelBackend.SaveCalls == 0;
                var formSaveBackend = new ScriptedBackendClient(status, new BackendProcessResult { ExitCode = 0 });
                bool sharedSettingsFormSavesThroughBackend;
                using (var settingsForm = new SetupSettingsForm(formSaveBackend, currentSettings, false, new NullFolderPicker()))
                    sharedSettingsFormSavesThroughBackend = await settingsForm.SaveForSelfTestAsync(null) && formSaveBackend.SaveCalls == 1;
                bool environmentOverrideIsReadOnly;
                using (var settingsForm = new SetupSettingsForm(cancelBackend, currentSettings, false, new NullFolderPicker()))
                    environmentOverrideIsReadOnly = currentSettings.mirrorOverrideActive && !settingsForm.MirrorEditableForSelfTest;

                DesktopSettings freshFormSettings = new DesktopSettings
                {
                    schemaVersion = 1,
                    configured = false,
                    baseUrl = String.Empty,
                    mirrorDir = initialSettings.mirrorDir,
                    mirrorOverrideActive = false,
                    maySuggestFirstRunMirror = true,
                    drive = new DesktopDriveSettings { enabled = false, destination = String.Empty }
                };
                string firstRunMirror;
                bool firstRunScheduleDefaultsOff;
                using (var settingsForm = new SetupSettingsForm(cancelBackend, freshFormSettings, true, new NullFolderPicker()))
                {
                    SettingsSaveRequest firstRunRequest = settingsForm.RequestForSelfTest();
                    firstRunMirror = firstRunRequest.mirrorDir;
                    firstRunScheduleDefaultsOff = firstRunRequest.schedule != null && !firstRunRequest.schedule.enabled
                        && firstRunRequest.schedule.intervalHours == 6
                        && firstRunRequest.schedule.fullIntervalDays == 7;
                }
                bool firstRunUsesKnownDocuments = String.Equals(firstRunMirror, SetupSettingsForm.SuggestedFirstRunMirror(), StringComparison.OrdinalIgnoreCase);

                DesktopSettings customMissingUrlSettings = new DesktopSettings
                {
                    schemaVersion = 1,
                    configured = false,
                    baseUrl = String.Empty,
                    mirrorDir = Path.Combine(status.mirrorDir, "Existing Custom Mirror"),
                    mirrorOverrideActive = false,
                    maySuggestFirstRunMirror = false,
                    drive = new DesktopDriveSettings { enabled = false, destination = String.Empty }
                };
                string customFirstRunMirror;
                using (var settingsForm = new SetupSettingsForm(cancelBackend, customMissingUrlSettings, true, new NullFolderPicker()))
                    customFirstRunMirror = settingsForm.RequestForSelfTest().mirrorDir;
                bool firstRunPreservesCustomMirror = String.Equals(customFirstRunMirror, customMissingUrlSettings.mirrorDir, StringComparison.OrdinalIgnoreCase);

                DesktopSettings meaningfulDefaultSettings = new DesktopSettings
                {
                    schemaVersion = 1,
                    configured = false,
                    baseUrl = String.Empty,
                    mirrorDir = initialSettings.mirrorDir,
                    mirrorOverrideActive = false,
                    maySuggestFirstRunMirror = false,
                    drive = new DesktopDriveSettings { enabled = false, destination = String.Empty }
                };
                string meaningfulFirstRunMirror;
                using (var settingsForm = new SetupSettingsForm(cancelBackend, meaningfulDefaultSettings, true, new NullFolderPicker()))
                    meaningfulFirstRunMirror = settingsForm.RequestForSelfTest().mirrorDir;
                bool firstRunPreservesMeaningfulDefault = String.Equals(meaningfulFirstRunMirror, meaningfulDefaultSettings.mirrorDir, StringComparison.OrdinalIgnoreCase);

                DesktopSettings overrideFirstRunSettings = new DesktopSettings
                {
                    schemaVersion = 1,
                    configured = false,
                    baseUrl = String.Empty,
                    mirrorDir = currentSettings.mirrorDir,
                    mirrorOverrideActive = true,
                    maySuggestFirstRunMirror = false,
                    drive = new DesktopDriveSettings { enabled = false, destination = String.Empty }
                };
                bool firstRunPreservesEnvironmentOverride;
                using (var settingsForm = new SetupSettingsForm(cancelBackend, overrideFirstRunSettings, true, new NullFolderPicker()))
                {
                    firstRunPreservesEnvironmentOverride =
                        String.Equals(settingsForm.RequestForSelfTest().mirrorDir, overrideFirstRunSettings.mirrorDir, StringComparison.OrdinalIgnoreCase)
                        && !settingsForm.MirrorEditableForSelfTest;
                }

                string syntheticBrowserPath = Path.Combine(status.dataDir, "Synthetic Browser", "browser.exe");
                bool manualBrowserRoundTrips;
                bool automaticBrowserReset;
                using (var settingsForm = new SetupSettingsForm(cancelBackend, currentSettings, false, new NullFolderPicker()))
                {
                    bool selected = await settingsForm.ChooseBrowserForSelfTestAsync(syntheticBrowserPath);
                    SettingsSaveRequest selectedRequest = settingsForm.RequestForSelfTest();
                    manualBrowserRoundTrips = selected
                        && String.Equals(cancelBackend.LastBrowserProbePath, syntheticBrowserPath, StringComparison.OrdinalIgnoreCase)
                        && !String.IsNullOrWhiteSpace(settingsForm.BrowserPathForSelfTest)
                        && String.Equals(
                            selectedRequest.browser.executablePath,
                            settingsForm.BrowserPathForSelfTest,
                            StringComparison.OrdinalIgnoreCase);
                    await settingsForm.UseAutomaticBrowserForSelfTestAsync();
                    automaticBrowserReset = String.IsNullOrWhiteSpace(settingsForm.RequestForSelfTest().browser.executablePath)
                        && String.IsNullOrWhiteSpace(cancelBackend.LastBrowserProbePath);
                }
                DesktopSettings missingBrowserSettings = new DesktopSettings
                {
                    schemaVersion = 1,
                    configured = false,
                    baseUrl = String.Empty,
                    mirrorDir = initialSettings.mirrorDir,
                    mayImportLegacySetup = true,
                    drive = new DesktopDriveSettings { enabled = false, destination = String.Empty },
                    browser = new DesktopBrowserSettings { schemaVersion = 1, engine = "chromium", available = false, validationStatus = "not-detected" }
                };
                bool missingBrowserRecoveryVisible;
                bool importOfferedOnlyOnFirstRun;
                using (var settingsForm = new SetupSettingsForm(cancelBackend, missingBrowserSettings, true, new NullFolderPicker()))
                {
                    missingBrowserRecoveryVisible = settingsForm.BrowserStatusForSelfTest.Contains("No compatible Chromium browser")
                        && SetupSettingsForm.EdgeDownloadUrl == "https://www.microsoft.com/edge/download";
                    importOfferedOnlyOnFirstRun = settingsForm.ImportVisibleForSelfTest;
                }
                using (var settingsForm = new SetupSettingsForm(cancelBackend, missingBrowserSettings, false, new NullFolderPicker()))
                    importOfferedOnlyOnFirstRun = importOfferedOnlyOnFirstRun && !settingsForm.ImportVisibleForSelfTest;

                stage = "credential settings behavior";
                const string syntheticUsername = "SyntheticStudent";
                const string syntheticPassword = "SyntheticPasswordValue123";
                const string replacementPassword = "ReplacementPasswordValue456";
                var legacyTargetStore = new FakeCredentialStore(syntheticUsername, syntheticPassword, true);
                var compatibleStore = new CompatibleCredentialStore(legacyTargetStore);
                bool legacyCredentialTargetCompatible;
                using (CredentialRecord legacyRecord = compatibleStore.Read(WindowsCredentialStore.StonyBrookTarget))
                {
                    legacyCredentialTargetCompatible = legacyRecord != null
                        && String.Equals(legacyRecord.Username, syntheticUsername, StringComparison.Ordinal);
                }
                compatibleStore.Write(WindowsCredentialStore.StonyBrookTarget, syntheticUsername, replacementPassword);
                legacyCredentialTargetCompatible = legacyCredentialTargetCompatible
                    && String.Equals(legacyTargetStore.CurrentTarget, WindowsCredentialStore.StonyBrookTarget, StringComparison.Ordinal)
                    && String.Equals(legacyTargetStore.CurrentPassword, replacementPassword, StringComparison.Ordinal);
                DesktopSettings stonyBrookSettings = new DesktopSettings
                {
                    schemaVersion = 1,
                    configured = true,
                    baseUrl = "https://mycourses.stonybrook.edu",
                    mirrorDir = currentSettings.mirrorDir,
                    mirrorOverrideActive = false,
                    maySuggestFirstRunMirror = false,
                    drive = new DesktopDriveSettings { enabled = false, destination = String.Empty },
                    authentication = new DesktopAuthenticationSettings
                    {
                        supported = true,
                        institution = "stony-brook",
                        automaticLoginEnabled = true
                    }
                };
                var keepStore = new FakeCredentialStore(syntheticUsername, syntheticPassword);
                var keepBackend = new ScriptedBackendClient(status, new BackendProcessResult { ExitCode = 0 });
                bool existingPasswordNotRedisplayed;
                bool blankPasswordKeepsCredential;
                bool credentialPayloadExcludedFromBackend;
                using (var settingsForm = new SetupSettingsForm(keepBackend, stonyBrookSettings, false, new NullFolderPicker(), keepStore))
                {
                    existingPasswordNotRedisplayed = settingsForm.AuthenticationVisibleForSelfTest
                        && settingsForm.CredentialExistsForSelfTest
                        && settingsForm.PasswordForSelfTest.Length == 0;
                    blankPasswordKeepsCredential = await settingsForm.SaveForSelfTestAsync(null)
                        && keepStore.WriteCalls == 0
                        && keepStore.DeleteCalls == 0;
                    string backendPayload = new JavaScriptSerializer().Serialize(keepBackend.LastSettingsRequest);
                    credentialPayloadExcludedFromBackend = backendPayload.IndexOf(syntheticUsername, StringComparison.OrdinalIgnoreCase) < 0
                        && backendPayload.IndexOf(syntheticPassword, StringComparison.OrdinalIgnoreCase) < 0
                        && backendPayload.IndexOf("username", StringComparison.OrdinalIgnoreCase) < 0
                        && backendPayload.IndexOf("password", StringComparison.OrdinalIgnoreCase) < 0;
                }

                var replaceStore = new FakeCredentialStore(syntheticUsername, syntheticPassword);
                var replaceBackend = new ScriptedBackendClient(status, new BackendProcessResult { ExitCode = 0 });
                bool credentialReplacementWorks;
                bool passwordClearedAfterSave;
                using (var settingsForm = new SetupSettingsForm(replaceBackend, stonyBrookSettings, false, new NullFolderPicker(), replaceStore))
                {
                    settingsForm.SetAuthenticationForSelfTest(true, syntheticUsername, replacementPassword);
                    credentialReplacementWorks = await settingsForm.SaveForSelfTestAsync(null)
                        && replaceStore.WriteCalls == 1
                        && replaceStore.CurrentPassword == replacementPassword;
                    passwordClearedAfterSave = settingsForm.PasswordForSelfTest.Length == 0;
                }

                var rejectedResponse = new SettingsSaveResponse
                {
                    schemaVersion = 1,
                    ok = false,
                    errors = new[] { new SettingsValidationError { field = "baseUrl", code = "invalid-url", message = "Enter a valid HTTPS Brightspace URL." } }
                };
                var rollbackStore = new FakeCredentialStore(syntheticUsername, syntheticPassword);
                var rejectedBackend = new ScriptedBackendClient(status, new BackendProcessResult { ExitCode = 0 }, rejectedResponse);
                bool rejectedSettingsRestoreCredential;
                using (var settingsForm = new SetupSettingsForm(rejectedBackend, stonyBrookSettings, false, new NullFolderPicker(), rollbackStore))
                {
                    settingsForm.SetAuthenticationForSelfTest(true, syntheticUsername, replacementPassword);
                    rejectedSettingsRestoreCredential = !await settingsForm.SaveForSelfTestAsync(null)
                        && rollbackStore.WriteCalls == 2
                        && rollbackStore.CurrentPassword == syntheticPassword;
                }

                var replaceThrowStore = new FakeCredentialStore(syntheticUsername, syntheticPassword);
                var replaceThrowBackend = new ScriptedBackendClient(status, new BackendProcessResult { ExitCode = 0 })
                {
                    SaveException = new BackendCommandException(replacementPassword, 17)
                };
                bool backendThrowRestoresReplacedCredential;
                string replaceThrowMessage;
                using (var settingsForm = new SetupSettingsForm(replaceThrowBackend, stonyBrookSettings, false, new NullFolderPicker(), replaceThrowStore))
                {
                    settingsForm.SetAuthenticationForSelfTest(true, syntheticUsername, replacementPassword);
                    backendThrowRestoresReplacedCredential = !await settingsForm.SaveForSelfTestAsync(null)
                        && replaceThrowStore.WriteCalls == 2
                        && replaceThrowStore.CurrentPassword == syntheticPassword
                        && settingsForm.PasswordForSelfTest.Length == 0;
                    replaceThrowMessage = settingsForm.ValidationTextForSelfTest;
                }

                var deleteThrowStore = new FakeCredentialStore(syntheticUsername, syntheticPassword);
                var deleteThrowBackend = new ScriptedBackendClient(status, new BackendProcessResult { ExitCode = 0 })
                {
                    SaveException = new InvalidDataException(replacementPassword)
                };
                bool backendThrowRestoresDeletedCredential;
                string deleteThrowMessage;
                using (var settingsForm = new SetupSettingsForm(deleteThrowBackend, stonyBrookSettings, false, new NullFolderPicker(), deleteThrowStore))
                {
                    settingsForm.RemoveCredentialForSelfTest();
                    backendThrowRestoresDeletedCredential = !await settingsForm.SaveForSelfTestAsync(null)
                        && deleteThrowStore.DeleteCalls == 1
                        && deleteThrowStore.WriteCalls == 1
                        && deleteThrowStore.CurrentPassword == syntheticPassword
                        && settingsForm.PasswordForSelfTest.Length == 0;
                    deleteThrowMessage = settingsForm.ValidationTextForSelfTest;
                }

                var createThrowStore = new FakeCredentialStore();
                var createThrowBackend = new ScriptedBackendClient(status, new BackendProcessResult { ExitCode = 0 })
                {
                    SaveException = new InvalidOperationException(replacementPassword)
                };
                bool backendThrowRemovesNewCredential;
                string createThrowMessage;
                using (var settingsForm = new SetupSettingsForm(createThrowBackend, stonyBrookSettings, false, new NullFolderPicker(), createThrowStore))
                {
                    settingsForm.SetAuthenticationForSelfTest(true, syntheticUsername, replacementPassword);
                    backendThrowRemovesNewCredential = !await settingsForm.SaveForSelfTestAsync(null)
                        && createThrowStore.WriteCalls == 1
                        && createThrowStore.DeleteCalls == 1
                        && !createThrowStore.Exists
                        && settingsForm.PasswordForSelfTest.Length == 0;
                    createThrowMessage = settingsForm.ValidationTextForSelfTest;
                }

                var rollbackFailureStore = new FakeCredentialStore(syntheticUsername, syntheticPassword) { FailWriteOnCall = 2 };
                var rollbackFailureBackend = new ScriptedBackendClient(status, new BackendProcessResult { ExitCode = 0 })
                {
                    SaveException = new InvalidOperationException(replacementPassword)
                };
                bool backendThrowRollbackFailureWarnsSafely;
                string rollbackFailureMessage;
                using (var settingsForm = new SetupSettingsForm(rollbackFailureBackend, stonyBrookSettings, false, new NullFolderPicker(), rollbackFailureStore))
                {
                    settingsForm.SetAuthenticationForSelfTest(true, syntheticUsername, replacementPassword);
                    backendThrowRollbackFailureWarnsSafely = !await settingsForm.SaveForSelfTestAsync(null)
                        && settingsForm.ValidationTextForSelfTest.IndexOf("manual review", StringComparison.OrdinalIgnoreCase) >= 0
                        && settingsForm.PasswordForSelfTest.Length == 0;
                    rollbackFailureMessage = settingsForm.ValidationTextForSelfTest;
                }

                string credentialExceptionMessages = String.Join("\n", new[] {
                    replaceThrowMessage, deleteThrowMessage, createThrowMessage, rollbackFailureMessage
                });
                AssertAbsent(credentialExceptionMessages, syntheticPassword, "credential exception UI exposed the previous password");
                AssertAbsent(credentialExceptionMessages, replacementPassword, "credential exception UI exposed the replacement password");
                foreach (ScriptedBackendClient throwingBackend in new[] { replaceThrowBackend, deleteThrowBackend, createThrowBackend, rollbackFailureBackend })
                {
                    string payload = new JavaScriptSerializer().Serialize(throwingBackend.LastSettingsRequest);
                    AssertAbsent(payload, syntheticPassword, "settings payload exposed the previous password");
                    AssertAbsent(payload, replacementPassword, "settings payload exposed the replacement password");
                }
                if (!backendThrowRestoresReplacedCredential || !backendThrowRestoresDeletedCredential
                    || !backendThrowRemovesNewCredential || !backendThrowRollbackFailureWarnsSafely)
                    throw new InvalidDataException("Credential rollback did not safely cover every backend save exception case.");

                var deleteStore = new FakeCredentialStore(syntheticUsername, syntheticPassword);
                var deleteBackend = new ScriptedBackendClient(status, new BackendProcessResult { ExitCode = 0 });
                bool credentialDeletionWorks;
                using (var settingsForm = new SetupSettingsForm(deleteBackend, stonyBrookSettings, false, new NullFolderPicker(), deleteStore))
                {
                    settingsForm.RemoveCredentialForSelfTest();
                    credentialDeletionWorks = await settingsForm.SaveForSelfTestAsync(null)
                        && deleteStore.DeleteCalls == 1
                        && !deleteStore.Exists
                        && !deleteBackend.LastSettingsRequest.authentication.automaticLoginEnabled;
                }

                var failingStore = new FakeCredentialStore(syntheticUsername, syntheticPassword) { FailWrites = true };
                var failingCredentialBackend = new ScriptedBackendClient(status, new BackendProcessResult { ExitCode = 0 });
                bool credentialFailureIsSafe;
                using (var settingsForm = new SetupSettingsForm(failingCredentialBackend, stonyBrookSettings, false, new NullFolderPicker(), failingStore))
                {
                    settingsForm.SetAuthenticationForSelfTest(true, syntheticUsername, replacementPassword);
                    bool saved = await settingsForm.SaveForSelfTestAsync(null);
                    string failureText = settingsForm.ValidationTextForSelfTest;
                    credentialFailureIsSafe = !saved
                        && failingCredentialBackend.SaveCalls == 0
                        && failureText.IndexOf(replacementPassword, StringComparison.OrdinalIgnoreCase) < 0
                        && settingsForm.PasswordForSelfTest.Length == 0;
                }

                DesktopSettings genericSettings = new DesktopSettings
                {
                    schemaVersion = 1,
                    configured = true,
                    baseUrl = "https://example.test",
                    mirrorDir = currentSettings.mirrorDir,
                    drive = new DesktopDriveSettings { enabled = false, destination = String.Empty },
                    authentication = new DesktopAuthenticationSettings { supported = false, institution = String.Empty, automaticLoginEnabled = false }
                };
                bool genericCredentialFieldsHidden;
                using (var settingsForm = new SetupSettingsForm(cancelBackend, genericSettings, false, new NullFolderPicker(), new FakeCredentialStore()))
                    genericCredentialFieldsHidden = !settingsForm.AuthenticationVisibleForSelfTest;

                string recoveryOld = Path.Combine(status.mirrorDir, "Recovery Old");
                string recoveryNew = Path.Combine(status.mirrorDir, "Recovery New");
                string recoveryJson = new JavaScriptSerializer().Serialize(new
                {
                    schemaVersion = 1,
                    ok = false,
                    errors = new[] { new { field = "mirrorDir", code = "mirror-rollback-failed", message = "Automatic rollback did not complete." } },
                    recovery = new
                    {
                        required = true,
                        oldMirrorDir = recoveryOld,
                        newMirrorDir = recoveryNew,
                        configRetainedOldLocation = true
                    }
                });
                SettingsSaveResponse recoveryResponse = backend.ParseSettingsSaveResponseForSelfTest(recoveryJson);
                bool recoverySurvivesBackendBridge = recoveryResponse.recovery != null
                    && recoveryResponse.recovery.required
                    && recoveryResponse.recovery.configRetainedOldLocation
                    && recoveryResponse.recovery.oldMirrorDir == recoveryOld
                    && recoveryResponse.recovery.newMirrorDir == recoveryNew;
                var recoveryBackend = new ScriptedBackendClient(status, new BackendProcessResult { ExitCode = 0 }, recoveryResponse);
                bool recoveryPresentedToUi;
                using (var settingsForm = new SetupSettingsForm(recoveryBackend, currentSettings, false, new NullFolderPicker()))
                {
                    bool recoverySaveResult = await settingsForm.SaveForSelfTestAsync(null);
                    string recoveryText = settingsForm.ValidationTextForSelfTest;
                    recoveryPresentedToUi = !recoverySaveResult
                        && recoveryText.IndexOf("Manual recovery may be required", StringComparison.OrdinalIgnoreCase) >= 0
                        && recoveryText.Contains(recoveryOld)
                        && recoveryText.Contains(recoveryNew)
                        && recoveryText.IndexOf("still point", StringComparison.OrdinalIgnoreCase) >= 0;
                }

                stage = "scheduled task transactions";
                bool scheduledEntrypointSelected = Program.IsScheduledRun(new[] { "--scheduled-run" })
                    && !Program.IsScheduledRun(new[] { "--scheduled-run", "unexpected" });
                var scheduledCommandBackend = new ScriptedBackendClient(status, new BackendProcessResult { ExitCode = 23 });
                bool scheduledEntrypointReturnsBackendCode = ScheduledRunCommand.Run(scheduledCommandBackend) == 23
                    && scheduledCommandBackend.ScheduledCalls == 1;

                var enableScheduler = new FakeTaskSchedulerService(null);
                var enableBackend = new ScriptedBackendClient(status, new BackendProcessResult { ExitCode = 0 });
                bool scheduleEnableSaved;
                using (var settingsForm = new SetupSettingsForm(
                    enableBackend, currentSettings, false, new NullFolderPicker(),
                    new FakeCredentialStore(), enableScheduler))
                {
                    settingsForm.SetScheduleForSelfTest(true, 4, 9);
                    scheduleEnableSaved = await settingsForm.SaveForSelfTestAsync(null)
                        && enableBackend.LastSettingsRequest.schedule.enabled
                        && enableBackend.LastSettingsRequest.schedule.intervalHours == 4
                        && enableBackend.LastSettingsRequest.schedule.fullIntervalDays == 9
                        && enableScheduler.CurrentRequest.Enabled
                        && enableScheduler.CurrentRequest.IntervalHours == 4;
                }

                var optionalUnavailableScheduler = new FakeTaskSchedulerService(null) { FailInspect = true };
                var optionalUnavailableBackend = new ScriptedBackendClient(status, new BackendProcessResult { ExitCode = 0 });
                bool disabledScheduleDoesNotRequireTaskScheduler;
                using (var settingsForm = new SetupSettingsForm(
                    optionalUnavailableBackend, currentSettings, false, new NullFolderPicker(),
                    new FakeCredentialStore(), optionalUnavailableScheduler))
                {
                    bool saved = await settingsForm.SaveForSelfTestAsync(null);
                    disabledScheduleDoesNotRequireTaskScheduler = saved
                        && optionalUnavailableBackend.SaveCalls == 1
                        && optionalUnavailableScheduler.ApplyCalls == 0
                        && settingsForm.ValidationTextForSelfTest.IndexOf("scheduling is unavailable", StringComparison.OrdinalIgnoreCase) >= 0;
                }

                var unavailableEnableScheduler = new FakeTaskSchedulerService(null) { FailCapture = true };
                var unavailableEnableBackend = new ScriptedBackendClient(status, new BackendProcessResult { ExitCode = 0 });
                bool unavailableEnableLeavesConfigDisabled;
                using (var settingsForm = new SetupSettingsForm(
                    unavailableEnableBackend, currentSettings, false, new NullFolderPicker(),
                    new FakeCredentialStore(), unavailableEnableScheduler))
                {
                    settingsForm.SetScheduleForSelfTest(true, 5, 7);
                    bool saved = await settingsForm.SaveForSelfTestAsync(null);
                    unavailableEnableLeavesConfigDisabled = !saved && unavailableEnableBackend.SaveCalls == 0;
                }

                var enabledScheduleSettings = new DesktopSettings
                {
                    schemaVersion = currentSettings.schemaVersion,
                    configured = currentSettings.configured,
                    baseUrl = currentSettings.baseUrl,
                    mirrorDir = currentSettings.mirrorDir,
                    mirrorOverrideActive = currentSettings.mirrorOverrideActive,
                    maySuggestFirstRunMirror = currentSettings.maySuggestFirstRunMirror,
                    drive = currentSettings.drive,
                    authentication = currentSettings.authentication,
                    schedule = new DesktopScheduleSettings { enabled = true, intervalHours = 6, fullIntervalDays = 7 }
                };
                var unavailableCadenceScheduler = new FakeTaskSchedulerService("enabled-task") { FailCapture = true };
                var unavailableCadenceBackend = new ScriptedBackendClient(status, new BackendProcessResult { ExitCode = 0 });
                bool unavailableCadenceChangeFailsSafely;
                using (var settingsForm = new SetupSettingsForm(
                    unavailableCadenceBackend, enabledScheduleSettings, false, new NullFolderPicker(),
                    new FakeCredentialStore(), unavailableCadenceScheduler))
                {
                    settingsForm.SetScheduleForSelfTest(true, 3, 7);
                    bool saved = await settingsForm.SaveForSelfTestAsync(null);
                    unavailableCadenceChangeFailsSafely = !saved && unavailableCadenceBackend.SaveCalls == 0;
                }

                var unavailableDisableScheduler = new FakeTaskSchedulerService("enabled-task") { FailCapture = true };
                var unavailableDisableBackend = new ScriptedBackendClient(status, new BackendProcessResult { ExitCode = 0 });
                bool unavailableDisableCannotAccidentallyEnable;
                using (var settingsForm = new SetupSettingsForm(
                    unavailableDisableBackend, enabledScheduleSettings, false, new NullFolderPicker(),
                    new FakeCredentialStore(), unavailableDisableScheduler))
                {
                    settingsForm.SetScheduleForSelfTest(false, 6, 7);
                    bool saved = await settingsForm.SaveForSelfTestAsync(null);
                    unavailableDisableCannotAccidentallyEnable = !saved
                        && unavailableDisableBackend.SaveCalls == 0
                        && unavailableDisableScheduler.CurrentXml == "enabled-task"
                        && settingsForm.ValidationTextForSelfTest.IndexOf("previous enabled schedule remains", StringComparison.OrdinalIgnoreCase) >= 0;
                }

                var laterRepairScheduler = new FakeTaskSchedulerService("stale-disabled-task") { FailInspect = true };
                var laterRepairBackend = new ScriptedBackendClient(status, new BackendProcessResult { ExitCode = 0 });
                bool laterAvailabilityRepairsStaleTask;
                using (var settingsForm = new SetupSettingsForm(
                    laterRepairBackend, currentSettings, false, new NullFolderPicker(),
                    new FakeCredentialStore(), laterRepairScheduler))
                {
                    bool savedWhileUnavailable = await settingsForm.SaveForSelfTestAsync(null);
                    laterRepairScheduler.FailInspect = false;
                    using (var retryForm = new SetupSettingsForm(
                        laterRepairBackend, currentSettings, false, new NullFolderPicker(),
                        new FakeCredentialStore(), laterRepairScheduler))
                    {
                        bool repaired = await retryForm.SaveForSelfTestAsync(null);
                        laterAvailabilityRepairsStaleTask = savedWhileUnavailable
                            && repaired
                            && laterRepairScheduler.CurrentXml == null;
                    }
                }

                const string priorTaskDefinition = "prior-exact-task-definition";
                var rollbackScheduler = new FakeTaskSchedulerService(priorTaskDefinition);
                var failedScheduleBackend = new ScriptedBackendClient(status, new BackendProcessResult { ExitCode = 0 })
                {
                    SaveException = new InvalidOperationException("Synthetic settings persistence failure.")
                };
                bool configFailureRestoresExactTask;
                using (var settingsForm = new SetupSettingsForm(
                    failedScheduleBackend, currentSettings, false, new NullFolderPicker(),
                    new FakeCredentialStore(), rollbackScheduler))
                {
                    settingsForm.SetScheduleForSelfTest(true, 3, 8);
                    bool saved = await settingsForm.SaveForSelfTestAsync(null);
                    configFailureRestoresExactTask = !saved
                        && rollbackScheduler.CurrentXml == priorTaskDefinition
                        && rollbackScheduler.RestoreCalls == 1;
                }

                var creationFailureScheduler = new FakeTaskSchedulerService(null) { FailApply = true };
                var creationFailureBackend = new ScriptedBackendClient(status, new BackendProcessResult { ExitCode = 0 });
                bool taskCreationFailureLeavesConfigDisabled;
                using (var settingsForm = new SetupSettingsForm(
                    creationFailureBackend, currentSettings, false, new NullFolderPicker(),
                    new FakeCredentialStore(), creationFailureScheduler))
                {
                    settingsForm.SetScheduleForSelfTest(true, 5, 7);
                    bool saved = await settingsForm.SaveForSelfTestAsync(null);
                    taskCreationFailureLeavesConfigDisabled = !saved
                        && creationFailureBackend.SaveCalls == 0
                        && creationFailureScheduler.CurrentXml == null;
                }

                var rollbackFailureScheduler = new FakeTaskSchedulerService(priorTaskDefinition) { FailRestore = true };
                var taskRollbackFailureBackend = new ScriptedBackendClient(status, new BackendProcessResult { ExitCode = 0 })
                {
                    SaveException = new InvalidOperationException("Synthetic settings persistence failure.")
                };
                bool taskRollbackFailureSurfaced;
                using (var settingsForm = new SetupSettingsForm(
                    taskRollbackFailureBackend, currentSettings, false, new NullFolderPicker(),
                    new FakeCredentialStore(), rollbackFailureScheduler))
                {
                    settingsForm.SetScheduleForSelfTest(true, 2, 7);
                    bool saved = await settingsForm.SaveForSelfTestAsync(null);
                    taskRollbackFailureSurfaced = !saved
                        && settingsForm.ValidationTextForSelfTest.IndexOf("manual review", StringComparison.OrdinalIgnoreCase) >= 0;
                }

                var disableScheduler = new FakeTaskSchedulerService(priorTaskDefinition);
                var disableBackend = new ScriptedBackendClient(status, new BackendProcessResult { ExitCode = 0 });
                bool scheduleDisableDeletesExactTask;
                using (var settingsForm = new SetupSettingsForm(
                    disableBackend, currentSettings, false, new NullFolderPicker(),
                    new FakeCredentialStore(), disableScheduler))
                {
                    settingsForm.SetScheduleForSelfTest(false, 6, 7);
                    scheduleDisableDeletesExactTask = await settingsForm.SaveForSelfTestAsync(null)
                        && disableScheduler.CurrentXml == null
                        && disableScheduler.UnrelatedTask == "unrelated-task-preserved";
                }

                var combinedStore = new FakeCredentialStore(syntheticUsername, syntheticPassword);
                var combinedScheduler = new FakeTaskSchedulerService(priorTaskDefinition);
                var combinedBackend = new ScriptedBackendClient(status, new BackendProcessResult { ExitCode = 0 })
                {
                    SaveException = new InvalidOperationException("Synthetic combined transaction failure.")
                };
                bool combinedCredentialAndTaskRollback;
                using (var settingsForm = new SetupSettingsForm(
                    combinedBackend, stonyBrookSettings, false, new NullFolderPicker(),
                    combinedStore, combinedScheduler))
                {
                    settingsForm.SetAuthenticationForSelfTest(true, syntheticUsername, replacementPassword);
                    settingsForm.SetScheduleForSelfTest(true, 2, 5);
                    bool saved = await settingsForm.SaveForSelfTestAsync(null);
                    combinedCredentialAndTaskRollback = !saved
                        && combinedStore.CurrentPassword == syntheticPassword
                        && combinedScheduler.CurrentXml == priorTaskDefinition;
                }

                const string syntheticSidA = "S-1-5-21-1000000001-1000000002-1000000003-1001";
                const string syntheticSidB = "S-1-5-21-1000000001-1000000002-1000000003-1002";
                string syntheticTaskA = WindowsTaskSchedulerService.TaskNameForSid(syntheticSidA);
                string syntheticTaskB = WindowsTaskSchedulerService.TaskNameForSid(syntheticSidB);
                var syntheticServiceA = new WindowsTaskSchedulerService(syntheticSidA);
                var syntheticServiceB = new WindowsTaskSchedulerService(syntheticSidB);
                var syntheticTaskLibrary = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
                {
                    { syntheticServiceA.ManagedTaskName, "user-a-task" },
                    { syntheticServiceB.ManagedTaskName, "user-b-task" }
                };
                syntheticTaskLibrary[syntheticServiceA.ManagedTaskName] = "user-a-repaired";
                syntheticTaskLibrary.Remove(syntheticServiceA.ManagedTaskName);
                bool perUserTaskIdentityIsolated = !String.Equals(syntheticTaskA, syntheticTaskB, StringComparison.OrdinalIgnoreCase)
                    && syntheticServiceA.ManagedTaskName == syntheticTaskA
                    && syntheticServiceB.ManagedTaskName == syntheticTaskB
                    && syntheticServiceA.ManagedTaskName != syntheticServiceB.ManagedTaskName
                    && !syntheticTaskLibrary.ContainsKey(syntheticServiceA.ManagedTaskName)
                    && syntheticTaskLibrary[syntheticServiceB.ManagedTaskName] == "user-b-task";
                bool taskIdentityAndArgumentsAreFixed = WindowsTaskSchedulerService.FolderPath == @"\CourseStow"
                    && WindowsTaskSchedulerService.LegacyFolderPath == @"\Brightspace Sync"
                    && WindowsTaskSchedulerService.TaskArguments == "--scheduled-run"
                    && !WindowsTaskSchedulerService.TaskArguments.Contains("password")
                    && !WindowsTaskSchedulerService.TaskArguments.Contains("config")
                    && !WindowsTaskSchedulerService.TaskArguments.Contains(syntheticSidA)
                    && !WindowsTaskSchedulerService.TaskArguments.Contains(syntheticSidB);
                var legacyTaskScheduler = new FakeTaskSchedulerService(null, "legacy-current-user-task");
                var legacyTaskBackend = new ScriptedBackendClient(status, new BackendProcessResult { ExitCode = 0 });
                bool legacyCurrentUserTaskReconciled;
                using (var settingsForm = new SetupSettingsForm(
                    legacyTaskBackend, currentSettings, false, new NullFolderPicker(),
                    new FakeCredentialStore(), legacyTaskScheduler))
                {
                    legacyCurrentUserTaskReconciled = await settingsForm.SaveForSelfTestAsync(null)
                        && legacyTaskScheduler.CurrentXml == null
                        && legacyTaskScheduler.LegacyXml == null
                        && legacyTaskScheduler.UnrelatedTask == "unrelated-task-preserved";
                }
                bool indefiniteTaskPolicyValidated = WindowsTaskSchedulerService.HasIndefiniteTimePolicy("PT0S", String.Empty, String.Empty)
                    && WindowsTaskSchedulerService.HasIndefiniteTimePolicy("PT0S", "PT0S", null)
                    && !WindowsTaskSchedulerService.HasIndefiniteTimePolicy("PT4H", String.Empty, String.Empty)
                    && !WindowsTaskSchedulerService.HasIndefiniteTimePolicy("PT0S", "P1D", String.Empty)
                    && !WindowsTaskSchedulerService.HasIndefiniteTimePolicy("PT0S", String.Empty, "2026-09-12T12:00:00");

                var reconcileSettings = new DesktopSettings
                {
                    schemaVersion = currentSettings.schemaVersion,
                    configured = currentSettings.configured,
                    baseUrl = currentSettings.baseUrl,
                    mirrorDir = currentSettings.mirrorDir,
                    mirrorOverrideActive = currentSettings.mirrorOverrideActive,
                    maySuggestFirstRunMirror = currentSettings.maySuggestFirstRunMirror,
                    drive = currentSettings.drive,
                    authentication = currentSettings.authentication,
                    schedule = new DesktopScheduleSettings { enabled = true, intervalHours = 6, fullIntervalDays = 7 }
                };
                var reconcileScheduler = new FakeTaskSchedulerService("obsolete-task-definition");
                var reconcileBackend = new ScriptedBackendClient(status, new BackendProcessResult { ExitCode = 0 });
                bool obsoleteTaskDetectedAndRepaired;
                using (var settingsForm = new SetupSettingsForm(
                    reconcileBackend, reconcileSettings, false, new NullFolderPicker(),
                    new FakeCredentialStore(), reconcileScheduler))
                {
                    bool detected = settingsForm.ScheduleHintForSelfTest.IndexOf("reconcile", StringComparison.OrdinalIgnoreCase) >= 0;
                    bool saved = await settingsForm.SaveForSelfTestAsync(null);
                    obsoleteTaskDetectedAndRepaired = detected && saved
                        && reconcileScheduler.CurrentRequest != null
                        && reconcileScheduler.CurrentRequest.Enabled
                        && reconcileScheduler.CurrentRequest.IntervalHours == 6;
                }

                stage = "status polling behavior";
                bool initialButtonsEnabled;
                bool externalLockStartedDisablesButtons;
                bool externalLockFinishedReturnsReady;
                string lockFile = Path.Combine(status.dataDir, "state", ".coursestow.lock");
                using (var form = new MainForm(backend, MainForm.StatusRefreshIntervalMilliseconds))
                {
                    SynchronizationContext.SetSynchronizationContext(null);
                    await form.InitializeForSelfTestAsync();
                    initialButtonsEnabled = form.SyncButtonsEnabledForSelfTest;
                    File.WriteAllText(lockFile, new JavaScriptSerializer().Serialize(new
                    {
                        schemaVersion = 1,
                        pid = Process.GetCurrentProcess().Id,
                        mode = "scheduled",
                        hostname = Dns.GetHostName(),
                        startedAt = DateTime.UtcNow.ToString("o")
                    }));
                    await form.PollStatusForSelfTestAsync();
                    externalLockStartedDisablesButtons = !form.SyncButtonsEnabledForSelfTest
                        && form.StatusTextForSelfTest == "Running Scheduled Sync";
                    File.Delete(lockFile);
                    await form.PollStatusForSelfTestAsync();
                    externalLockFinishedReturnsReady = form.SyncButtonsEnabledForSelfTest
                        && form.StatusTextForSelfTest == "Ready";
                }

                var delayedBackend = new DelayedStatusBackendClient(status);
                bool overlappingPollSkipped;
                using (var pollingForm = new MainForm(delayedBackend, MainForm.StatusRefreshIntervalMilliseconds))
                {
                    SynchronizationContext.SetSynchronizationContext(null);
                    Task<bool> firstPoll = pollingForm.PollStatusForSelfTestAsync();
                    await delayedBackend.Started;
                    overlappingPollSkipped = !await pollingForm.PollStatusForSelfTestAsync();
                    delayedBackend.AllowCompletion();
                    await firstPoll;
                }

                stage = "closing lifecycle";
                await VerifyClosingLifecycleAsync(CloneStatus(status));

                stage = "diagnostic sanitization";
                string[] knownKeyValues = new[]
                {
                    "AKIA" + new String('A', 16),
                    "ghp_" + new String('b', 24),
                    "sk-" + new String('c', 24),
                    "AIza" + new String('d', 32),
                    "eyJ" + new String('e', 10) + "." + new String('f', 10) + "." + new String('g', 10)
                };
                string[,] sensitiveFieldCases = new string[,]
                {
                    { "{\"password\":\"ExampleSecret123\"}", "ExampleSecret123" },
                    { "{\"token\":\"fake-token\"}", "fake-token" },
                    { "{\"Authorization\":\"Bearer fake-value\"}", "fake-value" },
                    { "{\"cookie\":\"fake-cookie\"}", "fake-cookie" },
                    { "{\"client_secret\":\"fake-secret\"}", "fake-secret" },
                    { "{ \"password\" : \"SpacedJsonSecret\" }", "SpacedJsonSecret" },
                    { "{'password':'SingleQuotedSecret'}", "SingleQuotedSecret" },
                    { "password=AssignmentSecret", "AssignmentSecret" },
                    { "password: ColonSecret", "ColonSecret" },
                    { "Authorization: Bearer HeaderSecret", "HeaderSecret" }
                };
                string sensitiveFieldStderr = String.Empty;
                for (int index = 0; index < sensitiveFieldCases.GetLength(0); index++)
                {
                    string fieldInput = sensitiveFieldCases[index, 0];
                    string fieldValue = sensitiveFieldCases[index, 1];
                    string fieldSanitized = BackendDiagnosticSanitizer.Sanitize(fieldInput);
                    AssertAbsent(fieldSanitized, fieldValue, "sensitive field value survived sanitization");
                    if (!fieldSanitized.Contains("[REDACTED]"))
                        throw new InvalidDataException("Sensitive field was not explicitly redacted.");
                    sensitiveFieldStderr += fieldInput + "\n";
                }

                string syntheticStderr = sensitiveFieldStderr +
                    "password=ExampleSecret123\n" +
                    "passwd=FakePasswdValue\n" +
                    "token=fake-token-value\n" +
                    "secret=FakeSecretValue\n" +
                    "Cookie: session=FakeCookieValue\n" +
                    "Authorization: Bearer fake-value\n" +
                    "credential=FakeCredentialValue\n" +
                    "api_key=FakeApiKeyValue\n" +
                    "[https://example.test/path?ticket=fake-secret](https://example.test/path?ticket=fake-secret)\n" +
                    String.Join("\n", knownKeyValues);
                string sanitized = BackendDiagnosticSanitizer.Sanitize(syntheticStderr + new String('x', 10000));
                string[] forbiddenSyntheticValues = new[]
                {
                    "ExampleSecret123", "FakePasswdValue", "fake-token-value", "FakeSecretValue",
                    "FakeCookieValue", "fake-value", "FakeCredentialValue", "FakeApiKeyValue", "ticket=fake-secret"
                };
                foreach (string forbidden in forbiddenSyntheticValues)
                    AssertAbsent(sanitized, forbidden, "sanitized diagnostic retained a synthetic secret or URL value");
                foreach (string forbidden in knownKeyValues)
                    AssertAbsent(sanitized, forbidden, "sanitized diagnostic retained a recognized key pattern");
                if (sanitized.Length > BackendDiagnosticSanitizer.MaximumCharacters)
                    throw new InvalidDataException("Sanitized diagnostics exceeded the strict size limit.");

                string failureLog = Path.Combine(status.logsDir, BackendFailureLog.FileName);
                if (File.Exists(failureLog)) File.Delete(failureLog);
                const string stdoutSentinel = "RAW_STDOUT_MUST_NOT_BE_WRITTEN";
                var failureBackend = new ScriptedBackendClient(CloneStatus(status), new BackendProcessResult
                {
                    ExitCode = 17,
                    StandardOutput = stdoutSentinel,
                    StandardError = syntheticStderr
                });
                using (var failureForm = new MainForm(failureBackend, MainForm.StatusRefreshIntervalMilliseconds))
                {
                    SynchronizationContext.SetSynchronizationContext(null);
                    await failureForm.InitializeForSelfTestAsync();
                    await failureForm.RunSyncForSelfTestAsync("quick");
                }
                string failureLogText = File.ReadAllText(failureLog);
                for (int index = 0; index < sensitiveFieldCases.GetLength(0); index++)
                    AssertAbsent(failureLogText, sensitiveFieldCases[index, 1], "sensitive field value survived in backend-failures.log");
                foreach (string forbidden in forbiddenSyntheticValues)
                    AssertAbsent(failureLogText, forbidden, "failure log retained a synthetic secret or URL value");
                foreach (string forbidden in knownKeyValues)
                    AssertAbsent(failureLogText, forbidden, "failure log retained a recognized key pattern");
                AssertAbsent(failureLogText, stdoutSentinel, "failure log wrote raw stdout");

                stage = "sync preflight";
                BackendStatus activeStatus = CloneStatus(status);
                activeStatus.status = "running";
                activeStatus.activeOperation = "Scheduled Sync";
                var activeBackend = new ScriptedBackendClient(activeStatus, new BackendProcessResult { ExitCode = 0 });
                using (var activeForm = new MainForm(activeBackend, MainForm.StatusRefreshIntervalMilliseconds))
                {
                    SynchronizationContext.SetSynchronizationContext(null);
                    await activeForm.InitializeForSelfTestAsync();
                    await activeForm.RunSyncForSelfTestAsync("quick");
                }
                bool preflightActiveOperationBlockedLaunch = activeBackend.SyncCalls == 0;
                var refreshBackend = new ScriptedBackendClient(CloneStatus(status), new BackendProcessResult { ExitCode = 0 });
                using (var refreshForm = new MainForm(refreshBackend, MainForm.StatusRefreshIntervalMilliseconds))
                {
                    SynchronizationContext.SetSynchronizationContext(null);
                    await refreshForm.InitializeForSelfTestAsync();
                    await refreshForm.RunRefreshLoginForSelfTestAsync();
                }
                bool refreshLoginWired = refreshBackend.RefreshLoginCalls == 1;
                var result = new
                {
                    schemaVersion = 1,
                    productName = Application.ProductName,
                    executableName = Path.GetFileName(Application.ExecutablePath),
                    mutexName = Program.MutexName,
                    legacyMutexCompatibility = Program.LegacyMutexName == @"Local\BrightspaceSync.ControlPanel",
                    applicationRoot = backend.Paths.ApplicationRoot,
                    applicationRootContainsSpaces = backend.Paths.ApplicationRoot.IndexOf(' ') >= 0,
                    nodeExecutable = backend.Paths.NodeExecutable,
                    launcherScript = backend.Paths.LauncherScript,
                    workingDirectory = startInfo.WorkingDirectory,
                    processFileName = startInfo.FileName,
                    processArguments = startInfo.Arguments,
                    quickProcessFileName = quickStartInfo.FileName,
                    quickProcessArguments = quickStartInfo.Arguments,
                    fullProcessFileName = fullStartInfo.FileName,
                    fullProcessArguments = fullStartInfo.Arguments,
                    refreshLoginProcessFileName = refreshLoginStartInfo.FileName,
                    refreshLoginProcessArguments = refreshLoginStartInfo.Arguments,
                    scheduledProcessFileName = scheduledStartInfo.FileName,
                    scheduledProcessArguments = scheduledStartInfo.Arguments,
                    settingsSaveProcessFileName = settingsSaveStartInfo.FileName,
                    settingsSaveProcessArguments = settingsSaveStartInfo.Arguments,
                    settingsSaveRedirectStandardInput = settingsSaveStartInfo.RedirectStandardInput,
                    browserProbeProcessFileName = browserProbeStartInfo.FileName,
                    browserProbeProcessArguments = browserProbeStartInfo.Arguments,
                    browserProbeRedirectStandardInput = browserProbeStartInfo.RedirectStandardInput,
                    sourceImportProcessFileName = sourceImportStartInfo.FileName,
                    sourceImportProcessArguments = sourceImportStartInfo.Arguments,
                    sourceImportRedirectStandardInput = sourceImportStartInfo.RedirectStandardInput,
                    useShellExecute = startInfo.UseShellExecute,
                    createNoWindow = startInfo.CreateNoWindow,
                    redirectStandardOutput = startInfo.RedirectStandardOutput,
                    redirectStandardError = startInfo.RedirectStandardError,
                    statusSchemaVersion = status.schemaVersion,
                    statusDataDir = status.dataDir,
                    statusMirrorDir = status.mirrorDir,
                    statusLogsDir = status.logsDir,
                    settingsSchemaVersion = currentSettings.schemaVersion,
                    settingsConfigured = currentSettings.configured,
                    settingsBaseUrl = currentSettings.baseUrl,
                    settingsMirrorDir = currentSettings.mirrorDir,
                    settingsDriveEnabled = currentSettings.drive.enabled,
                    settingsDriveDestination = currentSettings.drive.destination,
                    settingsAuthenticationSupported = currentSettings.authentication.supported,
                    settingsAutomaticLoginEnabled = currentSettings.authentication.automaticLoginEnabled,
                    settingsScheduleEnabled = currentSettings.schedule.enabled,
                    settingsScheduleIntervalHours = currentSettings.schedule.intervalHours,
                    settingsScheduleFullIntervalDays = currentSettings.schedule.fullIntervalDays,
                    settingsMirrorOverrideActive = currentSettings.mirrorOverrideActive,
                    settingsPayloadAbsentFromArguments = !settingsSaveStartInfo.Arguments.Contains(settingsRequest.baseUrl)
                        && !settingsSaveStartInfo.Arguments.Contains(settingsRequest.mirrorDir),
                    firstRunSetupTriggered = firstRunSetupTriggered,
                    firstRunCancelDisabledSync = firstRunCancelDisabledSync,
                    firstRunSignInThenFullSync = firstRunSignInThenFullSync,
                    failedSignInSkipsInitialFullSync = failedSignInSkipsInitialFullSync,
                    failedInitialFullSyncPreservesConfiguration = failedInitialFullSyncPreservesConfiguration,
                    configuredInstallSkipsFirstRun = configuredInstallSkipsFirstRun,
                    firstRunUsesKnownDocuments = firstRunUsesKnownDocuments,
                    firstRunScheduleDefaultsOff = firstRunScheduleDefaultsOff,
                    firstRunPreservesCustomMirror = firstRunPreservesCustomMirror,
                    firstRunPreservesMeaningfulDefault = firstRunPreservesMeaningfulDefault,
                    firstRunPreservesEnvironmentOverride = firstRunPreservesEnvironmentOverride,
                    manualBrowserRoundTrips = manualBrowserRoundTrips,
                    automaticBrowserReset = automaticBrowserReset,
                    missingBrowserRecoveryVisible = missingBrowserRecoveryVisible,
                    importOfferedOnlyOnFirstRun = importOfferedOnlyOnFirstRun,
                    settingsCancelSavesNothing = settingsCancelSavesNothing,
                    sharedSettingsFormSavesThroughBackend = sharedSettingsFormSavesThroughBackend,
                    environmentOverrideIsReadOnly = environmentOverrideIsReadOnly,
                    recoverySurvivesBackendBridge = recoverySurvivesBackendBridge,
                    recoveryPresentedToUi = recoveryPresentedToUi,
                    scheduledEntrypointSelected = scheduledEntrypointSelected,
                    scheduledEntrypointReturnsBackendCode = scheduledEntrypointReturnsBackendCode,
                    scheduleEnableSaved = scheduleEnableSaved,
                    disabledScheduleDoesNotRequireTaskScheduler = disabledScheduleDoesNotRequireTaskScheduler,
                    unavailableEnableLeavesConfigDisabled = unavailableEnableLeavesConfigDisabled,
                    unavailableCadenceChangeFailsSafely = unavailableCadenceChangeFailsSafely,
                    unavailableDisableCannotAccidentallyEnable = unavailableDisableCannotAccidentallyEnable,
                    laterAvailabilityRepairsStaleTask = laterAvailabilityRepairsStaleTask,
                    configFailureRestoresExactTask = configFailureRestoresExactTask,
                    taskCreationFailureLeavesConfigDisabled = taskCreationFailureLeavesConfigDisabled,
                    taskRollbackFailureSurfaced = taskRollbackFailureSurfaced,
                    scheduleDisableDeletesExactTask = scheduleDisableDeletesExactTask,
                    combinedCredentialAndTaskRollback = combinedCredentialAndTaskRollback,
                    perUserTaskIdentityIsolated = perUserTaskIdentityIsolated,
                    taskIdentityAndArgumentsAreFixed = taskIdentityAndArgumentsAreFixed,
                    legacyCurrentUserTaskReconciled = legacyCurrentUserTaskReconciled,
                    indefiniteTaskPolicyValidated = indefiniteTaskPolicyValidated,
                    obsoleteTaskDetectedAndRepaired = obsoleteTaskDetectedAndRepaired,
                    existingPasswordNotRedisplayed = existingPasswordNotRedisplayed,
                    blankPasswordKeepsCredential = blankPasswordKeepsCredential,
                    credentialPayloadExcludedFromBackend = credentialPayloadExcludedFromBackend,
                    credentialReplacementWorks = credentialReplacementWorks,
                    rejectedSettingsRestoreCredential = rejectedSettingsRestoreCredential,
                    backendThrowRestoresReplacedCredential = backendThrowRestoresReplacedCredential,
                    backendThrowRestoresDeletedCredential = backendThrowRestoresDeletedCredential,
                    backendThrowRemovesNewCredential = backendThrowRemovesNewCredential,
                    backendThrowRollbackFailureWarnsSafely = backendThrowRollbackFailureWarnsSafely,
                    credentialDeletionWorks = credentialDeletionWorks,
                    credentialFailureIsSafe = credentialFailureIsSafe,
                    passwordClearedAfterSave = passwordClearedAfterSave,
                    genericCredentialFieldsHidden = genericCredentialFieldsHidden,
                    legacyCredentialTargetCompatible = legacyCredentialTargetCompatible,
                    statusRefreshIntervalMilliseconds = MainForm.StatusRefreshIntervalMilliseconds,
                    initialButtonsEnabled = initialButtonsEnabled,
                    externalLockStartedDisablesButtons = externalLockStartedDisablesButtons,
                    externalLockFinishedReturnsReady = externalLockFinishedReturnsReady,
                    overlappingPollSkipped = overlappingPollSkipped,
                    maximumConcurrentStatusPolls = delayedBackend.MaximumConcurrentCalls,
                    sanitizedDiagnosticMaximumCharacters = BackendDiagnosticSanitizer.MaximumCharacters,
                    syntheticSecretsRemoved = true,
                    failureLogCreated = File.Exists(failureLog),
                    failedGuiOperationLogged = failureBackend.SyncCalls == 1,
                    failureLogOmitsRawStdout = !failureLogText.Contains(stdoutSentinel),
                    preflightActiveOperationBlockedLaunch = preflightActiveOperationBlockedLaunch,
                    refreshLoginWired = refreshLoginWired
                };
                File.WriteAllText(outputFile, new JavaScriptSerializer().Serialize(result));
                return 0;
            }
            catch (Exception error)
            {
                try
                {
                    var failure = new { schemaVersion = 1, error = error.GetType().Name, stage = stage };
                    File.WriteAllText(outputFile, new JavaScriptSerializer().Serialize(failure));
                }
                catch { }
                return 1;
            }
        }

        private static async Task VerifyClosingLifecycleAsync(BackendStatus status)
        {
            foreach (string mode in new[] { "quick", "full" })
            {
                foreach (bool failStatus in new[] { false, true })
                {
                    var delayed = new DelayedStatusBackendClient(status);
                    using (var form = new MainForm(delayed, MainForm.StatusRefreshIntervalMilliseconds))
                    {
                        SynchronizationContext.SetSynchronizationContext(null);
                        Task preflight = form.RunSyncForSelfTestAsync(mode);
                        await delayed.Started;
                        if (!form.OperationStartingForSelfTest || !form.BeginClosingForSelfTest())
                            throw new InvalidDataException("Closing during delayed preflight was not allowed.");
                        form.Dispose();
                        string closedUi = form.StatusUiSnapshotForSelfTest;
                        if (failStatus) delayed.FailCompletion();
                        else delayed.AllowCompletion();
                        await preflight;
                        if (delayed.SyncCalls != 0 || form.OperationStartingForSelfTest)
                            throw new InvalidDataException("Delayed preflight launched a sync or retained its starting flag after close.");
                        if (form.BackendStatusForSelfTest != null || form.StatusUiSnapshotForSelfTest != closedUi)
                            throw new InvalidDataException("Delayed preflight changed status or controls after close.");
                    }
                }
            }

            var delayedPoll = new DelayedStatusBackendClient(status);
            using (var form = new MainForm(delayedPoll, MainForm.StatusRefreshIntervalMilliseconds))
            {
                SynchronizationContext.SetSynchronizationContext(null);
                Task<bool> poll = form.PollStatusForSelfTestAsync();
                await delayedPoll.Started;
                if (!form.BeginClosingForSelfTest())
                    throw new InvalidDataException("Closing during a delayed status poll was not allowed.");
                form.Dispose();
                string closedUi = form.StatusUiSnapshotForSelfTest;
                delayedPoll.AllowCompletion();
                if (await poll || form.BackendStatusForSelfTest != null || form.StatusUiSnapshotForSelfTest != closedUi)
                    throw new InvalidDataException("Delayed status poll changed status or controls after close.");
            }
        }

        private static void AssertAbsent(string value, string forbidden, string message)
        {
            if ((value ?? String.Empty).IndexOf(forbidden, StringComparison.OrdinalIgnoreCase) >= 0)
                throw new InvalidDataException(message);
        }

        private static BackendStatus CloneStatus(BackendStatus value)
        {
            return new BackendStatus
            {
                schemaVersion = value.schemaVersion,
                appVersion = value.appVersion,
                status = "ready",
                configExists = value.configExists,
                configured = true,
                baseUrlConfigured = true,
                mirrorDir = value.mirrorDir,
                logsDir = value.logsDir,
                dataDir = value.dataDir,
                profileExists = value.profileExists,
                lastSync = value.lastSync,
                activeOperation = null
            };
        }
    }

    internal sealed class DelayedStatusBackendClient : IDesktopBackendClient
    {
        private readonly BackendStatus _status;
        private readonly TaskCompletionSource<bool> _started = new TaskCompletionSource<bool>();
        private readonly TaskCompletionSource<bool> _completion = new TaskCompletionSource<bool>();
        private int _concurrentCalls;
        private int _maximumConcurrentCalls;

        internal DelayedStatusBackendClient(BackendStatus status)
        {
            _status = status;
        }

        internal Task Started { get { return _started.Task; } }
        internal int MaximumConcurrentCalls { get { return _maximumConcurrentCalls; } }
        internal int SyncCalls { get; private set; }
        internal int RefreshLoginCalls { get; private set; }

        internal void AllowCompletion()
        {
            _completion.TrySetResult(true);
        }

        internal void FailCompletion()
        {
            _completion.TrySetException(new InvalidOperationException("Synthetic delayed status failure."));
        }

        public async Task<BackendStatus> GetStatusAsync()
        {
            int concurrent = Interlocked.Increment(ref _concurrentCalls);
            int observed;
            do
            {
                observed = _maximumConcurrentCalls;
                if (observed >= concurrent) break;
            } while (Interlocked.CompareExchange(ref _maximumConcurrentCalls, concurrent, observed) != observed);

            _started.TrySetResult(true);
            await _completion.Task;
            Interlocked.Decrement(ref _concurrentCalls);
            return _status;
        }

        public Task<BackendProcessResult> RunSyncAsync(string mode)
        {
            SyncCalls++;
            return Task.FromResult(new BackendProcessResult { ExitCode = 0 });
        }

        public Task<BackendProcessResult> RunRefreshLoginAsync()
        {
            RefreshLoginCalls++;
            return Task.FromResult(new BackendProcessResult { ExitCode = 0 });
        }

        public Task<BackendProcessResult> RunScheduledAsync()
        {
            return Task.FromResult(new BackendProcessResult { ExitCode = 0 });
        }

        public Task<DesktopSettings> GetSettingsAsync()
        {
            return Task.FromResult(SettingsFromStatus(_status));
        }

        public Task<SettingsSaveResponse> SaveSettingsAsync(SettingsSaveRequest request)
        {
            throw new InvalidOperationException("Delayed status test does not save settings.");
        }

        public Task<DesktopBrowserSettings> GetBrowserAsync() { return Task.FromResult(CompatibleBrowser()); }
        public Task<DesktopBrowserSettings> ProbeBrowserAsync(string executablePath) { return Task.FromResult(CompatibleBrowser()); }
        public Task<SourceImportResponse> ImportSourceAsync(string sourceDir) { throw new NotSupportedException(); }

        private static DesktopBrowserSettings CompatibleBrowser()
        {
            return new DesktopBrowserSettings { schemaVersion = 1, engine = "chromium", available = true, displayName = "Synthetic Chromium", validationStatus = "compatible" };
        }

        private static DesktopSettings SettingsFromStatus(BackendStatus status)
        {
            return new DesktopSettings
            {
                schemaVersion = 1,
                configured = status.configured,
                baseUrl = status.configured ? "https://example.test" : String.Empty,
                mirrorDir = status.mirrorDir,
                mirrorOverrideActive = false,
                drive = new DesktopDriveSettings { enabled = false, destination = String.Empty },
                authentication = new DesktopAuthenticationSettings { supported = false, institution = String.Empty, automaticLoginEnabled = false },
                schedule = new DesktopScheduleSettings { enabled = false, intervalHours = 6, fullIntervalDays = 7 },
                browser = CompatibleBrowser()
            };
        }
    }

    internal sealed class ScriptedBackendClient : IDesktopBackendClient
    {
        private readonly BackendStatus _status;
        private readonly BackendProcessResult _result;
        private readonly SettingsSaveResponse _settingsSaveResponse;

        internal ScriptedBackendClient(BackendStatus status, BackendProcessResult result)
            : this(status, result, null)
        {
        }

        internal ScriptedBackendClient(BackendStatus status, BackendProcessResult result, SettingsSaveResponse settingsSaveResponse)
        {
            _status = status;
            _result = result;
            _settingsSaveResponse = settingsSaveResponse;
            BrowserAvailable = true;
            Operations = new List<string>();
        }

        internal int SyncCalls { get; private set; }
        internal int RefreshLoginCalls { get; private set; }
        internal int ScheduledCalls { get; private set; }
        internal int SaveCalls { get; private set; }
        internal SettingsSaveRequest LastSettingsRequest { get; private set; }
        internal Exception SaveException { get; set; }
        internal bool BrowserAvailable { get; set; }
        internal string LastBrowserProbePath { get; private set; }
        internal BackendProcessResult SyncResult { get; set; }
        internal BackendProcessResult RefreshLoginResult { get; set; }
        internal List<string> Operations { get; private set; }

        public Task<BackendStatus> GetStatusAsync()
        {
            return Task.FromResult(_status);
        }

        public Task<BackendProcessResult> RunSyncAsync(string mode)
        {
            SyncCalls++;
            Operations.Add(mode);
            return Task.FromResult(SyncResult ?? _result);
        }

        public Task<BackendProcessResult> RunRefreshLoginAsync()
        {
            RefreshLoginCalls++;
            Operations.Add("refresh-login");
            return Task.FromResult(RefreshLoginResult ?? _result);
        }

        public Task<BackendProcessResult> RunScheduledAsync()
        {
            ScheduledCalls++;
            return Task.FromResult(_result);
        }

        public Task<DesktopSettings> GetSettingsAsync()
        {
            return Task.FromResult(new DesktopSettings
            {
                schemaVersion = 1,
                configured = _status.configured,
                baseUrl = _status.configured ? "https://example.test" : String.Empty,
                mirrorDir = _status.mirrorDir,
                mirrorOverrideActive = false,
                drive = new DesktopDriveSettings { enabled = false, destination = String.Empty },
                authentication = new DesktopAuthenticationSettings { supported = false, institution = String.Empty, automaticLoginEnabled = false },
                schedule = new DesktopScheduleSettings { enabled = false, intervalHours = 6, fullIntervalDays = 7 },
                browser = CompatibleBrowser(BrowserAvailable)
            });
        }

        public Task<DesktopBrowserSettings> GetBrowserAsync() { return Task.FromResult(CompatibleBrowser(BrowserAvailable)); }
        public Task<DesktopBrowserSettings> ProbeBrowserAsync(string executablePath)
        {
            LastBrowserProbePath = executablePath;
            return Task.FromResult(CompatibleBrowser(BrowserAvailable));
        }
        public Task<SourceImportResponse> ImportSourceAsync(string sourceDir)
        {
            return Task.FromResult(new SourceImportResponse { schemaVersion = 1, ok = true, imported = true });
        }

        private static DesktopBrowserSettings CompatibleBrowser(bool available)
        {
            return new DesktopBrowserSettings
            {
                schemaVersion = 1,
                engine = "chromium",
                available = available,
                displayName = available ? "Synthetic Chromium" : String.Empty,
                validationStatus = available ? "compatible" : "not-detected"
            };
        }

        public Task<SettingsSaveResponse> SaveSettingsAsync(SettingsSaveRequest request)
        {
            SaveCalls++;
            LastSettingsRequest = request;
            if (SaveException != null)
            {
                var failed = new TaskCompletionSource<SettingsSaveResponse>();
                failed.SetException(SaveException);
                return failed.Task;
            }
            if (_settingsSaveResponse != null)
                return Task.FromResult(_settingsSaveResponse);
            return Task.FromResult(new SettingsSaveResponse
            {
                schemaVersion = 1,
                ok = true,
                settings = new DesktopSettings
                {
                    schemaVersion = 1,
                    configured = true,
                    baseUrl = request.baseUrl,
                    mirrorDir = request.mirrorDir,
                    mirrorOverrideActive = false,
                    drive = request.drive,
                    authentication = request.authentication,
                    schedule = request.schedule,
                    browser = request.browser ?? CompatibleBrowser(true)
                }
            });
        }
    }

    internal sealed class FakeTaskSchedulerService : ITaskSchedulerService
    {
        internal FakeTaskSchedulerService(string currentXml, string legacyXml = null)
        {
            CurrentXml = currentXml;
            LegacyXml = legacyXml;
            UnrelatedTask = "unrelated-task-preserved";
        }

        internal string CurrentXml { get; private set; }
        internal string LegacyXml { get; private set; }
        internal string UnrelatedTask { get; private set; }
        internal ScheduledTaskRequest CurrentRequest { get; private set; }
        internal bool FailApply { get; set; }
        internal bool FailCapture { get; set; }
        internal bool FailInspect { get; set; }
        internal bool FailRestore { get; set; }
        internal int ApplyCalls { get; private set; }
        internal int RestoreCalls { get; private set; }

        public ScheduledTaskSnapshot Capture()
        {
            if (FailCapture) throw new TaskSchedulerOperationException("Synthetic Task Scheduler unavailability.");
            return new ScheduledTaskSnapshot
            {
                Exists = CurrentXml != null,
                Xml = CurrentXml,
                LegacyExists = LegacyXml != null,
                LegacyXml = LegacyXml
            };
        }

        public ScheduledTaskStatus Inspect(ScheduledTaskRequest expected)
        {
            if (FailInspect) throw new TaskSchedulerOperationException("Synthetic Task Scheduler unavailability.");
            bool exists = CurrentXml != null || LegacyXml != null;
            bool matches = !expected.Enabled ? !exists : CurrentXml != null && LegacyXml == null && CurrentRequest != null
                && CurrentRequest.Enabled
                && CurrentRequest.IntervalHours == expected.IntervalHours
                && String.Equals(CurrentRequest.ExecutablePath, expected.ExecutablePath, StringComparison.OrdinalIgnoreCase);
            return new ScheduledTaskStatus
            {
                Exists = exists,
                MatchesExpected = matches,
                IntervalHours = CurrentRequest == null ? 0 : CurrentRequest.IntervalHours,
                State = exists ? "ready" : "not-installed"
            };
        }

        public void Apply(ScheduledTaskRequest request)
        {
            ApplyCalls++;
            CurrentRequest = new ScheduledTaskRequest
            {
                Enabled = request.Enabled,
                IntervalHours = request.IntervalHours,
                ExecutablePath = request.ExecutablePath
            };
            CurrentXml = request.Enabled
                ? "task:" + request.IntervalHours + ":" + WindowsTaskSchedulerService.TaskArguments
                : null;
            LegacyXml = null;
            if (FailApply) throw new TaskSchedulerOperationException("Synthetic task registration failure.");
        }

        public void Restore(ScheduledTaskSnapshot snapshot)
        {
            RestoreCalls++;
            if (FailRestore) throw new TaskSchedulerOperationException("Synthetic task rollback failure.");
            CurrentXml = snapshot.Exists ? snapshot.Xml : null;
            LegacyXml = snapshot.LegacyExists ? snapshot.LegacyXml : null;
            CurrentRequest = null;
        }
    }

    internal sealed class FakeCredentialStore : ICredentialStore
    {
        private string _username;
        private string _password;

        private string _target;

        internal FakeCredentialStore(string username = "", string password = "", bool legacyOnly = false)
        {
            _username = username ?? String.Empty;
            _password = password ?? String.Empty;
            _target = legacyOnly ? WindowsCredentialStore.LegacyStonyBrookTarget : WindowsCredentialStore.StonyBrookTarget;
        }

        internal bool FailReads { get; set; }
        internal bool FailWrites { get; set; }
        internal bool FailDeletes { get; set; }
        internal int FailWriteOnCall { get; set; }
        internal int ReadCalls { get; private set; }
        internal int WriteCalls { get; private set; }
        internal int DeleteCalls { get; private set; }
        internal bool Exists { get { return !String.IsNullOrWhiteSpace(_username) && !String.IsNullOrEmpty(_password); } }
        internal string CurrentPassword { get { return _password; } }
        internal string CurrentTarget { get { return _target; } }

        public CredentialRecord Read(string target)
        {
            ValidateTarget(target);
            ReadCalls++;
            if (FailReads) throw new CredentialStoreException("Windows could not read the saved Brightspace credential.");
            return Exists && String.Equals(target, _target, StringComparison.Ordinal)
                ? new CredentialRecord(_username, _password.ToCharArray())
                : null;
        }

        public string ReadUsername(string target)
        {
            ValidateTarget(target);
            ReadCalls++;
            if (FailReads) throw new CredentialStoreException("Windows could not inspect the saved Brightspace credential.");
            return Exists && String.Equals(target, _target, StringComparison.Ordinal) ? _username : null;
        }

        public void Write(string target, string username, string password)
        {
            ValidateTarget(target);
            WriteCalls++;
            if (FailWrites || (FailWriteOnCall > 0 && WriteCalls == FailWriteOnCall))
                throw new CredentialStoreException("Windows could not save the Brightspace credential.");
            _username = username ?? String.Empty;
            _password = password ?? String.Empty;
            _target = target;
        }

        public void Delete(string target)
        {
            ValidateTarget(target);
            DeleteCalls++;
            if (FailDeletes) throw new CredentialStoreException("Windows could not remove the saved Brightspace credential.");
            if (String.Equals(target, _target, StringComparison.Ordinal))
            {
                _username = String.Empty;
                _password = String.Empty;
            }
        }

        private static void ValidateTarget(string target)
        {
            if (!String.Equals(target, WindowsCredentialStore.StonyBrookTarget, StringComparison.Ordinal)
                && !String.Equals(target, WindowsCredentialStore.LegacyStonyBrookTarget, StringComparison.Ordinal))
                throw new CredentialStoreException("The requested credential target is not supported.");
        }
    }

    internal sealed class ScriptedSettingsDialogService : ISettingsDialogService
    {
        private readonly bool _result;
        private readonly Action _onShow;

        internal ScriptedSettingsDialogService(bool result, Action onShow = null)
        {
            _result = result;
            _onShow = onShow;
        }

        internal int ShowCalls { get; private set; }
        internal bool LastFirstRun { get; private set; }

        public Task<bool> ShowAsync(IWin32Window owner, IDesktopBackendClient backend, bool firstRun)
        {
            ShowCalls++;
            LastFirstRun = firstRun;
            if (_onShow != null) _onShow();
            return Task.FromResult(_result);
        }
    }

    internal sealed class NullFolderPicker : IFolderPicker
    {
        public string SelectFolder(IWin32Window owner, string description, string initialPath)
        {
            return null;
        }
    }
}
