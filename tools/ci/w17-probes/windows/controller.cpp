// Loaded only by the private PowerShell broker. Job and dynamic BFE handles
// remain in that process until all subject activity for the phase has stopped.
#include "token.hpp"
#include <aclapi.h>
#include <map>
#include <ntsecapi.h>
#include <objbase.h>

// Instantiate the SDK filter and layer GUIDs in this translation unit.
#include <initguid.h>

#include <fwpmu.h>

#define API extern "C" __declspec(dllexport) DWORD WINAPI
#define GUARD                                                                  \
  catch (DWORD e) {                                                            \
    return e;                                                                  \
  }                                                                            \
  catch (...) {                                                                \
    return ERROR_UNHANDLED_EXCEPTION;                                          \
  }
static HANDLE job{}, engine{};
static std::map<DWORD, PROCESS_INFORMATION> launched;
static void status(DWORD r) {
  if (r)
    throw r;
}
static void copy(const wstring &text, wchar_t *dst, DWORD cap) {
  if (text.size() >= cap)
    throw DWORD(ERROR_INSUFFICIENT_BUFFER);
  wcscpy_s(dst, cap, text.c_str());
}
API Launch(const wchar_t *user, const wchar_t *password, const wchar_t *exe,
           wchar_t *command, void *env, const wchar_t *cwd,
           const wchar_t *stderrPath, DWORD *pid) try {
  if (!job) {
    job = CreateJobObjectW(nullptr, nullptr);
    check(job != nullptr);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limit{};
    limit.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    check(SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                                  &limit, sizeof(limit)));
  }
  STARTUPINFOW si{sizeof(si)};
  si.lpDesktop = const_cast<LPWSTR>(L"winsta0\\default");
  PROCESS_INFORMATION pi{};
  HANDLE output = INVALID_HANDLE_VALUE, input = INVALID_HANDLE_VALUE;
  if (stderrPath && *stderrPath) {
    SECURITY_ATTRIBUTES sa{sizeof(sa), nullptr, TRUE};
    output = CreateFileW(stderrPath, FILE_APPEND_DATA, FILE_SHARE_READ, &sa,
                         CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    check(output != INVALID_HANDLE_VALUE);
    input =
        CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                    &sa, OPEN_EXISTING, 0, nullptr);
    if (input == INVALID_HANDLE_VALUE) {
      DWORD e = GetLastError();
      CloseHandle(output);
      return e;
    }
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdError = output;
    si.hStdOutput = output;
    si.hStdInput = input;
  }
  BOOL created = CreateProcessWithLogonW(
      user, L".", password, LOGON_WITH_PROFILE, exe, command,
      CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW, env,
      cwd, &si, &pi);
  DWORD launchError = created ? 0 : GetLastError();
  if (output != INVALID_HANDLE_VALUE)
    CloseHandle(output);
  if (input != INVALID_HANDLE_VALUE)
    CloseHandle(input);
  status(launchError);
  if (!AssignProcessToJobObject(job, pi.hProcess)) {
    DWORD e = GetLastError();
    TerminateProcess(pi.hProcess, 1);
    WaitForSingleObject(pi.hProcess, 5000);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return e;
  }
  // PID reuse requires the previous process object to have been released.
  launched.emplace(pi.dwProcessId, pi);
  *pid = pi.dwProcessId;
  return 0;
}
GUARD
API Resume(DWORD pid) try {
  auto &pi = launched.at(pid);
  check(ResumeThread(pi.hThread) != DWORD(-1));
  CloseHandle(pi.hThread);
  pi.hThread = nullptr;
  return 0;
}
GUARD
API ExitCode(DWORD pid, DWORD wait, DWORD *code) try {
  HANDLE h = launched.at(pid).hProcess;
  DWORD r = WaitForSingleObject(h, wait);
  if (r != WAIT_OBJECT_0)
    return r == WAIT_FAILED ? GetLastError() : r;
  check(GetExitCodeProcess(h, code));
  CloseHandle(h);
  launched.erase(pid);
  return 0;
}
GUARD
API Inspect(DWORD pid, wchar_t *buf, DWORD cap) try {
  HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  check(h != nullptr);
  try {
    copy(tokenJson(h), buf, cap);
  } catch (...) {
    CloseHandle(h);
    throw;
  }
  CloseHandle(h);
  return 0;
}
GUARD
static std::map<DWORD, HANDLE> pinned;
API Pin(DWORD pid, ULONGLONG expected) try {
  HANDLE h = OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION |
                             SYNCHRONIZE,
                         FALSE, pid);
  check(h != nullptr);
  try {
    BOOL member = FALSE;
    check(IsProcessInJob(h, job, &member));
    if (!job || !member || !expected || birth(h) != expected)
      throw DWORD(ERROR_INVALID_DATA);
    if (pinned.emplace(pid, h).second)
      return 0;
  } catch (...) {
    CloseHandle(h);
    throw;
  }
  CloseHandle(h);
  return 0;
}
GUARD
API Member(DWORD pid, DWORD *member) try {
  *member = 0;
  if (!job)
    return 0;
  HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  check(h != nullptr);
  BOOL inJob = FALSE;
  BOOL ok = IsProcessInJob(h, job, &inJob);
  DWORD rc = ok ? 0 : GetLastError();
  CloseHandle(h);
  *member = inJob;
  return rc;
}
GUARD
API KillChecked(DWORD pid, ULONGLONG expected) try {
  HANDLE h = pinned.at(pid);
  if (!expected || birth(h) != expected)
    return ERROR_INVALID_DATA;
  check(TerminateProcess(h, 17));
  status(WaitForSingleObject(h, 5000));
  CloseHandle(h);
  pinned.erase(pid);
  return 0;
}
GUARD
API JobCount(DWORD *count) try {
  if (!job) {
    *count = 0;
    return 0;
  }
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info{};
  check(QueryInformationJobObject(job, JobObjectBasicAccountingInformation,
                                  &info, sizeof(info), nullptr));
  *count = info.ActiveProcesses;
  return 0;
}
GUARD
API StopTree() try {
  if (!job)
    return 0;
  check(TerminateJobObject(job, 19));
  DWORD count = 0;
  for (int i = 0; i < 100; i++) {
    status(JobCount(&count));
    if (!count) {
      for (const auto &item : pinned)
        CloseHandle(item.second);
      pinned.clear();
      for (const auto &item : launched) {
        if (item.second.hThread)
          CloseHandle(item.second.hThread);
        CloseHandle(item.second.hProcess);
      }
      launched.clear();
      CloseHandle(job);
      job = nullptr;
      return 0;
    }
    Sleep(50);
  }
  return WAIT_TIMEOUT;
}
GUARD

