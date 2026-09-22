using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Reflection;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace CourseStow.ControlPanel
{
    internal enum UpdateCheckOutcome
    {
        UpdateAvailable,
        UpToDate,
        Unavailable
    }

    internal sealed class UpdateCheckResult
    {
        internal UpdateCheckOutcome Outcome { get; set; }
        internal string LatestVersion { get; set; }
        internal string ReleaseUrl { get; set; }
        internal bool NetworkAttempted { get; set; }
        internal bool Throttled { get; set; }
    }

    internal sealed class StableVersion : IComparable<StableVersion>
    {
        internal int Major { get; private set; }
        internal int Minor { get; private set; }
        internal int Patch { get; private set; }

        private StableVersion(int major, int minor, int patch)
        {
            Major = major;
            Minor = minor;
            Patch = patch;
        }

        internal static bool TryParse(string value, bool requireTagPrefix, out StableVersion version)
        {
            version = null;
            if (String.IsNullOrEmpty(value)) return false;
            string numeric = value;
            if (requireTagPrefix)
            {
                if (value[0] != 'v') return false;
                numeric = value.Substring(1);
            }
            else if (value[0] == 'v') return false;

            string[] parts = numeric.Split('.');
            if (parts.Length != 3) return false;
            var numbers = new int[3];
            for (int index = 0; index < parts.Length; index++)
            {
                string part = parts[index];
                if (part.Length == 0 || (part.Length > 1 && part[0] == '0')) return false;
                for (int character = 0; character < part.Length; character++)
                    if (part[character] < '0' || part[character] > '9') return false;
                if (!Int32.TryParse(part, out numbers[index])) return false;
            }
            version = new StableVersion(numbers[0], numbers[1], numbers[2]);
            return true;
        }

        public int CompareTo(StableVersion other)
        {
            if (other == null) return 1;
            int result = Major.CompareTo(other.Major);
            if (result != 0) return result;
            result = Minor.CompareTo(other.Minor);
            return result != 0 ? result : Patch.CompareTo(other.Patch);
        }

        public override string ToString()
        {
            return String.Format("{0}.{1}.{2}", Major, Minor, Patch);
        }
    }

    internal sealed class UpdateCheckCache
    {
        public int schemaVersion { get; set; }
        public string lastAttemptUtc { get; set; }
        public string etag { get; set; }
        public string latestVersion { get; set; }
        public string releaseUrl { get; set; }
    }

    internal interface IUpdateCheckClock
    {
        DateTimeOffset UtcNow { get; }
    }

    internal sealed class SystemUpdateCheckClock : IUpdateCheckClock
    {
        public DateTimeOffset UtcNow { get { return DateTimeOffset.UtcNow; } }
    }

    internal interface IUpdateCheckCacheStore
    {
        UpdateCheckCache Load();
        void Save(UpdateCheckCache cache);
    }

    internal sealed class FileUpdateCheckCacheStore : IUpdateCheckCacheStore
    {
        internal const string FileName = "update-check.json";
        private readonly string _cacheFile;

        internal FileUpdateCheckCacheStore(string dataDir)
        {
            if (String.IsNullOrWhiteSpace(dataDir) || !Path.IsPathRooted(dataDir))
                throw new InvalidDataException("The backend did not provide a valid update-cache data directory.");
            _cacheFile = Path.Combine(dataDir, "state", FileName);
        }

        internal string CacheFile { get { return _cacheFile; } }

        public UpdateCheckCache Load()
        {
            try
            {
                if (!File.Exists(_cacheFile)) return null;
                string text = File.ReadAllText(_cacheFile, Encoding.UTF8);
                if (text.Length > 16384) return null;
                UpdateCheckCache cache = new JavaScriptSerializer().Deserialize<UpdateCheckCache>(text);
                return cache != null && cache.schemaVersion == UpdateCheckService.CacheSchemaVersion ? cache : null;
            }
            catch
            {
                return null;
            }
        }

        public void Save(UpdateCheckCache cache)
        {
            if (cache == null) throw new ArgumentNullException("cache");
            string directory = Path.GetDirectoryName(_cacheFile);
            Directory.CreateDirectory(directory);
            string temporary = _cacheFile + ".tmp-" + Guid.NewGuid().ToString("N");
            string backup = _cacheFile + ".replace-backup";
            try
            {
                string json = new JavaScriptSerializer().Serialize(cache);
                using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                using (var writer = new StreamWriter(stream, new UTF8Encoding(false)))
                {
                    writer.Write(json);
                    writer.Flush();
                    stream.Flush(true);
                }

                if (File.Exists(_cacheFile))
                {
                    if (File.Exists(backup)) File.Delete(backup);
                    File.Replace(temporary, _cacheFile, backup, true);
                    try { File.Delete(backup); } catch { }
                }
                else
                {
                    File.Move(temporary, _cacheFile);
                }
            }
            finally
            {
                try { if (File.Exists(temporary)) File.Delete(temporary); } catch { }
            }
        }
    }

    internal sealed class UpdateHttpResponse
    {
        internal HttpStatusCode StatusCode { get; set; }
        internal string ETag { get; set; }
        internal string Body { get; set; }
    }

    internal interface IUpdateHttpTransport
    {
        Task<UpdateHttpResponse> SendAsync(string etag);
    }

    internal sealed class GitHubUpdateHttpTransport : IUpdateHttpTransport
    {
        internal static readonly Uri LatestReleaseEndpoint = new Uri("https://api.github.com/repos/aryanramz/coursestow/releases/latest");
        internal const int MaximumResponseCharacters = 262144;
        private readonly HttpClient _client;
        private readonly string _currentVersion;

        internal GitHubUpdateHttpTransport(string currentVersion)
        {
            _currentVersion = currentVersion;
            _client = new HttpClient();
            _client.Timeout = TimeSpan.FromSeconds(5);
        }

        internal TimeSpan TimeoutForSelfTest { get { return _client.Timeout; } }

        internal HttpRequestMessage CreateRequestForSelfTest(string etag)
        {
            return CreateRequest(etag);
        }

        private HttpRequestMessage CreateRequest(string etag)
        {
            var request = new HttpRequestMessage(HttpMethod.Get, LatestReleaseEndpoint);
            request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github+json"));
            request.Headers.UserAgent.ParseAdd("CourseStow/" + _currentVersion);
            request.Headers.Add("X-GitHub-Api-Version", "2022-11-28");
            EntityTagHeaderValue parsed;
            if (UpdateCheckService.TryNormalizeEtag(etag, out parsed))
                request.Headers.IfNoneMatch.Add(parsed);
            return request;
        }

        public async Task<UpdateHttpResponse> SendAsync(string etag)
        {
            using (HttpRequestMessage request = CreateRequest(etag))
            using (HttpResponseMessage response = await _client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead))
            {
                string body = String.Empty;
                if (response.StatusCode != HttpStatusCode.NotModified && response.Content != null)
                {
                    using (Stream stream = await response.Content.ReadAsStreamAsync())
                    using (var reader = new StreamReader(stream, Encoding.UTF8, true, 4096, false))
                    {
                        var buffer = new char[4096];
                        var builder = new StringBuilder();
                        int count;
                        while ((count = await reader.ReadAsync(buffer, 0, buffer.Length)) > 0)
                        {
                            if (builder.Length + count > MaximumResponseCharacters)
                                throw new InvalidDataException("The update response exceeded the safe size limit.");
                            builder.Append(buffer, 0, count);
                        }
                        body = builder.ToString();
                    }
                }

                return new UpdateHttpResponse
                {
                    StatusCode = response.StatusCode,
                    ETag = response.Headers.ETag == null ? null : response.Headers.ETag.ToString(),
                    Body = body
                };
            }
        }
    }

    internal interface IUpdateCheckService
    {
        UpdateCheckResult GetCachedResult();
        Task<UpdateCheckResult> CheckAsync(bool manual);
    }

    internal interface IUpdateCheckServiceFactory
    {
        IUpdateCheckService Create(string dataDir);
    }

    internal sealed class UpdateCheckServiceFactory : IUpdateCheckServiceFactory
    {
        public IUpdateCheckService Create(string dataDir)
        {
            string version = ApplicationVersionProvider.GetCurrentVersion();
            return new UpdateCheckService(
                version,
                new FileUpdateCheckCacheStore(dataDir),
                new GitHubUpdateHttpTransport(version),
                new SystemUpdateCheckClock());
        }
    }

    internal sealed class DisabledUpdateCheckServiceFactory : IUpdateCheckServiceFactory
    {
        public IUpdateCheckService Create(string dataDir) { return null; }
    }

    internal static class ApplicationVersionProvider
    {
        internal static string GetCurrentVersion()
        {
            Assembly assembly = Assembly.GetExecutingAssembly();
            var informational = (AssemblyInformationalVersionAttribute)Attribute.GetCustomAttribute(
                assembly, typeof(AssemblyInformationalVersionAttribute));
            string value = informational == null ? null : informational.InformationalVersion;
            StableVersion parsed;
            if (!StableVersion.TryParse(value, false, out parsed))
                throw new InvalidDataException("CourseStow binary version metadata is invalid.");
            return parsed.ToString();
        }
    }

    internal sealed class UpdateCheckService : IUpdateCheckService
    {
        internal const int CacheSchemaVersion = 1;
        internal static readonly TimeSpan AutomaticInterval = TimeSpan.FromHours(24);
        private const string ReleasePrefix = "https://github.com/aryanramz/coursestow/releases/tag/v";
        private readonly StableVersion _currentVersion;
        private readonly IUpdateCheckCacheStore _cacheStore;
        private readonly IUpdateHttpTransport _transport;
        private readonly IUpdateCheckClock _clock;

        internal UpdateCheckService(string currentVersion, IUpdateCheckCacheStore cacheStore, IUpdateHttpTransport transport, IUpdateCheckClock clock)
        {
            if (!StableVersion.TryParse(currentVersion, false, out _currentVersion))
                throw new InvalidDataException("CourseStow binary version metadata is invalid.");
            if (cacheStore == null) throw new ArgumentNullException("cacheStore");
            if (transport == null) throw new ArgumentNullException("transport");
            if (clock == null) throw new ArgumentNullException("clock");
            _cacheStore = cacheStore;
            _transport = transport;
            _clock = clock;
        }

        public UpdateCheckResult GetCachedResult()
        {
            return ResultFromCache(_cacheStore.Load(), false, false);
        }

        public async Task<UpdateCheckResult> CheckAsync(bool manual)
        {
            DateTimeOffset now = _clock.UtcNow;
            UpdateCheckCache cache = NormalizeCache(_cacheStore.Load());
            if (!manual && IsThrottled(cache, now))
                return ResultFromCache(cache, false, true);

            cache.lastAttemptUtc = now.ToUniversalTime().ToString("o");
            _cacheStore.Save(cache);

            int maximumAttempts = manual ? 2 : 1;
            for (int attempt = 0; attempt < maximumAttempts; attempt++)
            {
                try
                {
                    string conditionalEtag = HasValidReleaseMetadata(cache) ? cache.etag : null;
                    UpdateHttpResponse response = await _transport.SendAsync(conditionalEtag);
                    if (response.StatusCode == HttpStatusCode.NotModified)
                    {
                        if (!HasValidReleaseMetadata(cache))
                            return Unavailable(true, false);
                        _cacheStore.Save(cache);
                        return ResultFromCache(cache, true, false);
                    }

                    if (response.StatusCode == HttpStatusCode.OK)
                    {
                        string version;
                        if (!TryReadStableRelease(response.Body, out version))
                        {
                            ClearReleaseMetadata(cache);
                            _cacheStore.Save(cache);
                            return Unavailable(true, false);
                        }
                        cache.latestVersion = version;
                        cache.releaseUrl = BuildReleaseUrl(version);
                        EntityTagHeaderValue parsedEtag;
                        cache.etag = TryNormalizeEtag(response.ETag, out parsedEtag) ? parsedEtag.ToString() : null;
                        _cacheStore.Save(cache);
                        return ResultFromCache(cache, true, false);
                    }

                    if (IsTransientStatus(response.StatusCode) && attempt + 1 < maximumAttempts)
                        continue;
                    return Unavailable(true, false);
                }
                catch (Exception error)
                {
                    if (!IsTransientException(error) || attempt + 1 >= maximumAttempts)
                        return Unavailable(true, false);
                }
            }
            return Unavailable(true, false);
        }

        internal static bool TryNormalizeEtag(string value, out EntityTagHeaderValue etag)
        {
            etag = null;
            return !String.IsNullOrWhiteSpace(value)
                && value.Length <= 512
                && value.IndexOf('\r') < 0
                && value.IndexOf('\n') < 0
                && EntityTagHeaderValue.TryParse(value, out etag);
        }

        internal static string BuildReleaseUrl(string version)
        {
            StableVersion parsed;
            if (!StableVersion.TryParse(version, false, out parsed)) return null;
            return ReleasePrefix + parsed;
        }

        internal static bool IsTrustedReleaseUrl(string value)
        {
            if (String.IsNullOrEmpty(value) || !value.StartsWith(ReleasePrefix, StringComparison.Ordinal)) return false;
            string version = value.Substring(ReleasePrefix.Length);
            return String.Equals(value, BuildReleaseUrl(version), StringComparison.Ordinal);
        }

        private static bool TryReadStableRelease(string json, out string version)
        {
            version = null;
            try
            {
                if (String.IsNullOrWhiteSpace(json) || json.Length > GitHubUpdateHttpTransport.MaximumResponseCharacters) return false;
                var root = new JavaScriptSerializer().DeserializeObject(json) as IDictionary<string, object>;
                if (root == null || !root.ContainsKey("tag_name") || !root.ContainsKey("draft") || !root.ContainsKey("prerelease")) return false;
                if (!(root["draft"] is bool) || !(root["prerelease"] is bool)) return false;
                if ((bool)root["draft"] || (bool)root["prerelease"]) return false;
                string tag = root["tag_name"] as string;
                StableVersion parsed;
                if (!StableVersion.TryParse(tag, true, out parsed)) return false;
                version = parsed.ToString();
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static bool IsTransientStatus(HttpStatusCode status)
        {
            int numeric = (int)status;
            return status == HttpStatusCode.RequestTimeout || numeric == 429 || numeric >= 500 && numeric <= 599;
        }

        private static bool IsTransientException(Exception error)
        {
            return error is HttpRequestException
                || error is TaskCanceledException
                || error is TimeoutException
                || error is IOException;
        }

        private bool IsThrottled(UpdateCheckCache cache, DateTimeOffset now)
        {
            DateTimeOffset lastAttempt;
            if (cache == null || !DateTimeOffset.TryParse(cache.lastAttemptUtc, out lastAttempt)) return false;
            lastAttempt = lastAttempt.ToUniversalTime();
            if (lastAttempt > now.AddMinutes(5)) return false;
            return now - lastAttempt < AutomaticInterval;
        }

        private static UpdateCheckCache NormalizeCache(UpdateCheckCache cache)
        {
            if (cache == null || cache.schemaVersion != CacheSchemaVersion)
                return new UpdateCheckCache { schemaVersion = CacheSchemaVersion };
            if (!HasValidReleaseMetadata(cache)) ClearReleaseMetadata(cache);
            return cache;
        }

        private static bool HasValidReleaseMetadata(UpdateCheckCache cache)
        {
            StableVersion parsed;
            return cache != null
                && StableVersion.TryParse(cache.latestVersion, false, out parsed)
                && String.Equals(cache.releaseUrl, BuildReleaseUrl(parsed.ToString()), StringComparison.Ordinal)
                && (String.IsNullOrEmpty(cache.etag) || IsValidEtag(cache.etag));
        }

        private static bool IsValidEtag(string value)
        {
            EntityTagHeaderValue ignored;
            return TryNormalizeEtag(value, out ignored);
        }

        private static void ClearReleaseMetadata(UpdateCheckCache cache)
        {
            cache.etag = null;
            cache.latestVersion = null;
            cache.releaseUrl = null;
        }

        private UpdateCheckResult ResultFromCache(UpdateCheckCache cache, bool networkAttempted, bool throttled)
        {
            if (!HasValidReleaseMetadata(cache)) return Unavailable(networkAttempted, throttled);
            StableVersion latest;
            StableVersion.TryParse(cache.latestVersion, false, out latest);
            return new UpdateCheckResult
            {
                Outcome = latest.CompareTo(_currentVersion) > 0 ? UpdateCheckOutcome.UpdateAvailable : UpdateCheckOutcome.UpToDate,
                LatestVersion = latest.ToString(),
                ReleaseUrl = cache.releaseUrl,
                NetworkAttempted = networkAttempted,
                Throttled = throttled
            };
        }

        private static UpdateCheckResult Unavailable(bool networkAttempted, bool throttled)
        {
            return new UpdateCheckResult
            {
                Outcome = UpdateCheckOutcome.Unavailable,
                NetworkAttempted = networkAttempted,
                Throttled = throttled
            };
        }
    }
}
