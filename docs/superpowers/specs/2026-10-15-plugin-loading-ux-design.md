# 插件載入體驗改善設計（第二階段第 1 步）

日期：2026-10-15  
狀態：Claude 與 Codex 已達成共識，使用者已核准設計方向，尚未實作。實作分成兩份計畫：1a 執行層強化、1b 圖形介面管理。

- 上層設計：[插件系統設計](2026-10-14-plugin-system-design.md)（§8.1 生命週期與復原、§9 打包與安裝）
- 待辦清單：[第二階段待辦](../plans/2026-10-15-plugin-system-phase-2-backlog.md)

## 1. 問題與目標

第一階段的開發插件只能從命令列載入：

- 要用 `--plugin-dev-dir` 指定插件，必須給絕對路徑、依平台使用不同分隔符號，封裝版還得用 `open -a … --args` 啟動。
- Kobrixa 不會記住載入來源，每次啟動都要重新帶參數。
- Python 直譯器要用 `--plugin-python` 手動指定，不會偵測。
- 安全模式只能用 `--safe-mode` 開啟。
- 設定頁的插件面板不能新增或移除插件。一個命令卡住會鎖住整個面板。

**目標：** 開發者用一般方式開啟 Kobrixa，就能在設定頁連結插件資料夾、選擇 Python、重新載入、查看日誌。重啟後連結仍然存在。插件出錯時，在同一頁就能處理；畫面卡住後，下次啟動不用命令列也能復原。

**不在範圍內：**

- 插件包安裝、受管理的 runtime、更新與回退：依 §9 另寫打包提案。
- 線上目錄或市集。
- 自動安裝 Python 或相依套件。
- 日誌寫入磁碟。
- 啟動時按住按鍵進入安全模式。
- 程序樹清理（插件自己產生的孫程序）。

**定位不變：** 這仍是「可信任的本機插件」開發模式，不是沙箱，也不代表向一般使用者開放第三方可執行插件。

## 2. 整體架構

```text
renderer（設定 → 插件面板）
   │  只傳 sourceKey 或候選 ID，不傳檔案路徑
   ▼
main：PluginController（新增）
   │  開發者模式、原生對話框與確認、Python 探測、日誌、session marker、操作授權
   ▼
plugin-runtime：PluginManager
   │  add／remove／reload（依序執行），以 sourceKey 與 generation 追蹤
   ▼
Supervisor
      停止流程都有時間上限，取消原因正確傳回
```

- **PluginController**（`apps/desktop/src/main/plugins/controller.ts`）負責判斷操作該不該執行：開發者模式、安全模式、是否正在關閉。它也擁有原生對話框、Python 探測、日誌緩衝區與 session marker。
- **PluginManager** 只管生命週期，不認得對話框、使用者設定或 Electron。
- **狀態檔：** `state.json` 升到 schema v2（見 §3.5）。

## 3. 1a：執行層強化

這部分的介面不會有變化，但完成後重新載入和解除連結才可靠。

### 3.1 停止流程都有時間上限

對應待辦清單高優先的三項：

- 握手失敗後，`supervisor.ts` 等待 exit 最多 `killGraceMs + exitTimeoutMs`；逾時就像 stop 放棄時一樣，清掉 `#process` 和 `#peer`，並解除 `#starting`。
- `launchers.ts` 的 `launchNode` 等待 `spawn` 事件設有逾時，逾時就強制終止程序並回報 `PLUGIN_E_LAUNCH`。
- 啟動中途要求 `stop()` 時，同樣受上述時間上限約束。

### 3.2 取消原因正確傳回

- 沿用現有的錯誤碼 `PLUGIN_E_CANCELLED`。
- 重新載入或解除連結造成的中斷，執行中的命令會收到 `PLUGIN_E_CANCELLED`；停用造成的中斷維持 `PLUGIN_E_DISABLED`。中斷原因由 manager 傳給 supervisor，不再從斷線事件推測。
- 任何情況都不重播命令。

### 3.3 以來源身分追蹤

