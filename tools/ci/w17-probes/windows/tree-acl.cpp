#include "token.hpp"
#include <aclapi.h>
#include <filesystem>
#include <fstream>
#include <memory>
#include <set>
#include <tuple>
#include <winternl.h>

// Pass the entire descriptor to the single opened NTFS object. The high-level
// Advapi ACL setters can walk descendants and take only a PACL.
extern "C" NTSYSAPI NTSTATUS NTAPI NtSetSecurityObject(
    HANDLE, SECURITY_INFORMATION, PSECURITY_DESCRIPTOR);
#pragma comment(lib, "ntdll.lib")

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
// DACL-only SDDL from ConvertSecurityDescriptorToStringSecurityDescriptor.
// AR is a write request. Never edit ACE text or discard P, AI or ACE order.
wstring persistedSddl(wstring value) {
  const auto pos = value.find(L"AR");
  if (pos != wstring::npos && pos < value.find(L'('))
    value.erase(pos, 2);
  return value;
}

struct Observation {
  const wchar_t *site = L"snapshot-sddl";
  wstring snapshot = L"-", expected = L"-", before = L"-", observed = L"-";
  wstring expectedBefore = L"-", request = L"-", setRc = L"not-called";

  void requireDacl(bool present) {
    if (!present) {
      site = L"null-dacl";
      throw DWORD(ERROR_INVALID_ACL);
    }
  }

  void requireBefore(bool inheritedOnly) {
    if (before != expectedBefore && !inheritedOnly) {
      site = L"before-conflict";
      throw DWORD(ERROR_REVISION_MISMATCH);
    }
  }

  void verifyAfter(DWORD rc) {
    if (rc) {
      site = L"set";
      throw rc;
    }
    if (observed != expected) {
      site = L"post-mismatch";
      throw DWORD(ERROR_INVALID_DATA);
    }
    site = L"verified";
  }

  wstring line(const wchar_t *phase, DWORD index, const Entry &e, DWORD rc) const {
    std::wostringstream out;
    out << L"dacl phase=" << phase << L" index=" << index << L" site=" << site
        << L" rc=" << rc << L" setRc=" << setRc
        << L" path=" << jsonString(e.path) << L" request=" << request
        << L" snapshot=" << snapshot << L" expected=" << expected
        << L" expectedBefore=" << expectedBefore << L" before=" << before
        << L" observed=" << observed << L"\n";
    return out.str();
  }
};

void appendTrace(const wchar_t *path, const wstring &line) {
  int chars = static_cast<int>(line.size());
  int bytes = WideCharToMultiByte(CP_UTF8, 0, line.data(), chars, nullptr, 0,
                                  nullptr, nullptr);
  check(bytes > 0);
  std::string utf8(bytes, '\0');
  check(WideCharToMultiByte(CP_UTF8, 0, line.data(), chars, utf8.data(), bytes,
                            nullptr, nullptr));
  std::ofstream out(std::filesystem::path(path), std::ios::binary | std::ios::app);
  out.exceptions(std::ios::badbit | std::ios::failbit);
  out.write(utf8.data(), bytes);
  out.close();
}

void verifyFile(File &file, const Entry &e) {
  BY_HANDLE_FILE_INFORMATION now{};
  check(GetFileInformationByHandle(file.handle, &now));
  if ((!(now.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) &&
       now.nNumberOfLinks != 1) ||
      identity(now) != identity(e.info) ||
      (now.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT))
    throw DWORD(ERROR_FILE_INVALID);
}

// Accept an indirect change only if removing precisely this probe's inherited
// deny recovers the entire snapshot, including P, AI and the other ACEs' order.
bool inheritedDenyOnly(std::vector<BYTE> current, PSID sid, DWORD mask,
                       DWORD inheritance, const wstring &snapshot) {
  BOOL present, defaulted;
  PACL acl = nullptr;
  check(GetSecurityDescriptorDacl(current.data(), &present, &acl, &defaulted));
  if (!present || !acl)
    return false;
  for (DWORD i = 0; i < acl->AceCount; ++i) {
    void *raw = nullptr;
    check(GetAce(acl, i, &raw));
    auto ace = static_cast<ACCESS_DENIED_ACE *>(raw);
    if (ace->Header.AceType == ACCESS_DENIED_ACE_TYPE &&
        ace->Header.AceFlags == (inheritance | INHERITED_ACE) &&
        ace->Mask == mask && EqualSid(&ace->SidStart, sid)) {
      check(DeleteAce(acl, i));
      return sddl(current.data()) == snapshot;
    }
  }
  return false;
}