static HANDLE desktopObject(int desk) {
  wchar_t station[256];
  DWORD bytes = 0;
  check(GetUserObjectInformationW(GetProcessWindowStation(), UOI_NAME, station,
                                  sizeof(station), &bytes));
  if (_wcsicmp(station, L"WinSta0"))
    throw DWORD(ERROR_INVALID_HANDLE);
  static HWINSTA winSta = nullptr;
  static HDESK desktop = nullptr;
  if (desk) {
    if (!desktop)
      desktop = OpenDesktopW(L"Default", 0, FALSE,
                             READ_CONTROL | WRITE_DAC | DESKTOP_READOBJECTS |
                                 DESKTOP_WRITEOBJECTS);
    check(desktop != nullptr);
    return desktop;
  }
  if (!winSta)
    winSta = OpenWindowStationW(L"WinSta0", FALSE, READ_CONTROL | WRITE_DAC);
  check(winSta != nullptr);
  return winSta;
}
API DesktopRead(int desk, wchar_t *buf, DWORD cap) try {
  SECURITY_INFORMATION what = DACL_SECURITY_INFORMATION;
  DWORD size = 0;
  GetUserObjectSecurity(desktopObject(desk), &what, nullptr, 0, &size);
  std::vector<BYTE> sd(size);
  check(GetUserObjectSecurity(desktopObject(desk), &what, sd.data(), size,
                              &size));
  LPWSTR str = nullptr;
  check(ConvertSecurityDescriptorToStringSecurityDescriptorW(
      sd.data(), SDDL_REVISION_1, what, &str, nullptr));
  wstring result(str);
  LocalFree(str);
  copy(result, buf, cap);
  return 0;
}
GUARD
API DesktopWrite(int desk, const wchar_t *sddl) try {
  PSECURITY_DESCRIPTOR sd = nullptr;
  check(ConvertStringSecurityDescriptorToSecurityDescriptorW(
      sddl, SDDL_REVISION_1, &sd, nullptr));
  SECURITY_INFORMATION what = DACL_SECURITY_INFORMATION;
  BOOL ok = SetUserObjectSecurity(desktopObject(desk), &what, sd);
  DWORD e = ok ? 0 : GetLastError();
  LocalFree(sd);
  return e;
}
GUARD

