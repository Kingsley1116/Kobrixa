# 路線圖

## 目前交付階段

Basic Plus 編譯、桌面編輯器、USB／Wi-Fi transport、遠端檔案管理，以及三平台安裝套件／壓縮包、Release 流程與自動更新均已實作。可下載版本以各個 GitHub Release 為準。實體 EV3 驗收已由維護者確認通過。1.0.0 不等待簽章，仍須確認乾淨環境安裝與發布產物。

目前亦已提供[Sensor Lab](sensor-lab.md)、[馬達測試](motor-test.md)與[雲端協作](collaboration.md)。這些功能的自動化測試不取代實體 EV3 驗收。

## Phase 0 — 已建立的基礎

- Electron、React、TypeScript 與 Monaco 使用鎖定版本的 Node.js／pnpm workspace。
- Compiler、IR、backend 與 device package 共用版本化契約。
- CI 依 Git 差異選擇網站或桌面檢查；桌面封裝目標為 Windows x64、macOS arm64 與 Linux x64。
- 產品文件與教學提供英文及繁體中文版本。

公開發布前持續檢查相依套件授權、品牌／素材來源與雙語連結。自動建置不代表已取得商標權利，也不能取代上述檢查。

## v1 — 發布驗收

目前已實作 `.bp` → 已驗證 `KobrixaIR` → 原生 `.rbf`，並提供 Monaco 編輯、專案、雙語離線診斷解說、由使用者選取且可用 Undo 復原的 Quick Fix、素材部署與遠端檔案操作。官網[錯誤索引](/docs/diagnostics?lang=zh-TW)與 IDE 共用解說內容；Quick Fix 僅提供可確定的語法修正。接下來依序完成：

1. 檢閱確切原始碼、歷史、素材與乾淨環境安裝結果，驗證 Release 草稿、安裝套件、壓縮包、更新資訊與校驗碼。
2. 發佈 1.0.0，明確標示 macOS、Windows 與 Linux 均未簽章。維護者已於 2026-10-12 確認實體 EV3 驗收通過；模擬器不納入正式發佈。
3. 憑證與核准齊備後，再於後續版本加入簽章；此前 macOS 未簽章版本使用手動下載更新。

退出條件：[產品規格](../zh-TW/product.md)與[設備規格](../zh-TW/device-support.md)的所有條件通過，且每項公開簽章聲明均有驗證證據。依[簽章政策](../zh-TW/code-signing.md)操作；啟用後不得靜默退回未簽章產物。

## v1.x — 強化

- 插件系統第一階段（開發預覽）：協定、JS／TS 與 Python SDK、命令與通知 API、設定面板，以及註冊為內建插件的 Basic Plus 前端。第三方插件僅限開發模式載入。詳見[插件設計](../superpowers/specs/2026-10-14-plugin-system-design.md)。
- 擴充 `.bp` 相容案例與 EV3 API 覆蓋。
- 改進補全、格式化、效能、無障礙、本地化與復原體驗。
- 在相同 compiler 與 device package 上加入 headless Node.js `kobrixa` CLI。
- 雲端協作（已納入）：透過 Kobrixa 營運的服務，以邀請碼開啟房間，即時共同編輯、共享檔案樹、聊天，並由單一持有者控制 EV3。詳見[雲端協作](../zh-TW/collaboration.md)。

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
- 以同一套 IR 為目標的 Blockly 類積木編輯器
- 教室部署與設備群工具
- 透過獨立後端支援其他 LEGO 相容 Hub

長期項目是研究方向，不是承諾。每個項目實作前都需要書面提案、安全審查、跨平台驗收條件，並同步更新兩種語言文件。
