# 路線圖

## 目前交付階段

倉庫目前處於 v1 候選版階段。Basic Plus 編譯、桌面編輯器、USB／Wi-Fi transport、遠端檔案管理，以及三平台安裝套件／壓縮包、Release 流程與自動更新均已實作。可下載版本以各個 GitHub Release 為準。正式簽章憑證與完整乾淨環境／實機矩陣仍是發布前須完成的項目。

## Phase 0 — 已建立的基礎

- Electron、React、TypeScript 與 Monaco 使用鎖定版本的 Node.js／pnpm workspace。
- Compiler、IR、backend 與 device package 共用版本化契約。
- CI 依 Git 差異選擇網站或桌面檢查；桌面封裝目標為 Windows x64、macOS arm64 與 Linux x64。
- 產品文件與教學提供英文及繁體中文版本。

公開發布前持續檢查相依套件授權、品牌／素材來源與雙語連結。自動建置不代表已取得商標權利，也不能取代上述檢查。

## v1 — 發布驗收

目前已實作 `.bp` → 已驗證 `KobrixaIR` → 原生 `.rbf`，並提供 Monaco 編輯、專案、雙語離線診斷解說、由使用者選取且可用 Undo 復原的 Quick Fix、素材部署與遠端檔案操作。官網[錯誤索引](/docs/diagnostics?lang=zh-TW)與 IDE 共用解說內容；Quick Fix 僅提供可確定的語法修正。接下來依序完成：

1. 完成 Apple 會員及 Developer ID 憑證設定，驗證解壓後的 macOS 應用程式已簽章並公證。
2. 完成原始碼／歷史／素材檢查與乾淨環境驗收，包括尚未完成的 USB／Wi-Fi 矩陣；檢閱確切 Release 草稿、安裝套件、壓縮包、更新資訊與校驗碼。
3. 手動公開倉庫與首個可使用版本：macOS 已簽章並公證，Windows 明確標示未簽章。
4. 使用公開原始碼與版本申請 SignPath Foundation。核准取決於外部審核；延後或拒絕時維持 Windows 未簽章。
5. 核准後設定允許的簽署範圍及人工核准 policy，在新版本啟用 Windows 簽章，再驗證回傳執行檔與最終下載包。

退出條件：[產品規格](../zh-TW/product.md)與[設備規格](../zh-TW/device-support.md)的所有條件通過，且每項公開簽章聲明均有驗證證據。依[簽章政策](../zh-TW/code-signing.md)操作；啟用後不得靜默退回未簽章產物。

## v1.x — 強化

- 擴充 `.bp` 相容案例與 EV3 API 覆蓋。
- 改進補全、格式化、效能、無障礙、本地化與復原體驗。
- 在相同 compiler 與 device package 上加入 headless Node.js `kobrixa` CLI。

退出條件：編譯器和設備 API 足夠穩定，可讓 CLI 與桌面程式獨立發布。

## v2 — Python 前端

- 加入 Python parsing、語意映射、EV3 profile 文件、補全與診斷。
- 不嵌入 CPython，將支援的 Python 語意透過 `KobrixaIR` 編譯為 `.rbf`。

## v3 — TypeScript 前端

- 加入 TypeScript parsing 與型別感知 lowering。
- 文件化支援的 runtime 語意，並明確拒絕使用者程式中的瀏覽器、Node.js 與動態程式碼功能。

## v4 — C++ 前端

- C++ 原始碼支援是面向使用者的語言前端，與 Kobrixa 的 Node.js 與 TypeScript 內部實作技術分開。
- 定義 freestanding C++ EV3 profile 與支援的標準函式庫範圍。
- 將支援的結構 lowering 為 `KobrixaIR`；不支援的 runtime 功能在編譯期回報。

## 長期探索

- Bluetooth transport
- EV3 模擬器與虛擬設備
- 以同一套 IR 為目標的 Blockly 類積木編輯器
- 教室部署與設備群工具
- 透過獨立後端支援其他 LEGO 相容 Hub

長期項目是研究方向，不是承諾。每個項目實作前都需要書面提案、安全審查、跨平台驗收條件，並同步更新兩種語言文件。
