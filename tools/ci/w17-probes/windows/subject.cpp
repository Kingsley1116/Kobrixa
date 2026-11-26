// Unprivileged, staged x64 client. No credentials or controller IPC.
#include "token.hpp"
#include <chrono>
#include <filesystem>
#include <fstream>
#include <objbase.h>
#include <userenv.h>
#include <shlobj.h>
#pragma comment(lib, "shell32.lib")
#include <winsock2.h>
#include <ws2tcpip.h>

static void emit(const wchar_t *path, const wstring &line) {
  int n = WideCharToMultiByte(CP_UTF8, 0, line.data(), int(line.size()),
                              nullptr, 0, nullptr, nullptr);
  std::string utf8(n, 0);
  WideCharToMultiByte(CP_UTF8, 0, line.data(), int(line.size()), utf8.data(), n,
                      nullptr, nullptr);
  std::ofstream f(std::filesystem::path(path), std::ios::binary);
  f.exceptions(std::ios::failbit | std::ios::badbit);
  f << utf8;
  f.close();
}
static bool callback = false;
static LRESULT CALLBACK proc(HWND hwnd, UINT msg, WPARAM w, LPARAM l) {
  if (msg == WM_APP + 1) {
    callback = true;
    return 0;
  }
  return DefWindowProcW(hwnd, msg, w, l);
}
static wstring objectName(HANDLE h) {
  wchar_t name[256];
  DWORD n;
  check(GetUserObjectInformationW(h, UOI_NAME, name, sizeof(name), &n));
  return name;
}
static wstring window() {
  WNDCLASSW wc{};
  wc.lpfnWndProc = proc;
  wc.hInstance = GetModuleHandleW(nullptr);
  wc.lpszClassName = L"W17Probe";
  check(RegisterClassW(&wc) != 0);
  HWND h = CreateWindowW(wc.lpszClassName, L"W17", WS_OVERLAPPEDWINDOW,
                         CW_USEDEFAULT, CW_USEDEFAULT, 220, 120, nullptr,
                         nullptr, wc.hInstance, nullptr);
  DWORD error = h ? 0 : GetLastError();
  if (h) {
    ShowWindow(h, SW_SHOW);
    check(PostMessageW(h, WM_APP + 1, 0, 0));
    MSG m;
    for (int i = 0; i < 100 && !callback; i++) {
      while (PeekMessageW(&m, nullptr, 0, 0, PM_REMOVE)) {
        TranslateMessage(&m);
        DispatchMessageW(&m);
      }
      Sleep(5);
    }
  }
  HKEY hk{};
  LONG hkcu = RegOpenCurrentUser(KEY_READ, &hk);
  if (hk)
    RegCloseKey(hk);
  HANDLE token;
  check(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token));
  wchar_t profile[32768];
  DWORD size = 32768;
  BOOL ok = GetUserProfileDirectoryW(token, profile, &size);
  DWORD profileError = ok ? 0 : GetLastError();
  auto user = tokenInfo(token, TokenUser);
  auto sid = sidText(reinterpret_cast<TOKEN_USER *>(user.data())->User.Sid);
  CloseHandle(token);
  if (profileError)
    throw profileError;
  HKEY loaded{};
  LONG loadedHive =
      RegOpenKeyExW(HKEY_USERS, sid.c_str(), 0, KEY_READ, &loaded);
  if (loaded)
    RegCloseKey(loaded);
  std::wostringstream s;
  s << L"\"windowError\":" << error << L",\"visible\":"
    << (h && IsWindowVisible(h)) << L",\"callback\":" << callback
    << L",\"hkcu\":" << hkcu << L",\"loadedHive\":" << loadedHive
    << L",\"profile\":" << jsonString(profile) << L",\"station\":"
    << jsonString(objectName(GetProcessWindowStation())) << L",\"desktop\":"
    << jsonString(objectName(GetThreadDesktop(GetCurrentThreadId())));
  if (h)
    DestroyWindow(h);
  return s.str();
}
static wstring network(wchar_t **a) {
  WSADATA data;
  int error = WSAStartup(MAKEWORD(2, 2), &data);
  if (error)
    throw DWORD(error);
  bool tcp = wstring(a[3]) == L"tcp";
  const wchar_t *host = a[4];
  int af = wcschr(host, L':') ? AF_INET6 : AF_INET;
  SOCKADDR_STORAGE remote{}, local{};
  auto addr = [&](SOCKADDR_STORAGE &storage, USHORT port) {
    if (af == AF_INET) {
      auto p = reinterpret_cast<SOCKADDR_IN *>(&storage);
      p->sin_family = AF_INET;
      p->sin_port = htons(port);
      if (InetPtonW(af, host, &p->sin_addr) != 1)
        throw DWORD(ERROR_INVALID_ADDRESS);
      return int(sizeof(*p));
    }
    auto p = reinterpret_cast<SOCKADDR_IN6 *>(&storage);
    p->sin6_family = AF_INET6;
    p->sin6_port = htons(port);
    if (InetPtonW(af, host, &p->sin6_addr) != 1)
      throw DWORD(ERROR_INVALID_ADDRESS);
    return int(sizeof(*p));
  };
  int len = addr(remote, (USHORT)_wtoi(a[5]));
  addr(local, (USHORT)_wtoi(a[6]));
  SOCKET sock = socket(af, tcp ? SOCK_STREAM : SOCK_DGRAM, 0);
  if (sock == INVALID_SOCKET)
    throw DWORD(WSAGetLastError());
  wstring step = L"bind";
  auto start = std::chrono::steady_clock::now();
  if (bind(sock, reinterpret_cast<sockaddr *>(&local), len))
    error = WSAGetLastError();
  else {
    step = L"connect";
    if (connect(sock, reinterpret_cast<sockaddr *>(&remote), len))
      error = WSAGetLastError();
    else {
      wstring w(a[7]);
      std::string nonce(w.begin(), w.end());
      if (tcp)
        nonce += '\n';
      step = L"send";
      if (send(sock, nonce.data(), int(nonce.size()), 0) == SOCKET_ERROR)
        error = WSAGetLastError();
      else {
        DWORD timeout = 2000;
        setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, (char *)&timeout,
                   sizeof(timeout));
        char reply[128];
        std::string received;
        step = L"reply";
        do {
          int bytes = recv(sock, reply, sizeof(reply), 0);
          if (bytes < 0) {
            error = WSAGetLastError();
            break;
          }
          if (!bytes)
            break;
          received.append(reply, bytes);
        } while (tcp && received.size() < 128 &&
                 received.find('\n') == std::string::npos);
        if (!error && received != "reply:" + nonce)
          error = ERROR_INVALID_DATA;
      }
    }
  }
  auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - start)
                .count();
  closesocket(sock);
  WSACleanup();
  return L"\"step\":" + jsonString(step) + L",\"wsa\":" +
         std::to_wstring(error) + L",\"elapsed\":" + std::to_wstring(ms);
}
static wstring folderIdentity(const wstring &path) {
  HANDLE dir = CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr);
  if (dir == INVALID_HANDLE_VALUE) return L"";
  BY_HANDLE_FILE_INFORMATION info{};
  BOOL ok = GetFileInformationByHandle(dir, &info);
  CloseHandle(dir);
  if (!ok || !(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) ||
      (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) return L"";
  return std::to_wstring(info.dwVolumeSerialNumber) + L"/" +
      std::to_wstring((ULONGLONG(info.nFileIndexHigh) << 32) | info.nFileIndexLow);
}
static wstring container(const wstring &action, wchar_t **a) {
  PSID sid = nullptr;
  HRESULT hr;
  if (action == L"container-delete" || action == L"container-query") {
    // A derived SID exists even for an absent profile. Query its folder in
    // HKCU.
    hr = DeriveAppContainerSidFromAppContainerName(a[3], &sid);
    if (FAILED(hr))
      throw DWORD(hr);
    auto text = sidText(sid);
    FreeSid(sid);
    PWSTR folder = nullptr;
    hr = GetAppContainerFolderPath(text.c_str(), &folder);
    const wstring apiFolder = folder ? folder : L"";
    if (folder)
      CoTaskMemFree(folder);
    // The staged environment overrides LOCALAPPDATA. Resolve the logon user's
    // registered known folder independently of the AppContainer mapping.
    PWSTR local = nullptr;
    HRESULT known = SHGetKnownFolderPath(FOLDERID_LocalAppData,
                                         KF_FLAG_DONT_VERIFY, nullptr, &local);
    HANDLE token = nullptr;
    wchar_t profile[32768]{};
    DWORD chars = 32768;
    DWORD profileError = 0;
    wstring owner;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token))
      profileError = GetLastError();
    else {
      auto user = tokenInfo(token, TokenUser);
      owner = sidText(reinterpret_cast<TOKEN_USER *>(user.data())->User.Sid);
      if (!GetUserProfileDirectoryW(token, profile, &chars))
        profileError = GetLastError();
      CloseHandle(token);
    }
    const wstring localAppData = local ? local : L"";
    wstring expected;
    // A redirected or environment-derived folder is unresolved on this probe.
    // Require agreement with the real loaded profile before recording absence.
    if (!profileError && *profile && SUCCEEDED(known) &&
        !_wcsicmp(localAppData.c_str(),
                  (wstring(profile) + L"\\AppData\\Local").c_str()))
      expected = localAppData + L"\\Packages\\" + a[3];
    if (local)
      CoTaskMemFree(local);
    auto attributesError = [](const wstring &path) -> wstring {
      if (path.empty())
        return L"null";
      DWORD attrs = GetFileAttributesW(path.c_str());
      return std::to_wstring(attrs == INVALID_FILE_ATTRIBUTES ? GetLastError()
                                                              : 0);
    };
    const wstring key = L"Software\\Classes\\Local "
                        L"Settings\\Software\\Microsoft\\Windows\\CurrentVersio"
                        L"n\\AppContainer\\Mappings\\" +
                        text;
    HKEY mapping{};
    LSTATUS mappingStatus =
        RegOpenKeyExW(HKEY_CURRENT_USER, key.c_str(), 0, KEY_READ, &mapping);
    if (mappingStatus == ERROR_SUCCESS)
      RegCloseKey(mapping);
    auto folderId = folderIdentity(apiFolder);
    if (action == L"container-delete") {
      // Repeat the receipt checks in the deleting logon, directly before the API.
      if (owner != a[4] || text != a[5] || mappingStatus != ERROR_SUCCESS ||
          FAILED(hr) || expected.empty() || _wcsicmp(expected.c_str(), a[6]) ||
          _wcsicmp(apiFolder.c_str(), a[6]) || folderId.empty() || folderId != a[7])
        throw DWORD(ERROR_REVISION_MISMATCH);
      hr = DeleteAppContainerProfile(a[3]);
      if (FAILED(hr)) throw DWORD(hr);
      return container(L"container-query", a);
    }
    return L"\"container\":" + jsonString(text) + L",\"mapping\":" +
           std::to_wstring(mappingStatus) + L",\"query\":" +
           std::to_wstring(DWORD(hr)) + L",\"folderError\":" +
           attributesError(apiFolder) + L",\"folder\":" +
           jsonString(apiFolder) + L",\"folderId\":" + jsonString(folderId) + L",\"profileQueryError\":" +
           std::to_wstring(profileError) + L",\"profileRoot\":" +
           jsonString(profileError ? L"" : profile) + L",\"localAppData\":" +
           jsonString(localAppData) + L",\"knownFolderResult\":" +
           std::to_wstring(DWORD(known)) + L",\"expectedFolder\":" +
           jsonString(expected) + L",\"expectedFolderError\":" +
           attributesError(expected);
  }
  if (action == L"container-create")
    hr = CreateAppContainerProfile(a[3], a[3], L"W17 disposable", nullptr, 0,
                                   &sid);
  else
    hr = DeriveAppContainerSidFromAppContainerName(a[3], &sid);
  if (FAILED(hr))
    throw DWORD(hr);
  wstring result = L"\"container\":" + jsonString(sidText(sid));
  if (action == L"container-create") {
    result += L",\"createResult\":" + std::to_wstring(DWORD(hr));
    PWSTR folder = nullptr;
    hr = GetAppContainerFolderPath(sidText(sid).c_str(), &folder);
    result += L",\"folder\":" +
              (SUCCEEDED(hr) ? jsonString(folder) : wstring(L"null"));
    result += L",\"folderId\":" + jsonString(folder ? folderIdentity(folder) : L"");
    if (folder)
      CoTaskMemFree(folder);
  }
  if (action == L"container-launch") {
    std::ifstream input(std::filesystem::path(a[5]),
                        std::ios::binary | std::ios::ate);
    auto byteCount = input.tellg();
    if (byteCount <= 0 || byteCount > 65534 ||
        (static_cast<std::streamoff>(byteCount) % 2))
      throw DWORD(ERROR_INVALID_DATA);
    std::vector<wchar_t> command(static_cast<size_t>(byteCount) / 2 + 1, 0);
    input.seekg(0);
    input.read(reinterpret_cast<char *>(command.data()),
               static_cast<std::streamsize>(byteCount));
    if (!input)
      throw DWORD(ERROR_READ_FAULT);
    SECURITY_CAPABILITIES caps{};
    caps.AppContainerSid = sid;
    SIZE_T bytes = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &bytes);
    std::vector<BYTE> storage(bytes);
    auto attrs = (LPPROC_THREAD_ATTRIBUTE_LIST)storage.data();
    check(InitializeProcThreadAttributeList(attrs, 1, 0, &bytes));
    check(UpdateProcThreadAttribute(attrs, 0,
                                    PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
                                    &caps, sizeof(caps), nullptr, nullptr));
    STARTUPINFOEXW si{};
    si.StartupInfo.cb = sizeof(si);
    si.lpAttributeList = attrs;
    PROCESS_INFORMATION pi{};
    BOOL capture = FALSE;
    if (GetFileType(GetStdHandle(STD_ERROR_HANDLE)) == FILE_TYPE_DISK) {
      si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
      si.StartupInfo.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
      si.StartupInfo.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
      si.StartupInfo.hStdError = GetStdHandle(STD_ERROR_HANDLE);
      capture = TRUE;
    }
    check(CreateProcessW(a[4], command.data(), nullptr, nullptr, capture,
                         EXTENDED_STARTUPINFO_PRESENT |
                             CREATE_UNICODE_ENVIRONMENT,
                         nullptr, nullptr, &si.StartupInfo, &pi));
    CloseHandle(pi.hThread);
    result += L",\"child\":" + std::to_wstring(pi.dwProcessId);
    // The parent lives until the child exits; both are in the controller's job.
    emit(a[1], L"{" + result + L"}");
    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD code;
    check(GetExitCodeProcess(pi.hProcess, &code));
    CloseHandle(pi.hProcess);
    DeleteProcThreadAttributeList(attrs);
    FreeSid(sid);
    ExitProcess(code);
  }
  FreeSid(sid);
  return result;
}
int wmain(int argc, wchar_t **a) {
  if (argc < 3)
    return ERROR_INVALID_PARAMETER;
  try {
    wstring action = a[2], detail;
    if (action == L"window")
      detail = window();
    else if (action == L"files") {
      detail = L"\"opens\":[";
      for (int i = 3; i < argc; i++) {
        HANDLE f =
            CreateFileW(a[i], GENERIC_READ,
                        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                        nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
        DWORD e = f == INVALID_HANDLE_VALUE ? GetLastError() : 0, count = 0;
        char c;
        if (!e) {
          if (!ReadFile(f, &c, 1, &count, nullptr))
            e = GetLastError();
          CloseHandle(f);
        }
        if (i > 3)
          detail += L",";
        detail += L"{\"path\":" + jsonString(a[i]) + L",\"error\":" +
                  std::to_wstring(e) + L",\"bytes\":" + std::to_wstring(count) +
                  L"}";
      }
      detail += L"]";
    } else if (action == L"flow" && argc == 8)
      detail = network(a);
    else if (action == L"memory" && argc == 4) {
      HANDLE h = OpenProcess(PROCESS_VM_READ, FALSE, _wtoi(a[3]));
      DWORD e = h ? 0 : GetLastError();
      if (h)
        CloseHandle(h);
      detail = L"\"targetPid\":" + std::to_wstring(_wtoi(a[3])) + L",\"error\":" + std::to_wstring(e);
    } else if (action.rfind(L"container-", 0) == 0 && argc >= 4 &&
             (action != L"container-delete" || argc == 8))
      detail = container(action, a);
    else
      return ERROR_INVALID_PARAMETER;
    emit(a[1], L"{\"token\":" + tokenJson(GetCurrentProcess()) + L"," + detail +
                   L"}");
    return 0;
  } catch (DWORD e) {
    emit(a[1], L"{\"error\":" + std::to_wstring(e) + L"}");
    return int(e ? e : 1);
  } catch (...) {
    return ERROR_UNHANDLED_EXCEPTION;
  }
}
