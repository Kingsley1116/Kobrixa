# Kobrixa 插件系統 4A：套件格式與信任契約子規格草案

日期：2026-11-12  
狀態：**PROPOSAL／待 owner 審查／未核准／未實作／未交付**。本文只有規劃；表中的「必須／拒絕」描述提議契約，不表示產品已有此行為，也不是驗收結果。

上層文件：[Stage 4 打包提案](2026-11-11-plugin-system-stage-4-packaging-proposal.md) §4、§8、§9、§11；結構參照 [3A 子規格](2026-10-17-plugin-system-3a-device-broker-design.md)。本文的 **O1–O12** 僅為[上層提案 §12 owner decisions](2026-11-11-plugin-system-stage-4-packaging-proposal.md#12-開工前-owner-decisions) 第 1–12 項的引用縮寫，不是另一組已核准決議。每節的 P 編號指定該節全部欄位、literal、上限、排序、錯誤及測試期望所依賴的 owner 決策；全部仍是提議，包含從上層初案沿用的數字。

## 1. 範圍、進場條件與已讀基線

**提議 P01（O1、O12）：** 4A 定義單一 `.kobrixa-plugin` 的可攜容器、metadata／lock／integrity／signature、驗證次序、平台選擇及 trust store。凍結 schema、vectors 與負例後，才依另行核准的實作計畫建立 Electron-free validator。本文不新增 schema 原始碼、CLI、安裝器、runtime 或公開 API。

Stage 3 全部必要驗收完成且合併至 `feat/plugin-system`、上層提案與 owner decisions 具名核准，仍是 Stage 4 **實作** entry gate。本文不認定 gate 已通過；Stage 3 的 R1、R2、H1–H6、原有 budgets／thresholds 不變。4A 的 `VerifiedCandidate` 不等於 installed／trusted to execute／Active；4C 負責交易、資料 generation 與 durability，4D 負責 runtime／native admission，4E 負責 solver／consent／channel，4F 負責發布證據。

### 1.1 已讀程式事實（不是新決策）

讀取時分支為 `feat/plugin-system-stage-3`、HEAD `15ba149`；共享工作樹可由其他工作者繼續變動。以下是檔案觀察，不是對最新推送或乾淨 commit 的認證。

| 來源                                                                                                                               | 已有行為／本草案不能假定的能力                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`manifest.ts`](../../../packages/plugin-protocol/src/manifest.ts)、[`common.ts`](../../../packages/plugin-protocol/src/common.ts) | manifest 外層及部分巢狀物件為 loose；runtime 為 `static`／`builtin`／`node`／`python`，沒有 `native`。entry 是受限 ASCII relative path、最多 512 字元。`apiVersion` 只接受 exact／caret／tilde 三段版本。新增 strict 包裝契約不能默默改舊 manifest 相容性。                                                               |
| [`limits.ts`](../../../packages/plugin-protocol/src/limits.ts)                                                                     | `PLUGIN_API_VERSION = "1.8.0"`、manifest 64 KiB、ID 128、commands／activationEvents 各 64。這些既有界線不因 ZIP 上限而放大。                                                                                                                                                                                              |
| [`json-schema.ts`](../../../packages/plugin-protocol/src/json-schema.ts)                                                           | 由 Zod 匯出 draft-2020-12、input 語意；unrepresentable／cycles 為 throw，reused inline。沒有本規格的包裝或 trust definitions；不能聲稱 committed Schema 已支援它們。                                                                                                                                                      |
| [`registry.ts`](../../../packages/plugin-runtime/src/registry.ts)                                                                  | source 只有 builtin／development；`dev:` 是 resolved directory 的 SHA-256 前 16 hex。`semver.satisfies`、entry realpath containment、safe-mode gate 已存在；device provider／compiler frontend/backend／language service 的 external 宣告仍拒絕。現行保留 ID 集合只列 `kobrixa.core`，本文整個 `kobrixa.*` 保留是新提議。 |
| [`builtin-launch.ts`](../../../apps/desktop/src/main/plugins/builtin-launch.ts)                                                    | builtin index 有排序、exact file set、bytes／SHA-256、regular-file／identity 檢查；其檔數／大小為 builtin 專用。pathname snapshots 明說不是可抵抗持續 rename 的 directory capability。不得把它直接描述為第三方安全 extractor 或 publisher signature verifier。                                                            |
| [`archive.mjs`](../../../tools/release/archive.mjs)                                                                                | desktop 發布 archive 使用 ditto／tar、tree round-trip 與 OS signing；tree 可保留合法相對 symlink。binary 檢查為 macOS arm64、Windows x64、Linux x64。這不是插件 ZIP profile，不能直接沿用其解壓／link policy，也未提供插件 trust store。                                                                                  |
| [architecture](../../en/architecture.md) 插件段落                                                                                  | trusted local code 的 API permissions／獨立 process 不是 OS sandbox；第三方 provider 開放與一般發布尚有自己的 gate。                                                                                                                                                                                                      |

### 1.2 提議決策索引

| 編號（全部提議） | 本文範圍與理由                                                                                      | 上層 owner 決策 |
| ---------------- | --------------------------------------------------------------------------------------------------- | --------------- |
| P01              | 只定契約；不藉規格完成、hash 正確或 CI 片段宣稱交付。                                               | O1、O12         |
| P02              | ZIP32 單 disk、單 variant、regular files、ASCII paths、固定 headers／entry order；縮小三平台差異。  | O2、O4          |
| P03              | 新包裝 object 全 strict；既有 manifest 語意另驗；沒有隱含 defaults。                                | O2、O4、O7      |
| P04              | integer-only canonical JSON、SHA-256、domain-separated pure Ed25519；bind publisher／key／format。  | O2、O3          |
| P05              | 實際串流計數、先驗簽再接收內容、驗完整 central directory 才產生候選。                               | O2、O3、O4、O11 |
| P06              | exact OS／arch／ABI，portable 明示；首批平台不由模擬執行補足。                                      | O5、O6、O7、O12 |
| P07              | publisher-bound 單版 dependency closure，root 不 hash 自己以免循環；optional omission 明示。        | O5、O9          |
| P08              | 本機 bootstrap、root／release／freshness roles、rotation／revocation／anti-rollback；不信包內 key。 | O3、O10、O11    |
| P09              | storage compatibility／migration 只作 signed declarations，執行與復原交 4C；不能覆蓋現有 quota。    | O8、O11         |
| P10              | 負例、跨語言 vectors、native platform receipts 分列；未執行維持 NOT RUN。                           | O1、O4、O12     |

## 2. 容器 profile 與資源界線

**本節全部為提議 P02、P05（O2、O3、O4、O11）。** `.kobrixa-plugin` 副檔名只供選檔；可信身分來自內容與 trust policy，檔名不得選擇 publisher、version 或解壓位置。以下指定的是自己的受限 profile；ZIP 欄位定義參照 [PKWARE APPNOTE 6.3.10](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT)，不接受一般 ZIP 工具自動兼容的擴充。

### 2.1 容器 bytes 與 header

| 項目             | 提議的唯一允許值／驗證                                                                                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Layout           | 從 offset 0 起為相鄰 local file records，接相鄰 central directory records，最後恰一個 22-byte EOCD；無 prefix、gap、padding、trailer、self-extracting stub 或 concatenated archive。                                       |
| ZIP dialect      | ZIP32、single disk；拒絕 ZIP64 records／sentinels、spanned archives、digital-signature record、archive extra data record。所有 offset 加法用不溢位整數且落在已收 bytes 內。                                                |
| Methods          | `0`（stored）或 `8`（raw DEFLATE，無 zlib／gzip wrapper）。六個控制檔（§2.2 前六筆）只用 method 0；其餘可用 0 或 8。method 0 的 compressedBytes 必須等於 expandedBytes。                                                   |
| Flags／versions  | general-purpose flags 恰 `0x0800`（UTF-8）；其餘 bit 均 0，包括 encryption、descriptor、compression option。local／central version-needed 恰 20；central version-made-by 恰 `0x0314`（Unix、2.0）。                        |
| CRC／sizes       | CRC-32 與兩個 32-bit sizes 必須在 local header 已知；central 逐項一致。CRC 使用 ZIP CRC-32：reflected polynomial `0xedb88320`、initial／final xor `0xffffffff`。不接受 data descriptor。CRC 只偵測傳輸錯誤，不作信任依據。 |
| Time             | DOS time `0x0000`、DOS date `0x0021`（固定 1980-01-01）；兩 header 一致。release 建置時間只在 signed metadata，不用 mtime 判斷新舊。                                                                                       |
| Extras／comments | 每筆 local／central extra length、central comment length、EOCD comment length 均 0；沒有 Unicode path extra、NTFS extra、UID/GID、extended timestamp。                                                                     |
| Attributes       | central internal attributes 0、disk start 0；external attributes 僅 `(0o100644 << 16)` 或 `(0o100755 << 16)`，低 16 bits 0。前者對應 integrity mode 420，後者 493；其他 bit／type 一律拒絕。                               |
| Directory        | 不允許 directory entries、尾端 `/`、空名稱；parents 由 extractor 自建。所有 entry 均是 regular file，無 symlink／hardlink／FIFO／socket／device／reparse point／setuid／setgid／sticky。                                   |
| EOCD             | 兩個 disk number 0，兩個 entry count 相等且等於實際筆數；directory offset／size 完全等於實際區間，EOF 必須緊接 EOCD。不得透過向後掃描接受另一個較晚 EOCD 掩蓋前方 archive。                                                |

packer 固定排序、time、mode 與壓縮器版本／設定。method 8 可有多種合法壓縮 bytes；validator 不重壓來認定 canonical ZIP。相同建置輸入的 reproducibility 應比較 pinned packer 的 ZIP bytes；相同解壓內容只保證相同 integrity，不保證不同壓縮器產出相同 artifact digest。

### 2.2 必要 entries 與 ordering

local records **及** central records 必須使用下列同一順序，不能依 metadata 任意挑下一檔：

1. `integrity.json`
2. `signatures/publisher.json`
3. `package-metadata.json`
4. `kobrixa-plugin.json`
5. `dependency-lock.json`
6. `sbom.json`
7. 其餘 entries，以完整 path 的 unsigned ASCII bytes 升序；只可位於 `licenses/`、`payload/`、`resources/`，且 `licenses/` 至少一檔。

`integrity.files` 自己則按**全部被覆蓋 path** 升序，不按上述 archive 控制檔順序。它恰好覆蓋所有 entries 除 `integrity.json` 與 `signatures/publisher.json`；沒有自行 hash、自行簽章、未列名內容、第二簽章或可選控制檔。兩個排除檔仍受 header、caps、canonical、schema、簽章及外部整包 digest 檢查。

禁止其他 root entries（包含 `__MACOSX`、`.DS_Store`、`package.json`、install scripts 作為 root 控制檔）、第二層套件容器及 nested `.zip`／`.tar`／`.tgz`／`.gz`／`.whl`／`.kobrixa-plugin`／`.kobrixa-runtime` 檔名。副檔名比對忽略 ASCII 大小寫。嵌入普通資源的任意 bytes 不遞迴辨識或自動解壓；改名的 archive 不構成可執行 installer。合法 vendor tree 須已展平，`payload/` 可含一般套件檔案，但 host 絕不執行 npm／pip／postinstall hooks。

### 2.3 路徑與 collision

`PackagePath` 提議為 1..240 UTF-8 bytes、以 `/` 分段、最多 16 段；每段 1..64 bytes，符合 `^[A-Za-z0-9_-][A-Za-z0-9._-]*$`。另拒絕：

- 尾端 dot／space、`.`／`..`、空段；任何 `\\`、NUL、control、`:`、`%`、absolute／drive／UNC／device namespace。不 URL-decode、不 percent-decode、不正規化後放行。
- 非 ASCII 名稱，包括 NFC／NFD、全形斜線及 Unicode confusables。UTF-8 解碼失敗先報 encoding；合法 UTF-8 但非 ASCII 報 path。這是縮限提議，不聲稱所有 Unicode 都不安全。
- 任一段第一個 `.` 前的 ASCII uppercase basename 為 `CON`、`PRN`、`AUX`、`NUL`、`COM1`..`COM9`、`LPT1`..`LPT9`。因此 `con.txt` 也拒絕。
- 同 bytes 重複 entry；另建立每個**完整 prefix** 的 ASCII lowercase → 原拼字表。`payload/A/x` 與 `payload/a/y` 即使 leaf 不同也拒絕。一個 path 同時為 file 與另一檔的 parent 也拒絕。不依平台 case-sensitivity 選擇結果。

manifest／resources 的每個檔案 reference 同時符合自己的既有 schema 與 PackagePath，並精確指向 integrity 中同一大小寫的檔案；不能以 case-insensitive lookup、另一 variant 或 checkout 補足。所有 paths 都是容器內相對名稱，不能變成 host 指定的 trust-store／profile 路徑。

### 2.4 上限（提議，全部含等號）

