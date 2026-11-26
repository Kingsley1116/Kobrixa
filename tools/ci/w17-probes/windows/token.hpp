// Kernel identity and birth samples shared by the controller and subject.
#pragma once
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

// SDDL declarations depend on Windows types.
#include <iomanip>
#include <sddl.h>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

using std::wstring;
inline void check(BOOL ok) {
  if (!ok)
    throw GetLastError();
}
inline wstring jsonString(const wstring &value) {
  std::wostringstream out;
  out << L'"';
  for (wchar_t c : value) {
    if (c == L'\\' || c == L'"')
      out << L'\\' << c;
    else if (c < 32)
      out << L"\\u" << std::hex << std::setw(4) << std::setfill(L'0')
          << unsigned(c);
    else
      out << c;
  }
  return out.str() + L'"';
}
inline wstring sidText(PSID sid) {
  LPWSTR text = nullptr;
  check(ConvertSidToStringSidW(sid, &text));
  wstring value(text);
  LocalFree(text);
  return value;
}
inline std::vector<BYTE> tokenInfo(HANDLE token, TOKEN_INFORMATION_CLASS type) {
  DWORD bytes = 0;
  GetTokenInformation(token, type, nullptr, 0, &bytes);
  if (!bytes)
    throw GetLastError();
  std::vector<BYTE> data(bytes);
  check(GetTokenInformation(token, type, data.data(), bytes, &bytes));
  return data;
}
inline ULONGLONG birth(HANDLE process) {
  FILETIME c, e, k, u;
  check(GetProcessTimes(process, &c, &e, &k, &u));
  return (ULONGLONG(c.dwHighDateTime) << 32) | c.dwLowDateTime;
}
inline wstring tokenJson(HANDLE process) {
  HANDLE token;
  check(OpenProcessToken(process, TOKEN_QUERY, &token));
  try {
    auto user = tokenInfo(token, TokenUser),
         groups = tokenInfo(token, TokenGroups),
         privs = tokenInfo(token, TokenPrivileges),
         caps = tokenInfo(token, TokenCapabilities),
         integrity = tokenInfo(token, TokenIntegrityLevel),
         restricted = tokenInfo(token, TokenRestrictedSids),
         app = tokenInfo(token, TokenAppContainerSid);
    auto number = [&](TOKEN_INFORMATION_CLASS type) {
      auto b = tokenInfo(token, type);
      return *reinterpret_cast<DWORD *>(b.data());
    };
    auto g = reinterpret_cast<TOKEN_GROUPS *>(groups.data());
    auto privileges = reinterpret_cast<TOKEN_PRIVILEGES *>(privs.data());
    auto appSid = reinterpret_cast<TOKEN_APPCONTAINER_INFORMATION *>(app.data())
                      ->TokenAppContainer;
    auto label =
        reinterpret_cast<TOKEN_MANDATORY_LABEL *>(integrity.data())->Label.Sid;
    DWORD level =
        *GetSidSubAuthority(label, *GetSidSubAuthorityCount(label) - 1);
    wstring logon;
    std::wostringstream s;
    s << L"{\"pid\":" << GetProcessId(process) << L",\"birth\":"
      << jsonString(std::to_wstring(birth(process))) << L",\"sid\":"
      << jsonString(
             sidText(reinterpret_cast<TOKEN_USER *>(user.data())->User.Sid))
      << L",\"session\":" << number(TokenSessionId) << L",\"elevated\":"
      << number(TokenElevation) << L",\"isContainer\":"
      << number(TokenIsAppContainer) << L",\"container\":"
      << (appSid ? jsonString(sidText(appSid)) : L"null")
      << L",\"capabilities\":"
      << reinterpret_cast<TOKEN_GROUPS *>(caps.data())->GroupCount
      << L",\"integrity\":" << level << L",\"restrictedSids\":"
      << reinterpret_cast<TOKEN_GROUPS *>(restricted.data())->GroupCount
      << L",\"groups\":[";
    for (DWORD i = 0; i < g->GroupCount; i++) {
      auto id = sidText(g->Groups[i].Sid);
      if ((g->Groups[i].Attributes & SE_GROUP_LOGON_ID) == SE_GROUP_LOGON_ID)
        logon = id;
      if (i)
        s << L",";
      s << jsonString(id);
    }
    s << L"],\"logon\":" << jsonString(logon) << L",\"privileges\":[";
    for (DWORD i = 0; i < privileges->PrivilegeCount; i++) {
      wchar_t name[256];
      DWORD len = 256;
      check(LookupPrivilegeNameW(nullptr, &privileges->Privileges[i].Luid, name,
                                 &len));
      if (i)
        s << L",";
      s << L"{\"name\":" << jsonString(name) << L",\"attributes\":"
        << privileges->Privileges[i].Attributes << L"}";
    }
    CloseHandle(token);
    return s.str() + L"]}";
  } catch (...) {
    CloseHandle(token);
    throw;
  }
}
