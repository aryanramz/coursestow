using CourseStow.Security;
using System;
using System.Collections.Generic;
using System.IO;
using System.Windows.Forms;

namespace CourseStow.ControlPanel
{
    internal static class InstallerMaintenanceExitCode
    {
        internal const int Success = 0;
        internal const int Busy = 10;
        internal const int InspectionFailure = 11;
        internal const int OperationFailure = 12;
    }

    internal interface IInstallerActivityProbe
    {
        bool IsMutexActive(string name);
        BackendStatus GetStatus();
    }

    internal sealed class InstallerActivityProbe : IInstallerActivityProbe
    {
        private readonly IDesktopBackendClient _backend;

        internal InstallerActivityProbe(IDesktopBackendClient backend)
        {
            if (backend == null) throw new ArgumentNullException("backend");
            _backend = backend;
        }

        public bool IsMutexActive(string name)
        {
            return CourseStowProcessIdentity.IsMutexActive(name);
        }

        public BackendStatus GetStatus()
        {
            return _backend.GetStatusAsync().GetAwaiter().GetResult();
        }
    }

    internal interface IPrivateDataFileSystem
    {
        bool DirectoryExists(string path);
        FileAttributes GetAttributes(string path);
        IEnumerable<string> EnumerateFileSystemEntries(string path);
        void DeleteFile(string path);
        void DeleteDirectory(string path);
    }

    internal sealed class PrivateDataFileSystem : IPrivateDataFileSystem
    {
        public bool DirectoryExists(string path) { return Directory.Exists(path); }
        public FileAttributes GetAttributes(string path) { return File.GetAttributes(path); }
        public IEnumerable<string> EnumerateFileSystemEntries(string path) { return Directory.EnumerateFileSystemEntries(path); }
        public void DeleteFile(string path)
        {
            FileAttributes attributes = File.GetAttributes(path);
            if ((attributes & FileAttributes.ReparsePoint) == 0) File.SetAttributes(path, FileAttributes.Normal);
            File.Delete(path);
        }
        public void DeleteDirectory(string path) { Directory.Delete(path, false); }
    }

    internal sealed class SafePrivateDataCleaner
    {
        private readonly IPrivateDataFileSystem _fileSystem;

        internal SafePrivateDataCleaner()
            : this(new PrivateDataFileSystem())
        {
        }

        internal SafePrivateDataCleaner(IPrivateDataFileSystem fileSystem)
        {
            if (fileSystem == null) throw new ArgumentNullException("fileSystem");
            _fileSystem = fileSystem;
        }

        internal void RemoveCurrentUserPrivateData()
        {
            string localData = Path.GetFullPath(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData));
            string expected = Path.Combine(localData, "CourseStow");
            string candidate = Path.GetFullPath(expected);
            if (!String.Equals(candidate, expected, StringComparison.OrdinalIgnoreCase)
                || !String.Equals(Path.GetDirectoryName(candidate), localData, StringComparison.OrdinalIgnoreCase))
                throw new IOException("The CourseStow private-data location could not be verified.");
            DeleteTreeWithoutFollowingReparsePoints(candidate);
        }

        internal void DeleteTreeWithoutFollowingReparsePoints(string root)
        {
            if (!_fileSystem.DirectoryExists(root)) return;
            DeleteDirectory(root);
        }

