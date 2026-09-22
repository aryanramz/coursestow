using System;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace CourseStow.ControlPanel
{
    internal sealed class ScheduledTaskRequest
    {
        internal bool Enabled { get; set; }
        internal int IntervalHours { get; set; }
        internal string ExecutablePath { get; set; }
    }

    internal sealed class ScheduledTaskSnapshot
    {
        internal bool Exists { get; set; }
        internal string Xml { get; set; }
        internal bool LegacyExists { get; set; }
        internal string LegacyXml { get; set; }
    }

    internal sealed class ScheduledTaskStatus
    {
        internal bool Exists { get; set; }
        internal bool MatchesExpected { get; set; }
        internal bool NeedsRepair { get { return Exists && !MatchesExpected; } }
        internal int IntervalHours { get; set; }
        internal DateTime? LastRunTime { get; set; }
        internal DateTime? NextRunTime { get; set; }
        internal int LastTaskResult { get; set; }
        internal string State { get; set; }
    }

    internal sealed class TaskSchedulerOperationException : Exception
    {
        internal TaskSchedulerOperationException(string message) : base(message) { }
        internal TaskSchedulerOperationException(string message, Exception inner) : base(message, inner) { }
    }

    internal interface ITaskSchedulerService
    {
        ScheduledTaskSnapshot Capture();
        ScheduledTaskStatus Inspect(ScheduledTaskRequest expected);
        void Apply(ScheduledTaskRequest request);
        void Restore(ScheduledTaskSnapshot snapshot);
    }

    // Internal test/development fallback used only by constructor overloads
    // that predate scheduling injection. Production UI supplies the Windows
    // Task Scheduler implementation explicitly.
    internal sealed class PassiveTaskSchedulerService : ITaskSchedulerService
    {
        public ScheduledTaskSnapshot Capture() { return new ScheduledTaskSnapshot { Exists = false }; }
        public ScheduledTaskStatus Inspect(ScheduledTaskRequest expected)
        {
            return new ScheduledTaskStatus
            {
                Exists = expected != null && expected.Enabled,
                MatchesExpected = true,
                IntervalHours = expected == null ? 0 : expected.IntervalHours,
                State = expected != null && expected.Enabled ? "ready" : "not-installed"
            };
        }
        public void Apply(ScheduledTaskRequest request) { }
        public void Restore(ScheduledTaskSnapshot snapshot) { }
    }

    internal sealed class WindowsTaskSchedulerService : ITaskSchedulerService
    {
        internal const string FolderPath = @"\CourseStow";
        internal const string LegacyFolderPath = @"\Brightspace Sync";
        internal const string TaskArguments = "--scheduled-run";

        private readonly string _userSid;
        private readonly string _taskName;

        private const int TaskActionExec = 0;
        private const int TaskTriggerTime = 1;
        private const int TaskCreateOrUpdate = 6;
        private const int TaskLogonInteractiveToken = 3;
        private const int TaskRunLevelLeastPrivilege = 0;
        private const int TaskInstancesIgnoreNew = 2;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint GetFinalPathNameByHandle(
            SafeFileHandle file,
            [Out] StringBuilder path,
            uint pathLength,
            uint flags);

        internal WindowsTaskSchedulerService()
            : this(CurrentUserSid())
        {
        }

        internal WindowsTaskSchedulerService(string userSid)
        {
            _userSid = NormalizeSid(userSid);
            _taskName = TaskNameForSid(_userSid);
        }

        internal string ManagedTaskName { get { return _taskName; } }

        internal static string TaskNameForSid(string userSid)
        {
            return "Scheduled Sync - " + NormalizeSid(userSid);
        }

        internal static bool HasIndefiniteTimePolicy(
            string executionTimeLimit,
            string repetitionDuration,
            string endBoundary)
        {
            return String.Equals((executionTimeLimit ?? String.Empty).Trim(), "PT0S", StringComparison.OrdinalIgnoreCase)
                && IsIndefiniteDuration(repetitionDuration)
                && String.IsNullOrWhiteSpace(endBoundary);
        }

        public ScheduledTaskSnapshot Capture()
        {
            return WithService(delegate(dynamic service)
            {
                dynamic task = GetExactTask(service, FolderPath);
                dynamic legacyTask = GetExactTask(service, LegacyFolderPath);
                try
                {
                    return new ScheduledTaskSnapshot
                    {
                        Exists = task != null,
                        Xml = task == null ? null : (string)task.Xml,
                        LegacyExists = legacyTask != null,
                        LegacyXml = legacyTask == null ? null : (string)legacyTask.Xml
                    };
                }
                catch (Exception error)
                {
                    throw new TaskSchedulerOperationException("Windows could not snapshot the CourseStow scheduled task.", error);
                }
                finally
                {
                    ReleaseComObject(legacyTask);
                    ReleaseComObject(task);
                }
            });
        }

        public ScheduledTaskStatus Inspect(ScheduledTaskRequest expected)
        {
            if (expected == null) throw new ArgumentNullException("expected");
            return WithService(delegate(dynamic service)
            {
                dynamic task = GetExactTask(service, FolderPath);
                dynamic legacyTask = GetExactTask(service, LegacyFolderPath);
                bool legacyExists = legacyTask != null;
                if (task == null)
                {
                    ReleaseComObject(legacyTask);
                    return new ScheduledTaskStatus
                    {
                        Exists = legacyExists,
                        MatchesExpected = !expected.Enabled && !legacyExists,
                        State = legacyExists ? "legacy-task" : "not-installed"
                    };
                }
                try
                {
                    var status = new ScheduledTaskStatus
                    {
                        Exists = true,
                        LastRunTime = ValidTaskDate((DateTime)task.LastRunTime),
                        NextRunTime = ValidTaskDate((DateTime)task.NextRunTime),
                        LastTaskResult = (int)task.LastTaskResult,
                        State = StateName((int)task.State)
                    };
                    dynamic definition = task.Definition;
                    dynamic actions = definition.Actions;
                    dynamic triggers = definition.Triggers;
                    dynamic principal = definition.Principal;
                    dynamic settings = definition.Settings;
                    try
                    {
                        bool shapeMatches = (int)actions.Count == 1 && (int)triggers.Count == 1;
                        if (shapeMatches)
                        {
                            dynamic action = actions.Item(1);
                            dynamic trigger = triggers.Item(1);
                            dynamic repetition = trigger.Repetition;
                            try
                            {
                                status.IntervalHours = ParseIntervalHours((string)repetition.Interval);
                                shapeMatches = (int)action.Type == TaskActionExec
                                    && (int)trigger.Type == TaskTriggerTime
                                    && SameExecutable((string)action.Path, expected.ExecutablePath)
                                    && String.Equals(((string)action.Arguments ?? String.Empty).Trim(), TaskArguments, StringComparison.Ordinal)
                                    && String.IsNullOrWhiteSpace((string)action.WorkingDirectory)
                                    && status.IntervalHours == expected.IntervalHours
                                    && (bool)trigger.Enabled
                                    && (int)principal.LogonType == TaskLogonInteractiveToken
                                    && (int)principal.RunLevel == TaskRunLevelLeastPrivilege
                                    && SameUserSid((string)principal.UserId, _userSid)
                                    && (bool)settings.Enabled
                                    && (bool)settings.StartWhenAvailable
                                    && (int)settings.MultipleInstances == TaskInstancesIgnoreNew
                                    && !(bool)settings.WakeToRun
                                    && !(bool)settings.DisallowStartIfOnBatteries
                                    && !(bool)settings.StopIfGoingOnBatteries
                                    && !(bool)repetition.StopAtDurationEnd
                                    && HasIndefiniteTimePolicy(
                                        (string)settings.ExecutionTimeLimit,
                                        (string)repetition.Duration,
                                        (string)trigger.EndBoundary);
                            }
                            finally
                            {
                                ReleaseComObject(repetition);
                                ReleaseComObject(action);
                                ReleaseComObject(trigger);
                            }
                        }
                        status.MatchesExpected = expected.Enabled && shapeMatches && !legacyExists;
                    }
                    finally
                    {
                        ReleaseComObject(settings);
                        ReleaseComObject(principal);
                        ReleaseComObject(triggers);
                        ReleaseComObject(actions);
                        ReleaseComObject(definition);
                    }
                    return status;
                }
                catch
                {
                    return new ScheduledTaskStatus { Exists = true, MatchesExpected = false, State = "unreadable" };
                }
                finally
                {
                    ReleaseComObject(legacyTask);
                    ReleaseComObject(task);
                }
            });
        }

        public void Apply(ScheduledTaskRequest request)
        {
            if (request == null) throw new ArgumentNullException("request");
            if (request.IntervalHours < 1 || request.IntervalHours > 24)
                throw new ArgumentOutOfRangeException("request", "Scheduled interval must be from 1 to 24 hours.");
            if (String.IsNullOrWhiteSpace(request.ExecutablePath) || !File.Exists(request.ExecutablePath))
                throw new TaskSchedulerOperationException("The CourseStow application executable is unavailable.");

            ScheduledTaskStatus current = Inspect(request);
            if ((!request.Enabled && !current.Exists) || (request.Enabled && current.MatchesExpected)) return;

            WithService<object>(delegate(dynamic service)
            {
                if (!request.Enabled)
                {
                    DeleteExactTask(service, FolderPath);
                    DeleteExactTask(service, LegacyFolderPath);
                    return null;
                }

                dynamic folder = EnsureFolder(service, FolderPath);
                try
                {
                    dynamic definition = service.NewTask(0);
                    try
                    {
                        definition.RegistrationInfo.Description = "Runs CourseStow in the signed-in user's desktop session.";
                        definition.Principal.UserId = _userSid;
                        definition.Principal.LogonType = TaskLogonInteractiveToken;
                        definition.Principal.RunLevel = TaskRunLevelLeastPrivilege;
                        definition.Settings.Enabled = true;
                        definition.Settings.StartWhenAvailable = true;
                        definition.Settings.WakeToRun = false;
                        definition.Settings.DisallowStartIfOnBatteries = false;
                        definition.Settings.StopIfGoingOnBatteries = false;
                        definition.Settings.MultipleInstances = TaskInstancesIgnoreNew;
                        definition.Settings.ExecutionTimeLimit = "PT0S";

                        dynamic trigger = definition.Triggers.Create(TaskTriggerTime);
                        dynamic action = definition.Actions.Create(TaskActionExec);
                        try
                        {
                            trigger.StartBoundary = DateTime.Now.AddMinutes(1).ToString("yyyy-MM-dd'T'HH:mm:ss", CultureInfo.InvariantCulture);
                            trigger.Enabled = true;
                            trigger.Repetition.Interval = "PT" + request.IntervalHours.ToString(CultureInfo.InvariantCulture) + "H";
                            trigger.Repetition.StopAtDurationEnd = false;
                            action.Path = CanonicalExistingFile(request.ExecutablePath);
                            action.Arguments = TaskArguments;
                            action.WorkingDirectory = String.Empty;
                        }
                        finally
                        {
                            ReleaseComObject(action);
                            ReleaseComObject(trigger);
                        }

                        dynamic registered = folder.RegisterTaskDefinition(
                            _taskName, definition, TaskCreateOrUpdate,
                            _userSid, null,
                            TaskLogonInteractiveToken, null);
                        ReleaseComObject(registered);
                    }
                    finally { ReleaseComObject(definition); }
                    DeleteExactTask(service, LegacyFolderPath);
                    return null;
                }
                finally { ReleaseComObject(folder); }
            });
        }

        public void Restore(ScheduledTaskSnapshot snapshot)
        {
            if (snapshot == null) throw new ArgumentNullException("snapshot");
            WithService<object>(delegate(dynamic service)
            {
                DeleteExactTask(service, FolderPath);
                DeleteExactTask(service, LegacyFolderPath);
                if (snapshot.Exists) RestoreExactTask(service, FolderPath, snapshot.Xml);
                if (snapshot.LegacyExists) RestoreExactTask(service, LegacyFolderPath, snapshot.LegacyXml);
                return null;
            });
        }

        private static T WithService<T>(Func<dynamic, T> operation)
        {
            Type serviceType = Type.GetTypeFromProgID("Schedule.Service");
            if (serviceType == null) throw new TaskSchedulerOperationException("Windows Task Scheduler is unavailable.");
            dynamic service = Activator.CreateInstance(serviceType);
            try
            {
                service.Connect();
                return operation(service);
            }
            catch (TaskSchedulerOperationException) { throw; }
            catch (Exception error)
            {
                throw new TaskSchedulerOperationException("Windows could not update CourseStow scheduling.", error);
            }
            finally { ReleaseComObject(service); }
        }

        private static dynamic EnsureFolder(dynamic service, string folderPath)
        {
            try { return service.GetFolder(folderPath); }
            catch
            {
                dynamic root = service.GetFolder(@"\");
                try { return root.CreateFolder(folderPath.TrimStart('\\'), null); }
                finally { ReleaseComObject(root); }
            }
        }

        private dynamic GetExactTask(dynamic service, string folderPath)
        {
            dynamic folder = null;
            try
            {
                folder = service.GetFolder(folderPath);
                return folder.GetTask(_taskName);
            }
            catch (COMException error)
            {
                if (IsNotFound(error)) return null;
                throw;
            }
            finally { ReleaseComObject(folder); }
        }

        private void DeleteExactTask(dynamic service, string folderPath)
        {
            dynamic task = GetExactTask(service, folderPath);
            if (task == null) return;
            ReleaseComObject(task);
            dynamic folder = service.GetFolder(folderPath);
            try { folder.DeleteTask(_taskName, 0); }
            finally { ReleaseComObject(folder); }
        }

        private void RestoreExactTask(dynamic service, string folderPath, string xml)
        {
            if (String.IsNullOrWhiteSpace(xml))
                throw new TaskSchedulerOperationException("The previous scheduled task snapshot is unavailable.");
            dynamic folder = EnsureFolder(service, folderPath);
            try
            {
                dynamic restored = folder.RegisterTask(
                    _taskName, xml, TaskCreateOrUpdate,
                    _userSid, null,
                    TaskLogonInteractiveToken, null);
                ReleaseComObject(restored);
            }
            finally { ReleaseComObject(folder); }
        }

        private static bool IsNotFound(COMException error)
        {
            uint code = unchecked((uint)error.HResult);
            return code == 0x80070002u || code == 0x8004130Fu;
        }

        private static int ParseIntervalHours(string interval)
        {
            if (String.IsNullOrWhiteSpace(interval) || !interval.StartsWith("PT", StringComparison.Ordinal) || !interval.EndsWith("H", StringComparison.Ordinal))
                return 0;
            int value;
            return Int32.TryParse(interval.Substring(2, interval.Length - 3), NumberStyles.None, CultureInfo.InvariantCulture, out value) ? value : 0;
        }

        private static bool IsIndefiniteDuration(string duration)
        {
            return String.IsNullOrWhiteSpace(duration)
                || String.Equals(duration.Trim(), "PT0S", StringComparison.OrdinalIgnoreCase);
        }

        private static string CurrentUserSid()
        {
            using (WindowsIdentity identity = WindowsIdentity.GetCurrent())
            {
                if (identity.User == null)
                    throw new TaskSchedulerOperationException("Windows could not determine the current user identity for automatic sync.");
                return identity.User.Value;
            }
        }

        private static string NormalizeSid(string value)
        {
            if (String.IsNullOrWhiteSpace(value))
                throw new ArgumentException("A Windows user SID is required.", "value");
            try { return new SecurityIdentifier(value.Trim()).Value; }
            catch (ArgumentException error)
            {
                throw new ArgumentException("The Windows user SID is invalid.", "value", error);
            }
        }

        private static bool SameUserSid(string principal, string expectedSid)
        {
            if (String.IsNullOrWhiteSpace(principal)) return false;
            try
            {
                return String.Equals(new SecurityIdentifier(principal).Value, expectedSid, StringComparison.OrdinalIgnoreCase);
            }
            catch (ArgumentException)
            {
                try
                {
                    var account = new NTAccount(principal);
                    var sid = (SecurityIdentifier)account.Translate(typeof(SecurityIdentifier));
                    return String.Equals(sid.Value, expectedSid, StringComparison.OrdinalIgnoreCase);
                }
                catch { return false; }
            }
        }

        private static bool SameExecutable(string left, string right)
        {
            try
            {
                return String.Equals(
                    CanonicalExistingFile(Environment.ExpandEnvironmentVariables(left ?? String.Empty)).TrimEnd('\\'),
                    CanonicalExistingFile(right ?? String.Empty).TrimEnd('\\'),
                    StringComparison.OrdinalIgnoreCase);
            }
            catch { return false; }
        }

        private static string CanonicalExistingFile(string value)
        {
            string fullPath = Path.GetFullPath(value);
            using (var stream = new FileStream(fullPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                var buffer = new StringBuilder(1024);
                uint length = GetFinalPathNameByHandle(stream.SafeFileHandle, buffer, (uint)buffer.Capacity, 0);
                if (length == 0) return fullPath;
                if (length >= buffer.Capacity)
                {
                    buffer.Capacity = checked((int)length + 1);
                    length = GetFinalPathNameByHandle(stream.SafeFileHandle, buffer, (uint)buffer.Capacity, 0);
                    if (length == 0) return fullPath;
                }
                string resolved = buffer.ToString();
                if (resolved.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase))
                    return @"\\" + resolved.Substring(8);
                if (resolved.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase))
                    return resolved.Substring(4);
                return resolved;
            }
        }

        private static DateTime? ValidTaskDate(DateTime value)
        {
            return value.Year < 1901 ? (DateTime?)null : value;
        }

        private static string StateName(int value)
        {
            switch (value)
            {
                case 1: return "disabled";
                case 2: return "queued";
                case 3: return "ready";
                case 4: return "running";
                default: return "unknown";
            }
        }

        private static void ReleaseComObject(object value)
        {
            if (value != null && Marshal.IsComObject(value))
            {
                try { Marshal.FinalReleaseComObject(value); } catch { }
            }
        }
    }
}
