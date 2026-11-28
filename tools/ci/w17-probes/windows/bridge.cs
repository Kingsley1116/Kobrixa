using System;
using System.Text;
using System.IO;
using System.ComponentModel;
using Microsoft.Win32.SafeHandles;
using System.Runtime.InteropServices;
public static class W17 {
  [DllImport("kernel32.dll", ExactSpelling = true, CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CreateDirectoryW(string path, IntPtr security);
  [DllImport("kernel32.dll", ExactSpelling = true, CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern SafeFileHandle CreateFileW(string path, uint access, uint share,
      IntPtr security, uint creation, uint flags, IntPtr template);

  // FILE_CREATE returns the newly created directory handle itself. A second
  // OPEN_EXISTING by pathname could authenticate a replacement instead.
  [StructLayout(LayoutKind.Sequential)]
  struct UnicodeName { public ushort length, maximum; public IntPtr buffer; }
  [StructLayout(LayoutKind.Sequential)]
  struct ObjectAttributes {
    public int length;
    public IntPtr root, name;
    public uint attributes;
    public IntPtr descriptor, qos;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct IoStatus { public IntPtr status, information; }
  [DllImport("ntdll.dll")]
  static extern int NtCreateFile(out SafeFileHandle handle, uint access,
      ref ObjectAttributes attributes, out IoStatus status, IntPtr allocation,
      uint fileAttributes, uint share, uint disposition, uint options, IntPtr ea, uint eaLength);
  [DllImport("ntdll.dll")]
  static extern uint RtlNtStatusToDosError(int status);

  public static SafeFileHandle CreateStage(string path) {
    string nt = @"\??\" + Path.GetFullPath(path);
    var name = new UnicodeName { length = checked((ushort)(nt.Length * 2)),
      maximum = checked((ushort)((nt.Length + 1) * 2)), buffer = Marshal.StringToHGlobalUni(nt) };
    var attributes = new ObjectAttributes { length = Marshal.SizeOf<ObjectAttributes>(),
      attributes = 0x40, name = Marshal.AllocHGlobal(Marshal.SizeOf<UnicodeName>()) };
    try {
      Marshal.StructureToPtr(name, attributes.name, false);
      SafeFileHandle handle;
      IoStatus io;
      int status = NtCreateFile(out handle, 0x10000 | 0x80 | 0x100000, ref attributes,
          out io, IntPtr.Zero, 0, 3, 2, 1 | 0x20 | 0x00200000, IntPtr.Zero, 0);
      if (status < 0) throw new Win32Exception((int)RtlNtStatusToDosError(status));
      if (io.information.ToInt64() != 2) { // FILE_CREATED
        handle.Dispose();
        throw new IOException("Stage creation not confirmed");
      }
      return handle;
    } finally {
      Marshal.FreeHGlobal(attributes.name);
      Marshal.FreeHGlobal(name.buffer);
    }
  }

  [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
  private static extern bool SetFileInformationByHandle(SafeFileHandle handle,
      int informationClass, ref byte disposition, uint size);

  [StructLayout(LayoutKind.Sequential)]
  struct FileInfo {
    public uint attributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME creation, access, write;
    public uint volume, sizeHigh, sizeLow, links, indexHigh, indexLow;
  }
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetFileInformationByHandle(SafeFileHandle h, out FileInfo info);

  public static string Identity(SafeFileHandle handle, bool directory, bool reparse = false) {
    FileInfo info;
    if (!GetFileInformationByHandle(handle, out info))
      throw new Win32Exception(Marshal.GetLastWin32Error());
    if (directory != ((info.attributes & 16) != 0) ||
        reparse != ((info.attributes & 1024) != 0) || (!directory && info.links != 1))
      throw new IOException("Unexpected file type or link count");
    if (info.indexHigh == 0 && info.indexLow == 0) throw new IOException("Missing file ID");
    return String.Format("{0:X8}/{1:X8}{2:X8}", info.volume, info.indexHigh, info.indexLow);
  }

  public static string ChildIdentity(SafeFileHandle pin, bool directory, bool junction) {
    return (junction ? "junction:" : directory ? "directory:" : "file:") +
        Identity(pin, directory, junction);
  }

  public static void DeletePinned(SafeFileHandle handle) {
    byte disposition = 1;
    if (!SetFileInformationByHandle(handle, 4, ref disposition, 1))
      throw new Win32Exception(Marshal.GetLastWin32Error());
  }

  // No FILE_SHARE_DELETE: keep the verified root at this path through removal.
  public static SafeFileHandle PinStage(string path) { return PinStage(path, false); }
  static SafeFileHandle PinStage(string path, bool readOwner) {
    var handle = CreateFileW(path, 0x10000u | 0x80u | (readOwner ? 0x20000u : 0u), 3, IntPtr.Zero, 3,
                             0x02000000 | 0x00200000, IntPtr.Zero);
    if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
    return handle;
  }

  [DllImport("advapi32.dll")]
  static extern uint GetSecurityInfo(SafeFileHandle handle, int objectType, uint info,
      out IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl, out IntPtr descriptor);
  [DllImport("kernel32.dll")]
  static extern IntPtr LocalFree(IntPtr pointer);

  static string PinnedOwner(SafeFileHandle pin) {
    IntPtr owner, descriptor;
    uint rc = GetSecurityInfo(pin, 1, 1, out owner, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out descriptor);
    if (rc != 0) throw new Win32Exception((int)rc);
    try { return new System.Security.Principal.SecurityIdentifier(owner).Value; }
    finally { LocalFree(descriptor); }
  }

  // Keep every verified parent pinned while opening children without following links.
  // Only registered account homes admit dynamic children owned by that account.
  static string RemoveChildren(string path, System.Collections.IDictionary children, bool root,
                               System.Collections.IDictionary homes, string homeOwner) {
    var pending = new StringBuilder();
    void Record(string message) {
      const int limit = 8192;
      if (pending.Length >= limit) return;
      pending.Append(message, 0, Math.Min(Math.Min(message.Length, 2048), limit - pending.Length));
      pending.AppendLine();
      if (pending.Length >= limit) pending.Append("[remaining diagnostics truncated]");
    }
    foreach (var entry in new DirectoryInfo(path).GetFileSystemInfos()) {
      try {
        if (root && entry.Name == ".w17-owner") continue;
        string expected = children[entry.FullName] as string;
        if (expected == null && (homeOwner == null || (entry.Attributes & FileAttributes.ReparsePoint) != 0)) {
          Record("Unconfirmed stage child: " + entry.FullName);
          continue;
        }
        bool directory = (entry.Attributes & FileAttributes.Directory) != 0;
        bool junction = (entry.Attributes & FileAttributes.ReparsePoint) != 0;
        using (var pin = PinStage(entry.FullName, expected == null)) {
          string actual = ChildIdentity(pin, directory, junction);
          if (expected == null ? PinnedOwner(pin) != homeOwner : actual != expected) {
            Record("Stage child replaced: " + entry.FullName);
            continue;
          }
          if (directory && !junction) {
            var remaining = RemoveChildren(entry.FullName, children, false, homes, homeOwner ??
                (expected == null ? null : homes[entry.FullName] as string));
            if (remaining != null) {
              Record(remaining);
              continue;
            }
          }
          DeletePinned(pin); // Nonempty directories cannot be removed.
        }
      } catch (Exception e) when (e is IOException || e is Win32Exception || e is UnauthorizedAccessException ||
                                  e is ArgumentException || e is NotSupportedException || e is System.Security.SecurityException) {
        Record(entry.FullName + ": " + e.Message);
      }
    }
    return pending.Length == 0 ? null : pending.ToString();
  }

  public static void RemoveStage(SafeFileHandle handle, string path, string rootId,
                                 string markerId, System.Collections.IDictionary children, System.Collections.IDictionary homes) {
    if (Identity(handle, true) != rootId) throw new IOException("Stage root replaced");
    string marker = Path.Combine(path, ".w17-owner");
    using (var pin = PinStage(marker)) {
      if (Identity(pin, false) != markerId) throw new IOException("Stage marker replaced");
      string pending = RemoveChildren(path, children, true, homes, null);
      if (pending != null) throw new IOException(pending);
      foreach (var entry in Directory.EnumerateFileSystemEntries(path))
        if (entry != marker) throw new IOException("Unconfirmed stage child: " + entry);
      DeletePinned(pin);
    }
    DeletePinned(handle);
  }
  [DllImport(@"W17_DLL", ExactSpelling = true, CharSet = CharSet.Unicode)]
  public static extern uint ReadLabel(string path, StringBuilder buffer, uint capacity);
  [DllImport(@"W17_DLL", ExactSpelling = true, CharSet = CharSet.Unicode)]
  public static extern uint WriteLabel(string path, string expectedBefore, string requested);
  [DllImport(@"W17_DLL", ExactSpelling = true, CharSet = CharSet.Unicode)]
  public static extern uint WriteDacl(string path, string expectedBefore, string sddl, StringBuilder observed, uint capacity);
  [DllImport(@"W17_DLL", ExactSpelling = true, CharSet = CharSet.Unicode)]
  public static extern uint ReadDacl(string path, StringBuilder buffer, uint capacity);
  [DllImport(@"W17_DLL", ExactSpelling = true, CharSet = CharSet.Unicode)]
  public static extern uint TreeSave(string root, string output,
                                     out uint count);
  [DllImport(@"W17_DLL", ExactSpelling = true, CharSet = CharSet.Unicode)]
  public static extern uint TreeChange(string manifest, uint count, string sid,
                                       int restore, out uint verified);
  [DllImport(@"W17_DLL", ExactSpelling = true, CharSet = CharSet.Unicode)]
  public static extern uint TreeSaveTrace(string root, string output, out uint count, string log);
  [DllImport(@"W17_DLL", ExactSpelling = true, CharSet = CharSet.Unicode)]
  public static extern uint TreeChangeTrace(string manifest, uint count, string sid,
                                            int restore, out uint verified, string log);
  [DllImport(@"W17_DLL", ExactSpelling = true, CharSet = CharSet.Unicode)]
  public static extern uint Launch(string user, IntPtr password, string exe,
                                   StringBuilder command, IntPtr env,
                                   string cwd, string stderr, out uint pid);
  [DllImport(@"W17_DLL", ExactSpelling = true)]
  public static extern uint Resume(uint pid);
  [DllImport(@"W17_DLL", ExactSpelling = true)]
  public static extern uint ExitCode(uint pid, uint wait, out uint code);
  [DllImport(@"W17_DLL", ExactSpelling = true, CharSet = CharSet.Unicode)]
  public static extern uint Inspect(uint pid, StringBuilder buf, uint cap);
  [DllImport(@"W17_DLL", ExactSpelling = true)]
  public static extern uint Pin(uint pid, ulong birth);
  [DllImport(@"W17_DLL", ExactSpelling = true)]
  public static extern uint Member(uint pid, out uint member);
  [DllImport(@"W17_DLL", ExactSpelling = true)]
  public static extern uint KillChecked(uint pid, ulong birth);
  [DllImport(@"W17_DLL", ExactSpelling = true)]
  public static extern uint JobCount(out uint count);
  [DllImport(@"W17_DLL", ExactSpelling = true)]
  public static extern uint StopTree();
  [DllImport(@"W17_DLL", ExactSpelling = true, CharSet = CharSet.Unicode)]
  public static extern uint DesktopRead(int desk, StringBuilder buf, uint cap);
  [DllImport(@"W17_DLL", ExactSpelling = true, CharSet = CharSet.Unicode)]
  public static extern uint DesktopWrite(int desk, string sd);
  [DllImport(@"W17_DLL", ExactSpelling = true, CharSet = CharSet.Unicode)]
  public static extern uint WfpStart(string sid, string layer, string v4,
                                     string v6, out ulong id4, out ulong id6);
  [DllImport(@"W17_DLL", ExactSpelling = true)]
  public static extern uint WfpClose();
  [DllImport(@"W17_DLL", ExactSpelling = true, CharSet = CharSet.Unicode)]
  public static extern uint WfpAbsent(string layer, string v4, string v6);
  [DllImport(@"W17_DLL", ExactSpelling = true, CharSet = CharSet.Unicode)]
  public static extern uint ContainerFilter(ulong id, int ipv6, string sid,
                                            out uint matches);
  [DllImport(@"W17_DLL", ExactSpelling = true)]
  public static extern uint Audit(int write, ref uint setting);
}
