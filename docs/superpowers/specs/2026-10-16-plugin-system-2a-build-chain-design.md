# 插件化編譯鏈與通用成品契約設計（第二階段 2A）

日期：2026-10-16  
狀態：Claude 與 Codex 經三輪討論達成共識，使用者已核准設計方向與「outputDir 排他鎖」的取捨。尚未實作。

- 上層設計：[插件系統設計](2026-10-14-plugin-system-design.md)（§2、§5.3、§11 第二階段）
- 待辦清單：[第二階段待辦](../plans/2026-10-15-plugin-system-phase-2-backlog.md)

## 1. 背景、範圍與目標

第二階段（插件化編譯鏈）拆成四個子專案，各自走 spec → plan → 實作，分支都從整合分支 `feat/plugin-system-stage-2` 分出、完成後合回：

| 子專案 | 內容                                                                        |
| ------ | --------------------------------------------------------------------------- |
| task 0 | 第二階段待辦的高優先四項                                                    |
| **2A** | **本文件：編譯前端／後端由插件提供，通用成品契約**                          |
| 2B     | 診斷 `source` 契約、`diagnosticHelp` 貢獻、語言分析／補全／Quick Fix 提供者 |
| 2C     | 靜態語言貢獻（宣告式 tokenizer 與資源上限）                                 |

現況的問題：

- `ProjectManifest.language` 寫死 `"bp"`、`target` 寫死 `"ev3-native"`（[contracts.ts](../../../packages/compiler/src/contracts.ts)）；`CompilerBackend` 回傳固定的 `rbf`／`listing` 欄位。
- `BuildSession` 只會產出 `.rbf`／`.ir.json`／`.lst`，並逐檔 rename；`build.ts`、`build-path.ts` 用 `kind === "rbf"` 找部署主檔。
- `PluginManager.frontendFor()` 有多個提供者時取第一筆；後端沒有經過插件註冊。
- `prepare-simulation.ts` 直接 `new BasicPlusFrontend()`，繞過插件選擇。
- 來源檔探索寫死 `**/*.bp|bpi|bpm`（[manifest.ts](../../../packages/compiler/src/manifest.ts) `loadSources`）。
- `execution.ts` 把「建置成功但沒有可部署程式」當成失敗。

**目標：** Basic Plus 前端與 EV3 後端都以內建插件的貢獻提供，宿主依專案的 `language`／`target` 解析提供者；後端以宣告的成品清單取代寫死的 `.rbf`，宿主負責驗證、提交與部署。既有範例、bytecode、取消、Folder／runtimeDirectory 與部署行為保持不變。

**不在範圍內：**

- 外部（非內建）插件提供前端或後端；跨程序的 build RPC（大型 IR 傳輸、取消、版本協商）另立後續里程碑。
- 多版本成品保留、成品庫、GC。
- 診斷 `source`（2B）；語言分析與補全的插件化（2B）；tokenizer（2C）。
- 改變模擬目前「後端必須能編譯」的門檻。

## 2. Manifest 貢獻

`packages/plugin-protocol` 的 `contributes`：

```ts
frontends: Array<{
  language: LanguageId; // /^[a-z][a-z0-9-]{0,31}$/
  entryExtensions: Extension[]; // 入口檔可用的副檔名，須為 sourceExtensions 的子集
  sourceExtensions: Extension[]; // 來源檔探索用
  ir: { min: number; max: number }; // 產出的 KobrixaIR 版本，正整數閉區間
}>; // 最多 8

backends: Array<{
  target: TargetId; // 同 LanguageId 格式
  ir: { min: number; max: number }; // 接受的 IR 版本
  capabilities: { deploy?: "ev3" }; // 宿主認得的部署方式
  artifacts: ArtifactDecl[]; // 最多 16
}>; // 最多 8

type ArtifactDecl = {
  slot: string; // 後端內唯一，/^[a-z][a-z0-9-]{0,31}$/
  kind: string; // 同格式，供 UI 與工具辨識
  extension: Extension; // /^[a-z0-9]{1,16}$/，不含點
  mediaType: string; // type/subtype，最長 127
  role: "deploy-main" | "aux"; // deploy-asset 由宿主從專案資源產生，後端不可宣告
  required: boolean;
};
```

