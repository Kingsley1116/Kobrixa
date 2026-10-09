# Kobrixa IDE

**用程式驅動創意。**

Kobrixa IDE 是一個開源桌面應用程式，用來在 Windows、macOS 與 Linux 上為 LEGO® MINDSTORMS® EV3 機器人編寫程式。你以 Basic Plus（`.bp`）撰寫程式，Kobrixa 將它編譯為原生 EV3 bytecode，並透過 USB 或 Wi-Fi 傳送到主機執行——不需要更換韌體。

[下載](https://github.com/Kingsley1116/Kobrixa/releases) · [網站](https://kobrixa.com) · [範例](examples/README.zh-TW.md) · [文件](#文件) · [English README](README.md)

## 你可以做什麼

- **撰寫 Basic Plus**：以 Monaco 為基礎的編輯器，提供診斷、格式化與可自訂的快捷鍵。常用的舊有 `.bp` 程式以「不需修改原始碼即可執行」為目標（[語言支援](docs/zh-TW/language-support.md)）。
- **在 EV3 上建置並執行**：編譯為原生 `.rbf` 程式，經 USB 或 Wi-Fi 上傳，一個指令即可執行（**在 EV3 執行**，F5）。也能瀏覽與管理主機上的檔案。
- **記錄感測器曲線**：即時繪製最多四個感測器或馬達角度通道、進行校正，並比較已儲存的記錄（[Sensor Lab](docs/zh-TW/sensor-lab.md)）。
- **測試馬達**：在 **EV3 工具 → 監測** 直接轉動 A–D 馬達，不需撰寫程式（[馬達測試](docs/zh-TW/motor-test.md)）。
- **即時協作**：分享邀請碼即可共同編輯同一專案、聊天並交接 EV3 控制權，不需要帳號（[雲端協作](docs/zh-TW/collaboration.md)）。
- **保持最新**：應用程式會檢查 GitHub Releases，經確認後安裝更新（[安裝與更新](docs/zh-TW/installation.md)）。

## 快速開始

### 1. 安裝

從最新的 [GitHub Release](https://github.com/Kingsley1116/Kobrixa/releases) 下載對應系統的檔案：

| 平台                | 檔案                                    | 安裝方式                                    |
| ------------------- | --------------------------------------- | ------------------------------------------- |
| Windows x64         | `Kobrixa-<version>-win32-x64-setup.exe` | 執行安裝程式（為目前使用者安裝）            |
| macOS Apple Silicon | `Kobrixa-<version>-darwin-arm64.dmg`    | 開啟 DMG，將 `Kobrixa.app` 拖入「應用程式」 |
| Linux x64           | `Kobrixa-<version>-linux-x64.AppImage`  | 將檔案設為可執行（`chmod +x`）後啟動        |

候選版可能尚未簽章，作業系統可能顯示警告。詳見[程式碼簽章政策](docs/zh-TW/code-signing.md)；校驗與更新請見[安裝指南](docs/zh-TW/installation.md)。Linux 上使用 USB 可能需要設定 [udev 規則](docs/zh-TW/installation.md#usb)。

### 2. 撰寫程式

選擇 **建立專案**（或 **開啟** 任一[範例](examples/README.zh-TW.md)），輸入：

```vb
' Show a greeting and a line on the EV3 display.
Folder "prjs" "Kobrixa"

LCD.Clear()
LCD.Text(1, 8, 18, 1, "Hello from Kobrixa")
LCD.Line(1, 8, 38, 165, 38)
LCD.Update()
Speaker.Tone(35, 440, 180)
Program.Delay(250)
```

這就是 [`examples/getting-started/hello-ev3`](examples/getting-started/hello-ev3/)，只需要主機的螢幕與喇叭。

### 3. 連線並執行

1. 開啟 EV3，以 USB 線連接電腦，或讓 EV3 與電腦連上同一個 Wi-Fi 網路。
2. 開啟 EV3 面板（**顯示 EV3 面板**，Ctrl/Cmd+Shift+E），選擇 **連線**。
3. 選擇 **在 EV3 執行**（F5）。Kobrixa 會編譯、上傳並啟動程式。

編譯錯誤會顯示在診斷面板（Ctrl/Cmd+J）並標出確切行號。沒有 EV3 時，可用 **建置**（Ctrl/Cmd+Shift+B）檢查程式。接下來可依照[學習路徑](examples/LEARNING-PATH.md)繼續。

## 專案狀態

Kobrixa 目前是 **v1 候選版**（`v0.1.0-v1-candidate.14`）。已可下載試用，但 v1 尚未定案：三平台完整實體 EV3 測試與正式程式碼簽章仍在進行中。

| 能力                               | 狀態                    |
| ---------------------------------- | ----------------------- |
| Basic Plus（`.bp`）編輯器與編譯器  | 可用                    |
| 原生 EV3 `.rbf` 輸出               | 可用                    |
| Windows、macOS、Linux USB          | 可用；實機測試中        |
| Windows、macOS、Linux Wi-Fi        | 可用；實機測試中        |
| EV3 檔案管理、Sensor Lab、馬達測試 | 可用                    |
| 雲端協作                           | 可用（自 candidate.12） |
| 安裝套件與自動更新                 | 可用                    |
| 本地機器人模擬器                   | 開發中；目前版本未開放  |
| Python 前端                        | v1 之後規劃             |
| TypeScript 前端                    | Python 之後規劃         |
| C++ 前端                           | TypeScript 之後規劃     |
| Bluetooth、積木編輯器              | 長期規劃                |

**可用**：已包含在目前候選版中。**實機測試中**：已實作並通過自動化測試，但實體 EV3 驗收矩陣尚未完成（[設備支援](docs/zh-TW/device-support.md)）。**規劃／長期規劃**：目前尚不可用，見[路線圖](docs/zh-TW/roadmap.md)。

## 運作方式

```text
編輯 .bp 原始碼
      ↓
編譯為 KobrixaIR（具型別的中間表示）
      ↓
產生原生 EV3 bytecode（.rbf）
      ↓
透過 USB 或 Wi-Fi 上傳
      ↓
在 EV3 主機上執行
```

Basic Plus 相容性採 clean-room 實作：受支援的程式應能不修改原始碼執行，並在主機上表現相同。與其他編譯器產生的 `.rbf` 逐位元組相同並非目標。

未來的 Python、TypeScript 與 C++ 前端會共用相同的 KobrixaIR 與 EV3 後端。EV3 執行環境無法承載這些語言完整的標準函式庫，因此不支援的功能會產生明確的編譯期錯誤，而不是默默出錯。

## 從原始碼建置

需求：Node.js 24 以上與 pnpm 10.15.0（已在 `package.json` 釘選；執行 `corepack enable` 即可安裝）。

```sh
pnpm install --frozen-lockfile
pnpm dev        # 建置共用套件並啟動桌面應用程式
pnpm test       # 單元與 bytecode 測試
pnpm check      # 型別檢查與 lint
pnpm package    # 為目前作業系統產生未簽章的桌面應用程式
```

在 Debian/Ubuntu 上，請先安裝原生 USB 建置依賴：

```sh
sudo apt-get install -y build-essential pkg-config libusb-1.0-0-dev libudev-dev
```

各產品專用檢查（`pnpm check:desktop`、`pnpm check:web` 等）、CI 與發布流程請見[安裝指南](docs/zh-TW/installation.md#開發版)。提交 pull request 前請先閱讀 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 倉庫結構

```text
apps/desktop/              Electron main／preload 與 React renderer（IDE 本體）
apps/web/                  網站、線上文件與瀏覽器 EV3 媒體工具（Cloudflare Worker）
apps/collab/               雲端協作服務（Cloudflare Worker）
packages/compiler/         編譯協調與診斷
packages/ir/               KobrixaIR 定義與驗證
packages/backend-ev3/      EV3 bytecode 與 .rbf 產生器
packages/device/           USB 與 Wi-Fi transport
packages/collab-protocol/  協作通訊契約
frontends/basic-plus/      Basic Plus 語言前端
examples/                  範例專案與學習路徑
tests/                     Bytecode、桌面 smoke、協作與實機測試
tools/                     建置、素材、CI 與發布腳本
docs/                      產品與工程文件（en、zh-TW）
```

## 文件

**使用 Kobrixa**

- [安裝、更新與復原](docs/zh-TW/installation.md)
- [快捷鍵與設定](docs/zh-TW/keyboard-settings.md)
- [設備與平台支援](docs/zh-TW/device-support.md)
- [Sensor Lab](docs/zh-TW/sensor-lab.md) · [馬達測試](docs/zh-TW/motor-test.md)
- [雲端協作](docs/zh-TW/collaboration.md)
- [範例](examples/README.zh-TW.md)與[學習路徑](examples/LEARNING-PATH.md)

**專案與工程**

- [產品規格](docs/zh-TW/product.md)
- [架構與公共契約](docs/zh-TW/architecture.md)
- [語言支援政策](docs/zh-TW/language-support.md)
- [路線圖](docs/zh-TW/roadmap.md)
- [程式碼簽章政策](docs/zh-TW/code-signing.md)

## 技術

Electron · React · TypeScript · Monaco Editor · Node.js。編譯器、EV3 後端與設備服務以 TypeScript 撰寫；v1 執行目標為原廠 EV3 VM。（上文的 C++ 指未來供使用者撰寫程式的語言，而非 Kobrixa 本身的實作語言。）

## 法律與命名

Kobrixa 是獨立專案，與 LEGO Group 沒有隸屬、認可或贊助關係。LEGO、MINDSTORMS 與 EV3 是 LEGO Group 的商標。

本倉庫的 Apache-2.0 授權只適用於 Kobrixa 的原創成果，不授予 Clev3r、EV3Basic、LEGO Group 或其他第三方所擁有之程式碼、素材、文件、商標或其他內容的權利。Kobrixa 不得複製 Clev3r 的原始碼、視覺素材或文件；相容工作必須依據公開行為規格與獨立撰寫的測試完成。

「Kobrixa」在規劃階段已進行基本網路與套件名稱撞名檢查，但這不構成商標檢索或法律意見。公開發布前，維護者必須完成適當的商標、程式碼倉庫、套件註冊表、社群帳號與網域檢查。

## 參與貢獻

Kobrixa 歡迎規格審查、獨立撰寫的相容案例、編譯器開發、設備測試與文件改進。參與前請閱讀 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 授權

Kobrixa 原創成果採用 [Apache License 2.0](LICENSE)。
