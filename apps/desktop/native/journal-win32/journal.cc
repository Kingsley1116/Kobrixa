// W02a feasibility prototype. Nothing here enables production journal admission.
// Candidate receipts describe completed syscalls, NOT verified crash durability.
#include <node_api.h>
#include <stdexcept>
#include <string>
#include <vector>
#ifdef _WIN32
#include <windows.h>
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
#ifdef _WIN32
void Number(napi_env env, napi_value obj, const char* key, unsigned long value) {
  napi_value v;
  Check(napi_create_uint32(env, value, &v));
  Set(env, obj, key, v);
}
napi_value Error(napi_env env, const Failure& f, const char* phase,
                 bool publicationAttempted) {
  napi_value err;
  Check(napi_create_error(env, String(env, f.code), String(env, f.message), &err));
  Number(env, err, "win32Code", f.native);
  Set(env, err, "phase", String(env, phase));
  Set(env, err, "publicationState",
      String(env, publicationAttempted ? "uncertain" : "not-published"));
  Check(napi_throw(env, err));
  return nullptr;
}
#endif
napi_value Unsupported(napi_env env, napi_callback_info) {
  napi_throw_error(env, "ENOTSUP",
      "Windows journal durability is unverified; production remains fail-closed");
  return nullptr;
}
napi_value Capabilities(napi_env env, napi_callback_info) {
  auto obj = Object(env);
#ifdef _WIN32
  Bool(env, obj, "prototypeAvailable", true);
#else
  Bool(env, obj, "prototypeAvailable", false);
#endif
  Bool(env, obj, "supported", false);
  Set(env, obj, "status", String(env, "to be verified on a Windows runner"));
  return obj;
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
    const std::wstring prefix = L"faults.next-";
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
struct PinnedDirectory {
  std::vector<Handle> ancestors;
  std::string identity;
  explicit PinnedDirectory(const std::wstring& path) {
    auto drive = path.substr(0, 3);
    if (GetDriveTypeW(drive.c_str()) != DRIVE_FIXED)
      throw Failure{"ENOTSUP", "remote/removable/unknown volume is unverified"};
    // OPEN_REPARSE_POINT affects the final component only: walk and pin every ancestor.
    size_t end = 2;
    for (;;) {
      auto prefix = path.substr(0, end == 2 ? 3 : end);
      auto h = Open(prefix, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE,
                    OPEN_EXISTING);
      identity = Identity(h.value, true);
      ancestors.push_back(std::move(h));
      if (end == path.size()) break;
      end = path.find(L'\\', end + 1);
      if (end == std::wstring::npos) end = path.size();
    }
    wchar_t fs[32]{};
    if (!GetVolumeInformationW(drive.c_str(), nullptr, 0, nullptr, nullptr, nullptr, fs, 32))
      WinError("GetVolumeInformationW");
    if (std::wstring(fs) != L"NTFS")
      throw Failure{"ENOTSUP", "only local NTFS is a prototype candidate"};
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
    catch (const std::exception& e) { return Error(env, {"EIO", e.what()}, "inspect", false); }
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
    catch (const std::exception& e) { return Error(env, {"EIO", e.what()}, phase, false); }
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
    // Path-based check/move race remains an explicit production blocker.
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
    catch (const std::exception& e) { return Error(env, {"EIO", e.what()}, phase, attempted); }
}
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
    catch (const std::exception& e) { return Error(env, {"EIO", e.what()}, "exclusive-file", false); }
}
#endif

napi_value Init(napi_env env, napi_value exports) {
  struct Entry { const char* name; napi_callback callback; };
  const Entry entries[] = {
    {"capabilities", Capabilities}, {"durableReplace", Unsupported},
#ifdef _WIN32
    {"inspect", Inspect}, {"probeDirectoryFlush", DirectoryProbe},
    {"replaceCandidate", ReplaceCandidate}, {"withExclusiveFile", WithExclusiveFile},
#else
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
  return exports;
}
}  // namespace
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
