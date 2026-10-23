# 插件系統（開發預覽）

Kobrixa 的插件系統讓可信任的本機程式碼在不修改核心應用程式的前提下，加入命令、編輯器語言與設備工具。本頁是入口文件：說明各組成部分、插件如何宣告與載入，以及每項能力的詳細文件位置。目前的插件 API 為 **1.5.0**。

> **信任模型。** 插件是可信任的本機程式。獨立程序提供當機隔離，manifest 權限只限制**透過 Kobrixa** 的呼叫，兩者都不是作業系統沙箱；插件程式碼仍可直接讀取檔案與使用網路。請只載入你信任的作者所提供的插件。

## 組成

| 組成                                                         | 職責                                                                                                                                            |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| [`packages/plugin-protocol`](../../packages/plugin-protocol) | `@kobrixa/plugin-protocol`。以 Zod 撰寫 manifest、JSON-RPC 方法、上限與錯誤碼；已提交的 `schema/plugin-protocol.schema.json` 是跨語言公開契約。 |
| [`packages/plugin-runtime`](../../packages/plugin-runtime)   | `@kobrixa/plugin-runtime`。manifest 驗證、registry、命令路由、程序監管、靜態語言目錄與設備資源；不依賴 Electron。                               |
| `apps/desktop/src/main/plugins`                              | 桌面端 `PluginController`：開發者模式、原生對話框、Python 偵測、日誌、session marker、安全模式與內建 allowlist。                                |
| [`packages/plugin-sdk-js`](../../packages/plugin-sdk-js)     | JS／TS 插件用的 `@kobrixa/plugin-sdk`：`definePlugin`、`runPlugin`、`context.commands`、`context.ui`、`context.devices`。                       |
| [`sdks/python`](../../sdks/python/README.md)                 | Python 3.10 以上用的 `kobrixa-plugin-sdk`（匯入名稱 `kobrixa`），執行時只用標準函式庫：`Plugin`、`@plugin.command`、`ctx.ui`、`ctx.devices`。   |
| [`plugins/`](../../plugins)                                  | 內建 manifest（`basic-plus`、`ev3`）與[可執行範例](../../plugins/samples/README.md#繁體中文)。                                                  |

```text
renderer（設定 → 插件、編輯器、面板）
      │ 只傳 source key、命令 ID、布林值——從不傳路徑或執行檔
      ▼
main：PluginController ── PluginManager／registry／supervisor
      │                         │
      │ utilityProcess +        │ stdin/stdout +
      │ MessagePort             │ Content-Length 訊息框
      ▼                         ▼
  JS／TS 插件               Python 插件            static 插件：沒有程序
```

宿主從綁定的通道推導呼叫者身分，從不採信訊息內附的插件 ID。renderer 只傳識別碼；開發者模式、安全模式與關閉中的檢查都在 main process、於對話框關閉之後執行。

## 插件種類

| `runtime.kind` | 誰可使用       | 程序                                    | 常見貢獻                                           |
| -------------- | -------------- | --------------------------------------- | -------------------------------------------------- |
| `node`         | 開發插件       | Electron `utilityProcess`，需要時才啟動 | 命令、設備 consumer、靜態語言、診斷說明            |
| `python`       | 開發插件       | 使用者選定的本機直譯器，需要時才啟動    | 命令、設備 consumer、靜態語言、診斷說明            |
| `static`       | 開發插件       | 無——只有 JSON 資料                      | 靜態語言、診斷說明                                 |
| `builtin`      | 宿主 allowlist | 編譯進應用程式                          | 編譯器 frontend／backend、語言服務、EV3 設備提供者 |

隨附的內建插件為 `kobrixa.basic-plus`（語言 `bp`）、`kobrixa.ev3`（後端 `ev3-native`）與 `kobrixa.device-ev3`（設備提供者）。內建插件在安全模式下仍可使用；必要的內建插件不能停用（`PLUGIN_E_BUILTIN_REQUIRED`）。

## Manifest

每個插件資料夾都有一份 `kobrixa-plugin.json`（最大 64 KiB）。為了向前相容，允許未知的頂層欄位；已知欄位無效時則回報錯誤。以下最小命令插件取自 [TypeScript 範例](../../plugins/samples/hello-ts/kobrixa-plugin.json)：

```json
{
  "id": "kobrixa-samples.hello-ts",
  "version": "0.1.0",
  "apiVersion": "^1.0.0",
  "displayName": { "en": "Hello (TypeScript sample)", "zh-TW": "問候（TypeScript 範例）" },
  "runtime": { "kind": "node", "entry": "dist/index.cjs" },
  "activationEvents": ["onCommand:kobrixa-samples.hello-ts.greet"],
  "permissions": ["ui.notifications"],
  "contributes": {
    "commands": [
      { "id": "kobrixa-samples.hello-ts.greet", "title": { "en": "Say hello", "zh-TW": "打招呼" } }
    ]
  }
}
```

| 欄位               | 意義                                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`               | 具命名空間的插件 ID，例如 `acme.tools`。`kobrixa.core` 為保留 ID（`PLUGIN_E_RESERVED_ID`）；重複 ID 會被拒絕。                                                      |
| `version`          | 插件本身的 semver。                                                                                                                                                 |
| `apiVersion`       | semver 範圍（`1.2.3`、`^1.2.3` 或 `~1.2.3`）。宿主的 API 版本必須符合此範圍，否則為 `PLUGIN_E_API_VERSION`。請宣告所用功能的最低版本，例如使用設備時宣告 `^1.5.0`。 |
| `displayName`      | 單行字串，或 `{ "en": …, "zh-TW"?: … }`。                                                                                                                           |
| `runtime`          | `{ "kind": "node" \| "python", "entry": "<相對路徑>" }` 或 `{ "kind": "static" }`。entry 為套件內相對路徑，不得含 `..`、隱藏或絕對路徑片段。                        |
| `activationEvents` | `onCommand:<command-id>`（最多 64 筆）。只有執行對應命令時才會啟動程序。                                                                                            |
| `permissions`      | 最多 16 筆，可用值為 `ui.notifications`、`devices.read`、`devices.connect`、`devices.control`。缺少權限的呼叫會得到 `PLUGIN_E_PERMISSION_DENIED`。                  |
| `requires.devices` | 1–5 筆不重複的 `{ capability, required }`，描述 consumer 需要的設備能力。                                                                                           |
| `contributes`      | 下一節所列的貢獻。                                                                                                                                                  |

### 貢獻（contributes）

| `contributes.*`    | 起始 API | 可用對象       | 說明                                                                                                                   |
| ------------------ | -------- | -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `commands`         | 1.0      | node／python   | 最多 64 筆。每個 ID 都必須以插件 ID 加 `.` 開頭（`PLUGIN_E_COMMAND_NAMESPACE`）。見[命令與生命週期](#命令與生命週期)。 |
| `diagnosticHelp`   | 1.2      | 全部           | 一個 `{ "version": 1, "path": "…json" }` 資源。見[範例：撰寫診斷說明](../../plugins/samples/README.md#撰寫診斷說明)。  |
| `languages`        | 1.4      | 全部           | 靜態 tokenizer 與編輯器設定 JSON。見[靜態語言插件](plugin-static-languages.md)。                                       |
| `frontends`        | 1.1      | 僅內建         | 編譯器 frontend；否則為 `PLUGIN_E_FRONTEND_REQUIRES_BUILTIN`。見[編譯器契約](architecture.md#編譯器契約)。             |
| `backends`         | 1.1      | 僅內建         | 編譯器 backend 與成品 slot；否則為 `PLUGIN_E_BACKEND_REQUIRES_BUILTIN`。                                               |
| `languageServices` | 1.3      | 僅內建         | 綁定同一擁有者 frontend 的分析／補全等服務；否則為 `PLUGIN_E_LANGUAGE_SERVICE_REQUIRES_BUILTIN`。                      |
| `deviceProviders`  | 1.5      | 宿主 allowlist | 只有 `kobrixa.device-ev3`；否則為 `PLUGIN_E_DEVICE_PROVIDER_REQUIRES_BUILTIN`。                                        |

僅限內建的欄位**即使是空陣列或 `null`** 也會被拒絕，宣告後整個開發插件都會無效。TypeScript 與 Python 共用結構性 JSON Schema 驗證；宿主 registry 另外檢查唯一性、擁有者、副檔名集合相等與可信來源，所以只通過 schema 不代表宿主一定接受。

## 命令與生命週期

JS／TS（[範例](../../plugins/samples/hello-ts/src/index.ts)）：

```ts
import { definePlugin, runPlugin } from "@kobrixa/plugin-sdk";

void runPlugin(
  definePlugin({
    activate(context) {
      context.commands.register("kobrixa-samples.hello-ts.greet", () =>
        context.ui.showMessage(context.locale === "zh-TW" ? "你好" : "Hello"),
      );
    },
  }),
);
```

Python（[範例](../../plugins/samples/hello-python/main.py)）：

```python
from kobrixa import Plugin

plugin = Plugin()


@plugin.command("kobrixa-samples.hello-python.greet")
async def greet(ctx):
    await ctx.ui.show_message("你好" if ctx.locale == "zh-TW" else "Hello")


if __name__ == "__main__":
    plugin.run()
```

通訊協定為 JSON-RPC 2.0：

| 方法               | 方向        | 用途                                                                             |
| ------------------ | ----------- | -------------------------------------------------------------------------------- |
| `initialize`       | 宿主 → 插件 | API 版本、宿主指派的插件 ID、語系（`en`／`zh-TW`）、已授予權限；回傳 SDK 身分。  |
| `command/execute`  | 宿主 → 插件 | 執行貢獻的命令；成功時回傳 `null`。命令不接受參數。                              |
| `$/cancelRequest`  | 宿主 → 插件 | 取消執行中的命令（JS 為 `AbortSignal`，Python 為 task `cancel()`）。             |
| `shutdown`／`exit` | 宿主 → 插件 | 有序停止。                                                                       |
| `ui/showMessage`   | 插件 → 宿主 | 在「設定 → 插件」顯示 `info`／`warning`／`error` 訊息；需要 `ui.notifications`。 |
| `devices/*`        | 插件 → 宿主 | 設備 broker API（API 1.5）；見[設備插件](plugin-devices.md)。                    |
| `events/deliver`   | 宿主 → 插件 | 訂閱事件，例如設備取樣。                                                         |

每個插件都應預期以下生命週期規則：

- 程序在其命令執行時才啟動，而不是在應用程式啟動時。static 插件從不啟動程序。
- 取消有五秒寬限期；未停止的插件會被終止。
- 當機會拒絕所有待處理請求，且**從不重播**。五分鐘內三次程序失敗後，必須停用再啟用插件才能再次啟動（`PLUGIN_E_CRASH_LOOP`）。
- 停用會取消註冊插件的貢獻並停止其程序；重新載入會重新讀取資料夾並重新啟動插件。
- Python 的 stdout 只傳送協定訊息框，日誌請寫入 stderr；建立 `Plugin()` 時會把 `print()` 導向 stderr。日誌只保留在記憶體（每插件 256 KiB、合計 4 MiB），並以 `[plugin <id>] …` 同步輸出到終端機。

## 開發與載入插件

1. 依[範例 README](../../plugins/samples/README.md#準備範例) 準備工具鏈與 SDK。JS／TS 插件要打包成 `runtime.entry` 指定的檔案；Python 插件需要把 SDK 安裝在 Kobrixa 要啟動的直譯器中。
2. 開啟「設定 → 插件」，選「開啟開發者模式」並在原生對話框確認。
3. 選「連結資料夾…」並選擇插件資料夾。連結前 Kobrixa 會預覽 ID、執行環境與 manifest 問題。
4. Python 插件請在「Python 直譯器」選擇直譯器；每個候選都會標示是否已安裝 SDK。
5. 執行命令，開發過程中使用「重新載入」、「查看日誌」、「停用／啟用」與「解除連結」。

也可以用啟動參數在單次執行中略過面板（不會保存）：

```sh
pnpm dev -- --plugin-dev-dir="$PWD/path/to/plugin" --plugin-python="$(command -v python3)"
```

多個資料夾在 macOS／Linux 以 `:` 分隔，Windows 以 `;` 分隔。`--safe-mode` 會在本次執行關閉所有第三方插件。

## 狀態、安全模式與復原

- `<userData>/plugins/state.json` 保存開發者模式、連結的資料夾、Python 選擇、重新啟動後保持停用的來源，以及安全模式鎖。檔案無法讀取時會保持第三方插件關閉，而不是覆寫它（`PLUGIN_E_STATE_CORRUPT`）；寫入失敗回報 `PLUGIN_E_STATE_SAVE`。
- 第三方程序執行期間，或第三方靜態貢獻已送出時，`<userData>/plugins/session.json` 會同步寫入，正常結束時移除。若它在非正常結束後仍存在，或視窗曾停止回應，下次啟動會暫停所有第三方插件並顯示橫幅。
- 安全模式下，內建插件（Basic Plus、EV3 編譯器與設備復原）仍可使用；開發插件可以停用或解除連結，但不能啟用、連結或重新載入（`PLUGIN_E_SAFE_MODE`）。「恢復插件」可結束因鎖定而進入的安全模式，但無法結束 `--safe-mode`。

詳見[架構：插件](architecture.md#插件開發預覽)與[範例：復原](../../plugins/samples/README.md#復原)。

## 常見錯誤碼

| 錯誤碼                                                     | 常見原因                                                             |
| ---------------------------------------------------------- | -------------------------------------------------------------------- |
| `PLUGIN_E_MANIFEST`                                        | manifest 無效、static 執行環境語意錯誤，或同一擁有者的副檔名不一致。 |
| `PLUGIN_E_API_VERSION`                                     | 宿主的 API 版本不符合 `apiVersion`。                                 |
| `PLUGIN_E_*_REQUIRES_BUILTIN`                              | 開發插件宣告了僅限內建的貢獻。                                       |
| `PLUGIN_E_ENTRY`／`PLUGIN_E_LAUNCH`                        | entry 檔不存在，或程序無法啟動。                                     |
| `PLUGIN_E_PYTHON_UNUSABLE`                                 | 選定的直譯器不是 Python 3.10 以上，或無法執行。                      |
| `PLUGIN_E_HANDSHAKE`／`PLUGIN_E_PROTOCOL`                  | `initialize` 失敗，或訊息破壞協定（例如 stdout 混入其他輸出）。      |
| `PLUGIN_E_COMMAND_NAMESPACE`／`PLUGIN_E_DUPLICATE_COMMAND` | 命令 ID 不在插件命名空間內，或重複註冊。                             |
| `PLUGIN_E_PERMISSION_DENIED`                               | 呼叫需要 manifest 未要求的權限。                                     |
| `PLUGIN_E_CANCELLED`／`PLUGIN_E_TIMEOUT`                   | 請求被取消或超過期限。                                               |
| `PLUGIN_E_CRASHED`／`PLUGIN_E_CRASH_LOOP`                  | 程序結束；重複失敗後禁止再啟動。                                     |
| `PLUGIN_E_DEVELOPER_MODE`／`PLUGIN_E_SAFE_MODE`            | 操作需要開發者模式，或在安全模式下被封鎖。                           |
| `PLUGIN_E_STATIC_LANGUAGE*`                                | 見[靜態語言插件](plugin-static-languages.md)。                       |
| `PLUGIN_E_DEVICE_*`                                        | 設備 business result；見[設備插件](plugin-devices.md)。              |

完整清單以 [`packages/plugin-runtime/src/errors.ts`](../../packages/plugin-runtime/src/errors.ts) 與 [`packages/plugin-protocol/src/business-result.ts`](../../packages/plugin-protocol/src/business-result.ts) 為準。

## API 版本

| 版本 | 新增內容                                                                              |
| ---- | ------------------------------------------------------------------------------------- |
| 1.0  | manifest、命令、`ui.notifications`、JS 與 Python SDK。                                |
| 1.1  | 內建編譯器 `frontends`／`backends` 與成品契約。                                       |
| 1.2  | 宿主加註的 `Diagnostic.source` 與 `contributes.diagnosticHelp`。                      |
| 1.3  | 內建 `languageServices`。                                                             |
| 1.4  | `runtime.kind: "static"` 與靜態 `languages`。                                         |
| 1.5  | 設備 broker：`devices.*` 權限、`requires.devices`、`devices/*` RPC、內建 EV3 提供者。 |

相容的 1.x manifest 會持續載入。接下來規劃的是宣告式 UI 面板（1.6）、具型別的設定與有上限的紀錄儲存（1.7），之後再把馬達測試與感測器實驗室遷移到公開 API；在此之前插件無法使用這些 API。設計紀錄見 [`docs/superpowers/specs`](../superpowers/specs/2026-10-14-plugin-system-design.md)，第三階段見[第三階段設計](../superpowers/specs/2026-10-17-plugin-system-stage-3-design.md)。

## 測試

```sh
pnpm test                    # 協定、runtime 與 SDK 單元測試
pnpm test:python-sdk         # Python SDK 的 schema、訊息框與協定測試
pnpm test:plugins:smoke      # 真實 Electron、兩個範例、當機隔離與離開清理
pnpm test:static-languages   # 靜態語言契約與邊界檢查
pnpm test:device-broker      # 設備 broker conformance
```

Python 測試依序尋找 `KOBRIXA_TEST_PYTHON`、`python3` 與 `python`。詳見 [Plugin smoke](../../tests/desktop/README.md#plugin-smoke)。

## 相關文件

- [插件範例](../../plugins/samples/README.md#繁體中文)——TypeScript 與 Python 逐步教學、診斷說明。
- [Python SDK](../../sdks/python/README.md#繁體中文)——安裝、API 與取消。
- [靜態語言插件](plugin-static-languages.md)——文法格式、上限、擁有者規則。
- [設備插件](plugin-devices.md)——權限、動作安全、訂閱、逾時。
- [架構：插件](architecture.md#插件開發預覽)——宿主內部與編譯器契約。
