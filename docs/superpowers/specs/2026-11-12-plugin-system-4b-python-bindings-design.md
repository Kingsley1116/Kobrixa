# Stage 4B：由 JSON Schema 產生 Python bindings 設計提案

日期：2026-11-12。狀態：**PROPOSAL／未核准／未實作／未交付**。本文只有規劃；下述新增檔案、介面、命令與驗收均為提案，不是既有功能或通過證據。

## 1. 基準、範圍與進場關卡

承接 [Stage 4 packaging proposal §7](2026-11-11-plugin-system-stage-4-packaging-proposal.md#7-由-committed-json-schema-產生-python-bindings)。Stage 3 必要驗收完成並合併至 `feat/plugin-system`、Stage 4 提案核准、4A 版本與 generator contract 凍結後，才開始實作 4B。本文不核銷 Stage 3 失敗或未執行項目，也不授權發布。

唯一 wire 型別來源是已提交的 [`plugin-protocol.schema.json`](../../../packages/plugin-protocol/schema/plugin-protocol.schema.json)。[`keywords.json`](../../../packages/plugin-protocol/schema/keywords.json) 是 generator 支援能力的共同清單，不另造 wire schema。目標是 stdlib-only generator、Python 3.10+ 型別與薄 async facade、可安裝的 typed wheel，以及完整 drift／conformance／相容性關卡。Python distribution version 與 protocol API version 分開管理。

不在本階段改寫 transport、設備安全、事件生命週期、runtime 管理、安裝交易或現有 dict API；不將 type hints 宣稱為 runtime validator，也不開放任何原先不允許的 provider。

## 2. 已讀實物與量測基線

以下是本次讀取工作樹的實測，並非最新 pushed commit 或整個並行工作樹的驗收。Schema 為 draft-2020-12，`$id` 為 `https://kobrixa.com/schemas/plugin-protocol/1.8.0.json`。原始檔案 **10,459,664 bytes**；SHA-256：

```text
a7b63d8c6c8b6aac81bd512ce2091d200af6dddb955090e848126e9f49183c67
```

計數只走 schema 節點：`$defs`／`properties` 的值、`items`／`additionalProperties`／`propertyNames`／`not`，以及 `anyOf`／`oneOf`／`prefixItems` 的成員；不把 property 名稱或 enum 值當關鍵字。重複 inline 結構每次出現都計數，沒有先 dedup。

| 實測項目         | 結果與意義                                                                                                                                                                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$defs`          | **173**；未帶版本尾碼的 `.params` 73、`.result` 70；版本化定義 19；獨立定義 11。73／70 是 schema 命名分類，不是 outbound 方法數。                                                                                                             |
| 版本化定義       | `.v1.params/result` 16 個：`ui/negotiate`、`ui/ready`、`command/invoke`、`ui/instances`、`ui/state`、`ui/patch`、`ui/subscribe`、`ui/snapshot` 各一對；`.v170` 3 個：`events/deliver.v170.params` 與 `devices/subscribe.v170.params/result`。 |
| 完整頂層結構去重 | 對每個 definition 做遞迴 key 排序的 canonical JSON、保留 array 順序，可得 **131** 個不同結構、**25** 組重複群，共可共用 42 份頂層實作。這不是最終產生類別數；nested 型別仍需另量測。                                                          |
| 關鍵字           | allowlist **25** 個，實際使用也是 **25** 個；`$ref` **0**。不得因沒有 references 就假設未來也沒有。                                                                                                                                           |
| 物件             | `type: object` 7,092 處；`additionalProperties: false` 7,034 處，其餘 58 處為 schema（含 `{}`）；其中 14 處同時有固定 properties 與開放額外鍵。                                                                                               |
| Union            | `anyOf` **3,008** 處；分支數 2／3／4／5／6／14／19 的出現數依序為 1,216／639／1,141／8／2／1／1。`oneOf` **16** 處。                                                                                                                          |
| Tuple 形狀       | `prefixItems` **28** 處，長度 0／1／2／4 分別出現 5／9／12／2 次；全部搭配 `items: false`。                                                                                                                                                   |
| 不可能值         | `not: {}` **2** 處，位於 manifest 舊式 command 的 `invocation` 與 `arguments`。Boolean schema `false` **7,062** 處＝7,034 個封閉物件＋28 個禁止 tuple 尾項；`true` 0 處。空 schema `{}` 19 處，含兩個 `not` 的 operand。                      |
| type 陣列        | `['number', 'null']` 28 處、`['boolean', 'number', 'string']` 8 處。其餘為單一 type。                                                                                                                                                         |
| Literal          | `const` 1,950 處：string 1,442、boolean 338、integer-valued JSON number 170；`enum` 5,788 處。                                                                                                                                                |
| 共用 cases       | [`cases.json`](../../../packages/plugin-protocol/conformance/cases.json) **347** 筆：191 valid、156 invalid，僅 **11** 個不同 definition；不是 173 個定義的全面覆蓋。`$repeat` 是 fixture 展開語法，不是 schema keyword。                     |

16 個 `oneOf` 的實際形狀如下；同一 recovery 結構 inline 出現仍分別列計。

| 所在定義／路徑                                                                                                                                                                           | 分支數        | 可供 narrowing 的欄位                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | --------------------------------------------- |
| `connection-recovery-snapshot.recovery`、`devices/subscribe.result` 的 snapshot recovery、`devices/connectionRecovery/read.result` 的 recovery、`events/deliver.params` 的 recovery data | 各 8，共 4 處 | `phase`                                       |
| `events/deliver.v170.params`／`events/deliver.params`                                                                                                                                    | 16／17        | `kind`，並保留 `version`／`delivery` literals |
| `devices/subscribe.v170.params`／`devices/subscribe.params`                                                                                                                              | 6／7          | `topic`；新形狀多 `connectionRecovery`        |
| `settings-resource-v1.fields.items`                                                                                                                                                      | 5             | `type`                                        |
| `ui-resource-v2` 的 datasets value、`ui/dataBegin.params.header`、`ui/dataChunk.params.chunk`                                                                                            | 各 4，共 3 處 | `kind`                                        |
| `manifest.runtime`                                                                                                                                                                       | 4             | `kind`，含開放物件分支                        |
| `storage/beginWrite.params.target`、`devices/connect.params.target`                                                                                                                      | 各 2          | `mode`／`kind`                                |
| `devices/motion/prepare.params.motion`                                                                                                                                                   | 3             | `mode`                                        |

現有 [`json-schema.test.ts`](../../../packages/plugin-protocol/src/json-schema.test.ts) 已比對 Zod serializer 與兩份 committed schema、限制 keywords／patterns，並檢查每個 request／notification 的 definition。部分測試名稱仍寫 1.7，實際 assertion 是 1.8.0；不可由標題推斷契約版本。現有 [`conformance.test.ts`](../../../packages/plugin-protocol/src/conformance.test.ts) 與 [`test_conformance.py`](../../../sdks/python/tests/test_conformance.py) 同讀 cases，另有 settings/storage fixtures 與 domain checks，均須保留。

[`_schema.py`](../../../sdks/python/kobrixa/_schema.py) 的 `Validator.bundled()` 共享 immutable schema cache，執行結構與 device／persistence／recovery semantics；[`_plugin.py`](../../../sdks/python/kobrixa/_plugin.py) 在 `_validate_ui` 根據協商選 `.v1`／`.v170`，並在 `_request` 維持 deep copy、timeout、cancel、pending 清理與 epoch 檢查。這些行為不是 `$defs` 能產生的內容。

[`pyproject.toml`](../../../sdks/python/pyproject.toml) 現為 `kobrixa-plugin-sdk` 0.1.0、Python ≥3.10、`dependencies = []`，build backend 為 setuptools ≥68；package-data 目前只列 schema。沒有據此宣稱已交付 `py.typed` 或 generated bindings。

## 3. Generator 架構提案

提議新增 `sdks/python/tools/generate_bindings.py`，只使用 `json`、`hashlib`、`pathlib`、`argparse`、`keyword` 等 stdlib。開發用 type checker／build backend 可是固定版本的工具相依，但不得進入 generator 或 wheel 的 runtime dependencies。不 import Zod、不抓網路、不 import SDK 啟動 transport，也不在 wheel 安裝時生成。

流程為 **讀取／檢查 → deterministic IR → dedup／命名 → render／check**：

1. 讀取 committed schema 原始 bytes、allowlist 與受審查的 method metadata；拒絕重複 JSON keys、非有限 JSON number、未知 keyword、dangling metadata、unsupported 組合。關鍵字必須同時在 allowlist 與 generator implementation 中；擴充 allowlist 本身不能讓 generator 放行。錯誤帶 JSON Pointer，不輸出半套檔案。
2. IR 節點至少含 `kind`、原始 schema pointer、constraints、requiredness、extra-key policy、ordered alternatives／prefix、discriminator candidates、wire definition identity。分開保存「原始 schema 語意」與「靜態可表示部分」，每個刻意寬化都有固定 reason code，不能悄悄落成 `Any`。
3. 以完整 schema canonical JSON 的 UTF-8 bytes 作 SHA-256 結構指紋。object keys 按 Unicode code point 排序、array 保留順序；不以 float 轉換數值，不把 `true` 與 `1` 合併。不只按 Python annotation 去重：`str` 的不同 pattern／bounds 必須仍有不同 schema identity。碰到 digest 相同時再比 bytes，不假設無碰撞。
4. 以穩定排序產生 DAG、共用 nested nodes、公開 aliases、facade 與 inventory。所有來源 pointer 均可反查 IR／輸出 symbol。輸出 UTF-8、LF、固定縮排／末尾 newline；不含時間、絕對路徑、OS 或 locale。schema 不含 `$ref`，目前不需解 reference；未來若出現則明確失敗並另審 IR 擴充。
5. `--check` 只在記憶體比較預期內容與 committed 檔案，不寫回；一般 generation 須先完成全部 rendering／驗證才更新指定輸出集合。任意漏檔、多出舊生成檔、header／bytes／inventory 不同均失敗。CI 不自動修復 diff。

提議命令（**尚未實作**）：

```sh
python3 sdks/python/tools/generate_bindings.py --check
```

需額外測試交換 input object key order 不改 IR／symbols；原始 schema digest 仍忠實反映 bytes 改變。連續兩次相同 bytes 輸入則所有輸出必須 byte-identical。產物大小、生成時間與 type-check 時間應量測記錄，事前審定新增預算，不改既有性能門檻。

## 4. 實際 JSON Schema 到 Python 3.10 的映射提案

以下涵蓋全部 25 個實際 keywords，以及 boolean／empty schema。表中的 occurrence 數是 §2 遍歷結果；「runtime」表示必須保留驗證，不是忽略該 constraint。使用 `typing.TypeAlias`、`TypedDict`、`Literal`、`Union`、`NoReturn`；不用 Python 3.11 才有的 `NotRequired`／`Never` 或第三方 `typing_extensions`。

| 構造（出現數）                                                 | Python 輸出／規則                                                                                                                                                   | 無法靜態完整表達的部分                                                                                            |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `$schema`／`$id`／`title`／`$defs`（各 1）                     | 文件 metadata、header 與 definition→alias 表；不是 payload fields                                                                                                   | dialect／API 身分由 generator 檢查；`$defs` 不等於 root union                                                     |
| `type`（26,230）                                               | string→`str`；boolean→`bool`；number→`Union[int, float]`；integer→`int`；null→`None`；array／object 依下列規則；type 陣列→`Union[...]`                              | Python `bool` 是 `int` 子類、整數值 float 的 schema integer 接受性、finite number 仍由 validator 判定；不強制轉型 |
| `properties`（7,051）、`required`（7,028）                     | 封閉固定物件→`TypedDict`；先定義 required 的 total=True base，再以 total=False child 加 optional fields。全 optional 使用 total=False；空封閉物件用空 `TypedDict`   | absent 與 explicit `None` 分開；只有包含 null 的 value 型別才加 `None`；不注入 default                            |
| `additionalProperties`（7,092）                                | false＋固定欄位依上一列；純 dictionary schema→`dict[str, T]`；`{}` value→`JsonValue`；固定欄位＋開放 extras 見 §4.1                                                 | TypedDict 不是 runtime exact-object validator，也不能在 3.10 同時精確描述 arbitrary extras                        |
| `enum`（5,788）、`const`（1,950）                              | 實際 string／bool／integer literal→`Literal[...]`，保留 primitive kind。例 `severity`→`Literal['info', 'warning', 'error']`，`ok`→`Literal[True]`／`Literal[False]` | JSON `1.0` 可等於 numeric const `1`，靜態 `Literal[1]` 是較窄的 authoring 型別；wire validator 保留現有接受範圍   |
| `anyOf`（3,008）                                               | `Union`，nullable 為含 `None` 的 union；`ok` 成功／失敗分支保留不同 TypedDict                                                                                       | 不做可能破壞欄位關係的「全部 optional」攤平；重疊分支在 runtime 至少命中一個                                      |
| `oneOf`（16）                                                  | discriminated `Union`，保留各分支 required literal；封閉分支可依 `topic`／`kind`／`phase`／`mode` narrowing                                                         | 恰好一個分支匹配須 runtime 計數；不因目前有 discriminators 就刪除此檢查                                           |
| `items`（729）                                                 | 一般 JSON array→`list[T]`                                                                                                                                           | 不接收 tuple 作為 wire list 的隱式替代                                                                            |
| `prefixItems`（28）                                            | wire 型別用 `list[Union[T0, …, Tn]]`；零長度用 `list[NoReturn]`；另產生可選 positional helper 的 `tuple[T0, …, Tn]` 型別，見 §4.2                                   | list 的長度／位置關係須 runtime；明列寬化，不宣稱 `list[Union]` 是完整 tuple constraint                           |
| `not`（2）                                                     | 現有 `not: {}` 為 impossible；optional 欄位型別為 `NoReturn`，只能省略；若 required 則整個分支不可滿足                                                              | 其他 negation 形狀未支援，須失敗而非忽略                                                                          |
| `propertyNames`（41）                                          | dictionary key 為 `str`；其 name schema 留在 IR                                                                                                                     | key pattern／禁用鍵由 validator／domain checks 執行                                                               |
| `pattern`（3,655）、`minLength`（3,019）、`maxLength`（4,287） | `str`，constraints 可出現在產生註解／inventory                                                                                                                      | regex、Unicode code points／NUL／surrogate／UTF-8 bytes 等限制不能靠 `str` 表達                                   |
| `minimum`（1,021）、`maximum`（981）                           | 原數值型別加 IR bounds                                                                                                                                              | 範圍、safe integer、finite 與跨欄位大小關係需 runtime                                                             |
| `minItems`（566）、`maxItems`（725）                           | 保留 `list[T]`／positional helper 型別                                                                                                                              | 最小／最大長度與額外尾項拒絕需 runtime                                                                            |
| `minProperties`／`maxProperties`（各 2）                       | 保留 object 型別與 IR constraint                                                                                                                                    | property 數量由 runtime 驗證                                                                                      |
| boolean `false`／空 schema `{}`                                | false→不可滿足 `NoReturn`；`{}`→明確遞迴 `JsonValue`（若為 `not` operand 則按否定處理）                                                                             | `JsonValue` 僅代表 JSON 值；不是任意 Python object／`Any`。目前無 true schema，新增時需 inventory review          |

`JsonValue` 提案定義為 `Union[None, bool, int, float, str, list['JsonValue'], dict[str, 'JsonValue']]`，搭配 `TypeAlias` 與 forward references。遞迴 alias、`NoReturn` value position 與 TypedDict inheritance 必須在選定 checker 的 Python 3.10 模式及真實 3.10 import 測試，不用最新版 interpreter 成功替代最低版本證據。

### 4.1 開放物件與非 identifier 欄位

`manifest`、`manifest.contributes`、localized `displayName`／command title 等目前允許 extras。提議這些 wire alias 使用 `dict[str, JsonValue]`（schema-valued extras 時 value union 亦含已知欄位的值型別），保留全部鍵；另產生明名 `…KnownFields` TypedDict，供顯式的唯讀已知欄位投影／編輯器提示使用。投影不是 wire serialization，不可拿投影結果覆蓋原物件；facade 不自動投影。這是 Python 3.10 表達力的明示取捨，開放物件 required keys 仍由 runtime 驗證。

`zh-TW` 等非 identifier property 保留原拼字，用 functional `TypedDict('Name', {'zh-TW': str}, total=False)`；必要時先建立 functional required base，再以 class inheritance 加 optional fields。若 optional 部分有非 identifier，先建 total=False functional base，再由 total=True child 加 required fields；兩組都含非 identifier 的新形狀須先擴充生成策略並驗 checker，不改 wire key 或降成 `Any`。

### 4.2 prefixItems 與無損 wire 表示

`ui/negotiate.params.uiResourceVersions` 有 `[]`、`[1]`、`[2]`、`[1, 2]` 四種 prefix 形狀；`ui/dataChunk.params.chunk` 的 line-chart entries 是四元素 list。生成的 wire alias 必須仍接受既有 JSON list；runtime 按位置驗證，拒絕 `[2, 1]` 等不合法 negotiation 值。

可選 helper 用 `tuple[Literal[1], Literal[2]]` 等精確位置型別，呼叫後建立 list 並驗證；只能是明示、局部轉換，不在 facade 把所有 list 變 tuple，也不改 round-trip 的容器形狀。helper 的有效／無效 typing fixtures 與直接 list 的 runtime fixtures 分開驗收。

## 5. 命名、去重與版本身分

公開 aliases 由完整 definition key 產生 PascalCase：分隔 `/`、`.`、`-`，保留 camelCase word boundaries 與數字，版本 token 保留為 `V1`／`V170`；`$` 映為 `Dollar`。所有公開名稱與 wire key 的映射寫入 inventory，生成順序不影響名稱。

| 真實 `$defs` key                                            | 提議公開名稱                                                                |
| ----------------------------------------------------------- | --------------------------------------------------------------------------- |
| `resourceOwner`／`commonFailure`                            | `ResourceOwner`／`CommonFailure`                                            |
| `settings/read.params`／`settings/watch.params`             | `SettingsReadParams`／`SettingsWatchParams`，可共用結構但兩個公開名稱均保留 |
| `devices/inputModes/query.result`                           | `DevicesInputModesQueryResult`                                              |
| `ui/negotiate.v1.params`／`ui/negotiate.params`             | `UiNegotiateV1Params`／`UiNegotiateParams`，不得互相覆蓋                    |
| `devices/subscribe.v170.params`／`devices/subscribe.params` | `DevicesSubscribeV170Params`／`DevicesSubscribeParams`，分別保留 6／7 分支  |
| `events/deliver.v170.params`／`events/deliver.params`       | `EventsDeliverV170Params`／`EventsDeliverParams`，分別保留 16／17 分支      |
| `ui-resource-v1`／`ui-resource-v2`                          | `UiResourceV1`／`UiResourceV2`                                              |
| `$/cancelRequest.params`                                    | `DollarCancelRequestParams`；wire method 仍為 `$/cancelRequest`             |

內部結構名提議 `_Shape_<完整 SHA-256>`，nested property／branch 的人類可讀 path 留於註解與 inventory。使用完整 digest 避免新增別的短 hash collision 導致既有命名漂移；需要更短符號須另凍結 naming 版本。公開名稱正規化若碰撞，generator 拒絕並要求旁表中的明確 alias override，不能加依遍歷順序決定的 `_2`。Python reserved words 的 facade method 加尾 `_`，wire keys 不變。

去重以完整 schema 相等為限。例如 `settings/read.params` 與 `settings/watch.params` 相等；`shutdown.params`、`exit.params` 與其他空封閉 params 可共享 `_Shape_…`；`command/execute.result`、`shutdown.result`、`ui/showMessage.result` 都是 null，可各自 alias `None`。`ui/ready.v1.result` 與未帶版本 result 目前相等，仍保留兩個 alias／驗證 definition。禁止僅因 annotations 一樣而合併不同 bounds，或用最新版取代 historical alias。

wire method 去掉的是最後 `.params`／`.result` 與已辨識的版本 marker；不是任意切掉所有點號。`storage/beginWrite` 的 Python facade 可名 `storage_begin_write`，但送出的 method 字串必須逐字保留大小寫與 `/`。`initialize`、`command/execute`、`storage/drain` 等 inbound 方法不能因具有 params/result 就自動暴露為 plugin outbound request。

## 6. 手寫邊界與 typed facade

提議旁表 `sdks/python/tools/bindings-methods.json` 對每個 definition 記錄角色（resource／envelope／request params／result／notification）、wire method、direction、version profile、能力／引入版本與 Python name。**只供 routing／版本／命名，不重述欄位 schema**。173 個 keys 必須全部分類，request 必須成對、notification 不可偽造 result；之後新增 definition 若無分類就失敗。版本資訊由既有 registry／協商實作與 protocol owner 審查，不從 `.v1` 推算 API 1.0 或把 `.v170` 當 distribution version。

生成 facade 提議為 `TypedRequests`，透過手寫 adapter 取得現有 request callback 與協商 profile；每個 outbound coroutine 使用明確 params/result aliases，沿既有 `_request` 執行驗證與回應處理。historical profile 有對應 facade／overloads，只能由已協商 adapter 取得；不能讓 caller 自選新 profile 繞過 gate。business-result envelope 保留 `ok` 分支，不擅自 unwrap 或吞掉 error。notification／inbound handler contracts 可生成 typing Protocol，dispatch 仍手寫。

維持手寫的內容包括：

- `_plugin.py` 的 framing／dispatch／pending／timeout／cancel、UI 和 recovery negotiation、epoch retirement、ready／drain／deactivate；typing 不能證明生命週期有效。
- `_schema.py` 的結構 validator、immutable bundle cache，以及 `_devices.py`、`_events.py`、`_ui*.py`、`_settings.py`、`_storage.py`、`_persistence_actions.py`、`_connection_recovery.py` 中各自的 domain checks／callback／handle lifecycle。生成器不能由 schema 推導 watch／unwatch 或 storage drain 的權限範圍。
- 舊 `Plugin`／`CommandContext`／client 方法與例外語意。新增 facade 為選用入口；既有 dict callers 不需建立 dataclass、model instance 或 typed wrapper，也不變更 positional／keyword arguments。

TypedDict 不可直接視為任意 `dict[str, JsonValue]` 的可變型別替代。手寫 adapter 接 `object`，先檢查／驗證 JSON 形狀，再在小且可審查的邊界收窄並轉交既有 request；不得在每個 generated method 放任意 `cast` 來逃避 checker。回應也在驗證後才收窄。允許舊 dict 使用者走原介面，不在新 typed overload 加 `Any` fallback，使 invalid fixtures 偷渡。

回歸要求保留 absent／null、unknown extra keys、整數值與 Unicode、list 順序及巢狀內容。不得為了型別生成額外 defaults、丟未知欄位、把 bool 轉 int、normalize IDs 或重排 payload。原本 runtime 接受的 `1.0` integer 值可由舊 dict 路徑繼續接受；新 authoring hints 的較窄型別不構成 wire breaking change，須在文件說明並有測試。

## 7. 生成檔案與 wheel 提案

為配合目前 setuptools 明列 `packages = ['kobrixa']`，提議先採同 package 的平面 modules，避免新增未被打包的子 package。

```text
sdks/python/tools/generate_bindings.py       # 手寫 generator，開發工具
sdks/python/tools/bindings-methods.json       # 手寫、受審查 metadata
sdks/python/kobrixa/_generated_types.py       # 共用結構＋173 個公開 aliases
sdks/python/kobrixa/_generated_requests.py    # 薄 typed facade／handler contracts
sdks/python/kobrixa/_generated_inventory.json # names、pointers、profiles、constraints
sdks/python/kobrixa/types.py                  # 手寫穩定公開 re-exports
sdks/python/kobrixa/_typed_adapter.py         # 手寫協商／驗證邊界
sdks/python/kobrixa/py.typed                  # 空 marker，納入 package-data
```

schema bundled copy 保持既有 `kobrixa/plugin-protocol.schema.json`。生成 Python 檔 header 範本如下（placeholder 不是已生成產物）：

```python
# Generated by Kobrixa Python bindings generator; DO NOT EDIT.
# generator-version: <reviewed generator version>
# generator-format: 1
# schema-id: https://kobrixa.com/schemas/plugin-protocol/1.8.0.json
# schema-sha256: <raw schema bytes SHA-256>
# keywords-sha256: <allowlist bytes SHA-256>
# method-metadata-sha256: <reviewed metadata bytes SHA-256>
```

inventory 保存同樣 provenance，`py.typed` 保持空檔不加 header。generator source 也納入 review；版本號不代替重新生成的 byte comparison。不得把 173 定義預設視為 173 類別或承諾未量測的檔案大小。

wheel 必含所有手寫 runtime modules、生成 `.py`、inventory、`py.typed`、bundled schema、distribution metadata；不得依賴 repo 中的 tools／tests／source schema 才能 import。`pyproject.toml` package-data 需明列新增資料檔，維持 `dependencies = []`；setuptools／type checker／build 是 build 或 dev dependencies。PEP 561 marker 不等於整個既有 SDK 已達 strict typing，公開 typed surface 與未完整 annotation 的 legacy surface 必須明列。

提議 `test_wheel_contents.py` 檢查 wheel ZIP members／schema digest／marker，再在乾淨 venv 安裝既有 wheel、移除 checkout 的 `PYTHONPATH`，從 repo 外 import `kobrixa`／`kobrixa.types`／facade、載入 `Validator.bundled()` 並跑一筆有效／無效值。另將 typing consumer 指向已安裝 wheel 檢查 marker 發現，不能只測 source import。Python 3.10 與 release 支援的較新 interpreter 都須驗；不下載 runtime，管理與 ABI 策略由 4D 處理。

## 8. 四階段 drift 與測試落點

所有新增 tests／fixtures 均為提議落點，尚不存在或尚未接線。四階段任一 failure 都阻止接受；不能只比較檔案已存在。

| 階段 | 來源→目標                                          | 測試落點與必要斷言                                                                                                                                                                                                                                                             |
| ---- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1   | Zod→committed protocol schema                      | 保留 `packages/plugin-protocol/src/json-schema.test.ts` serializer byte comparison、method registry coverage、keyword／pattern checks。不變更現有 assertion。                                                                                                                  |
| D2   | committed protocol schema→Python bundled schema    | 同一 TS test 的 bundled comparison；新增 `sdks/python/tests/test_generated_bindings.py` 直接比兩份 bytes／digest，檢查 Python `SUPPORTED_KEYWORDS` 與 allowlist。不可只比 `$id`。                                                                                              |
| D3   | committed schema＋keywords＋metadata→生成 bindings | 新增 `sdks/python/tests/test_codegen.py`：兩次生成相同、`--check`、整份輸出 inventory、173 keys 完整分類、版本 aliases 不消失、不同 key order 的 IR 穩定、未知 keyword／新增未分類 method／改 bounds／手改生成檔／漏檔負例均失敗。測試使用記憶體輸出或 runner 提供的暫存目錄。 |
| D4   | bindings→已安裝 wheel 與消費者                     | 新增 `test_wheel_contents.py` 和 `test_typing.py`，驗包內容、repo 外 import／bundled validation、valid／invalid typing diagnostics；與 runtime conformance／facade round-trip 合流。不能讓 source imports 掩蓋遺漏檔案。                                                       |

現有 TS／Python conformance tests 繼續消費同一份 347 cases，沿用 `$repeat` 展開與原有 expected flags。新增 `test_generated_bindings.py` 對每一 case 依 definition role 走 generated codec／驗證邊界，request cases 才走適用 facade，不把 manifest 或 inbound request 硬送成 outbound RPC。正例 JSON encode／decode 後以型別敏感的深比較驗 `True` 不被當成 `1`、unknown keys／null／absent／list 形狀皆保留；負例必須仍拒絕。再由 TS validator 消費相同 round-trip payloads，證明跨語言結果一致。

347 cases 僅覆蓋 11 defs，故新增 fixtures 於 `sdks/python/tests/fixtures/generated-bindings/`，並在 `packages/plugin-protocol/src/generated-bindings.test.ts` 提議新增 TS consumer。inventory 要列出每個 definition 的有效值與失敗案例或結構限制的明確原因；每個 union branch、optional/null、prefix 位置、open extras、historical shape 都有 consumer。不能用總 case 數取代分支覆蓋，也不能憑 generator 自己生成再自己接受作為唯一 oracle；關鍵 fixtures 由 owner 從 wire contract 獨立審查。

既有 `sdks/python/tests/test_plugin.py`、`test_framing.py`、`test_schema_cache.py`、`test_devices.py`、`test_connection_recovery.py`、`test_events.py`、`test_ui*.py`、`test_settings.py`、`test_storage.py`、`test_persistence_actions.py` 等持續跑，補上同樣操作分別由 legacy dict／typed facade 呼叫的 fake transport unit tests。取消、timeout、stale epoch、drain callback、business error 與 API 1.4–1.8 negotiation 不得因 typing 路徑新增而跳過。

### 8.1 Typing fixtures 提案

提議固定版本 mypy 為開發工具，使用 strict、Python 3.10 target；版本與鎖定方式由 owner 在實作前決定。`test_typing.py` 不得在 checker 缺失時默默 skip。valid 與 invalid 分開執行；invalid fixture 逐行記錄預期 diagnostic code／位置，檢查缺失與多餘 diagnostics，不能只看非零 exit code。不得使用 `Any`、`type: ignore`、`cast` 壓掉應驗錯誤。

| Fixture（提議放 `sdks/python/tests/typing/`） | 必須驗到的行為                                                                                                                                                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `valid_messages.py`                           | `UiShowMessageParams = {'severity': 'info', 'message': '你好'}`；`SettingsReadParams = {'schemaVersion': 1}`；正確 await 的 facade result 型別。                                                                         |
| `invalid_messages.py`                         | severity `'debug'`、缺 message、schemaVersion 為字串、封閉 message literal 多鍵；錯配 method params alias 必須報錯。                                                                                                     |
| `valid_unions.py`／`invalid_unions.py`        | `DevicesSubscribeParams` 的 catalog 分支只需 topic，session 分支需 sessionId；missing sessionId／把 connectionRecovery 填入 V170 alias 必須報錯；依 `ok` narrowing 後不能讀另一分支欄位。                                |
| `valid_optional.py`／`invalid_optional.py`    | `storage/beginWrite.params.drainToken` 可省略但不可為 None；`settings/reset.params.expectedRevision` 必須存在且可為 None。缺 expectedRevision 或把 drainToken 設 None 必須報錯；使用實際 schema pointer，不自造 schema。 |
| `valid_prefix.py`／`invalid_prefix.py`        | positional helper 接 `(1, 2)`、拒 `(2, 1)`／長度錯誤；wire list 的不合法順序另由 runtime 負例拒絕，不假報 checker 能判斷 list 位置。                                                                                     |
| `valid_open_objects.py`                       | manifest 保留未知 extension key 與 nested JSON；KnownFields 的 `zh-TW` 原樣保留；wire round-trip 不經投影。                                                                                                              |
| `invalid_forbidden.py`                        | `not: {}` 的已知欄位投影禁止指定 invocation／arguments；open wire dict 的對應值另由 runtime 拒絕。                                                                                                                       |
| `installed_consumer.py`                       | 僅從已安裝 wheel import aliases／facade，確認不是 `Any` 或 untyped import；用可通過／不可通過 assignment 驗回傳型別。                                                                                                    |

## 9. 型別提示以外的契約

下列不能靠上述 annotations 完整表示，必須由既有 validator 與手寫 domain logic 覆蓋並持續保留負例：

- `oneOf` exact-one、`not`、object extra keys／requiredness（開放 dict 路徑）、propertyNames、tuple/list 位置與長度、min/max property 數。
- numeric bounds、安全整數、非有限值、bool/int 差異、integer-valued float；string pattern、Unicode code points、UTF-8／JSON encoded bytes、NUL／surrogate、canonical IP／base64。
- device／persistence error code 與 detail.reason 的關係、sequence 區間、channel／record ID 唯一性、motion mode 與 gesture reference 的關係、各 method byte caps。
- request/result correlation、協商的 offered versions、recovery topic／hostEpoch、UI binding／dataset revision、source identity、權限、stale handles、cancel／drain lifetime。

第一類由 `_schema.py._check` 負責；後三類依現有 `_device_semantics`、`_persistence_semantics`、`_validate_ui` 與各 domain module 分工。type hints 不新增執行期權限，也不能替代 host validation。所有現有上限／budget 保持原值。

## 10. 風險與待核准決策

| 風險／待決項                                              | 提案控制與關門條件                                                                                                      |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 10 MB inline schema 造成型別膨脹／checker 緩慢            | 完整結構 dedup、穩定 IR、量測 generation／import／typing 成本；131 是頂層唯一結構數，不是成本保證。                     |
| Python 3.10 無精確 open TypedDict／list tuple constraints | 接受 §4 的明示寬化＋runtime validation；若 owner 要求完全靜態精確須另審公開 API，不偷偷改成 dataclass／第三方 runtime。 |
| dedup 改掉版本 validator identity                         | public alias 與 definition metadata 永遠分離；相等結構共享實作不共享協商身分。                                          |
| methods 有形狀但沒有 direction／版本生命週期              | 旁表全量覆蓋與 owner review；不從名稱猜 introduction version。                                                          |
| `py.typed` 暴露既有未完整 typing 的 API                   | 固定新 typed surface、wheel consumer fixtures、相容性文件；不以 marker 冒充整個 SDK strict 通過。                       |
| checker／setuptools／Python 版本差異                      | 固定 dev tools、真實 3.10 baseline、release interpreter matrix、source-free wheel 驗證。                                |
| schema 與並行改動造成測量過期                             | generation／驗收重記 schema digest、candidate commit／dirty scope；本文件數字只對 §2 digest 成立。                      |
| 新測試有缺漏而把舊 conformance 當完整覆蓋                 | 173-definition inventory、union branches 與反例矩陣；缺失／NOT RUN 保持未完成。                                         |

owner 在實作前需核准 naming format、metadata owner、open-object／prefix typing 取捨、checker 固定版本、wheel 支援矩陣與新增成本預算。這些不是本文默認已批准的事項。

## 11. 驗收表與原生交接

以下各列狀態目前均為 **提案／NOT RUN**，不是本次文件編輯的測試結果。

| ID    | 必要驗收                 | 通過條件／證據                                                                                                                                 |
| ----- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 4B-01 | 進場與 contract review   | Stage 3／4A gates、owner decisions 有明確核准；schema／generator format 凍結。                                                                 |
| 4B-02 | 支援 inventory           | 全部實際 keywords／173 defs／版本 aliases 分類；未知構造失敗；新 inventory 有人工 review。                                                     |
| 4B-03 | deterministic generation | 重複生成 byte-identical；不同平台／hash seed 排序穩定；手改／漏檔／過期輸出負例失敗。                                                          |
| 4B-04 | D1–D4 drift              | 四階段全部成功，測試對應同一 source／schema／wheel digest。                                                                                    |
| 4B-05 | conformance／round-trip  | 原有 cases 與 domain fixtures 全保留；新增覆蓋矩陣完成；TS／Python 結果一致、無值或鍵流失。                                                    |
| 4B-06 | typing                   | valid 零非預期診斷，invalid 逐項精確診斷；3.10 import／遞迴 alias／optional inheritance 成功。                                                 |
| 4B-07 | backwards compatibility  | dict callers 與 facade 的 wire／例外／取消／stale／drain 等價，1.4–1.8 negotiation 與 historical aliases 不退化。                              |
| 4B-08 | packaging                | wheel contents 正確、`py.typed` 被消費、repo 外無 runtime dependencies 安裝／import／驗證成功。                                                |
| 4B-09 | 真實 transports          | 相同 candidate 下 JS MessagePort 與 Python stdio 的 settings／storage／UI／devices error／cancel／stale／drain matrix 完成；unit mock 不替代。 |
| 4B-10 | 文件與成本               | 核准實作時補英／繁中 authoring docs、公開 aliases 與限制；新成本量測符合事前核准預算，既有 budgets 不變。                                      |

規劃階段不啟動 Electron、不聆聽 localhost、不產生 bindings／wheel。實作後可先在 sandbox 執行的既有入口（需依候選實作增補 generator／typing／wheel tests）為：

```sh
node node_modules/vitest/vitest.mjs run packages/plugin-protocol/src/json-schema.test.ts packages/plugin-protocol/src/conformance.test.ts
node tools/run-python-tests.mjs
```

原生 orchestrator 仍須在已建置的同一候選上執行下列既有入口；這些命令尚未執行，也不單獨證明新 facade 已接入全部測試：

```sh
node --test tests/desktop/plugins-smoke-process.test.mjs
node tests/desktop/run-plugins-smoke.mjs
node tests/desktop/device-broker-run.mjs
node tests/desktop/declarative-ui-run.mjs --transport-only
node tests/desktop/stage-3-closeout-run.mjs b2 --run
```

原生 runner 的必要 inputs／已建置 artifact／Python／真實驗收資料由 orchestrator 準備，不造 placeholder。4B 實作計畫須補 facade 同時走 MessagePort／stdio 的 cases 接線與 wheel matrix 命令；在實作之前不宣稱存在新的可執行 runner。原生或 installed 測試不能執行時記 NOT RUN 與原因，Stage 3 硬體／人工門檻繼續由原 owner 關閉。

**本文沒有交付 Python bindings，也沒有宣告任何 Stage 4 驗收通過。**