- 目前 IR 版本為 1（[ir/types.ts](../../../packages/ir/src/types.ts)），Basic Plus 與 EV3 都宣告 `{ min: 1, max: 1 }`。
- 有 `capabilities.deploy` 的後端，必須恰好宣告一個 `required: true` 的 `deploy-main`。
- `ir`、`asset` 是宿主保留的 slot，後端宣告時 manifest 判為無效，成品驗證也會拒絕。
- 外部插件宣告 `frontends` 時沿用 `PLUGIN_E_FRONTEND_REQUIRES_BUILTIN`；宣告 `backends` 時新增 `PLUGIN_E_BACKEND_REQUIRES_BUILTIN`，訊息「Compiler backends can only be contributed by built-in plugins in this version.」。整個插件判為 invalid（[registry.ts](../../../packages/plugin-runtime/src/registry.ts)）。
- **API 版本升為 1.1.0。** 既有 `frontends` 項目新增必填欄位，但有效的 1.0 外部插件本來就不能宣告前端，所以對外部插件仍相容；內建的 [`plugins/basic-plus/kobrixa-plugin.json`](../../../plugins/basic-plus/kobrixa-plugin.json) 直接補上宣告，不做相容層。EV3 後端另立內建插件 `kobrixa.ev3`（`plugins/ev3/kobrixa-plugin.json`），讓前端與目標可以分開衝突檢查，日後也能分開停用。
- 同步更新提交到 repo 的 JSON Schema、JS SDK 與 Python SDK 的 API 版本常數與共用 conformance 案例。

## 3. 提供者解析

- `ProjectManifest.language`、`target` 改成經 schema 驗證的字串（同 LanguageId 格式）；`LanguageFrontend.id`、`CompilerBackend.id` 也改為字串，代表語言／目標，與提供者的插件 ID 分開。`schemaVersion` 維持 1，舊專案照常開啟；隱式專案（無 manifest）仍預設 `bp`／`ev3-native`。
- `PluginManager.frontendFor()` 改為 `resolveCompiler(language, target)`，回傳：

  ```ts
  type CompilerResolution =
    | { ok: true; frontend: ProviderRef; backend: ProviderRef; ir: number }
    | { ok: false; code: "BUILD1001" | "BUILD1002"; message: string };
  type ProviderRef = {
    pluginId: string;
    sourceKey: string;
    contribution: FrontendDecl | BackendDecl;
  };
  ```

- 只看已啟用且有效的插件。同一個 `language` 或 `target` 有兩個以上啟用中的提供者時，**全部**判為衝突：相關插件標記 `PLUGIN_E_PROVIDER_CONFLICT`，解析回 BUILD1001，不取第一筆。停用其中一個後重新檢查即恢復（2A 的內建編譯器仍不能由使用者停用，這條規則以測試註冊的提供者驗證；開放停用內建插件需另行設計設定、持久化與安全模式）。
- 前端與後端 IR 範圍取交集，取最大值；交集為空回 BUILD1002「前端產出的 IR 版本與目標不相容」。
- 找不到提供者時回 BUILD1001「找不到已啟用的語言／目標提供者：<language>／<target>」，不啟動 build worker。
- 安全模式與停用沿用 1a／1b 的規則；內建插件在安全模式下仍保留。

## 4. 內建 adapter 與共用編譯

- [`builtin-frontends.ts`](../../../apps/desktop/src/main/workspace/builtin-frontends.ts) 擴充為 `builtin-compilers.ts`：前端與後端兩張工廠表，以 `(pluginId, language)`、`(pluginId, target)` 為鍵。main 把解析結果的快照（插件 ID、宣告、IR 版本）傳給 build worker，worker 依快照建立實例；找不到工廠時回 BUILD1001。
- EV3 函式庫（[backend-ev3](../../../packages/backend-ev3/src/backend.ts)）改回傳自己的 `EV3Result { rbf, listing, diagnostics }`，由內建 adapter 轉成通用 `BackendResult`；bytecode 演算法不變。
- 抽出 `compileToMemory(project, frontend, backend, signal)`：前端 → IR 驗證 → 後端 → 驗證成品，全部在記憶體完成，不落盤。`BuildSession` 用它計算後再提交；`prepare-simulation.ts` 改走同一個解析與 `compileToMemory`，保留現有的 4 個入口、64 個資源／1 MiB、資源快照檢查，並維持「後端必須成功」的門檻。
- `loadSources` 依解析出的前端 `sourceExtensions` 探索來源與 overlay；入口副檔名必須在 `entryExtensions` 內；保留路徑驗證、不跟隨符號連結、排除 `outputDir`。

## 5. 通用成品契約

