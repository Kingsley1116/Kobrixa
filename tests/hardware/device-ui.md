# Stage 3 EV3 plugin UI acceptance / 插件設備介面驗收

Status: **NOT RUN / 尚未執行** (S3-14–S3-15). This checklist is not a passing receipt. Earlier EV3 hardware acceptance does not establish acceptance of the Stage 3 plugin migration. Synthetic provider, MessagePort and installed smoke results must be recorded separately.

## Record the tested artifact / 記錄受測成品

For each run record: date, tester, commit, package SHA-256, OS/version/architecture, EV3 firmware, USB or Wi-Fi, sensor types, locale and theme. Use an installed package; retain its logs and screenshots. Do not substitute a development checkout for the installed case.

每次記錄日期、測試人、commit、安裝包 SHA-256、作業系統與架構、EV3 韌體、傳輸方式、感測器型號、語言及主題。使用安裝後的應用程式並保留日誌與截圖；開發模式結果另列。

## Procedure / 步驟

Use a stationary, supported brick with unloaded motors and an accessible physical stop. Preserve the original profile before migration cases. Run English and Traditional Chinese in both themes; repeat transport cases on each supported platform.

使用固定且穩定的 EV3，馬達不接負載，保留可立即停止的實體操作。匯入案例先保留原始 profile。英文及繁體中文各驗證兩種主題；各支援平台分別測 USB 與 Wi-Fi。

| ID  | Action / 操作                                                                                                                                                          | Required observation / 必要結果                                                                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H01 | Open Plugin tools with no device. 開啟插件工具。                                                                                                                       | No automatic discovery, connection or execution. Opening or retrying resources cannot replay a prior command. 不自動搜尋、連線或重播指令。                                          |
| H02 | Explicitly discover and connect via USB; repeat Wi-Fi discovery and address entry. 主動搜尋並以兩種傳輸連線。                                                          | Stable candidate identity; failed connection exits Connecting and permits retry. Discovery does not move motors. 候選身分一致，失敗可重試且不維持連線中。                           |
| H03 | Start Run while disconnected, then connect through the plugin; repeat after cancelling Run and after changing workspace. 先 Run 再透過插件連線，另測取消與切換工作區。 | Only the still-current original intent may execute, once. Cancelled or obsolete intent never executes. 僅目前有效的原始意圖可執行一次。                                             |
| H04 | Use deployment, version checks and remote files after a plugin connection. 連線後部署與操作遠端檔案。                                                                  | These core tools use that same session; no second connection or independent device lock. 共用同一連線，不建立第二鎖。                                                               |
| H05 | Observe empty ports, initialization, unknown devices, null readings, negative angles and multivalue sensors. 觀察空埠及各類讀值。                                      | Actual port/state remains visible; missing samples are unavailable, never zero. Battery/program state belongs to the brick. 不以零替代缺值。                                        |
| H06 | Query/change supported UART modes; try while program runs, recording pins the channel, sensor changes or authority is lost. 在各限制情境切換模式。                     | Fresh identity/state required; stale or prohibited requests do not write. No calibration/internal modes or automatic program stop. 舊身分與禁止操作不得寫入。                       |
| H07 | Hide/close device panel while Lab records; reopen. 記錄時隱藏或關閉設備面板。                                                                                          | Only that panel's demand stops; recording continues. Reopen observes current state without reconnecting. 僅解除自己的取樣需求。                                                     |
| H08 | Disconnect normally with active motion/recording; inject save or stop failure in a separate controlled test. 活動中正常斷線，另測停止或保存失敗。                      | Host stops and saves before disconnect. Failure remains visible and blocks normal completion; no false success. 不把失敗回報成功。                                                  |
| H09 | Unplug/replug USB during pending work; exercise retry-limit and cancel recovery. 待處理操作中拔插 USB。                                                                | Old replies cannot revive old sessions or Run. Recovery cancel works through the host action. 恢復連線不重播執行。                                                                  |
| H10 | Suspend/resume the OS with a plugin-created connection. 插件連線後讓系統休眠與喚醒。                                                                                   | Stop/save includes this session; resume does not reconnect or replay work automatically. 此連線也必須停止與保存。                                                                   |
| H11 | Migrate a profile with all nine nondefault legacy preferences; restart, retry and open a replacement window. 匯入九個非預設偏好並重啟／重試。                          | One combined authoritative commit; old writers stay frozen; retries do not overwrite newer settings. Forget-address clears the address in the same revision. 不重複匯入或覆寫新值。 |
| H12 | Toggle the three optional plugins individually and all off; restart and launch a second instance. 各別與全部停用並重啟／開第二程序。                                   | Choices persist; compiler/core management remain usable. No hidden optional connection; second instance does not own a second provider/profile writer.                              |
| H13 | Crash/freeze renderer or plugin during pending work in a controlled fixture. 受控情境使 renderer 或插件失效。                                                          | Main safety and visible recovery remain available; late messages cannot revive retired owners. Provider and consumer lifetimes remain distinct.                                     |
| H14 | Keyboard-only focus, IME input, labels, errors and recovery controls in both locales/themes. 以鍵盤與中文輸入法操作。                                                  | Focus is recoverable, composition does not submit early, errors remain readable, controls have meaningful accessible names.                                                         |

## Result record / 結果表

| Artifact / 成品 | Platform / 平台 | Transport / 傳輸 | Cases / 案例 | PASS / FAIL / NOT RUN | Evidence / 證據 |
| --------------- | --------------- | ---------------- | ------------ | --------------------- | --------------- |
| Not supplied    | Not run         | Not run          | H01–H14      | NOT RUN               | None            |

A failure records the exact step, expected/actual result and logs. Repeat after a fix against the new artifact identity. Do not infer Windows/macOS results from Linux, hardware results from fake providers, or accessibility results from unit tests.

失敗須記錄確切步驟、預期與實際結果及日誌；修正後以新成品身分重驗。Linux、模擬 provider 或單元測試不得替代其他平台、實體硬體或無障礙驗收。

## Final-candidate record / 最終成品紀錄

H1–H6 and S3-13–S3-15 remain **NOT RUN / 尚未執行**. Use the final regression-tested artifact after its automated/platform gates; no final candidate is certified by this checklist. Record tester/date, full commit and dirty state, installer **and executable** SHA-256, OS/version/architecture, Electron/runtime, EV3 firmware, transport, sensor/motor/load, locale/theme, case, actual result and logs/screenshots/video. Repeat platform-specific USB/Wi-Fi cases on Windows x64, macOS arm64 and Linux x64; an untested platform remains open. Windows device execution/recovery first needs verified Windows journal durability and packaging, not a successful prototype alone.

依 [Stage 3 H1–H6 procedures](../../docs/superpowers/specs/2026-10-17-plugin-system-stage-3-design.md#s3-human-checklist) 使用最終完成回歸測試的成品，逐筆記錄測試人／日期、完整 commit 與 dirty 狀態、安裝包及執行檔雜湊、OS／架構、runtime、韌體、硬體／負載、語系／主題、案例與原始結果。未測平台保持未執行；Windows 先完成 Windows journal 持久性及封裝證據。既有 stage-2 V01–V04 不變。

Append each named result after execution; preserve earlier failures and identify the corrected artifact on rerun. Stop requested, host readback and physical stop are separate observations. Native fake-provider/AX output cannot sign physical stopping, screen-reader speech or clean-machine usability. Do not prefill PASS.
