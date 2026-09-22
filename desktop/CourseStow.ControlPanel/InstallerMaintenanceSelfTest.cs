using CourseStow.Security;
using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace CourseStow.ControlPanel
{
    internal static class InstallerMaintenanceSelfTest
    {
        internal static int Run(string outputFile)
        {
            string stage = "initialize";
            try
            {
                stage = "command routing";
                string[] commands = {
                    InstallerMaintenanceCommand.Preflight,
                    InstallerMaintenanceCommand.ReconcileSchedule,
                    InstallerMaintenanceCommand.RemoveSchedule,
                    InstallerMaintenanceCommand.RemoveCredential,
                    InstallerMaintenanceCommand.RemovePrivateData
                };
                foreach (string command in commands)
                    Require(InstallerMaintenanceCommand.IsMaintenanceCommand(command), "A fixed maintenance command was not recognized.");
                Require(!InstallerMaintenanceCommand.IsMaintenanceCommand("--scheduled-run"), "A normal application command was classified as installer maintenance.");

                stage = "preflight contracts";
                var idle = new FakeInstallerActivityProbe();
                Require(InstallerMaintenanceCommand.RunPreflight(idle) == InstallerMaintenanceExitCode.Success, "Idle preflight did not succeed.");

                var canonicalBusy = new FakeInstallerActivityProbe();
                canonicalBusy.ActiveMutexes.Add(CourseStowProcessIdentity.ControlPanelMutexName);
                Require(InstallerMaintenanceCommand.RunPreflight(canonicalBusy) == InstallerMaintenanceExitCode.Busy, "Canonical GUI mutex was not busy.");

                var legacyBusy = new FakeInstallerActivityProbe();
                legacyBusy.ActiveMutexes.Add(CourseStowProcessIdentity.LegacyControlPanelMutexName);
                Require(InstallerMaintenanceCommand.RunPreflight(legacyBusy) == InstallerMaintenanceExitCode.Busy, "Legacy GUI mutex was not busy.");

                var helperBusy = new FakeInstallerActivityProbe();
                helperBusy.ActiveMutexes.Add(CourseStowProcessIdentity.CredentialHelperMutexName);
                Require(InstallerMaintenanceCommand.RunPreflight(helperBusy) == InstallerMaintenanceExitCode.Busy, "Credential-helper mutex was not busy.");

                var activeLock = new FakeInstallerActivityProbe { ActiveOperation = "Scheduled Sync" };
                Require(InstallerMaintenanceCommand.RunPreflight(activeLock) == InstallerMaintenanceExitCode.Busy, "Active sync lock was not busy.");

                var safelyStaleLock = new FakeInstallerActivityProbe { ActiveOperation = null };
                Require(InstallerMaintenanceCommand.RunPreflight(safelyStaleLock) == InstallerMaintenanceExitCode.Success, "Safely stale sync lock remained busy.");

                var inspectionFailure = new FakeInstallerActivityProbe { FailInspection = true };
                Require(InstallerMaintenanceCommand.RunPreflight(inspectionFailure) == InstallerMaintenanceExitCode.InspectionFailure, "Inspection failure was not distinguished.");

                stage = "operating-system mutex identity";
                foreach (string mutexName in new[] {
                    CourseStowProcessIdentity.ControlPanelMutexName,
                    CourseStowProcessIdentity.LegacyControlPanelMutexName,
                    CourseStowProcessIdentity.CredentialHelperMutexName
                })
                {
                    using (var held = new Mutex(false, mutexName))
                    {
                        Require(CourseStowProcessIdentity.IsMutexActive(mutexName), "A CourseStow activity mutex was not observable.");
                        GC.KeepAlive(held);
                    }
                }

                stage = "schedule contracts";
                var disabledScheduler = new RecordingInstallerTaskScheduler();
                var unconfiguredBackend = new InstallerSelfTestBackend(false, true, 4);
                Require(InstallerMaintenanceCommand.RunReconcileSchedule(unconfiguredBackend, disabledScheduler, "C:\\Program Files\\CourseStow\\CourseStow.exe") == InstallerMaintenanceExitCode.Success, "Unconfigured schedule reconciliation failed.");
                Require(disabledScheduler.LastRequest != null && !disabledScheduler.LastRequest.Enabled, "Unconfigured install invented a schedule.");

                var enabledScheduler = new RecordingInstallerTaskScheduler();
                var enabledBackend = new InstallerSelfTestBackend(true, true, 4);
                const string installedExecutable = "C:\\Users\\Example\\AppData\\Local\\Programs\\CourseStow\\CourseStow.exe";
                Require(InstallerMaintenanceCommand.RunReconcileSchedule(enabledBackend, enabledScheduler, installedExecutable) == InstallerMaintenanceExitCode.Success, "Enabled schedule reconciliation failed.");
                Require(enabledScheduler.LastRequest.Enabled
                    && enabledScheduler.LastRequest.IntervalHours == 4
                    && String.Equals(enabledScheduler.LastRequest.ExecutablePath, installedExecutable, StringComparison.Ordinal), "Schedule did not target the current fixed executable.");

                var removeScheduler = new RecordingInstallerTaskScheduler();
                Require(InstallerMaintenanceCommand.RunRemoveSchedule(removeScheduler, installedExecutable) == InstallerMaintenanceExitCode.Success, "Schedule removal failed.");
                Require(removeScheduler.LastRequest != null && !removeScheduler.LastRequest.Enabled, "Schedule removal did not request exact managed-task deletion.");

                var failingScheduler = new RecordingInstallerTaskScheduler { FailApply = true };
                Require(InstallerMaintenanceCommand.RunRemoveSchedule(failingScheduler, installedExecutable) == InstallerMaintenanceExitCode.OperationFailure, "Schedule maintenance failure was not deterministic.");

                stage = "credential contract";
                var credentialInner = new RecordingInstallerCredentialStore();
                var compatibleCredential = new CompatibleCredentialStore(credentialInner);
                Require(InstallerMaintenanceCommand.RunRemoveCredential(compatibleCredential) == InstallerMaintenanceExitCode.Success, "Credential removal failed.");
                Require(credentialInner.DeletedTargets.Count == 2
                    && credentialInner.DeletedTargets[0] == WindowsCredentialStore.StonyBrookTarget
                    && credentialInner.DeletedTargets[1] == WindowsCredentialStore.LegacyStonyBrookTarget,
                    "Credential removal exceeded or missed the supported identity set.");

                stage = "private-data reparse contract";
                var fileSystem = new RecordingPrivateDataFileSystem();
                var cleaner = new SafePrivateDataCleaner(fileSystem);
                cleaner.DeleteTreeWithoutFollowingReparsePoints(fileSystem.Root);
                Require(fileSystem.Enumerated.Contains(fileSystem.Root), "Private root was not enumerated.");
                Require(!fileSystem.Enumerated.Contains(fileSystem.ExternalTarget), "Cleanup followed a reparse point outside the private root.");
                Require(fileSystem.DeletedDirectories.Contains(fileSystem.ReparseChild), "Cleanup did not remove the reparse link itself.");
                Require(!fileSystem.DeletedFiles.Contains(fileSystem.ExternalFile), "Cleanup deleted external data through a reparse point.");

                var result = new
                {
                    schemaVersion = 1,
                    maintenanceCommandsBypassGui = true,
                    fixedCommandArgumentsOnly = true,
                    canonicalMutexBusy = true,
                    legacyMutexBusy = true,
                    credentialHelperBusy = true,
                    activeSyncLockBusy = true,
                    safelyStaleLockSafe = true,
                    preflightExitCodes = new { safe = 0, busy = 10, inspectionFailure = 11, operationFailure = 12 },
                    unconfiguredScheduleDisabled = true,
                    configuredScheduleReconciled = true,
                    scheduleRemovalNarrow = true,
                    credentialRemovalNarrow = true,
                    privateDataReparseNotFollowed = true
                };
                File.WriteAllText(outputFile, new JavaScriptSerializer().Serialize(result));
                return 0;
            }
            catch (Exception error)
            {
                try
                {
                    File.WriteAllText(outputFile, new JavaScriptSerializer().Serialize(new
                    {
                        schemaVersion = 1,
                        error = error.GetType().Name,
                        stage = stage
                    }));
                }
                catch { }
                return 1;
            }
        }

        private static void Require(bool condition, string message)
        {
            if (!condition) throw new InvalidDataException(message);
        }
    }

    internal sealed class FakeInstallerActivityProbe : IInstallerActivityProbe
    {
        internal FakeInstallerActivityProbe()
        {
            ActiveMutexes = new HashSet<string>(StringComparer.Ordinal);
        }

        internal HashSet<string> ActiveMutexes { get; private set; }
        internal string ActiveOperation { get; set; }
        internal bool FailInspection { get; set; }

        public bool IsMutexActive(string name)
        {
            if (FailInspection) throw new IOException("Synthetic inspection failure.");
            return ActiveMutexes.Contains(name);
        }

        public BackendStatus GetStatus()
        {
            if (FailInspection) throw new IOException("Synthetic inspection failure.");
            return new BackendStatus { schemaVersion = 1, activeOperation = ActiveOperation };
        }
    }

    internal sealed class InstallerSelfTestBackend : IDesktopBackendClient
    {
        private readonly DesktopSettings _settings;

        internal InstallerSelfTestBackend(bool configured, bool scheduleEnabled, int intervalHours)
        {
            _settings = new DesktopSettings
            {
                schemaVersion = 1,
                configured = configured,
                baseUrl = configured ? "https://example.test" : String.Empty,
                mirrorDir = "C:\\SyntheticMirror",
                drive = new DesktopDriveSettings { enabled = false, destination = String.Empty },
                authentication = new DesktopAuthenticationSettings(),
                schedule = new DesktopScheduleSettings { enabled = scheduleEnabled, intervalHours = intervalHours, fullIntervalDays = 7 },
                browser = CompatibleBrowser()
            };
        }

        private static DesktopBrowserSettings CompatibleBrowser() { return new DesktopBrowserSettings { schemaVersion = 1, engine = "chromium", available = true, displayName = "Synthetic Chromium", validationStatus = "compatible" }; }

        public Task<BackendStatus> GetStatusAsync() { return Task.FromResult(new BackendStatus { schemaVersion = 1 }); }
        public Task<DesktopSettings> GetSettingsAsync() { return Task.FromResult(_settings); }
        public Task<SettingsSaveResponse> SaveSettingsAsync(SettingsSaveRequest request) { throw new NotSupportedException(); }
        public Task<DesktopBrowserSettings> GetBrowserAsync() { return Task.FromResult(CompatibleBrowser()); }
        public Task<DesktopBrowserSettings> ProbeBrowserAsync(string executablePath) { return Task.FromResult(CompatibleBrowser()); }
        public Task<SourceImportResponse> ImportSourceAsync(string sourceDir) { throw new NotSupportedException(); }
        public Task<BackendProcessResult> RunSyncAsync(string mode) { throw new NotSupportedException(); }
        public Task<BackendProcessResult> RunRefreshLoginAsync() { throw new NotSupportedException(); }
        public Task<BackendProcessResult> RunScheduledAsync() { throw new NotSupportedException(); }
    }

    internal sealed class RecordingInstallerTaskScheduler : ITaskSchedulerService
    {
        internal ScheduledTaskRequest LastRequest { get; private set; }
        internal bool FailApply { get; set; }

        public ScheduledTaskSnapshot Capture() { return new ScheduledTaskSnapshot(); }
        public ScheduledTaskStatus Inspect(ScheduledTaskRequest expected) { return new ScheduledTaskStatus(); }
        public void Restore(ScheduledTaskSnapshot snapshot) { }
        public void Apply(ScheduledTaskRequest request)
        {
            LastRequest = request;
            if (FailApply) throw new TaskSchedulerOperationException("Synthetic schedule failure.");
        }
    }

    internal sealed class RecordingInstallerCredentialStore : ICredentialStore
    {
        internal RecordingInstallerCredentialStore()
        {
            DeletedTargets = new List<string>();
        }

        internal List<string> DeletedTargets { get; private set; }
        public CredentialRecord Read(string target) { return null; }
        public string ReadUsername(string target) { return null; }
        public void Write(string target, string username, string password) { throw new NotSupportedException(); }
        public void Delete(string target) { DeletedTargets.Add(target); }
    }

    internal sealed class RecordingPrivateDataFileSystem : IPrivateDataFileSystem
    {
        internal RecordingPrivateDataFileSystem()
        {
            Enumerated = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            DeletedDirectories = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            DeletedFiles = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        }

        internal string Root { get { return @"C:\fixture\CourseStow"; } }
        internal string ReparseChild { get { return Root + @"\linked-mirror"; } }
        internal string OrdinaryChild { get { return Root + @"\state"; } }
        internal string OrdinaryFile { get { return OrdinaryChild + @"\state.json"; } }
        internal string ExternalTarget { get { return @"D:\school-mirror"; } }
        internal string ExternalFile { get { return ExternalTarget + @"\course.txt"; } }
        internal HashSet<string> Enumerated { get; private set; }
        internal HashSet<string> DeletedDirectories { get; private set; }
        internal HashSet<string> DeletedFiles { get; private set; }

        public bool DirectoryExists(string path) { return String.Equals(path, Root, StringComparison.OrdinalIgnoreCase); }
        public FileAttributes GetAttributes(string path)
        {
            if (String.Equals(path, ReparseChild, StringComparison.OrdinalIgnoreCase))
                return FileAttributes.Directory | FileAttributes.ReparsePoint;
            if (String.Equals(path, Root, StringComparison.OrdinalIgnoreCase) || String.Equals(path, OrdinaryChild, StringComparison.OrdinalIgnoreCase))
                return FileAttributes.Directory;
            return FileAttributes.Normal;
        }
        public IEnumerable<string> EnumerateFileSystemEntries(string path)
        {
            Enumerated.Add(path);
            if (String.Equals(path, Root, StringComparison.OrdinalIgnoreCase)) return new[] { OrdinaryChild, ReparseChild };
            if (String.Equals(path, OrdinaryChild, StringComparison.OrdinalIgnoreCase)) return new[] { OrdinaryFile };
            if (String.Equals(path, ExternalTarget, StringComparison.OrdinalIgnoreCase)) return new[] { ExternalFile };
            return new string[0];
        }
        public void DeleteFile(string path) { DeletedFiles.Add(path); }
        public void DeleteDirectory(string path) { DeletedDirectories.Add(path); }
    }
}
