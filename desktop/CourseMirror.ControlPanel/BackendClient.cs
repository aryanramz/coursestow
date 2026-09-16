using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace CourseMirror.ControlPanel
{
    internal sealed class BackendPaths
    {
        internal string ApplicationRoot { get; private set; }
        internal string NodeExecutable { get; private set; }
        internal string LauncherScript { get; private set; }
        internal string WorkingDirectory { get; private set; }

        private BackendPaths() { }

        internal static BackendPaths Resolve()
        {
            string root = Environment.GetEnvironmentVariable("COURSEMIRROR_DEV_BUNDLE_ROOT");
            if (String.IsNullOrWhiteSpace(root))
                root = Environment.GetEnvironmentVariable("BRIGHTSPACE_SYNC_DEV_BUNDLE_ROOT");
            if (String.IsNullOrWhiteSpace(root))
                root = AppDomain.CurrentDomain.BaseDirectory;

            root = Path.GetFullPath(root);
            string node = Path.Combine(root, "runtime", "node.exe");
            string app = Path.Combine(root, "app");
            string launcher = Path.Combine(app, "src", "launcher.mjs");

            if (!File.Exists(node))
                throw new FileNotFoundException("The private CourseMirror runtime is missing. Rebuild or repair the application.", node);
            if (!File.Exists(launcher))
                throw new FileNotFoundException("The CourseMirror backend is missing. Rebuild or repair the application.", launcher);

            return new BackendPaths
            {
                ApplicationRoot = root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
                NodeExecutable = node,
                LauncherScript = launcher,
                WorkingDirectory = app
            };
        }
    }

    internal sealed class BackendStatus
    {
        public int schemaVersion { get; set; }
        public string appVersion { get; set; }
        public string status { get; set; }
        public bool configExists { get; set; }
        public bool configured { get; set; }
        public bool baseUrlConfigured { get; set; }
        public string mirrorDir { get; set; }
        public string logsDir { get; set; }
        public string dataDir { get; set; }
        public bool profileExists { get; set; }
        public string lastSync { get; set; }
        public string activeOperation { get; set; }
        public string attention { get; set; }
    }

    internal sealed class BackendProcessResult
    {
        internal int ExitCode { get; set; }
        internal string StandardOutput { get; set; }
        internal string StandardError { get; set; }
    }

    internal sealed class DesktopDriveSettings
    {
        public bool enabled { get; set; }
        public string destination { get; set; }
    }

    internal sealed class DesktopAuthenticationSettings
    {
        public bool supported { get; set; }
        public string institution { get; set; }
        public bool automaticLoginEnabled { get; set; }
        public bool retryRequested { get; set; }
    }

    internal sealed class DesktopScheduleSettings
    {
        public bool enabled { get; set; }
        public int intervalHours { get; set; }
        public int fullIntervalDays { get; set; }
    }

    internal sealed class DesktopBrowserSettings
    {
        public int schemaVersion { get; set; }
        public string engine { get; set; }
        public bool available { get; set; }
        public string displayName { get; set; }
        public string executablePath { get; set; }
        public string source { get; set; }
        public bool configuredManually { get; set; }
        public string supportLevel { get; set; }
        public string validationStatus { get; set; }
    }

    internal sealed class DesktopSettings
    {
        public int schemaVersion { get; set; }
        public bool configured { get; set; }
        public string baseUrl { get; set; }
        public string mirrorDir { get; set; }
        public bool mirrorOverrideActive { get; set; }
        public bool maySuggestFirstRunMirror { get; set; }
        public bool mayImportLegacySetup { get; set; }
        public DesktopBrowserSettings browser { get; set; }
        public DesktopDriveSettings drive { get; set; }
        public DesktopAuthenticationSettings authentication { get; set; }
        public DesktopScheduleSettings schedule { get; set; }
    }

    internal sealed class SettingsSaveRequest
    {
        public int schemaVersion { get; set; }
        public string baseUrl { get; set; }
        public string mirrorDir { get; set; }
        public DesktopDriveSettings drive { get; set; }
        public DesktopAuthenticationSettings authentication { get; set; }
        public DesktopScheduleSettings schedule { get; set; }
        public DesktopBrowserSettings browser { get; set; }
        public string mirrorAction { get; set; }
    }

    internal sealed class BrowserProbeRequest
    {
        public int schemaVersion { get; set; }
        public string executablePath { get; set; }
    }

    internal sealed class SourceImportRequest
    {
        public int schemaVersion { get; set; }
        public string sourceDir { get; set; }
    }

    internal sealed class SourceImportResponse
    {
        public int schemaVersion { get; set; }
        public bool ok { get; set; }
        public bool imported { get; set; }
        public SettingsValidationError[] errors { get; set; }
    }

    internal sealed class SettingsValidationError
    {
        public string field { get; set; }
        public string code { get; set; }
        public string message { get; set; }
    }

    internal sealed class MirrorRelocationRequest
    {
        public bool required { get; set; }
        public string oldMirrorDir { get; set; }
        public string newMirrorDir { get; set; }
    }

    internal sealed class MirrorRecoveryInformation
    {
        public bool required { get; set; }
        public string oldMirrorDir { get; set; }
        public string newMirrorDir { get; set; }
        public bool configRetainedOldLocation { get; set; }
    }

    internal sealed class SettingsSaveResponse
    {
        public int schemaVersion { get; set; }
        public bool ok { get; set; }
        public DesktopSettings settings { get; set; }
        public bool mirrorMoved { get; set; }
        public SettingsValidationError[] errors { get; set; }
        public MirrorRelocationRequest relocation { get; set; }
        public MirrorRecoveryInformation recovery { get; set; }
    }

    internal sealed class BackendCommandException : Exception
    {
        internal int ExitCode { get; private set; }

        internal BackendCommandException(string message, int exitCode)
            : base(message)
        {
            ExitCode = exitCode;
        }
    }

    internal sealed class BoundedOutputBuffer
    {
        private readonly int _maximumCharacters;
        private readonly StringBuilder _value = new StringBuilder();
        private readonly object _gate = new object();

        internal BoundedOutputBuffer(int maximumCharacters)
        {
            _maximumCharacters = maximumCharacters;
        }

        internal void AppendLine(string line)
        {
            if (line == null) return;
            lock (_gate)
            {
                _value.AppendLine(line);
                if (_value.Length > _maximumCharacters)
                    _value.Remove(0, _value.Length - _maximumCharacters);
            }
        }

        public override string ToString()
        {
            lock (_gate) return _value.ToString();
        }
    }

    internal interface IDesktopBackendClient
    {
        Task<BackendStatus> GetStatusAsync();
        Task<DesktopSettings> GetSettingsAsync();
        Task<SettingsSaveResponse> SaveSettingsAsync(SettingsSaveRequest request);
        Task<DesktopBrowserSettings> GetBrowserAsync();
        Task<DesktopBrowserSettings> ProbeBrowserAsync(string executablePath);
        Task<SourceImportResponse> ImportSourceAsync(string sourceDir);
        Task<BackendProcessResult> RunSyncAsync(string mode);
        Task<BackendProcessResult> RunRefreshLoginAsync();
        Task<BackendProcessResult> RunScheduledAsync();
    }

    internal sealed class BackendClient : IDesktopBackendClient
    {
        internal const int SupportedStatusSchemaVersion = 1;
        private readonly BackendPaths _paths;
        private readonly JavaScriptSerializer _json = new JavaScriptSerializer();

        internal BackendClient()
        {
            _paths = BackendPaths.Resolve();
        }

        internal BackendPaths Paths { get { return _paths; } }

        internal ProcessStartInfo CreateStartInfo(string command, params string[] arguments)
        {
            return CreateStartInfo(command, false, arguments);
        }

        internal ProcessStartInfo CreateSettingsSaveStartInfo()
        {
            return CreateStartInfo("settings", true, "save", "--json");
        }

        internal ProcessStartInfo CreateBrowserProbeStartInfo()
        {
            return CreateStartInfo("browser", true, "probe", "--json");
        }

        internal ProcessStartInfo CreateSourceImportStartInfo()
        {
            return CreateStartInfo("settings", true, "import", "--json");
        }

        private ProcessStartInfo CreateStartInfo(string command, bool redirectStandardInput, params string[] arguments)
        {
            if (String.IsNullOrWhiteSpace(command)) throw new ArgumentException("A backend command is required.", "command");

            var allArguments = new List<string>();
            allArguments.Add(_paths.LauncherScript);
            allArguments.Add(command);
            if (arguments != null) allArguments.AddRange(arguments);

            var quoted = new List<string>();
            foreach (string argument in allArguments) quoted.Add(QuoteWindowsArgument(argument));

            var startInfo = new ProcessStartInfo
            {
                FileName = _paths.NodeExecutable,
                Arguments = String.Join(" ", quoted.ToArray()),
                WorkingDirectory = _paths.WorkingDirectory,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                RedirectStandardInput = redirectStandardInput
            };
            startInfo.EnvironmentVariables["COURSEMIRROR_GUI"] = "1";
            return startInfo;
        }

        internal async Task<BackendProcessResult> RunAsync(string command, params string[] arguments)
        {
            return await RunProcessAsync(command, null, arguments);
        }

        private async Task<BackendProcessResult> RunProcessAsync(string command, string standardInput, params string[] arguments)
        {
            var stdout = new BoundedOutputBuffer(32768);
            var stderr = new BoundedOutputBuffer(32768);

            using (var process = new Process())
            {
                process.StartInfo = CreateStartInfo(command, standardInput != null, arguments);
                process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { stdout.AppendLine(e.Data); };
                process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { stderr.AppendLine(e.Data); };

                if (!process.Start()) throw new InvalidOperationException("The CourseMirror backend did not start.");
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                if (standardInput != null)
                {
                    await process.StandardInput.WriteAsync(standardInput);
                    process.StandardInput.Close();
                }
                await Task.Run(new Action(process.WaitForExit));

                return new BackendProcessResult
                {
                    ExitCode = process.ExitCode,
                    StandardOutput = stdout.ToString(),
                    StandardError = stderr.ToString()
                };
            }
        }

        public async Task<BackendStatus> GetStatusAsync()
        {
            BackendProcessResult result = await RunAsync("status", "--json");
            if (result.ExitCode != 0)
                throw new BackendCommandException("The CourseMirror backend could not report its status.", result.ExitCode);

            string jsonLine = LastNonEmptyLine(result.StandardOutput);
            BackendStatus status;
            try
            {
                status = _json.Deserialize<BackendStatus>(jsonLine);
            }
            catch (Exception error)
            {
                throw new InvalidDataException("The CourseMirror backend returned an invalid status response.", error);
            }

            if (status == null || status.schemaVersion != SupportedStatusSchemaVersion)
                throw new InvalidDataException("The CourseMirror backend status schema is not supported.");
            if (String.IsNullOrWhiteSpace(status.mirrorDir) || String.IsNullOrWhiteSpace(status.logsDir) || String.IsNullOrWhiteSpace(status.dataDir))
                throw new InvalidDataException("The CourseMirror backend status response is incomplete.");
            return status;
        }

        public async Task<DesktopSettings> GetSettingsAsync()
        {
            BackendProcessResult result = await RunAsync("settings", "--json");
            if (result.ExitCode != 0)
                throw new BackendCommandException("The CourseMirror backend could not load settings.", result.ExitCode);

            DesktopSettings settings = DeserializeResponse<DesktopSettings>(result.StandardOutput, "settings");
            ValidateSettings(settings);
            return settings;
        }

        public async Task<SettingsSaveResponse> SaveSettingsAsync(SettingsSaveRequest request)
        {
            if (request == null) throw new ArgumentNullException("request");
            string payload = _json.Serialize(request);
            BackendProcessResult result = await RunProcessAsync("settings", payload, "save", "--json");
            if (result.ExitCode != 0)
                throw new BackendCommandException("The CourseMirror backend could not save settings.", result.ExitCode);

            SettingsSaveResponse response = ParseSettingsSaveResponse(result.StandardOutput);
            return response;
        }

        public async Task<DesktopBrowserSettings> GetBrowserAsync()
        {
            BackendProcessResult result = await RunAsync("browser", "--json");
            if (result.ExitCode != 0)
                throw new BackendCommandException("The CourseMirror backend could not inspect compatible browsers.", result.ExitCode);
            return ParseBrowserResponse(result.StandardOutput);
        }

        public async Task<DesktopBrowserSettings> ProbeBrowserAsync(string executablePath)
        {
            var request = new BrowserProbeRequest { schemaVersion = 1, executablePath = executablePath ?? String.Empty };
            BackendProcessResult result = await RunProcessAsync("browser", _json.Serialize(request), "probe", "--json");
            if (result.ExitCode != 0)
                throw new BackendCommandException("The selected browser could not be validated.", result.ExitCode);
            return ParseBrowserResponse(result.StandardOutput);
        }

        public async Task<SourceImportResponse> ImportSourceAsync(string sourceDir)
        {
            var request = new SourceImportRequest { schemaVersion = 1, sourceDir = sourceDir ?? String.Empty };
            BackendProcessResult result = await RunProcessAsync("settings", _json.Serialize(request), "import", "--json");
            if (result.ExitCode != 0)
                throw new BackendCommandException("The selected setup could not be imported.", result.ExitCode);
            SourceImportResponse response = DeserializeResponse<SourceImportResponse>(result.StandardOutput, "source import");
            if (response == null || response.schemaVersion != SupportedStatusSchemaVersion)
                throw new InvalidDataException("The CourseMirror source-import schema is not supported.");
            if (!response.ok && (response.errors == null || response.errors.Length == 0))
                throw new InvalidDataException("The CourseMirror backend returned an incomplete source-import response.");
            return response;
        }

        private DesktopBrowserSettings ParseBrowserResponse(string standardOutput)
        {
            DesktopBrowserSettings browser = DeserializeResponse<DesktopBrowserSettings>(standardOutput, "browser");
            if (browser == null || browser.schemaVersion != SupportedStatusSchemaVersion
                || !String.Equals(browser.engine, "chromium", StringComparison.Ordinal))
                throw new InvalidDataException("The CourseMirror browser response is not supported.");
            return browser;
        }

        internal SettingsSaveResponse ParseSettingsSaveResponseForSelfTest(string standardOutput)
        {
            return ParseSettingsSaveResponse(standardOutput);
        }

        private SettingsSaveResponse ParseSettingsSaveResponse(string standardOutput)
        {
            SettingsSaveResponse response = DeserializeResponse<SettingsSaveResponse>(standardOutput, "settings save");
            if (response == null || response.schemaVersion != SupportedStatusSchemaVersion)
                throw new InvalidDataException("The CourseMirror backend settings-save schema is not supported.");
            if (response.ok)
            {
                ValidateSettings(response.settings);
            }
            else if (response.errors == null || response.errors.Length == 0)
            {
                throw new InvalidDataException("The CourseMirror backend returned an incomplete settings validation response.");
            }
            return response;
        }

        public Task<BackendProcessResult> RunSyncAsync(string mode)
        {
            if (mode != "quick" && mode != "full") throw new ArgumentOutOfRangeException("mode");
            return RunAsync(mode);
        }

        public Task<BackendProcessResult> RunRefreshLoginAsync()
        {
            return RunAsync("refresh-login");
        }

        public Task<BackendProcessResult> RunScheduledAsync()
        {
            return RunAsync("scheduled");
        }

        private T DeserializeResponse<T>(string standardOutput, string label)
        {
            try
            {
                return _json.Deserialize<T>(LastNonEmptyLine(standardOutput));
            }
            catch (Exception error)
            {
                throw new InvalidDataException("The CourseMirror backend returned an invalid " + label + " response.", error);
            }
        }

        private static void ValidateSettings(DesktopSettings settings)
        {
            if (settings == null || settings.schemaVersion != SupportedStatusSchemaVersion)
                throw new InvalidDataException("The CourseMirror backend settings schema is not supported.");
            if (String.IsNullOrWhiteSpace(settings.mirrorDir) || settings.drive == null || settings.authentication == null || settings.schedule == null || settings.browser == null)
                throw new InvalidDataException("The CourseMirror backend settings response is incomplete.");
            if (settings.schedule.intervalHours < 1 || settings.schedule.intervalHours > 24
                || settings.schedule.fullIntervalDays < 1 || settings.schedule.fullIntervalDays > 30)
                throw new InvalidDataException("The CourseMirror backend returned invalid scheduling settings.");
        }

        internal static string LastNonEmptyLine(string value)
        {
            string[] lines = (value ?? String.Empty).Split(new[] { "\r\n", "\n" }, StringSplitOptions.RemoveEmptyEntries);
            return lines.Length == 0 ? String.Empty : lines[lines.Length - 1].Trim();
        }

        internal static string QuoteWindowsArgument(string argument)
        {
            argument = argument ?? String.Empty;
            if (argument.Length > 0 && argument.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0)
                return argument;

            var result = new StringBuilder();
            result.Append('"');
            int backslashes = 0;
            foreach (char character in argument)
            {
                if (character == '\\')
                {
                    backslashes++;
                    continue;
                }
                if (character == '"')
                {
                    result.Append('\\', backslashes * 2 + 1);
                    result.Append('"');
                    backslashes = 0;
                    continue;
                }
                result.Append('\\', backslashes);
                backslashes = 0;
                result.Append(character);
            }
            result.Append('\\', backslashes * 2);
            result.Append('"');
            return result.ToString();
        }
    }
}