- 每個來源有穩定的 `sourceKey`：
  - 內建插件：`builtin:<id>`；
  - 開發插件：`dev:<path.resolve(directory) 的 SHA-256 前 16 個十六進位字元>`。計算時不碰檔案系統，安全模式和讀取卡住時也能得到同一個 key；以 `realpath` 去除別名的工作由 1b 在連結資料夾時完成，存進狀態檔的路徑本來就是 `realpath`。
- `sourceKey` 與 manifest ID 無關。開發時改了 ID，停用設定、日誌和操作對象都不受影響。
- 每個來源有一個 `generation`，每次重新載入就加 1。帶著舊 generation 的程序事件一律丟棄。
- `#summary` 和所有內部查詢改用 `sourceKey` 找對應的程序。ID 重複的 invalid 項目不會再顯示成另一列的執行狀態。
- `PluginsSnapshot` 新增單調遞增的 `revision`。面板只接受比目前更新的快照，避免舊的操作結果蓋掉較新的狀態事件。

### 3.4 動態 add／remove／reload

PluginManager 新增：

```ts
addSource(source: PluginSource): Promise<PluginActionResult>;
removeSource(sourceKey: string): Promise<PluginActionResult>;
reloadSource(sourceKey: string): Promise<PluginActionResult>;
```

- 所有修改（包含現有的 `setEnabled`）排進同一個佇列依序執行。
- 每次修改後，依「內建優先、來源順序固定」對全部插件重新檢查重複 ID 和命令衝突，停用的插件也參與檢查。只重建結果有變化的 supervisor。
- **reload 的順序：**
  1. 擋住這個來源的新命令；
  2. 以 `PLUGIN_E_CANCELLED` 取消執行中的命令；
  3. 在 §3.1 的時限內停止程序；
  4. 重讀 manifest 並重新驗證全部插件；
  5. 有效時保留原本的停用設定，之後收到命令才啟動；無效時保留 invalid 項目，並移除舊的貢獻。
- **remove：** 先停止程序、撤銷貢獻，再移除來源。這只移除登記，不刪除任何檔案。
- 驗證失敗或資料夾不見的來源保留成 invalid 項目，畫面上看得到也能操作。
- 已經開始 shutdown 時，修改操作回 `PLUGIN_E_SHUTTING_DOWN`，不會留下孤兒程序或登記。

### 3.5 狀態檔 v2 與容錯

`<userData>/plugins/state.json` v2 的內容：

```ts
{
  schemaVersion: 2,
  developerMode: boolean,
  sources: Array<{ directory: string }>,           // 已解析的 realpath，依連結順序排列
  disabled: string[],                             // 一律存 sourceKey
  legacyDisabledIds: string[],                    // v1 遷移留下、尚未對應到來源的 manifest ID
  python?: { executable: string, args: string[] },
  safeModeLock?: { since: string, reason: "unclean-exit" | "renderer-unresponsive" }
}
```

- **v1 遷移：** v1 的 `disabled` 只有 manifest ID；當時內建插件不能停用，所以全部放進 `legacyDisabledIds`。之後任何開發來源載入時，如果 manifest ID 在 `legacyDisabledIds` 裡，就把該來源的 `sourceKey` 加入 `disabled`，並從 `legacyDisabledIds` 移除這個 ID。`developerMode` 預設為 `false`，`sources` 為空。
- **區分不存在和損毀：** 檔案不存在就當作首次啟動。檔案存在卻無法解析或 schema 不合法時，停用所有第三方插件，在面板顯示「插件設定檔已損毀」，並把原檔備份成 `state.json.corrupt-<時間>`。
- **寫入：** 依序執行，最後一次寫入一定是最新狀態；寫入失敗時清掉 `.tmp`。
- **存檔失敗：** 停用操作仍然在當次停止程序並撤銷貢獻，結果標示 `persisted: false`，面板顯示「未保存，重啟後可能恢復」。

### 3.6 啟動與安全模式

- 安全模式不讀第三方來源的目錄，直接把它們列成「安全模式中已暫停」，避免讀取卡住導致連復原都進不去。
- 正常啟動時，第三方來源的讀取有逾時（每個來源 5 秒）。逾時的來源列為 invalid，原因是 `PLUGIN_E_SOURCE_TIMEOUT`。
- `PluginManager.create` 失敗時仍然開啟視窗，面板顯示錯誤；內建插件照常可用。

