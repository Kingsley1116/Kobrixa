# Plugin samples (development preview)

These samples contribute a greeting command and display a message in Settings → Plugins. They demonstrate trusted local plugins, not Python or TypeScript compilation for EV3. Plugin permissions restrict calls through Kobrixa; they are not an operating-system sandbox.

## Run from a checkout

Use Node.js 24 or newer, pnpm 10.15.0 and Python 3.10 or newer with pip. From the repository root, run the following in a macOS/Linux shell. If Python requires a virtual environment, activate it first so installation and launch use the same interpreter.

```sh
pnpm install && pnpm build:core
npx esbuild plugins/samples/hello-ts/src/index.ts --bundle --platform=node --format=cjs \
  --tsconfig=tsconfig.base.json --outfile=plugins/samples/hello-ts/dist/index.cjs
python3 -m pip install -e sdks/python
pnpm dev -- --plugin-dev-dir="$PWD/plugins/samples/hello-ts:$PWD/plugins/samples/hello-python" \
  --plugin-python="$(command -v python3)"
```

`--tsconfig=tsconfig.base.json` supplies the workspace mapping for `@kobrixa/plugin-sdk`. The bundle output matches the TypeScript manifest's `runtime.entry`. Use one `--` separator after the root `pnpm dev`: pnpm forwards it through the nested script, and Electron Forge passes the following switches to Electron.

`--plugin-dev-dir` accepts one list of plugin folders, each containing `kobrixa-plugin.json`: the separator is `:` on macOS/Linux and `;` on Windows. Quote the entire value, use absolute paths, and point `--plugin-python` at the interpreter where the SDK is installed. The commands above use POSIX shell syntax; Windows paths must be separated with `;` and supplied using the syntax of your shell.

Open Settings → Plugins. Both samples should be enabled; their processes start when you click **Say hello**. The corresponding command IDs are:

- `kobrixa-samples.hello-ts.greet` — `hello-ts/src/index.ts`, bundled to `hello-ts/dist/index.cjs`.
- `kobrixa-samples.hello-python.greet` — `hello-python/main.py`, using `from kobrixa import Plugin`.

Both manifests request `ui.notifications` and declare the matching `onCommand:<command-id>` activation event. The greeting uses the host locale received at startup (`en` or `zh-TW`) and appears under **Messages from plugins** with the plugin ID.

Plugin logs appear in the main process's terminal/console, such as the terminal running `pnpm dev`, with a `[plugin <id>] ` prefix on each line. This includes JS/TS stdout/stderr and Python stderr. Constructing `Plugin()` redirects Python `print()` to stderr, including top-level prints before `run()`; use stderr explicitly for any logs before construction.

Use **Disable** to stop a sample and remove its commands; **Enable** makes them available again. The choice persists in `<userData>/plugins/state.json`. For recovery, add `--safe-mode` to the launch command: development plugins stay off for that session, while built-in Basic Plus stays enabled. Use **Keep disabled after restart** for a problem plugin, then restart without `--safe-mode`. A crash never replays a command; three process failures within five minutes require disabling and enabling the plugin before another start.

## Launch a packaged app on macOS

After preparing the samples above, quit any running Kobrixa instance. A packaged app containing phase 1 can load the same development directories. From the repository root:

```sh
open -a Kobrixa --args \
  --plugin-dev-dir="$PWD/plugins/samples/hello-ts:$PWD/plugins/samples/hello-python" \
  --plugin-python="$(command -v python3)"
```