`KiB = 1024 bytes`、`MiB = 1,048,576 bytes`；所有 bytes 計原始 octets，不用 JS 字串長度。

| 對象                 | 提議上限／計數方式                                                                                                                                                                                                                           | 依賴          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| 完整輸入 ZIP         | 128 MiB，含 headers／directory／EOCD；超過即停止讀取。                                                                                                                                                                                       | P02／O4       |
| 全部 expanded bytes  | 512 MiB，含六個控制檔與零長檔。                                                                                                                                                                                                              | P02／O4       |
| Files／單檔          | 20,000（含六控制檔）／64 MiB；各 metadata 更小上限優先。                                                                                                                                                                                     | P02／O4       |
| Ratio                | 每檔及所有 entries 的 `expandedBytes <= 100 * compressedDataBytes`；分母不含 headers。空檔 0/0 視為 1，非空/0 拒絕；以實際消耗／輸出及宣告數字分別驗。                                                                                       | P02／O4       |
| manifest             | 64 KiB（既有上限，不變）。                                                                                                                                                                                                                   | 現況＋P03／O4 |
| metadata／lock／SBOM | 各 1 MiB。                                                                                                                                                                                                                                   | P03／O4       |
| integrity／signature | 16 MiB／16 KiB。                                                                                                                                                                                                                             | P03／O4       |
| JSON parser          | 各檔最大 nesting 32（root container 深度 1）、每 object 最多 64 keys、任意字串最多 4096 UTF-8 bytes；欄位更小 bound 優先。manifest 沿用既有欄位上限，parser 的外層安全上限為正式包新增限制。                                                 | P03／O4       |
| 單次驗證             | 一次一個 inflater；輸入／輸出 chunk 各最多 64 KiB；metadata 保留受各檔 cap 限制，不能把 payload 累積到 RAM。單次 wall-clock 120 秒，monotonic，取消即停；隔離 worker 須可真正終止。這是新 installer 工作預算，須在代表性最大樣本驗證後核准。 | P05／O4       |
| Closure              | root 加 nodes 最多 128 plugins、最長 edge chain 16；單 profile 單 `(publisherId, pluginId)` version。                                                                                                                                        | P07／O4、O9   |

runtime 包不套用插件 cap；`.kobrixa-runtime` 仍待 O5／4D 的獨立格式與供應核准。4A 不以插件 metadata 自稱 runtime 來放大上限。8 GiB cache 初案與 snapshot 空間歸 O11／4C，不是本 validator 可用的 RAM 或可刪資料額度。

## 3. 共通型別、JSON 與未知欄位

**本節全部為提議 P03、P04（O2、O3、O4、O7）。** 除明列 optional 外，每個欄位 required；沒有 default／coercion。`null` 只在明列 union 中合法，absent 不等於 null。下文所有新 object（含巢狀 object、union branch、trust records）均 `additionalProperties: false`；未知欄位即 `PKG_E_UNKNOWN_FIELD`，未知 format／kind／algorithm 不作 fallback。錯誤代碼是新提議，不是已存在的 `PluginErrorCode`。

| Alias                    | 精確提議型別與 bounds                                                                                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `U53`                    | JSON number，但 token 僅 `0` 或 `[1-9][0-9]*`；值 0..9007199254740991。拒絕負數、`-0`、fraction、exponent、leading zero、NaN／Infinity。布林不是整數。                                                                         |
| `Positive`               | U53，1..9007199254740991；欄位另有較小上限時取交集。                                                                                                                                                                           |
| `Hash`／`KeyId`          | `^[0-9a-f]{64}$`，SHA-256 小寫 hex；KeyId = SHA-256(raw 32-byte Ed25519 public key)，不 hash PEM、DER 或 hex 文字。                                                                                                            |
| `Id`                     | 3..128 ASCII，`^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$`；與現有 namespaced ID 對齊。                                                                                                                         |
| `Token`                  | 1..128 ASCII，`^[a-z0-9][a-z0-9._-]*$`；不可代替 path 或 URL。                                                                                                                                                                 |
| `Version`                | 1..64 ASCII；三段 nonnegative decimal、各段 ≤2147483647、無前導零；可加 `-` prerelease（dot 分隔非空 `[0-9A-Za-z-]+` identifiers，純數字無前導零）。本 profile 禁止 build metadata `+...`，避免不同 artifact 共用 precedence。 |
| `StableVersion`／`Range` | StableVersion 為上述無 prerelease 的三段；Range 為 StableVersion 或其前方一個 `^`／`~`，總長 ≤64。無空白、OR、comparators、wildcards、URL、git ref。                                                                           |
| `OsVersion`              | 3 個 decimal 整數的字串 `major.minor.patch`，各 0..65535、無前導零；按三元整數比較，非字典序。                                                                                                                                 |
| `Time`                   | U53，Unix seconds（不是 milliseconds）；0..253402300799，UTC，不接受日期字串／leap-second 特例。                                                                                                                               |
| `Text`                   | 1..4096 UTF-8 bytes 的 Unicode scalar string；無 unpaired surrogate，欄位可另縮限。沒有自動 NFC／NFD normalization。                                                                                                           |
| `PackageRef`             | strict `{publisherId: Id, pluginId: Id}`；tuple 先 publisherId 再 pluginId 以 ASCII bytes 排序，禁止重複。                                                                                                                     |
| `Artifact`               | strict `{sha256: Hash, bytes: Positive}`；plugin artifact bytes ≤128 MiB，runtime artifact bytes ≤512 MiB。hash 是整個下載檔原始 bytes，不是解壓內容。                                                                         |

Range 比較提議固定語意：exact 相等；`~M.m.p` 為 `>=M.m.p <M.(m+1).0`；`^M.m.p` 在 M>0 時 `<(M+1).0.0`，M=0、m>0 時 `<0.(m+1).0`，M=m=0 時 `<0.0.(p+1)`。任何 Range 不接受 prerelease target；preview dependency 如需 prerelease pin，留待 O9 決策，不能偷偷擴 grammar。package 本身可為 preview Version，但需 §7 opt-in；API 仍使用現有 manifest range，不能由 package version 推導。

既有 `kobrixa-plugin.json` 保留現有 known／unknown-field policy；新增 byte-level JSON lexer 拒絕 duplicate keys、非法 UTF-8、BOM、非 scalar 字串與超限。manifest 原始 bytes 被 hash，不強迫 canonical、不刪除 loose 欄位。unknown manifest 欄位不具 authority；新增 `signature`／`publisher`／`dependencies` 類自填欄位不能取代 strict metadata；需要新必要語意須提高 installer／format 或 API gate。現有 resources 各用原 schema，不把本節 integer-only canonical 規則套到有小數值的 UI／storage data。

## 4. 四份控制文件的完整提議 schema

### 4.1 `package-metadata.json`

**全部欄位提議 P03（O2、O4、O7），runtime／platform 加 P06（O5、O6、O7、O12），dependencies 加 P07（O9），storage 加 P09（O8、O11），release 加 P08（O3、O10）。** bytes 必須等於 §5 canonical encoding。

| 欄位                      | 型別／bounds                  | 交叉條件／失敗                                                                                 |
| ------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------- |
| `formatVersion`           | literal integer `1`           | 不識別版本 `PKG_E_FORMAT`。                                                                    |
| `minimumInstallerVersion` | StableVersion                 | 比較 host 的獨立 installer version；不足 `PKG_E_INSTALLER`，不拿 app／API version 代替。       |
| `pluginId`                | Id                            | 與 manifest.id／integrity.pluginId／lock.root.pluginId 相同；`kobrixa` 第一段保留。            |
| `version`                 | Version                       | 與 manifest.version／integrity.version／lock.root.version byte-equal；manifest 自己也須有效。  |
| `publisherId`             | Id                            | 與 integrity／lock.root 一致，必須有 trust namespace binding。                                 |
| `platform`                | Platform（下表）              | 一份 metadata 只有一個 platform；不接受 variants array。                                       |
| `runtime`                 | Runtime（下表）               | kind 對應 manifest；entry 唯一權威仍為 manifest.runtime.entry。                                |
| `dependencies`            | Dependency[]，0..127          | 按 PackageRef 升序、唯一；與 optionalDependencies 不交集。                                     |
| `optionalDependencies`    | Dependency[]，0..127          | 兩 array 合計 ≤127；不能自我 dependency。                                                      |
| `storage`                 | Storage 或 null               | null 表示不宣告套件資料遷移；不等於撤掉現有 storage grants。                                   |
| `channel`                 | literal `stable` 或 `preview` | prerelease Version 只允許 preview；stable 不會自動選 preview。                                 |
| `release`                 | Release                       | provenance 不能自授 trust。                                                                    |
| `executionPolicy`         | literal `trusted-local`       | sandbox profile 尚未核准；其他值 `PKG_E_POLICY`，不得靜默降級。static 仍須揭露 renderer 風險。 |

`Dependency` 所有欄位：`publisherId: Id`、`pluginId: Id`、`range: Range`。沒有 URL／install script／permission grant；缺必要 dependency 為 closure failure，optional 缺少由 lock 明確表達。

`Platform` 所有欄位（無省略）：

| 欄位               | 型別／bounds                      | 條件                                                                                                                                                  |
| ------------------ | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `os`               | `any`／`darwin`／`win32`／`linux` | 其他值不支援。                                                                                                                                        |
| `arch`             | `any`／`arm64`／`x64`             | os=any iff arch=any；不使用 universal／fat alias。                                                                                                    |
| `minimumOsVersion` | OsVersion 或 null                 | any 時 null，其他 required non-null；Windows 對照 kernel major.minor.build，darwin 為 macOS product version，Linux 為 kernel version。                |
| `libc`             | null 或 strict `{family: "glibc"  | "musl", minimumVersion: OsVersion}`                                                                                                                   | linux 必須 non-null，其他必須 null；不足三段的 probe 版本由 host 補 patch=0，probe 失敗不能猜。 |
| `nativeAbi`        | Token 或 null                     | static／純 Node 為 null；Python native vendor／native executable 必須為 host 已知 exact ABI ID，未知拒絕。any 必為 null。ABI ID catalog 尚待 O5／O7。 |

`Runtime` 為下列互斥 strict branch；表列欄位即該 branch 全部欄位，不接受其他 branch 的欄位：

| `kind`   | 其餘全部欄位                                                                                                                       | 條件                                                                                                                                                                           |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `static` | 無                                                                                                                                 | manifest kind=static；無 entry，沿用 static semantics。                                                                                                                        |
| `node`   | `hostVersion: Range`；`electronAbi: Positive`（≤65535）                                                                            | 使用 host 隨附 Node full version 檢查 range，Electron module ABI exact；即使純 JS 也明示已測 ABI。初版拒絕第三方 Node addon。                                                  |
| `python` | `implementation: "cpython"`；`fullVersion: StableVersion`；`buildId: Token`；`runtimePublisherId: Id`；`runtimeArtifact: Artifact` | 必須與 lock 的一個 RuntimePin 完全一致；本版 Python 的 platform 不得 any，即使 code 為純 Python。禁止 PATH／user-site fallback。                                               |
| `native` | `protocol: "stdio-v1"`；`abi: Token`                                                                                               | 格式保留提議，與 platform.nativeAbi 相同；現有 manifest 尚不接受 native，故本階段 admission 必為 `PKG_E_RUNTIME`。O7 核准且 4D 實作驗收後才可調整 gate，不能靠 metadata 開啟。 |

為避免 portable Python 的 runtimeArtifact 與一 variant 一包衝突，提議採**一個 exact runtime pin 的 package variant**，因此本版 Python 不允許 platform any。Node／static 才有 §7 portable 分支。此取捨待 O2／O5 核准，不在實作端自行忽略 pin。

`Release` 所有欄位：

| 欄位               | 型別／bounds                                | 語意                                                                                                   |
| ------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `id`               | Token                                       | publisher 內 release identity；同 `(publisherId, pluginId, version, platform)` 不可重發不同 artifact。 |
| `channelId`        | Id                                          | host 已信任的 channel identity；不是可自行指定的 URL。                                                 |
| `sourceRevision`   | Text，1..128 bytes，禁止 U+0000..001f／007f | provenance reference，非 authorization。                                                               |
| `builderId`        | Id                                          | 只是宣告；是否接受 builder 由 release policy。                                                         |
| `builtAt`          | Time                                        | 只記錄建置時間，不能當可信簽署時間或 anti-replay sequence。                                            |
| `provenanceSha256` | Hash 或 null                                | 外部 provenance artifact 的 digest；未提供為 null，不自動下載。                                        |

`Storage` 全部欄位與 Migration（提議 P09／O8、O11）：

