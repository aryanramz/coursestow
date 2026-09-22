using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace CourseStow.ControlPanel
{
    internal sealed class UpdateCheckSelfTestResult
    {
        public int schemaVersion { get; set; }
        public bool strictStableVersionParsing { get; set; }
        public bool semanticComparison { get; set; }
        public bool exactEndpoint { get; set; }
        public bool versionedUserAgent { get; set; }
        public bool requestHasNoAuthorization { get; set; }
        public bool fiveSecondTimeout { get; set; }
        public bool newerReleaseDetected { get; set; }
        public bool currentReleaseIsUpToDate { get; set; }
        public bool olderReleaseIsUpToDate { get; set; }
        public bool draftRejected { get; set; }
        public bool prereleaseRejected { get; set; }
        public bool malformedReleaseRejected { get; set; }
        public bool automaticCheckDoesNotRetry { get; set; }
        public bool manualCheckRetriesTransientFailure { get; set; }
        public bool manualCheckDoesNotRetryPermanentFailure { get; set; }
        public bool failedAttemptIsThrottled { get; set; }
        public bool manualCheckBypassesThrottle { get; set; }
        public bool etagSentAnd304Reused { get; set; }
        public bool invalid304CacheRejected { get; set; }
        public bool corruptCacheRecovered { get; set; }
        public bool cacheUsesExternalStateDirectory { get; set; }
        public bool cacheAllowlistOnly { get; set; }
        public bool cacheContainsNoResponseSecrets { get; set; }
        public bool cacheWriteIsAtomic { get; set; }
        public bool releaseUrlConstructedLocally { get; set; }
        public bool applicationVersionFromBinaryMetadata { get; set; }
        public bool automaticCheckDoesNotBlockInitialization { get; set; }
        public bool updateChecksDoNotOverlap { get; set; }
        public bool updateNoticeDisplayed { get; set; }
        public bool updateCompletionAfterCloseIgnored { get; set; }
        public bool automaticFailureIsSilent { get; set; }
        public bool manualNoUpdateIsExplicit { get; set; }
        public bool manualFailureIsExplicit { get; set; }
        public bool timeoutUsesTransientRetryPolicy { get; set; }
    }

    internal static class UpdateCheckSelfTest
    {
        internal static int Run(string outputFile)
        {
            try
            {
                UpdateCheckSelfTestResult result = RunAsync(Path.GetDirectoryName(outputFile)).GetAwaiter().GetResult();
                foreach (var property in typeof(UpdateCheckSelfTestResult).GetProperties())
                {
                    if (property.PropertyType == typeof(bool) && !(bool)property.GetValue(result, null))
                        throw new InvalidDataException("Update-check assertion failed: " + property.Name);
                }
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
                        error = error.GetType().Name
                    }));
                }
                catch { }
                return 1;
            }
        }

        internal static async Task<UpdateCheckSelfTestResult> RunAsync(string parentDirectory)
        {
            string root = Path.Combine(parentDirectory, "update checker " + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            try
            {
                StableVersion parsed;
                bool strictParsing = StableVersion.TryParse("v3.0.0", true, out parsed)
                    && parsed.ToString() == "3.0.0"
                    && !StableVersion.TryParse("3.0.0", true, out parsed)
                    && !StableVersion.TryParse("v03.0.0", true, out parsed)
                    && !StableVersion.TryParse("v3.00.0", true, out parsed)
                    && !StableVersion.TryParse("v3.0.00", true, out parsed)
                    && !StableVersion.TryParse("v3.0.0.0", true, out parsed)
                    && !StableVersion.TryParse("v3.0.0-beta", true, out parsed)
                    && !StableVersion.TryParse("v2147483648.0.0", true, out parsed)
                    && !StableVersion.TryParse("3.0.0?token=fake-marker", false, out parsed);

                StableVersion v300;
                StableVersion v301;
                StableVersion v241;
                StableVersion.TryParse("3.0.0", false, out v300);
                StableVersion.TryParse("3.0.1", false, out v301);
                StableVersion.TryParse("2.4.1", false, out v241);
                bool semanticComparison = v301.CompareTo(v300) > 0 && v241.CompareTo(v300) < 0 && v300.CompareTo(v300) == 0;

                var http = new GitHubUpdateHttpTransport("3.0.0");
                bool exactEndpoint;
                bool versionedUserAgent;
                bool requestHasNoAuthorization;
                using (HttpRequestMessage request = http.CreateRequestForSelfTest("\"safe-etag\""))
                {
                    exactEndpoint = request.Method == HttpMethod.Get
                        && request.RequestUri.AbsoluteUri == "https://api.github.com/repos/aryanramz/coursestow/releases/latest"
                        && request.Headers.IfNoneMatch.Count == 1;
                    versionedUserAgent = request.Headers.UserAgent.ToString() == "CourseStow/3.0.0";
                    requestHasNoAuthorization = request.Headers.Authorization == null;
                }

                string primaryData = Path.Combine(root, "external data");
                var clock = new FakeUpdateCheckClock(new DateTimeOffset(2026, 9, 14, 12, 0, 0, TimeSpan.Zero));
                var primaryStore = new FileUpdateCheckCacheStore(primaryData);
                const string secretMarker = "response-secret-marker";
                var primaryTransport = new ScriptedUpdateTransport(
                    Response(HttpStatusCode.OK, "v3.0.1", false, false, "\"etag-one\"", secretMarker));
                var service = new UpdateCheckService("3.0.0", primaryStore, primaryTransport, clock);
                UpdateCheckResult newer = await service.CheckAsync(false);
                string cacheText = File.ReadAllText(primaryStore.CacheFile);
                var cacheObject = new JavaScriptSerializer().DeserializeObject(cacheText) as IDictionary<string, object>;
                string[] allowed = { "schemaVersion", "lastAttemptUtc", "etag", "latestVersion", "releaseUrl" };
                bool allowlistOnly = cacheObject != null && cacheObject.Keys.All(key => allowed.Contains(key));
                bool localUrl = newer.ReleaseUrl == "https://github.com/aryanramz/coursestow/releases/tag/v3.0.1"
                    && newer.ReleaseUrl.IndexOf(secretMarker, StringComparison.Ordinal) < 0
                    && UpdateCheckService.IsTrustedReleaseUrl(newer.ReleaseUrl)
                    && !UpdateCheckService.IsTrustedReleaseUrl("https://example.test/releases/tag/v3.0.1");

                clock.Advance(TimeSpan.FromHours(25));
                primaryTransport.Enqueue(new UpdateHttpResponse { StatusCode = HttpStatusCode.NotModified });
                UpdateCheckResult notModified = await service.CheckAsync(false);
                bool etagReused = primaryTransport.LastEtag == "\"etag-one\""
                    && notModified.Outcome == UpdateCheckOutcome.UpdateAvailable
                    && notModified.ReleaseUrl == newer.ReleaseUrl;

                UpdateCheckResult current = await CheckSingleAsync(root, "current", "3.0.0", Response(HttpStatusCode.OK, "v3.0.0", false, false, null, null));
                UpdateCheckResult older = await CheckSingleAsync(root, "older", "3.0.0", Response(HttpStatusCode.OK, "v2.4.1", false, false, null, null));
                UpdateCheckResult draft = await CheckSingleAsync(root, "draft", "3.0.0", Response(HttpStatusCode.OK, "v9.0.0", true, false, null, null));
                UpdateCheckResult prerelease = await CheckSingleAsync(root, "prerelease", "3.0.0", Response(HttpStatusCode.OK, "v9.0.0", false, true, null, null));
                UpdateCheckResult malformed = await CheckSingleAsync(root, "malformed", "3.0.0", new UpdateHttpResponse
                {
                    StatusCode = HttpStatusCode.OK,
                    Body = "{\"tag_name\":\"v09.0.0\",\"draft\":false,\"prerelease\":false,\"html_url\":\"https://example.test/" + secretMarker + "\"}"
                });

                var autoTransport = new ScriptedUpdateTransport(
                    new UpdateHttpResponse { StatusCode = HttpStatusCode.ServiceUnavailable },
                    Response(HttpStatusCode.OK, "v3.0.1", false, false, null, null));
                var autoClock = new FakeUpdateCheckClock(clock.UtcNow);
                var autoService = new UpdateCheckService("3.0.0", new FileUpdateCheckCacheStore(Path.Combine(root, "automatic retry")), autoTransport, autoClock);
                UpdateCheckResult autoFailure = await autoService.CheckAsync(false);
                UpdateCheckResult throttledFailure = await autoService.CheckAsync(false);
                int callsAfterThrottle = autoTransport.CallCount;
                UpdateCheckResult manualAfterFailure = await autoService.CheckAsync(true);

                var retryTransport = new ScriptedUpdateTransport(
                    new UpdateHttpResponse { StatusCode = HttpStatusCode.ServiceUnavailable },
                    Response(HttpStatusCode.OK, "v3.0.1", false, false, null, null));
                var retryService = new UpdateCheckService("3.0.0", new FileUpdateCheckCacheStore(Path.Combine(root, "manual retry")), retryTransport, new FakeUpdateCheckClock(clock.UtcNow));
                UpdateCheckResult retryResult = await retryService.CheckAsync(true);

                var permanentTransport = new ScriptedUpdateTransport(
                    new UpdateHttpResponse { StatusCode = HttpStatusCode.NotFound },
                    Response(HttpStatusCode.OK, "v3.0.1", false, false, null, null));
                var permanentService = new UpdateCheckService("3.0.0", new FileUpdateCheckCacheStore(Path.Combine(root, "permanent failure")), permanentTransport, new FakeUpdateCheckClock(clock.UtcNow));
                await permanentService.CheckAsync(true);

                var timeoutTransport = new ScriptedUpdateTransport(
                    new TaskCanceledException("Synthetic timeout."),
                    Response(HttpStatusCode.OK, "v3.0.1", false, false, null, null));
                var timeoutService = new UpdateCheckService("3.0.0", new FileUpdateCheckCacheStore(Path.Combine(root, "timeout retry")), timeoutTransport, new FakeUpdateCheckClock(clock.UtcNow));
                UpdateCheckResult timeoutResult = await timeoutService.CheckAsync(true);

                string invalid304Data = Path.Combine(root, "invalid 304");
                Directory.CreateDirectory(Path.Combine(invalid304Data, "state"));
                File.WriteAllText(Path.Combine(invalid304Data, "state", FileUpdateCheckCacheStore.FileName), "{\"schemaVersion\":1,\"lastAttemptUtc\":\"broken\",\"etag\":\"\\\"etag\\\"\",\"latestVersion\":\"v3.0.1\",\"releaseUrl\":\"https://example.test/unsafe\"}");
                var invalid304Transport = new ScriptedUpdateTransport(new UpdateHttpResponse { StatusCode = HttpStatusCode.NotModified });
                var invalid304Service = new UpdateCheckService("3.0.0", new FileUpdateCheckCacheStore(invalid304Data), invalid304Transport, new FakeUpdateCheckClock(clock.UtcNow));
                UpdateCheckResult invalid304 = await invalid304Service.CheckAsync(false);

                string corruptData = Path.Combine(root, "corrupt cache");
                Directory.CreateDirectory(Path.Combine(corruptData, "state"));
                File.WriteAllText(Path.Combine(corruptData, "state", FileUpdateCheckCacheStore.FileName), "not-json-" + secretMarker);
                var corruptTransport = new ScriptedUpdateTransport(Response(HttpStatusCode.OK, "v3.0.1", false, false, null, null));
                var corruptService = new UpdateCheckService("3.0.0", new FileUpdateCheckCacheStore(corruptData), corruptTransport, new FakeUpdateCheckClock(clock.UtcNow));
                UpdateCheckResult corrupt = await corruptService.CheckAsync(false);

                bool noTemporaryFiles = !Directory.EnumerateFiles(Path.Combine(primaryData, "state"), "*.tmp-*", SearchOption.TopDirectoryOnly).Any();
                string binaryVersion = ApplicationVersionProvider.GetCurrentVersion();

                var uiStatus = new BackendStatus
                {
                    schemaVersion = 1,
                    appVersion = "3.0.0",
                    configured = true,
                    baseUrlConfigured = true,
                    mirrorDir = Path.Combine(root, "mirror"),
                    logsDir = Path.Combine(root, "logs"),
                    dataDir = Path.Combine(root, "ui data"),
                    status = "ready"
                };
                var uiBackend = new ScriptedBackendClient(uiStatus, new BackendProcessResult { ExitCode = 0 });
                var uiService = new ControllableUpdateCheckService { DelayNext = true };
                bool automaticNonBlocking;
                bool noOverlap;
                bool noticeDisplayed;
                bool closeIgnored;
                bool automaticFailureSilent;
                bool manualNoUpdateExplicit;
                bool manualFailureExplicit;
                using (var form = new MainForm(uiBackend, MainForm.StatusRefreshIntervalMilliseconds, null, new FixedUpdateCheckServiceFactory(uiService)))
                {
                    await form.InitializeForSelfTestAsync();
                    await uiService.Started;
                    automaticNonBlocking = uiService.CallCount == 1
                        && form.UpdateCheckRunningForSelfTest
                        && form.BackendStatusForSelfTest != null;
                    uiService.Complete(new UpdateCheckResult { Outcome = UpdateCheckOutcome.Unavailable, NetworkAttempted = true });
                    for (int wait = 0; wait < 100 && form.UpdateCheckRunningForSelfTest; wait++)
                        await Task.Delay(10);
                    if (form.UpdateCheckRunningForSelfTest)
                        throw new InvalidDataException("Automatic update check did not finish after its response was released.");
                    automaticFailureSilent = String.IsNullOrEmpty(form.UpdateTextForSelfTest);

                    uiService.ResetDelay();
                    Task delayedUiCheck = form.CheckForUpdatesForSelfTestAsync(true);
                    await uiService.Started;
                    await form.CheckForUpdatesForSelfTestAsync(true);
                    noOverlap = uiService.CallCount == 2;
                    uiService.Complete(new UpdateCheckResult
                    {
                        Outcome = UpdateCheckOutcome.UpdateAvailable,
                        LatestVersion = "3.0.1",
                        ReleaseUrl = UpdateCheckService.BuildReleaseUrl("3.0.1"),
                        NetworkAttempted = true
                    });
                    await delayedUiCheck;
                    noticeDisplayed = form.UpdateAvailableForSelfTest
                        && form.UpdateTextForSelfTest.IndexOf("3.0.1", StringComparison.Ordinal) >= 0;

                    uiService.ImmediateResult = new UpdateCheckResult { Outcome = UpdateCheckOutcome.UpToDate, NetworkAttempted = true };
                    await form.CheckForUpdatesForSelfTestAsync(true);
                    manualNoUpdateExplicit = form.UpdateTextForSelfTest.IndexOf("up to date", StringComparison.OrdinalIgnoreCase) >= 0;
                    uiService.ImmediateResult = new UpdateCheckResult { Outcome = UpdateCheckOutcome.Unavailable, NetworkAttempted = true };
                    await form.CheckForUpdatesForSelfTestAsync(true);
                    manualFailureExplicit = form.UpdateTextForSelfTest.IndexOf("Unable", StringComparison.OrdinalIgnoreCase) >= 0;

                    uiService.ResetDelay();
                    Task closingCheck = form.CheckForUpdatesForSelfTestAsync(true);
                    await uiService.Started;
                    string closedSnapshot = form.UpdateTextForSelfTest;
                    if (!form.BeginClosingForSelfTest())
                        throw new InvalidDataException("Update-check-only work unexpectedly blocked form close.");
                    uiService.Complete(new UpdateCheckResult
                    {
                        Outcome = UpdateCheckOutcome.UpdateAvailable,
                        LatestVersion = "9.9.9",
                        ReleaseUrl = UpdateCheckService.BuildReleaseUrl("9.9.9")
                    });
                    await closingCheck;
                    closeIgnored = form.UpdateTextForSelfTest == closedSnapshot;
                }

                return new UpdateCheckSelfTestResult
                {
                    schemaVersion = 1,
                    strictStableVersionParsing = strictParsing,
                    semanticComparison = semanticComparison,
                    exactEndpoint = exactEndpoint,
                    versionedUserAgent = versionedUserAgent,
                    requestHasNoAuthorization = requestHasNoAuthorization,
                    fiveSecondTimeout = http.TimeoutForSelfTest == TimeSpan.FromSeconds(5),
                    newerReleaseDetected = newer.Outcome == UpdateCheckOutcome.UpdateAvailable,
                    currentReleaseIsUpToDate = current.Outcome == UpdateCheckOutcome.UpToDate,
                    olderReleaseIsUpToDate = older.Outcome == UpdateCheckOutcome.UpToDate,
                    draftRejected = draft.Outcome == UpdateCheckOutcome.Unavailable,
                    prereleaseRejected = prerelease.Outcome == UpdateCheckOutcome.Unavailable,
                    malformedReleaseRejected = malformed.Outcome == UpdateCheckOutcome.Unavailable,
                    automaticCheckDoesNotRetry = autoFailure.Outcome == UpdateCheckOutcome.Unavailable && callsAfterThrottle == 1,
                    manualCheckRetriesTransientFailure = retryResult.Outcome == UpdateCheckOutcome.UpdateAvailable && retryTransport.CallCount == 2,
                    manualCheckDoesNotRetryPermanentFailure = permanentTransport.CallCount == 1,
                    failedAttemptIsThrottled = throttledFailure.Throttled && callsAfterThrottle == 1,
                    manualCheckBypassesThrottle = manualAfterFailure.Outcome == UpdateCheckOutcome.UpdateAvailable && autoTransport.CallCount == 2,
                    etagSentAnd304Reused = etagReused,
                    invalid304CacheRejected = invalid304.Outcome == UpdateCheckOutcome.Unavailable && String.IsNullOrEmpty(invalid304Transport.LastEtag),
                    corruptCacheRecovered = corrupt.Outcome == UpdateCheckOutcome.UpdateAvailable,
                    cacheUsesExternalStateDirectory = primaryStore.CacheFile == Path.Combine(primaryData, "state", FileUpdateCheckCacheStore.FileName),
                    cacheAllowlistOnly = allowlistOnly,
                    cacheContainsNoResponseSecrets = cacheText.IndexOf(secretMarker, StringComparison.Ordinal) < 0,
                    cacheWriteIsAtomic = noTemporaryFiles,
                    releaseUrlConstructedLocally = localUrl,
                    applicationVersionFromBinaryMetadata = binaryVersion == "3.0.0",
                    automaticCheckDoesNotBlockInitialization = automaticNonBlocking,
                    updateChecksDoNotOverlap = noOverlap,
                    updateNoticeDisplayed = noticeDisplayed,
                    updateCompletionAfterCloseIgnored = closeIgnored,
                    automaticFailureIsSilent = automaticFailureSilent,
                    manualNoUpdateIsExplicit = manualNoUpdateExplicit,
                    manualFailureIsExplicit = manualFailureExplicit,
                    timeoutUsesTransientRetryPolicy = timeoutResult.Outcome == UpdateCheckOutcome.UpdateAvailable && timeoutTransport.CallCount == 2
                };
            }
            finally
            {
                try { Directory.Delete(root, true); } catch { }
            }
        }

        private static async Task<UpdateCheckResult> CheckSingleAsync(string root, string name, string currentVersion, UpdateHttpResponse response)
        {
            var service = new UpdateCheckService(
                currentVersion,
                new FileUpdateCheckCacheStore(Path.Combine(root, name)),
                new ScriptedUpdateTransport(response),
                new FakeUpdateCheckClock(new DateTimeOffset(2026, 9, 14, 12, 0, 0, TimeSpan.Zero)));
            return await service.CheckAsync(false);
        }

        private static UpdateHttpResponse Response(HttpStatusCode status, string tag, bool draft, bool prerelease, string etag, string ignoredUrlMarker)
        {
            string foreignUrl = "https://example.test/releases/" + (ignoredUrlMarker ?? "ignored");
            return new UpdateHttpResponse
            {
                StatusCode = status,
                ETag = etag,
                Body = new JavaScriptSerializer().Serialize(new
                {
                    tag_name = tag,
                    draft = draft,
                    prerelease = prerelease,
                    html_url = foreignUrl,
                    body = ignoredUrlMarker
                })
            };
        }
    }

    internal sealed class FakeUpdateCheckClock : IUpdateCheckClock
    {
        internal FakeUpdateCheckClock(DateTimeOffset value) { UtcNow = value; }
        public DateTimeOffset UtcNow { get; private set; }
        internal void Advance(TimeSpan amount) { UtcNow = UtcNow.Add(amount); }
    }

    internal sealed class ScriptedUpdateTransport : IUpdateHttpTransport
    {
        private readonly Queue<object> _responses = new Queue<object>();

        internal ScriptedUpdateTransport(params object[] responses)
        {
            foreach (object response in responses) _responses.Enqueue(response);
        }

        internal int CallCount { get; private set; }
        internal string LastEtag { get; private set; }
        internal void Enqueue(object response) { _responses.Enqueue(response); }

        public Task<UpdateHttpResponse> SendAsync(string etag)
        {
            CallCount++;
            LastEtag = etag;
            if (_responses.Count == 0) throw new InvalidOperationException("No scripted update response remains.");
            object response = _responses.Dequeue();
            Exception error = response as Exception;
            if (error != null)
            {
                var failed = new TaskCompletionSource<UpdateHttpResponse>();
                failed.SetException(error);
                return failed.Task;
            }
            return Task.FromResult((UpdateHttpResponse)response);
        }
    }

    internal sealed class FixedUpdateCheckServiceFactory : IUpdateCheckServiceFactory
    {
        private readonly IUpdateCheckService _service;
        internal FixedUpdateCheckServiceFactory(IUpdateCheckService service) { _service = service; }
        public IUpdateCheckService Create(string dataDir) { return _service; }
    }

    internal sealed class ControllableUpdateCheckService : IUpdateCheckService
    {
        private TaskCompletionSource<bool> _started = NewCompletion<bool>();
        private TaskCompletionSource<UpdateCheckResult> _completion = NewCompletion<UpdateCheckResult>();

        internal bool DelayNext { get; set; }
        internal UpdateCheckResult ImmediateResult { get; set; }
        internal int CallCount { get; private set; }
        internal Task Started { get { return _started.Task; } }

        public UpdateCheckResult GetCachedResult()
        {
            return new UpdateCheckResult { Outcome = UpdateCheckOutcome.Unavailable };
        }

        public Task<UpdateCheckResult> CheckAsync(bool manual)
        {
            CallCount++;
            if (!DelayNext)
                return Task.FromResult(ImmediateResult ?? new UpdateCheckResult { Outcome = UpdateCheckOutcome.UpToDate, NetworkAttempted = true });
            _started.TrySetResult(true);
            return _completion.Task;
        }

        internal void Complete(UpdateCheckResult result)
        {
            DelayNext = false;
            _completion.TrySetResult(result);
        }

        internal void ResetDelay()
        {
            DelayNext = true;
            _started = NewCompletion<bool>();
            _completion = NewCompletion<UpdateCheckResult>();
        }

        private static TaskCompletionSource<T> NewCompletion<T>()
        {
            return new TaskCompletionSource<T>();
        }
    }
}
