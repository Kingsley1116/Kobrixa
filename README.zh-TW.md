# Kobrixa IDE

**用程式驅動創意。**

Kobrixa IDE 是一個規劃中的開源跨平台開發環境，用於編寫 LEGO® MINDSTORMS® EV3 機器人程式。它主要服務學生與創客，提供從原始碼到實體 EV3 主機執行程式的清楚流程。

> [English README](README.md)

## 專案狀態

**v1 候選實作。** 本倉庫已包含可建置的 IDE、編譯流程、EV3 image 後端，以及 USB／Wi‑Fi 設備服務。Basic Plus 相容覆蓋與三平台 EV3 實機矩陣仍是發布門檻。

| 能力                          | 狀態                   |
| ----------------------------- | ---------------------- |
| Basic Plus（`.bp`）前端       | v1 候選版              |
| 原生 EV3 `.rbf` 輸出          | v1 候選版              |
| Windows、macOS、Linux USB HID | 候選版；實機矩陣待完成 |
| Windows、macOS、Linux Wi-Fi   | 候選版；實機矩陣待完成 |
| Python 前端                   | v1 之後規劃            |
| TypeScript 前端               | Python 之後規劃        |
| C++ 前端                      | TypeScript 之後規劃    |
| Bluetooth、模擬器、積木編輯器 | 長期規劃               |

任何「規劃中」能力都不應被理解為目前已經可用。

## 產品方向

v1 刻意採用範圍明確的流程：

```text
編輯 .bp 原始碼
      ↓
編譯為 KobrixaIR
      ↓
產生原生 EV3 bytecode（.rbf）
      ↓
透過 USB 或 Wi-Fi 上傳
      ↓
在 EV3 主機執行
```

Kobrixa 將以 clean-room 方式實作，對常用舊版 `.bp` 程式提供行為相容性。相容代表支援的程式不必修改原始碼即可執行，並產生等價的可觀察行為；不要求與其他編譯器輸出的 `.rbf` 逐位元相同。

後續語言前端會共用同一套具型別的中間表示與 EV3 後端。Kobrixa 會盡可能解析標準 Python、TypeScript 與 C++ 語法，但原生 EV3 執行環境無法提供這些語言完整的桌面 runtime 或標準函式庫。無法安全映射的能力必須產生明確的編譯期診斷。

## 規劃技術

- Electron 桌面外殼
- React 與 TypeScript renderer
- Monaco Editor
- 以 Node.js 與 TypeScript 實作的編譯器核心、EV3 後端與設備服務
- v1 以原生 EV3 VM 為執行目標
- Apache License 2.0

Node.js 與 TypeScript 是 Kobrixa 的內部實作技術；C++ 則仍是 TypeScript 前端之後另行規劃、供使用者程式採用的來源語言前端。

## 文件

- [Code signing policy／程式碼簽章政策](docs/zh-TW/code-signing.md)

- [產品規格](docs/zh-TW/product.md)
- [架構與公共契約](docs/zh-TW/architecture.md)
- [語言支援政策](docs/zh-TW/language-support.md)
- [設備與平台支援](docs/zh-TW/device-support.md)
- [路線圖](docs/zh-TW/roadmap.md)
- [安裝與復原](docs/zh-TW/installation.md)
- [範例](examples/README.zh-TW.md)
- [貢獻指南](CONTRIBUTING.md)

## 預定倉庫結構

```text
apps/desktop/           Electron main／preload 與 React renderer
packages/compiler/      編譯協調與診斷
packages/ir/            KobrixaIR 定義與驗證
packages/backend-ev3/   EV3 bytecode 與 .rbf 產生器
packages/device/        USB 與 Wi-Fi transport
frontends/basic-plus/   v1 Basic Plus 前端
tests/bytecode/         離線 bytecode 與行為回歸測試
tests/hardware/         手動 EV3 實機驗收腳本
docs/                   產品與工程文件
```

這是實作契約，不代表上述元件目前已經存在。

## 法律與命名

Kobrixa 是獨立專案，與 LEGO Group 沒有隸屬、認可或贊助關係。LEGO、MINDSTORMS 與 EV3 是 LEGO Group 的商標。

本倉庫的 Apache-2.0 授權只適用於 Kobrixa 的原創成果，不授予 Clev3r、EV3Basic、LEGO Group 或其他第三方所擁有之程式碼、素材、文件、商標或其他內容的權利。Kobrixa 不得複製 Clev3r 的原始碼、視覺素材或文件；相容工作必須依據公開行為規格與獨立撰寫的測試完成。

「Kobrixa」在規劃階段已進行基本網路與套件名稱撞名檢查，但這不構成商標檢索或法律意見。公開發布前，維護者必須完成適當的商標、程式碼倉庫、套件註冊表、社群帳號與網域檢查。

## 參與貢獻

Kobrixa 歡迎規格審查、獨立撰寫的相容案例、編譯器開發、設備測試與文件改進。參與前請閱讀 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 授權

Kobrixa 原創成果採用 [Apache License 2.0](LICENSE)。
