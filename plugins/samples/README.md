# Plugin samples (development preview)

These samples contribute a greeting command and display a message in Settings → Plugins. They demonstrate trusted local plugins, not Python or TypeScript compilation for EV3. Plugin permissions restrict calls through Kobrixa; they are not an operating-system sandbox.

## Prepare the samples

Use Node.js 24 or newer, pnpm 10.15.0 and Python 3.10 or newer with pip. From the repository root, run the following in a macOS/Linux shell. If Python requires a virtual environment, activate it first so the SDK is installed into the interpreter you will choose in Kobrixa.

```sh
pnpm install && pnpm build:core
npx esbuild plugins/samples/hello-ts/src/index.ts --bundle --platform=node --format=cjs \
  --tsconfig=tsconfig.base.json --outfile=plugins/samples/hello-ts/dist/index.cjs
python3 -m pip install -e sdks/python
pnpm dev
```

`--tsconfig=tsconfig.base.json` supplies the workspace mapping for `@kobrixa/plugin-sdk`. The bundle output matches the TypeScript manifest's `runtime.entry`. A packaged Kobrixa works the same way: open it normally, no launch options are needed.

## Link the samples

1. Open **Settings → Plugins** and select **Turn on developer mode** at the bottom. Kobrixa asks for confirmation, because linked plugins run as ordinary programs on this computer.
2. Select **Link folder…** and choose `plugins/samples/hello-ts`. Before linking, Kobrixa shows the plugin's name, ID, runtime, folder and any manifest problems. Repeat for `plugins/samples/hello-python`.
3. Under **Python interpreter**, choose the interpreter where you installed the SDK. Each candidate shows its version and whether the Kobrixa SDK is installed; **Other…** opens a file picker and **Detect again** checks the candidates again. On Windows, `py -3` is also listed.
4. Select **Say hello** on each sample. Plugin processes start only when a command runs.

The links and the Python choice are saved in `<userData>/plugins/state.json`, so the samples are still there after a restart. Kobrixa stores the folder's real path, so linking the same folder again (even with different letter case on macOS or Windows) only highlights the existing row.

The corresponding command IDs are:

- `kobrixa-samples.hello-ts.greet` — `hello-ts/src/index.ts`, bundled to `hello-ts/dist/index.cjs`.
- `kobrixa-samples.hello-python.greet` — `hello-python/main.py`, using `from kobrixa import Plugin`.

Both manifests request `ui.notifications` and declare the matching `onCommand:<command-id>` activation event. The greeting uses the host locale received at startup (`en` or `zh-TW`) and appears under **Messages from plugins** with the plugin ID and its severity.

## While developing

- **Reload** reads the folder again and restarts the plugin, for example after rebuilding `dist/index.cjs` or editing `main.py`. A Python choice made while a plugin is running takes effect at the next reload.
- **Choose folder again…** points a row at a moved folder. **Unlink** removes the row; it never deletes files.
- **Show log** shows the plugin's output: JS/TS stdout/stderr and Python stderr. Control characters are removed. Each plugin keeps up to 256 KiB and all plugins together up to 4 MiB, oldest lines first out; logs live only in memory and are cleared on unlink. The same lines also appear in the terminal running Kobrixa, prefixed with `[plugin <id>] `. Constructing `Plugin()` redirects Python `print()` to stderr, including top-level prints before `run()`; use stderr explicitly for any logs before construction.
- A running command shows **Cancel**. If the plugin does not stop within five seconds, Kobrixa terminates its process.
- **Disable** stops a plugin and removes its commands; **Enable** makes them available again. **Keep disabled after restart** saves the choice.
- Turning developer mode off stops every linked plugin but keeps the links; turning it on again loads them.

A crash never replays a command; three process failures within five minutes require disabling and enabling the plugin before another start.

## Recovery

