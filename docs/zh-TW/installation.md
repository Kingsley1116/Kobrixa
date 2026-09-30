# 安裝與復原

## Release 下載

從 [GitHub Releases](https://github.com/Kingsley1116/Kobrixa/releases) 選擇已公開版本，先閱讀該版逐平台的簽章狀態。建置中或未完成草稿尚不可作為安裝版本。

| 平台                | 壓縮包                               | 解壓後啟動    |
| ------------------- | ------------------------------------ | ------------- |
| Windows x64         | `Kobrixa-<version>-win32-x64.zip`    | `kobrixa.exe` |
| macOS Apple Silicon | `Kobrixa-<version>-darwin-arm64.zip` | `Kobrixa.app` |
| Linux x64           | `Kobrixa-<version>-linux-x64.tar.gz` | `kobrixa`     |

將壓縮包與同名 `.sha256` 檔下載至同一目錄，並將以下範例中的 `<version>` 換成下載版本。Windows PowerShell 可計算雜湊，再與校驗碼檔的第一欄比較：

```powershell
Get-FileHash -Algorithm SHA256 'Kobrixa-<version>-win32-x64.zip'
Get-Content 'Kobrixa-<version>-win32-x64.zip.sha256'
```

macOS：

```sh
shasum -a 256 -c 'Kobrixa-<version>-darwin-arm64.zip.sha256'
```

Linux：

```sh
sha256sum -c 'Kobrixa-<version>-linux-x64.tar.gz.sha256'
```

完整解壓並保留目錄結構與權限，執行檔須與資源及原生模組放在一起。目前沒有安裝程式或自動更新；更新時將新版本解壓至獨立目錄，專案應放在應用程式目錄之外。

校驗碼只能檢查位元組是否改變，不能驗證發行者身分。macOS 版本可能已完成 Developer ID 簽章與公證；Windows 依版本可能未簽章或採 SignPath 簽章。請依[程式碼簽章政策](../zh-TW/code-signing.md)與該版 Release 說明判斷。若宣稱已簽章的版本驗證失敗，回報版本與校驗碼；SmartScreen 信譽警告與 Authenticode 有效性分開記錄。USB／Wi-Fi 實機驗收狀態另見[設備支援](../zh-TW/device-support.md)。

## 開發版

安裝 Node.js 24 與倉庫鎖定的 pnpm 10.15.0，執行 `pnpm install --frozen-lockfile` 後使用 `pnpm dev`。`pnpm package` 會為目前作業系統產生未簽署的開發版應用程式，不需要 Apple 或 SignPath 憑證。

在 Debian／Ubuntu 上，請先安裝原生 USB 模組的建置依賴，再執行 `pnpm install` 或封裝：

```sh
sudo apt-get update
sudo apt-get install -y build-essential pkg-config libusb-1.0-0-dev libudev-dev
```

### CI 與開發版下載

**CI** workflow 會在 pull request、push 到 `main` 與手動執行時啟動。共通格式、根目錄設定的 lint 及 CI 分流測試在 Ubuntu 執行一次，產品檢查依完整 Git 差異分流：

- `apps/web/` 與 `docs/` 變更：執行網站型別／lint、前端／IR 與 Worker 測試，以及網站建置。
- `apps/desktop/`、`examples/`、`tests/`、桌面工具及桌面 release workflow 變更：在 Ubuntu 24.04 x64、Windows Server 2022 x64 (Visual Studio 2022)、macOS 26 arm64 執行桌面檢查、核心／桌面測試與封裝。此矩陣不執行網站測試。
- 共用套件、語言前端、素材、鎖檔、根目錄設定與 CI 工具變更：兩邊都驗證。未識別路徑也會跑兩邊；只有根目錄 README、貢獻說明或授權文件變更時，只跑共通檢查。
- 手動執行一律跑兩邊；比較歷史不可用時也跑兩邊。重新命名和刪除會計入原本路徑。

`CI result` 保留原有必要檢查名稱。只有分流明確判定未受影響的產品工作可以跳過；失敗、取消，或必要工作意外跳過，都不會通過。同一分支或 pull request 有新 commit 時，會取消舊的 CI 執行。

使用 `pnpm check:common` 執行共通檢查。網站依序執行 `pnpm check:web`、`pnpm test:web`、`pnpm build:web`。桌面依序執行 `pnpm check:desktop`、`pnpm build:core`、`pnpm test:desktop`、`pnpm build:desktop`、`pnpm package:archive`。封裝指令會在暫存目錄解壓產物，驗證完整檔案樹、權限、符號連結及 USB 模組，再寫入 SHA-256 校驗碼。各作業系統仍須安裝原生模組的建置依賴。`pnpm check:ci` 與 `pnpm test:ci` 仍保留為全倉庫本機檢查；桌面 tag 發布使用共通及桌面檢查，不執行網站建置／測試。

一般 CI 不上傳應用程式。若要下載開發版，請手動執行 **CI** 並啟用 **upload_artifacts**；壓縮包與校驗碼會保留 7 天。既有 Actions 儲存配額不足仍會阻擋這項選用上傳；縮短保留天數不會刪除舊產物。最終 Release 下載直接使用 Release assets；啟用 Windows 簽章時，額外需要保留一天的暫存 Actions artifact。

### 桌面 Release 草稿

1. 將根目錄及所有 workspace 的 `package.json` 設為相同 SemVer 版本，必要時更新 lockfile，再將版本變更合併到 `main`。
2. 為既有 commit 推送版本 tag，例如 `v0.1.0-v1-candidate.0`。**Desktop Release** workflow 會拒絕格式錯誤、套件版本不符或不屬於 `main` 歷史的 commit。
3. 流程建立標示 **建置中 / Building** 的草稿，驗證 tag 指定的確切 commit，各平台直接上傳壓縮包與校驗碼到草稿。版本有預發行後綴時，草稿會標示為 prerelease。
4. 所有檢查成功，且六個產物皆下載並通過校驗碼驗證後，草稿改為 **待發布 / Ready for manual publication**，附上來源 commit 與自動產生的版本紀錄。請檢閱後手動公開；流程不會自動發布。

六個最終產物為上表的三個壓縮包與各自的 `.sha256` 檔。簽章預設關閉；啟用 macOS 後須通過 Developer ID 簽章與公證，啟用 Windows 後須通過已核准的 SignPath 簽章與時間戳驗證。Linux 維持未簽章，目前不提供 Intel Mac 套件。封裝前後都檢查授權聲明、原生模組、檔案內容、符號連結與執行權限，並在啟用時驗證簽章。憑證、核准與隱私說明見[程式碼簽章政策](../zh-TW/code-signing.md)。

先完成 Apple 憑證設定，第一個 Windows 版本明確標示未簽章。倉庫與可使用的版本公開後，再申請 SignPath Foundation，核准後才啟用 Windows 簽章。啟用後失敗不會改用未簽章產物；簽章請求被拒或等待人工核准超過 60 分鐘時保留未完成草稿。草稿記錄簽章模式，相同 tag 的重跑不得混用不同模式。

執行失敗時會保留未完成草稿，並在 workflow 摘要列出各平台結果。可為相同 tag 與 commit 重跑失敗工作，只替換相符的草稿產物。tag 被移動、草稿由手動建立或無法辨識、Release 已公開時，流程會拒絕更新。校驗碼或最終確認失敗也不會將草稿標示為待發布。請勿公開未完成草稿或移動發布 tag。同一 tag 的 Release 執行會序列化，不取消正在執行的工作。

不需要新增 GitHub personal access token：一般 CI 只有倉庫讀取權限，Release 寫入工作使用具備 `contents: write` 的 `GITHUB_TOKEN`。啟用簽章時另須 Apple 憑證或 SignPath API token。倉庫改公開與 Release 發布維持人工操作。使用下一個預定發布的版本 tag 驗證第一份真實草稿，不為測試流程另外公開測試版本。

評估改善效果時，請比較 Actions 中第一次冷快取與後續暖快取執行的各工作耗時、總 runner 分鐘數及壓縮包大小，並使用相近的 commit 與相同 runner 平台，不預設固定加速比例。流程只依作業系統、架構與 lockfile 快取 pnpm store，不快取 `node_modules` 或已編譯的原生模組。

編輯器與編譯器不需要雲端帳號或網路連線；Wi‑Fi 只用於與 EV3 通訊。

## USB

診斷存取問題時，先只連接一台 EV3。「權限不足」與「找不到裝置」會分別回報。Linux 僅應為 LEGO vendor `0694`、EV3 product `0005` 建立範圍精確的 udev 規則，不要對所有 HID 開放權限；變更規則後重新連接 EV3。

## Wi-Fi

EV3 與電腦必須位於同一個可信任網路。搜尋會接收 IPv4 UDP 3015 廣播，也可直接輸入 EV3 位址；連線使用 TCP 5555。找不到設備、連線被拒絕或逾時時，檢查這些 port 與本機防火牆。

## 復原

- 可取消停滯操作並重新連線，不必重新啟動 Kobrixa。
- 輸出提交前的編譯錯誤或取消會保留既有成品。輸出檔逐一提交；若提交階段失敗，請重新成功建置後再部署。
- 上傳中斷線會回報錯誤，EV3 可能留下未完成檔案；重連、確認目的地後再次上傳。
- 編輯器未儲存草稿存放於本機應用程式資料，重新開啟專案時會復原。