// Prepend exactly one explicit deny, preserving the original ACE bytes/order.
// Directory ACEs still apply to future children created under the fixture.
std::vector<BYTE> withDeny(PACL old, PSID sid, DWORD rights, BYTE inheritance) {
  ACL_SIZE_INFORMATION size{};
  check(GetAclInformation(old, &size, sizeof(size), AclSizeInformation));
  DWORD bytes = size.AclBytesInUse + FIELD_OFFSET(ACCESS_DENIED_ACE, SidStart) +
                GetLengthSid(sid);
  if (bytes > MAXWORD)
    throw DWORD(ERROR_ALLOTTED_SPACE_EXCEEDED);
  std::vector<BYTE> data(bytes);
  auto acl = reinterpret_cast<PACL>(data.data());
  check(InitializeAcl(acl, bytes, old->AclRevision));
  check(AddAccessDeniedAceEx(acl, old->AclRevision, inheritance, rights, sid));
  if (old->AceCount) {
    void *first = nullptr;
    check(GetAce(old, 0, &first));
    check(AddAce(acl, old->AclRevision, MAXDWORD, first,
                 size.AclBytesInUse - static_cast<DWORD>(sizeof(ACL))));
  }
  return data;
}

void change(Entry &e, PSID sid, bool restore, bool skipped, Observation &o) {
  o.snapshot = sddl(e.sd.data());
  if (restore)
    o.expected = o.snapshot;
  o.site = L"open";
  constexpr DWORD query = FILE_READ_ATTRIBUTES | READ_CONTROL;
  // Unwind must count untouched originals even if only READ_CONTROL is granted.
  if (restore) {
    File reader(e.path, query);
    o.site = L"identity";
    verifyFile(reader, e);
    o.site = L"read-before";
    o.before = o.observed = sddl(dacl(reader.handle).data());
    if (o.before == o.snapshot) {
      o.expectedBefore = o.snapshot;
      o.site = L"already-original";
      return;
    }
  }
  o.site = L"open";
  File file(e.path, query | (skipped ? 0 : WRITE_DAC));
  o.site = L"identity";
  verifyFile(file, e);
  o.site = L"read-before";
  auto current = dacl(file.handle);
  o.before = o.observed = sddl(current.data());
  o.site = L"snapshot-dacl";
  BOOL present, defaulted;
  PACL old = nullptr;
  check(GetSecurityDescriptorDacl(e.sd.data(), &present, &old, &defaulted));
  o.requireDacl(present && old);
  constexpr DWORD rights = FILE_GENERIC_READ & ~SYNCHRONIZE;
  const BYTE inheritance = (e.info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)
                               ? SUB_CONTAINERS_AND_OBJECTS_INHERIT
                               : NO_INHERITANCE;
  o.site = L"build-acl";
  auto data = withDeny(old, sid, rights, inheritance);
  auto acl = reinterpret_cast<PACL>(data.data());

  o.site = L"build-descriptor";
  SECURITY_DESCRIPTOR sd{};
  SECURITY_DESCRIPTOR_CONTROL flags{};
  DWORD revision;
  check(GetSecurityDescriptorControl(e.sd.data(), &flags, &revision));
  check(InitializeSecurityDescriptor(&sd, SECURITY_DESCRIPTOR_REVISION));
  check(SetSecurityDescriptorDacl(&sd, TRUE, acl, FALSE));
  constexpr SECURITY_DESCRIPTOR_CONTROL mask =
      SE_DACL_PROTECTED | SE_DACL_AUTO_INHERITED | SE_DACL_AUTO_INHERIT_REQ;
  auto control = flags & (SE_DACL_PROTECTED | SE_DACL_AUTO_INHERITED);
  if (control & SE_DACL_AUTO_INHERITED)
    control |= SE_DACL_AUTO_INHERIT_REQ;
  check(SetSecurityDescriptorControl(&sd, mask,
                                     static_cast<SECURITY_DESCRIPTOR_CONTROL>(control)));
  const auto installed = persistedSddl(sddl(&sd));
  o.expected = restore ? o.snapshot : installed;
  o.expectedBefore = restore ? installed : o.snapshot;
  if (skipped) {
    o.site = L"not-attempted";
    return;
  }
  o.requireBefore(restore && o.before != installed &&
                  inheritedDenyOnly(current, sid, rights, inheritance, o.snapshot));
  if (restore)
    check(SetSecurityDescriptorDacl(&sd, TRUE, old, FALSE));
  o.request = sddl(&sd);
  o.site = L"set";
  o.observed = L"-";
  NTSTATUS status = NtSetSecurityObject(file.handle, DACL_SECURITY_INFORMATION, &sd);
  DWORD rc = status < 0 ? RtlNtStatusToDosError(status) : ERROR_SUCCESS;
  o.setRc = std::to_wstring(rc);
  o.site = L"read-after";
  o.observed = sddl(dacl(file.handle).data());
  o.verifyAfter(rc);
}

