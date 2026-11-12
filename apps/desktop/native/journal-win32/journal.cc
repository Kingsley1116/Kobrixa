// Windows safety journal. R1 2026-11-12: documented API semantics plus CI
// process-kill evidence; physical power loss has not been tested.
#include <node_api.h>
#include <stdexcept>
#include <cstddef>
#include <cstring>
#include <string>
#include <vector>
#ifdef _WIN32
#include <windows.h>
#include <winternl.h>
#include <aclapi.h>
#include <memory>
#include <algorithm>
#include <iomanip>
#include <sstream>
#include <utility>
#endif

namespace {
struct Failure {
  std::string code, message;
  unsigned long native = 0;
};
struct PendingException {};

void Check(napi_status status) {
  if (status == napi_pending_exception) throw PendingException{};
  if (status != napi_ok) throw Failure{"EINVAL", "invalid native journal argument"};
}
napi_value String(napi_env env, const std::string& s) {
  napi_value v;
  Check(napi_create_string_utf8(env, s.data(), s.size(), &v));
  return v;
}
void Set(napi_env env, napi_value obj, const char* key, napi_value value) {
  Check(napi_set_named_property(env, obj, key, value));
}
void Bool(napi_env env, napi_value obj, const char* key, bool value) {
  napi_value v;
  Check(napi_get_boolean(env, value, &v));
  Set(env, obj, key, v);
}
napi_value Object(napi_env env) {
  napi_value v;
  Check(napi_create_object(env, &v));
  return v;
}
// Error reporting must never allocate C++ strings or throw out of a callback,
// including when N-API already has an exception or cannot allocate an Error.
napi_value Error(napi_env env, const char* code, const char* message,
                 unsigned long native, const char* phase, bool attempted) noexcept {
  bool pending = false;
  if (napi_is_exception_pending(env, &pending) != napi_ok || pending) return nullptr;
  napi_value err, c, m, n, p, state;
  if (napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &c) == napi_ok &&
      napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &m) == napi_ok &&
      napi_create_error(env, c, m, &err) == napi_ok &&
      napi_create_uint32(env, native, &n) == napi_ok &&
      napi_create_string_utf8(env, phase, NAPI_AUTO_LENGTH, &p) == napi_ok &&
      napi_create_string_utf8(env, attempted ? "uncertain" : "not-published",
                              NAPI_AUTO_LENGTH, &state) == napi_ok &&
      napi_set_named_property(env, err, "win32Code", n) == napi_ok &&
      napi_set_named_property(env, err, "phase", p) == napi_ok &&
      napi_set_named_property(env, err, "publicationState", state) == napi_ok &&
      napi_throw(env, err) == napi_ok) return nullptr;
  // Preserve an exception produced by any of the calls above.
  if (napi_is_exception_pending(env, &pending) == napi_ok && !pending)
    napi_throw_error(env, "EIO", "native journal error reporting failed");
  return nullptr;
}
[[maybe_unused]] napi_value Error(napi_env env, const Failure& f, const char* phase,
                 bool attempted) noexcept {
  return Error(env, f.code.c_str(), f.message.c_str(), f.native, phase, attempted);
}
napi_value Unsupported(napi_env env, napi_callback_info) {
  napi_throw_error(env, "ENOTSUP",
      "Windows journal adapter requires verified local fixed NTFS");
  return nullptr;
}
napi_value StubCapabilities(napi_env env, napi_callback_info) {
  try {
  auto obj = Object(env);
#ifdef _WIN32
  Bool(env, obj, "prototypeAvailable", true);
#else
  Bool(env, obj, "prototypeAvailable", false);
#endif
  Bool(env, obj, "supported", false);
  Set(env, obj, "status", String(env, "unsupported platform"));
  return obj;
  } catch (...) { return Error(env, "EIO", "stub capabilities failed", 0, "capabilities", false); }
}

