# Python SDK (development preview)

`kobrixa-plugin-sdk` provides the `kobrixa` module for trusted local Python plugins. It requires Python 3.10 or newer and uses only the standard library at runtime. Phase 1 supports development-directory loading with a developer-selected interpreter; Kobrixa does not download or manage Python.

## Install and launch

From the repository root, install the SDK into the same interpreter environment that Kobrixa will launch. Activate a virtual environment first if your Python installation requires one. In a macOS/Linux shell:

```sh
python3 -m pip install -e sdks/python
pnpm dev -- --plugin-dev-dir="$PWD/plugins/samples/hello-python" \
  --plugin-python="$(command -v python3)"
```

The checkout also needs Node.js 24 or newer, pnpm 10.15.0 and installed workspace dependencies; follow the [sample setup](../../plugins/samples/README.md). The editable install uses the setuptools build backend declared in `pyproject.toml` and includes the committed protocol schema. It is a development SDK install, not a packaged-plugin installer.

Alternatively, expose the SDK source to the interpreter instead of installing it. Run this before the same launch command in the same shell:

```sh
export PYTHONPATH="$PWD/sdks/python${PYTHONPATH:+:$PYTHONPATH}"
```

This environment variable configures Python imports only; plugin identity, locale and granted permissions arrive through the protocol handshake. On Windows, use `;` between paths in `PYTHONPATH` and `--plugin-dev-dir`, and use your shell's environment-variable syntax. Always select the intended Python executable with `--plugin-python`.

In Settings → Plugins, run the Python sample's **Say hello** command and check **Messages from plugins**. Use **Disable** or **Enable** to control the sample. See the [samples README](../../plugins/samples/README.md) for both languages, packaged macOS launch and safe-mode recovery.

## Minimal plugin

The [Python sample manifest](../../plugins/samples/hello-python/kobrixa-plugin.json) declares `runtime.kind: "python"`, `runtime.entry: "main.py"`, the command below, its `onCommand:` activation event and the `ui.notifications` permission. Its entry point is:

```python
from kobrixa import Plugin

plugin = Plugin()


@plugin.command("kobrixa-samples.hello-python.greet")
async def greet(ctx):
    message = "來自 Python 插件的問候" if ctx.locale == "zh-TW" else "Hello from a Python plugin"
    await ctx.ui.show_message(message)


if __name__ == "__main__":
    plugin.run()
```

Keep the manifest and registered command IDs in agreement. Each command ID must begin with the manifest's plugin ID followed by `.`. `Plugin()` takes no plugin ID argument: the host supplies identity during `initialize`.

Command handlers must be `async def` functions. Their context exposes `plugin_id`, `locale` (`en` or `zh-TW`) and `ui.show_message(message, severity="info")`; supported severities are `info`, `warning` and `error`. Await message requests, which require the manifest's `ui.notifications` permission. Handlers have no command arguments in phase 1, and successful execution returns `null` on the wire.

## Protocol and cancellation

`plugin.run()` serves JSON-RPC 2.0 over stdin/stdout using `Content-Length` frames. Stdout is reserved for the protocol; write logs to stderr, including before calling `run()`. During `run()`, the SDK redirects Python `print()` output to stderr, but direct writes to the stdout file descriptor can still corrupt the protocol.

The SDK handles `initialize`, `command/execute`, `shutdown`, `exit` and `$/cancelRequest`, and sends `ui/showMessage` requests to the host. Wire objects use ordinary dictionaries and are validated against the bundled `kobrixa/plugin-protocol.schema.json`; there are no generated Python type bindings. The host binds identity to the channel, and the SDK validates the same shared valid/invalid cases as the TypeScript protocol tests.

Cancellation calls `cancel()` on the command's asyncio task. Use await points and let `asyncio.CancelledError` propagate after cleanup; blocking synchronous work cannot receive cooperative cancellation until it yields. The host terminates a process that does not finish within the cancellation grace period. Commands are never replayed after a crash. Three process failures within five minutes stop further starts until the plugin is disabled and enabled again.

Load only trusted plugins. The `ui.notifications` permission controls calls through Kobrixa and does not sandbox Python's filesystem or network access.

## Verify the SDK

From the repository root:

```sh
pnpm test:python-sdk
pnpm test:plugins:smoke
```