void collectChildren(const wstring &name, std::vector<wstring> &pending) {
  WIN32_FIND_DATAW data;
  HANDLE scan = FindFirstFileW((name + L"\\*").c_str(), &data);
  if (scan == INVALID_HANDLE_VALUE) {
    DWORD err = GetLastError();
    if (err == ERROR_FILE_NOT_FOUND)
      return;
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
} // namespace
// Snapshot format is private, run-local and consumed by the same compiled DLL.
extern "C" __declspec(dllexport) DWORD WINAPI
TreeSaveTrace(const wchar_t *root, const wchar_t *output, DWORD *count,
              const wchar_t *log) try {
  std::ofstream f(std::filesystem::path(output), std::ios::binary);
  f.exceptions(std::ios::failbit | std::ios::badbit);
  std::set<std::tuple<DWORD, DWORD, DWORD>> seen;
  std::vector<wstring> pending{wstring(L"\\\\?\\") + root};
  *count = 0;
  while (!pending.empty()) {
    if (*count >= (log ? 7u : 64u))
      throw DWORD(ERROR_BUFFER_OVERFLOW);
    wstring name = pending.back();
    pending.pop_back();
    Entry e;
    e.path = name;
    Observation o;
    try {
      o.site = L"open";
      File file(name, FILE_READ_ATTRIBUTES | READ_CONTROL);
      o.site = L"identity";
      check(GetFileInformationByHandle(file.handle, &e.info));
      if ((e.info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
          (!(e.info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) &&
           e.info.nNumberOfLinks != 1) ||
          !seen.insert(identity(e.info)).second)
        throw DWORD(ERROR_FILE_INVALID);
      o.site = L"read-snapshot";
      e.sd = dacl(file.handle);
      if (log)
        o.snapshot = o.expected = o.observed = sddl(e.sd.data());
      o.site = L"save-snapshot";
      store(f, e);
      if (e.info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
        o.site = L"enumerate";
        collectChildren(name, pending);
      }
    } catch (DWORD error) {
      if (log)
        appendTrace(log, o.line(L"snapshot", *count, e, error));
      throw;
    }
    if (log) {
      o.site = L"saved";
      appendTrace(log, o.line(L"snapshot", *count, e, 0));
    }
    ++*count;
  }
  f.close();
  return 0;
} catch (DWORD e) {
  return e;
} catch (...) {
  return ERROR_WRITE_FAULT;
}

extern "C" __declspec(dllexport) DWORD WINAPI TreeSave(
    const wchar_t *root, const wchar_t *output, DWORD *count) {
  return TreeSaveTrace(root, output, count, nullptr);
}

extern "C" __declspec(dllexport) DWORD WINAPI
TreeChangeTrace(const wchar_t *manifest, DWORD count, const wchar_t *sidTextValue,
                int restore, DWORD *checked, const wchar_t *log) try {
  *checked = 0;
  if (count > 64 || (log && count > 7))
    return ERROR_BUFFER_OVERFLOW;
  std::ifstream f(std::filesystem::path(manifest), std::ios::binary);
  f.exceptions(std::ios::failbit | std::ios::badbit);
  PSID sid = nullptr;
  check(ConvertStringSidToSidW(sidTextValue, &sid));
  std::unique_ptr<void, decltype(&LocalFree)> owned(sid, LocalFree);
  DWORD firstError = 0;
  for (DWORD i = 0; i < count; ++i) {
    Entry e = load(f);
    Observation o;
    DWORD rc = ERROR_SUCCESS;
    bool skipped = firstError && !restore;
    try {
      change(e, sid, restore != 0, skipped, o);
      if (!skipped)
        ++*checked;
      else
        rc = ERROR_OPERATION_ABORTED;
    } catch (DWORD error) {
      rc = error;
      if (!firstError)
        firstError = rc;
    }
    if (log || rc) {
      auto line = o.line(restore ? L"restore" : L"apply", i, e, rc);
      if (log) {
        try {
          appendTrace(log, line);
        } catch (...) {
          // A failed observer must not prevent the rest of the unwind.
          if (!firstError)
            firstError = ERROR_WRITE_FAULT;
        }
      } else {
        std::ofstream conflict(std::filesystem::path(wstring(manifest) + L".conflicts"),
                               std::ios::binary | std::ios::app);
        conflict.write(reinterpret_cast<const char *>(line.data()),
                       line.size() * sizeof(wchar_t));
      }
    }
    if (rc && !restore && !log)
      return rc;
  }
  if (f.peek() != std::char_traits<char>::eof())
    throw DWORD(ERROR_INVALID_DATA);
  return firstError;
} catch (DWORD e) {
  return e;
} catch (...) {
  return ERROR_READ_FAULT;
}

extern "C" __declspec(dllexport) DWORD WINAPI
TreeChange(const wchar_t *manifest, DWORD count, const wchar_t *sid,
           int restore, DWORD *checked) {
  return TreeChangeTrace(manifest, count, sid, restore, checked, nullptr);
}