#ifdef _WIN32
struct Handle {
  HANDLE value = INVALID_HANDLE_VALUE;
  explicit Handle(HANDLE h) : value(h) {}
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  Handle(Handle&& other) noexcept : value(std::exchange(other.value, INVALID_HANDLE_VALUE)) {}
  ~Handle() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  void Close() {
    HANDLE h = std::exchange(value, INVALID_HANDLE_VALUE);
    if (!CloseHandle(h)) {
      DWORD code = GetLastError();
      throw Failure{"EIO", "CloseHandle", code};
    }
  }
};
[[noreturn]] void WinError(const char* operation, DWORD code = GetLastError()) {
  const char* mapped = "EIO";
  if (code == ERROR_ACCESS_DENIED) mapped = "EACCES";
  else if (code == ERROR_SHARING_VIOLATION || code == ERROR_LOCK_VIOLATION) mapped = "EBUSY";
  else if (code == ERROR_FILE_NOT_FOUND || code == ERROR_PATH_NOT_FOUND) mapped = "ENOENT";
  else if (code == ERROR_FILE_EXISTS || code == ERROR_ALREADY_EXISTS) mapped = "EEXIST";
  else if (code == ERROR_DISK_FULL || code == ERROR_HANDLE_DISK_FULL) mapped = "ENOSPC";
  else if (code == ERROR_NOT_SUPPORTED || code == ERROR_INVALID_FUNCTION) mapped = "ENOTSUP";
  throw Failure{mapped, operation, code};
}
std::wstring Wide(napi_env env, napi_value value) {
  size_t count;
  Check(napi_get_value_string_utf16(env, value, nullptr, 0, &count));
  if (count > 32760) throw Failure{"EINVAL", "path/string too long"};
  std::vector<char16_t> bytes(count + 1);
  Check(napi_get_value_string_utf16(env, value, bytes.data(), bytes.size(), &count));
  if (std::find(bytes.begin(), bytes.begin() + count, 0) != bytes.begin() + count)
    throw Failure{"EINVAL", "embedded NUL"};
  return std::wstring(bytes.begin(), bytes.begin() + count);
}
std::string Token(napi_env env, napi_value value) {
  auto wide = Wide(env, value);
  for (auto c : wide) if (c > 127) throw Failure{"EINVAL", "identity must be ASCII"};
  return std::string(wide.begin(), wide.end());
}
std::vector<napi_value> Args(napi_env env, napi_callback_info info, size_t count) {
  std::vector<napi_value> args(count);
  size_t actual = count;
  Check(napi_get_cb_info(env, info, &actual, args.data(), nullptr, nullptr));
  if (actual != count) throw Failure{"EINVAL", "wrong argument count"};
  return args;
}
std::wstring Directory(napi_env env, napi_value value) {
  auto p = Wide(env, value);
  std::replace(p.begin(), p.end(), L'/', L'\\');
  if (p.size() < 4 || !((p[0] >= L'A' && p[0] <= L'Z') ||
      (p[0] >= L'a' && p[0] <= L'z')) || p[1] != L':' || p[2] != L'\\')
    throw Failure{"ENOTSUP", "only absolute local drive paths are candidates"};
  // Do not normalize away traversal, ADS, device namespaces, or Win32 aliases.
  size_t start = 3;
  while (start < p.size()) {
    size_t end = p.find(L'\\', start);
    if (end == std::wstring::npos) end = p.size();
    auto part = p.substr(start, end - start);
    if (part.empty() || part.back() == L'.' || part.back() == L' ' ||
        part.find_first_of(L":*?<>|\"") != std::wstring::npos)
      throw Failure{"EINVAL", "non-canonical directory component"};
    start = end + 1;
  }
  if (p.back() == L'\\') throw Failure{"EINVAL", "trailing directory separator"};
  return p;
}
std::wstring Name(napi_env env, napi_value value, bool temp) {
  auto name = Wide(env, value);
  if (!temp && (name == L"faults.json" || name == L"faults.previous.json")) return name;
  if (temp) {
    const std::wstring prefix = name.rfind(L"faults.backup-", 0) == 0 ? L"faults.backup-" : L"faults.next-";
    if (name.size() == prefix.size() + 36 + 5 && name.substr(0, prefix.size()) == prefix &&
        name.substr(name.size() - 5) == L".json") {
      auto id = name.substr(prefix.size(), 36);
      bool valid = true;
      for (size_t i = 0; i < id.size(); ++i) {
        bool dash = i == 8 || i == 13 || i == 18 || i == 23;
        valid = valid && (dash ? id[i] == L'-' :
            ((id[i] >= L'0' && id[i] <= L'9') || (id[i] >= L'a' && id[i] <= L'f')));
      }
      if (valid) return name;
    }
  }
  throw Failure{"EINVAL", "journal filename refused"};
}
Handle Open(const std::wstring& path, DWORD access, DWORD share, DWORD disposition,
            DWORD extra = 0) {
  HANDLE h = CreateFileW(path.c_str(), access, share, nullptr, disposition,
      FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS | extra, nullptr);
  if (h == INVALID_HANDLE_VALUE) WinError("CreateFileW");
  return Handle(h);
}
std::string Identity(HANDLE h, bool directory) {
  BY_HANDLE_FILE_INFORMATION basic{};
  if (!GetFileInformationByHandle(h, &basic)) WinError("GetFileInformationByHandle");
  if (basic.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)
    throw Failure{"EUNSAFE", "reparse point refused"};
  if (!!(basic.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != directory ||
      (!directory && (basic.nNumberOfLinks != 1 || basic.nFileSizeHigh ||
                     basic.nFileSizeLow > 8388608)))
    throw Failure{"EUNSAFE", "type, hard-link count or file budget refused"};
  FILE_ID_INFO id{};
  if (!GetFileInformationByHandleEx(h, FileIdInfo, &id, sizeof(id)))
    WinError("GetFileInformationByHandleEx(FileIdInfo)");
  std::ostringstream out;
  out << std::hex << id.VolumeSerialNumber << ':' << std::setfill('0');
  for (auto b : id.FileId.Identifier) out << std::setw(2) << static_cast<unsigned>(b);
  return out.str();
}

// NtCreateFile's documented RootDirectory binds a single component to its pinned
// parent. No path normalization, junction following, or global cwd changes.
Handle RelativeOpen(HANDLE parent, const std::wstring& name, DWORD access,
                    DWORD share, bool create = false) {
  auto module = GetModuleHandleW(L"ntdll.dll");
  auto createFile = reinterpret_cast<decltype(&NtCreateFile)>(
      GetProcAddress(module, "NtCreateFile"));
  using MapError = ULONG (WINAPI*)(NTSTATUS);
  auto mapError = reinterpret_cast<MapError>(GetProcAddress(module, "RtlNtStatusToDosError"));
  if (!createFile || !mapError) throw Failure{"ENOTSUP", "relative file API unavailable"};
  UNICODE_STRING text{};
  text.Buffer = const_cast<PWSTR>(name.c_str());
  text.Length = static_cast<USHORT>(name.size() * sizeof(wchar_t));
  text.MaximumLength = text.Length;
  OBJECT_ATTRIBUTES attributes{};
  attributes.Length = sizeof(attributes);
  attributes.RootDirectory = parent;
  attributes.ObjectName = &text;
  attributes.Attributes = 0x40; // OBJ_CASE_INSENSITIVE
  IO_STATUS_BLOCK io{};
  HANDLE handle = INVALID_HANDLE_VALUE;
  auto status = createFile(&handle, access | SYNCHRONIZE, &attributes, &io, nullptr,
      FILE_ATTRIBUTE_NORMAL, share, create ? 2 : 1, // FILE_CREATE / FILE_OPEN
      0x00200000 | 0x00000020 | 0x00004000 | (create ? 0x2 : 0), // OPEN_REPARSE_POINT / SYNCHRONOUS_IO_NONALERT / BACKUP_INTENT / WRITE_THROUGH
      nullptr, 0);
  if (status < 0) WinError("NtCreateFile(relative)", mapError(status));
  return Handle(handle);
}
// Accept only the current user, SYSTEM and Administrators as writers/owners.
// Do not silently rewrite existing ACLs: an unsafe inherited ACL is a refusal.
void PrivateAcl(HANDLE handle) {
  HANDLE rawToken;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &rawToken)) WinError("OpenProcessToken");
  Handle token(rawToken);
  DWORD size = 0;
  GetTokenInformation(token.value, TokenUser, nullptr, 0, &size);
  std::vector<unsigned char> user(size);
  if (!GetTokenInformation(token.value, TokenUser, user.data(), size, &size))
    WinError("GetTokenInformation");
  auto sid = reinterpret_cast<TOKEN_USER*>(user.data())->User.Sid;
  auto trusted = [&](PSID candidate) {
    return IsValidSid(candidate) && (EqualSid(sid, candidate) ||
        IsWellKnownSid(candidate, WinLocalSystemSid) ||
        IsWellKnownSid(candidate, WinBuiltinAdministratorsSid));
  };
  PSECURITY_DESCRIPTOR raw = nullptr;
  PSID owner = nullptr;
  PACL acl = nullptr;
  DWORD error = GetSecurityInfo(handle, SE_FILE_OBJECT,
      OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      &owner, nullptr, &acl, nullptr, &raw);
  if (error != ERROR_SUCCESS) WinError("GetSecurityInfo", error);
  struct Free { void operator()(void* p) const { LocalFree(p); } };
  std::unique_ptr<void, Free> descriptor(raw);
  if (!owner || !trusted(owner) || !acl)
    throw Failure{"EUNSAFE", "journal requires a private owner and DACL"};
  for (DWORD i = 0; i < acl->AceCount; ++i) {
    void* rawAce;
    if (!GetAce(acl, i, &rawAce)) WinError("GetAce");
    auto header = static_cast<ACE_HEADER*>(rawAce);
    if (header->AceFlags & INHERIT_ONLY_ACE) continue;
    if (header->AceType == ACCESS_DENIED_ACE_TYPE) continue;
    if (header->AceType != ACCESS_ALLOWED_ACE_TYPE)
      throw Failure{"EUNSAFE", "unverifiable journal DACL ACE"};
    auto ace = static_cast<ACCESS_ALLOWED_ACE*>(rawAce);
    constexpr DWORD mutation = GENERIC_ALL | GENERIC_WRITE | FILE_WRITE_DATA |
        FILE_APPEND_DATA | FILE_WRITE_EA | FILE_WRITE_ATTRIBUTES | FILE_DELETE_CHILD |
        DELETE | WRITE_DAC | WRITE_OWNER;
    if ((ace->Mask & mutation) && !trusted(&ace->SidStart))
      throw Failure{"EUNSAFE", "journal DACL permits another principal to mutate evidence"};
  }
}
std::wstring HandlePath(HANDLE handle) {
  std::vector<wchar_t> path(32768);
  DWORD length = GetFinalPathNameByHandleW(handle, path.data(), static_cast<DWORD>(path.size()),
                                        FILE_NAME_NORMALIZED | VOLUME_NAME_GUID);
  if (!length || length >= path.size()) WinError("GetFinalPathNameByHandleW");
  return std::wstring(path.data(), length);
}
struct PinnedDirectory {
  std::vector<Handle> ancestors;
  std::string identity;
  explicit PinnedDirectory(const std::wstring& path, bool production = false) {
    if (production) {
      // Conservative production floor: Windows 10 1709 / Server 2022 or newer.
      using GetVersion = LONG (WINAPI*)(PRTL_OSVERSIONINFOW);
      auto getVersion = reinterpret_cast<GetVersion>(
          GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion"));
      RTL_OSVERSIONINFOW version{};
      version.dwOSVersionInfoSize = sizeof(version);
      if (!getVersion || getVersion(&version) != 0 || version.dwMajorVersion < 10 ||
          (version.dwMajorVersion == 10 && version.dwBuildNumber < 16299))
        throw Failure{"ENOTSUP", "FileRenameInfoEx requires Windows 10 1709 or newer"};
    }
    auto drive = path.substr(0, 3);
    if (GetDriveTypeW(drive.c_str()) != DRIVE_FIXED)
      throw Failure{"ENOTSUP", "remote/removable/unknown volume is unverified"};
    // OPEN_REPARSE_POINT affects the final component only: walk and pin every ancestor.
    size_t end = 2;
    for (;;) {
      auto prefix = path.substr(0, end == 2 ? 3 : end);
      const bool final = end == path.size();
      // LIST_DIRECTORY participates in share checks; attribute-only pins do not.
      // The leaf's write access is for FlushFileBuffers. Share READ|WRITE so the
      // I/O manager can open the rename target parent for write, never DELETE.
      DWORD access = production && final ? GENERIC_READ | GENERIC_WRITE :
          FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES;
      DWORD share = FILE_SHARE_READ | FILE_SHARE_WRITE;
      auto h = ancestors.empty() ? Open(prefix, access, share, OPEN_EXISTING) :
          RelativeOpen(ancestors.back().value, prefix.substr(prefix.find_last_of(L'\\') + 1),
                       access, share);
      if (production && final) PrivateAcl(h.value);
      identity = Identity(h.value, true);
      ancestors.push_back(std::move(h));
      if (end == path.size()) break;
      end = path.find(L'\\', end + 1);
      if (end == std::wstring::npos) end = path.size();
    }
    auto volume = HandlePath(ancestors.front().value);
    if (GetDriveTypeW(volume.c_str()) != DRIVE_FIXED)
      throw Failure{"ENOTSUP", "pinned volume is not a local fixed drive"};
    wchar_t fs[32]{};
    if (!GetVolumeInformationByHandleW(ancestors.back().value, nullptr, 0, nullptr, nullptr, nullptr, fs, 32))
      WinError("GetVolumeInformationByHandleW");
    if (std::wstring(fs) != L"NTFS")
      throw Failure{"ENOTSUP", "only local fixed NTFS is supported"};
  }
};
std::string FileIdentity(const std::wstring& path) {
  HANDLE raw = CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr);
  if (raw == INVALID_HANDLE_VALUE) {
    DWORD code = GetLastError();
    if (code == ERROR_FILE_NOT_FOUND) return "missing";
    WinError("CreateFileW(identity)", code);
  }
  Handle h(raw);
  return Identity(h.value, false);
}
std::string RelativeIdentity(HANDLE parent, const std::wstring& name) {
  try {
    auto h = RelativeOpen(parent, name, FILE_READ_ATTRIBUTES,
                          FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
    return Identity(h.value, false);
  } catch (const Failure& f) {
    if (f.native == ERROR_FILE_NOT_FOUND) return "missing";
    throw;
  }
}
void Match(const std::string& actual, const std::string& expected) {
  if (actual != expected) throw Failure{"ESTALE", "journal identity changed"};
}
void Hook(napi_env env, napi_value callback, const char* phase) {
  napi_value receiver, ignored, arg = String(env, phase);
  Check(napi_get_undefined(env, &receiver));
  Check(napi_call_function(env, receiver, callback, 1, &arg, &ignored));
}
napi_value Inspect(napi_env env, napi_callback_info info) {
  try {
    auto args = Args(env, info, 2);
    auto dir = Directory(env, args[0]);
    PinnedDirectory pinned(dir);
    auto name = Wide(env, args[1]);
    return String(env, name.empty() ? pinned.identity :
        FileIdentity(dir + L"\\" + Name(env, args[1], false)));
  } catch (const PendingException&) { return nullptr; }
    catch (const Failure& f) { return Error(env, f, "inspect", false); }
    catch (const std::exception& e) { return Error(env, "EIO", e.what(), 0, "inspect", false); }
    catch (...) { return Error(env, "EIO", "unknown native exception", 0, "inspect", false); }
}
napi_value DirectoryProbe(napi_env env, napi_callback_info info) {
  // This is a diagnostic, never a successful production directory barrier.
  const char* phase = "open-directory";
  try {
    auto args = Args(env, info, 1);
    auto dir = Directory(env, args[0]);
    PinnedDirectory pinned(dir);
    auto h = Open(dir, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                  OPEN_EXISTING);
    Match(Identity(h.value, true), pinned.identity);
    phase = "flush-directory";
    if (!FlushFileBuffers(h.value)) WinError("FlushFileBuffers(directory)");
    h.Close();
    auto result = Object(env);
    Bool(env, result, "flushed", true);
    Bool(env, result, "supported", false);
    return result;
  } catch (const PendingException&) { return nullptr; }
    catch (const Failure& f) { return Error(env, f, phase, false); }
    catch (const std::exception& e) { return Error(env, "EIO", e.what(), 0, phase, false); }
    catch (...) { return Error(env, "EIO", "unknown native exception", 0, phase, false); }
}
napi_value ReplaceCandidate(napi_env env, napi_callback_info info) {
  const char* phase = "validate";
  bool attempted = false;
  try {
    auto args = Args(env, info, 7);
    auto dir = Directory(env, args[0]);
    auto target = dir + L"\\" + Name(env, args[1], false);
    auto temp = dir + L"\\" + Name(env, args[2], true);
    bool isBuffer;
    Check(napi_is_buffer(env, args[3], &isBuffer));
    if (!isBuffer) throw Failure{"EINVAL", "payload must be a Buffer"};
    void* data;
    size_t size;
    Check(napi_get_buffer_info(env, args[3], &data, &size));
    if (!size || size > 8388608) throw Failure{"EINVAL", "journal byte budget"};
    std::vector<unsigned char> bytes(static_cast<unsigned char*>(data),
                                     static_cast<unsigned char*>(data) + size);
    auto dirId = Token(env, args[4]), targetId = Token(env, args[5]);
    napi_valuetype callbackType;
    Check(napi_typeof(env, args[6], &callbackType));
    if (callbackType != napi_function) throw Failure{"EINVAL", "prototype phase callback required"};
    PinnedDirectory pinned(dir);
    Match(pinned.identity, dirId);
    Match(FileIdentity(target), targetId);
    phase = "create-temp";
    // Never truncate existing evidence. Inherit the private profile directory's DACL.
    auto h = Open(temp, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ,
                  CREATE_NEW, FILE_FLAG_WRITE_THROUGH);
    auto tempId = Identity(h.value, false);
    phase = "write-temp";
    for (size_t offset = 0; offset < size;) {
      DWORD written = 0;
      if (!WriteFile(h.value, bytes.data() + offset, static_cast<DWORD>(size - offset),
                     &written, nullptr)) WinError("WriteFile");
      if (!written) throw Failure{"EIO", "zero-length WriteFile"};
      offset += written;
    }
    phase = "flush-temp";
    if (!FlushFileBuffers(h.value)) WinError("FlushFileBuffers(temp)");
    h.Close();
    Hook(env, args[6], "after-temp-flush");
    phase = "pre-publication";
    Match(Identity(pinned.ancestors.back().value, true), dirId);
    Match(FileIdentity(temp), tempId);
    Match(FileIdentity(target), targetId);
    // Deliberately no COPY_ALLOWED, no delete/unlink fallback, no retry.
    // Historical candidate stays path-based; production uses a held-source rename.
    phase = "move";
    attempted = true;
    if (!MoveFileExW(temp.c_str(), target.c_str(),
                     MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
      WinError("MoveFileExW");
    Hook(env, args[6], "after-move");
    phase = "flush-published";
    auto published = Open(target, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ,
                          OPEN_EXISTING, FILE_FLAG_WRITE_THROUGH);
    Match(Identity(published.value, false), tempId);
    if (!FlushFileBuffers(published.value)) WinError("FlushFileBuffers(published)");
    published.Close();
    Hook(env, args[6], "after-published-flush");
    auto result = Object(env);
    Bool(env, result, "fileFlushed", true);
    Bool(env, result, "published", true);
    Bool(env, result, "supported", false);
    Set(env, result, "identity", String(env, tempId));
    Set(env, result, "primitive", String(env, "MoveFileExW(REPLACE_EXISTING|WRITE_THROUGH)"));
    return result;
  } catch (const PendingException&) { return nullptr; }
    catch (const Failure& f) { return Error(env, f, phase, attempted); }
    catch (const std::exception& e) { return Error(env, "EIO", e.what(), 0, phase, attempted); }
    catch (...) { return Error(env, "EIO", "unknown native exception", 0, phase, attempted); }
}

napi_value Capabilities(napi_env env, napi_callback_info info) {
  try {
    auto args = Args(env, info, 1);
    PinnedDirectory pinned(Directory(env, args[0]), true);
    auto result = Object(env);
    Bool(env, result, "supported", true);
    Set(env, result, "scope", String(env, "local-fixed-NTFS"));
    return result;
  } catch (const PendingException&) { return nullptr; }
    catch (const Failure& f) { return Error(env, f, "capabilities", false); }
    catch (const std::exception& e) { return Error(env, "EIO", e.what(), 0, "capabilities", false); }
    catch (...) { return Error(env, "EIO", "unknown native exception", 0, "capabilities", false); }
}
napi_value SyncDirectory(napi_env env, napi_callback_info info) {
  try {
    auto args = Args(env, info, 1);
    PinnedDirectory pinned(Directory(env, args[0]), true);
    if (!FlushFileBuffers(pinned.ancestors.back().value)) WinError("FlushFileBuffers(directory)");
    pinned.ancestors.back().Close();
    auto result = Object(env);
    Bool(env, result, "flushed", true);
    Bool(env, result, "supported", true);
    return result;
  } catch (const PendingException&) { return nullptr; }
    catch (const Failure& f) { return Error(env, f, "flush-directory", false); }
    catch (const std::exception& e) { return Error(env, "EIO", e.what(), 0, "flush-directory", false); }
    catch (...) { return Error(env, "EIO", "unknown native exception", 0, "flush-directory", false); }
}
napi_value DurableReplaceImpl(napi_env env, napi_callback_info info, bool testHook) {
  const char* phase = "validate";
  bool attempted = false;
  try {
    auto args = Args(env, info, testHook ? 5 : 4);
    auto dir = Directory(env, args[0]);
    auto target = Name(env, args[1], false), temp = Name(env, args[2], true);
    bool isBuffer = false;
    Check(napi_is_buffer(env, args[3], &isBuffer));
    if (!isBuffer) throw Failure{"EINVAL", "payload must be a Buffer"};
    void* data;
    size_t size;
    Check(napi_get_buffer_info(env, args[3], &data, &size));
    if (!size || size > 8388608) throw Failure{"EINVAL", "journal byte budget"};
    PinnedDirectory pinned(dir, true);
    HANDLE parent = pinned.ancestors.back().value;
    // The old target denies data writers but shares DELETE for POSIX replacement.
    // It stays alive across the rename; a target-name substitution race remains.
    std::unique_ptr<Handle> old;
    try {
      old = std::make_unique<Handle>(RelativeOpen(parent, target, GENERIC_READ,
                                                 FILE_SHARE_READ | FILE_SHARE_DELETE));
      Identity(old->value, false);
      PrivateAcl(old->value);
    } catch (const Failure& f) {
      if (f.native != ERROR_FILE_NOT_FOUND) throw;
    }
    phase = "create-temp";
    auto staging = RelativeOpen(parent, temp, GENERIC_READ | GENERIC_WRITE | DELETE,
                                FILE_SHARE_READ, true);
    auto identity = Identity(staging.value, false);
    PrivateAcl(staging.value);
    phase = "write-temp";
    for (size_t offset = 0; offset < size;) {
      DWORD count = 0;
      if (!WriteFile(staging.value, static_cast<unsigned char*>(data) + offset,
                     static_cast<DWORD>(size - offset), &count, nullptr)) WinError("WriteFile");
      if (!count) throw Failure{"EIO", "zero-length WriteFile"};
      offset += count;
    }
    phase = "flush-temp";
    if (!FlushFileBuffers(staging.value)) WinError("FlushFileBuffers(temp)");
#ifdef JOURNAL_TEST_HOOKS
    if (testHook) Hook(env, args[4], "after-temp-flush");
#endif
    phase = "pre-publication";
    Match(RelativeIdentity(parent, temp), identity);
    Match(RelativeIdentity(parent, target), old ? Identity(old->value, false) : "missing");
    // Keep the original writer/DELETE handle: no close/reopen or path-based
    // source lookup, and no other writer/deleter can open this staging file.
    const DWORD nameBytes = static_cast<DWORD>(target.size() * sizeof(wchar_t));
    const DWORD renameBytes = static_cast<DWORD>(sizeof(FILE_RENAME_INFO)) + nameBytes;
    std::vector<unsigned char> storage(renameBytes, 0);
    auto rename = reinterpret_cast<FILE_RENAME_INFO*>(storage.data());
    rename->Flags = FILE_RENAME_FLAG_REPLACE_IF_EXISTS | FILE_RENAME_FLAG_POSIX_SEMANTICS;
    rename->RootDirectory = parent;
    rename->FileNameLength = nameBytes;
    std::memcpy(rename->FileName, target.data(), nameBytes);
    phase = "move";
    attempted = true;
    if (!SetFileInformationByHandle(staging.value, FileRenameInfoEx, rename, renameBytes)) {
      DWORD code = GetLastError();
      if (code == ERROR_INVALID_PARAMETER || code == ERROR_NOT_SUPPORTED ||
          code == ERROR_INVALID_FUNCTION || code == ERROR_CALL_NOT_IMPLEMENTED)
        throw Failure{"ENOTSUP", "FileRenameInfoEx POSIX replacement unsupported", code};
      WinError("SetFileInformationByHandle(FileRenameInfoEx)", code);
    }
#ifdef JOURNAL_TEST_HOOKS
    if (testHook) Hook(env, args[4], "after-move");
#endif
    phase = "flush-published";
    Match(RelativeIdentity(parent, target), identity);
    PrivateAcl(staging.value);
    // FileRenameInfoEx has no WRITE_THROUGH flag. Require explicit file and
    // directory flush receipts; never equate rename success with durable commit.
    if (!FlushFileBuffers(staging.value)) WinError("FlushFileBuffers(published)");
#ifdef JOURNAL_TEST_HOOKS
    if (testHook) Hook(env, args[4], "after-published-flush");
#endif
    if (old) old->Close();
    phase = "flush-directory";
    if (!FlushFileBuffers(parent)) WinError("FlushFileBuffers(directory)");
    staging.Close();
    pinned.ancestors.back().Close();
    auto result = Object(env);
    Bool(env, result, "supported", true);
    Bool(env, result, "published", true);
    Bool(env, result, "fileFlushed", true);
    Bool(env, result, "directoryFlushed", true);
    Set(env, result, "identity", String(env, identity));
    return result;
  } catch (const PendingException&) { return nullptr; }
    catch (const Failure& f) { return Error(env, f, phase, attempted); }
    catch (const std::exception& e) { return Error(env, "EIO", e.what(), 0, phase, attempted); }
    catch (...) { return Error(env, "EIO", "unknown native exception", 0, phase, attempted); }
}
napi_value DurableReplace(napi_env env, napi_callback_info info) {
  return DurableReplaceImpl(env, info, false);
}
#ifdef JOURNAL_TEST_HOOKS
napi_value DurableReplaceForTest(napi_env env, napi_callback_info info) {
  return DurableReplaceImpl(env, info, true);
}
#endif
napi_value WithExclusiveFile(napi_env env, napi_callback_info info) {
  try {
    auto args = Args(env, info, 3);
    auto dir = Directory(env, args[0]);
    PinnedDirectory pinned(dir);
    auto h = Open(dir + L"\\" + Name(env, args[1], false), GENERIC_READ, 0, OPEN_EXISTING);
    Identity(h.value, false);
    Hook(env, args[2], "exclusive-handle-held");
    h.Close();
    napi_value result;
    Check(napi_get_undefined(env, &result));
    return result;
  } catch (const PendingException&) { return nullptr; }
    catch (const Failure& f) { return Error(env, f, "exclusive-file", false); }
    catch (const std::exception& e) { return Error(env, "EIO", e.what(), 0, "exclusive-file", false); }
    catch (...) { return Error(env, "EIO", "unknown native exception", 0, "exclusive-file", false); }
}
#endif

napi_value Init(napi_env env, napi_value exports) {
  try {
  struct Entry { const char* name; napi_callback callback; };
  const Entry entries[] = {
    #ifdef _WIN32
    {"capabilities", Capabilities}, {"durableReplace", DurableReplace},
    {"syncDirectory", SyncDirectory},
#ifdef JOURNAL_TEST_HOOKS
    {"durableReplaceForTest", DurableReplaceForTest},
    {"inspect", Inspect}, {"probeDirectoryFlush", DirectoryProbe},
    {"replaceCandidate", ReplaceCandidate}, {"withExclusiveFile", WithExclusiveFile},
#endif
#else
    {"capabilities", StubCapabilities}, {"durableReplace", Unsupported},
    {"syncDirectory", Unsupported},
    {"inspect", Unsupported}, {"probeDirectoryFlush", Unsupported},
    {"replaceCandidate", Unsupported}, {"withExclusiveFile", Unsupported},
#endif
  };
  for (const auto& entry : entries) {
    napi_value function;
    if (napi_create_function(env, entry.name, NAPI_AUTO_LENGTH, entry.callback,
                             nullptr, &function) != napi_ok ||
        napi_set_named_property(env, exports, entry.name, function) != napi_ok) return nullptr;
  }
  Set(env, exports, "apiVersion", String(env, "1"));
#if defined(_M_ARM64) || defined(__aarch64__)
  Set(env, exports, "arch", String(env, "arm64"));
#elif defined(_M_X64) || defined(__x86_64__)
  Set(env, exports, "arch", String(env, "x64"));
#else
  Set(env, exports, "arch", String(env, "unsupported"));
#endif
  Set(env, exports, "napiVersion", String(env, "8"));
  return exports;
  } catch (...) { return Error(env, "EIO", "native journal initialization failed", 0, "init", false); }
}
}  // namespace
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