Both runners try `KOBRIXA_TEST_PYTHON`, then `python3` and `python`, selecting the first Python 3.10-or-newer interpreter. The variable must name an executable, without extra arguments. Both set `PYTHONPATH` to the SDK source, so these tests do not require an editable install. The SDK runner covers shared schema cases, framing and protocol behavior; it skips locally if Python is unavailable and fails in CI. The plugin smoke requires Python and exercises real Electron, both sample plugins, crash isolation and quit cleanup. See [Plugin smoke](../../tests/desktop/README.md#plugin-smoke).

## 繁體中文

`kobrixa-plugin-sdk` 提供 `kobrixa` 模組，供可信任的本機 Python 插件使用。它需要 Python 3.10 以上，執行時只使用標準函式庫。第一階段支援從開發目錄載入，並使用開發者指定的直譯器；Kobrixa 不下載或管理 Python。

### 安裝與啟動

在儲存庫根目錄，將 SDK 安裝到 Kobrixa 將啟動的同一個直譯器環境。如果 Python 安裝要求虛擬環境，請先啟用該環境。在 macOS／Linux shell 執行：

```sh
python3 -m pip install -e sdks/python
pnpm dev -- --plugin-dev-dir="$PWD/plugins/samples/hello-python" \
  --plugin-python="$(command -v python3)"
```

原始碼環境另需 Node.js 24 以上、pnpm 10.15.0 與已安裝的 workspace 相依套件；請依照[範例設定步驟](../../plugins/samples/README.md)準備。可編輯安裝使用 `pyproject.toml` 宣告的 setuptools 建置後端，並包含已提交的協定 schema。這是開發用 SDK 安裝，不是插件封裝安裝器。

也可以不安裝 SDK，改讓直譯器直接載入原始碼。在同一個 shell 執行以下命令，再使用相同的啟動命令：

```sh
export PYTHONPATH="$PWD/sdks/python${PYTHONPATH:+:$PYTHONPATH}"
```

此環境變數只設定 Python 匯入路徑；插件身分、語系與已授予權限均透過協定握手傳入。Windows 的 `PYTHONPATH` 與 `--plugin-dev-dir` 路徑清單使用 `;` 分隔，環境變數則依使用的 shell 語法設定。請一律以 `--plugin-python` 指定要使用的 Python 執行檔。

在「設定 → 插件」執行 Python 範例的「打招呼」命令，並檢查「插件訊息」。使用「停用」或「啟用」控制範例。兩種語言的範例、macOS 已封裝版本啟動方式與安全模式復原步驟，詳見[範例 README](../../plugins/samples/README.md)。

### 最小插件

[Python 範例 manifest](../../plugins/samples/hello-python/kobrixa-plugin.json) 宣告了 `runtime.kind: "python"`、`runtime.entry: "main.py"`、上述英文段落程式碼中的命令、其 `onCommand:` 啟用事件，以及 `ui.notifications` 權限。入口程式碼與英文段落相同。

manifest 與程式註冊的命令 ID 必須一致。每個命令 ID 都必須以 manifest 的插件 ID 加上 `.` 開頭。`Plugin()` 不接受插件 ID 參數；身分由宿主在 `initialize` 時提供。

命令處理函式必須使用 `async def`。其 context 提供 `plugin_id`、`locale`（`en` 或 `zh-TW`）及 `ui.show_message(message, severity="info")`；支援的嚴重程度為 `info`、`warning` 與 `error`。訊息請求必須使用 `await`，且 manifest 必須要求 `ui.notifications` 權限。第一階段的命令不接受命令參數，執行成功時在通訊層回傳 `null`。

### 協定與取消

`plugin.run()` 透過 stdin／stdout 與 `Content-Length` 訊息邊界處理 JSON-RPC 2.0。stdout 專用於協定；包含呼叫 `run()` 之前的日誌，都應寫入 stderr。執行 `run()` 期間，SDK 會將 Python `print()` 的輸出導向 stderr，但直接寫入 stdout 檔案描述元仍可能破壞協定。

SDK 處理 `initialize`、`command/execute`、`shutdown`、`exit` 與 `$/cancelRequest`，並向宿主傳送 `ui/showMessage` 請求。通訊物件使用一般字典，依隨附的 `kobrixa/plugin-protocol.schema.json` 驗證；不產生 Python 型別綁定。宿主將身分綁定至通道，SDK 也會驗證與 TypeScript 協定測試共用的有效／無效案例。

取消會對命令的 asyncio 工作呼叫 `cancel()`。請使用可讓出執行權的 await 點，並在清理後讓 `asyncio.CancelledError` 繼續傳遞；阻塞的同步工作必須先讓出執行權，才能接收合作式取消。若請求未在取消寬限期內結束，宿主會終止程序。當機後不會重播命令。五分鐘內發生三次程序失敗，就會停止後續啟動，直到將插件停用後再啟用。

請只載入可信任的插件。`ui.notifications` 權限控制透過 Kobrixa 的呼叫，並不會以沙箱限制 Python 對檔案系統或網路的存取。

### 驗證 SDK

在儲存庫根目錄執行：

```sh
pnpm test:python-sdk
pnpm test:plugins:smoke
```

兩個執行器都依序嘗試 `KOBRIXA_TEST_PYTHON`、`python3` 與 `python`，選用第一個符合 Python 3.10 以上要求的直譯器。環境變數必須指定執行檔，不可夾帶額外參數。兩者都將 `PYTHONPATH` 設為 SDK 原始碼目錄，因此測試不需要可編輯安裝。SDK 執行器涵蓋共用 schema 案例、訊息邊界與協定行為；本機缺少 Python 時會略過，CI 則會失敗。插件 smoke 必須具備 Python，會驗證真實 Electron、兩個範例插件、當機隔離與離開時的清理。詳見 [Plugin smoke](../../tests/desktop/README.md#plugin-smoke)。
