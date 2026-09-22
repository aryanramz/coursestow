using System;
using System.Threading;

namespace CourseStow.Security
{
    internal static class CourseStowProcessIdentity
    {
        internal const string ControlPanelMutexName = @"Local\CourseStow.ControlPanel";
        internal const string LegacyControlPanelMutexName = @"Local\BrightspaceSync.ControlPanel";
        internal const string CredentialHelperMutexName = @"Local\CourseStow.CredentialHelper";
        internal const string InstallerLifecycleMutexName = @"Local\CourseStow.InstallerLifecycle";

        internal static bool IsMutexActive(string name)
        {
            if (String.IsNullOrWhiteSpace(name)) throw new ArgumentException("A mutex name is required.", "name");
            try
            {
                using (Mutex.OpenExisting(name)) return true;
            }
            catch (WaitHandleCannotBeOpenedException)
            {
                return false;
            }
        }
    }
}