If Kobrixa did not shut down normally while a third-party plugin was running, or its window stopped responding, the next start pauses all third-party plugins and shows a banner. Built-in Basic Plus and EV3 remain enabled. Use **Open plugin settings** to disable or unlink the problem plugin, then **Restore plugins**.

## Advanced: launch options

Launch options apply to one session only. They are not saved, and the panel marks such rows **From launch options**; they cannot be unlinked. A folder that is also linked appears once.

| Switch                          | Effect                                                                                                                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--plugin-dev-dir=<folders>`    | Loads these folders for this session without turning on developer mode. Separate folders with `:` on macOS/Linux and `;` on Windows; quote the value and use absolute paths. |
| `--plugin-python=<interpreter>` | Uses this interpreter for this session instead of the saved choice.                                                                                                          |
| `--safe-mode`                   | Keeps all third-party plugins off for this session. **Restore plugins** cannot end it; restart without the switch.                                                           |

From a checkout, pass them after one `--` separator: pnpm forwards it through the nested script, and Electron Forge passes the following switches to Electron.

```sh
pnpm dev -- --plugin-dev-dir="$PWD/plugins/samples/hello-ts:$PWD/plugins/samples/hello-python" \
  --plugin-python="$(command -v python3)"
```

For a packaged app on macOS, quit any running Kobrixa first:

```sh
open -a Kobrixa --args \
  --plugin-dev-dir="$PWD/plugins/samples/hello-ts:$PWD/plugins/samples/hello-python" \
  --plugin-python="$(command -v python3)"
