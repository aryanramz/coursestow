using CourseStow.Security;
using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

namespace CourseStow.CredentialHelper
{
    internal sealed class PipeRequest
    {
        public int schemaVersion { get; set; }
        public string operation { get; set; }
        public string target { get; set; }
        public string username { get; set; }
        public string password { get; set; }
    }

    internal static class Program
    {
        private const int MaximumRequestCharacters = 64 * 1024;

        private static int Main(string[] args)
        {
            if (args.Length == 2 && args[0] == "--self-test") return SelfTest(args[1]);
            if (args.Length != 2 || args[0] != "--pipe" || !Regex.IsMatch(args[1], @"^CourseStow-Credential-[A-Za-z0-9-]+$")) return 2;
            try
            {
                if (CourseStowProcessIdentity.IsMutexActive(CourseStowProcessIdentity.InstallerLifecycleMutexName)) return 4;
            }
            catch { return 4; }

            bool ownsActivityMutex;
            using (var activityMutex = new Mutex(true, CourseStowProcessIdentity.CredentialHelperMutexName, out ownsActivityMutex))
            {
                if (!ownsActivityMutex) return 3;
                try
                {
                    using (var pipe = new NamedPipeClientStream(".", args[1], PipeDirection.InOut, PipeOptions.None))
                    {
                        pipe.Connect(15000);
                        string input = ReadBoundedLine(pipe);
                        var serializer = new JavaScriptSerializer { MaxJsonLength = MaximumRequestCharacters };
                        PipeRequest request = serializer.Deserialize<PipeRequest>(input);
                        input = String.Empty;
                        string response = ExecuteAndSerialize(request, new CompatibleCredentialStore(new WindowsCredentialStore()), serializer);
                        byte[] output = Encoding.UTF8.GetBytes(response);
                        try
                        {
                            pipe.Write(output, 0, output.Length);
                            pipe.Flush();
                        }
                        finally
                        {
                            Array.Clear(output, 0, output.Length);
                            response = String.Empty;
                        }
                    }
                    GC.KeepAlive(activityMutex);
                    return 0;
                }
                catch
                {
                    return 1;
                }
            }
        }

        private static string ReadBoundedLine(Stream stream)
        {
            var value = new StringBuilder();
            using (var reader = new StreamReader(stream, Encoding.UTF8, false, 2048, true))
            {
                while (true)
                {
                    int next = reader.Read();
                    if (next < 0 || next == '\n') break;
                    if (next != '\r') value.Append((char)next);
                    if (value.Length > MaximumRequestCharacters) throw new InvalidDataException("Request too large.");
                }
            }
            return value.ToString();
        }

        private static string ExecuteAndSerialize(PipeRequest request, ICredentialStore store, JavaScriptSerializer serializer)
        {
            if (request == null || request.schemaVersion != 1 || request.target != WindowsCredentialStore.StonyBrookTarget)
                throw new InvalidDataException("Unsupported credential request.");
            try
            {
                if (request.operation == "probe")
                    return serializer.Serialize(new { schemaVersion = 1, ok = true, credentialApi = "Windows Credential Manager" });
                if (request.operation == "read")
                {
                    using (CredentialRecord record = store.Read(request.target))
                    {
                        if (record == null) return serializer.Serialize(new { schemaVersion = 1, ok = true, found = false });
                        string password = new String(record.Password);
                        try
                        {
                            return serializer.Serialize(new { schemaVersion = 1, ok = true, found = true, username = record.Username, password = password });
                        }
                        finally { password = String.Empty; }
                    }
                }
                if (request.operation == "write")
                {
                    store.Write(request.target, request.username, request.password);
                    request.password = String.Empty;
                    return serializer.Serialize(new { schemaVersion = 1, ok = true });
                }
                if (request.operation == "delete")
                {
                    store.Delete(request.target);
                    return serializer.Serialize(new { schemaVersion = 1, ok = true });
                }
                throw new InvalidDataException("Unsupported credential operation.");
            }
            finally
            {
                request.password = String.Empty;
                request.username = String.Empty;
            }
        }

        private static int SelfTest(string outputFile)
        {
            try
            {
                File.WriteAllText(
                    outputFile,
                    "{\"schemaVersion\":1,\"pipeTransport\":true,\"credentialTargetStable\":true,\"legacyCredentialTargetCompatible\":true}",
                    new UTF8Encoding(false));
                return 0;
            }
            catch { return 1; }
        }
    }
}