| 欄位                           | 型別／bounds                                            | 語意                                                                                          |
| ------------------------------ | ------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `schemaVersion`                | Positive ≤2147483647                                    | plugin data schema，非 protocol schema。                                                      |
| `readable`                     | strict `{min: Positive, max: Positive}`，各 ≤2147483647 | min≤schemaVersion≤max。                                                                       |
| `writable`                     | 同 readable                                             | min≤schemaVersion≤max；writable 區間必須包含於 readable。                                     |
| `rollback`                     | `compatible-only`／`snapshot-required`                  | 宣告不能覆蓋實測不相容，也不能授權丟棄新版資料。                                              |
| `migrations`                   | Migration[]，0..16                                      | 按 `(from,to)` 整數升序、唯一；from≠to；允許反向 descriptor，但不推定可逆。                   |
| Migration.`from`／`to`         | Positive，各 ≤2147483647                                | to 必須在 writable 內；4C 按實際資料 schema 選路。                                            |
| Migration.`kind`               | `declarative-v1`／`isolated-process-v1`                 | 只描述未來執行器；未實作的 kind 不可執行，回 `PKG_E_MIGRATION`。                              |
| Migration.`path`               | PackagePath，必在 `payload/`                            | 必須被 integrity 覆蓋。                                                                       |
| Migration.`sha256`             | Hash                                                    | 與該 path 的 integrity hash 相同。                                                            |
| Migration.`maximumOutputBytes` | Positive ≤64 MiB                                        | 另取現有 record／namespace quotas 與 4C snapshot reservation 的較小值，不能增大既有 quota。   |
| Migration.`deadlineMs`         | Positive ≤10000                                         | 新 migration 提議上限，非現有 device／persistence timeout 的變更；4C 須有真實可終止的執行器。 |

### 4.2 `dependency-lock.json`

**全部提議 P03、P07（O2、O4、O5、O9），artifact 信任另依 P08（O3、O10）。** 此檔是作者提供的完整候選 closure，不是 grants／啟用指令；solver 不能因簽過字而省略驗每個 dependency。canonical bytes；禁止 floating version、URL、未鎖定 runtime、install hook。

| 欄位            | 型別／bounds         | 語意                                                                                               |
| --------------- | -------------------- | -------------------------------------------------------------------------------------------------- |
| `formatVersion` | literal 1            | 與 package format 相同。                                                                           |
| `root`          | LockRoot             | 無自己的 Artifact／integrity digest，避免 metadata→lock→自身 hash 循環。                           |
| `nodes`         | LockNode[]，0..127   | 按 PackageRef 升序；root 不出現在 nodes；同 PackageRef 單版。                                      |
| `runtimes`      | RuntimePin[]，0..128 | 按 artifact.sha256 ASCII 升序；唯一；全部必須被 root／node 的 runtimeDigest 引用，不能藏無引用包。 |

| LockRoot 欄位（全部）                | 型別／bounds                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| `publisherId`／`pluginId`／`version` | Id／Id／Version，與 metadata 相同。                                          |
| `platform`                           | Platform，與 metadata byte-level canonical value 相同。                      |
| `runtimeDigest`                      | Hash 或 null；Python 為 metadata.runtime.runtimeArtifact.sha256，其餘 null。 |
| `edges`                              | LockEdge[]，0..127，按 PackageRef 升序、唯一。                               |

LockNode = LockRoot 的全部欄位，再加 **`artifact: Artifact`、`integritySha256: Hash`**。digest 綁單一完整依賴包；拿到其真實 metadata／lock 後，必須核對 node 的 identity、version、platform、runtimeDigest 及 edges，不信 root 包自述的 dependency 內容。各子包自己的 closure 若不同即拒絕整個 activation graph，不採最後載入者勝出。

| LockEdge 欄位（全部）     | 型別／bounds                                                 | 語意                                                                        |
| ------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `publisherId`／`pluginId` | Id／Id                                                       | 對應該父節點 metadata 的 dependency；不能改 publisher。                     |
| `range`                   | Range                                                        | 與父節點 metadata 宣告完全相同。                                            |
| `optional`                | boolean                                                      | 對應 required／optional array，不能自行改 true。                            |
| `targetVersion`           | Version 或 null                                              | non-null 必須找到唯一 node 並滿足 range；null 只允許 optional。             |
| `omission`                | null／`not-selected`／`unavailable`／`incompatible-platform` | targetVersion 非 null iff omission=null；缺選項須明列，不能自動下載／執行。 |

`RuntimePin` 全部欄位：`publisherId: Id`、`implementation: "cpython"`、`fullVersion: StableVersion`、`buildId: Token`、`platform: Platform`、`artifact: Artifact`、`integritySha256: Hash`。platform 不得 any；runtime native ABI 必須非 null、為供應 catalog 中 exact ABI。metadata 的 runtimePublisherId／fullVersion／buildId／artifact 必須一致。runtime format 仍待 O5，因此「pin 結構正確」不能當成 runtime 包已驗證。

所有 required edges 都到達 nodes，所有 nodes 從 root 可達，無 cycles／多版本／多 publisher 偽裝／self-edge；depth 最多 16（root depth=0）。初次 install 的每一必要 artifact 必須在完整離線集合或受信任來源可取得且通過自身驗證；僅驗單包時只能報 `PackageVerified, closure=NOT_RUN`，不得報 `Installable`。4E 可以重新解 graph，但產出新 host-owned activation lock／consent，不能改已簽作者 lock 後仍沿用原簽章。

### 4.3 `integrity.json`

**全部提議 P03、P04（O2、O3、O4）。** 新版 metadata 不能自行替換算法；此物件也是 signature 的 authority binding。

| 欄位                                 | 型別／bounds                                  | 語意                                                                                                                                                                          |
| ------------------------------------ | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `formatVersion`                      | literal 1                                     | framing 也必須為 1。                                                                                                                                                          |
| `pluginId`／`publisherId`／`version` | Id／Id／Version                               | 與 metadata 相同。                                                                                                                                                            |
| `signing`                            | strict `{algorithm: "Ed25519", keyId: KeyId}` | key role 必須 release，publisher 必須有該 key binding。                                                                                                                       |
| `hashAlgorithm`                      | literal `sha256`                              | 任何其他拼字／算法 `PKG_E_ALGORITHM`。                                                                                                                                        |
| `files`                              | IntegrityFile[]，5..19998                     | 最少 metadata、manifest、lock、sbom、license；完整且無額外檔，按 path ASCII 升序。                                                                                            |
| IntegrityFile.`path`                 | PackagePath                                   | 符合 §2 allowed entry set；不可含兩個排除檔。                                                                                                                                 |
| IntegrityFile.`bytes`                | U53 ≤64 MiB                                   | 解壓後原始長度；各 metadata 小 cap 優先。                                                                                                                                     |
| IntegrityFile.`mode`                 | integer 420 或 493                            | 十進位表示 `0o644`／`0o755`，不是字串或 ZIP file-type bits。control／resources／licenses 全 420；493 只限 native entry，且受 4D admission gate。Node／Python entry 仍為 420。 |
| IntegrityFile.`sha256`               | Hash                                          | SHA-256(exact expanded file bytes)，包含該檔原有 LF／CRLF／BOM（若該類檔允許）；不做 newline／Unicode 轉換。                                                                  |

`integritySha256 = SHA-256(C(integrity))` 用於 receipts／channel binding。它不同於整包 `artifact.sha256`，也不同於 §5 signature message 的 digest。metadata／manifest／lock／SBOM／licenses 都有 hash；只簽 entry 不合格。

### 4.4 `signatures/publisher.json`

**全部提議 P03、P04、P08（O2、O3、O4、O10）。** 初版恰一個 package signature；多簽 rotation 記錄在 trust metadata，不把第二個未驗簽 envelope 當 optional。

| 欄位              | 型別／bounds      | 語意                                                                                                |
| ----------------- | ----------------- | --------------------------------------------------------------------------------------------------- |
| `formatVersion`   | literal 1         | envelope version，必須與 integrity 相同。                                                           |
| `publisherId`     | Id                | 與 integrity.publisherId 相同。                                                                     |
| `keyId`           | KeyId             | 與 integrity.signing.keyId 相同；只查 host trust store，沒有 inline publicKey／certificate／URL。   |
| `algorithm`       | literal `Ed25519` | 與 integrity.signing.algorithm 相同；不接受 Ed25519ph／Ed25519ctx／RSA／HS256／none／大小寫 alias。 |
| `integritySha256` | Hash              | 必須等於 SHA-256(C(integrity))，但驗簽仍使用下面的完整 message。                                    |
| `signature`       | `^[0-9a-f]{128}$` | raw 64-byte signature 的 hex；不接受 DER／Base64／截斷／尾隨 bytes。                                |

### 4.5 SBOM 與 manifest 邊界

**提議 P03、P07（O2、O4、O9）：** 為了讓必要 `sbom.json` 可精確驗收，初版採最小 build-input inventory，**不是宣稱完整 SPDX／CycloneDX 相容**。strict canonical object：`formatVersion: 1`、`components: Component[]`（0..4096，按 id ASCII 升序、唯一）。Component 全欄位為 `id: Token`、`name: Text`（≤200 bytes）、`version: Text`（≤128 bytes）、`sourceSha256: Hash`、`licensePath: PackagePath`（必在 licenses/ 且被 integrity 覆蓋）。外部完整 SBOM 可作 resource，不能代替此 inventory；供應鏈 scanner／license 法務核准不由 parser 宣稱完成。

manifest 仍是 API／permissions／requires.devices／contributions 唯一權威。正式來源不得冒充 builtin；即使空陣列、null 或錯型別，出現外部 deviceProviders／languageServices 也沿用現有拒絕語意；frontend/backend 亦保留 builtin-only。package validator 報 `PKG_E_MANIFEST_POLICY`，detail 可以帶既有 `PLUGIN_E_*_REQUIRES_BUILTIN`，不修改現有 registry error union。

## 5. Canonical bytes、hash 與簽章輸入

