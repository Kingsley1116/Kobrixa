# Kobrixa 插件系統第四階段：正式打包與發布提案

日期：2026-11-11  
狀態：**PROPOSAL／未核准／未實作／未交付**。本文是第四階段開始前的獨立打包提案，不是實作授權、驗收結果或發布承諾。除「已讀基線」與附來源的歷史觀察外，下文的格式、欄位、數值、流程及 CLI 都是待決方案。

- 上層約束：[主設計 §9、§11](2026-10-14-plugin-system-design.md)、[協商紀錄 §5.2–§5.3](2026-10-14-plugin-system-negotiation.md)、[roadmap](../../en/roadmap.md)。Stage 4 包含正式打包、managed runtimes、產生式 Python bindings、相依解析／版本回退與開發 CLI；驗收後才對一般使用者開放可信第三方插件。
- 承接文件：[Stage 3 umbrella design](2026-10-17-plugin-system-stage-3-design.md)、[Stage 3 current ledger](2026-10-17-plugin-system-stage-3-design.md#s3-current-ledger)。伴隨文件：Stage 4 實作綱要（草案：`../plans/2026-11-11-plugin-system-stage-4-outline.md`；尚未納入 git 追蹤）。
- **硬性 entry gate：Stage 3 完成全部必要驗收並合併至 `feat/plugin-system`，且本提案與 owner decisions 核准後，才開始 Stage 4 實作。** 撰寫本提案不表示 gate 已通過；也不授權合併 `main` 或發布。

## 1. 範圍與非目標

目標是讓使用者在沒有 checkout、Python、Node、編譯器或套件管理工具的乾淨機器，安裝可驗證、可離線取得、可停用、可復原的可信插件。先支援現有公開 consumer API；打包本身不增加設備權限或解除 builtin-only 限制。

| 項目          | 本提案範圍                                                                                                                                               |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 套件          | manifest／payload／資源／相依 lock／完整性／簽章、平台 variant、離線完整集合、驗證與大小上限。                                                           |
| 生命週期      | install／update／rollback／uninstall、穩定 source identity、資料遷移、crash recovery、safe mode 與撤銷。                                                 |
| runtimes／SDK | 固定版本的共享唯讀 Python、各插件相依隔離、由已提交 JSON Schema 產生 Python 型別；Node 沿用宿主 runtime。原生 stdio executable 另有明確 admission 工作。 |
| 發布          | 發布者信任、權限同意、受驗證更新 metadata、開發 CLI、三平台 installed／硬體／人工驗收後的一般第三方 consumer 開放。                                      |

**非目標：** marketplace、WASM Host、隔離 HTML panel、任意 React／CSS／script 注入、通用 service bus、多設備 UX、remote-files 等剩餘 UI 插件化，以及任意不可信程式的跨平台完整沙箱。主設計明確將 marketplace 與 WASM Host 留給獨立提案；它們不阻擋 Stage 4。

第三方 device providers 繼續拒絕：Stage 3 §8 要求另定 provider RPC、capability version、physical-device conflicts、containment、native packaging 與失效停止。第三方 compiler frontend/backend 與 language-service RPC 也不因安裝格式而自動開放；現有拒絕點見 §2。Rust／Go／C++ executable 的包裝與 stdio 啟動，不等於開放 provider，也不代表本階段交付各語言完整 SDK。

## 2. 已讀基線與設計缺口

讀取當下分支為 `feat/plugin-system-stage-3`，HEAD 為 `60a0bde`；工作樹有其他工作者的未提交變更。以下是所讀檔案的觀察，不是乾淨 commit 或最終成品認證。指定 CI 目錄對應 `b08336b`；audit 自述基線為 `d228baa`，三者不能混為同一次驗收。實作前須重查 Stage 3 合併結果。

| 已讀來源                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 可確認的現況／對 Stage 4 的影響                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`limits.ts`](../../../packages/plugin-protocol/src/limits.ts)、[`manifest.ts`](../../../packages/plugin-protocol/src/manifest.ts)、[`json-schema.ts`](../../../packages/plugin-protocol/src/json-schema.ts)                                                                                                                                                                                                                                                            | API 為 `1.8.0`；runtime kinds 為 `static`／`builtin`／`node`／`python`。`apiVersion` 僅接受 exact／`^`／`~` 三段版本；manifest 外層允許未知欄位，不能據此聲稱有正式 dependency／signature 語意。Zod 匯出 input 語意的 draft-2020-12 Schema，不可表示內容會失敗。                                                                                                  |
| [`registry.ts`](../../../packages/plugin-runtime/src/registry.ts)、[`compiler-resolution.ts`](../../../packages/plugin-runtime/src/compiler-resolution.ts)                                                                                                                                                                                                                                                                                                              | source 僅有 builtin／development；`dev:` key 是目錄路徑雜湊，`builtin:` key 綁 ID。registry 使用 `semver.satisfies`，檢查 realpath／entry；外部 deviceProviders、frontends、backends、languageServices 被拒絕。相同 language／target 的 enabled providers 衝突時失效，沒有載入順序勝出。尚不能把版本目錄直接當穩定安裝身分。                                      |
| [`manager.ts`](../../../packages/plugin-runtime/src/manager.ts)、[`supervisor.ts`](../../../packages/plugin-runtime/src/supervisor.ts)                                                                                                                                                                                                                                                                                                                                  | 已有 enable／disable／reload、generation、撤銷與程序監督。`initialize` 傳 host 指派 ID、locale、grantedPermissions；握手有 major 檢查及後續分域協商。這些不是套件相依 solver 或套件交易。                                                                                                                                                                         |
| [`launchers.ts`](../../../apps/desktop/src/main/plugins/launchers.ts)、[`python.ts`](../../../apps/desktop/src/main/plugins/python.ts)                                                                                                                                                                                                                                                                                                                                  | JS 使用 Electron `utilityProcess`＋MessagePort；Python 使用選定 interpreter 的 `-u entry`＋stdio。probe 最低 Python 3.10；目前 launcher 沒有下載 Python 或建立 per-plugin runtime。Node 清除部分注入環境變數，Python 仍繼承 host environment；正式模式須另定 allowlist。                                                                                          |
| [`controller.ts`](../../../apps/desktop/src/main/plugins/controller.ts)、[`state-store.ts`](../../../apps/desktop/src/main/plugins/state-store.ts)、[`session.ts`](../../../apps/desktop/src/main/plugins/session.ts)                                                                                                                                                                                                                                                   | main 驗 developer／safe-mode／shutdown gate；state schema v2 保存來源、disabled、Python 選擇、safe-mode lock，以 temp＋rename 序列化寫入，沒有安裝 graph transaction。session 記錄 third-party process／static／UI risk 與 renderer hang；static／UI delivery 有 checked marker 寫入，部分其他 marker 更新仍 best effort。不能稱所有 risk 寫入均具 durable 保證。 |
| [`persistence/worker.ts`](../../../apps/desktop/src/main/plugins/persistence/worker.ts)、[`atomic-store.ts`](../../../apps/desktop/src/main/plugins/persistence/atomic-store.ts)、[`namespace.ts`](../../../apps/desktop/src/main/plugins/persistence/namespace.ts)、[`import-journal.ts`](../../../apps/desktop/src/main/plugins/persistence/import-journal.ts)                                                                                                        | worker_threads、source namespace、版本化 head／payload、publication ticket、reconcile、checkpoint／import evidence 已存在。import 會核對 descriptor／source／schema／receipt，並非任意插件 migration runner；現有逐筆 publication 也不是跨插件原子切換。                                                                                                          |
| [`persistence/filesystem.ts`](../../../apps/desktop/src/main/plugins/persistence/filesystem.ts)、[`profile-writer-lock.ts`](../../../packages/plugin-runtime/src/profile-writer-lock.ts)、[`shutdown-coordinator.ts`](../../../apps/desktop/src/main/plugins/shutdown-coordinator.ts)、[`journal-filesystem.ts`](../../../apps/desktop/src/main/device-broker/journal-filesystem.ts)                                                                                    | persistence 使用 profile lock／host epoch，Windows 有明示 `file-sync-only` 策略；device safety journal 則在 Windows directory barrier 回 `ENOTSUP`，不接受同一降級。close/update 依 lifecycle 結果保留 blocker。套件 journal 不可冒充或清除設備 fault journal。                                                                                                   |
| [`JS SDK`](../../../packages/plugin-sdk-js/src/index.ts)、Python [`_plugin.py`](../../../sdks/python/kobrixa/_plugin.py)、[`_schema.py`](../../../sdks/python/kobrixa/_schema.py)、[`pyproject.toml`](../../../sdks/python/pyproject.toml)                                                                                                                                                                                                                              | JS 有 devices／UI／settings／storage 客戶端；Python stdlib runtime 使用 dict、bundled Schema validator 與手寫 domain semantics。Python distribution 為 `0.1.0`、API 為 `1.8.0`；不可用 distribution version 判斷 API 不相容。尚無由該 Schema 產生的完整 bindings。                                                                                                |
| [`basic-plus`](../../../plugins/basic-plus/kobrixa-plugin.json)、[`ev3`](../../../plugins/ev3/kobrixa-plugin.json)、[`motor-test`](../../../plugins/motor-test/kobrixa-plugin.json)、[`sensor-lab`](../../../plugins/sensor-lab/kobrixa-plugin.json)、[`device-ev3`](../../../plugins/device-ev3/kobrixa-plugin.json)、[`hello-ts`](../../../plugins/samples/hello-ts/kobrixa-plugin.json)、[`hello-python`](../../../plugins/samples/hello-python/kobrixa-plugin.json) | builtin compiler 分別提供 `bp`／`ev3-native`。Motor 為 `^1.6.0` Node consumer，Lab／device 為 `^1.8.0`；device 的 builtin declaration 不構成第三方 provider 註冊入口。兩個 hello samples 是開發來源範例，不是正式可驗簽安裝包。                                                                                                                                   |
| [`builtin-launch.ts`](../../../apps/desktop/src/main/plugins/builtin-launch.ts)、[`packaging.ts`](../../../apps/desktop/packaging.ts)、[`desktop-packaging.mjs`](../../../tools/release/desktop-packaging.mjs)                                                                                                                                                                                                                                                          | 已有 builtin leaf／resource-index 的 bytes／SHA-256 檢查、三個 feature payload 與 persistence worker 打包／unpack 接線、native dependency 篩選與 notices。builtin validator 明說 pathname snapshot 無法原子抵抗持續惡意 rename；不能宣稱已解決第三方 TOCTOU。                                                                                                     |
| [`archive.mjs`](../../../tools/release/archive.mjs)、[`update-assets.mjs`](../../../tools/release/update-assets.mjs)、[`signing.mjs`](../../../tools/release/signing.mjs)                                                                                                                                                                                                                                                                                               | 工具處理 desktop archive tree、checksums、installer/update metadata 與可配置的 OS 簽章驗證。它們不是插件 publisher trust store；app code signing 也不替插件簽署者背書。                                                                                                                                                                                           |
| [architecture 插件段落](../../en/architecture.md)、[roadmap](../../en/roadmap.md)                                                                                                                                                                                                                                                                                                                                                                                       | 文件仍定位 trusted local／development preview，且記錄未管理 Python、未生成 bindings、process isolation 非 OS sandbox。architecture 前段「devices planned」與後段 API 1.8 development branch 有時序落差；以所讀程式碼及 Stage 3 closeout 區分已實作與已驗收，不在本提案順手修改產品文件。                                                                          |

