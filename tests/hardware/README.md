# Manual EV3 acceptance

These scripts operate on a connected EV3 and are excluded from `pnpm test` and CI.
Build the packages first with `pnpm -r --filter='./packages/**' --filter='./frontends/**' build`.
Run commands from the repository root.

| Script             | Purpose                                                                          | Invocation                                                           |
| ------------------ | -------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `run.mjs`          | USB or Wi-Fi artifact upload/run/stop/delete smoke check                         | `pnpm test:hardware -- --transport=usb --artifact=/path/program.rbf` |
| `certify.mjs`      | Execute original example RBF images and record firmware completion               | `node tests/hardware/certify.mjs [project/path ...]`                 |
| `fixture.mjs`      | Checks for a specific touch, sync, motor, I2C, rover or button setup             | `node tests/hardware/fixture.mjs <mode> [phase]`                     |
| `new-examples.mjs` | Run selected examples and compare EV3 readback with `fixtures/new-examples.json` | `node tests/hardware/new-examples.mjs [project/path ...]`            |

Project paths are relative to `examples/`. The hardware plan is separate from the
offline VM expectations because it describes actual sensor inputs and RAM readback.

Read [the hardware acceptance notes](../../examples/HARDWARE-ACCEPTANCE.md) before
running a script; they describe port assignments, required fixture states and motor
restrictions. Firmware completion does not establish visual or audio correctness.

The three example-checking scripts currently default to dated report paths under
`docs/audits/`; create that directory before running them. `EV3_CERT_REPORT` and
`EV3_NEW_REPORT` override the report files for `certify.mjs` and `new-examples.mjs`.
The smoke check writes JSON to stdout unless `--output=/path/result.json` is set.

## Pixy2 readback / Pixy2 讀取驗證

Open [fixtures/pixy2-signature.bp](fixtures/pixy2-signature.bp) directly in Kobrixa and build/run it with the corrected compiler. It only reads the camera and draws the screen. Connect Pixy2 to input 1, select LEGO I2C in PixyMon, and teach signature 2 (or edit `port` and `signature`). Point at the taught object and check Count, X/Y and W/H; move it horizontally and vertically and confirm the corresponding coordinate changes. Remove the object and check Count returns to zero. Press the EV3 Enter button to exit. Zero values alone do not distinguish a missing object from a connection/configuration problem. This fixture has not yet been verified on hardware.

在 Kobrixa 直接開啟 [fixtures/pixy2-signature.bp](fixtures/pixy2-signature.bp)，使用修正後的編譯器重新建置並執行。程式只讀取相機和更新畫面。將 Pixy2 接到輸入埠 1，在 PixyMon 選擇 LEGO I2C，並教導 signature 2（也可修改 `port` 和 `signature`）。對準已教導的物件，檢查 Count、X/Y、W/H；左右和上下移動物件，確認對應座標改變。移開物件後，Count 應回到零。按 EV3 Enter 鍵結束。全部為零仍可能是沒有偵測到物件或連線／設定問題，不能單憑零值判斷。此測試程式尚未完成實機驗證。
