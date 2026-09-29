# 安裝與復原

> 狀態：v1 候選版。USB 與 Wi‑Fi 尚未完成三平台 EV3 實機矩陣。

## 開發版

安裝 Node.js 24 與 pnpm 10.15，執行 `pnpm install` 後使用 `pnpm dev`。`pnpm package` 會為目前作業系統產生未簽署的開發版應用程式。

在 Debian／Ubuntu 上，請先安裝原生 USB 模組的建置依賴，再執行 `pnpm install` 或封裝：

```sh
sudo apt-get update
sudo apt-get install -y build-essential pkg-config libusb-1.0-0-dev libudev-dev
```

### CI 與開發版下載

**CI** workflow 會在 pull request、push 到 `main` 與手動執行時啟動。共通格式、根目錄設定的 lint 及 CI 分流測試在 Ubuntu 執行一次，產品檢查依完整 Git 差異分流：

- `apps/web/` 與 `docs/` 變更：執行網站型別／lint、前端／IR 與 Worker 測試，以及網站建置。
- `apps/desktop/`、`examples/`、`tests/`、桌面工具及桌面 release workflow 變更：在 Ubuntu 24.04 x64、Windows 2025 x64、macOS 26 arm64 執行桌面檢查、核心／桌面測試與封裝。此矩陣不執行網站測試。
- 共用套件、語言前端、素材、鎖檔、根目錄設定與 CI 工具變更：兩邊都驗證。未識別路徑也會跑兩邊；只有根目錄 README、貢獻說明或授權文件變更時，只跑共通檢查。
- 手動執行一律跑兩邊；比較歷史不可用時也跑兩邊。重新命名和刪除會計入原本路徑。

`CI result` 保留原有必要檢查名稱。只有分流明確判定未受影響的產品工作可以跳過；失敗、取消，或必要工作意外跳過，都不會通過。同一分支或 pull request 有新 commit 時，會取消舊的 CI 執行。

使用 `pnpm check:common` 執行共通檢查。網站依序執行 `pnpm check:web`、`pnpm test:web`、`pnpm build:web`。桌面依序執行 `pnpm check:desktop`、`pnpm build:core`、`pnpm test:desktop`、`pnpm build:desktop`、`pnpm package:archive`。封裝指令會在暫存目錄解壓產物，驗證完整檔案樹、權限、符號連結及 USB 模組，再寫入 SHA-256 校驗碼。各作業系統仍須安裝原生模組的建置依賴。`pnpm check:ci` 與 `pnpm test:ci` 仍保留為全倉庫本機檢查；桌面 tag 發布使用共通及桌面檢查，不執行網站建置／測試。

一般 CI 不上傳應用程式。若要下載開發版，請手動執行 **CI** 並啟用 **upload_artifacts**；壓縮包與校驗碼會保留 7 天。既有 Actions 儲存配額不足仍會阻擋這項選用上傳；縮短保留天數不會刪除舊產物。Release 建置會直接使用 Release assets，不經 Actions artifacts。

### 桌面 Release 草稿

1. 將根目錄及所有 workspace 的 `package.json` 設為相同 SemVer 版本，必要時更新 lockfile，再將版本變更合併到 `main`。
2. 為既有 commit 推送版本 tag，例如 `v0.1.0-v1-candidate.0`。**Desktop Release** workflow 會拒絕格式錯誤、套件版本不符或不屬於 `main` 歷史的 commit。
3. 流程建立標示 **建置中 / Building** 的草稿，驗證 tag 指定的確切 commit，各平台直接上傳壓縮包與校驗碼到草稿。版本有預發行後綴時，草稿會標示為 prerelease。
4. 所有檢查成功，且六個產物皆下載並通過校驗碼驗證後，草稿改為 **待發布 / Ready for manual publication**，附上來源 commit 與自動產生的版本紀錄。請檢閱後手動公開；流程不會自動發布。

下載檔名為 `Kobrixa-<version>-win32-x64.zip`、`Kobrixa-<version>-darwin-arm64.zip` 與 `Kobrixa-<version>-linux-x64.tar.gz`，各附一個 `.sha256`。解壓後分別執行 `kobrixa.exe`、`Kobrixa.app` 或 `kobrixa`。這些是未簽署開發版，macOS 版未經公證；不包含 Intel Mac、安裝程式、程式碼簽署與自動更新。

執行失敗時會保留未完成草稿，並在 workflow 摘要列出各平台結果。可為相同 tag 與 commit 重跑失敗工作，只替換相符的草稿產物。tag 被移動、草稿由手動建立或無法辨識、Release 已公開時，流程會拒絕更新。校驗碼或最終確認失敗也不會將草稿標示為待發布。請勿公開未完成草稿或移動發布 tag。同一 tag 的 Release 執行會序列化，不取消正在執行的工作。

不需要新增 personal access token：一般 CI 只有倉庫讀取權限，Release 寫入工作使用具備 `contents: write` 的 `GITHUB_TOKEN`。網站部署與既有遠端產物維持現況。導入後使用下一個預定發布的版本 tag 驗證第一份真實草稿，不為測試流程另外公開測試版本。

評估改善效果時，請比較 Actions 中第一次冷快取與後續暖快取執行的各工作耗時、總 runner 分鐘數及壓縮包大小，並使用相近的 commit 與相同 runner 平台，不預設固定加速比例。流程只依作業系統、架構與 lockfile 快取 pnpm store，不快取 `node_modules` 或已編譯的原生模組。

編輯器與編譯器不需要雲端帳號或網路連線；Wi‑Fi 只用於與 EV3 通訊。

## USB

診斷存取問題時，先只連接一台 EV3。「權限不足」與「找不到裝置」會分別回報。Linux 僅應為 LEGO vendor `0694`、EV3 product `0005` 建立範圍精確的 udev 規則，不要對所有 HID 開放權限；變更規則後重新連接 EV3。

## Wi-Fi

EV3 與電腦必須位於同一個可信任網路。可使用搜尋或輸入 EV3 的 IPv4／IPv6 位址。連線被拒絕或逾時時，檢查 TCP 5555 port 與本機防火牆。

## 復原

- 可取消停滯操作並重新連線，不必重新啟動 Kobrixa。
- 建置失敗或取消時會保留上一個成功成品。
- 上傳中斷線會回報錯誤；重新連線後再次上傳。
- 編輯器未儲存草稿存放於本機應用程式資料，重新開啟專案時會復原。
