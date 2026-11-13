# macOS installed synthetic host under OS isolation

Observed 2026-10-23 on macOS arm64. `KOBRIXA_PLUGIN_FIXTURE_BUILD=1 node tools/release/build-desktop.mjs` and `node tests/desktop/builtin-process-installed.mjs --isolated` both exited 0. The actual release payload was copied into the separately identified synthetic installed host; no product installation was modified. Baseline f69f472 plus the recorded observer changes, correctly marked dirty. Emitted host/payload identities are preserved.

The installed executable ran under `/usr/bin/sandbox-exec` with network access and the complete checkout denied by the OS, in an unrelated cwd with empty PATH and no NODE_PATH. In all three runs the actual host observed EPERM when opening a known existing source file, opening a known existing workspace dependency and connecting to a live local listener. Healthy payload: real installed resolver/utilityProcess/MessagePort/SDK executed, process 69735 exited, no remaining consumer PID. Missing and corrupted payloads were rejected before launch. Both receipt/helper tests passed without skips.

The logs contain Chromium child sandbox initialization warnings under the outer test sandbox. The tested host and plugin transport still completed; this receipt does **not** establish production GUI rendering, a physical clean-machine installation, other OS/architectures, or hardware behavior. No `--no-sandbox` or weakened application setting was used. Original gzip bytes and uncompressed hashes are retained.

The first observer attempt failed before execution because it assumed a root-hoisted zod dependency. The corrected observer resolves the desktop package dependency using Node resolution; this is not a product fix. Normal production packaged smoke remains a separate gate.