本提案解決的是上述正式安裝／發布契約缺口，不宣稱修正 Stage 3 CI。`b08336b` 的 desktop-mac job 記錄三次 load 的 `apply:false`，第一次另有 `revoke:false`；desktop-win job 在 declarative-ui fixture 路徑 `/D:/...` 建置失敗；desktop-linux job 記錄 apt DNS／下載失敗與 exit 100。這些是該 run 的觀察，不是目前 dirty tree 的重跑結果，也不代表後續步驟通過。

## 3. Stage 3 承接條件與例外

依 [Stage 3 current ledger](2026-10-17-plugin-system-stage-3-design.md#s3-current-ledger)，下列仍須 Stage 3 owner 逐列結案。表中是稽核待辦摘要；同工作樹後續修正不自動改變驗收狀態。

| Row   | 進場前所需證據                                                                                         |
| ----- | ------------------------------------------------------------------------------------------------------ |
| S3-01 | 當前 API／雙 SDK／schema drift、1.4–1.8 compatibility 與不支援版本的完整證據。                         |
| S3-02 | 真正 MessagePort／stdio 的 method × transport × failure matrix，不只成功情境。                         |
| S3-03 | motor／Lab／device 最終 source、bundle、RPC audit；device E7 retirement 後保留 core／files 能力。      |
| S3-04 | 最終 artifact 的 motor 77-case native matrix；實體停止仍另驗。                                         |
| S3-05 | 單一 broker／provider／lock inventory、失效與 Disconnect 仲裁、Windows journal。                       |
| S3-06 | collaboration authority transitions、每個 consequential await、兩 client 與硬體操作證據。              |
| S3-07 | v2 最大 UI workload、latency／resources、重複實驗與 R2 記憶體裁決。                                    |
| S3-08 | Lab final product lifecycle／failure／D9b／installed 證據；不重作 audit 已辨識的 D8 retirement。       |
| S3-09 | N01–N29、RF1 真正 kill／reopen、RF5 完整 import cuts、雙 transport、壓力／資料完整性。                 |
| S3-10 | umbrella §4.7、cold safe mode、三 optional switches、single-instance 全部觀察。                        |
| S3-11 | 最終 close／update／stop／save／force-exit／restart、無 orphan，未確認結果仍為 blocker。               |
| S3-12 | 三個公開功能與 single-instance 的 source-free／network-denied installed 自動化，實際交付平台逐項證明。 |
| S3-13 | H1：USB／Wi-Fi motor safety；區分送 stop、readback 與實體停止。                                        |
| S3-14 | H2–H3：真實 Lab／monitor／mode／仲裁／最大錄製／authority／suspend。                                   |
| S3-15 | H4–H6：舊 profile 與資料復原、乾淨安裝／開關／second launch、雙語／主題／鍵盤／IME／screen reader。    |
| S3-16 | W21 逐項 ledger 與雙語文件、artifact／commit 對應、保留例外與歷史失敗。                                |

**R1 不移轉成 Stage 4 的可忽略 bug。** 已讀 production Windows safety journal 仍 fail closed；native prototype 或 mock barrier 不等於 shipped adapter 通過。須核准並實作原 durability contract，或明確完成範圍修訂與驗收；不能把 Windows 刪掉後宣稱原三平台要求完成。

**R2 仍是 owner ruling。** thread 與 main 的 RSS 屬同一程序，不能相減當獨立 RSS。audit 的選項是分 process 保留原 budgets、經審查重定 thread 指標，或維持未結案。建議沿用 audit 的 thread 量測裁決方向，但本文不核准任何替代數字，尤其不把 32＋64 MiB 當已核准總額。既有資料量、queue、10 秒 commit／flush 與 latency 要求均保留；partial report 不能成為 full pass。

H1–H6 在該 audit 中皆 **NOT RUN**。本次沒有執行，也沒有替它們簽核。Stage 2 V01–V03 與 V04 環境例外保持獨立狀態；Stage 4 若受其影響須列出具體阻塞／正式處置，不能繼承成 pass。

Stage 3 §8 仍保留 remote-files UI、simulator、collaboration UI、editor、workspace、legacy settings、updates UI／installer 的過渡例外。這些是各自 future spec 的責任，不是 Stage 4 包裝完成即可移除的列。HTML host 與 external device-provider contract 同樣維持獨立 gate；motor／Lab 退出例外須消費 Stage 3 最終證據。

進場紀錄至少包含：Stage 3 合併 commit、S3-01–16 ledger、R1／R2 決議、H1–H6 實際結果、交付 OS／arch／artifact hashes、所有保留例外的 owner。CI aggregate green 不能替代這份紀錄。

## 4. 套件格式選項與建議

### 4.1 選項比較

| 選項                                                   | 優點                                                                           | 代價／限制                                                                                                                     |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| ZIP container＋獨立嚴格 metadata／integrity／signature | 三平台工具容易檢視、可串流驗證、不綁 JS／Python ecosystem；可一 variant 一檔。 | 必須自己實作安全解壓、canonical metadata、trust 與交易；ZIP 本身不提供 publisher 身分。                                        |
| tar＋壓縮＋相同簽章 envelope                           | 對 Unix 權限／串流友善，runtime 上游常見。                                     | Windows 工具與 path／link 語意較複雜；不應直接繼承 tar 特殊檔案、link、owner。                                                 |
| npm／wheel 作為安裝格式                                | 各語言已有 dependency metadata 與建置工具。                                    | 雙套安裝行為、hooks／native build、平台／runtime 管理、Kobrixa grants 與 rollback 仍需自行補齊；不能把一般使用者環境當開發機。 |
| OCI／內容定址 layers                                   | 去重、內容識別與多平台 metadata 有利。                                         | registry／工具鏈與離線體積、桌面 UX 複雜；對目前本機安裝過重。                                                                 |

**建議：`.kobrixa-plugin` 為受限 ZIP，每檔只含一個 platform variant；純資料／純 JS 可用明示 portable variant。** npm／wheel 只作建置輸入，由 pack 階段完成解析與 vendor；使用者端不跑 npm／pip／postinstall。共享 runtime 使用另類型、同驗證原則的 `.kobrixa-runtime`。不把 app ASAR 當可寫插件 store。

### 4.2 建議 archive layout 與 manifest 擴充

```text
acme.example-1.2.3-darwin-arm64.kobrixa-plugin
  package-metadata.json      # formatVersion、publisher、variant、runtime、dependencies
  kobrixa-plugin.json        # 公開 contributions／permissions／apiVersion
  dependency-lock.json       # exact versions、來源 identity、每個 artifact digest
  payload/                   # entry、vendor code、離線所需 modules
  resources/                 # UI／settings／static language 等宣告資源
  licenses/                  # 授權與 notices
  sbom.json                  # 建置輸入清單；不是安全保證
  integrity.json             # 所有 payload／metadata 檔案的 bytes、mode、SHA-256
  signatures/publisher.json  # 對 canonical integrity envelope 的簽章
```

manifest 的 entry／resource path 仍以 package root 為基準，例如 `payload/main.cjs`；entry 必須落在選中 variant 的允許集合，不能從另一 variant 或 checkout fallback。建議離線配送為一個含 signed collection index 的目錄：精確插件包、runtime 包及其 dependency closure；不必再發明可執行 installer。collection index 也經版本／大小／簽章驗證，每個子包仍獨立驗證。

`package-metadata.json` 使用新的 strict schema，不能藉既有 loose manifest 忽略安全欄位。建議新增下列語意；詳細 JSON Schema 由 4A 凍結：

| 欄位                                       | 提議語意                                                                                                                                           |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `formatVersion`、`minimumInstallerVersion` | 套件格式與最小安裝器版本；未知必要欄位／演算法拒絕，不靜默忽略。                                                                                   |
| `pluginId`、`version`、`publisherId`       | ID／version 必須與 manifest 一致；publisher 是 trust store 的身分，不能只是自填 display name。保留 `kobrixa.*` builtin 身分，不可由第三方覆蓋。    |
| `platform`                                 | `os`、`arch`、最低 OS、Linux libc／ABI、native extension ABI；`any` 只能用於經驗證不含平台 native code 的包。不默認 Rosetta 或 x64 模擬相容。      |
| `runtime`                                  | Node host ABI 要求，或 Python implementation／完整版本／build ID／runtime digest；原生 executable 是待新增 kind，非現有 schema 能力。              |
| `dependencies`／`optionalDependencies`     | 其他插件的 ID＋可信 publisher＋受限 semver range；lock 固定實際 closure。不混用 `requires.devices`。                                               |
| `storage`                                  | data schema、可讀／可寫版本範圍、migration descriptor／digest、rollback 相容宣告；宣告必須有測試，不能覆蓋實測不相容。                             |
| `channel`／`release`                       | stable／preview、release identity、source revision／builder provenance；channel URL 只能指向經使用者信任的來源，不能由 payload 任意改 trust root。 |
| `executionPolicy`                          | 清楚聲明 trusted-local 或指定、已驗證的 sandbox profile；不是可自授予的 OS capability。                                                            |

現有 `apiVersion`、`permissions`、`requires.devices`、UI resource versions 繼續是公開 manifest 的唯一對應來源，不在 metadata 複製成兩套權威。正式包的新 installer 必須拒絕不識別的必要語意；需新增的 wire／runtime 欄位按 API 演進規則同步 TS／Python 與 conformance。

### 4.3 Integrity、大小與可重現性

建議逐檔 SHA-256＋Ed25519 publisher signature。`integrity.json` 列出排序後的 canonical path、長度、有限 executable mode 及 hash，覆蓋 manifest、package metadata、lock、licenses、SBOM、所有 code/resources。integrity 本身與 signature envelope 不列入自身 hash，避免循環；簽署固定 domain separator＋formatVersion＋canonical integrity bytes。簽章 envelope 嚴格限制 key ID／algorithm／長度；額外未列名 ZIP entries 一律拒絕。外部 channel metadata 再綁整個 ZIP digest／bytes，防止下載物替換。

canonical encoding 須在 4A 寫成跨語言規格與 vectors：UTF-8、固定 key order／number 表示、禁止 duplicate JSON keys、無不必要浮點欄位。不可只說「JSON.stringify 即 canonical」。key ID 由已信任的 key material 對照；包內公鑰不自動成為信任根。

以下是**新安裝器的待核准上限初案**，不修改現有 RPC、manifest、UI、storage 或性能 budgets；同時命中多種上限時採最嚴格者：

| 對象           | 提議上限                                                                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 插件 ZIP       | compressed 128 MiB、expanded 512 MiB、20,000 files、單檔 64 MiB。                                                                                           |
| runtime ZIP    | compressed 512 MiB、expanded 2 GiB、100,000 files、單檔 256 MiB；與插件分類分開。                                                                           |
| 解壓           | 每檔與總體壓縮比均 ≤100:1、path ≤240 UTF-8 bytes／depth ≤16；ZIP64／加密／巢狀自動解壓初版拒絕。                                                            |
| metadata       | manifest 沿用現有 64 KiB；package metadata／lock 各 ≤1 MiB，integrity ≤16 MiB，簽章 envelope ≤16 KiB。                                                      |
| resolver／磁碟 | 一次 closure ≤128 plugins、depth ≤16；profile package/runtime cache 初案 8 GiB，交易先預留新舊版本＋資料 snapshot＋暫存需求。無足夠空間時不動 active head。 |

實際串流計數，不信 ZIP 宣告大小；不能先解完再檢查。拒絕 `..`、absolute／drive／UNC、NUL、反斜線歧義、大小寫／Unicode 正規化 collision、Windows reserved names／ADS／尾端 dot/space、symlink／hardlink／reparse point、device node、setuid、重複 entries。解壓只到 host 建立的同 filesystem staging，以不跟隨 link 的原語驗證 parent／leaf；不能用簡單 prefix 比對聲稱安全。runtime 上游若用 symlink，建置端須在授權允許下展平並驗證 relocation，否則該 runtime variant 不可發布。

可重現建置固定 source／lock／runtime／工具版本，排序 entries、固定 timestamp（如 `SOURCE_DATE_EPOCH`）、mode 與壓縮設定，移除絕對路徑／機密／非必要 cache。兩個乾淨 build 比較 unsigned payload 與 integrity bytes；簽署／notarization 的 timestamp／ticket 若不同，另外保留 pre-sign 與最終 bytes 對應，不謊稱整包 bit-identical。重現性減少未知差異，不證明輸入沒有惡意。

## 5. Install／update／rollback／uninstall 交易

### 5.1 身分與原子單位

提議新增 `installed` source 與由 host 指派的穩定 installation identity，邏輯鍵綁 `(publisherId, pluginId)`，不綁 version path。所有 source-key schemas、ResourceOwner、disabled／grants、namespace、risk markers 都須一起演進；不能將正式包冒充 `builtin` 或沿用 `dev:` 目錄雜湊。development → installed 為明確匯入，不能默默取得同 ID 的舊資料或同意。

版本內容放在不可就地修改的 `packages/<identity>/<version>/<digest>/`；shared runtimes 以完整 build identity＋digest 定址。這裡的「不可修改」是 host 寫入政策與 ACL／mode，不保證同使用者的未沙箱程式無法破壞它；啟用前仍驗證。只讀 app builtin payload 由 app updater 管理，不能用一般插件包替換。

**一個交易 commit head** 指向已驗證的 activation graph、exact runtime／dependency lock、資料 generation 與 grants digest。graph 與資料 candidate 先完全寫妥，再 publish head；不依賴數次互不相干 rename 當跨檔原子交易。manager／controller 僅從 committed head 建立 catalog。這是新增 package-store 契約，現有 `state.json` 的 temp＋rename 或 AtomicStore 的單一 record CAS 都不能直接提供此保證。

### 5.2 建議狀態機

```text
Absent → Acquiring → Quarantined → Verified → Resolved → AwaitingConsent
       → Prepared → Quiescing → Migrating → ReadyToCommit → CommittedDisabled
       → Active（只有明確啟用／既有同意仍適用且不在 safe mode）

Active → update candidate（舊版仍保留）→ 同一交易流程
Active／CommittedDisabled → RollbackPrepared → Quiescing → ReadyToCommit
Active／CommittedDisabled → UninstallPrepared → Quiescing → RemovedRetainedData
任一不確定 publication／stop／save → RecoveryRequired
驗證／解析／同意拒絕 → Rejected（舊 committed graph 不變）
```

| 邊界                              | 必須成立的條件與失敗結果                                                                                                                                                                                                    |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Acquiring → Verified              | 只下載到 quarantine；串流 caps、簽章／撤銷／platform／每檔 hash 全過。尚不載入 static/UI resources，不執行 hooks。失敗可清理 candidate，原版不動。                                                                          |
| Resolved → Prepared               | solver 固定完整 closure、顯示所有 publisher／permissions delta／磁碟成本；取得同意後才準備。安裝不默認執行插件；不允許 hidden dependency execution。                                                                        |
| Quiescing                         | 持有既有 profile writer lock，交易序列化；先封新 admission／撤 owner generation，再走既有 bounded drain／stop／save／process-exit。任何 journal fault、未確認 stop、save blocker 或 child 未退出都停在 recovery，不先刪檔。 |
| Migrating → ReadyToCommit         | 只操作 shadow data generation；保留舊版資料／checkpoint。migration 成功與相容驗證形成 receipt，不能以 callback 回傳成功代替落盤。                                                                                           |
| ReadyToCommit → CommittedDisabled | sync candidate files／directories，再以平台驗證過的原語 publish graph head 並 sync；記錄 transaction ID、舊／新 head digest、資料與 consent identity。回覆遺失須 reconcile，不重發 migration 或有副作用命令。               |
| Active                            | 按需初始化，重做 runtime／API／trust 檢查，風險 marker 必須在執行或貢獻 delivery 前記錄；首次健康檢查只做協商，不執行設備命令。初始化仍會執行第三方 code，不能稱無 OS 副作用。                                              |
| Uninstall                         | 先計算 dependents，預設拒絕拆除仍必要的依賴；經明確確認才整組停用／移除。publish tombstone 後延後 GC；預設保留資料，另有 explicit purge／export。uninstall 不呼叫任意 uninstall hook。                                      |

### 5.3 Crash recovery、journal 與 safe mode

新增 package transaction journal，重用現有 profile lock、host epoch、strict parsing、hash、publication reconcile 與 lifecycle port 的設計／可抽取原語；不把 package journal 塞進設備 fault journal，也不讓第三方呼叫 host-only import descriptor。journal 包含 phase、candidate／old graph digests、被 pin 的 runtime／資料、consent 與最後完成的 durable frontier；不信 manifest 提供的絕對路徑。

啟動順序為：取得 primary profile lock → 讀取安全狀態與 journals → reconcile heads → 決定 safe mode／disabled → 註冊 contributions → 按需啟動。pre-commit crash 保留舊 head，清理／隔離孤兒 candidate；post-commit crash 依已驗證 head 恢復新 graph，或在損壞／unknown 時保留雙方證據並停用。不能依 mtime 猜新版，或因收不到 reply 重做 publication。對每個 write／sync／rename／head／ack 邊界做 kill/reopen 測試。

單 filesystem rename 的原子可見性不等於掉電 durability。POSIX file＋directory sync、Windows replacement／barrier 要有真實實作證據。R1 safety contract 不降級；B2 的 `file-sync-only` 也不可直接提升為套件 power-loss guarantee。package store 的平台能力不足時拒絕 publish，顯示未支援／recovery，不能當安裝成功。

所有 installed executable、static、UI contributions 納入 third-party risk；safe mode 在讀入／註冊前阻止它們。更新／回退不能清除 persisted disable 或 safe-mode lock；仍由使用者明確 restore。manager 目前部分風險判斷使用 `dev:`（§2），4C 必須盤點改為來源信任分類，不能漏掉 installed。package corruption 只隔離相關 graph，設備 stop uncertainty／checkpoint 仍由 core recovery 顯示，不能靠回退清除。

### 5.4 Per-plugin data migration 與回退資料規則

沿用 source namespace、settings revision／validation digest、record schemaVersion、checkpoint、CAS 與 quota；新增 data-generation snapshot／head pinning 作為 package transaction 的一部分，**不是現有功能宣稱**。正式插件沒有 raw namespace path。migration descriptor 固定 from／to schema、程式／宣告式變換 digest、輸出上限與期限；初版優先 host 驗證的宣告式設定變換，複雜 record 變換在獨立程序中透過受限 shadow-storage port 執行，不能在 main import 任意 migration module。

撤銷正常 owner 後固定輸入 revision 與 immutable snapshot；新 generation 還未成為 active，不與舊 process 同時寫。每一步可重入，receipt 綁原始 hash／schema／target generation。失敗、磁碟滿、超限或未知結果保留原資料並停止交易。snapshot／candidate 空間另預算，不能放寬既有 per-record／namespace quota；不足時要求先匯出／清理，不刪除唯一可復原資料。

回退必須同時檢查 API、依賴 graph、runtime、信任與資料可讀性。新版尚未寫入時可恢復 pin 住的舊 generation；新版已寫入時，只有舊版可讀現有 schema 或經驗證的反向 migration 才可無損回退。否則維持停用，提供匯出與明確的「還原更新前 snapshot」選項，保留新版資料副本並告知會失去哪些更新後變更；不得默默丟資料。GC 至少保留 current＋previous known-good closure 與所需 runtime／資料，引用與未解交易全部解除才清理。

## 6. Managed runtimes 與可強制的隔離

### 6.1 Python 交付策略

| 選項                                        | 取捨                                                                                                                                     |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 每個插件附 interpreter                      | 完整離線且自足；每包膨脹、安全修補與多副本稽核困難。                                                                                     |
| desktop 一律內建 Python                     | 首次離線容易；所有使用者承擔體積，Python patch release 綁 app release。                                                                  |
| host 管理共享唯讀 runtime，可下載或離線匯入 | 可按 `(implementation, fullVersion, buildId, os, arch, ABI, digest)` 去重與並存；必須實作供應來源、簽章、cache、離線 UX、GC 與修補政策。 |

**建議第三項。** 第一次需要時，在同意畫面列出固定的 runtime artifact，從受信任 channel 下載；離線 collection 包含完全相同 bytes。不能只保存 `python >=3.10` 或使用 PATH 上碰巧存在的 Python。供應者、Python minor／patch 與支持期限由 owner 在 4A 定案，須先核對三平台 redistribution、license、security maintenance 與 relocation；本提案沒有選定或宣稱已提供某個 runtime build。

每個插件版本有獨立、已鎖定的 site-packages／vendor tree，只共用唯讀 interpreter，不共用可寫環境。wheel 於受控建置階段解析為 exact hashes／platform tags；使用者端不解析 PyPI、不執行 setup／build hooks。禁止 system-site-packages／user-site／`PYTHONPATH` 注入；用固定 bootstrap、Python isolated mode／環境 allowlist、固定 import roots 與可寫 scratch，驗證 wheel 不能覆蓋宿主 SDK 或 runtime。venv 與 `-I` 是依賴／搜尋路徑隔離，不是 OS 安全邊界。

runtime 更新採並存而非覆寫，共享引用者逐一通過新 build 的驗收／lock 更新後才切換。被撤銷 runtime 不可因回退再次啟動。已運行程式的撤權／stop／drain 仍須安全收尾；GC 不刪正在使用或 previous closure 所需的 runtime。

Node 預設沿用 app 隨附的 Electron utility-process runtime，lock 記錄宿主支援範圍與 ABI；不提供任意外部 Node 選擇作正式發布依賴。native addon 必須有逐平台／Electron ABI 驗證與 OS signing 接線，初版建議不接受第三方 Node addon。Rust／Go／C++ 可走新增 `native` executable＋同一 stdio protocol；4D 必須新增 manifest／launcher／conformance／timeout／child-tree cleanup，不能說目前 `launchers.ts` 已支援。

### 6.2 OS sandbox 的實際界線

主設計接受的首次一般發布仍是 **trusted local code**。必要的 API grants、process crash isolation、env 清理、安裝路徑驗證都要交付；完整惡意程式隔離不作為假定前提。若另選「強制 sandbox」模式，缺少任何必要能力即拒絕啟動，不能靜默退成 trusted-local。一般 trusted-local 模式不保證阻止直接 fs／network／USB，也不能保證 migration 的 OS 副作用可回復。

| 平台    | 待實證方案                                                                                                         | 能力與限制                                                                                                                                                                                                                                                                       |
| ------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS   | Seatbelt 限制方案 feasibility；另評估經簽章 helper／App Sandbox entitlement 路線。                                 | 不把 `sandbox-exec` 或自訂 profile 當穩定、已支援的產品契約；要實測 Python imports／native libraries／child inheritance／MessagePort 或 stdio／file grants。Apple App Sandbox 涉及 entitlement 與資源授權，不能因 Electron renderer sandbox 就推定 utilityProcess／Python 受限。 |
| Linux   | 偵測 Landlock ABI／enabled 狀態，加上適用的 user／mount／network namespaces、no-new-privileges 與 syscall policy。 | 權利項目隨 ABI 不同；namespace 可用性取決於 kernel／發行版政策。Landlock 單獨不等於完整網路／process／device 隔離；預先開啟的 fd／socket 也須盤點。不能以 kernel 版本字串或 CI 一台機器推定所有使用者可用。                                                                      |
| Windows | AppContainer token／capabilities／ACL、受控 pipe handles，加上 Job Objects 管 process tree 與資源。                | AppContainer 才負責相應資源存取邊界；Job Object 終止／limits 不等於檔案或網路 sandbox。須驗 Python DLL loading、繼承 handles、子程序 breakaway／cleanup、已安裝 app 實際啟動。                                                                                                   |

外部依據（2026-11-11 查閱）：[Apple App Sandbox](https://developer.apple.com/documentation/security/app-sandbox)、[Linux Landlock](https://docs.kernel.org/userspace-api/landlock.html)、[Linux kernel threat model](https://www.kernel.org/doc/html/latest/process/threat-model.html)、[Microsoft AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation)、[Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)。表中是依文件提出的實作／驗證方向，不是本專案已達成保證。Seatbelt 方案的支援性仍需平台 owner 在 4D 實證與裁決。

每個發布 variant 的 capability receipt 要分列：API denied／OS denied／未限制／未測。檔案跨 namespace、直接網路／USB、環境洩漏、child escape、動態載入與 process injection 的負例必須在 native host 執行；不可把 mocked denied 回覆當 OS deny。靜態 tokenizer 仍有 renderer 同步 regex 風險，既有上限／safe mode 不是完整 ReDoS 防護；不因簽章通過就接納任意不可信規則。

## 7. 由 committed JSON Schema 產生 Python bindings

**唯一輸入是已提交的** [`plugin-protocol.schema.json`](../../../packages/plugin-protocol/schema/plugin-protocol.schema.json)，不是直接 import Zod、抓網路 schema 或另寫 Python 版本的 wire 定義。既有 [`json-schema.test.ts`](../../../packages/plugin-protocol/src/json-schema.test.ts) 比對生成值與兩份 committed schema；[`conformance.test.ts`](../../../packages/plugin-protocol/src/conformance.test.ts) 與 Python [`test_conformance.py`](../../../sdks/python/tests/test_conformance.py) 消費 [`conformance/cases.json`](../../../packages/plugin-protocol/conformance/cases.json)。4B 在這些門檻旁新增 drift／typing 測試，不取代它們。

建議 stdlib-only generator：讀 `$defs` 與 [`keywords.json`](../../../packages/plugin-protocol/schema/keywords.json)，建 deterministic intermediate representation，以 schema path／結構 digest 決定穩定命名、去除大型 inline schema 的重複型別。輸出 `TypedDict`、`Literal`、`Union`、method params/result aliases、typed async request facade 與 `py.typed`；保留現有 dict 使用方式。支援 Python 3.10 的 required／optional 組合可用 total=True／False 的 TypedDict inheritance，不為 `NotRequired` 偷增 runtime dependency。

`oneOf` 與 bounds／pattern／finite-number／cross-field 語意不能由 type hints 完整表達；產生型別外仍在 I/O 邊界走既有 validator 與 domain checks。unknown schema keyword／不能表示的必要結構讓 generator 失敗，不能退成 `Any`。有意開放的 JSON 值用明確 JSON value type；不能把 loose object 的額外欄位語意誤縮成 strict 或在 round-trip 丟失。保留 null 與 absent、bool 與 int、Unicode code points、tuple／`prefixItems`、unknown keys、numeric edge cases 的區別。

wire schema 不描述所有 local API 的 cancellation、event pump、watch／unwatch、drain lifetime 或 method introduction version；這些行為保留手寫 adapter。若需要 method-version 表，將其作受審查、覆蓋全部 `$defs` 的旁表，不能從名稱猜版本。不得把過往 `.v1`／`.v170` 定義覆蓋成最新型別。

驗收要求：

1. 同一 committed Schema 連續生成兩次 byte-identical；header 記錄 schema digest／generator version，不含 wall-clock timestamp。temp output 與 committed bindings 比對，手改生成檔失敗。
2. Zod → committed Schema → Python bundled copy → generated bindings 四段 drift 檢查；schema／keyword／method inventory 改變卻未生成時 CI 失敗。
3. 共用 cases 的正例經 generated facade 編碼後通過 TS／Python validator、解碼不丟語意；負例仍被拒絕。type checker 的 valid／invalid fixtures 驗證欄位／union，不能只驗 codegen diff。
4. 真正 MessagePort JS／stdio Python 對 host 跑相同 settings／storage／UI／devices error／cancel／stale／drain cases；舊 dict callers 與 API 1.4–1.8 negotiation 保持既有語意。wheel 安裝後在沒有 repo 的環境 import types／schema／SDK。

## 8. 相依解析、API 版本與回退

分開四個版本軸：package format、插件 release、Plugin API、runtime／ABI；另保留 UI resource 與資料 schema version。不能因插件版本 `1.8.0` 就推定支援 Plugin API 1.8。

建議新正式插件以 `^1.8.0` 為 API baseline；實際使用未來 API 時提高最低 minor。host 的完整 API 版本必須符合 manifest range，初始化的 SDK 版本與每個 feature negotiation 也要成立；major 相同不代表所需新 method 可用。不強迫把仍相容的舊 builtin／開發 manifest 改成 `^1.8.0`，例如 motor 的 `^1.6.0` 保留相容驗收。

初版 range grammar 沿用 exact／caret／tilde，明確不接受 `*`、URL、git ref、OR 或任意 comparator expression；這是有意限制的 semver range 支援，若要擴充須同步 schema／validators／solver tests。prerelease 僅從使用者 opt-in 的 preview channel、明確規則取得，不讓 stable 自動選 preview。

resolver 只從受信任、已驗證的 local／channel index 建 candidate set，以 ID＋publisher 綁定防 dependency confusion。每個 profile 一個 active version；先滿足使用者 pin 與現有 compatible lock，再依明確版本排序選候選，產出 deterministic closure、reasons 與 conflict chain。拒絕 cycles、超深／超量圖與無交集 constraints；optional dependency 缺少可回報功能不可用，但不得擅自安裝或啟用。解出版本之後仍檢查 platform／ABI／capabilities／grants／revocation／storage compatibility。

**一個 language／target 一個 provider** 的規則在 plan 階段就檢查，commit 前再驗；衝突顯示所有來源並拒絕 graph，不能「最後載入勝出」、自動停用 builtin 或讓 dependency 順序決定。此規則不解除 registry 的 builtin-only 限制；未來 external compiler contract 開放後仍必須遵守。靜態語言衝突沿用其 catalog 規則，不能誤當 compiler provider 已開放。

回退選擇完整、先前成功且仍可信的 closure，重驗 host API／runtime／grants／provider 衝突／資料 schema；依賴不能各自隨機退版。若原 previous closure 會破壞另一個使用中插件，先提出整組變更或維持停用。首次初始化失敗可恢復 pre-update head 並保持問題插件停用，不自動重播 commands、連線、錄製、Run 或 motor。使用者點選較舊版本是明確 rollback intent；channel 的舊 metadata／較低 sequence 是攻擊，不可同一方式放行。撤銷版本不得成為 known-good fallback。

## 9. 信任、同意與供應鏈

簽章證明內容由受信任 key 簽出，不證明 code 安全。初版建議明確本機 trust store：Kobrixa 隨 app 提供的受信任根／publisher 綁定，或使用者經帶外核對 fingerprint 匯入的 publisher key。`publisherId`、允許的 plugin namespace、key roles／有效期／rotation chain 均持久記錄；僅憑包內姓名、公鑰或下載站 HTTPS 不自動信任。publisher 轉移要由舊／新 key 與 owner 核准流程確認，不能繼承資料／permissions 給同名陌生包。

consent UI 由 core 提供，展示 publisher 與 verification 狀態、plugin／dependency versions、執行模式、runtime 下載大小、API permissions、required device capabilities、資料 migration／rollback 後果與 channel。以白話說明 trusted-local 程式可以直接存取 OS；API grants 只能限制經 Kobrixa 的路徑。靜態包也顯示 renderer resource 風險。新增 permission／capability、publisher／channel／execution-policy 改變均需新同意；不因自動更新沿用更多權限。保存 consent digest，初始化傳遞實際授予集合，declared ≠ granted。

首次正式版本建議預設只檢查／下載更新，使用者確認後在可 quiesce 時切換；不得在 motion／recording／save 中強行換版。更新 metadata 採可審查的角色分工：offline root 管 key／namespace，release key 簽 artifact targets，短期 freshness metadata 綁序號／期限／target hashes；具備 root rotation、rollback／freeze／mix-and-match 防護。選用成熟規格／實作或自訂最小格式需在 4A 決策與 review，不把 TLS／SHA-256 當完整 update security。

撤銷以已簽 metadata 分 key／package digest／runtime build 表達，保存最高可信序號與最後更新時間。已知撤銷拒絕新安裝／啟動，現行 process 先撤 API admission、stop／drain／terminate 並保留 recovery；不直接刪資料或謊報設備停止。離線不可能知道最新撤銷：建議允許未命中已知撤銷且簽章／metadata 仍有效的完整離線集合；metadata 過期則拒絕新安裝／更新、保留已安裝 trusted-local 版及清楚的 freshness 狀態，known-revoked 仍停用。時鐘倒退要用已保存的最高可信時間／序號偵測；離線存續政策是 owner decision，不是假裝有即時撤銷。

| 威脅                                       | 必要緩解／殘餘風險                                                                                                               |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| publisher key／CI 被入侵                   | signing key 與 build 分離、最小權限、受審查 release、rotation／revocation、保留 provenance。合法簽出的惡意 code 仍需信任與偵測。 |
| dependency confusion／typosquat／hook      | lock＋publisher namespace＋exact artifact hashes、離線 vendor、不在使用者機器執行安裝 hooks；SBOM／license 與漏洞審查。          |
| ZIP slip／bomb／link／TOCTOU               | §4 串流上限與 path identity；staging 私有、啟動前驗 hash、平台安全檔案原語。未沙箱的同使用者惡意程式仍可能篡改 profile。         |
| update replay／freeze／mirror substitution | signed target hashes、版本序號／expiry、root rotation、持久保存可信上限、回退需 explicit intent。                                |
| runtime／native dependency 被替換          | runtime digest pin、供應者驗證、三平台 binary／ABI／signing 測試；不借 PATH 或使用者 site-packages。                             |
| permission laundering／source spoof        | host 綁 channel 身分、publisher／plugin／source 穩定鍵、實際 grants 與新增同意；第三方不得註冊 builtin provider。                |
| migration／rollback 資料破壞               | shadow generation、immutable originals、CAS／receipts、顯式資料回退選擇、core export／recovery。                                 |
| renderer regex／資源耗盡／direct USB       | 延用所有現有 caps／supervisor／safe mode；OS 限制有實測才聲稱有效。停止程序不等於實體停止。                                      |

app signing、publisher signing 與更新根三者分別記錄。macOS notarization／Windows signing 是否適用某個 runtime／native artifact 要由 release 工具驗證；不得把主程式已簽章當動態下載 payload 皆獲 OS 信任。

## 10. 開發者工作流程與 CLI 邊界

以下命令為**介面草案，尚不存在**：

```text
kobrixa plugin validate <source-or-package> --target <os-arch> --offline
kobrixa plugin pack <source> --lock <lockfile> --target <os-arch> --out <file>
kobrixa plugin sign <package> --key-ref <secure-key-reference>
kobrixa plugin inspect <package>
```

`validate` 不執行 entry／install scripts，輸出結構／API／platform／lock／integrity／signature／trust 分項結果；「valid structure」不能印成「trusted」。`pack` 只收已建置輸入與受鎖定 vendor 結果，產出 deterministic archive／SBOM／notices。`sign` 不接 CLI 明文私鑰，使用受控 key reference；簽後再 validate。針對需要 compile／native wheel 的插件，在建置環境做明確步驟，不藏在使用者安裝時執行。

建議將 parser／validator／resolver／transaction model 放 Electron-free library，desktop 與 CLI 共用；對話框、key store、OS launcher、下載與 profile ownership 是 adapters。既有 [`compiler/contracts.ts`](../../../packages/compiler/src/contracts.ts) 與 [`device/contracts.ts`](../../../packages/device/src/contracts.ts) 保持向內依賴；roadmap 的 headless compile／device CLI 可共用這些 packages，但不是本打包 CLI 必須同時交付的所有命令。CLI 不 import `apps/desktop/src/**`，不繞 broker safety／profile lock，亦不在 desktop 持有 profile 時另起 writer。

延續 hello-ts／hello-python 開發目錄體驗，新增 pack→sign→offline install 的正式範例；正式 manifest 不因開發時使用本機 Python 而漏帶 runtime lock。公開契約核准實作時再同步英／繁中 architecture、authoring docs、roadmap；本次只新增提案及綱要。

## 11. 驗收與提議子階段

所有階段先 spec／contract review，再 implementation／tests／evidence。大小為相對工作量：S＝單一契約或工具模組，M＝數個模組，L＝跨程序／跨平台整合，XL＝含持久化或發布 gate 的多輪驗收；不是工期承諾。

| 子階段                            | 目標／exit                                                                                                                                      | 依賴                                              | 粗估 | 可平行範圍                                                                                              |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------- |
| 4A：格式與信任契約                | entry gate、owner decisions、schemas／canonical vectors／caps／platform matrix／trust bootstrap／migration model 凍結；validator 可拒絕惡意包。 | Stage 3 完成並合併；本提案核准。                  | L    | 只在進場後分 schema／archive vectors／platform feasibility，protocol hotspot 單一 writer。              |
| 4B：Python codegen                | committed Schema → bindings／wheel；drift、conformance、typing 與舊 caller 相容。                                                               | 4A 版本與 generator contract。                    | M    | 可與 4C／4D 實作平行；schema 修改集中交接。                                                             |
| 4C：交易與復原                    | 安裝 graph／stable identity／permissions／storage generation／rollback／uninstall／safe mode；fault matrix 與 platform durability 通過。        | 4A；Stage 3 persistence／R1／R2 結案。            | XL   | 核心純 model 測試與 4D runtime store 可分檔；controller／source schemas／persistence hotspot 依序整合。 |
| 4D：runtime 與 launch             | shared Python＋離線包、依賴隔離、native stdio admission、OS containment feasibility／honest policy、三平台 cleanup。                            | 4A；與 4C 對齊 identity／pins；Python 整合依 4B。 | L    | OS-specific adapters 可分平台；launcher 公共介面一位 owner。                                            |
| 4E：solver／consent／CLI／channel | deterministic closure、pack/sign/validate、權限差異 UI、更新／撤銷與安全發布來源，接上 4C／4D。                                                 | 4A 可先寫 solver／CLI 純邏輯；整合需 4B–4D。      | L    | solver／CLI、consent UI、channel tests 各有固定 write set；不平行改同一 registry／controller。          |
| 4F：候選版與一般發布 gate         | 三平台 source-free 離線安裝／更新／回退／uninstall、硬體／人工、雙語 docs、供應鏈與撤銷演練；owner 簽核後才開放一般第三方。                     | 4B–4E 全過、固定同一 candidate／artifact。        | XL   | 三平台與人工程序可分跑；性能實驗獨占 host；最終 evidence join 單一 owner。                              |

### 11.1 Automated

- 純 unit／property／fuzz：archive path collision／ZIP bomb／signature tamper／unknown algorithm／size +1、semver graph／cycles／conflicts、consent delta、revoke／expiry、migration compatible／incompatible、state-machine 每一 durable frontier 與 lost ack。
- 真實 filesystem／worker／process：primary writer、CAS、disk-full／read-only、rename／sync failures、crash/reopen、sealed payload／quota、source identity 更新前後一致、uninstall／GC 引用、safe mode 在 static／UI delivery 前生效。
- SDK：§7 四段 drift、cases、雙 transport 與版本降級負例；permissions 與 capability negotiation 不得由簽章繞過。
- 保留全部 Stage 3 assertions／budgets／thresholds；package／runtime 額外成本另行事前定義數值並量測，不能因新版本較慢就調門檻。缺資料、partial、skipped、NOT RUN 均獨立列出。

### 11.2 Cross-platform installed

以目前 release 工具檢查的 macOS arm64、Windows x64、Linux x64 為提議首批 matrix（§2 的 `archive.mjs`），最終支持 OS／ABI 在 4A 簽定。每平台使用已 hash 的真正 installer／archive，乾淨帳號無 repo／user Node／Python，網路禁用，測試完整 offline closure、缺 runtime、錯架構、tamper、升版／退版、原資料復原、撤銷／過期 metadata、second instance、disable/all-off／safe mode、無 orphan。接受來源不得偷偷讀 checkout；acceptance host 的 leaf 成功不等於 whole-product 成功。

OS signing／launcher／durability／containment receipt 要跟最終 artifact 相符；原生 probe 失敗不跳過。性能採既有 workload／重複／distribution／GC／sampling 規則，R2 以正式裁決為準。三平台必要列均完成才可聲稱三平台發布準備完成。

### 11.3 Hardware 與 manual

在 Stage 3 已驗收基線上，用正式安裝的 JS／Python consumer 回歸 USB／Wi-Fi：motion 中更新／撤銷／disable／crash、Lab 錄製中 close／update／uninstall、authority transfer、disconnect／suspend／reconnect；沒有自動 replay，實際觀察 stop 與最大錄製資料。native fake provider 可以準備案例，不能簽硬體結果。

人工驗 consent 是否理解 publisher／trusted-local／新增權限，離線 runtime 缺失、被撤銷／失效簽章、migration／資料回退／purge 的說明，雙語／明暗／320 px／125%／keyboard／IME／screen reader，以及乾淨機器 recovery。每筆記錄 tester／日期、source／artifact hashes、OS／arch／runtime、firmware／transport、case、觀察與限制。H1–H6 的歷史紀錄不直接冒充 Stage 4 新成品驗收。

### 11.4 本次未執行的 native handoff

本次只規劃，未啟動 Electron、未聆聽 localhost、未執行硬體或 installed 驗收。Stage 3 orchestrator 仍須在最終候選原生環境依 [`stage-3-closeout-run.mjs`](../../../tests/desktop/stage-3-closeout-run.mjs) 的實際 inputs 執行下列既有命令；它們是**待執行**，不是 Stage 4 新測試，也不是完整 S3 ledger 的替代品：

```sh
node tests/desktop/stage-3-closeout-run.mjs motor --run
node tests/desktop/stage-3-closeout-run.mjs lab --run
node tests/desktop/stage-3-closeout-run.mjs device --run
node tests/desktop/stage-3-closeout-run.mjs installed --run
node tests/desktop/stage-3-closeout-run.mjs b2 --run
node tests/desktop/run-smoke.mjs
node tests/desktop/declarative-ui-motion-run.mjs --load
```

先由 orchestrator 建好同一 source 的 core／desktop／installed candidate。Lab／device 需 Python；B2 需真實且完整的 `PERSISTENCE_EVIDENCE`、`KOBRIXA_SINGLE_INSTANCE_REPORT`，其他 producers／handoffs 依 audit 執行；缺檔不可造 placeholder。Linux GUI 需適用的 Xvfb session、installed isolation 需實際 namespace／Landlock；Windows 需先解決 native runner／journal gate。H1–H6 依 audit 的硬體／人工程序另外執行。Stage 4 CLI 與測試命令須等子規格／實作產生，本文不假造已存在的 runner。

## 12. 開工前 owner decisions

下列均**尚未核准**。owner 指主維護者／指定的 security、runtime、persistence、release 責任人；4A 開始前要有姓名與決議紀錄，不能把建議當預設批准。

1. **範圍與 entry（主維護者）：** 提前混入 Stage 3／完成且合併後再實作。建議後者；保留所有 S3、R1／R2、H1–H6 gate，provider／HTML／WASM／marketplace 另案。
2. **格式（protocol／release）：** ZIP／tar／ecosystem／OCI。建議受限 ZIP＋strict metadata／integrity signature，一 variant 一包，offline collection 用相同子包。
3. **身分與簽章（security）：** 僅 hash／自帶 key 自信任／publisher-bound trust store。建議第三者＋Ed25519／SHA-256，保留 key rotation／revocation；定義首次可信 fingerprint 配送及 namespace 分配責任。
4. **上限（runtime／release）：** §4.3 初案／先以已知最大合法樣本制定更嚴格上限。建議將初案拿代表性包驗證後事前凍結；不變動任何既有 protocol／UI／storage budgets，超限包不得靠解壓後檢查放行。
5. **Python 供應（runtime／release）：** 每插件 bundled／app bundled／共享可下載＋離線匯入。建議第三者；須選定供應者、完整版本／ABI、license 與安全修補期限才做正式 build。
6. **隔離承諾（security／平台 owner）：** trusted-local＋如實顯示／三平台強制 OS sandbox。建議首次發布採前者並做 §6 feasibility；若選後者則必須新增 blocking native proof，不能靜默降級。不接受不可信 code 安全宣稱。
7. **原生範圍（protocol／runtime）：** 首批只 static／Node／Python／再含 native stdio executable。建議納入獨立 4D native admission，但不含新 provider 或第三方 Node addon；若不納入，主設計 Rust／Go／C++ 路線要明記後續里程碑。
8. **資料回退（persistence）：** 強制可逆 migrations／shadow snapshots＋相容檢查／直接覆寫。建議第二者；新版寫入後不相容時要求 explicit snapshot restore 並保存新資料，禁止默默遺失。
9. **dependency policy（runtime）：** 每 profile 單版／每依賴私有多版；完整 semver grammar／現有 exact-caret-tilde 子集。建議單版＋子集＋deterministic closure、cycle 拒絕，provider conflict 不自動選邊。
10. **更新與離線撤銷（security／release）：** 自動 activate／下載後同意；metadata 過期全部停用／拒絕新安裝更新但保留既有可信版。建議各採後者，known-revoked 仍停用；明定 freshness 期限與成熟 update metadata 實作選型，接受離線未知撤銷的限制。
11. **durability／cache（persistence／平台 owner）：** 平台一致可驗證 durable commit／明示較弱契約。建議前者、能力不足拒絕 publish；至少 current＋previous closure，GC 與 snapshot 配額一起定案，不拿 R1 或 B2 策略互換。
12. **開發 CLI／發布門檻（主維護者／release）：** pack 工具綁 desktop 私有碼／共用 Electron-free library；逐平台先開放／三平台完成後開放。建議共用 library 且三平台及硬體／人工完成後一般發布；headless compile/device CLI 仍沿 roadmap 另排。指定 artifact freeze、簽核人與撤銷演練責任。

## 13. 主要風險

| 風險                                                         | 控制與仍需決定之處                                                                                           |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Stage 3 還沒閉合就累積新交易／身分語意                       | entry gate 與合併 commit 明確；不轉移未完成驗收成 Stage 4 正常前提。                                         |
| source identity 改變導致 grants／disabled／namespace 串用    | 穩定 installed identity 與全邊界 migration；舊 dev import 明確選擇，禁止 ID collision 自動接管。             |
| graph／資料／runtime 多個 head 部分更新                      | 單 commit head、shadow generations、journal frontier、跨平台 kill／reopen；這是 4C 最大設計成本。            |
| Windows durability、macOS runtime signing、Linux policy 差異 | 各平台真實 artifact proof；沒有 adapter／能力即阻塞，不用 unit mock 或平台 skip 關門檻。                     |
| 大型 schema 造成 Python 生成碼膨脹或語意失真                 | deterministic dedup、typing＋runtime validator＋共享 cases、版本化 naming map；不以 `Any` 消除錯誤。         |
| Python native wheels／runtime 散佈授權與 patch 滯後          | exact provenance／SBOM／license、按 ABI variants、撤銷與修補 owner；需要實際供應者選型。                     |
| rollback 與 security downgrade／資料損失混淆                 | 明確 rollback intent、revocation 優先、完整 closure、資料相容 gate 與保存新資料。                            |
| signed code 被誤認為受 sandbox 保護                          | consent 分開 publisher verification／API grants／OS containment；未沙箱直接 I/O 與非可逆副作用仍存在。       |
| concurrent work 與證據不同版本混用                           | 各子階段固定 write sets／hotspot handoff，4F freeze 成品；source／dirty diff／artifact／raw results 全對應。 |
| 包裝工作膨脹成全面插件化                                     | §1 非目標與 Stage 3 §8 ledger 保留；新增 provider／HTML／marketplace／WASM 須獨立 spec。                     |

**本文沒有交付 Stage 4 功能，也沒有核銷任何 Stage 3 或 Stage 4 驗收列。**

#### Closeout work-package references

These IDs name work scopes, not passing acceptance results.

- **W21**: reconcile documentation and final evidence ledger.