```ts
interface BackendResult {
  artifacts: Array<{ slot: string; data: Uint8Array }>;
  diagnostics: Diagnostic[];
}

interface BuildArtifact {
  slot: string; // 宿主產生的成品用保留 slot：ir、asset
  kind: string;
  role: "deploy-main" | "deploy-asset" | "aux";
  mediaType: string;
  path: string;
  sha256: string;
  byteLength: number;
  remotePath?: string; // deploy-asset 專用
}

interface CompileResult {
  buildId: string;
  target: string;
  deploy?: "ev3"; // 後端宣告的部署能力；沒有代表不可部署
  runtimeDirectory?: string;
  success: boolean;
  diagnostics: Diagnostic[];
  artifacts: BuildArtifact[]; // 失敗時為空
}
```

- 後端只回 `{ slot, data }`；`kind`、`role`、`mediaType`、副檔名都由宣告決定，宿主計算 `path`、`sha256`、`byteLength`。
- 宿主產生的成品：IR（`slot: "ir"`、`kind: "ir"`、`role: "aux"`、`<名稱>.ir.json`）與專案資源（`slot: "asset"`、`role: "deploy-asset"`）。listing 由後端宣告為 `aux`。
- 成功的條件：沒有 error 診斷、所有 `required` 的宣告都有對應成品、可部署的後端有唯一且非空的 `deploy-main`。
- **驗證規則**（違反時 BUILD1003，整個建置失敗、不改動最終成品；outputDir 本身、staging 與鎖檔可能已建立）：
  - 拒絕未宣告的 slot、重複 slot、缺少必要 slot、空的 `deploy-main`。
  - 檔名為 `<安全化專案名稱>.<extension>`；同一建置內的檔名與資源路徑在 Unicode NFC 正規化並轉小寫後不得碰撞，也不得與保留名稱（`.kobrixa*`）衝突。
  - 資源路徑不得越界或經過符號連結。
- **上限常數**（`BUILD_LIMITS`，v1）：

  | 項目             | 上限               |
  | ---------------- | ------------------ |
  | 後端產生的成品數 | 64                 |
  | 含資源的成品總數 | 1024               |
  | 單一成品         | 64 MiB             |
  | 全部成品合計     | 256 MiB            |
  | 檔名             | 128 bytes（UTF-8） |
  | 相對路徑         | 512 bytes（UTF-8） |

  大小在讀寫時累計，hash 取 staging 內的實際內容。

## 6. 提交與 outputDir 排他鎖

- **輸出位置不變：** `outputDir/<名稱>.<extension>`、`outputDir/assets/<相對路徑>`，使用者與外部工具依賴的 `<名稱>.rbf` 位置不變。
- **流程：**
  1. `compileToMemory` 完成並通過 §5 驗證。
  2. 寫入 `outputDir/.kobrixa-<buildId>.tmp/`（含資源複製），計算 hash。
  3. 取得 outputDir 鎖（見下）。
  4. 第一次 rename 前最後一次檢查取消；之後依 **aux → deploy-asset → deploy-main** 的順序 rename 到最終位置。
  5. 釋放鎖、刪除 staging。
- **取消邊界：** 第一次 rename 之前取消回 BUILD0001、outputDir 不變；開始 rename 之後一定做完。rename 中途 I/O 失敗回 BUILD9000、成品清單為空；磁碟上可能留下新舊混合的檔案，部署會在 §7 被擋下。
- **程序內排隊：** `BuildService` 依 canonical outputDir（`realpath`）維護 FIFO，同一個 outputDir 的建置一次只跑一個（目前每次直接開 worker，沒有排隊）。
- **跨程序排他鎖（使用者決定採用）：** Kobrixa 沒有 `requestSingleInstanceLock`，兩個實例可能交錯提交，留下兩邊都回報成功卻不完整的成品組。只在步驟 3–4 持有 `outputDir/.kobrixa-build.lock`：
  - 以 `open(path, "wx")` 建立，內容 `{ pid, startedAt }`。
  - 已存在時讀取內容：pid 不存在（`process.kill(pid, 0)` 回 ESRCH）或內容無法解析且檔案超過 60 秒，視為殘留，刪除後重試一次。
  - 仍被佔用時每 100 ms 重試，最多 5 秒；逾時回 BUILD1004「另一個 Kobrixa 視窗正在寫入這個專案的建置輸出」。
  - 釋放時只刪除自己寫入的鎖（比對內容）。
  - 鎖只保護提交，不保護整段編譯；同一部電腦以外（網路磁碟）的 pid 判斷不保證正確，文件註明。
  - 回收殘留鎖是「比對內容後刪除」，不是原子操作：兩個程序同時回收同一個殘留鎖時，極少數排程下可能刪到對方剛建立的鎖。這需要殘留鎖加上兩個程序同時提交才會發生，2A 接受此限制並在文件註明。