### 3.7 1a 的測試

- runtime 單元測試使用假的 launcher，涵蓋以下情境：
  - 程序從不回報 exit；
  - 啟動中途 reload；
  - 重複 ID 與命令衝突在 add／remove 後重新判定；
  - 舊 generation 的事件被丟棄；
  - snapshot revision 單調遞增；
  - shutdown 期間的修改操作。
- state store 測試涵蓋 v1 遷移、檔案損毀、寫入失敗清掉 `.tmp`、依序寫入。
- 現有的命令列 smoke 要保持通過。

## 4. 1b：圖形介面管理

### 4.1 開發者模式

- 「設定 → 插件」最下方新增「開發者模式」開關，預設關閉。
- **開啟時**，主程序跳出原生確認對話框，內容寫明：會在本機執行程式碼、不是沙箱、只連結你信任的資料夾。按取消不會有任何變動。
- **關閉時**，停止所有開發插件的程序並撤銷它們的貢獻，但保留連結紀錄。
- **命令列：** 帶 `--plugin-dev-dir` 視為當次 session 已授權開發模式，但不寫入設定，也不能繞過安全模式。

### 4.2 連結資料夾

- 開發者模式開啟後顯示「連結資料夾…」。主程序依序執行：
  1. 開啟原生資料夾選擇視窗；
  2. 取得 `realpath`；
  3. 讀取 manifest；
  4. 跳出確認對話框，顯示插件名稱、ID、執行環境與完整路徑；
  5. 呼叫 `addSource`，並寫入 `state.json`。
- 已連結的路徑（以 `realpath` 比對）不會重複加入，改為捲動到該列並提示。
- 每個開發插件那一列提供：**重新載入**、**停用／啟用**、**解除連結**、**查看日誌**。
- 資料夾不見或 manifest 無效時，那一列顯示原因，並提供「重新指定資料夾…」和「解除連結」。
- 「解除連結」的確認對話框寫明「不會刪除任何檔案」。
- 命令列帶入的來源在列上標示「本次啟動參數」，不能解除連結，也不寫入設定。與已保存的來源重複時，以 `realpath` 去重。

### 4.3 Python 設定

- 開發者模式區塊內有「Python 直譯器」下拉選單。
- **候選：** PATH 上的 `python3` 和 `python`；Windows 另加 `py` 搭配參數 `-3`。
- **探測方式：** 以 executable 加 args 執行，不經過 shell，限時 3 秒，stdout 上限 4 KiB。探測腳本輸出 Python 版本、`kobrixa` SDK 是否可匯入，以及 SDK 支援的 API 版本。
- **狀態顯示：**
  - ✅ 可用：Python ≥ 3.10，SDK 可匯入，API 版本相容；
  - ⚠️ 沒裝 SDK，或 SDK 的 API 版本不相容；
  - ❌ Python 低於 3.10，或探測失敗。
    每個選項都顯示實際路徑與版本。
- **「其他…」：** 用原生檔案選擇視窗挑一個直譯器，選完一樣要通過探測。
- renderer 只傳候選 ID，實際的 executable 和 args 由主程序保存。
- **生效時機：** 新設定在下一次啟動插件程序時生效。已在執行的 Python 插件顯示「重新載入後套用」。launcher 改成每次啟動程序時，透過 getter 讀取最新設定。
- 探測通過不代表一定能用，啟動握手仍會驗證。
- `--plugin-python` 只覆蓋當次 session，不寫入設定。

### 4.4 日誌與通知

- 主程序為每個來源保留一份日誌，最多 256 KiB；全部合計最多 4 MiB。超過時先丟最舊的內容，並標示「已截斷」。
- 進入緩衝區前先清除 `\r` 以外的控制字元和 ANSI 碼，行內的 `\r` 改成換行。
- 日誌跨程序重啟仍然保留，不寫入磁碟；解除連結時一併清除。
- 面板關閉期間也會繼續收集。按「查看日誌」時才分批讀取，不會每來一行就送一次 IPC。
- 插件發出的通知改由主程序收集保存，每個來源最多 100 則。每則通知收到時就分配遞增的 ID，並顯示嚴重程度。

### 4.5 各插件獨立的忙碌狀態