```

Python must be installed locally with the SDK; Kobrixa does not download or manage the interpreter. Python stdout carries only protocol messages; write logs to stderr. See the [Python SDK](../../sdks/python/README.md) and [plugin architecture](../../docs/en/architecture.md#plugins-development-preview).

These samples remain API 1.0-compatible command plugins. Kobrixa's current plugin API is 1.3.0; compiler declarations are reserved for built-ins. Adding `frontends` or `backends` to an external manifest makes the entire plugin invalid. Build outputs stay in the project's configured outputDir; changing or deleting them before deployment requires a new build. See [compiler and artifact contracts](../../docs/en/architecture.md#compiler-contracts).

## Language services / 語言服務

Built-in manifests place this complete `bp` declaration under `contributes`:
內建 manifest 在 `contributes` 下使用以下完整 `bp` 宣告：

```json
{
  "languageServices": [
    {
      "language": "bp",
      "extensions": ["bp", "bpi", "bpm"],
      "capabilities": [
        "analysis",
        "completion",
        "quickFixes",
        "semanticTokens",
        "hover",
        "signatureHelp",
        "definition",
        "references",
        "rename",
        "documentSymbols",
        "documentFormatting",
        "rangeFormatting"
      ]
    }
  ]
}
```

`languageServices` is a built-in-only API 1.3.0 contribution. Do not add it to the development samples, even as `[]`. Structural schema validation is shared with Python; the host additionally validates uniqueness, required `analysis`, frontend ownership, extension-set equality and trusted source. A declaration contains no implementation path. The runtime resolves frontend conflicts before deciding whether a service is missing. Built-in factory capabilities must cover every declared capability; a mismatch makes the language unavailable without changing the plugin's status.

`languageServices` 僅供 API 1.3.0 的內建插件使用，請勿加到開發插件範例，空陣列也不允許。Python 共用結構 schema；唯一性、必要的 `analysis`、frontend 擁有者、副檔名集合相等及可信來源由宿主另行驗證。宣告沒有實作路徑。runtime 先判定 frontend 衝突再判定缺少服務；工廠能力不足會讓語言不可用，但不改變插件本身狀態。

Duplicate languages within `languageServices`, and duplicate extensions or capabilities within a declaration, are rejected by the **host registry**, not by the published JSON Schema or the Python SDK validator. Passing structural validation alone does not make a language-service declaration valid for the host.

`languageServices` 中重複的語言，以及單筆宣告中重複的副檔名或能力，由**宿主 registry** 拒絕；已發布的 JSON Schema 與 Python SDK 驗證器不會拒絕這些重複值。通過結構驗證不代表宣告符合宿主規則。

## Author diagnostic help

Declare `contributes.diagnosticHelp = { "version": 1, "path": "diagnostic-help.json" }` in your manifest. The path is relative to the plugin folder and must point to a JSON file inside it. The resource has an `entries` array:

```json
{
  "entries": [
    {
      "code": "ACME1001",
      "helpKey": "missing-value",
      "title": { "en": "Missing value", "zh-TW": "缺少值" },
      "cause": { "en": "A required value is missing." },
      "steps": { "en": ["Supply the required value."] },
      "example": { "before": "value =", "after": "value = 1" },
      "links": [{ "url": "https://example.com/help", "label": { "en": "More help" } }]
    }
  ]
}
```

Each entry requires `code`, `title`, `cause` and `steps`; `helpKey`, `example` and `links` are optional. Localized text and steps require `en`; `zh-TW` is optional and falls back to English. Codes match `/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/`, and help keys match `/^[a-z0-9-]{1,100}$/`. Each `(code, helpKey)` pair must be unique within the file. Unknown fields, including `source`, are rejected.

All content is plain text, without Markdown or HTML rendering. Titles, steps and link labels are single-line; causes and the `before`/`after` examples may span multiple lines. Links must use HTTPS. Version 1 limits come from [`DIAGNOSTIC_HELP_LIMITS`](../../packages/plugin-protocol/src/limits.ts):

| Item                                 | Limit                   |
| ------------------------------------ | ----------------------- |
| Resource file                        | 1 MiB (1,048,576 bytes) |
| Entries per plugin                   | 512                     |
| Serialized JSON per entry (UTF-8)    | 16 KiB (16,384 bytes)   |
| Steps per locale                     | 16                      |
| Links per entry                      | 4                       |
| URL                                  | 2048 characters         |
| Title, individual step or link label | 500 characters          |
| Cause or each example field          | 4000 characters         |
| Total loaded help across plugins     | 8 MiB (8,388,608 bytes) |

Help is published only while the plugin is enabled and shown only for diagnostics with the plugin's own source ID; matching another plugin's diagnostic code does not grant access to its help. This preview does not yet expose external diagnostic producers. An unreadable or invalid help resource adds `PLUGIN_E_DIAGNOSTIC_HELP` and leaves the plugin enabled without that help. The reserved plugin ID `kobrixa.core` is rejected with `PLUGIN_E_RESERVED_ID`.

## 繁體中文

這兩個範例會提供問候命令，並在「設定 → 插件」顯示訊息。它們示範可信任的本機插件，不提供將 Python 或 TypeScript 編譯至 EV3 的功能。插件權限只限制透過 Kobrixa 的呼叫，並不是作業系統沙箱。

### 準備範例

請使用 Node.js 24 以上、pnpm 10.15.0，以及具備 pip 的 Python 3.10 以上版本。在儲存庫根目錄，以 macOS／Linux shell 執行以下命令。如果 Python 要求使用虛擬環境，請先啟用該環境，讓 SDK 安裝到之後要在 Kobrixa 選的直譯器。

```sh
pnpm install && pnpm build:core
npx esbuild plugins/samples/hello-ts/src/index.ts --bundle --platform=node --format=cjs \
  --tsconfig=tsconfig.base.json --outfile=plugins/samples/hello-ts/dist/index.cjs
