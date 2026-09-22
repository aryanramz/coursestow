using CourseStow.Security;
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace CourseStow.ControlPanel
{
    internal interface ISettingsDialogService
    {
        Task<bool> ShowAsync(IWin32Window owner, IDesktopBackendClient backend, bool firstRun);
    }

    internal sealed class SettingsDialogService : ISettingsDialogService
    {
        public async Task<bool> ShowAsync(IWin32Window owner, IDesktopBackendClient backend, bool firstRun)
        {
            while (true)
            {
                DesktopSettings settings = await backend.GetSettingsAsync();
                settings.browser = await backend.GetBrowserAsync();
                using (var form = new SetupSettingsForm(
                    backend, settings, firstRun, new WindowsFolderPicker(),
                    new CompatibleCredentialStore(new WindowsCredentialStore()), new WindowsTaskSchedulerService(),
                    new WindowsExecutablePicker()))
                {
                    DialogResult result = form.ShowDialog(owner);
                    if (result == DialogResult.Retry) continue;
                    return result == DialogResult.OK;
                }
            }
        }
    }

    internal sealed class SetupSettingsForm : Form
    {
        internal const string EdgeDownloadUrl = "https://www.microsoft.com/edge/download";
        private readonly IDesktopBackendClient _backend;
        private readonly IFolderPicker _folderPicker;
        private readonly IExecutablePicker _executablePicker;
        private readonly ICredentialStore _credentialStore;
        private readonly ITaskSchedulerService _taskScheduler;
        private readonly TextBox _baseUrl = new TextBox();
        private readonly TextBox _mirrorDir = new TextBox();
        private readonly CheckBox _driveEnabled = new CheckBox();
        private readonly TextBox _driveDestination = new TextBox();
        private readonly Button _mirrorBrowse = new Button();
        private readonly Button _driveBrowse = new Button();
        private readonly Button _save = new Button();
        private readonly Button _cancel = new Button();
        private readonly Label _validation = new Label();
        private readonly GroupBox _authenticationGroup = new GroupBox();
        private readonly GroupBox _browserGroup = new GroupBox();
        private readonly Label _browserStatus = new Label();
        private readonly Button _retryBrowser = new Button();
        private readonly Button _chooseBrowser = new Button();
        private readonly Button _automaticBrowser = new Button();
        private readonly LinkLabel _edgeDownload = new LinkLabel();
        private readonly Button _importSource = new Button();
        private readonly GroupBox _driveGroup = new GroupBox();
        private readonly GroupBox _scheduleGroup = new GroupBox();
        private readonly CheckBox _scheduleEnabled = new CheckBox();
        private readonly NumericUpDown _intervalHours = new NumericUpDown();
        private readonly NumericUpDown _fullIntervalDays = new NumericUpDown();
        private readonly Label _scheduleHint = new Label();
        private readonly CheckBox _automaticLoginEnabled = new CheckBox();
        private readonly TextBox _username = new TextBox();
        private readonly TextBox _password = new TextBox();
        private readonly Button _removeCredential = new Button();
        private readonly Label _credentialHint = new Label();
        private readonly bool _mirrorOverrideActive;
        private readonly bool _firstRun;
        private readonly bool _importSourceAvailable;
        private string _manualBrowserPath = String.Empty;
        private string _storedCredentialUsername = String.Empty;
        private bool _credentialExists;
        private bool _credentialStateInspected;
        private bool _credentialInspectionFailed;
        private bool _deleteCredentialRequested;
        private bool _saving;
        private DesktopScheduleSettings _committedSchedule;

        internal SetupSettingsForm(IDesktopBackendClient backend, DesktopSettings settings, bool firstRun, IFolderPicker folderPicker)
            : this(backend, settings, firstRun, folderPicker, new WindowsCredentialStore(), new PassiveTaskSchedulerService(), new WindowsExecutablePicker())
        {
        }

        internal SetupSettingsForm(IDesktopBackendClient backend, DesktopSettings settings, bool firstRun, IFolderPicker folderPicker, ICredentialStore credentialStore)
            : this(backend, settings, firstRun, folderPicker, credentialStore, new PassiveTaskSchedulerService(), new WindowsExecutablePicker())
        {
        }

        internal SetupSettingsForm(
            IDesktopBackendClient backend,
            DesktopSettings settings,
            bool firstRun,
            IFolderPicker folderPicker,
            ICredentialStore credentialStore,
            ITaskSchedulerService taskScheduler)
            : this(backend, settings, firstRun, folderPicker, credentialStore, taskScheduler, new WindowsExecutablePicker())
        {
        }

        internal SetupSettingsForm(
            IDesktopBackendClient backend,
            DesktopSettings settings,
            bool firstRun,
            IFolderPicker folderPicker,
            ICredentialStore credentialStore,
            ITaskSchedulerService taskScheduler,
            IExecutablePicker executablePicker)
        {
            if (backend == null) throw new ArgumentNullException("backend");
            if (settings == null) throw new ArgumentNullException("settings");
            _backend = backend;
            _folderPicker = folderPicker ?? new WindowsFolderPicker();
            _executablePicker = executablePicker ?? new WindowsExecutablePicker();
            if (credentialStore == null) throw new ArgumentNullException("credentialStore");
            _credentialStore = credentialStore;
            if (taskScheduler == null) throw new ArgumentNullException("taskScheduler");
            _taskScheduler = taskScheduler;
            _mirrorOverrideActive = settings.mirrorOverrideActive;
            _firstRun = firstRun;
            _importSourceAvailable = firstRun && settings.mayImportLegacySetup;
            _committedSchedule = CopySchedule(settings.schedule);

            Text = firstRun ? "Set up CourseStow" : "CourseStow Settings";
            StartPosition = FormStartPosition.CenterParent;
            ClientSize = new Size(610, 700);
            MinimumSize = new Size(626, 620);
            MaximizeBox = false;
            MinimizeBox = false;
            ShowInTaskbar = false;
            Font = new Font("Segoe UI", 9F, FontStyle.Regular, GraphicsUnit.Point);
            AutoScaleMode = AutoScaleMode.Dpi;
            AutoScroll = true;

            var title = new Label
            {
                AutoSize = true,
                Text = firstRun ? "Set up CourseStow" : "Settings",
                Font = new Font("Segoe UI Semibold", 16F, FontStyle.Bold, GraphicsUnit.Point),
                ForeColor = Color.FromArgb(34, 54, 74),
                Location = new Point(22, 18)
            };
            var intro = new Label
            {
                AutoSize = true,
                Text = firstRun
                    ? "Choose your Brightspace site and where course files should be stored."
                    : "Update the Brightspace site and file locations used by this application.",
                Location = new Point(25, 55)
            };

            var urlLabel = CreateLabel("Brightspace URL", 25, 88);
            _baseUrl.Location = new Point(25, 109);
            _baseUrl.Size = new Size(540, 24);
            _baseUrl.Text = settings.baseUrl ?? String.Empty;
            _baseUrl.TabIndex = 0;
            _baseUrl.TextChanged += delegate { UpdateAuthenticationControls(); };

            var mirrorLabel = CreateLabel("Mirror folder", 25, 148);
            _mirrorDir.Location = new Point(25, 169);
            _mirrorDir.Size = new Size(447, 24);
            _mirrorDir.Text = InitialMirrorPath(settings, firstRun);
            _mirrorDir.ReadOnly = _mirrorOverrideActive;
            _mirrorDir.TabIndex = 1;
            ConfigureBrowse(_mirrorBrowse, 482, 167, 2);
            _mirrorBrowse.Enabled = !_mirrorOverrideActive;
            _mirrorBrowse.Click += delegate
            {
                string selected = _folderPicker.SelectFolder(this, "Choose the Brightspace mirror folder.", _mirrorDir.Text);
                if (!String.IsNullOrWhiteSpace(selected)) _mirrorDir.Text = Path.GetFullPath(selected);
            };

            var overrideLabel = new Label
            {
                AutoSize = true,
                ForeColor = Color.DarkGoldenrod,
                Location = new Point(25, 197),
                Text = _mirrorOverrideActive
                    ? "An administrator/environment override controls the effective mirror folder."
                    : "Course files only are stored here. Private app data remains separate."
            };

            ConfigureBrowserGroup(settings);

            _importSource.Text = "Import settings from an existing CourseStow setup...";
            _importSource.Location = new Point(25, 365);
            _importSource.Size = new Size(330, 30);
            _importSource.Visible = _importSourceAvailable;
            _importSource.Click += async delegate { await ImportSourceAsync(); };

            ConfigureAuthenticationGroup(settings);

            _driveGroup.Text = "Google Drive publishing (optional)";
            _driveGroup.Location = new Point(25, 534);
            _driveGroup.Size = new Size(540, 105);
            _driveEnabled.AutoSize = true;
            _driveEnabled.Location = new Point(14, 24);
            _driveEnabled.Text = "Publish mirror to Google Drive";
            _driveEnabled.Checked = settings.drive != null && settings.drive.enabled;
            _driveEnabled.TabIndex = 7;
            _driveEnabled.CheckedChanged += delegate { UpdateDriveControls(); };
            _driveDestination.Location = new Point(14, 59);
            _driveDestination.Size = new Size(425, 24);
            _driveDestination.Text = settings.drive == null ? String.Empty : (settings.drive.destination ?? String.Empty);
            _driveDestination.TabIndex = 8;
            ConfigureBrowse(_driveBrowse, 449, 57, 9);
            _driveBrowse.Click += delegate
            {
                string selected = _folderPicker.SelectFolder(this, "Choose a Google Drive for desktop destination.", _driveDestination.Text);
                if (!String.IsNullOrWhiteSpace(selected)) _driveDestination.Text = Path.GetFullPath(selected);
            };
            _driveGroup.Controls.AddRange(new Control[] { _driveEnabled, _driveDestination, _driveBrowse });

            ConfigureScheduleGroup(settings);

            _validation.Location = new Point(25, 788);
            _validation.Size = new Size(365, 58);
            _validation.ForeColor = Color.Firebrick;

            _save.Text = firstRun ? "Save && Sign In" : "Save";
            _save.Location = new Point(400, 817);
            _save.Size = new Size(78, 32);
            _save.TabIndex = 10;
            _save.Click += async delegate { await SaveAsync(null, true); };
            _cancel.Text = "Cancel";
            _cancel.Location = new Point(487, 817);
            _cancel.Size = new Size(78, 32);
            _cancel.TabIndex = 11;
            _cancel.DialogResult = DialogResult.Cancel;

            AcceptButton = _save;
            CancelButton = _cancel;
            FormClosing += delegate(object sender, FormClosingEventArgs args)
            {
                if (!_saving)
                {
                    ClearPasswordInput();
                    return;
                }
                args.Cancel = true;
                _validation.Text = "Wait for the settings operation to finish.";
            };
            Controls.AddRange(new Control[] {
                title, intro, urlLabel, _baseUrl, mirrorLabel, _mirrorDir, _mirrorBrowse,
                overrideLabel, _browserGroup, _importSource, _authenticationGroup, _driveGroup, _scheduleGroup, _validation, _save, _cancel
            });
            UpdateDriveControls();
            UpdateAuthenticationControls();
        }

        internal static string SuggestedFirstRunMirror()
        {
            string documents = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
            return Path.GetFullPath(Path.Combine(documents, "CourseStow"));
        }

        internal SettingsSaveRequest RequestForSelfTest()
        {
            return BuildRequest(null);
        }

        internal bool MirrorEditableForSelfTest { get { return !_mirrorDir.ReadOnly && _mirrorBrowse.Enabled; } }

        internal bool AuthenticationVisibleForSelfTest { get { return SupportsStonyBrookAuthentication(_baseUrl.Text.Trim()); } }

        internal bool CredentialExistsForSelfTest { get { return _credentialExists; } }

        internal string PasswordForSelfTest { get { return _password.Text; } }

        internal void SetAuthenticationForSelfTest(bool enabled, string username, string password)
        {
            _automaticLoginEnabled.Checked = enabled;
            _username.Text = username ?? String.Empty;
            _password.Text = password ?? String.Empty;
        }

        internal void RemoveCredentialForSelfTest()
        {
            MarkCredentialForRemoval();
        }

        internal string ValidationTextForSelfTest { get { return _validation.Text; } }

        internal string ScheduleHintForSelfTest { get { return _scheduleHint.Text; } }

        internal string BrowserStatusForSelfTest { get { return _browserStatus.Text; } }

        internal string BrowserPathForSelfTest { get { return _manualBrowserPath; } }

        internal bool ImportVisibleForSelfTest { get { return _importSourceAvailable; } }

        internal Task RetryBrowserForSelfTestAsync() { return DetectAutomaticBrowserAsync(); }

        internal Task<bool> ChooseBrowserForSelfTestAsync(string executablePath) { return ValidateManualBrowserAsync(executablePath); }

        internal Task UseAutomaticBrowserForSelfTestAsync()
        {
            _manualBrowserPath = String.Empty;
            return DetectAutomaticBrowserAsync();
        }

        internal void SetScheduleForSelfTest(bool enabled, int intervalHours, int fullIntervalDays)
        {
            _scheduleEnabled.Checked = enabled;
            _intervalHours.Value = intervalHours;
            _fullIntervalDays.Value = fullIntervalDays;
        }

        internal Task<bool> SaveForSelfTestAsync(string mirrorAction)
        {
            return SaveAsync(mirrorAction, false);
        }

        internal void CancelForSelfTest()
        {
            DialogResult = DialogResult.Cancel;
        }

        private static string InitialMirrorPath(DesktopSettings settings, bool firstRun)
        {
            if (firstRun && settings.maySuggestFirstRunMirror && !settings.mirrorOverrideActive)
                return SuggestedFirstRunMirror();
            return settings.mirrorDir ?? String.Empty;
        }

        internal static string MirrorRecoveryMessage(SettingsSaveResponse response)
        {
            MirrorRecoveryInformation recovery = response == null ? null : response.recovery;
            if (recovery == null || !recovery.required)
                return "Automatic mirror recovery did not complete. Manual recovery may be required.";

            string message =
                "Automatic mirror recovery did not complete. Manual recovery may be required.\n\n" +
                "Old mirror: " + (recovery.oldMirrorDir ?? String.Empty) + "\n" +
                "New mirror: " + (recovery.newMirrorDir ?? String.Empty);
            if (recovery.configRetainedOldLocation)
                message += "\n\nSettings still point to the old mirror location.";
            return message;
        }

        private void ConfigureBrowserGroup(DesktopSettings settings)
        {
            _browserGroup.Text = "Compatible Chromium browser";
            _browserGroup.Location = new Point(25, 224);
            _browserGroup.Size = new Size(540, 132);

            _browserStatus.AutoEllipsis = true;
            _browserStatus.Location = new Point(14, 23);
            _browserStatus.Size = new Size(508, 34);

            _retryBrowser.Text = "Retry";
            _retryBrowser.Location = new Point(14, 76);
            _retryBrowser.Size = new Size(72, 30);
            _retryBrowser.Click += async delegate { await DetectAutomaticBrowserAsync(); };

            _chooseBrowser.Text = "Choose browser executable...";
            _chooseBrowser.Location = new Point(96, 76);
            _chooseBrowser.Size = new Size(181, 30);
            _chooseBrowser.Click += async delegate
            {
                string selected = _executablePicker.SelectExecutable(this, _manualBrowserPath);
                if (!String.IsNullOrWhiteSpace(selected)) await ValidateManualBrowserAsync(selected);
            };

            _automaticBrowser.Text = "Use automatic";
            _automaticBrowser.Location = new Point(287, 76);
            _automaticBrowser.Size = new Size(108, 30);
            _automaticBrowser.Click += async delegate
            {
                _manualBrowserPath = String.Empty;
                await DetectAutomaticBrowserAsync();
            };

            _edgeDownload.AutoSize = true;
            _edgeDownload.Text = "Get Microsoft Edge";
            _edgeDownload.Location = new Point(407, 84);
            _edgeDownload.LinkClicked += delegate { OpenEdgeDownloadPage(); };

            _browserGroup.Controls.AddRange(new Control[] {
                _browserStatus, _retryBrowser, _chooseBrowser, _automaticBrowser, _edgeDownload
            });
            DesktopBrowserSettings browser = settings.browser;
            if (browser != null && browser.configuredManually)
                _manualBrowserPath = browser.executablePath ?? String.Empty;
            DisplayBrowser(browser);
        }

        private void DisplayBrowser(DesktopBrowserSettings browser)
        {
            if (browser != null && browser.available)
            {
                string support = String.Equals(browser.supportLevel, "official", StringComparison.Ordinal)
                    ? "officially tested"
                    : (String.Equals(browser.supportLevel, "best-effort", StringComparison.Ordinal) ? "best-effort compatible" : "custom compatible");
                _browserStatus.ForeColor = Color.DarkGreen;
                _browserStatus.Text = (browser.configuredManually ? "Manual: " : "Detected: ")
                    + (browser.displayName ?? "Chromium browser") + " (" + support + ")";
            }
            else
            {
                _browserStatus.ForeColor = Color.Firebrick;
                _browserStatus.Text = "No compatible Chromium browser is available. Retry, choose an executable, or install Microsoft Edge.";
            }
            _automaticBrowser.Enabled = !_saving && !String.IsNullOrWhiteSpace(_manualBrowserPath);
        }

        private async Task DetectAutomaticBrowserAsync()
        {
            if (_saving) return;
            _retryBrowser.Enabled = false;
            _validation.Text = "Checking browser compatibility...";
            try
            {
                DesktopBrowserSettings browser = await _backend.ProbeBrowserAsync(String.Empty);
                if (String.IsNullOrWhiteSpace(_manualBrowserPath)) DisplayBrowser(browser);
                _validation.Text = browser.available ? String.Empty : "Install a supported Chromium browser or choose a compatible executable.";
            }
            catch
            {
                _validation.Text = "Browser detection could not complete. Retry or choose a browser executable.";
            }
            finally { if (!IsDisposed) _retryBrowser.Enabled = true; }
        }

        private async Task<bool> ValidateManualBrowserAsync(string executablePath)
        {
            if (_saving) return false;
            _chooseBrowser.Enabled = false;
            _validation.Text = "Checking browser compatibility...";
            try
            {
                DesktopBrowserSettings browser = await _backend.ProbeBrowserAsync(executablePath);
                if (!browser.available)
                {
                    DisplayBrowser(browser);
                    _validation.Text = "The selected file is not a compatible Chromium browser.";
                    return false;
                }
                _manualBrowserPath = Path.GetFullPath(executablePath);
                browser.configuredManually = true;
                browser.executablePath = _manualBrowserPath;
                DisplayBrowser(browser);
                _validation.Text = String.Empty;
                return true;
            }
            catch
            {
                _validation.Text = "The selected file could not be validated as a compatible Chromium browser.";
                return false;
            }
            finally { if (!IsDisposed) _chooseBrowser.Enabled = true; }
        }

        private async Task ImportSourceAsync()
        {
            if (_saving || !_firstRun) return;
            string selected = _folderPicker.SelectFolder(this, "Choose an existing CourseStow or Brightspace Sync setup folder.", String.Empty);
            if (String.IsNullOrWhiteSpace(selected)) return;
            _saving = true;
            SetInputsEnabled(false);
            _validation.Text = "Importing supported settings and private application state...";
            try
            {
                SourceImportResponse response = await _backend.ImportSourceAsync(Path.GetFullPath(selected));
                if (response != null && response.ok)
                {
                    _saving = false;
                    DialogResult = DialogResult.Retry;
                    Close();
                    return;
                }
                SettingsValidationError error = response == null || response.errors == null ? null : response.errors.FirstOrDefault();
                _validation.Text = error == null ? "The selected setup could not be imported safely." : error.message;
            }
            catch
            {
                _validation.Text = "The selected setup could not be imported safely. The original setup was not changed.";
            }
            finally
            {
                _saving = false;
                if (!IsDisposed) SetInputsEnabled(true);
            }
        }

        private void OpenEdgeDownloadPage()
        {
            try
            {
                Process.Start(new ProcessStartInfo { FileName = EdgeDownloadUrl, UseShellExecute = true });
            }
            catch { _validation.Text = "Windows could not open the Microsoft Edge download page."; }
        }

        private void ConfigureAuthenticationGroup(DesktopSettings settings)
        {
            _authenticationGroup.Text = "Stony Brook University sign-in (optional)";
            _authenticationGroup.Location = new Point(25, 229);
            _authenticationGroup.Size = new Size(540, 145);

            _automaticLoginEnabled.AutoSize = true;
            _automaticLoginEnabled.Location = new Point(14, 23);
            _automaticLoginEnabled.Text = "Automatically sign me in when my session expires";
            _automaticLoginEnabled.TabIndex = 3;
            _automaticLoginEnabled.Checked = settings.authentication != null && settings.authentication.automaticLoginEnabled;
            _automaticLoginEnabled.CheckedChanged += delegate { UpdateAuthenticationControls(); };

            var usernameLabel = CreateLabel("Username", 14, 55);
            _username.Location = new Point(83, 52);
            _username.Size = new Size(176, 24);
            _username.TabIndex = 4;

            var passwordLabel = CreateLabel("Password", 275, 55);
            _password.Location = new Point(343, 52);
            _password.Size = new Size(178, 24);
            _password.UseSystemPasswordChar = true;
            _password.TabIndex = 5;

            _credentialHint.AutoSize = true;
            _credentialHint.Location = new Point(83, 82);
            _credentialHint.ForeColor = SystemColors.GrayText;
            _credentialHint.Text = "Stored securely by Windows.";

            _removeCredential.Text = "Remove saved sign-in";
            _removeCredential.Location = new Point(369, 102);
            _removeCredential.Size = new Size(152, 29);
            _removeCredential.TabIndex = 6;
            _removeCredential.Click += delegate { MarkCredentialForRemoval(); };

            _authenticationGroup.Controls.AddRange(new Control[] {
                _automaticLoginEnabled, usernameLabel, _username, passwordLabel, _password,
                _credentialHint, _removeCredential
            });

            bool backendSupportsAuthentication = settings.authentication != null
                && settings.authentication.supported
                && String.Equals(settings.authentication.institution, "stony-brook", StringComparison.Ordinal);
            if (backendSupportsAuthentication)
                InspectCredentialState();
        }

        private static bool SupportsStonyBrookAuthentication(string baseUrl)
        {
            Uri uri;
            return Uri.TryCreate(baseUrl, UriKind.Absolute, out uri)
                && String.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)
                && String.Equals(uri.Host, "mycourses.stonybrook.edu", StringComparison.OrdinalIgnoreCase)
                && String.IsNullOrEmpty(uri.UserInfo);
        }

        private void UpdateAuthenticationControls()
        {
            bool supported = SupportsStonyBrookAuthentication(_baseUrl.Text.Trim());
            if (supported) InspectCredentialState();
            _authenticationGroup.Visible = supported;
            ApplyAuthenticationLayout(supported);
            bool enabled = supported && _automaticLoginEnabled.Checked && !_saving;
            _username.Enabled = enabled;
            _password.Enabled = enabled;
            _removeCredential.Enabled = supported && _credentialExists && !_deleteCredentialRequested && !_saving;
            if (_credentialInspectionFailed)
                _credentialHint.Text = "Windows could not inspect the saved sign-in. Enter a replacement to continue.";
            else if (_deleteCredentialRequested || (_credentialExists && !_automaticLoginEnabled.Checked))
                _credentialHint.Text = "Saved sign-in will be removed when you save.";
            else if (_credentialExists)
                _credentialHint.Text = "Stored securely by Windows. Leave password blank to keep it.";
            else
                _credentialHint.Text = "Stored securely by Windows.";
        }

        private void ApplyAuthenticationLayout(bool supported)
        {
            int importOffset = _importSourceAvailable ? 40 : 0;
            int authenticationTop = 374 + importOffset;
            int driveTop = (supported ? 534 : 374) + importOffset;
            int scheduleTop = (supported ? 649 : 489) + importOffset;
            int validationTop = (supported ? 788 : 628) + importOffset;
            int buttonTop = (supported ? 817 : 657) + importOffset;
            int contentHeight = buttonTop + 52;
            _authenticationGroup.Location = new Point(25, authenticationTop);
            _driveGroup.Location = new Point(25, driveTop);
            _scheduleGroup.Location = new Point(25, scheduleTop);
            _validation.Location = new Point(25, validationTop);
            _save.Location = new Point(400, buttonTop);
            _cancel.Location = new Point(487, buttonTop);
            AutoScrollMinSize = new Size(0, contentHeight);
        }

        private void InspectCredentialState()
        {
            if (_credentialStateInspected) return;
            _credentialStateInspected = true;
            try
            {
                _storedCredentialUsername = _credentialStore.ReadUsername(WindowsCredentialStore.StonyBrookTarget) ?? String.Empty;
                _credentialExists = !String.IsNullOrWhiteSpace(_storedCredentialUsername);
                _username.Text = _storedCredentialUsername;
            }
            catch (CredentialStoreException)
            {
                _credentialInspectionFailed = true;
                _validation.Text = "Windows could not inspect the saved sign-in. Enter a replacement, or retry after Windows Credential Manager is available.";
            }
        }

        private void MarkCredentialForRemoval()
        {
            _deleteCredentialRequested = true;
            _automaticLoginEnabled.Checked = false;
            _username.Text = String.Empty;
            ClearPasswordInput();
            UpdateAuthenticationControls();
        }

        private void ClearPasswordInput()
        {
            _password.Text = String.Empty;
        }

        private static Label CreateLabel(string text, int x, int y)
        {
            return new Label { AutoSize = true, Text = text, Location = new Point(x, y) };
        }

        private static void ConfigureBrowse(Button button, int x, int y, int tabIndex)
        {
            button.Text = "Browse...";
            button.Location = new Point(x, y);
            button.Size = new Size(83, 28);
            button.TabIndex = tabIndex;
            button.UseVisualStyleBackColor = true;
        }

        private void UpdateDriveControls()
        {
            _driveDestination.Enabled = _driveEnabled.Checked;
            _driveBrowse.Enabled = _driveEnabled.Checked;
        }

        private void ConfigureScheduleGroup(DesktopSettings settings)
        {
            DesktopScheduleSettings schedule = _committedSchedule;
            _scheduleGroup.Text = "Automatic sync (optional)";
            _scheduleGroup.Location = new Point(25, 504);
            _scheduleGroup.Size = new Size(540, 129);

            _scheduleEnabled.AutoSize = true;
            _scheduleEnabled.Location = new Point(14, 22);
            _scheduleEnabled.Text = "Run CourseStow automatically while I am signed in";
            _scheduleEnabled.Checked = schedule.enabled;
            _scheduleEnabled.CheckedChanged += delegate { UpdateScheduleControls(); };

            var everyLabel = CreateLabel("Run every", 14, 54);
            _intervalHours.Minimum = 1;
            _intervalHours.Maximum = 24;
            _intervalHours.Value = Math.Min(24, Math.Max(1, schedule.intervalHours));
            _intervalHours.Location = new Point(81, 51);
            _intervalHours.Size = new Size(55, 24);
            var hoursLabel = CreateLabel("hour(s)", 143, 54);

            var fullLabel = CreateLabel("Run a Full Sync at least every", 222, 54);
            _fullIntervalDays.Minimum = 1;
            _fullIntervalDays.Maximum = 30;
            _fullIntervalDays.Value = Math.Min(30, Math.Max(1, schedule.fullIntervalDays));
            _fullIntervalDays.Location = new Point(415, 51);
            _fullIntervalDays.Size = new Size(50, 24);
            var daysLabel = CreateLabel("day(s)", 471, 54);

            _scheduleHint.AutoSize = false;
            _scheduleHint.Location = new Point(14, 84);
            _scheduleHint.Size = new Size(510, 36);
            _scheduleHint.ForeColor = SystemColors.GrayText;
            _scheduleGroup.Controls.AddRange(new Control[] {
                _scheduleEnabled, everyLabel, _intervalHours, hoursLabel,
                fullLabel, _fullIntervalDays, daysLabel, _scheduleHint
            });
            RefreshScheduleHint(schedule);
            UpdateScheduleControls();
        }

        private ScheduledTaskRequest CurrentTaskRequest()
        {
            return new ScheduledTaskRequest
            {
                Enabled = _scheduleEnabled.Checked,
                IntervalHours = Decimal.ToInt32(_intervalHours.Value),
                ExecutablePath = Application.ExecutablePath
            };
        }

        private static DesktopScheduleSettings CopySchedule(DesktopScheduleSettings schedule)
        {
            schedule = schedule ?? new DesktopScheduleSettings
            {
                enabled = false,
                intervalHours = 6,
                fullIntervalDays = 7
            };
            return new DesktopScheduleSettings
            {
                enabled = schedule.enabled,
                intervalHours = schedule.intervalHours,
                fullIntervalDays = schedule.fullIntervalDays
            };
        }

        private string TryReconcileOptionalDisabledTask(
            out ScheduledTaskSnapshot snapshot,
            out bool mutationAttempted)
        {
            snapshot = null;
            mutationAttempted = false;
            ScheduledTaskRequest request = CurrentTaskRequest();
            try
            {
                ScheduledTaskStatus status = _taskScheduler.Inspect(request);
                if (!status.Exists) return null;
                snapshot = _taskScheduler.Capture();
                mutationAttempted = true;
                _taskScheduler.Apply(request);
                return null;
            }
            catch (TaskSchedulerOperationException)
            {
                bool restored = TryRollbackTaskChange(snapshot, mutationAttempted);
                snapshot = null;
                mutationAttempted = false;
                return restored
                    ? "Settings can be saved, but Windows scheduling is unavailable. Automatic sync remains off; reopen Settings later to reconcile any stale scheduled task."
                    : "Settings can be saved with automatic sync off, but Windows could not restore or reconcile the stale scheduled task. Manual scheduling review is required.";
            }
        }

        private void RefreshScheduleHint(DesktopScheduleSettings schedule)
        {
            try
            {
                ScheduledTaskStatus status = _taskScheduler.Inspect(new ScheduledTaskRequest
                {
                    Enabled = schedule.enabled,
                    IntervalHours = schedule.intervalHours,
                    ExecutablePath = Application.ExecutablePath
                });
                if (schedule.enabled && !status.Exists)
                    _scheduleHint.Text = "The Windows scheduled task is missing. Saving will repair it.";
                else if (status.NeedsRepair || (!schedule.enabled && status.Exists))
                    _scheduleHint.Text = "The Windows scheduled task does not match these settings. Saving will reconcile it.";
                else if (schedule.enabled && (status.NextRunTime.HasValue || status.LastRunTime.HasValue))
                {
                    string next = status.NextRunTime.HasValue ? status.NextRunTime.Value.ToString("g") : "not currently available";
                    string last = status.LastRunTime.HasValue
                        ? status.LastRunTime.Value.ToString("g") + " (result " + status.LastTaskResult + ")"
                        : "never";
                    _scheduleHint.Text = "Next: " + next + ".  Last: " + last + ".";
                }
                else
                    _scheduleHint.Text = schedule.enabled ? "Windows scheduling is ready." : "Automatic sync is off by default.";
            }
            catch (TaskSchedulerOperationException)
            {
                _scheduleHint.Text = "Windows scheduling could not be inspected. Saving will retry safely.";
            }
        }

        private void UpdateScheduleControls()
        {
            bool enabled = _scheduleEnabled.Checked && !_saving;
            _intervalHours.Enabled = enabled;
            _fullIntervalDays.Enabled = enabled;
        }

        private SettingsSaveRequest BuildRequest(string mirrorAction)
        {
            bool supportedAuthentication = SupportsStonyBrookAuthentication(_baseUrl.Text.Trim());
            return new SettingsSaveRequest
            {
                schemaVersion = 1,
                baseUrl = _baseUrl.Text.Trim(),
                mirrorDir = _mirrorDir.Text.Trim(),
                drive = new DesktopDriveSettings
                {
                    enabled = _driveEnabled.Checked,
                    destination = _driveDestination.Text.Trim()
                },
                authentication = new DesktopAuthenticationSettings
                {
                    supported = supportedAuthentication,
                    institution = supportedAuthentication ? "stony-brook" : String.Empty,
                    automaticLoginEnabled = supportedAuthentication && _automaticLoginEnabled.Checked
                },
                schedule = new DesktopScheduleSettings
                {
                    enabled = _scheduleEnabled.Checked,
                    intervalHours = Decimal.ToInt32(_intervalHours.Value),
                    fullIntervalDays = Decimal.ToInt32(_fullIntervalDays.Value)
                },
                browser = new DesktopBrowserSettings
                {
                    schemaVersion = 1,
                    engine = "chromium",
                    executablePath = _manualBrowserPath,
                    configuredManually = !String.IsNullOrWhiteSpace(_manualBrowserPath)
                },
                mirrorAction = mirrorAction
            };
        }

        private bool TryApplyCredentialChange(SettingsSaveRequest request, out CredentialRecord previousCredential, out bool changed)
        {
            previousCredential = null;
            changed = false;
            bool automatic = request.authentication != null && request.authentication.automaticLoginEnabled;
            string username = _username.Text.Trim();
            string password = _password.Text;

            if (automatic)
            {
                if (String.IsNullOrWhiteSpace(username))
                {
                    _validation.Text = "Enter the Stony Brook username to enable automatic sign-in.";
                    return false;
                }
                if (String.IsNullOrEmpty(password))
                {
                    bool canKeepExisting = _credentialExists
                        && !_deleteCredentialRequested
                        && String.Equals(username, _storedCredentialUsername, StringComparison.OrdinalIgnoreCase);
                    if (!canKeepExisting)
                    {
                        _validation.Text = "Enter the Stony Brook password. Existing passwords are never displayed.";
                        return false;
                    }
                    return true;
                }

                previousCredential = _credentialStore.Read(WindowsCredentialStore.StonyBrookTarget);
                _credentialStore.Write(WindowsCredentialStore.StonyBrookTarget, username, password);
                changed = true;
                return true;
            }

            if (_credentialExists || _deleteCredentialRequested)
            {
                previousCredential = _credentialStore.Read(WindowsCredentialStore.StonyBrookTarget);
                _credentialStore.Delete(WindowsCredentialStore.StonyBrookTarget);
                changed = true;
            }
            return true;
        }

        private bool TryRollbackCredentialChange(CredentialRecord previousCredential, bool changed)
        {
            if (!changed) return true;
            try
            {
                if (previousCredential == null)
                {
                    _credentialStore.Delete(WindowsCredentialStore.StonyBrookTarget);
                }
                else
                {
                    string priorPassword = new String(previousCredential.Password);
                    try
                    {
                        _credentialStore.Write(WindowsCredentialStore.StonyBrookTarget, previousCredential.Username, priorPassword);
                    }
                    finally { priorPassword = String.Empty; }
                }
                return true;
            }
            catch (CredentialStoreException)
            {
                _validation.Text = "Settings were not saved, and Windows could not restore the previous saved sign-in. The saved sign-in may require manual review before retrying.";
                return false;
            }
        }

        private bool TryRollbackTaskChange(ScheduledTaskSnapshot snapshot, bool mutationAttempted)
        {
            if (!mutationAttempted || snapshot == null) return true;
            try
            {
                _taskScheduler.Restore(snapshot);
                return true;
            }
            catch (TaskSchedulerOperationException)
            {
                return false;
            }
        }

        private bool TryRollbackExternalChanges(
            CredentialRecord previousCredential,
            bool credentialChanged,
            ScheduledTaskSnapshot taskSnapshot,
            bool taskMutationAttempted)
        {
            bool taskRestored = TryRollbackTaskChange(taskSnapshot, taskMutationAttempted);
            bool credentialRestored = TryRollbackCredentialChange(previousCredential, credentialChanged);
            if (taskRestored && credentialRestored) return true;

            if (!taskRestored && !credentialRestored)
                _validation.Text = "Settings were not saved, and Windows could not restore the previous scheduled task or saved sign-in. Both require manual review before retrying.";
            else if (!taskRestored)
                _validation.Text = "Settings were not saved, and Windows could not restore the previous scheduled task. Automatic sync requires manual review before retrying.";
            return false;
        }

        private void CommitCredentialState(SettingsSaveRequest request)
        {
            bool automatic = request.authentication != null && request.authentication.automaticLoginEnabled;
            if (automatic)
            {
                _storedCredentialUsername = _username.Text.Trim();
                _credentialExists = true;
            }
            else
            {
                _storedCredentialUsername = String.Empty;
                _credentialExists = false;
                _username.Text = String.Empty;
            }
            _deleteCredentialRequested = false;
            _credentialInspectionFailed = false;
        }

        private async Task<bool> SaveAsync(string mirrorAction, bool interactive)
        {
            if (_saving) return false;
            _saving = true;
            SetInputsEnabled(false);
            _validation.Text = "Saving...";
            CredentialRecord previousCredential = null;
            bool credentialChanged = false;
            bool backendSaveSucceeded = false;
            ScheduledTaskSnapshot taskSnapshot = null;
            bool taskMutationAttempted = false;
            SettingsSaveRequest request = BuildRequest(mirrorAction);
            string schedulingWarning = null;
            try
            {
                if (!TryApplyCredentialChange(request, out previousCredential, out credentialChanged)) return false;
                request.authentication.retryRequested = credentialChanged;
                bool schedulerRequired = _committedSchedule.enabled || request.schedule.enabled;
                if (schedulerRequired)
                {
                    taskSnapshot = _taskScheduler.Capture();
                    taskMutationAttempted = true;
                    _taskScheduler.Apply(CurrentTaskRequest());
                }
                else
                {
                    schedulingWarning = TryReconcileOptionalDisabledTask(
                        out taskSnapshot, out taskMutationAttempted);
                }
                SettingsSaveResponse response = await _backend.SaveSettingsAsync(request);
                if (response == null) throw new InvalidDataException("The settings backend returned no response.");
                if (response.ok)
                {
                    backendSaveSucceeded = true;
                    CommitCredentialState(request);
                    _committedSchedule = CopySchedule(request.schedule);
                    RefreshScheduleHint(request.schedule);
                    if (!String.IsNullOrWhiteSpace(schedulingWarning))
                    {
                        _scheduleHint.Text = schedulingWarning;
                        _validation.Text = schedulingWarning;
                        if (interactive)
                        {
                            MessageBox.Show(
                                this,
                                schedulingWarning,
                                "Automatic sync requires review",
                                MessageBoxButtons.OK,
                                MessageBoxIcon.Warning);
                        }
                    }
                    else
                    {
                        _validation.Text = String.Empty;
                    }
                    if (interactive)
                    {
                        _saving = false;
                        DialogResult = DialogResult.OK;
                        Close();
                    }
                    return true;
                }

                if (!TryRollbackExternalChanges(previousCredential, credentialChanged, taskSnapshot, taskMutationAttempted)) return false;
                credentialChanged = false;
                taskMutationAttempted = false;

                if (interactive && response.relocation != null && response.relocation.required)
                {
                    DialogResult choice = MessageBox.Show(
                        "The existing mirror contains course files.\n\n" +
                        "Yes: Move the existing mirror to the new folder.\n" +
                        "No: Use the new folder and leave old files untouched.\n" +
                        "Cancel: Make no settings change.",
                        "Change mirror folder",
                        MessageBoxButtons.YesNoCancel,
                        MessageBoxIcon.Question,
                        MessageBoxDefaultButton.Button3);
                    if (choice == DialogResult.Cancel)
                    {
                        _validation.Text = "No changes were saved.";
                        return false;
                    }
                    _saving = false;
                    SetInputsEnabled(true);
                    return await SaveAsync(choice == DialogResult.Yes ? "move" : "use-new", true);
                }

                SettingsValidationError error = response.errors == null ? null : response.errors.FirstOrDefault();
                if (error != null && error.code == "mirror-rollback-failed")
                {
                    string recoveryMessage = MirrorRecoveryMessage(response);
                    _validation.Text = recoveryMessage;
                    if (interactive)
                    {
                        MessageBox.Show(
                            this,
                            recoveryMessage,
                            "Mirror recovery required",
                            MessageBoxButtons.OK,
                            MessageBoxIcon.Warning);
                    }
                    return false;
                }
                _validation.Text = error == null ? "Settings could not be saved." : error.message;
                return false;
            }
            catch (CredentialStoreException)
            {
                if (!backendSaveSucceeded && !TryRollbackExternalChanges(previousCredential, credentialChanged, taskSnapshot, taskMutationAttempted)) return false;
                _validation.Text = "Windows could not update the saved sign-in. No settings were saved.";
                return false;
            }
            catch (TaskSchedulerOperationException)
            {
                if (!backendSaveSucceeded && !TryRollbackExternalChanges(previousCredential, credentialChanged, taskSnapshot, taskMutationAttempted)) return false;
                _validation.Text = _committedSchedule.enabled && !request.schedule.enabled
                    ? "Windows could not disable automatic sync. No settings were saved, so the previous enabled schedule remains in effect."
                    : "Windows could not update automatic sync. No settings were saved.";
                return false;
            }
            catch (Exception)
            {
                if (!backendSaveSucceeded && !TryRollbackExternalChanges(previousCredential, credentialChanged, taskSnapshot, taskMutationAttempted)) return false;
                _validation.Text = "Settings could not be saved. Try again, or open View Logs for diagnostics.";
                return false;
            }
            finally
            {
                if (previousCredential != null) previousCredential.Dispose();
                ClearPasswordInput();
                _saving = false;
                if (!IsDisposed) SetInputsEnabled(true);
            }
        }

        private void SetInputsEnabled(bool enabled)
        {
            bool supportedAuthentication = SupportsStonyBrookAuthentication(_baseUrl.Text.Trim());
            _baseUrl.Enabled = enabled;
            _mirrorDir.Enabled = enabled;
            _mirrorBrowse.Enabled = enabled && !_mirrorOverrideActive;
            _driveEnabled.Enabled = enabled;
            _driveDestination.Enabled = enabled && _driveEnabled.Checked;
            _driveBrowse.Enabled = enabled && _driveEnabled.Checked;
            _retryBrowser.Enabled = enabled;
            _chooseBrowser.Enabled = enabled;
            _automaticBrowser.Enabled = enabled && !String.IsNullOrWhiteSpace(_manualBrowserPath);
            _edgeDownload.Enabled = enabled;
            _importSource.Enabled = enabled;
            _automaticLoginEnabled.Enabled = enabled;
            _username.Enabled = enabled && supportedAuthentication && _automaticLoginEnabled.Checked;
            _password.Enabled = enabled && supportedAuthentication && _automaticLoginEnabled.Checked;
            _removeCredential.Enabled = enabled && supportedAuthentication && _credentialExists && !_deleteCredentialRequested;
            _scheduleEnabled.Enabled = enabled;
            _intervalHours.Enabled = enabled && _scheduleEnabled.Checked;
            _fullIntervalDays.Enabled = enabled && _scheduleEnabled.Checked;
            _save.Enabled = enabled;
            _cancel.Enabled = enabled;
        }
    }
}