- 忙碌狀態改成每一列各自計算。
- 命令執行中，只有該插件的「執行命令」按鈕停用；「停用」「重新載入」「解除連結」都還能按。
- 命令執行中的那一列多一個「取消」按鈕，使用協定已有的取消機制。
- 錯誤訊息一律轉成可讀文字，不會顯示 `[object Object]`。之後收到新的狀態事件時，會清掉過時的「要求失敗」提示。

### 4.6 復原：條件式安全模式

**session marker：** `<userData>/plugins/session.json`，由主程序維護。

| 欄位                   | 寫入時機                                                                  |
| ---------------------- | ------------------------------------------------------------------------- |
| `startedAt`            | 啟動時                                                                    |
| `thirdPartyRunning`    | 第三方插件程序啟動或結束時更新                                            |
| `rendererUnresponsive` | `unresponsive` 或 `render-process-gone` 事件發生時設為 `true`，之後不清除 |

- **正常結束：** `will-quit` 完成時刪除 marker。主程序收到 SIGINT 或 SIGTERM 時走正常關閉流程，結束時一樣刪除 marker。
- **觸發條件：** 啟動時發現 marker 還在，而且 `thirdPartyRunning` 或 `rendererUnresponsive` 為 `true`，就進入安全模式，並在 `state.json` 寫入 `safeModeLock`。
- **鎖定：** 跨重啟保留，直到使用者解除。
- **橫幅：** 文字是「Kobrixa 上次沒有正常結束，已暫停第三方插件。」，不斷言一定是插件造成的。提供兩個按鈕：
  - **恢復插件**：解除鎖定，並重新載入第三方來源；
  - **前往插件設定**：可以先停用個別插件再恢復。
- `rendererUnresponsive` 在同一次 session 稍後正常結束時仍然保留，所以下次啟動會觸發。
- `--safe-mode` 維持只在當次生效，不寫入鎖定。

### 4.7 IPC

- 新增的 channel（`plugins:setDeveloperMode`、`plugins:linkFolder`、`plugins:relinkFolder`、`plugins:unlink`、`plugins:reload`、`plugins:cancel`、`plugins:pythonCandidates`、`plugins:setPython`、`plugins:readLog`、`plugins:clearSafeModeLock`）都經過現有的受信任 wrapper。
- renderer 只傳 `sourceKey` 或候選 ID，不傳路徑或執行檔。
- 開發者模式、安全模式和是否正在關閉，一律在主程序檢查。
- **限制：** 這能防止「沒經過使用者選擇就加入任意路徑或執行檔」，但防不了已經被入侵的合法 renderer。文件需要寫明這一點。

### 4.8 1b 的測試與驗收

**單元測試：**

- controller 在開發者模式、安全模式、正在關閉時的權限檢查；
- Python 探測的逾時、輸出上限與狀態分類；
- 日誌的單一來源與全域容量上限、截斷標示、控制字元清理；
- session marker 的各種情境：正常結束、SIGINT、當機時有第三方程序在跑、當機時沒有第三方程序在跑、畫面無回應後又正常結束；
- 面板各插件的忙碌狀態、revision 處理、錯誤文字。

**Electron smoke**（原生對話框用注入的假實作取代）：

1. 全新 profile 開啟後，開發者模式為關閉；拒絕確認後狀態不變。
2. 開啟開發者模式、連結 hello-ts、執行命令，重啟後連結仍然存在。
3. 重新載入、解除連結；解除後原始檔案仍然存在。
4. 模擬畫面無回應後強制結束；下次啟動出現安全模式橫幅，按「恢復插件」後恢復正常。
5. 現有的命令列 smoke 保持通過。

**平台：** smoke 在現有 CI 的平台上執行。

## 5. 實作順序

1. **1a 執行層強化**：§3，介面不變，可以單獨合併。
2. **1b 圖形介面管理**：§4，依賴 1a 的 `sourceKey`、generation、revision 與動態 API。

兩份計畫完成後，同步更新 `plugins/samples/README.md`、`docs/{en,zh-TW}/architecture.md` 和根目錄 README：圖形介面流程為主，命令列旗標改為進階用法；並從第二階段待辦清單移除已處理的項目。
