using System;
using System.Text;
using System.Text.RegularExpressions;

namespace CourseStow.ControlPanel
{
    internal static class BackendDiagnosticSanitizer
    {
        internal const int MaximumCharacters = 4096;

        private static readonly Regex UrlPattern = new Regex(
            @"https?://[^\s<>""']+",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

        private static readonly Regex SensitiveFieldPattern = new Regex(
            @"(?im)([""']?\b(?:password|passwd|token|secret|authorization|credential|(?:set-)?cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key)\b[""']?\s*[:=]\s*)[^\r\n]*",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

        private static readonly Regex KnownKeyPattern = new Regex(
            @"(?i)\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

        internal static string Sanitize(string value)
        {
            string sanitized = RemoveUnsafeControlCharacters(value ?? String.Empty);
            sanitized = UrlPattern.Replace(sanitized, "[REDACTED_URL]");
            sanitized = SensitiveFieldPattern.Replace(sanitized, "$1[REDACTED]");
            sanitized = KnownKeyPattern.Replace(sanitized, "[REDACTED_KEY]");
            sanitized = sanitized.Trim();
            if (sanitized.Length == 0) return "No backend error details were provided.";
            if (sanitized.Length > MaximumCharacters)
            {
                const string prefix = "[truncated] ";
                sanitized = prefix + sanitized.Substring(sanitized.Length - (MaximumCharacters - prefix.Length));
            }
            return sanitized;
        }

        private static string RemoveUnsafeControlCharacters(string value)
        {
            var result = new StringBuilder(value.Length);
            foreach (char character in value)
            {
                if (!Char.IsControl(character) || character == '\r' || character == '\n' || character == '\t')
                    result.Append(character);
            }
            return result.ToString();
        }
    }

    internal static class BackendFailureLog
    {
        internal const string FileName = "backend-failures.log";

        internal static string Append(string logsDirectory, string operation, int exitCode, string standardError)
        {
            if (!System.IO.Directory.Exists(logsDirectory))
                throw new System.IO.DirectoryNotFoundException("The backend logs directory does not exist.");

            string file = System.IO.Path.Combine(logsDirectory, FileName);
            string diagnostic = BackendDiagnosticSanitizer.Sanitize(standardError);
            string entry = String.Format(
                "{0:u} Operation: {1}; exit code: {2}.{3}{4}{3}---{3}",
                DateTime.UtcNow,
                operation,
                exitCode,
                Environment.NewLine,
                diagnostic);
            System.IO.File.AppendAllText(file, entry, Encoding.UTF8);
            return file;
        }
    }
}