        private void DeleteDirectory(string directory)
        {
            FileAttributes attributes = _fileSystem.GetAttributes(directory);
            if ((attributes & FileAttributes.ReparsePoint) != 0)
            {
                _fileSystem.DeleteDirectory(directory);
                return;
            }

            foreach (string entry in _fileSystem.EnumerateFileSystemEntries(directory))
            {
                FileAttributes entryAttributes = _fileSystem.GetAttributes(entry);
                if ((entryAttributes & FileAttributes.Directory) != 0)
                {
                    if ((entryAttributes & FileAttributes.ReparsePoint) != 0)
                        _fileSystem.DeleteDirectory(entry);
                    else
                        DeleteDirectory(entry);
                }
                else
                {
                    _fileSystem.DeleteFile(entry);
                }
            }
            _fileSystem.DeleteDirectory(directory);
        }
    }

    internal static class InstallerMaintenanceCommand
    {
        internal const string Preflight = "--installer-preflight";
        internal const string ReconcileSchedule = "--installer-reconcile-schedule";
        internal const string RemoveSchedule = "--installer-remove-schedule";
        internal const string RemoveCredential = "--installer-remove-credential";
        internal const string RemovePrivateData = "--installer-remove-private-data";

        internal static bool TryRun(string[] args, out int exitCode)
        {
            exitCode = 0;
            if (args == null || args.Length != 1 || !IsMaintenanceCommand(args[0])) return false;

            try
            {
                switch (args[0])
                {
                    case Preflight:
                        exitCode = RunPreflight(new InstallerActivityProbe(new BackendClient()));
                        break;
                    case ReconcileSchedule:
                        exitCode = RunReconcileSchedule(new BackendClient(), new WindowsTaskSchedulerService(), Application.ExecutablePath);
                        break;
                    case RemoveSchedule:
                        exitCode = RunRemoveSchedule(new WindowsTaskSchedulerService(), Application.ExecutablePath);
                        break;
                    case RemoveCredential:
                        exitCode = RunRemoveCredential(new CompatibleCredentialStore(new WindowsCredentialStore()));
                        break;
                    case RemovePrivateData:
                        exitCode = RunRemovePrivateData(new SafePrivateDataCleaner());
                        break;
                }
            }
            catch
            {
                exitCode = args[0] == Preflight
                    ? InstallerMaintenanceExitCode.InspectionFailure
                    : InstallerMaintenanceExitCode.OperationFailure;
            }
            return true;
        }

        internal static bool IsMaintenanceCommand(string value)
        {
            return String.Equals(value, Preflight, StringComparison.Ordinal)
                || String.Equals(value, ReconcileSchedule, StringComparison.Ordinal)
                || String.Equals(value, RemoveSchedule, StringComparison.Ordinal)
                || String.Equals(value, RemoveCredential, StringComparison.Ordinal)
                || String.Equals(value, RemovePrivateData, StringComparison.Ordinal);
        }

        internal static int RunPreflight(IInstallerActivityProbe activity)
        {
            if (activity == null) throw new ArgumentNullException("activity");
            try
            {
                if (activity.IsMutexActive(CourseStowProcessIdentity.ControlPanelMutexName)
                    || activity.IsMutexActive(CourseStowProcessIdentity.LegacyControlPanelMutexName)
                    || activity.IsMutexActive(CourseStowProcessIdentity.CredentialHelperMutexName))
                    return InstallerMaintenanceExitCode.Busy;

                BackendStatus status = activity.GetStatus();
                if (status == null) return InstallerMaintenanceExitCode.InspectionFailure;
                return String.IsNullOrWhiteSpace(status.activeOperation)
                    ? InstallerMaintenanceExitCode.Success
                    : InstallerMaintenanceExitCode.Busy;
            }
            catch
            {
                return InstallerMaintenanceExitCode.InspectionFailure;
            }
        }

        internal static int RunReconcileSchedule(IDesktopBackendClient backend, ITaskSchedulerService scheduler, string executablePath)
        {
            if (backend == null || scheduler == null) return InstallerMaintenanceExitCode.OperationFailure;
            try
            {
                DesktopSettings settings = backend.GetSettingsAsync().GetAwaiter().GetResult();
                if (settings == null || settings.schedule == null) return InstallerMaintenanceExitCode.OperationFailure;
                bool enabled = settings.configured && settings.schedule.enabled;
                scheduler.Apply(new ScheduledTaskRequest
                {
                    Enabled = enabled,
                    IntervalHours = settings.schedule.intervalHours,
                    ExecutablePath = executablePath
                });
                return InstallerMaintenanceExitCode.Success;
            }
            catch
            {
                return InstallerMaintenanceExitCode.OperationFailure;
            }
        }

        internal static int RunRemoveSchedule(ITaskSchedulerService scheduler, string executablePath)
        {
            if (scheduler == null) return InstallerMaintenanceExitCode.OperationFailure;
            try
            {
                scheduler.Apply(new ScheduledTaskRequest
                {
                    Enabled = false,
                    IntervalHours = 6,
                    ExecutablePath = executablePath
                });
                return InstallerMaintenanceExitCode.Success;
            }
            catch
            {
                return InstallerMaintenanceExitCode.OperationFailure;
            }
        }

        internal static int RunRemoveCredential(ICredentialStore store)
        {
            if (store == null) return InstallerMaintenanceExitCode.OperationFailure;
            try
            {
                store.Delete(WindowsCredentialStore.StonyBrookTarget);
                return InstallerMaintenanceExitCode.Success;
            }
            catch
            {
                return InstallerMaintenanceExitCode.OperationFailure;
            }
        }

        internal static int RunRemovePrivateData(SafePrivateDataCleaner cleaner)
        {
            if (cleaner == null) return InstallerMaintenanceExitCode.OperationFailure;
            try
            {
                cleaner.RemoveCurrentUserPrivateData();
                return InstallerMaintenanceExitCode.Success;
            }
            catch
            {
                return InstallerMaintenanceExitCode.OperationFailure;
            }
        }
    }
}
