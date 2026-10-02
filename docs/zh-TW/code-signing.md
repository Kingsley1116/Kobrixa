# Code signing policy／程式碼簽章政策

Kobrixa 的發布流程支援 macOS Developer ID 簽章與 Apple 公證，以及 Windows SignPath 簽章。兩者在帳號、憑證及驗證準備完成前均預設關閉。流程已支援不代表現有下載檔已簽章；請查看該版本的 Release 說明並驗證下載的應用程式。

Windows 的 SignPath Foundation 免費開源方案仍須申請核准，目前不宣稱已獲贊助或取得憑證。核准前的 Windows 版本會明確標示未簽章。Linux 維持未簽章並附 SHA-256 校驗碼；校驗碼可檢查內容是否改變，但不能驗證發行者身分。

## 責任與隱私

- 作者、審查者與發布／簽章核准者：[Kingsley1116](https://github.com/Kingsley1116)。其他貢獻者的變更須經維護者審查；用於簽章的 GitHub 與 SignPath 帳號必須啟用多因素驗證。
- 核准者須檢視確切來源 commit、檢查結果與簽章請求，再逐次核准 Windows 發布。SignPath 核准與 GitHub Release 公開是兩個獨立人工步驟。
- 桌面編輯器／編譯器在本機運作；EV3 搜尋、連線與傳輸由使用者操作觸發，明確開啟的 LEGO 連結交由系統瀏覽器處理。桌面程式不實作廣告或分析追蹤。啟用自動更新時向 GitHub 取得公開 Release 資訊及下載檔，傳送一般 HTTP 連線資訊（IP 位址、User-Agent），不會上傳原始碼或專案。可在「設定 → 更新」關閉背景檢查。網站與素材庫另有[隱私政策](https://kobrixa.com/privacy)。
- 簽章服務在發布時取得版本二進位檔及建置資訊；此流程不會傳送使用者電腦中的專案。

## 發布行為

GitHub repository **Variables** 中的 `MACOS_SIGNING_ENABLED`、`WINDOWS_SIGNING_ENABLED` 只接受 `true`、`false` 或未設定（關閉）。驗證工作會保存簽章模式快照，供後續工作使用，並記錄在草稿識別標記中。只重跑失敗工作時沿用原快照；重跑全部工作而變更模式時，會拒絕覆寫既有草稿。請在下一個版本 tag 切換模式，不修改既有草稿／tag。

只有通過 tag 與 `main` 歷史驗證、共通檢查與桌面測試的 Release 才執行簽章。PR、一般 CI 與 `pnpm package` 不需要簽章憑證。啟用某平台後，缺少設定、憑證過期或遭拒、公證失敗、簽章無效、請求被拒或逾時，都必須讓該平台失敗；不會自動改用未簽章版本。

流程發布 Windows NSIS／ZIP、Linux AppImage／tar.gz、macOS DMG，以及單一 SHA256SUMS.txt。macOS 僅已簽章版本加上更新 ZIP，不再發布普通 ZIP。個別校驗檔僅暫存於草稿，在最後驗證時合併。Windows／Linux 一律提供更新資訊，macOS 僅已簽章版本提供。產物保留為草稿供人工公開。已簽章程式在壓縮前、解壓後皆驗證。建置中或未完成草稿只標示待驗證，全部成功後才宣稱已驗證簽章。

## 首次公開前檢查

首個公開版本發布前，維護者須檢閱確切 commit 與草稿：

1. 檢查受追蹤檔案、可達的 Git 歷史及最終壓縮包是否含憑證與私人資料。忽略檔案不會移除歷史或舊產物中的內容。
2. 確認原始碼、範例與媒體的再散布權利，檢查封裝內的專案 `LICENSE`、`THIRD-PARTY-NOTICES.txt` 及上游 Electron／Chromium／HIDAPI 授權聲明。
3. 完成正式 macOS 簽章／公證與瀏覽器下載驗證，依[設備支援驗收清單](../zh-TW/device-support.md)記錄尚待完成的平台與 EV3 結果。
4. 確認草稿包含各平台壓縮包、安裝包、相符的 SHA256SUMS.txt，以及簽章模式所需的更新資訊；使用預定的 commit，並逐平台核對簽章狀態。
5. 將倉庫改公開與 Release 發布作為兩個獨立人工操作。SignPath 核准前維持 Windows 明確標示未簽章；帳號身分驗證、付款、申請及簽章核准由擁有者完成。

## 設定 macOS

1. 自行加入 [Apple Developer Program](https://developer.apple.com/programs/enroll/)，完成身分驗證與付款。建立 **Developer ID Application** 憑證，連同私鑰匯出成密碼保護的 P12。Apple Development 或 Developer ID Installer 憑證不能替代它。
2. 在 GitHub → Settings → Secrets and variables → Actions 設定下表。不要把私鑰或密碼貼進 issue、聊天或提交到倉庫。

| 類型     | 名稱                           | 內容                                             |
| -------- | ------------------------------ | ------------------------------------------------ |
| Secret   | `MACOS_CERTIFICATE_P12_BASE64` | 包含私鑰的 P12，以單行 base64 編碼               |
| Secret   | `MACOS_CERTIFICATE_PASSWORD`   | P12 匯出密碼                                     |
| Secret   | `APPLE_ID`                     | 用於公證的 Apple 帳號                            |
| Secret   | `APPLE_APP_SPECIFIC_PASSWORD`  | App 專用密碼，不是帳號登入密碼                   |
| Variable | `APPLE_TEAM_ID`                | 十字元 Apple Team ID                             |
| Variable | `MACOS_SIGNING_IDENTITY`       | 完整的 `Developer ID Application: Name (TEAMID)` |
| Variable | `MACOS_SIGNING_ENABLED`        | 上述資料齊備後設為 `true`                        |

macOS runner 將憑證匯入暫存 keychain 並把路徑交給 electron-builder；成功或失敗後皆還原原始搜尋清單、移除 P12 與暫存 keychain。取消工作時由 `always()` 清理；強制中止而未能執行清理時，以 GitHub hosted runner 的銷毀為最終清理邊界。

electron-builder 以 Hardened Runtime 簽署 `com.kobrixa.ide`、helper 與原生模組，再送 Apple 公證並附加票證。權限僅啟用 JIT 與 USB，不停用 library validation。通過驗證後才建立壓縮包；`node-hid` 僅包含目標平台所需的預編譯檔。

## 公開發布並獲 SignPath 核准後設定 Windows

1. 完成[公開前檢查](#首次公開前檢查)，自行公開倉庫與可使用的 Release。第一個 Windows 版本可未簽章。向 [SignPath Foundation](https://signpath.org/apply.html) 申請；核准由基金會決定，新專案可能仍需累積可驗證的可信度。
2. 取得 SignPath 對 Electron 封裝 `kobrixa.exe` 與最終 NSIS 安裝程式簽署範圍的核准。不要用 Foundation 憑證自行重簽上游 DLL 或 `node-hid` 檔案；若此範圍不被接受，維持 Windows 關閉並記錄要求，不自動擴大範圍。
3. 連接 GitHub trusted build system，授予 SignPath GitHub App 必要的倉庫權限。正式 policy 必須要求人工核准、GitHub hosted runner，並限制此倉庫與 Release workflow。正式發布不可使用測試憑證。
4. 匯入 [`tools/release/signpath-artifact.xml`](https://github.com/Kingsley1116/Kobrixa/blob/main/tools/release/signpath-artifact.xml)。設定只簽 ZIP 根目錄的 `kobrixa.exe`，限制 Kobrixa 產品資訊與版本，採 SHA-256 Authenticode；服務 policy 必須附可信的 RFC 3161 時間戳，其餘檔案保持原樣。Windows PE 版本使用 `major.minor.patch.0`，套件與壓縮包檔名保留完整 SemVer。
5. 另匯入 [`tools/release/signpath-installer.xml`](https://github.com/Kingsley1116/Kobrixa/blob/main/tools/release/signpath-installer.xml)，驗證最終 `setup.exe` 的完整 SemVer 產品版本與數字檔案版本。應用程式簽章、安裝包組裝完成後，再單獨申請安裝包簽章；解除安裝程式不另外簽章。
6. 設定下表，再於下一個發布 tag 啟用 Windows。

| 類型     | 名稱                                             | 內容                                        |
| -------- | ------------------------------------------------ | ------------------------------------------- |
| Secret   | `SIGNPATH_API_TOKEN`                             | 已核准 project／policy 的 submitter token   |
| Variable | `SIGNPATH_ORGANIZATION_ID`                       | 配發的 organization ID                      |
| Variable | `SIGNPATH_PROJECT_SLUG`                          | Project slug                                |
| Variable | `SIGNPATH_SIGNING_POLICY_SLUG`                   | 已核准正式 policy 的 slug                   |
| Variable | `SIGNPATH_ARTIFACT_CONFIGURATION_SLUG`           | 使用倉庫 XML 的設定 slug                    |
| Variable | `SIGNPATH_INSTALLER_ARTIFACT_CONFIGURATION_SLUG` | 已核准的 `signpath-installer.xml` 設定 slug |
| Variable | `SIGNPATH_CERTIFICATE_SUBJECT`                   | 正式憑證的完整 Subject，驗證時須完全一致    |
| Variable | `WINDOWS_SIGNING_ENABLED`                        | 核准與設定完成後才設為 `true`               |

流程會將未簽章應用程式與最終安裝包分別上傳為 Actions artifact，各保留一天；兩次簽章請求均可能需要人工核准，因此需要可用的 Actions 儲存配額。縮短保留期限不會移除舊產物或立即釋放配額；最終下載仍直接上傳 Release assets。請求最多等待人工核准 60 分鐘；被拒、逾時或服務失敗時保留未完成草稿。重跑相同 commit 前，先檢查 SignPath 步驟日誌的請求連結；重跑會提交新請求，舊的待核准請求應於 SignPath 取消。不得把未簽章暫存檔當成已簽章版本發布。

回傳產物的檔案集合必須完全相同，且除了 `kobrixa.exe` 以外內容都不可改動。Windows 驗證 Authenticode 信任、預期憑證 Subject、時間戳、產品資訊與版本後才替換執行檔。新版本即使簽章有效，仍可能遇到 SmartScreen 信譽警告。

確認 Foundation 核准後，再更新本頁與英文版，加入連結至兩個組織的聲明：「Free code signing provided by SignPath.io, certificate by SignPath Foundation」。發布工具只會在 Windows 簽章驗證成功的 Release 加入這段聲明；核准前保留本頁的待申請文字。

## 驗收與更新憑證

- 各支援平台執行共通、桌面、release 測試與封裝。macOS 解壓後須通過 `codesign --verify --deep --strict`、身分／Team ID、`xcrun stapler validate`、`spctl --assess --type execute`；Windows 須通過倉庫 PowerShell verifier 與 Windows SDK SignTool。
- 使用乾淨機器，經瀏覽器下載後測試啟動、範例編譯與 EV3 USB／Wi-Fi，記錄作業系統、產物校驗碼與結果。沒有瀏覽器 quarantine 標記的本機建置不算完成 Gatekeeper 驗收。
- 真實簽章驗收須使用正式憑證；未取得憑證前，mock 測試與未簽章封裝只驗證流程，不代表 Apple／SignPath 已核發或使用者端信任已通過。
- 憑證到期或撤銷前更換憑證設定，確認預期身分／Subject，再驗證新版本。不要修改已公開檔案或移動 tag。SignPath 延後或拒絕核准時保持 Windows 關閉，不自動購買其他服務。

參考：[electron-builder code signing](https://www.electron.build/v26/docs/features/code-signing/)、[SignPath GitHub integration](https://docs.signpath.io/trusted-build-systems/github)、[Foundation terms](https://signpath.org/terms.html)、[Microsoft signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)。

Windows 未簽章版本先支援自動更新；啟用簽章後，已簽章版本會驗證預期發行者，拒絕未簽章或其他發行者的安裝包。macOS 自動安裝需要 Apple 簽章，未簽章版本提供手動下載。所有簽章完成後才生成更新 metadata 與校驗碼；首版使用完整下載。倉庫公開及 Release 公開仍由維護者手動操作。

未配置 Apple 簽章的 Apple Silicon 建置會加上可供本機啟動的 ad-hoc 簽章；沒有 Developer ID 身分、公證或 Hardened Runtime，仍僅提供手動更新。正式簽章版本維持 Hardened Runtime 與既有 JIT／USB 權限。
