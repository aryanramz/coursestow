using System;

namespace CourseStow.ControlPanel
{
    internal static class ScheduledRunCommand
    {
        internal static int Run()
        {
            try { return Run(new BackendClient()); }
            catch { return 1; }
        }

        internal static int Run(IDesktopBackendClient backend)
        {
            if (backend == null) throw new ArgumentNullException("backend");
            try
            {
                BackendProcessResult result = backend.RunScheduledAsync().GetAwaiter().GetResult();
                return result == null ? 1 : result.ExitCode;
            }
            catch
            {
                // The scheduled entry point has no UI and never emits raw backend
                // diagnostics. The Node scheduled log records a safe category.
                return 1;
            }
        }
    }
}
