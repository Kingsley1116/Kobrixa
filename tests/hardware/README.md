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

Before running a script, check each example's README for port assignments, required
fixture states and motor restrictions. Firmware completion does not establish visual or
audio correctness.

The three example-checking scripts currently default to dated report paths under
`docs/audits/`; create that directory before running them. `EV3_CERT_REPORT` and
`EV3_NEW_REPORT` override the report files for `certify.mjs` and `new-examples.mjs`.
The smoke check writes JSON to stdout unless `--output=/path/result.json` is set.

## Pixy2 readback / Pixy2 讀取驗證

Open [fixtures/pixy2-signature.bp](fixtures/pixy2-signature.bp) directly in Kobrixa and build/run it with the corrected compiler. It only reads the camera and draws the screen. Connect Pixy2 to input 1, select LEGO I2C in PixyMon, and teach signature 2 (or edit `port` and `signature`). Point at the taught object and check Count, X/Y and W/H; move it horizontally and vertically and confirm the corresponding coordinate changes. Remove the object and check Count returns to zero. Press the EV3 Enter button to exit. Zero values alone do not distinguish a missing object from a connection/configuration problem. This fixture has not yet been verified on hardware.

在 Kobrixa 直接開啟 [fixtures/pixy2-signature.bp](fixtures/pixy2-signature.bp)，使用修正後的編譯器重新建置並執行。程式只讀取相機和更新畫面。將 Pixy2 接到輸入埠 1，在 PixyMon 選擇 LEGO I2C，並教導 signature 2（也可修改 `port` 和 `signature`）。對準已教導的物件，檢查 Count、X/Y、W/H；左右和上下移動物件，確認對應座標改變。移開物件後，Count 應回到零。按 EV3 Enter 鍵結束。全部為零仍可能是沒有偵測到物件或連線／設定問題，不能單憑零值判斷。此測試程式尚未完成實機驗證。

## USB unplug/replug recovery / USB 拔插自動恢復

Use the desktop app with a display-only program, including a deployed image or sound
asset when testing verification. The automated tests use simulated HID and EV3
sessions; they do not establish physical USB behavior on any platform.

1. Manually connect one EV3 over USB and run the program. Unplug while idle after
   the Run command: the app must show **Waiting for USB** without an error dialog.
   The program on the EV3 must not restart or stop because of reconnection.
2. While unplugged, edit, save and build locally. Run/upload/stop must be unavailable;
   no operation may be queued for execution when the cable returns.
3. Reinsert the same EV3, including through a different USB port. After the OS
   exposes it, allow one retry interval (up to five seconds) plus file verification.
   The connection must recover without Find/Connect. **Run uploaded version** must
   return only after the executable and all deployed assets match. Press it explicitly
   to confirm the new session works.
4. Repeat several quick unplug/replug cycles and unplug during verification.
   Confirm recovery remains possible and no stale success or duplicate Run appears.
5. Unplug during an upload or file operation. The operation must end, release its
   lock and never resume automatically. A partial deployment must not regain an
   uploaded-version action. Separately verify that a local Build continues through
   cable removal and reinsertion.
6. Change or remove a deployed resource on the EV3 while disconnected. Reconnect:
   the connection should work, but the app must request another upload. Merely
   rebuilding the local project while offline must not invalidate an unchanged
   program already on the EV3.
7. Insert another EV3 while waiting for the original. It must not be adopted. With
   multiple devices, verify only the unique matching serial is used. Missing or
   duplicate serials require manual selection.
8. Cancel reconnection while waiting and while a connection is being opened; replug
   must not reconnect. Also test intentional Disconnect, selecting Wi-Fi after
   cancelling, window close/reopen, and app quit/relaunch. A fresh window requires
   a fresh manual connection; Wi-Fi does not automatically reconnect.
9. Repeat key steps in English and Traditional Chinese. The toolbar and device panel
   must agree, and the remote file panel must reload using the replacement session.

首次手動連線後，拔線應顯示「等待 USB 插回」，期間可以編輯、儲存及建置。
插回同一台 EV3 後自動恢復連線，校驗已上傳程式與全部素材後才恢復執行按鈕。
插線本身不會重新執行程式；傳輸中斷不會自動續傳。取消等待或手動中斷後，
不應再自動連線。請另行驗證不同 USB 插口、快速拔插、多台 EV3、視窗關閉和
兩種介面語言，並分平台記錄結果。

