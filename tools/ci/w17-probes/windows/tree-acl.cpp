// Snapshot first, then change existing NTFS objects through individual handles.
// A MAXIMUM_ALLOWED SetSecurityInfo handle suppresses automatic propagation.
// Each record binds the original DACL to the volume and file ID. New files
// inherit the deny.
#include "token.hpp"
#include <aclapi.h>
#include <filesystem>
#include <fstream>
#include <set>
#include <tuple>

namespace {
struct File {
  HANDLE handle;
  File(const wstring &path, DWORD rights)
      : handle(CreateFileW(
            path.c_str(), rights,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            nullptr)) {
    check(handle != INVALID_HANDLE_VALUE);
  }
  ~File() { CloseHandle(handle); }
};
struct Entry {
  wstring path;
  BY_HANDLE_FILE_INFORMATION info{};
  std::vector<BYTE> sd;
};
auto identity(const BY_HANDLE_FILE_INFORMATION &f) {
  return std::make_tuple(f.dwVolumeSerialNumber, f.nFileIndexHigh,
                         f.nFileIndexLow);
}
std::vector<BYTE> dacl(HANDLE h) {
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  DWORD rc = GetSecurityInfo(h, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                             nullptr, nullptr, nullptr, nullptr, &descriptor);
  if (rc)
    throw rc;
  auto begin = static_cast<BYTE *>(descriptor);
  std::vector<BYTE> result(begin,
                           begin + GetSecurityDescriptorLength(descriptor));
  LocalFree(descriptor);
  return result;
}
wstring sddl(PSECURITY_DESCRIPTOR sd) {
  LPWSTR s = nullptr;
  check(ConvertSecurityDescriptorToStringSecurityDescriptorW(
      sd, SDDL_REVISION_1, DACL_SECURITY_INFORMATION, &s, nullptr));
  wstring value(s);
  LocalFree(s);
  return value;
}
template <class T> void write(std::ofstream &f, const T &value) {
  f.write(reinterpret_cast<const char *>(&value), sizeof(value));
}
template <class T> void read(std::ifstream &f, T &value) {
  f.read(reinterpret_cast<char *>(&value), sizeof(value));
}
void store(std::ofstream &f, const Entry &e) {
  DWORD chars = static_cast<DWORD>(e.path.size()),
        bytes = static_cast<DWORD>(e.sd.size());
  write(f, chars);
  write(f, bytes);
  write(f, e.info);
  f.write(reinterpret_cast<const char *>(e.path.data()),
          chars * sizeof(wchar_t));
  f.write(reinterpret_cast<const char *>(e.sd.data()), bytes);
}
Entry load(std::ifstream &f) {
  Entry e;
  DWORD chars = 0, bytes = 0;
  read(f, chars);
  read(f, bytes);
  read(f, e.info);
  if (!chars || chars > 32768 || !bytes || bytes > 1024 * 1024)
    throw DWORD(ERROR_INVALID_DATA);
  e.path.resize(chars);
  e.sd.resize(bytes);
  f.read(reinterpret_cast<char *>(e.path.data()), chars * sizeof(wchar_t));
  f.read(reinterpret_cast<char *>(e.sd.data()), bytes);
  if (!IsValidSecurityDescriptor(e.sd.data()))
    throw DWORD(ERROR_INVALID_SECURITY_DESCR);
  return e;
}
void change(File &file, const Entry &e, PSID sid, bool restore,
            const wchar_t *manifest) {
  BOOL present, defaulted;
  PACL old = nullptr;
  check(GetSecurityDescriptorDacl(const_cast<BYTE *>(e.sd.data()), &present,
                                  &old, &defaulted));
  // Replacing a NULL DACL by a single deny ACE would deny everybody.
  if (!present || !old)
    throw DWORD(ERROR_INVALID_ACL);
  EXPLICIT_ACCESSW access{};
  access.grfAccessPermissions = FILE_GENERIC_READ & ~SYNCHRONIZE;
  access.grfAccessMode = DENY_ACCESS;
  access.grfInheritance = (e.info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)
                              ? SUB_CONTAINERS_AND_OBJECTS_INHERIT
                              : NO_INHERITANCE;
  BuildTrusteeWithSidW(&access.Trustee, sid);
  PACL acl = nullptr;
  DWORD rc = SetEntriesInAclW(1, &access, old, &acl);
  if (rc)
    throw rc;
  try {
    SECURITY_DESCRIPTOR desired{};
    SECURITY_DESCRIPTOR_CONTROL flags{};
    DWORD revision = 0;
    check(GetSecurityDescriptorControl(const_cast<BYTE *>(e.sd.data()), &flags,
                                       &revision));
    check(InitializeSecurityDescriptor(&desired, SECURITY_DESCRIPTOR_REVISION));
    check(SetSecurityDescriptorDacl(&desired, TRUE, acl, FALSE));
    constexpr SECURITY_DESCRIPTOR_CONTROL mask =
        SE_DACL_PROTECTED | SE_DACL_AUTO_INHERITED | SE_DACL_AUTO_INHERIT_REQ;
    check(SetSecurityDescriptorControl(&desired, mask, flags & mask));
    const auto original = sddl(const_cast<BYTE *>(e.sd.data()));
    const auto installed = sddl(&desired);
    const auto current = sddl(dacl(file.handle).data());
    if (current != (restore ? installed : original)) {
      std::ofstream conflict(
          std::filesystem::path(wstring(manifest) + L".conflicts"),
          std::ios::binary | std::ios::app);
      const wstring detail = e.path + L" current=" + current + L" installed=" +
                             installed + L" original=" + original + L"\n";
      conflict.write(reinterpret_cast<const char *>(detail.data()),
                     detail.size() * sizeof(wchar_t));
      throw DWORD(ERROR_REVISION_MISMATCH);
    }
    rc = SetSecurityInfo(file.handle, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                         nullptr, nullptr, restore ? old : acl, nullptr);
    if (rc)
      throw rc;
    if (sddl(dacl(file.handle).data()) != (restore ? original : installed))
      throw DWORD(ERROR_INVALID_ACL);
  } catch (...) {
    LocalFree(acl);
    throw;
  }
  LocalFree(acl);
}
} // namespace
// Snapshot format is private, run-local and consumed by the same compiled DLL.
extern "C" __declspec(dllexport) DWORD WINAPI TreeSave(const wchar_t *root,
                                                       const wchar_t *output,
                                                       DWORD *count) try {
  std::ofstream f(std::filesystem::path(output), std::ios::binary);
  f.exceptions(std::ios::failbit | std::ios::badbit);
  std::set<std::tuple<DWORD, DWORD, DWORD>> seen;
  std::vector<wstring> pending{wstring(L"\\\\?\\") + root};
  *count = 0;
  while (!pending.empty()) {
    wstring name = pending.back();
    pending.pop_back();
    File file(name, FILE_READ_ATTRIBUTES | READ_CONTROL);
    Entry e;
    e.path = name;
    check(GetFileInformationByHandle(file.handle, &e.info));
    if ((e.info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
        (!(e.info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) &&
         e.info.nNumberOfLinks != 1))
      throw DWORD(ERROR_FILE_INVALID);
    if (!seen.insert(identity(e.info)).second)
      throw DWORD(ERROR_FILE_INVALID);
    e.sd = dacl(file.handle);
    store(f, e);
    if (++(*count) > 64)
      throw DWORD(ERROR_BUFFER_OVERFLOW);
    if (!(e.info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY))
      continue;
    WIN32_FIND_DATAW data;
    HANDLE scan = FindFirstFileW((name + L"\\*").c_str(), &data);
    if (scan == INVALID_HANDLE_VALUE) {
      DWORD err = GetLastError();
      if (err == ERROR_FILE_NOT_FOUND)
        continue;
      throw err;
    }
    do {
      if (wcscmp(data.cFileName, L".") && wcscmp(data.cFileName, L".."))
        pending.push_back(name + L"\\" + data.cFileName);
    } while (FindNextFileW(scan, &data));
    DWORD err = GetLastError();
    FindClose(scan);
    if (err != ERROR_NO_MORE_FILES)
      throw err;
  }
  f.close();
  return 0;
} catch (DWORD e) {
  return e;
} catch (...) {
  return ERROR_WRITE_FAULT;
}

extern "C" __declspec(dllexport) DWORD WINAPI
TreeChange(const wchar_t *manifest, DWORD count, const wchar_t *sidTextValue,
           int restore, DWORD *checked) try {
  std::ifstream f(std::filesystem::path(manifest), std::ios::binary);
  f.exceptions(std::ios::failbit | std::ios::badbit);
  PSID sid = nullptr;
  check(ConvertStringSidToSidW(sidTextValue, &sid));
  *checked = 0;
  DWORD firstError = 0;
  try {
    for (DWORD i = 0; i < count; i++) {
      Entry e = load(f);
      auto verify = [&](File &file) {
        BY_HANDLE_FILE_INFORMATION now{};
        check(GetFileInformationByHandle(file.handle, &now));
        if ((!(now.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) &&
             now.nNumberOfLinks != 1) ||
            identity(now) != identity(e.info) ||
            (now.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT))
          throw DWORD(ERROR_FILE_INVALID);
      };
      try {
        if (restore) {
          File query(e.path, READ_CONTROL | FILE_READ_ATTRIBUTES);
          verify(query);
          if (sddl(dacl(query.handle).data()) == sddl(e.sd.data())) {
            (*checked)++;
            continue;
          }
        }
        File file(e.path, MAXIMUM_ALLOWED);
        verify(file);
        change(file, e, sid, restore != 0, manifest);
        (*checked)++;
      } catch (DWORD error) {
        if (!restore)
          throw;
        if (!firstError)
          firstError = error;
      }
    }
    if (f.peek() != std::char_traits<char>::eof())
      throw DWORD(ERROR_INVALID_DATA);
  } catch (...) {
    LocalFree(sid);
    throw;
  }
  LocalFree(sid);
  return firstError;
} catch (DWORD e) {
  return e;
} catch (...) {
  return ERROR_READ_FAULT;
}