## 7. 消費端

- **部署**（[build.ts](../../../apps/desktop/src/main/workspace/build.ts)、[device.ts](../../../apps/desktop/src/main/device/device.ts)）：
  - 依 `role` 選檔，不再用 `kind === "rbf"`；`CompileResult.deploy` 必須是設備支援的方式（目前只有 `"ev3"`），否則 BUILD1005。
  - 先把所有要部署的檔案讀進記憶體並比對 `sha256`，全部相符後才上傳這批記憶體內容；檔案不見或 hash 不符回 BUILD1006「成品已變更，請重新建置」。設備傳輸本身仍不是原子操作。
  - 順序：`deploy-asset` 依 `remotePath` 排序先上傳，`deploy-main` 最後。保留 Folder／`runtimeDirectory`、設備鎖與略過未變更資源的行為。
- **renderer**（[build-path.ts](../../../apps/desktop/src/renderer/execution/build-path.ts)、[execution.ts](../../../apps/desktop/src/renderer/execution/execution.ts)）：依 `deploy` 與 `role` 組出部署路徑；「建置成功但不可部署」視為建置成功，執行／部署按鈕顯示不可部署的原因，不顯示成建置失敗。
- **模擬：** 由宿主依實際 IR 版本與模擬器支援判斷；不新增後端的模擬能力宣告。
- 全庫移除通用的 `kind === "rbf"` 判斷；`motor-test-service.ts` 的 helper `.rbf` 是設備端自己的程式，不屬於建置成品，不在此範圍。

## 8. 錯誤碼

保留 IR 驗證、BUILD0001（取消）、BUILD9000（例外與提交 I/O 失敗）、EV39000 與 worker 的共享記憶體同步取消。新增：

| 代碼      | 意義                              |
| --------- | --------------------------------- |
| BUILD1001 | 找不到提供者或提供者衝突          |
| BUILD1002 | 前端與後端的 IR 版本不相容        |
| BUILD1003 | 成品不符合宣告或超過上限          |
| BUILD1004 | outputDir 正被另一個 Kobrixa 寫入 |
| BUILD1005 | 目標不支援這個部署方式            |
| BUILD1006 | 成品已變更，請重新建置            |

新代碼在 [`diagnostic-help.ts`](../../../packages/compiler/src/diagnostic-help.ts) 補上英文與繁體中文說明，沿用既有官方說明網址格式。

## 9. 測試與驗收

- **假前端與假後端**（只在測試註冊）：不同副檔名、非 `.rbf` 的主成品、多個 aux，完整走過解析、建置、提交與部署選檔。
- **解析：** 衝突、停用後恢復、IR 不相容、外部插件宣告前後端被拒、找不到提供者時不開 worker。
- **成品驗證：** 每條 §5 規則與每個上限各有反例，含剛好到上限的正例。
- **提交：** 注入寫檔、rename 中途、鎖取得失敗，確認 outputDir 不變或回報正確錯誤；第一次 rename 前後取消；同一 outputDir 兩個建置排隊；殘留鎖（pid 不存在）被回收；兩個程序同時提交時其中一個等待或回 BUILD1004。
- **部署：** hash 不符與檔案遺失回 BUILD1006 且未上傳任何檔案；資源先、主檔最後；Folder 行為不變。
- **回歸：** 既有範例、`pnpm test:bytecode`、`build.test.ts` 的同步取消、模擬快照、schema drift、JSON Schema 與兩個 SDK 的 conformance、打包後的 worker 測試全部通過。

## 10. 實作切分

task 0 完成後，2A 依序分成八個可獨立審查的 task，每個都附測試：

1. Manifest schema、`ArtifactDecl`、API 1.1、JSON Schema 與兩個 SDK 同步。
2. `resolveCompiler`：提供者解析、衝突、IR 交集、外部插件拒絕。
3. 前後端工廠表、EV3 adapter、Basic Plus 與 EV3 的內建宣告。
4. 依前端宣告的來源探索、`compileToMemory`、模擬改走解析。
5. 通用成品型別、驗證規則與 `BUILD_LIMITS`。
6. staging、程序內 FIFO、outputDir 排他鎖、提交順序與取消邊界。
7. 部署讀入記憶體並驗 hash、依 role 選檔、renderer 與 execution 的可部署判斷。
8. 假後端、故障注入與競態驗收；既有回歸；英文與繁體中文的 architecture／插件文件更新。