static GUID key(const wchar_t *text) {
  GUID id{};
  status(IIDFromString(text, &id));
  return id;
}
API WfpStart(const wchar_t *sid, const wchar_t *layer, const wchar_t *v4,
             const wchar_t *v6, UINT64 *id4, UINT64 *id6) try {
  if (engine)
    return ERROR_ALREADY_EXISTS;
  FWPM_SESSION0 session{};
  session.flags = FWPM_SESSION_FLAG_DYNAMIC;
  session.txnWaitTimeoutInMSec = 3000;
  status(
      FwpmEngineOpen0(nullptr, RPC_C_AUTHN_WINNT, nullptr, &session, &engine));
  PSECURITY_DESCRIPTOR sd = nullptr;
  try {
    status(FwpmTransactionBegin0(engine, 0));
    FWPM_SUBLAYER0 sub{};
    sub.subLayerKey = key(layer);
    sub.weight = 0xffff;
    sub.displayData.name = const_cast<wchar_t *>(L"W17 disposable SID probe");
    status(FwpmSubLayerAdd0(engine, &sub, nullptr));
    // SDDL numerical access masks use hexadecimal.
    std::wostringstream mask;
    mask << L"D:(A;;0x" << std::hex << FWP_ACTRL_MATCH_FILTER << L";;;" << sid
         << L")";
    DWORD size = 0;
    check(ConvertStringSecurityDescriptorToSecurityDescriptorW(
        mask.str().c_str(), SDDL_REVISION_1, &sd, &size));
    FWP_BYTE_BLOB blob{size, reinterpret_cast<UINT8 *>(sd)};
    FWPM_FILTER_CONDITION0 condition{};
    condition.fieldKey = FWPM_CONDITION_ALE_USER_ID;
    condition.matchType = FWP_MATCH_EQUAL;
    condition.conditionValue.type = FWP_SECURITY_DESCRIPTOR_TYPE;
    condition.conditionValue.sd = &blob;
    for (int i = 0; i < 2; i++) {
      FWPM_FILTER0 f{};
      f.filterKey = key(i ? v6 : v4);
      f.displayData.name = sub.displayData.name;
      f.layerKey =
          i ? FWPM_LAYER_ALE_AUTH_CONNECT_V6 : FWPM_LAYER_ALE_AUTH_CONNECT_V4;
      f.subLayerKey = sub.subLayerKey;
      f.action.type = FWP_ACTION_BLOCK;
      f.weight.type = FWP_EMPTY;
      f.filterCondition = &condition;
      f.numFilterConditions = 1;
      status(FwpmFilterAdd0(engine, &f, nullptr, i ? id6 : id4));
    }
    status(FwpmTransactionCommit0(engine));
  } catch (...) {
    if (sd)
      LocalFree(sd);
    FwpmTransactionAbort0(engine);
    FwpmEngineClose0(engine);
    engine = nullptr;
    throw;
  }
  LocalFree(sd);
  return 0;
}
GUARD
API WfpClose() {
  if (!engine)
    return 0;
  DWORD r = FwpmEngineClose0(engine);
  if (!r)
    engine = nullptr;
  return r;
}
API WfpAbsent(const wchar_t *layer, const wchar_t *v4, const wchar_t *v6) try {
  HANDLE h;
  status(FwpmEngineOpen0(nullptr, RPC_C_AUTHN_WINNT, nullptr, nullptr, &h));
  DWORD result = 0;
  for (int i = 0; i < 3; i++) {
    GUID id = key(i == 0 ? layer : i == 1 ? v4 : v6);
    void *data = nullptr;
    DWORD r = i ? FwpmFilterGetByKey0(h, &id,
                                      reinterpret_cast<FWPM_FILTER0 **>(&data))
                : FwpmSubLayerGetByKey0(
                      h, &id, reinterpret_cast<FWPM_SUBLAYER0 **>(&data));
    if (data)
      FwpmFreeMemory0(&data);
    if (r != (i ? FWP_E_FILTER_NOT_FOUND : FWP_E_SUBLAYER_NOT_FOUND))
      result = r ? r : ERROR_ALREADY_EXISTS;
  }
  status(FwpmEngineClose0(h));
  return result;
}
GUARD
API Audit(int write, DWORD *setting) try {
  HANDLE token;
  check(OpenProcessToken(GetCurrentProcess(),
                         TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, &token));
  TOKEN_PRIVILEGES privilege{};
  privilege.PrivilegeCount = 1;
  check(LookupPrivilegeValueW(nullptr, SE_SECURITY_NAME,
                              &privilege.Privileges[0].Luid));
  privilege.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED;
  BOOL adjusted =
      AdjustTokenPrivileges(token, FALSE, &privilege, 0, nullptr, nullptr);
  DWORD adjustment = GetLastError();
  CloseHandle(token);
  if (!adjusted || adjustment)
    return adjustment ? adjustment : ERROR_PRIVILEGE_NOT_HELD;
  GUID guid =
      key(L"{0CCE9226-69AE-11D9-BED3-505054503030}"); // Filtering Platform
                                                      // Connection
  PAUDIT_POLICY_INFORMATION info = nullptr;
  check(AuditQuerySystemPolicy(&guid, 1, &info));
  DWORD r = 0;
  if (write) {
    info->AuditingInformation = *setting;
    if (!AuditSetSystemPolicy(info, 1))
      r = GetLastError();
  } else
    *setting = info->AuditingInformation;
  AuditFree(info);
  return r;
}
GUARD

