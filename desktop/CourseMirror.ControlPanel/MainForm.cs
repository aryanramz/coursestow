using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace CourseMirror.ControlPanel
{
    internal sealed class MainForm : Form
    {
        internal const int StatusRefreshIntervalMilliseconds = 5000;
        private readonly Label _statusValue = new Label();
        private readonly Label _lastSyncValue = new Label();
        private readonly Button _quickButton = new Button();
        private readonly Button _fullButton = new Button();
        private readonly Button _openMirrorButton = new Button();
        private readonly Button _settingsButton = new Button();
        private readonly Button _refreshLoginButton = new Button();
        private readonly Button _viewLogsButton = new Button();
        private readonly LinkLabel _checkUpdatesLink = new LinkLabel();
        private readonly Label _updateMessage = new Label();
        private readonly LinkLabel _viewReleaseLink = new LinkLabel();
        private readonly TextBox _activity = new TextBox();
        private readonly System.Windows.Forms.Timer _statusTimer = new System.Windows.Forms.Timer();
        private readonly SemaphoreSlim _statusRefreshGate = new SemaphoreSlim(1, 1);
        private readonly ISettingsDialogService _settingsDialog;
        private readonly IUpdateCheckServiceFactory _updateCheckFactory;
        private IDesktopBackendClient _backend;
        private BackendStatus _backendStatus;
        private IUpdateCheckService _updateChecker;
        private string _trustedReleaseUrl;
        private bool _updateCheckRunning;
        private bool _updateAvailable;
        private bool _automaticUpdateCheckStarted;
        private bool _operationRunning;
        private bool _operationStarting;
        private bool _closing;
        private bool _firstRunSetupOffered;
        private bool _browserReady;

        internal MainForm() : this(null, StatusRefreshIntervalMilliseconds, null, new UpdateCheckServiceFactory()) { }

        internal MainForm(IDesktopBackendClient backend, int statusRefreshIntervalMilliseconds)
            : this(backend, statusRefreshIntervalMilliseconds, null, new DisabledUpdateCheckServiceFactory()) { }

        internal MainForm(IDesktopBackendClient backend, int statusRefreshIntervalMilliseconds, ISettingsDialogService settingsDialog)
            : this(backend, statusRefreshIntervalMilliseconds, settingsDialog, new DisabledUpdateCheckServiceFactory()) { }

        internal MainForm(IDesktopBackendClient backend, int statusRefreshIntervalMilliseconds, ISettingsDialogService settingsDialog, IUpdateCheckServiceFactory updateCheckFactory)
        {
            _backend = backend;
            _settingsDialog = settingsDialog ?? new SettingsDialogService();
            _updateCheckFactory = updateCheckFactory ?? new DisabledUpdateCheckServiceFactory();
            Text = "CourseMirror";
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(520, 436);
            MinimumSize = new Size(536, 475);
            Font = new Font("Segoe UI", 9F, FontStyle.Regular, GraphicsUnit.Point);
            AutoScaleMode = AutoScaleMode.Dpi;
            FormClosing += OnFormClosing;
            FormClosed += OnFormClosed;
            Activated += async delegate { await PollStatusAsync(); };
            _statusTimer.Interval = Math.Max(100, statusRefreshIntervalMilliseconds);
            _statusTimer.Tick += async delegate { await PollStatusAsync(); };

            var title = new Label
            {
                AutoSize = true,
                Text = "CourseMirror",
                Font = new Font("Segoe UI Semibold", 18F, FontStyle.Bold, GraphicsUnit.Point),
                ForeColor = Color.FromArgb(34, 54, 74),
                Location = new Point(24, 20)
            };

            var statusLabel = CreateCaption("Status:", 27, 72);
            _statusValue.AutoSize = true;
            _statusValue.Text = "Loading";
            _statusValue.Location = new Point(120, 72);
            _statusValue.Font = new Font(Font, FontStyle.Bold);

            var lastSyncLabel = CreateCaption("Last Sync:", 27, 98);
            _lastSyncValue.AutoSize = true;
            _lastSyncValue.Text = "Never";
            _lastSyncValue.Location = new Point(120, 98);

            ConfigureButton(_quickButton, "Quick Sync", 27, 137, 218);
            ConfigureButton(_fullButton, "Full Sync", 275, 137, 218);
            ConfigureButton(_openMirrorButton, "Open Mirror", 27, 183, 218);
            ConfigureButton(_viewLogsButton, "View Logs", 275, 183, 218);
            ConfigureButton(_settingsButton, "Settings", 27, 229, 218);
            ConfigureButton(_refreshLoginButton, "Refresh Login", 275, 229, 218);

            _quickButton.Click += async delegate { await RunSyncAsync("quick"); };
            _fullButton.Click += async delegate { await RunSyncAsync("full"); };
            _openMirrorButton.Click += delegate { OpenResolvedDirectory(true); };
            _viewLogsButton.Click += delegate { OpenResolvedDirectory(false); };
            _settingsButton.Click += async delegate { await OpenSettingsAsync(false); };
            _refreshLoginButton.Click += async delegate { await RunRefreshLoginAsync(); };

            _checkUpdatesLink.AutoSize = true;
            _checkUpdatesLink.Text = "Check for Updates";
            _checkUpdatesLink.Location = new Point(27, 281);
            _checkUpdatesLink.LinkClicked += async delegate { await CheckForUpdatesAsync(true); };

            _updateMessage.AutoEllipsis = true;
            _updateMessage.Location = new Point(151, 280);
            _updateMessage.Size = new Size(255, 22);

            _viewReleaseLink.AutoSize = true;
            _viewReleaseLink.Text = "View Release";
            _viewReleaseLink.Location = new Point(416, 281);
            _viewReleaseLink.Visible = false;
            _viewReleaseLink.LinkClicked += delegate { OpenTrustedRelease(); };

            var activityLabel = CreateCaption("Activity / Result:", 27, 324);
            activityLabel.AutoSize = true;
            _activity.Location = new Point(27, 348);
            _activity.Size = new Size(466, 56);
            _activity.Multiline = true;
            _activity.ReadOnly = true;
            _activity.BackColor = SystemColors.Window;
            _activity.BorderStyle = BorderStyle.FixedSingle;
            _activity.Text = "Loading application status...";

            Controls.AddRange(new Control[] {
                title, statusLabel, _statusValue, lastSyncLabel, _lastSyncValue,
                _quickButton, _fullButton, _openMirrorButton, _viewLogsButton,
                _settingsButton, _refreshLoginButton, _checkUpdatesLink, _updateMessage,
                _viewReleaseLink, activityLabel, _activity
            });

            SetSyncButtons(false);
            Shown += async delegate
            {
                await InitializeBackendAsync();
                if (!_closing) _statusTimer.Start();
            };
        }

        internal bool SyncButtonsEnabledForSelfTest { get { return _quickButton.Enabled && _fullButton.Enabled; } }
        internal string StatusTextForSelfTest { get { return _statusValue.Text; } }
        internal int StatusRefreshIntervalForSelfTest { get { return _statusTimer.Interval; } }
        internal Task InitializeForSelfTestAsync() { return InitializeBackendAsync(); }
        internal Task<bool> PollStatusForSelfTestAsync() { return RefreshStatusAsync(false, true, true); }
        internal Task RunSyncForSelfTestAsync(string mode) { return RunSyncAsync(mode); }
        internal Task RunRefreshLoginForSelfTestAsync() { return RunRefreshLoginAsync(); }
        internal bool OperationStartingForSelfTest { get { return _operationStarting; } }
        internal bool FirstRunSetupOfferedForSelfTest { get { return _firstRunSetupOffered; } }
        internal BackendStatus BackendStatusForSelfTest { get { return _backendStatus; } }
        internal bool UpdateCheckRunningForSelfTest { get { return _updateCheckRunning; } }
        internal bool UpdateAvailableForSelfTest { get { return _updateAvailable; } }
        internal string UpdateTextForSelfTest { get { return _updateMessage.Text; } }
        internal Task CheckForUpdatesForSelfTestAsync(bool manual) { return CheckForUpdatesAsync(manual); }
        internal string StatusUiSnapshotForSelfTest
        {
            get { return String.Join("|", _statusValue.Text, _lastSyncValue.Text, _activity.Text, _quickButton.Enabled, _fullButton.Enabled); }
        }
        internal bool BeginClosingForSelfTest()
        {
            var args = new FormClosingEventArgs(CloseReason.UserClosing, false);
            OnFormClosing(this, args);
            return !args.Cancel;
        }

        private Label CreateCaption(string text, int x, int y)
        {
            return new Label { AutoSize = true, Text = text, Location = new Point(x, y) };
        }

        private static void ConfigureButton(Button button, string text, int x, int y, int width)
        {
            button.Text = text;
            button.Location = new Point(x, y);
            button.Size = new Size(width, 34);
            button.UseVisualStyleBackColor = true;
        }

        private async Task InitializeBackendAsync()
        {
            try
            {
                if (_backend == null) _backend = new BackendClient();
                bool refreshed = await RefreshStatusAsync(true, false, false);
                if (refreshed && !_closing && !_backendStatus.configured
                    && String.IsNullOrWhiteSpace(_backendStatus.activeOperation)
                    && String.IsNullOrWhiteSpace(_backendStatus.attention))
                {
                    _firstRunSetupOffered = true;
                    await OpenSettingsAsync(true);
                }
                else if (refreshed && !_closing && _backendStatus.configured)
                {
                    _browserReady = await InspectBrowserForStartupAsync();
                    UpdateSyncButtons();
                    if (!_browserReady && !_closing)
                    {
                        SetStatus("Browser Required", Color.DarkGoldenrod);
                        _activity.Text = "Choose or install a compatible Chromium browser. CourseMirror remains available for configuration.";
                        await OpenSettingsAsync(false);
                    }
                }
                if (!_closing && _backendStatus != null)
                    StartAutomaticUpdateCheck();
            }
            catch (Exception)
            {
                if (_closing) return;
                SetStatus("Error", Color.Firebrick);
                _activity.Text = "The packaged backend could not be started. Rebuild or repair CourseMirror.";
                SetSyncButtons(false);
            }
        }

        private Task<bool> PollStatusAsync()
        {
            if (_operationRunning || _operationStarting || _closing) return Task.FromResult(false);
            return RefreshStatusAsync(false, true, true);
        }

        private async Task<bool> RefreshStatusAsync(bool updateActivity, bool skipIfBusy, bool suppressFailure)
        {
            if (_backend == null || _closing) return false;
            bool entered = skipIfBusy
                ? await _statusRefreshGate.WaitAsync(0)
                : await WaitForStatusRefreshAsync();
            if (!entered) return false;

            try
            {
                if (_closing) return false;
                BackendStatus status = await _backend.GetStatusAsync();
                if (_closing) return false;
                _backendStatus = status;
                _lastSyncValue.Text = FormatLastSync(_backendStatus.lastSync);

                if (!_operationRunning)
                {
                    if (!String.IsNullOrWhiteSpace(_backendStatus.attention))
                    {
                        SetStatus("Error", Color.Firebrick);
                        if (updateActivity) _activity.Text = _backendStatus.attention;
                    }
                    else if (!String.IsNullOrWhiteSpace(_backendStatus.activeOperation))
                    {
                        SetStatus("Running " + _backendStatus.activeOperation, Color.DarkGoldenrod);
                        if (updateActivity) _activity.Text = "Another CourseMirror operation is currently active.";
                    }
                    else
                    {
                        SetStatus("Ready", Color.DarkGreen);
                        if (updateActivity)
                        {
                            _activity.Text = _backendStatus.configured
                                ? "Ready."
                                : "Setup is not complete. Open Settings to configure CourseMirror.";
                        }
                    }
                }
                UpdateSyncButtons();
                return true;
            }
            catch (Exception)
            {
                if (!_closing && !suppressFailure)
                {
                    SetStatus("Error", Color.Firebrick);
                    _activity.Text = "The packaged backend could not report its status. View Logs for diagnostic information.";
                    SetSyncButtons(false);
                }
                return false;
            }
            finally
            {
                _statusRefreshGate.Release();
            }
        }

        private async Task<bool> WaitForStatusRefreshAsync()
        {
            await _statusRefreshGate.WaitAsync();
            return true;
        }

        private async Task<bool> RunSyncAsync(string mode)
        {
            if (_closing || _operationRunning || _operationStarting || _backend == null) return false;
            _operationStarting = true;
            SetSyncButtons(false);
            bool refreshed = await RefreshStatusAsync(false, false, false);
            if (_closing)
            {
                _operationStarting = false;
                return false;
            }
            if (!refreshed)
            {
                _operationStarting = false;
                UpdateSyncButtons();
                return false;
            }
            if (!String.IsNullOrWhiteSpace(_backendStatus.attention))
            {
                _operationStarting = false;
                SetStatus("Error", Color.Firebrick);
                _activity.Text = _backendStatus.attention;
                UpdateSyncButtons();
                return false;
            }
            if (!String.IsNullOrWhiteSpace(_backendStatus.activeOperation))
            {
                _operationStarting = false;
                SetStatus("Running " + _backendStatus.activeOperation, Color.DarkGoldenrod);
                _activity.Text = "Another CourseMirror operation is currently active.";
                UpdateSyncButtons();
                return false;
            }
            if (!_backendStatus.configured)
            {
                _operationStarting = false;
                _activity.Text = "Setup is not complete. Open Settings to configure CourseMirror.";
                UpdateSyncButtons();
                return false;
            }
            if (!_browserReady)
            {
                _operationStarting = false;
                SetStatus("Browser Required", Color.DarkGoldenrod);
                _activity.Text = "Open Settings to retry detection or choose a compatible Chromium browser.";
                UpdateSyncButtons();
                return false;
            }

            _operationStarting = false;
            _operationRunning = true;
            SetSyncButtons(false);
            string displayMode = mode == "quick" ? "Quick Sync" : "Full Sync";
            SetStatus("Running " + displayMode, Color.DarkGoldenrod);
            _activity.Text = displayMode + " is running. This window will update when it finishes.";

            BackendProcessResult result = null;
            try
            {
                result = await _backend.RunSyncAsync(mode);
                await RefreshStatusAsync(false, false, true);

                if (result.ExitCode == 0)
                {
                    SetStatus("Completed", Color.DarkGreen);
                    _activity.Text = displayMode + " completed successfully.";
                }
                else
                {
                    SetStatus("Error", Color.Firebrick);
                    _activity.Text = String.Format("{0} failed with exit code {1}. Open View Logs for diagnostic information.", displayMode, result.ExitCode);
                    AppendFailureDiagnostic(displayMode, result.ExitCode, result.StandardError);
                }
                AppendSafeActivityLog(displayMode, result.ExitCode);
            }
            catch (Exception)
            {
                SetStatus("Error", Color.Firebrick);
                _activity.Text = displayMode + " could not be started. Open View Logs for diagnostic information.";
                AppendFailureDiagnostic(displayMode, -1, String.Empty);
                AppendSafeActivityLog(displayMode, -1);
            }
            finally
            {
                _operationRunning = false;
                UpdateSyncButtons();
            }
            return result != null && result.ExitCode == 0;
        }

        private async Task<bool> RunRefreshLoginAsync()
        {
            if (_closing || _operationRunning || _operationStarting || _backend == null) return false;
            _operationStarting = true;
            SetSyncButtons(false);
            bool refreshed = await RefreshStatusAsync(false, false, false);
            if (_closing)
            {
                _operationStarting = false;
                return false;
            }
            if (!refreshed)
            {
                _operationStarting = false;
                UpdateSyncButtons();
                return false;
            }
            if (!String.IsNullOrWhiteSpace(_backendStatus.activeOperation))
            {
                _operationStarting = false;
                SetStatus("Running " + _backendStatus.activeOperation, Color.DarkGoldenrod);
                _activity.Text = "Another CourseMirror operation is currently active.";
                UpdateSyncButtons();
                return false;
            }
            if (!_backendStatus.configured)
            {
                _operationStarting = false;
                _activity.Text = "Setup is not complete. Open Settings before refreshing login.";
                UpdateSyncButtons();
                return false;
            }
            if (!_browserReady)
            {
                _operationStarting = false;
                SetStatus("Browser Required", Color.DarkGoldenrod);
                _activity.Text = "Open Settings to retry detection or choose a compatible Chromium browser.";
                UpdateSyncButtons();
                return false;
            }

            _operationStarting = false;
            _operationRunning = true;
            SetSyncButtons(false);
            SetStatus("Running Login Refresh", Color.DarkGoldenrod);
            _activity.Text = "Complete sign-in and any MFA challenge in the browser window.";

            BackendProcessResult completedResult = null;
            try
            {
                BackendProcessResult result = await _backend.RunRefreshLoginAsync();
                completedResult = result;
                await RefreshStatusAsync(false, false, true);
                if (result.ExitCode == 0)
                {
                    SetStatus("Completed", Color.DarkGreen);
                    _activity.Text = "Login refresh completed successfully.";
                }
                else
                {
                    SetStatus("Error", Color.Firebrick);
                    _activity.Text = "Login refresh failed. Open View Logs for diagnostic information.";
                    AppendFailureDiagnostic("Refresh Login", result.ExitCode, result.StandardError);
                }
                AppendSafeActivityLog("Refresh Login", result.ExitCode);
            }
            catch (Exception)
            {
                SetStatus("Error", Color.Firebrick);
                _activity.Text = "Login refresh could not be started. Open View Logs for diagnostic information.";
                AppendFailureDiagnostic("Refresh Login", -1, String.Empty);
                AppendSafeActivityLog("Refresh Login", -1);
            }
            finally
            {
                _operationRunning = false;
                UpdateSyncButtons();
            }
            return completedResult != null && completedResult.ExitCode == 0;
        }

        private async Task OpenSettingsAsync(bool firstRun)
        {
            if (_closing || _operationRunning || _operationStarting || _backend == null) return;
            _settingsButton.Enabled = false;
            try
            {
                bool saved = await _settingsDialog.ShowAsync(this, _backend, firstRun);
                if (_closing) return;
                if (saved)
                {
                    bool refreshed = await RefreshStatusAsync(true, false, false);
                    if (!_closing && refreshed && _backendStatus.configured)
                    {
                        _browserReady = await InspectBrowserForStartupAsync();
                        if (!_browserReady)
                        {
                            SetStatus("Browser Required", Color.DarkGoldenrod);
                            _activity.Text = "Settings were saved, but no compatible Chromium browser is available.";
                        }
                        else if (firstRun)
                        {
                            _activity.Text = "Settings saved. Complete sign-in and any MFA challenge to continue.";
                            bool signedIn = await RunRefreshLoginAsync();
                            if (!_closing && signedIn)
                            {
                                _activity.Text = "Sign-in completed. Running the initial Full Sync.";
                                await RunSyncAsync("full");
                            }
                            else if (!_closing)
                            {
                                _activity.Text = "Settings were saved, but sign-in did not complete. Use Refresh Login when you are ready; the initial Full Sync was not started.";
                            }
                        }
                        else
                        {
                            _activity.Text = String.IsNullOrWhiteSpace(_backendStatus.activeOperation)
                                ? "Settings saved. Ready."
                                : "Settings saved. Another CourseMirror operation is currently active.";
                        }
                    }
                }
                else if (_backendStatus != null && !_backendStatus.configured)
                {
                    SetStatus("Setup Required", Color.DarkGoldenrod);
                    _activity.Text = "Setup was cancelled. Open Settings when you are ready to continue.";
                    UpdateSyncButtons();
                }
            }
            catch (Exception)
            {
                if (_closing) return;
                SetStatus("Error", Color.Firebrick);
                _activity.Text = "Settings could not be opened. View Logs for diagnostic information.";
            }
            finally
            {
                if (!_closing) _settingsButton.Enabled = true;
            }
        }

        private async Task<bool> InspectBrowserForStartupAsync()
        {
            try
            {
                DesktopBrowserSettings browser = await _backend.GetBrowserAsync();
                return browser != null && browser.available;
            }
            catch { return false; }
        }

        private void EnsureUpdateChecker()
        {
            if (_updateChecker != null || _backendStatus == null || String.IsNullOrWhiteSpace(_backendStatus.dataDir)) return;
            _updateChecker = _updateCheckFactory.Create(_backendStatus.dataDir);
        }

        private async void StartAutomaticUpdateCheck()
        {
            if (_automaticUpdateCheckStarted) return;
            _automaticUpdateCheckStarted = true;
            try
            {
                EnsureUpdateChecker();
                if (_updateChecker == null || _closing) return;
                UpdateCheckResult cached = _updateChecker.GetCachedResult();
                if (!_closing && cached != null && cached.Outcome == UpdateCheckOutcome.UpdateAvailable)
                    DisplayUpdateResult(cached, false);
                await CheckForUpdatesAsync(false);
            }
            catch
            {
                // Automatic update checks are intentionally silent and never block startup.
            }
        }

        private async Task CheckForUpdatesAsync(bool manual)
        {
            if (_closing || _updateCheckRunning) return;
            _updateCheckRunning = true;
            _checkUpdatesLink.Enabled = false;
            if (manual)
            {
                _updateMessage.Text = "Checking...";
            }
            try
            {
                EnsureUpdateChecker();
                if (_updateChecker == null)
                {
                    if (manual) _updateMessage.Text = "Unable to check right now.";
                    return;
                }
                UpdateCheckResult result = await _updateChecker.CheckAsync(manual);
                if (_closing) return;
                DisplayUpdateResult(result, manual);
            }
            catch
            {
                if (!_closing && manual)
                {
                    _updateAvailable = false;
                    _trustedReleaseUrl = null;
                    _viewReleaseLink.Visible = false;
                    _updateMessage.Text = "Unable to check right now.";
                }
            }
            finally
            {
                _updateCheckRunning = false;
                if (!_closing) _checkUpdatesLink.Enabled = true;
            }
        }

        private void DisplayUpdateResult(UpdateCheckResult result, bool manual)
        {
            if (_closing || result == null) return;
            if (result.Outcome == UpdateCheckOutcome.UpdateAvailable
                && UpdateCheckService.IsTrustedReleaseUrl(result.ReleaseUrl))
            {
                _updateAvailable = true;
                _trustedReleaseUrl = result.ReleaseUrl;
                _updateMessage.Text = "Version " + result.LatestVersion + " is available.";
                _viewReleaseLink.Visible = true;
                return;
            }
            if (!manual) return;
            _updateAvailable = false;
            _trustedReleaseUrl = null;
            _viewReleaseLink.Visible = false;
            _updateMessage.Text = result.Outcome == UpdateCheckOutcome.UpToDate
                ? "CourseMirror is up to date."
                : "Unable to check right now.";
        }

        private void OpenTrustedRelease()
        {
            if (!UpdateCheckService.IsTrustedReleaseUrl(_trustedReleaseUrl)) return;
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = _trustedReleaseUrl,
                    UseShellExecute = true
                });
            }
            catch
            {
                if (!_closing) _updateMessage.Text = "Windows could not open the release page.";
            }
        }

        private void OpenResolvedDirectory(bool mirror)
        {
            if (_backendStatus == null)
            {
                MessageBox.Show("Runtime paths are not available yet.", "CourseMirror", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            string directory = mirror ? _backendStatus.mirrorDir : _backendStatus.logsDir;
            if (!Directory.Exists(directory))
            {
                string label = mirror ? "mirror" : "logs";
                MessageBox.Show("The " + label + " directory does not exist yet.", "CourseMirror", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = "explorer.exe",
                    Arguments = BackendClient.QuoteWindowsArgument(directory),
                    UseShellExecute = false,
                    CreateNoWindow = true
                });
            }
            catch (Exception)
            {
                MessageBox.Show("Windows could not open that directory.", "CourseMirror", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void AppendSafeActivityLog(string operation, int exitCode)
        {
            if (_backendStatus == null || String.IsNullOrWhiteSpace(_backendStatus.logsDir)) return;
            if (!Directory.Exists(_backendStatus.logsDir)) return;
            try
            {
                string line = String.Format("{0:u} Control panel: {1}; exit code {2}.{3}", DateTime.UtcNow, operation, exitCode, Environment.NewLine);
                File.AppendAllText(Path.Combine(_backendStatus.logsDir, "control-panel.log"), line, Encoding.UTF8);
            }
            catch { }
        }

        private void AppendFailureDiagnostic(string operation, int exitCode, string standardError)
        {
            if (_backendStatus == null || String.IsNullOrWhiteSpace(_backendStatus.logsDir)) return;
            try { BackendFailureLog.Append(_backendStatus.logsDir, operation, exitCode, standardError); } catch { }
        }

        private void UpdateSyncButtons()
        {
            bool enabled = !_operationRunning && !_operationStarting && _browserReady && _backendStatus != null && _backendStatus.configured && String.IsNullOrWhiteSpace(_backendStatus.activeOperation);
            SetSyncButtons(enabled);
        }

        private void SetSyncButtons(bool enabled)
        {
            _quickButton.Enabled = enabled;
            _fullButton.Enabled = enabled;
            _refreshLoginButton.Enabled = enabled;
        }

        private void SetStatus(string text, Color color)
        {
            _statusValue.Text = text;
            _statusValue.ForeColor = color;
        }

        private static string FormatLastSync(string value)
        {
            DateTimeOffset timestamp;
            if (String.IsNullOrWhiteSpace(value) || !DateTimeOffset.TryParse(value, out timestamp)) return "Never";
            return timestamp.ToLocalTime().ToString("g");
        }

        private void OnFormClosing(object sender, FormClosingEventArgs args)
        {
            if (!_operationRunning)
            {
                _closing = true;
                _statusTimer.Stop();
                return;
            }
            args.Cancel = true;
            MessageBox.Show("A sync operation is still running. Keep CourseMirror open until it finishes.", "CourseMirror", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        private void OnFormClosed(object sender, FormClosedEventArgs args)
        {
            _closing = true;
            _statusTimer.Stop();
            _statusTimer.Dispose();
        }
    }
}