python3 -m pip install -e sdks/python
pnpm dev
```

`--tsconfig=tsconfig.base.json` 提供 `@kobrixa/plugin-sdk` 的 workspace 路徑對應。輸出檔案符合 TypeScript manifest 的 `runtime.entry`。已封裝的 Kobrixa 用法相同：正常開啟即可，不需要啟動參數。

### 連結範例

1. 開啟「設定 → 插件」，在最下方選「開啟開發者模式」。Kobrixa 會先請你確認，因為連結的插件會以一般程式身分在這部電腦執行。
2. 選「連結資料夾…」，選擇 `plugins/samples/hello-ts`。連結前 Kobrixa 會顯示插件名稱、ID、執行環境、資料夾，以及 manifest 的問題（如果有）。再對 `plugins/samples/hello-python` 做一次。
3. 在「Python 直譯器」選擇安裝了 SDK 的直譯器。每個候選都會顯示版本，以及是否已安裝 Kobrixa SDK；「其他…」會開啟檔案選擇視窗，「重新偵測」會重新檢查候選。Windows 另外會列出 `py -3`。
4. 在兩個範例各按一次「打招呼」。插件程序要等命令執行時才會啟動。

連結的資料夾與 Python 選擇會保存在 `<userData>/plugins/state.json`，重新啟動後範例仍在。Kobrixa 存的是資料夾的實際路徑，所以再次連結同一個資料夾（即使在 macOS 或 Windows 上大小寫不同）只會標示既有的那一列。

對應的命令 ID 如下：

- `kobrixa-samples.hello-ts.greet`：原始碼為 `hello-ts/src/index.ts`，打包至 `hello-ts/dist/index.cjs`。
- `kobrixa-samples.hello-python.greet`：入口為 `hello-python/main.py`，使用 `from kobrixa import Plugin`。

兩份 manifest 都要求 `ui.notifications` 權限，並宣告對應的 `onCommand:<command-id>` 啟用事件。問候訊息使用啟動時從宿主收到的語系（`en` 或 `zh-TW`），附上插件 ID 與嚴重程度，顯示於「插件訊息」。

### 開發時

- 「重新載入」會重新讀取資料夾並重新啟動插件，例如重新打包 `dist/index.cjs` 或修改 `main.py` 之後。插件執行中變更的 Python 選擇，會在下次重新載入時套用。
- 「重新指定資料夾…」用於資料夾搬移之後。「解除連結」只移除這一列，不會刪除任何檔案。
- 「查看日誌」顯示插件的輸出：JS／TS 的 stdout／stderr 與 Python 的 stderr，控制字元會被移除。每個插件最多保留 256 KiB，全部插件合計最多 4 MiB，先丟最舊的行；日誌只存在記憶體，解除連結時清除。同樣的內容也會出現在執行 Kobrixa 的終端機，每行加上 `[plugin <id>] ` 前綴。建立 `Plugin()` 時，Python 的 `print()` 便會導向 stderr，包含呼叫 `run()` 之前的頂層輸出；建立實例之前的日誌則須明確寫入 stderr。
- 命令執行中會出現「取消」。插件若在五秒內沒有停下，Kobrixa 會結束它的程序。
- 「停用」會停止插件並移除其命令；「啟用」即可再次使用。「重新啟動後也保持停用」會保存這個選擇。
- 關閉開發者模式會停止所有連結的插件，但保留連結；再次開啟時會重新載入。

當機不會重播命令；五分鐘內發生三次程序失敗後，必須停用再啟用插件，才能再次啟動。

### 復原

如果 Kobrixa 在第三方插件執行時沒有正常結束，或視窗停止回應，下次啟動會暫停所有第三方插件並顯示提示橫幅。內建 Basic Plus 與 EV3 保持啟用。按「前往插件設定」停用或解除連結有問題的插件，再按「恢復插件」。

### 進階：啟動參數

啟動參數只對本次執行有效，不會保存，面板會在這些列標示「本次啟動參數」，這些列不能解除連結。已連結的資料夾若也出現在參數中，只會顯示一列。

| 開關                            | 效果                                                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `--plugin-dev-dir=<folders>`    | 本次執行載入這些資料夾，不需要開啟開發者模式。macOS／Linux 以 `:` 分隔資料夾，Windows 使用 `;`；請加上引號並使用絕對路徑。 |
| `--plugin-python=<interpreter>` | 本次執行改用這個直譯器，不使用保存的選擇。                                                                                 |
| `--safe-mode`                   | 本次執行保持關閉所有第三方插件。「恢復插件」無法解除；請移除這個開關後重新啟動。                                           |

從原始碼執行時，在一個 `--` 分隔符之後傳入：pnpm 會經由巢狀腳本保留此分隔符，Electron Forge 再將後續開關傳至 Electron。

```sh
pnpm dev -- --plugin-dev-dir="$PWD/plugins/samples/hello-ts:$PWD/plugins/samples/hello-python" \
  --plugin-python="$(command -v python3)"
