using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace CourseStow.Security
{
    internal sealed class CredentialRecord : IDisposable
    {
        internal string Username { get; private set; }
        internal char[] Password { get; private set; }

        internal CredentialRecord(string username, char[] password)
        {
            Username = username ?? String.Empty;
            Password = password ?? new char[0];
        }

        public void Dispose()
        {
            if (Password != null) Array.Clear(Password, 0, Password.Length);
            Password = new char[0];
            Username = String.Empty;
        }
    }

    internal interface ICredentialStore
    {
        CredentialRecord Read(string target);
        string ReadUsername(string target);
        void Write(string target, string username, string password);
        void Delete(string target);
    }

    internal sealed class CredentialStoreException : Exception
    {
        internal CredentialStoreException(string message) : base(message) { }
    }

    internal sealed class WindowsCredentialStore : ICredentialStore
    {
        internal const string StonyBrookTarget = "CourseStow:institution:stony-brook";
        internal const string LegacyStonyBrookTarget = "Brightspace Sync:institution:stony-brook";
        private const uint CredentialTypeGeneric = 1;
        private const uint PersistLocalMachine = 2;
        private const int ErrorNotFound = 1168;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct NativeCredential
        {
            public uint Flags;
            public uint Type;
            [MarshalAs(UnmanagedType.LPWStr)] public string TargetName;
            [MarshalAs(UnmanagedType.LPWStr)] public string Comment;
            public long LastWritten;
            public uint CredentialBlobSize;
            public IntPtr CredentialBlob;
            public uint Persist;
            public uint AttributeCount;
            public IntPtr Attributes;
            [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias;
            [MarshalAs(UnmanagedType.LPWStr)] public string UserName;
        }

        [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);

        [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CredWrite(ref NativeCredential credential, uint flags);

        [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CredDelete(string target, uint type, uint flags);

        [DllImport("advapi32.dll", EntryPoint = "CredFree", SetLastError = false)]
        private static extern void CredFree(IntPtr credential);

        private static void ValidateTarget(string target)
        {
            if (!String.Equals(target, StonyBrookTarget, StringComparison.Ordinal)
                && !String.Equals(target, LegacyStonyBrookTarget, StringComparison.Ordinal))
                throw new CredentialStoreException("The requested credential target is not supported.");
        }

        public CredentialRecord Read(string target)
        {
            ValidateTarget(target);
            IntPtr pointer;
            if (!CredRead(target, CredentialTypeGeneric, 0, out pointer))
            {
                if (Marshal.GetLastWin32Error() == ErrorNotFound) return null;
                throw new CredentialStoreException("Windows could not read the saved Brightspace credential.");
            }

            try
            {
                NativeCredential credential = (NativeCredential)Marshal.PtrToStructure(pointer, typeof(NativeCredential));
                byte[] bytes = new byte[credential.CredentialBlobSize];
                char[] password = new char[0];
                try
                {
                    if (bytes.Length > 0) Marshal.Copy(credential.CredentialBlob, bytes, 0, bytes.Length);
                    password = Encoding.Unicode.GetChars(bytes);
                    return new CredentialRecord(credential.UserName, password);
                }
                finally
                {
                    Array.Clear(bytes, 0, bytes.Length);
                }
            }
            catch (CredentialStoreException) { throw; }
            catch { throw new CredentialStoreException("Windows could not read the saved Brightspace credential."); }
            finally
            {
                CredFree(pointer);
            }
        }

        public string ReadUsername(string target)
        {
            ValidateTarget(target);
            IntPtr pointer;
            if (!CredRead(target, CredentialTypeGeneric, 0, out pointer))
            {
                if (Marshal.GetLastWin32Error() == ErrorNotFound) return null;
                throw new CredentialStoreException("Windows could not inspect the saved Brightspace credential.");
            }
            try
            {
                NativeCredential credential = (NativeCredential)Marshal.PtrToStructure(pointer, typeof(NativeCredential));
                return credential.UserName ?? String.Empty;
            }
            catch { throw new CredentialStoreException("Windows could not inspect the saved Brightspace credential."); }
            finally { CredFree(pointer); }
        }

        public void Write(string target, string username, string password)
        {
            ValidateTarget(target);
            if (String.IsNullOrWhiteSpace(username) || String.IsNullOrEmpty(password))
                throw new CredentialStoreException("Both username and password are required to save a credential.");
            byte[] bytes = Encoding.Unicode.GetBytes(password);
            IntPtr blob = IntPtr.Zero;
            try
            {
                blob = Marshal.AllocHGlobal(bytes.Length);
                Marshal.Copy(bytes, 0, blob, bytes.Length);
                var credential = new NativeCredential
                {
                    Type = CredentialTypeGeneric,
                    TargetName = target,
                    CredentialBlobSize = (uint)bytes.Length,
                    CredentialBlob = blob,
                    Persist = PersistLocalMachine,
                    UserName = username
                };
                if (!CredWrite(ref credential, 0))
                    throw new CredentialStoreException("Windows could not save the Brightspace credential.");
            }
            finally
            {
                Array.Clear(bytes, 0, bytes.Length);
                if (blob != IntPtr.Zero)
                {
                    for (int index = 0; index < bytes.Length; index++) Marshal.WriteByte(blob, index, 0);
                    Marshal.FreeHGlobal(blob);
                }
            }
        }

        public void Delete(string target)
        {
            ValidateTarget(target);
            if (CredDelete(target, CredentialTypeGeneric, 0)) return;
            if (Marshal.GetLastWin32Error() == ErrorNotFound) return;
            throw new CredentialStoreException("Windows could not remove the saved Brightspace credential.");
        }
    }

    internal sealed class CompatibleCredentialStore : ICredentialStore
    {
        private readonly ICredentialStore _inner;

        internal CompatibleCredentialStore(ICredentialStore inner)
        {
            if (inner == null) throw new ArgumentNullException("inner");
            _inner = inner;
        }

        private static void ValidateCanonicalTarget(string target)
        {
            if (!String.Equals(target, WindowsCredentialStore.StonyBrookTarget, StringComparison.Ordinal))
                throw new CredentialStoreException("The requested credential target is not supported.");
        }

        public CredentialRecord Read(string target)
        {
            ValidateCanonicalTarget(target);
            CredentialRecord current = _inner.Read(WindowsCredentialStore.StonyBrookTarget);
            return current ?? _inner.Read(WindowsCredentialStore.LegacyStonyBrookTarget);
        }

        public string ReadUsername(string target)
        {
            ValidateCanonicalTarget(target);
            string current = _inner.ReadUsername(WindowsCredentialStore.StonyBrookTarget);
            return current ?? _inner.ReadUsername(WindowsCredentialStore.LegacyStonyBrookTarget);
        }

        public void Write(string target, string username, string password)
        {
            ValidateCanonicalTarget(target);
            _inner.Write(WindowsCredentialStore.StonyBrookTarget, username, password);
            _inner.Delete(WindowsCredentialStore.LegacyStonyBrookTarget);
        }

        public void Delete(string target)
        {
            ValidateCanonicalTarget(target);
            _inner.Delete(WindowsCredentialStore.StonyBrookTarget);
            _inner.Delete(WindowsCredentialStore.LegacyStonyBrookTarget);
        }
    }
}