// Read the actual system filter named by 5157. Only a block at the specified
// connect layer with an explicit applicable package predicate can corroborate
// the fallback. A concurrent unrelated firewall drop does not qualify.
API ContainerFilter(UINT64 id, int ipv6, const wchar_t *sid,
                    DWORD *matches) try {
  HANDLE h;
  status(FwpmEngineOpen0(nullptr, RPC_C_AUTHN_WINNT, nullptr, nullptr, &h));
  FWPM_FILTER0 *f = nullptr;
  DWORD rc = FwpmFilterGetById0(h, id, &f);
  *matches = 0;
  if (!rc) {
    if (f->action.type == FWP_ACTION_BLOCK &&
        IsEqualGUID(f->layerKey, ipv6 ? FWPM_LAYER_ALE_AUTH_CONNECT_V6
                                      : FWPM_LAYER_ALE_AUTH_CONNECT_V4)) {
      for (UINT32 i = 0; i < f->numFilterConditions; i++) {
        auto &c = f->filterCondition[i];
        if (IsEqualGUID(c.fieldKey, FWPM_CONDITION_ALE_PACKAGE_ID) &&
            c.conditionValue.type == FWP_SID) {
          auto conditionSid = sidText(c.conditionValue.sid);
          if ((c.matchType == FWP_MATCH_EQUAL && conditionSid == sid) ||
              (c.matchType == FWP_MATCH_NOT_EQUAL &&
               conditionSid == L"S-1-0-0"))
            *matches = 1;
        }
      }
    }
    FwpmFreeMemory0(reinterpret_cast<void **>(&f));
  }
  status(FwpmEngineClose0(h));
  return rc;
}
GUARD