| Platform | OS / app revision / EV3 firmware / serial | Hardware result |
| -------- | ----------------------------------------- | --------------- |
| macOS    | Record when tested                        | Not yet tested  |
| Windows  | Record when tested                        | Not yet tested  |
| Linux    | Record when tested                        | Not yet tested  |

## Sensor lab / 曲線與校正

See [the sensor lab physical checklist](sensor-lab.md) for USB/Wi-Fi SI fractions, calibration, background recording, persistence and interruption acceptance. All sensor lab hardware checks remain pending.

## Live monitor / 即時監測

Run the desktop app with the reference EV3, one Color, Gyro and Infrared sensor, and an unloaded motor whose shaft can be turned safely by hand. Connect through USB, then repeat through Wi-Fi. Record exact port assignments, sensor types, firmware, operating system and application revision. No automated monitor smoke result establishes physical acceptance.

1. Open **EV3 tools → Monitor**. Check battery percentage and voltage against the brick's battery information. Confirm empty ports are not zero-valued sensors and a motor rotated backwards shows a negative angle without resetting its existing count.
2. With the user program stopped, select each offered Color mode and confirm its name, unit and changing readings. Modes must exclude internal/calibration choices. Verify IR multi-channel readings, including unavailable channels, and Gyro initialization/readings. Touch and third-party/I2C devices must remain read-only; their readings may be unavailable when unsupported.
3. Start a display-only program directly from the EV3. The panel must show the brick's running program status and disable mode changes. Stop it from the brick and verify controls return only after a stopped sample. The monitor must never start, stop or attribute that program to the open project.
4. With no sensor lab recording active, while a read is pending, switch to Connection/EV3 files/Activity, close the tools panel, or hide/minimize the window. Future samples must stop; the connection and program must remain active. Reopen Monitor to obtain fresh values. Switching back must not apply a stale reply or silently change a sensor mode.
5. During monitoring, explicitly upload/run/stop a display-only program, list files and start a batch with a conflict confirmation. Foreground work must proceed, readings must show paused/stale state, and monitoring must resume after the operation or confirmation finishes. Sampling must not add operation-log entries.
6. Unplug USB during a read, then replug the same brick. Confirm recovery resumes sampling through the replacement session, ignores old readings and reloads available modes after sensor replacement. Repeat sensor unplug/replug while connected, and repeat Wi-Fi disconnect/manual reconnect. No mode is automatically restored and no program is automatically run.
7. Check English and Traditional Chinese, dark/light themes, the minimum 320 px tools-panel width and 125% UI scale. Keep typing and undoing in the editor while readings change; focus, model content and cursor must remain intact.

以 Color、Gyro、Infrared 感測器及可安全手動旋轉的未負載馬達，分別驗證 USB 與 Wi-Fi。記錄埠位、感測器、韌體、作業系統與應用程式版本；比對電量、馬達負角度與感測器值，從 EV3 本體啟動／停止程式以驗證模式切換限制。未記錄時，切換分頁、隱藏視窗或關閉工具面板後應停止後續取樣；上傳、檔案批次及確認期間讓前景操作優先。USB 恢復與感測器熱拔插後不得採用舊資料、自動還原模式或重新啟動程式。另驗證雙語、深淺主題、320 px 側欄、125% 縮放，以及取樣期間的編輯與復原操作。

| Platform | Transport | OS / app revision / EV3 firmware / sensor setup | Monitor result |
| -------- | --------- | ----------------------------------------------- | -------------- |
| macOS    | USB       | Record when tested                              | Not yet tested |
| macOS    | Wi-Fi     | Record when tested                              | Not yet tested |
| Windows  | USB       | Record when tested                              | Not yet tested |
| Windows  | Wi-Fi     | Record when tested                              | Not yet tested |
| Linux    | USB       | Record when tested                              | Not yet tested |
| Linux    | Wi-Fi     | Record when tested                              | Not yet tested |

Implementation check on 2026-10-04: macOS 15.7.3, `ev3-monitor` worktree based on
`0ac12c1`. USB discovery returned no EV3 devices, and no Wi-Fi brick was available
for this run. The protocol fixtures, scheduler tests and Electron monitor smoke
are offline checks; none of the hardware rows above has passed yet.

2026-10-04 實作驗證：macOS 15.7.3，基於 `0ac12c1` 的 `ev3-monitor` worktree。
USB 搜尋未找到 EV3，本次也沒有可驗證的 Wi-Fi 主機。協定 fixture、排程測試與
Electron 監測 smoke 均屬離線驗證；上表所有 USB／Wi-Fi 實機項目仍待驗收。