**本節全部提議 P04（O2、O3），parser caps 依 P03（O4）。** `C` 是本文件定義的 integer-only canonical encoding，**不宣稱為 RFC 8785 JCS**。JSON 語法底層參考 [RFC 8259](https://www.rfc-editor.org/rfc/rfc8259)；以下額外限制是 Kobrixa 提議，不能用某語言的預設 stringify 代替契約。

### 5.1 `C(value)` 的演算法

1. 輸入為通過 strict UTF-8 decoder 的 JSON text；拒絕 BOM、overlong UTF-8、invalid continuation、unpaired surrogate、trailing token。在建立 map 前辨識 duplicate keys：`"a"` 與 `"\u0061"` 是同一 key，拒絕而非取最後值。不得以 JS object prototype 作 key lookup。
2. 新控制文件只接受 null、boolean、U53、Unicode scalar string、array、object。object keys 限 1..64 ASCII bytes、`^[A-Za-z][A-Za-z0-9]*$`；正式 schema 的已列欄位仍是唯一允許集合。generic vector 可測其他合法 key，但不代表 schema 允許該 key。數字在轉成 double 前以 decimal token／整數檢查 U53，不先四捨五入。
3. object keys 以 unsigned ASCII bytes lexicographic 升序，prefix 較短者在前；不採 insertion order、locale sort 或 JS integer-index ordering。array 保留輸入順序，另由各 schema 檢查其排序／唯一性，不自行重排來接受不合格包。
4. null／boolean 輸出 `null`、`true`、`false`；U53 輸出無前導零十進位。沒有 exponent、decimal point、`+`、negative zero 或非 finite 值。
5. 字串前後為 ASCII `"`。U+0022 輸出 `\"`、U+005C 輸出 `\\`；U+0000..001f 一律輸出六個 ASCII bytes `\u00xx`，hex 小寫，**不用** `\n`、`\t` 等短 escape。其他 scalar 原樣 UTF-8，包括 `/`、U+007F、U+2028／2029、非 ASCII；不 escape slash、不 NFC／NFD。欄位禁止的 control 字元仍須先按 schema 拒絕。
6. object 用 `:`、`,`，array 用 `,`，完全無空白、BOM、尾端 LF。`C` 輸出為 bytes，不是 UTF-16 string。正式新控制文件要求原始 bytes **等於** `C(parsedValue)`；同義但不同 key order／escape／whitespace 回 `PKG_E_CANONICAL`。不 canonicalize 後放過已簽檔案的實際 hash 差異。

順序固定為 lexical validity → duplicate-key detection → generic bounds／number domain → schema／unknown keys → canonical-byte equality。若 `"a"` 與 `"\u0061"` 重複，先報 `PKG_E_JSON_DUPLICATE_KEY`，不報 noncanonical。manifest／其他既有 JSON 依 §3 的例外，仍偵測 duplicate，但不要求 C equality。

### 5.2 Hash 域與簽章演算法

`H(B) = SHA-256(B)`，輸出 32 raw bytes；呈現為 64 lower hex。連接符 `||` 指 bytes 串接，不是把 hex 字串串起來再 hash。`U32BE`／`U64BE` 為固定 4／8-byte unsigned big-endian integer；ZIP header 自己則按 ZIP little-endian，兩者不可混用。

```text
I = C(integrity object)
domain = ASCII("KOBRIXA-PLUGIN-INTEGRITY") || 00
M = domain || U32BE(1) || U64BE(byteLength(I)) || I
integritySha256 = lowerHex(H(I))
signature = lowerHex(Ed25519.Sign(privateKey, M))
artifactSha256 = lowerHex(H(entire ZIP bytes through EOCD))
```

domain 的 terminator 是**單一 NUL byte**，非兩個字元 `\0`，不是 LF。`U32BE(1)` 對應 integrity.formatVersion；未知版本在選 domain 前即拒絕。用 [RFC 8032 pure Ed25519](https://www.rfc-editor.org/rfc/rfc8032) 簽完整 M；**不簽 H(M)、H(I)、hex digest 或 signature envelope**，也不選 Ed25519ph／ctx。驗證 library 必須接受 raw 32-byte key、raw 64-byte signature，拒絕 noncanonical point encoding、identity／非 prime-order 的 A 或 R、`S >= L`；驗證 prime subgroup 中的 Ed25519 equation。嚴格 point／scalar 負例需跨實作對齊，不接受 library 的較寬鬆行為作為契約。

algorithm、keyId、publisherId、pluginId、version 均在已簽 I 內；外層 signature envelope 只重複定位並逐欄相等。改 envelope algorithm 不會切換 verifier，換 publisher／key ID 不會找到另一個允許角色。包內無公鑰；OS code-signing／HTTPS certificate 不參與此驗證。

### 5.3 Worked byte vectors（提議，非套件通過證據）

以下每列的 `hex` 是**完整 hash 輸入 bytes**，無省略、無尾端 newline。`sha256` 是本次以 Node crypto 重算的算術輸出；這只驗證示例數字，不是尚未實作的 validator／跨語言測試通過。V01／V02 是 file hash；V03–V06 是 C 層、V07 是單一 IntegrityFile、V08 是 framing 層；它們不是可安裝 archive。V05a／b 特別顯示 absent 與 null 不可互換。

**V01：空檔，長度 0。** 空字串表示零個 bytes，不是兩個 quote bytes。

```text
hex=
sha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

**V02：檔案字面內容 `abc`，長度 3，無 LF。**

```text
hex=616263
sha256=ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
```

**V03：抽象 object 依插入順序 b=2、a=1；C 輸出 `{"a":1,"b":2}`，長度 13。** 若正式控制檔原 bytes 為 b 在前，雖可得到此 C，仍須 `PKG_E_CANONICAL`。

```text
hex=7b2261223a312c2262223a327d
sha256=43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777
```

**V04：object 的 s 為 U+00E9、U+6C34、U+1F600；x 為 U+000A、U+0022、U+005C、U+002F，長度 35。** x 的四個 scalar 是 LF、quote、backslash、slash；hex 是準據，顯示字型不影響 bytes。這是 encoder vector，不授權 control 字元出現在禁止它的欄位。

```text
hex=7b2273223a22c3a9e6b0b4f09f9880222c2278223a225c75303030615c225c5c2f227d
sha256=ea50aaa74fbb7ef3698d89f79f9c3eacdef6486c15884e6940f887dbfe3879a5
```

**V05a：空 object `{}`，長度 2。V05b：`{"x":null}`，長度 10。**

```text
V05a.hex=7b7d
V05a.sha256=44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a
V05b.hex=7b2278223a6e756c6c7d
V05b.sha256=c6b8df5aba33a39cbdee46ffaf77fae93ea2aa7d99d66408162b05a42105bd71
```

**V06：`{"a":[true,false,null,0,9007199254740991]}`，長度 42。** 最大 U53 直接轉十進位，array 不排序。

```text
hex=7b2261223a5b747275652c66616c73652c6e756c6c2c302c393030373139393235343734303939315d7d
sha256=d3f3c61f6894743b1b82ea28e432ea3d288c8a47278d85ae2840b018fb589e2a
```

**V07：`payload/a.txt` 為 V02 的三個 bytes；mode=420 的 IntegrityFile，C 長度 121。** 外層 hash 是 record 的 C，內層 sha256 是 file hash，兩者不可混淆。

```text
hex=7b226279746573223a332c226d6f6465223a3432302c2270617468223a227061796c6f61642f612e747874222c22736861323536223a2262613738313662663866303163666561343134313430646535646165323232336230303336316133393631373761396362343130666636316632303031356164227d
sha256=93e6afc80340f80b3d265720b01a26a0b2f08f2680dac39e4ed2808e3fcb63c9
```

**V08：framing primitive 把 V03 的 13 bytes 當測試 I，M 長度 50。** domain 25 bytes（含 NUL）＋4＋8＋13。此 I 不符合完整 integrity schema，完整 verifier 必須拒絕；這個 vector 只固定 bytes framing，**不是有效簽章測試或可省略 schema 的例外**。`H(M)` 只供比對；真正 Sign 的輸入仍是 M。

```text
hex=4b4f42524958412d504c5547494e2d494e544547524954590000000001000000000000000d7b2261223a312c2262223a327d
sha256=1c07d8da4761a9d792ccb592537212e6adbf9cc11e7f0854057991234f5b4e28
```

另須實作時產生**完整合法包**的 immutable golden fixture：固定測試私鑰（明示非 production）、完整 I／M hex、Ed25519 signature、全部 file hashes、整 ZIP digest；由獨立 TS 與 Python／另一語言 verifier 都讀取同一 fixture。本文不捏造尚不存在的完整簽章／archive conformance 證據。

## 6. 串流驗證、拒絕次序與結果

**全部提議 P05（O2、O3、O4、O11），語意檢查另依 P03／P06／P07／P08／P09 的 owner。** 使用 bounded stream parser；不能把 archive 交給會自動建立目標檔案的通用 unzip。acquisition 原始 ZIP 可 spool 到 host 私有 quarantine file，以便最後檢查整包 digest；解壓內容先以 entry ordinal 的 host-generated 檔名寫入同 filesystem quarantine，未驗完整包前不建立插件可見路徑、不 import、不交付 static/UI resources。

### 6.1 結果與共同失敗語意

提議回傳 discriminated result，而非單一 `valid: true`：

| 結果                                                                                                                       | 精確語意                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Rejected {code, stage, entryIndex?, path?}`                                                                               | code 為本節／§9 的有限 `PKG_E_*`；stage 為下表 `S00`..`S12`；entryIndex 為 0-based U53 ≤19999；path 只可為已驗 PackagePath，不回 host absolute path／raw hostile name。未達階段列 NOT RUN。    |
| `PackageVerified {artifact, integritySha256, publisherId, pluginId, version, trustRevision, platform, closure: "NOT_RUN"}` | 僅單包結構、簽章、信任、平台、內容全過；尚未核對所有外部依賴／runtime，不能安裝／啟用。trustRevision 為 §8 TrustStore.revision（Positive），綁全部 authorities／bindings，不只單一 publisher。 |
| `VerifiedCandidate {package, closureDigest, trustRevision}`                                                                | 外部 closure 全驗證且平台/runtime admission 所需 receipts 存在；只交 4C 準備交易。仍無 grants／Active／durable publish 保證。closureDigest 為 host 重新核對 activation lock 的 C hash。        |

本次不建立以上型別。失敗撤銷 candidate、關閉 fd／inflater，不改 active head、disabled、grants、資料 generation、trust roots 或既有安全 journal。quarantine 清理失敗另記 host cleanup fault，不把原 rejection 改 pass，也不允許晚到 callback publish。I/O failure 保留 bounded diagnostic；明確取消／timeout 與惡意輸入分開。

### 6.2 固定階段

| 次序 | 提議檢查與輸出                                                                                                                                                                                                                                                          | 拒絕碼（同列依列出順序）                                                                                                                                                                                        |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S00  | host 提供 operation=`inspect`／`install`／`update`／`enable`、目標平台、可信時鐘／trust snapshot；取得私有 no-follow staging capability。inspect 可回未信任結果，但不產生 VerifiedCandidate。                                                                           | `PKG_E_TRUST_STORE`（trust 損壞／不完整）；`PKG_E_IO`（讀寫失敗）；`PKG_E_STAGING_UNSAFE`（無安全原語／private root）                                                                                           |
| S01  | 每次讀取先檢取消與 monotonic deadline，再更新整 ZIP bytes；checked arithmetic；沒有可用完整 header 時等待更多 bytes，EOF 才是截斷。                                                                                                                                     | `PKG_E_CANCELLED`；`PKG_E_TIMEOUT`；`PKG_E_ARCHIVE_LIMIT`；`PKG_E_ZIP_TRUNCATED`                                                                                                                                |
| S02  | 依 §2.1 解析下一個 local header，驗 record type、version／flags／method／extras／time／宣告 sizes；做 file-count、declared expanded／ratio cap。                                                                                                                        | `PKG_E_ZIP_STRUCTURE`；`PKG_E_ZIP_FEATURE`；`PKG_E_FILE_LIMIT`；`PKG_E_EXPANDED_LIMIT`；`PKG_E_RATIO`                                                                                                           |
| S03  | strict decode filename → path grammar／reserved names → identical duplicate → folded-prefix／file-parent collision → allowed entry set → fixed order；integrity 到手後也對其完整 path set 做同一檢查。                                                                  | `PKG_E_ENCODING`；`PKG_E_PATH`；`PKG_E_DUPLICATE_ENTRY`；`PKG_E_PATH_COLLISION`；`PKG_E_ENTRY_SET`；`PKG_E_ENTRY_ORDER`                                                                                         |
| S04  | 只讀該 entry 已宣告 compressed extent；bounded inflate／raw copy，實際 expanded、metadata cap、ratio、CRC、實際 size；控制檔只 method 0。raw DEFLATE 必須恰一個 stream 結束，禁止 concatenated／unused whole bytes，最後 byte unused bits 必為 0。每個 chunk 仍經 S01。 | `PKG_E_FILE_LIMIT`；`PKG_E_EXPANDED_LIMIT`；`PKG_E_RATIO`；`PKG_E_DEFLATE`；`PKG_E_SIZE`；`PKG_E_CRC`                                                                                                           |
| S05  | 第一檔 integrity：UTF-8／JSON lexer／duplicate／bounds → strict schema（含 format／algorithm）→ C equality → path set／sorting／總上限；第二檔 signature 同樣驗，核對重複欄位與 I digest。不讀第三檔 payload 前先完成 S06。                                             | `PKG_E_ENCODING`；`PKG_E_JSON`；`PKG_E_JSON_DUPLICATE_KEY`；`PKG_E_JSON_LIMIT`；`PKG_E_FORMAT`；`PKG_E_ALGORITHM`；`PKG_E_UNKNOWN_FIELD`；`PKG_E_SCHEMA`；`PKG_E_CANONICAL`；`PKG_E_ENTRY_SET`；`PKG_E_BINDING` |
| S06  | 查 keyId 對應的單一 raw key，檢 key validity／role／publisher namespace／已知撤銷／operation freshness，再按 §5 驗 Ed25519 M；選定的 trust revision 固定於本次 candidate。                                                                                              | `PKG_E_KEY_UNKNOWN`；`PKG_E_KEY_SCOPE`；`PKG_E_REVOKED`；`PKG_E_TRUST_EXPIRED`；`PKG_E_SIGNATURE`                                                                                                               |
| S07  | 其餘檔案沿 S01–S04，逐檔對 integrity 的 path／bytes／mode（central 才最終確認）／SHA-256；hash 更新只取實際 expanded bytes；每檔完成即關閉 quarantine leaf，無 read-all payload。                                                                                       | `PKG_E_ENTRY_SET`；`PKG_E_SIZE`；`PKG_E_HASH`；`PKG_E_IO`                                                                                                                                                       |
| S08  | metadata／manifest／lock／SBOM 分別在完整 bytes／hash 正確後解析。新控制檔走 S05 的 JSON／strict／C 規則；核對 identity／installer、manifest known semantics／builtin-only、references、entry、runtime、storage descriptors、lock 根結構。                              | `PKG_E_BINDING`；`PKG_E_INSTALLER`；`PKG_E_MANIFEST`；`PKG_E_MANIFEST_POLICY`；`PKG_E_REFERENCE`；`PKG_E_RUNTIME`；`PKG_E_MIGRATION`；`PKG_E_LOCK`                                                              |
| S09  | 讀 central directory，逐 ordinal 對 local 的 names／sizes／CRC／flags／method／time／offset，驗 type／mode、相鄰 extent、EOCD count／offset／size／EOF；所有期待檔案已出現。                                                                                            | `PKG_E_ZIP_TRUNCATED`；`PKG_E_ZIP_STRUCTURE`；`PKG_E_ZIP_FEATURE`；`PKG_E_FILE_TYPE`；`PKG_E_MODE`；`PKG_E_ENTRY_SET`                                                                                           |
| S10  | 完整 ZIP bytes／digest 對受信任外部 target（若有）；核對其 publisher／plugin／version／platform／integrity digest。已知 package digest／runtime build 撤銷再檢；§7 target／policy／API 相容。                                                                           | `PKG_E_ARTIFACT`；`PKG_E_REVOKED`；`PKG_E_PLATFORM`；`PKG_E_ABI`；`PKG_E_POLICY`；`PKG_E_API`                                                                                                                   |
| S11  | install／update 的 closure：每個 dependency／runtime 自身驗簽、digest／platform、manifest edge ranges、單版／cycle／depth／數量、provider conflicts；完整性不足不可升格。                                                                                               | `PKG_E_CLOSURE_MISSING`；`PKG_E_LOCK`；`PKG_E_DEPENDENCY_CYCLE`；`PKG_E_DEPENDENCY_LIMIT`；`PKG_E_PROVIDER_CONFLICT`；`PKG_E_RUNTIME`                                                                           |
| S12  | 從已驗 host-named files 以安全 directory handles materialize private package tree；核對 inode／file ID／regularness／bytes，再檢 trust revision 與撤銷沒有改變。產出 receipt 給 4C，沒有 rename active head。                                                           | `PKG_E_STAGING_UNSAFE`；`PKG_E_IO`；`PKG_E_TOCTOU`；`PKG_E_TRUST_CHANGED`                                                                                                                                       |

S02–S08 是逐 entry 執行而非先讀所有 headers；第一／二 entry 分別完成 S05，第二 entry 完成後立刻 S06，才允許第三 entry。S08 的跨檔條件等所需檔都到手時按 metadata→manifest→lock→SBOM 檢；entry／resource reference 的「檔存在」先對 signed index，S09 再確認實際集合。任何 manifest required resource 的既有 schema／bytes 上限仍另驗，失敗 `PKG_E_REFERENCE`，簽章不豁免。S11 若需要在多個候選包選 variant，先套 §7 選擇次序；同順位歧義為 `PKG_E_VARIANT_AMBIGUOUS`，不進 closure expansion。

schema 的一般型別／bounds 失敗為 `PKG_E_SCHEMA`；但已識別安全 selector 的未知值使用專用錯誤：formatVersion→`PKG_E_FORMAT`、algorithm／hashAlgorithm→`PKG_E_ALGORITHM`、runtime.kind→`PKG_E_RUNTIME`、executionPolicy→`PKG_E_POLICY`。這些在 S05/S08 解析時即拒絕，不延後至 S10；S10 的 policy 是已通過結構驗證後的 host channel opt-in／執行政策檢查。missing selector 仍為 schema error，額外 key 仍為 unknown-field error。integrity 完整 path set 的 S03 檢查在 S05 重用，因此 path／duplicate／collision／ordering 錯誤也保留相同專用 code，不全部壓成 ENTRY_SET。

S06 對 install/update 要求 active release key；retired key 回 `PKG_E_KEY_SCOPE`，時間過期回 `PKG_E_TRUST_EXPIRED`。enable 僅在 §8.5 的舊 durable receipt 精確匹配時允許 retired／stale 例外，仍驗簽與全部 known revocations；不為新 bytes 發 receipt。snapshot／freshness／LocalBinding 任一改變都推進全域 TrustStore.revision；S00 先持久記錄本次時鐘觀察，再 capture revision，S12 只比較、不悄悄改 snapshot 或重設時間。後續 commit／enable 另由 4C 在其 admission frontier 重驗，不能將 receipt 當永久有效授權。

輸入每多一個 bytes 都需有界；declared sizes 只用來界定 framing 與早拒絕，**不**作 allocation 大小、不取代真實 counters。單檔 ratio 的 streaming early bound 是 `actualOutput <= 100 * declaredCompressedExtent`；entry 結束再以 inflater 實際消耗（不得含未用 bytes）驗 ratio。總體對已完成 entries 的實際 totals 檢查，當前 entry 另受單檔／總 expanded cap；不能借未來假宣告的 compressed data 掩蓋 bomb。

同時違反多規則時，回報**最先可判定階段**的第一個錯誤；同階段依表內順序、同一 object 依 canonical key 次序、同 array 依 index。不要為了蒐集更多錯誤繼續解壓。例：invalid signature＋後方 truncated payload → S06 signature；signature 合法但最後 EOCD 缺 bytes → S09 truncated。測負例時保持其他條件有效，才能期待指定錯誤。I/O／取消是環境事件，測試需另記發生 frontier，不能包裝成可重現 archive error。

no-follow leaf open 加事前 realpath 不足以抵抗 parent swap。平台 adapter 須持有 root／parent directory capabilities，exclusive-create regular files、拒絕 reparse／link／hardlink（link count 必為 1）、不覆寫任何既有 leaf、檢查身份在 read／materialize 前後一致；缺安全原語即 `PKG_E_STAGING_UNSAFE`。同使用者未沙箱惡意程式仍有 OS 層殘餘風險，4D 不得用驗簽宣稱阻止 direct filesystem／network／USB。每次 enable／activate 重新驗內容及信任；4C 的 durable commit 尚需另外驗證。

## 7. 平台、variant 與 runtime matching

**本節全部提議 P06（O5、O6、O7、O12），選候選另依 P07（O9）。** 所有 host facts 由可信 adapter 取得，不由包提供。每個 `.kobrixa-plugin` 只有一個 variant；file basename、CPU 模擬能力、開發機 PATH 不參與 matching。

| 候選                 | 提議 match 規則                                                                                                                                                                                                                                       | 拒絕                          |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| 首批 concrete matrix | 僅 `darwin/arm64`、`win32/x64`、`linux/x64`。OS product/kernel minimum、Linux libc family/minimum、nativeAbi 必須逐一成立。其他 schema 可表示的組合仍無發布 admission。                                                                               | `PKG_E_PLATFORM`／`PKG_E_ABI` |
| `any/any`            | 只 static 或純 JS Node；minimumOsVersion／libc／nativeAbi 全 null，無 mode 493、`.node`／`.dll`／`.so`／`.dylib`／`.exe`，無 PE／ELF／Mach-O magic 的 payload。binary scan 不足以證明任意 JS 行為可攜，仍須三平台 build receipt。                     | `PKG_E_PLATFORM`              |
| Node                 | host Node version 滿足 hostVersion，Electron module ABI exact；禁止第三方 native addon（任何平台），不裝外部 Node。manifest entry 必在 payload/ 且 mode 420。                                                                                         | `PKG_E_RUNTIME`／`PKG_E_ABI`  |
| Python               | concrete OS／arch；exact CPython version＋buildId＋runtimePublisher＋artifact digest；runtime pin OS／arch 與 plugin 相同，其 minimum OS／libc 也滿足 host。plugin nativeAbi 非 null 時必與 runtime ABI 相同。venv／isolated mode 不構成 OS sandbox。 | `PKG_E_RUNTIME`／`PKG_E_ABI`  |
| native               | 4D manifest／stdio／binary type／OS-signing／child cleanup admission 尚未實作，故本規格狀態下不能出 VerifiedCandidate。                                                                                                                               | `PKG_E_RUNTIME`               |
| API                  | host full Plugin API 必須滿足 manifest apiVersion，並在未來 launch 保留握手／feature negotiation；提議新正式包最低 API baseline 1.8.0（range 下界至少 1.8.0）。不修改既有 builtin／development 的相容 range。                                         | `PKG_E_API`                   |
| execution policy     | 初版只 trusted-local。unknown／sandbox-required 不能當 trusted-local 執行；權限另由 core consent，declared≠granted。                                                                                                                                  | `PKG_E_POLICY`                |

純 JS native scan 的特徵提議固定：suffix 使用 ASCII lowercase，PE 檢 `4d5a`、ELF 檢 `7f454c46`、Mach-O 檢 `feedface`／`cefaedfe`／`feedfacf`／`cffaedfe`／`cafebabe`／`bebafeca`／`cafebabf`／`bfbafeca` 的前四個 raw bytes。它是保守拒絕清單，不是惡意 payload detector；資料巧合命中仍要求 concrete variant／owner review，不加隱藏 allow flag。unknown ABI catalog 或 OS/libc probe 失敗一律拒絕；沒有「看起來像 linux」的 fallback。

同 `(publisherId, pluginId, version)` 有多個 verified candidates 時，先 filter trust／channel opt-in／API／runtime，再 exact OS/arch 優先於 any；同順位若有不同 digest 或不同 libc/ABI candidate 同時適用，回 `PKG_E_VARIANT_AMBIGUOUS`，不依下載順序或最大 minOS 猜。只選本機兼容的 libc family；不把 glibc 與 musl 視為互換、不用 Rosetta／x64 emulation 充當 arm64。若 exact candidate 不可信／被撤銷，不以同 release 的 portable candidate 自動規避；受撤銷 target 的實際 scope 決定，任何替代都須重新解 graph／同意。

runtime 缺少時 install 可顯示缺少的 exact artifact，不能換系統 Python。最低 OS 版本、Linux 支援 distro／libc baseline、CPython supplier／build catalog、Node／Electron ABI 支援集合**仍未由現有 code 決定**，是 §11 blocking questions；本文不填入未驗數字以假定已支援。

## 8. Trust store、bootstrap、rotation 與 revocation

**本節全部提議 P08（O3、O10、O11）；不是既有 app code-signing store。** 這是可 review 的本機 trust contract 草案；更新 metadata 採成熟框架或自訂最小格式，仍須 O10 security review。本節提供精確候選 data model，不宣稱已完成完整 repository-update security。只有本節明列的 root／freshness 簽署文件能改 trust；插件 archive 絕不能攜帶自動匯入的信任根。

### 8.1 本機持久化 model

新 objects 均 strict、C encoding；每個檔上限 4 MiB、JSON 通則同 §3。容量滿回 `PKG_E_TRUST_LIMIT`，不得丟棄 revocations／sequence high-water 來接收新資料。host 儲存以 4C 的單 writer／atomic head 契約處理；未證明 durable publication 時不得更新可信狀態或宣稱新 key 已安裝。

| TrustStore 欄位（全部） | 提議型別／bounds        | 語意                                                                                                     |
| ----------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------- |
| `formatVersion`         | literal 1               | 未知版本不 overwrite。                                                                                   |
| `revision`              | Positive                | host 本機單調遞增；同 revision 不接受另一 digest。                                                       |
| `authorities`           | AuthorityState[]，1..64 | 按 authorityId ASCII 升序、唯一。每個 publisher 恰歸一 authority；不允許較弱 root 擴張別人的 namespace。 |
| `bindings`              | LocalBinding[]，0..1024 | 按 publisherId 升序、唯一；只能由 app bootstrap 或帶外核對後的 core 操作建立。                           |

| AuthorityState 欄位（全部）                           | 提議型別／bounds        | 語意                                                                                          |
| ----------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------- |
| `authorityId`                                         | Id                      | trust domain identity，不能從包的 publisher 自動建立。                                        |
| `bootstrap`                                           | Bootstrap               | 本機核對來源，不能由遠端 snapshot 覆寫。                                                      |
| `snapshot`                                            | SignedTrustSnapshot     | 下節的完整 signed record；至多 4 MiB 的檔案 cap 仍優先。                                      |
| `freshness`                                           | SignedFreshness 或 null | null 阻擋 install／update，不能因「離線」忽略。                                               |
| `highestSnapshotSequence`／`highestFreshnessSequence` | U53                     | 已 durable 接受的最高值，永不因重裝包／回退 app 清零；bootstrap 首次 freshness 高水位可為 0。 |
| `highestTrustedTime`                                  | Time                    | 已接受 signed issuedAt 的最大值；避免回調時鐘讓過期 metadata 復活。                           |
| `lastObservedWallTime`                                | Time                    | 本機最後一次已持久記錄的時鐘，用於檢出回退。                                                  |
| `snapshotSha256`                                      | Hash                    | H(C(snapshot.signed))；必與 snapshot 相符。                                                   |

`Bootstrap` 為互斥 strict branch（全欄位）：

- app 配送：`{kind: "app", appVersion: Version, rootKeyId: KeyId, publicKey: Hex32, importedAt: Time}`。
- 帶外匯入：`{kind: "manual", rootKeyId: KeyId, publicKey: Hex32, verifiedFingerprint: KeyId, importedAt: Time}`；verifiedFingerprint 必須等於 SHA-256(raw key)，由 core UI 記錄使用者核對的完整 64 hex。不能把 plugin 的 confirmation callback 當核准。

`Hex32 = ^[0-9a-f]{64}$`，解碼後是 raw public key；KeyId 必須由它重算。bootstrap 的 appVersion／importedAt 是本機 provenance，不是 root 自簽能獲信任的原因。首次 snapshot 可 self-sign，但只有 key bytes 與已配送／核對的 bootstrap 完全相同且 namespace binding 已建立時才接受。首次 root fingerprint 的實際配送責任仍待 O3 具名。

`LocalBinding` 全欄位：`publisherId: Id`、`authorityId: Id`、`namespacePrefixes: Id[]`（1..32，ASCII 升序唯一、無包含關係）、`approvedAt: Time`、`origin: "app" | "manual"`。prefix `acme.tools` 只授權 pluginId 恰 `acme.tools` 或以 `acme.tools.` 開頭，不授權 `acme.toolset`。所有 binding 間 namespace 不重疊；`kobrixa` 第一段禁止第三方。root snapshot 可以縮小授權，不能超出 LocalBinding；擴大、跨 publisher 移轉須 core 帶外核准，不是更新包自動做的事。

### 8.2 Signed trust snapshot 的逐欄 schema

`SignedTrustSnapshot` = strict `{signed: TrustSnapshot, signatures: TrustSignature[]}`；signatures 1..2，按 keyId 升序、唯一。一般 snapshot 一個目前 root 簽署；root rotation transition 恰舊／新兩個 root。多出第三簽章不接受。

| TrustSnapshot 欄位（全部） | 提議型別／bounds                    | 語意                                                                                              |
| -------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------- |
| `formatVersion`／`kind`    | literal 1／literal `trust-snapshot` | 不與 package signature 域共用。                                                                   |
| `authorityId`              | Id                                  | 與 AuthorityState 相同。                                                                          |
| `sequence`                 | Positive                            | 從 1 起，每次恰 +1；離線 collection 須帶缺少的連續鏈。                                            |
| `previousSha256`           | Hash 或 null                        | sequence=1 iff null；其餘是前 snapshot.signed 的 C digest。                                       |
| `issuedAt`／`expiresAt`    | Time／Time                          | issuedAt<expiresAt；expiresAt-issuedAt ≤31536000 秒（365 日提議）；issuedAt 不得低於前 snapshot。 |
| `keys`                     | KeyRecord[]，1..1024                | 按 keyId 升序唯一；恰一個目前 root，rotation 過渡可有兩個；歷史 key 記錄不刪。                    |
| `publishers`               | PublisherRecord[]，0..1024          | 按 publisherId 升序唯一；僅能在 local binding 內。                                                |
| `rotations`                | Rotation[]，0..1024                 | 按 sequence 升序、唯一，歷史累積不可刪改。                                                        |
| `revocations`              | Revocation[]，0..4096               | 按 sequence 升序、唯一，歷史累積不可刪改。                                                        |

`KeyRecord` 全部欄位：

| 欄位                    | 型別／bounds                   | 條件                                                                                                                                                                  |
| ----------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `keyId`／`publicKey`    | KeyId／Hex32                   | 必須互相重算符合，嚴格 Ed25519 key。                                                                                                                                  |
| `algorithm`             | literal `Ed25519`              | 不做算法自動偵測。                                                                                                                                                    |
| `role`                  | `root`／`release`／`freshness` | 一個 key material 只一個 role，不以 alias 重用 root 作 release。                                                                                                      |
| `publisherId`           | Id 或 null                     | release 必 non-null；root／freshness 必 null。                                                                                                                        |
| `notBefore`／`notAfter` | Time／Time                     | notBefore<notAfter；驗證時必須在 `[notBefore,notAfter)`。                                                                                                             |
| `status`                | `active`／`retired`／`revoked` | active 可簽新目標；retired 不能認可新 install/update，但既有可信 receipt 可按 §8.5 使用；revoked 一律禁止。status 只能透過 rotation／revocation 推進，不能回 active。 |

`PublisherRecord` 全欄位：`publisherId: Id`、`displayName: Text`（≤200 bytes，無 controls）、`namespacePrefixes: Id[]`（1..32、排序唯一）、`releaseKeyIds: KeyId[]`（1..8、排序唯一）。每個 releaseKeyId 必存在、role=release、publisherId 相同；namespace 必為 local binding 的子集合。displayName 不做 identity lookup；任意 package 自填 publisher 姓名不能產生此 record。

`TrustSignature` 全欄位：`keyId: KeyId`、`algorithm: "Ed25519"`、`signature: ^[0-9a-f]{128}$`。沒有包內替代 key，按已信任根驗證。簽署 framing 提議如下；shape 與 package M 相同，但 domain 必不同：

```text
TrustSnapshot: ASCII("KOBRIXA-TRUST-SNAPSHOT") || 00 || U32BE(1) || U64BE(len(C(signed))) || C(signed)
Freshness:     ASCII("KOBRIXA-TRUST-FRESHNESS") || 00 || U32BE(1) || U64BE(len(C(signed))) || C(signed)
Rotation:      ASCII("KOBRIXA-TRUST-ROTATION") || 00 || U32BE(1) || U64BE(len(C(body))) || C(body)
```

包簽章不能驗作 snapshot，snapshot 簽章不能驗作 freshness。record 自己的 signature 欄位不放進自己的簽署 body；snapshot 的整體簽署包含 rotations 及其 proofs，沒有循環。

### 8.3 Key rotation、publisher transfer 與撤銷 records

`Rotation` = strict `{body: RotationBody, proofs: TrustSignature[]}`，proofs 恰 2 個、按 keyId 排序，必為 oldKeyId／newKeyId。root 的 snapshot signatures 另驗，不能用 proofs 代替外層授權。

| RotationBody 全欄位      | 提議型別／bounds               | 條件                                                                   |
| ------------------------ | ------------------------------ | ---------------------------------------------------------------------- |
| `sequence`               | Positive                       | authority 內 rotation 序列，首筆 1，每筆 +1。                          |
| `role`                   | `root`／`release`／`freshness` | old／new 的 role 相同。                                                |
| `publisherId`            | Id 或 null                     | release 為相同 publisher，其餘 null；不得藉 rotation 轉讓 publisher。  |
| `oldKeyId`／`newKeyId`   | KeyId／KeyId                   | 不相同；兩個 key 都存在，new 以前未使用；新 key fingerprint 重算相符。 |
| `effectiveAt`            | Time                           | 等於包含此 record 的 snapshot.issuedAt，禁止預約模糊切換。             |
| `previousSnapshotSha256` | Hash                           | 綁 transition 前的可信 snapshot，阻擋跨 authority／fork 重放。         |

正常 rotation 要舊／新 key 都證明持有私鑰，且目前 root 簽發新的 snapshot；root rotation 另要求**外層**舊 root 與新 root 雙簽，各按前／後 key set 驗證。old 轉 retired，new active，不默默擴 namespace／role／有效期。當 old key 已遺失／撤銷，不能偽造正常 rotation；要走重新帶外核對的 recovery bootstrap，保留先前 high-water／revocations 並記錄 core 明確 consent。該 recovery ceremony 的 UI／雙人核准要求未由現有 code 解決，屬 O3／O10 blocking review。

publisher transfer 不是 rotation：需 old publisher 的有效 release key、new publisher 的有效 release key、root 授權及本機 owner 核准；本版未定 transfer wire record，因此 **拒絕自動移轉**（`PKG_E_KEY_SCOPE`），不繼承資料／grants／installed identity。4C 需另作 explicit import，不能以同 pluginId 偷渡。

`Revocation` 全欄位如下；record 由包含它的 root-signed snapshot 授權，不接受 package 自稱 revoke 其他 publisher：

| 欄位       | 提議型別／bounds                         | 語意                                                                                   |
| ---------- | ---------------------------------------- | -------------------------------------------------------------------------------------- |
| `sequence` | Positive                                 | authority 內撤銷序列，首筆 1，每筆 +1。                                                |
| `issuedAt` | Time                                     | 等於首次包含它的 snapshot.issuedAt；收到且認證後立即生效，不依攻擊者選未來生效日延遲。 |
| `reason`   | `compromised`／`withdrawn`／`superseded` | 顯示分類，不改 fail-closed 規則。                                                      |
| `target`   | 以下 strict union                        | namespace／publisher 必須在 root 權限內。                                              |

target 的每個 branch **全部欄位**：

- key：`{kind: "key", keyId: KeyId}`；撤銷該 key 簽署的所有套件，不用自填 builtAt 宣稱早於事件。
- package：`{kind: "package", publisherId: Id, pluginId: Id, artifactSha256: Hash}`；命中整包 digest。為防重壓換 digest 規避，另支援下一 branch。
- integrity：`{kind: "integrity", publisherId: Id, pluginId: Id, integritySha256: Hash}`；同內容的不同 ZIP bytes 也撤銷。
- runtime：`{kind: "runtime", publisherId: Id, buildId: Token, artifactSha256: Hash}`；已安裝與 rollback 的 pins 都查。

同 target 不重複記錄；撤銷不能刪除、倒退、以 expiry 失效或被較新 package 解除。即使 snapshot 過期，**已知撤銷**仍有效。所有 root rotations 必須攜帶完整歷史撤銷；缺失 `PKG_E_TRUST_ROLLBACK`。若需撤回誤撤銷，只能另案核准新 key／new content，不設 hidden override。

### 8.4 Freshness 與 metadata replay

`SignedFreshness` = strict `{signed: Freshness, signature: TrustSignature}`；signature 的 key role 必為 freshness，key 屬同一 authority、仍有效且未撤銷。

| Freshness 全欄位                     | 型別／bounds                         | 條件                                                                                                    |
| ------------------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `formatVersion`／`kind`              | literal 1／literal `trust-freshness` | 不與 snapshot 混用。                                                                                    |
| `authorityId`                        | Id                                   | 與已信任 snapshot 相同。                                                                                |
| `sequence`                           | Positive                             | 嚴格遞增；重送相同 sequence 只接受完全相同 C digest，較低或同序不同 bytes 拒絕。                        |
| `snapshotSequence`／`snapshotSha256` | Positive／Hash                       | exact pin 目前 snapshot；不拼接舊 root 與新 freshness。                                                 |
| `issuedAt`／`expiresAt`              | Time／Time                           | issuedAt<expiresAt，TTL ≤2592000 秒（30 日提議）；issuedAt≥highestTrustedTime，且不晚於本機 wall time。 |

install／update 前 root snapshot、freshness 與 signing key 都必須有效；evaluationTime = max(currentWallTime, highestTrustedTime)。currentWallTime < lastObservedWallTime 或 < highestTrustedTime 回 `PKG_E_CLOCK_ROLLBACK`，不靠把時間設早延長 key 或 metadata 的期限。初次機器時鐘偏差只能由 core 明確修正後重試，不引入默許 tolerance。signed sequence／digest／trustedTime 更新與 trust snapshot 同一 durable commit；失敗 `PKG_E_TRUST_PERSIST`，不能只在 RAM 接受新根。

每個下載目標還需由 4E 受信任 channel target metadata 綁 artifact bytes／digest、identity／platform／integrity digest。這個 target index 的完整 wire schema、root threshold／TUF 等選型仍待 O10；本地離線單包可依 publisher signature 驗證，**不能聲稱已取得 channel anti-freeze／anti-rollback 完整保護**。未來 channel 未取得這個 contract 的驗收前，不開啟自動更新。

### 8.4.1 Trust import 的拒絕次序（S00 前置子流程）

此流程由 core 明確匯入／更新 trust 時執行，不接受插件 archive 觸發；只讀驗包使用最後 durable 的 snapshot。以下順序同屬提議 P08／O3、O10、O11，補足 S00 的 trust-specific codes：

1. 讀取本機 head／snapshot，驗 C、schema、digest／high-water 自洽；損壞 `PKG_E_TRUST_STORE`，I/O 失敗 `PKG_E_IO`。尚無設定時只可進 bootstrap ceremony，不能把任意首次包當 bootstrap。
2. 先以 4 MiB／array／JSON caps 讀取候選，容量錯誤 `PKG_E_TRUST_LIMIT`；候選的 encoding／JSON／duplicate／schema／C 錯誤沿 §6 S05 的專用 code，不做 silent repair。
3. 查 bootstrap 或目前 root 的 authority、key material、role 與 LocalBinding。keyId/publicKey 不符、跨 authority、namespace 擴張、roles 共用 key、freshness pin 不符均為 `PKG_E_TRUST_BINDING`。現有 key 的 material／role／publisher／notBefore／notAfter 不可原地改；需新 key＋rotation。未知 bootstrap 不自動接受。
4. 依**已信任**舊 root 驗候選 snapshot 簽章；一般失敗 `PKG_E_SIGNATURE`。root rotation 則按舊 root 與提議新 root 分別驗雙簽及 §8.3 proofs，缺簽／錯簽／跨 role／無證明的 status transition 一律 `PKG_E_TRUST_ROTATION`。歷史 retired root 只可核對已接納鏈，不能授權新 transition；已知 revoked root 只能走帶外 recovery。
5. 檢 sequence／previous digest／歷史 rotation 與 revocation prefix 不刪改；違反 `PKG_E_TRUST_ROLLBACK`。同 sequence 的完全相同 bytes 可冪等讀取，不延長 freshness／expiry；跳號拒絕，需先送齊中間鏈。驗證 rotation 的 effectiveAt 時 old/new key 均須有效；接納新 snapshot 時 root/key/current validity 也不得過期，不能只用回填的 issuedAt 通過。
6. 檢 wall time 回退（`PKG_E_CLOCK_ROLLBACK`）、snapshot／freshness issuedAt 不晚於 currentWallTime、有效期／key lifetime（`PKG_E_TRUST_EXPIRED`）；核對 freshness 簽章與 role（`PKG_E_SIGNATURE`／`PKG_E_TRUST_BINDING`）。已知撤銷優先於任何 stale 例外，命中 `PKG_E_REVOKED`。尚未認證的遠端 issuedAt 不能推進可信時間。
7. 在單 writer 下原子持久化 snapshot／bindings 的核准縮限／high-water／最高時間／revision；失敗 `PKG_E_TRUST_PERSIST`，重讀 reconcile 後才可使用新狀態。lastObservedWallTime 每次成功 trust 使用也只能單調推進；重啟不可回落。沒有 durable 保證就保留舊狀態並拒絕新 install/update。

本機儲存與系統時鐘都可被同使用者的未沙箱惡意程序破壞；此契約只能偵測留存 high-water 的重放／倒退，不宣稱抵抗整個 profile 與 OS clock 同時被還原的攻擊。O10 若要求硬體 monotonic counter 或外部 trusted time，必須另加可驗平台 adapter 與 gate。

### 8.5 離線、啟用與 trust 變更

| 情境                                                                                 | 提議結果                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新 install／update，未命中已知撤銷，全部 signature／metadata／key 有效且完整 closure | 可以成為 VerifiedCandidate；尚待 consent／4C。離線不代表知道最新撤銷，必須顯示 freshness 期限。                                                                                                         |
| 新 install／update，freshness／snapshot／key 過期                                    | `PKG_E_TRUST_EXPIRED`，不進交易；不能以 package builtAt 回推可信簽署時間。                                                                                                                              |
| 已安裝 trusted-local、未命中已知撤銷，但 metadata 過期或 key 正常 retired            | 只可使用 host 之前 durable 記錄的完整 artifact／integrity／key／trust receipt，重驗內容與簽章；顯示 stale，保留原 disabled／safe-mode／grants。這不允許第一次安裝舊包或替換 bytes。receipt 不足即拒絕。 |
| key／package／integrity／runtime 已知撤銷                                            | install、update、enable、rollback 均拒絕；活躍 process 先封 admission，走既有 stop／drain／terminate，保留 recovery／資料，不能直接刪資料或謊報設備已停。                                               |
| trust snapshot 在驗包／consent／commit 之間改變                                      | 舊 candidate 回 `PKG_E_TRUST_CHANGED`，重驗；不能把之前的成功 boolean 帶過 consequential await。                                                                                                        |
| local store unreadable／missing historical state                                     | `PKG_E_TRUST_STORE`；保留原資料、停用待恢復，不自動以空白 trust store 重設 high-water。                                                                                                                 |
| clock rollback                                                                       | install/update 拒絕；已安裝者只按前列 receipt policy，仍不可越過 known-revoked／safe-mode。修復時鐘不會自動啟用插件。                                                                                   |

## 9. 編號負例矩陣與固定錯誤對應

**全部提議 P10（O1、O4、O12），每列測被引用 P02–P09 的契約及其 owner。** 除刻意損壞處以外，各 fixture 必須合法；具有多個錯誤時依 §6 的早拒絕次序，不把不同 frontier 當 flaky test。每列都斷言「沒有 entry 執行、沒有 contribution delivery、沒有 active head／grants／資料異動」，包含拒絕後延遲 chunk／callback。以下的期望全是未執行測試計畫。

| ID  | 負例（提議）                                                                                          | 期望錯誤／frontier                                                                                       | 契約     |
| --- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------- |
| N01 | `../x`、`payload/../../x`、`.`、空段、尾 slash                                                        | `PKG_E_PATH` S03                                                                                         | P02      |
| N02 | `/etc/x`、`C:/x`、UNC、`\\?\\`、backslash、NUL、ADS `x:y`、percent-encoded traversal                  | `PKG_E_PATH` S03                                                                                         | P02      |
| N03 | `con.txt`／COM1、尾 dot／space、segment 65 bytes、path 241 bytes、depth 17                            | `PKG_E_PATH` S03                                                                                         | P02      |
| N04 | 非法 UTF-8／overlong／truncated scalar filename                                                       | `PKG_E_ENCODING` S03                                                                                     | P02      |
| N05 | Unicode NFC `é`／NFD `e+U+0301` 同時或單獨出現；全形 slash                                            | `PKG_E_PATH` S03（ASCII subset，正規化前拒絕）                                                           | P02      |
| N06 | `payload/A.txt` 與 `payload/a.txt`；`payload/A/x` 與 `payload/a/y`                                    | `PKG_E_PATH_COLLISION` S03                                                                               | P02      |
| N07 | byte-identical duplicate local entry，或 integrity 重複 path                                          | `PKG_E_DUPLICATE_ENTRY` S03／S05 的 path-set 檢查                                                        | P02      |
| N08 | 一個 entry 為 `payload/a`，另一為 `payload/a/b`                                                       | `PKG_E_PATH_COLLISION` S03                                                                               | P02      |
| N09 | 第七筆起不按 path 排序、控制檔交換、central 次序與 local 不同                                         | local：`PKG_E_ENTRY_ORDER` S03；central：`PKG_E_ZIP_STRUCTURE` S09                                       | P02      |
| N10 | 額外 root 檔、未列名 payload、第二簽章、nested archive 副檔名                                         | `PKG_E_ENTRY_SET` S03／S07                                                                               | P02、P04 |
| N11 | 少 license、少 manifest 或任一 signed file；聲稱 integral 檔集合含自身                                | `PKG_E_ENTRY_SET` S05／S09                                                                               | P02、P04 |
| N12 | ZIP64 sentinel／record、multi-disk、加密、descriptor flag、未知 method、extra field／comment          | `PKG_E_ZIP_FEATURE` S02／S09                                                                             | P02      |
| N13 | symlink／device／socket／FIFO／directory type、reparse attributes                                     | `PKG_E_FILE_TYPE` S09；目標 FS reparse 為 `PKG_E_STAGING_UNSAFE` S12                                     | P02、P05 |
| N14 | setuid／setgid／sticky、mode 非 420/493、ZIP 與 signed mode 不同                                      | signed value：`PKG_E_SCHEMA` S05；central：`PKG_E_MODE` S09                                              | P02、P03 |
| N15 | 偽造小 declared size、實際超 64 MiB／metadata cap                                                     | `PKG_E_FILE_LIMIT` S04；未超 cap 但 size 不符為 `PKG_E_SIZE`                                             | P02、P05 |
| N16 | 整包 128 MiB+1、expanded 512 MiB+1、第 20,001 檔                                                      | `PKG_E_ARCHIVE_LIMIT` S01／`PKG_E_EXPANDED_LIMIT` S02/S04／`PKG_E_FILE_LIMIT` S02                        | P02、P05 |
| N17 | 單檔或總體 ratio >100、非空/0、以 padding 增大分母                                                    | `PKG_E_RATIO` S02/S04；unused compressed bytes 為 `PKG_E_DEFLATE`                                        | P02、P05 |
| N18 | DEFLATE 無結尾、invalid back-reference、concat streams、非零 unused bits                              | `PKG_E_DEFLATE` S04；輸入 extent 尚未收齊即 EOF 為 `PKG_E_ZIP_TRUNCATED`                                 | P02、P05 |
| N19 | header、file data、central、EOCD 每個 byte boundary 截斷                                              | `PKG_E_ZIP_TRUNCATED` S01/S09；完整但無效 stream 依 N18                                                  | P05      |
| N20 | SFX prefix、records 間 gap／overlap／offset wrap、EOCD count／directory size 不符、trailer／第二 EOCD | `PKG_E_ZIP_STRUCTURE` S02/S09                                                                            | P02、P05 |
| N21 | local／central name、CRC、size、flags、method、offset 任一不同                                        | `PKG_E_ZIP_STRUCTURE` S09；payload 本身 CRC 壞則先 `PKG_E_CRC` S04                                       | P02、P05 |
| N22 | data CRC 錯但 SHA 正確；CRC 正確但 signed SHA 錯                                                      | `PKG_E_CRC` S04；`PKG_E_HASH` S07                                                                        | P04、P05 |
| N23 | JSON BOM、invalid UTF-8、lone surrogate、trailing token                                               | UTF-8／BOM：`PKG_E_ENCODING`；其餘 `PKG_E_JSON` S05/S08                                                  | P03、P04 |
| N24 | duplicate JSON keys、escaped key alias、prototype-shaped unknown field                                | duplicate：`PKG_E_JSON_DUPLICATE_KEY`；未知欄位：`PKG_E_UNKNOWN_FIELD` S05/S08                           | P03、P04 |
| N25 | 新 object 任一層多欄位、missing required、wrong type／null／bool-as-int、超欄位 bounds                | unknown：`PKG_E_UNKNOWN_FIELD`；其他 `PKG_E_SCHEMA` S05/S08                                              | P03      |
| N26 | `-0`／`1.0`／`1e0`／超 U53／深度 33／string 4097 bytes／object 65 keys                                | number domain：`PKG_E_JSON`；資源 cap：`PKG_E_JSON_LIMIT` S05/S08                                        | P03、P04 |
| N27 | 控制檔 key order、空白、尾 LF、`\n` 短 escape、escaped slash／Unicode 的非 C 表示                     | `PKG_E_CANONICAL` S05/S08；manifest 原始合法空白不屬此錯誤                                               | P04      |
| N28 | formatVersion=2、minimum installer 超 host、metadata 與 manifest ID/version 不符                      | `PKG_E_FORMAT` S05/S08／`PKG_E_INSTALLER` S08／`PKG_E_BINDING` S08                                       | P03      |
| N29 | algorithm=none／HS256／Ed25519ph／大小寫 alias，hash=sha512                                           | `PKG_E_ALGORITHM` S05；不選其他 verifier                                                                 | P04      |
| N30 | signature 63/65 bytes、hex 大寫／DER/base64、envelope 新增 inline key                                 | `PKG_E_SCHEMA` 或 `PKG_E_UNKNOWN_FIELD` S05                                                              | P03、P04 |
| N31 | 換 envelope keyId／publisher／integrity digest；把另一 key 的 signature 放入                          | binding 不符：`PKG_E_BINDING` S05；綁定正確但密碼學不符：`PKG_E_SIGNATURE` S06                           | P04、P08 |
| N32 | 對 H(M)／H(I)／hex 而非 M 簽名；domain NUL 改 LF、長度 little-endian、跨 trust domain 重放            | `PKG_E_SIGNATURE` S06                                                                                    | P04      |
| N33 | noncanonical／small-order A 或 R、S≥L、signature 任一 bit tamper                                      | `PKG_E_SIGNATURE` S06；trust key 本身非法先 `PKG_E_TRUST_STORE` S00                                      | P04、P08 |
| N34 | 包內自簽 key、未知 keyId、已知 key 但錯 role／publisher／namespace、第三方 kobrixa ID                 | `PKG_E_KEY_UNKNOWN`／`PKG_E_KEY_SCOPE` S06                                                               | P08      |
| N35 | key expired、snapshot／freshness expired／missing、時鐘倒退                                           | `PKG_E_TRUST_EXPIRED` S06；trust 前置時鐘檢查 `PKG_E_CLOCK_ROLLBACK` S00                                 | P08      |
| N36 | known revoked key／package digest／integrity digest／runtime，嘗試 rollback 或重新壓縮                | `PKG_E_REVOKED` S06/S10/S11；active graph 交 lifecycle，不直接刪除                                       | P08      |
| N37 | trust sequence 降低／跳號、同序不同 bytes、previous hash 錯、刪除歷史 revocation                      | `PKG_E_TRUST_ROLLBACK`，trust import 前置，S00                                                           | P08      |
| N38 | rotation 缺 old/new proof、跨 role、外層 root 單簽換 root、繞過帶外 bootstrap                         | `PKG_E_TRUST_ROTATION`，trust import 前置，S00                                                           | P08      |
| N39 | freshness pin 舊 snapshot／wrong authority；缺 role 分離／binding overlap                             | `PKG_E_TRUST_BINDING`，trust import 前置，S00                                                            | P08      |
| N40 | wrong arch／不支援 OS、最低 OS 高於 host、libc family 不同／probe unknown、Rosetta fallback           | `PKG_E_PLATFORM` S10                                                                                     | P06      |
| N41 | wrong Electron ABI／native ABI／CPython build／runtime digest、Node addon／native kind 未 admission   | `PKG_E_ABI` S10 或 `PKG_E_RUNTIME` S08/S11                                                               | P06      |
| N42 | any 帶 native executable／不合法 platform null 組合；同順位兩個 variant                               | schema：`PKG_E_SCHEMA` S08；native：`PKG_E_PLATFORM` S10；候選歧義：`PKG_E_VARIANT_AMBIGUOUS` S11        | P03、P06 |
| N43 | API 不滿足、preview 未 opt-in、宣稱不存在 sandbox profile                                             | `PKG_E_API`／`PKG_E_POLICY` S10；未知 executionPolicy 在 S08 即 `PKG_E_POLICY`                           | P03、P06 |
| N44 | external provider/compiler/language service、自稱 builtin、entry 不在 signed set 或跨 variant         | `PKG_E_MANIFEST_POLICY`／`PKG_E_REFERENCE` S08                                                           | P03      |
| N45 | dependency 改 publisher／floating range／required omission／lock root 含自身 artifact hash            | `PKG_E_SCHEMA`（錯 shape/range）；`PKG_E_LOCK` S08/S11（跨欄位）                                         | P07      |
| N46 | cycle、129 plugins／depth 17、unreachable node／子包 lock 不一致／多版                                | `PKG_E_DEPENDENCY_CYCLE`／`PKG_E_DEPENDENCY_LIMIT`／`PKG_E_LOCK` S11                                     | P07      |
| N47 | offline closure 缺必要 plugin/runtime；provider 同 language/target conflict                           | `PKG_E_CLOSURE_MISSING`／`PKG_E_PROVIDER_CONFLICT` S11                                                   | P07      |
| N48 | storage writable 不在 readable、migration hash 不符／未 admission executor                            | `PKG_E_SCHEMA`（區間）；`PKG_E_MIGRATION` S08                                                            | P09      |
| N49 | signed channel 下載 target 的 bytes/digest 與 ZIP 不符                                                | `PKG_E_ARTIFACT` S10                                                                                     | P04、P08 |
| N50 | quarantine parent rename／leaf link replacement／既有 hardlink／reparse／不支援安全 open              | `PKG_E_STAGING_UNSAFE`／`PKG_E_TOCTOU` S00/S12                                                           | P05      |
| N51 | disk-full、short-write、read error、取消、120 秒耗盡；仍有晚到 chunks                                 | `PKG_E_IO`／`PKG_E_CANCELLED`／`PKG_E_TIMEOUT`，實際 frontier 記錄；不產生 receipt                       | P05      |
| N52 | 驗證後 trust revision 改變；trust durable commit 失敗／容量滿／store 損壞                             | `PKG_E_TRUST_CHANGED` S12；import 為 `PKG_E_TRUST_PERSIST`／`PKG_E_TRUST_LIMIT`／`PKG_E_TRUST_STORE` S00 | P08      |

所有 size/count/ratio/deadline 另驗 `limit-1`、`limit`、`limit+1`，含空檔、20,000 個零長合法 files、metadata 正好 cap、path 正好 240 bytes。邊界正例必須同時符合其他 bounds，不以「檔數未超但 integrity 先超限」當作檔數正例。trust 過期邊界為 now<expiresAt 有效、now=expiresAt 無效；撤銷一經認證持久接受，任何 later enable 都不能用過去的驗證成功。

## 10. 驗收表與後續 native handoff

**全部提議 P10（O1、O4、O12）。** 每列結果需記 source commit、artifact／fixture digest、OS／arch、validator／crypto library／packer 版本、命令、完整 outcome、觀察人與限制。規格審查完成、文字 formatter 通過，不會使 runtime acceptance 變 PASS。

| Row    | 提議 acceptance criterion                                                                  | 所需證據                                                                        | 本文狀態                               |
| ------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | -------------------------------------- |
| 4A-A01 | O1–O12 具名裁決、Stage 3 entry gate 完成；未決 choice 不被實作當預設批准                   | owner record、S3 merge／完整 gate ledger                                        | 待裁決；未核准                         |
| 4A-A02 | 四份控制文件及所有 nested object 的 required／bounds／unknown policy 可產生 strict schemas | Schema review、TS／committed JSON Schema parity；既有 API Schema 不倒退         | NOT RUN                                |
| 4A-A03 | V01–V08 的 hex／length／SHA-256 一致，另有完整合法 signed archive vector                   | 至少兩語言獨立 canonicalizer／verifier；合法與非法 crypto vectors               | 只有本文示例算術核對；實作驗收 NOT RUN |
| 4A-A04 | N01–N33 archive／path／parser／signature 負例在任意 chunk 切分一致                         | unit、property/fuzz、每個 truncated boundary；caps 不先 allocate 後拒絕         | NOT RUN                                |
| 4A-A05 | N34–N39／N52 bootstrap、roles、rotation、revocation、freshness 不可繞過                    | 固定 test keys、clock、連續 metadata chain、lost-ack／reopen tests              | NOT RUN                                |
| 4A-A06 | N40–N47 platform／variant／lock 精確選擇、cycle／conflict fail closed                      | 三平台 facts fixtures、跨語言 Range fixtures、dependency closure oracles        | NOT RUN                                |
| 4A-A07 | storage declarations 不授權 migration，錯誤／不可逆保留原資料                              | 4C shadow-generation model／rollback contract review；既有 quota 不變           | NOT RUN                                |
| 4A-A08 | 格式最大合法包、caps ±1、壓縮炸彈不越界；120 秒預算在代表性 host 可用                      | 實際 RSS／CPU／I/O 記錄、worker termination；數值在核准前凍結，不能事後放寬     | NOT RUN                                |
| 4A-A09 | Windows／macOS／Linux path alias、hardlink／reparse／parent-swap 安全 adapter              | 真實 filesystem race fixtures、no-follow primitives；不能只 mock denied         | NOT RUN                                |
| 4A-A10 | 一份 canonical package 在三平台得到相同 bytes/hash/signature／errors                       | macOS arm64、Windows x64、Linux x64 receipts；不靠 OS 解壓器寬容差異            | NOT RUN                                |
| 4A-A11 | packer 兩個乾淨 build 可重現 unsigned payload／integrity／ZIP，signing差異可追溯           | pinned toolchain、lock、source／artifact digests；不使用修改後 fixture 自證     | NOT RUN                                |
| 4A-A12 | 已安裝版 stale/retired 例外僅用舊 durable receipt，known-revoked 永遠停用                  | offline install/update/enable/rollback matrix、clock rollback、safe mode        | NOT RUN                                |
| 4A-A13 | validator 不 import desktop、不執行 hooks、不自授 source／permissions                      | import-boundary／side-effect unit tests、既有 registry policy regression        | NOT RUN                                |
| 4A-A14 | 4A→4C/D/E ports 完整；runtime／channel 不存在不報 Installable                              | 未知 runtime／缺 closure／未知 ABI 的 end-to-end rejection；明示 NOT RUN domain | NOT RUN                                |
| 4A-A15 | 原 Stage 3 budgets、hardware／installed／manual gates 無降級                               | 同 candidate 的 S3/native receipts；4F 另列正式包回歸                           | NOT RUN（本文不核銷）                  |

### 10.1 本次規劃的檢查與限制

只新增本文件；不修改產品碼、schema、測試 fixture、evidence 或 git index。已有程式缺少 package/trust 契約是本次規劃要填補的缺口，**不是已定位或修復任何 CI 失敗的 root cause**。沒有執行 Electron、localhost listener、native／installed／hardware 測試。文件中的未驗列保持 NOT RUN。

本文件的本機檢查命令：

```sh
node node_modules/prettier/bin/prettier.cjs --write docs/superpowers/specs/2026-11-12-plugin-system-4a-package-format-design.md
node node_modules/prettier/bin/prettier.cjs --check docs/superpowers/specs/2026-11-12-plugin-system-4a-package-format-design.md
node node_modules/eslint/bin/eslint.js docs/superpowers/specs/2026-11-12-plugin-system-4a-package-format-design.md
```

本次實際結果：Prettier write／check 均 exit 0，check 回 `All matched files use Prettier code style!`。ESLint exit 0、0 errors／1 warning：`File ignored because no matching configuration was supplied`；因此為 **not applicable／未 lint Markdown**，不是 lint 通過。另以 `node --input-type=module` 的 inline 檢查從抽象值重建 9 組 vectors（V05 分 a/b），精確 bytes、長度、SHA-256 與 framing 全相符；相對檔案連結均存在，52 組負例／15 列 acceptance 編號唯一。這是文件算術／結構檢查，不是產品 validator、跨語言 conformance 或 native 驗收，不新增產品 unit test 來冒充尚不存在的 parser 行為。

### 10.2 Orchestrator 尚須執行

下列是既有 Stage 3 entry-gate native commands（**本次全部 NOT RUN**），先由 orchestrator 建置並固定同一 candidate、準備真實 runner inputs；它們不能代替新的 4A acceptance。部分 wrapper 可能產生自己的輸出，須在 orchestrator 的授權環境執行。

```sh
node tests/desktop/stage-3-closeout-run.mjs motor --run
node tests/desktop/stage-3-closeout-run.mjs lab --run
node tests/desktop/stage-3-closeout-run.mjs device --run
node tests/desktop/stage-3-closeout-run.mjs installed --run
node tests/desktop/stage-3-closeout-run.mjs b2 --run
node tests/desktop/run-smoke.mjs
node tests/desktop/declarative-ui-motion-run.mjs --load
```

Lab／device 需真實 Python、B2 需真正的 persistence／single-instance receipts；不能製造 placeholders。USB／Wi-Fi hardware、人工 accessibility／consent、Windows journal／durability 另依各 stage 程序實測。4A validator／native race runner 尚不存在，因此本文不虛構可執行命令；O12 核准實作計畫時，須為 4A-A03–A14 配置實際 binary／test path 與三平台命令，未配置前維持 NOT RUN。

## 11. 從現有程式無法定案的問題與阻擋條件

所有問題均為待 owner 裁決，沒有以本草案取代批准。若採不同方案，須同步更新 P 編號、schema、vectors、error matrix 與 acceptance；不能只改 implementation 來接受原本拒絕的包。

| Question | 未定事項／本草案暫提案                                                                                                                                              | 決策 owner／影響                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Q01      | Stage 3 全部 gate／R1／R2／H1–H6 是否已完成且合併？本文無足夠證據認定。                                                                                             | O1／O12；阻擋實作進場與交付宣稱。                                                 |
| Q02      | 是否接受 ASCII-only paths、固定 ZIP headers、控制檔前置與 no-extra profile？native vendor／license 檔名若不符須由建置端合法重排，不放寬 extraction。                | O2／O4；需要代表性最大 JS／Python／native bundle。                                |
| Q03      | `.kobrixa-runtime` 的 supplier、CPython fullVersion/buildId、ABI catalog、license／patch 維護期限；Python 一 concrete variant 一包是否接受？                        | O5／O7；無 runtime admission 前不能 install Python 正式包。                       |
| Q04      | 三平台 minimum OS／Linux distro+libc baseline、host Node/Electron ABI release matrix、native stdio binary/OS signing 規則？                                         | O5／O7／O12；目前 archive.mjs 只證實 binary architecture checks，不證實最低 OS。  |
| Q05      | Key bootstrap fingerprint 如何配送／核對、namespace 分配者是誰、root key custody／threshold、遺失 key recovery／publisher transfer ceremony？                       | O3；本草案的一般 root 單簽＋rotation 雙簽須 security review。                     |
| Q06      | 採成熟 update metadata framework 或本節最小方案？channel target/index schema、root／freshness TTL 365/30 日、offline stale receipt policy 是否接受？                | O10；本文不提供完整 channel security 的完成宣稱。                                 |
| Q07      | 128/512 MiB、20,000 entries、100:1、JSON bounds、120 秒 validator 預算與 memory peak 是否容納合法最大樣本？                                                         | O4；核准前量測，可選更嚴格設計，不能用失敗後調 threshold 取得 pass。              |
| Q08      | 各 OS directory capability／exclusive-create／reparse／TOCTOU adapter 可否實作與驗證？package head 的 durable commit、8 GiB cache、current+previous pins 如何保證？ | O11；builtin snapshot 不是充分證據，平台缺原語即拒絕。                            |
| Q09      | Migration declarative/process grammar、10 秒／64 MiB 新上限與舊 quotas 的交集、rollback receipt／shadow generation 如何對接？                                       | O8／O11；本草案只凍結候選 descriptor，未實作 executor 一律不跑。                  |
| Q10      | preview dependency 是否需 exact prerelease range、dependency 子包 lock 不同 closure 的作者 workflow？                                                               | O9；本版 Range 拒絕 prerelease target，不能用完整 semver library 的額外能力偷擴。 |
| Q11      | 是否接受最小 SBOM inventory，或改成受限 SPDX／CycloneDX profile？未知欄位及 size policy 要一起變更。                                                                | O2／O9／O12；scanner／license review 不能由 inventory parser 取代。               |
| Q12      | Package schema 要獨立 `$id`／format version 還是納入現有 protocol export？本草案建議獨立 package schema namespace，manifest 繼續引用 committed API definitions。    | O2／O7／O12；不得把尚未實作 native runtime 塞入現有 API 1.8 並宣稱相容。          |
| Q13      | trusted-local 首發或三平台強制 sandbox？目前提議前者；若改後者要新增 blocking OS proof 與 executionPolicy strict branch。                                           | O6；不能宣稱簽章保證 code 安全，不能靜默降級。                                    |

本文只有待審查的契約與測試期望；上述 owner record、完整 signed package fixture、跨語言驗證、native receipts 與所有 Stage 3 entry gates 都需另取得真實結果。