```

在 macOS 啟動已封裝的應用程式前，先結束所有執行中的 Kobrixa：

```sh
open -a Kobrixa --args \
  --plugin-dev-dir="$PWD/plugins/samples/hello-ts:$PWD/plugins/samples/hello-python" \
  --plugin-python="$(command -v python3)"
```

必須在本機安裝 Python 與 SDK；Kobrixa 不下載或管理直譯器。Python stdout 只傳送協定訊息，日誌請寫入 stderr。詳見 [Python SDK](../../sdks/python/README.md) 與[插件架構](../../docs/zh-TW/architecture.md#插件開發預覽)。

這些範例仍是相容 API 1.0 的命令插件。Kobrixa 目前的插件 API 為 1.3.0，編譯器宣告只限內建插件；在外部 manifest 加入 `frontends` 或 `backends` 會讓整個插件無效。建置成品仍在專案設定的 outputDir；部署前修改或刪除成品後，必須重新建置。詳見[編譯器與成品契約](../../docs/zh-TW/architecture.md#編譯器契約)。

### 撰寫診斷說明

在 manifest 宣告 `contributes.diagnosticHelp = { "version": 1, "path": "diagnostic-help.json" }`。路徑相對於插件資料夾，必須指向該資料夾內的 JSON 檔。資源格式如上方英文範例，以 `entries` 陣列包含各筆說明。

每筆必須有 `code`、`title`、`cause` 與 `steps`；`helpKey`、`example` 與 `links` 可省略。在地化文字與步驟必須提供 `en`，`zh-TW` 可省略，缺漏時退回英文。代碼格式為 `/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/`，helpKey 格式為 `/^[a-z0-9-]{1,100}$/`；同一檔案內的 `(code, helpKey)` 不得重複。未知欄位（包含 `source`）一律拒絕。

所有內容只以純文字呈現，不解析 Markdown 或 HTML。標題、步驟與連結標籤只能單行；原因及範例的 `before`／`after` 可多行。連結只接受 HTTPS。第 1 版上限來自 [`DIAGNOSTIC_HELP_LIMITS`](../../packages/plugin-protocol/src/limits.ts)：

| 項目                          | 上限                     |
| ----------------------------- | ------------------------ |
| 資源檔                        | 1 MiB（1,048,576 bytes） |
| 每插件條目數                  | 512                      |
| 單筆 JSON 序列化大小（UTF-8） | 16 KiB（16,384 bytes）   |
| 每語系步驟數                  | 16                       |
| 每筆連結數                    | 4                        |
| URL                           | 2048 字元                |
| 標題、單一步驟或連結標籤      | 500 字元                 |
| 原因或範例的單一欄位          | 4000 字元                |
| 全部插件已載入的說明合計      | 8 MiB（8,388,608 bytes） |

說明只在插件啟用時發布，並且只顯示於來源 ID 為該插件的診斷；即使代碼相同，也不會使用其他插件的說明。本預覽版尚未開放外部診斷提供者。說明資源無法讀取或驗證失敗時，會加上 `PLUGIN_E_DIAGNOSTIC_HELP`，插件仍保持啟用，但不提供該資源的說明。插件使用保留 ID `kobrixa.core` 時，會以 `PLUGIN_E_RESERVED_ID` 拒絕。