Explicit development-directory loading is still required in a packaged app. Python must be installed locally with the SDK; Kobrixa does not download or manage the interpreter. Python stdout carries only protocol messages; write logs to stderr. See the [Python SDK](../../sdks/python/README.md) and [plugin architecture](../../docs/en/architecture.md#plugins-development-preview).

## 繁體中文

這兩個範例會提供問候命令，並在「設定 → 插件」顯示訊息。它們示範可信任的本機插件，不提供將 Python 或 TypeScript 編譯至 EV3 的功能。插件權限只限制透過 Kobrixa 的呼叫，並不是作業系統沙箱。

### 從原始碼執行

請使用 Node.js 24 以上、pnpm 10.15.0，以及具備 pip 的 Python 3.10 以上版本。在儲存庫根目錄，以 macOS／Linux shell 執行以下命令。如果 Python 要求使用虛擬環境，請先啟用該環境，讓安裝與啟動使用同一個直譯器。

```sh
pnpm install && pnpm build:core
npx esbuild plugins/samples/hello-ts/src/index.ts --bundle --platform=node --format=cjs \
  --tsconfig=tsconfig.base.json --outfile=plugins/samples/hello-ts/dist/index.cjs
python3 -m pip install -e sdks/python
pnpm dev -- --plugin-dev-dir="$PWD/plugins/samples/hello-ts:$PWD/plugins/samples/hello-python" \
  --plugin-python="$(command -v python3)"
```

`--tsconfig=tsconfig.base.json` 提供 `@kobrixa/plugin-sdk` 的 workspace 路徑對應。輸出檔案符合 TypeScript manifest 的 `runtime.entry`。根目錄 `pnpm dev` 後使用一個 `--` 分隔符：pnpm 會經由巢狀腳本保留此分隔符，Electron Forge 再將後續開關傳至 Electron。

`--plugin-dev-dir` 接受一份插件資料夾清單，每個資料夾都必須含有 `kobrixa-plugin.json`：macOS／Linux 以 `:` 分隔，Windows 使用 `;`。請以引號包住完整參數值，使用絕對路徑，並將 `--plugin-python` 指向已安裝 SDK 的直譯器。上述命令使用 POSIX shell 語法；Windows 路徑必須以 `;` 分隔，並依使用的 shell 語法傳入。

開啟「設定 → 插件」。兩個範例應顯示為已啟用；按下「打招呼」才會啟動程序。對應的命令 ID 如下：

- `kobrixa-samples.hello-ts.greet`：原始碼為 `hello-ts/src/index.ts`，打包至 `hello-ts/dist/index.cjs`。
- `kobrixa-samples.hello-python.greet`：入口為 `hello-python/main.py`，使用 `from kobrixa import Plugin`。

兩份 manifest 都要求 `ui.notifications` 權限，並宣告對應的 `onCommand:<command-id>` 啟用事件。問候訊息使用啟動時從宿主收到的語系（`en` 或 `zh-TW`），並附上插件 ID，顯示於「插件訊息」。

插件日誌會顯示在主程序的終端機／主控台，例如執行 `pnpm dev` 的終端機，每行都加上 `[plugin <id>] ` 前綴。這包含 JS／TS 的 stdout／stderr 與 Python 的 stderr。建立 `Plugin()` 時，Python 的 `print()` 便會導向 stderr，包含呼叫 `run()` 之前的頂層輸出；建立實例之前的日誌則須明確寫入 stderr。

按下「停用」會停止範例並移除其命令；按下「啟用」即可再次使用。選擇會保存在 `<userData>/plugins/state.json`。需要復原時，在啟動命令加上 `--safe-mode`：本次執行的開發插件會保持停用，內建 Basic Plus 則保持啟用。對有問題的插件選取「重新啟動後也保持停用」，再移除 `--safe-mode` 重新啟動。當機不會重播命令；五分鐘內發生三次程序失敗後，必須停用再啟用插件，才能再次啟動。

### 在 macOS 啟動已封裝的應用程式

依上述步驟準備範例後，先結束所有執行中的 Kobrixa。包含第一階段功能的已封裝應用程式可載入相同的開發目錄。在儲存庫根目錄執行：

```sh
open -a Kobrixa --args \
  --plugin-dev-dir="$PWD/plugins/samples/hello-ts:$PWD/plugins/samples/hello-python" \
  --plugin-python="$(command -v python3)"
```

已封裝的應用程式仍須明確指定開發目錄。必須在本機安裝 Python 與 SDK；Kobrixa 不下載或管理直譯器。Python stdout 只傳送協定訊息，日誌請寫入 stderr。詳見 [Python SDK](../../sdks/python/README.md) 與[插件架構](../../docs/zh-TW/architecture.md#插件開發預覽)。
