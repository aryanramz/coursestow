using System;
using System.Diagnostics;
using System.Threading;
using System.Windows.Forms;
using CourseStow.Security;

namespace CourseStow.ControlPanel
{
    internal static class Program
    {
        internal const string MutexName = CourseStowProcessIdentity.ControlPanelMutexName;
        internal const string LegacyMutexName = CourseStowProcessIdentity.LegacyControlPanelMutexName;
        internal const string InstallerLaunchArgument = "--installer-launch";
        internal const int InstallerLaunchTimeoutMilliseconds = 10000;
        internal const int InstallerLaunchPollMilliseconds = 200;

        [STAThread]
        private static int Main(string[] args)
        {
            int maintenanceExitCode;
            if (InstallerMaintenanceCommand.TryRun(args, out maintenanceExitCode))
                return maintenanceExitCode;

            if (args.Length == 2 && args[0] == "--installer-lifecycle-self-test")
                return InstallerMaintenanceSelfTest.Run(args[1]);

            bool installerReady;
            try
            {
                var timer = Stopwatch.StartNew();
                installerReady = WaitForInstallerIfRequested(
                    args,
                    delegate { return CourseStowProcessIdentity.IsMutexActive(CourseStowProcessIdentity.InstallerLifecycleMutexName); },
                    Thread.Sleep,
                    delegate { return timer.ElapsedMilliseconds; });
            }
            catch { return 4; }
            if (!installerReady)
            {
                if (!IsScheduledRun(args))
                    MessageBox.Show("CourseStow is being installed or repaired. Try again when setup finishes.", "CourseStow", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return 4;
            }

            if (IsScheduledRun(args))
                return ScheduledRunCommand.Run();

            if (args.Length == 2 && args[0] == "--self-test")
                return ControlPanelSelfTest.Run(args[1]);

            if (args.Length == 2 && args[0] == "--update-check-self-test")
                return UpdateCheckSelfTest.Run(args[1]);

            bool ownsMutex;
            bool ownsLegacyMutex;
            using (var singleInstance = new Mutex(true, MutexName, out ownsMutex))
            using (var legacySingleInstance = new Mutex(true, LegacyMutexName, out ownsLegacyMutex))
            {
                if (!ownsMutex || !ownsLegacyMutex)
                {
                    MessageBox.Show("CourseStow is already open.", "CourseStow", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return 0;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new MainForm());
                GC.KeepAlive(legacySingleInstance);
                GC.KeepAlive(singleInstance);
            }
            return 0;
        }

        internal static bool IsScheduledRun(string[] args)
        {
            return args != null && args.Length == 1
                && String.Equals(args[0], "--scheduled-run", StringComparison.Ordinal);
        }

        internal static bool IsInstallerLaunch(string[] args)
        {
            return args != null && args.Length == 1
                && String.Equals(args[0], InstallerLaunchArgument, StringComparison.Ordinal);
        }

        internal static bool WaitForInstallerIfRequested(
            string[] args, Func<bool> isInstallerActive, Action<int> wait, Func<long> elapsedMilliseconds)
        {
            if (isInstallerActive == null) throw new ArgumentNullException("isInstallerActive");
            if (!IsInstallerLaunch(args)) return !isInstallerActive();
            if (wait == null) throw new ArgumentNullException("wait");
            if (elapsedMilliseconds == null) throw new ArgumentNullException("elapsedMilliseconds");

            while (isInstallerActive())
            {
                long remaining = InstallerLaunchTimeoutMilliseconds - elapsedMilliseconds();
                if (remaining <= 0) return false;
                wait((int)Math.Min(InstallerLaunchPollMilliseconds, remaining));
            }
            return true;
        }
    }
}
