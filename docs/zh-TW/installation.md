# 安裝與復原

## Release 下載

從 [GitHub Releases](https://github.com/Kingsley1116/Kobrixa/releases) 選擇已公開版本，依作業系統下載下表的檔案並安裝。所有後續桌面發行版本都內建 updater，安裝後即可在「設定 → 更新」管理更新。建置中或未完成草稿尚不可作為安裝版本。

| 平台                | 下載檔案                                | 安裝方式                                     |
| ------------------- | --------------------------------------- | -------------------------------------------- |
| Windows x64         | `Kobrixa-<version>-win32-x64-setup.exe` | 執行安裝程式，安裝至目前使用者帳戶           |
| macOS Apple Silicon | `Kobrixa-<version>-darwin-arm64.dmg`    | 開啟 DMG，將 `Kobrixa.app` 拖入 Applications |
| Linux x64           | `Kobrixa-<version>-linux-x64.AppImage`  | 放在使用者可寫入的位置，設為可執行後啟動     |

`<version>` 代表下載的版本號。專案應放在應用程式目錄之外。Windows 未簽章安裝程式可能顯示系統警告；請閱讀該版逐平台的簽章狀態，詳見[程式碼簽章政策](../zh-TW/code-signing.md)。USB／Wi-Fi 實機驗收狀態另見[設備支援](../zh-TW/device-support.md)。

### SHA-256 校驗（選用）

SHA-256 校驗是選用步驟，不影響安裝與使用。若想確認下載檔案是否完整，可另行下載同名 `.sha256` 檔，與安裝檔放在同一目錄，並將以下範例中的 `<version>` 換成下載版本。

Windows PowerShell：計算雜湊，與校驗碼檔的第一欄比較。

```powershell
Get-FileHash -Algorithm SHA256 'Kobrixa-<version>-win32-x64-setup.exe'
Get-Content 'Kobrixa-<version>-win32-x64-setup.exe.sha256'
```

macOS：

```sh
shasum -a 256 -c 'Kobrixa-<version>-darwin-arm64.dmg.sha256'
```

Linux：

```sh
sha256sum -c 'Kobrixa-<version>-linux-x64.AppImage.sha256'
```

校驗碼可檢查下載內容是否與發行檔一致；發行者身分依程式碼簽章驗證。此處的選用步驟是手動校驗下載檔案，updater 仍會自動驗證其下載的更新。

## 自動更新

Windows 安裝版與 Linux AppImage 可自動下載新版，並在確認後安裝。macOS 自動安裝要求目前與目標版本均具有效 Apple 簽章；未簽章版本會提示新版並提供下載頁，使用上表的安裝方式更新。

「設定 → 更新」顯示版本、進度與檢查結果。預設在啟動 30 秒後及每 6 小時檢查並下載正式版；可關閉背景檢查，或開啟預覽版（包括 `v1-candidate`）。切回正式版不會降版。沒有正式版時會顯示提示，可手動選擇接收預覽版。手動「檢查更新」仍會下載可用更新。

下載完成後可選「稍後」，一般退出不安裝；只有「重新啟動並更新」才啟動安裝。未儲存內容須先選「儲存全部並更新」，儲存失敗會保留草稿並停止安裝。編譯、設備傳輸、專案／設備檔案操作進行時不能重啟更新。重啟後重新開啟原專案即可繼續，既有設定與草稿資料位置保持不變。

更新來源固定為本倉庫公開的 GitHub Releases，不內嵌存取 token。倉庫仍私有或離線時，設定頁顯示無法存取；不會影響編輯。來源公開、各平台產物完整且版本已人工公開後才可下載。下載／校驗失敗可重試；安裝未完成時可從 Releases 重新下載安裝，專案與使用者資料不刪除。開發模式不連線檢查更新。

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

使用 `pnpm check:common` 執行共通檢查。網站依序執行 `pnpm check:web`、`pnpm test:web`、`pnpm build:web`。桌面依序執行 `pnpm check:desktop`、`pnpm build:core`、`pnpm test:desktop`、`pnpm build:desktop`、`pnpm test:desktop:packaged`、`pnpm package:installers`、`pnpm package:archive`、`pnpm package:updates`。封裝指令會在暫存目錄解壓產物，驗證完整檔案樹、權限、符號連結及 USB 模組，再寫入 SHA-256 校驗碼。各作業系統仍須安裝原生模組的建置依賴。`pnpm check:ci` 與 `pnpm test:ci` 仍保留為全倉庫本機檢查；桌面 tag 發布使用共通及桌面檢查，不執行網站建置／測試。

一般 CI 不上傳應用程式。若要下載開發版，請手動執行 **CI** 並啟用 **upload_artifacts**；壓縮包與校驗碼會保留 7 天。既有 Actions 儲存配額不足仍會阻擋這項選用上傳；縮短保留天數不會刪除舊產物。最終 Release 下載直接使用 Release assets；啟用 Windows 簽章時，額外需要保留一天的暫存 Actions artifact。

### 桌面 Release 草稿

1. 將根目錄及所有 workspace 的 `package.json` 設為相同 SemVer 版本，必要時更新 lockfile，再將版本變更合併到 `main`。
2. 為既有 commit 推送版本 tag，例如 `v0.1.0-v1-candidate.0`。**Desktop Release** workflow 會拒絕格式錯誤、套件版本不符或不屬於 `main` 歷史的 commit。
3. 流程建立標示 **建置中 / Building** 的草稿，驗證 tag 指定的確切 commit，各平台直接上傳壓縮包、安裝包、更新資訊與校驗碼到草稿。版本有預發行後綴時，草稿會標示為 prerelease。
4. 所有檢查成功，且所有壓縮包、安裝包與更新資訊皆下載並通過驗證後，草稿改為 **待發布 / Ready for manual publication**，附上來源 commit 與自動產生的版本紀錄。請檢閱後手動公開；流程不會自動發布。

最終產物包含三個原有壓縮包、Windows NSIS 安裝程式、Linux AppImage、macOS DMG 與更新用 ZIP，以及每個下載檔的 `.sha256`。另有 Windows／Linux 更新 metadata；僅已簽章 macOS 版本提供 `latest-mac.yml`。簽章預設關閉；啟用 macOS 後須通過 Developer ID 簽章與公證，啟用 Windows 後須通過已核准的 SignPath 簽章與時間戳驗證。Linux 維持未簽章，目前不提供 Intel Mac 套件。封裝前後都檢查授權聲明、原生模組、檔案內容、符號連結與執行權限，並在啟用時驗證簽章。憑證、核准與隱私說明見[程式碼簽章政策](../zh-TW/code-signing.md)。

先完成 Apple 憑證設定，第一個 Windows 版本明確標示未簽章。倉庫與可使用的版本公開後，再申請 SignPath Foundation，核准後才啟用 Windows 簽章。啟用後失敗不會改用未簽章產物；簽章請求被拒或等待人工核准超過 60 分鐘時保留未完成草稿。草稿記錄簽章模式，相同 tag 的重跑不得混用不同模式。

執行失敗時會保留未完成草稿，並在 workflow 摘要列出各平台結果。可為相同 tag 與 commit 重跑失敗工作，只替換相符的草稿產物。tag 被移動、草稿由手動建立或無法辨識、Release 已公開時，流程會拒絕更新。校驗碼或最終確認失敗也不會將草稿標示為待發布。請勿公開未完成草稿或移動發布 tag。同一 tag 的 Release 執行會序列化，不取消正在執行的工作。

不需要新增 GitHub personal access token：一般 CI 只有倉庫讀取權限，Release 寫入工作使用具備 `contents: write` 的 `GITHUB_TOKEN`。啟用簽章時另須 Apple 憑證或 SignPath API token。倉庫改公開與 Release 發布維持人工操作。使用下一個預定發布的版本 tag 驗證第一份真實草稿，不為測試流程另外公開測試版本。

評估改善效果時，請比較 Actions 中第一次冷快取與後續暖快取執行的各工作耗時、總 runner 分鐘數及壓縮包大小，並使用相近的 commit 與相同 runner 平台，不預設固定加速比例。流程只依作業系統、架構與 lockfile 快取 pnpm store，不快取 `node_modules` 或已編譯的原生模組。

編輯器與編譯器不需要雲端帳號或網路連線。自動更新會連線 GitHub；關閉設定中的「自動檢查並下載」即可停止背景更新請求。EV3 Wi-Fi 通訊仍在本地網路進行。

## USB

診斷存取問題時，先只連接一台 EV3。「權限不足」與「找不到裝置」會分別回報。Linux 僅應為 LEGO vendor `0694`、EV3 product `0005` 建立範圍精確的 udev 規則，不要對所有 HID 開放權限；變更規則後重新連接 EV3。

## Wi-Fi

EV3 與電腦必須位於同一個可信任網路。搜尋會接收 IPv4 UDP 3015 廣播，也可直接輸入 EV3 位址；連線使用 TCP 5555。找不到設備、連線被拒絕或逾時時，檢查這些 port 與本機防火牆。

## 復原

- 可取消停滯操作並重新連線，不必重新啟動 Kobrixa。
- 輸出提交前的編譯錯誤或取消會保留既有成品。輸出檔逐一提交；若提交階段失敗，請重新成功建置後再部署。
- 上傳中斷線會回報錯誤，EV3 可能留下未完成檔案；重連、確認目的地後再次上傳。
- 編輯器未儲存草稿存放於本機應用程式資料，重新開啟專案時會復原。
