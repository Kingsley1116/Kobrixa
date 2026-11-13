# Sensor lab physical acceptance / 曲線與校正實機驗收

Stage 3 status (2026-11-11): **NOT RUN / 尚未執行** (S3-14–S3-15). Use **Plugin tools → Sensor Lab / 插件工具 → 感測器工具**; the private Lab panel/recorder is removed. The dated baseline below is retained. The maintainer’s 2026-10-12 confirmation for the earlier implementation does not sign this public-plugin migration.

Stage 3 請使用公開插件路徑；舊 Lab 面板／recorder 已撤除。以下歷史基準與先前實機確認不能代簽本次遷移。

Status on 2026-10-05: **NOT RUN / 尚未執行**. Implementation checks use simulated transports, the bytecode VM and Electron smoke. No sensor lab hardware result is claimed.

Record application revision, OS, EV3 firmware, connection, sensor type, port and mode. Repeat every row over **USB and Wi-Fi** with Color reflected light, Gyro and Ultrasonic sensors. Use an unloaded motor and turn its shaft by hand when checking angles; no motor-drive command is required.

| Check / 項目               | Expected / 預期                                                                                                                                                                                                        | USB     | Wi-Fi   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------- |
| Raw SI / 原始 SI           | Compare monitor, exported raw CSV and a generated `ReadSIValue` program at stable inputs. Check Ultrasonic fractions and cm/in units, Gyro signed angles/rate, Color reflected %. / 比對穩定輸入、小數及單位。         | Not run | Not run |
| Calibration / 校正         | Capture two known points; check 0–100, reversed targets, raw-only zero and two-point zero. Generated program and tool agree within float32/display precision. Motor count is not reset. / 驗證正反向、歸零與程式結果。 | Not run | Not run |
| Four channels / 四通道     | Record three sensors and motor; common elapsed time, separate Y axes. Sampling interval includes response time plus 500 ms. / 檢查時間與採樣間隔。                                                                     | Not run | Not run |
| Background / 背景          | Switch tabs, collapse panel, minimize and restore; recording continues, plugin status Stop ends it, editor focus/undo survive. / 背景持續，插件狀態區可停止。                                                          | Not run | Not run |
| Foreground work / 前景操作 | Explicitly upload/run/stop a display-only program and browse/transfer files. Operations proceed first; busy gaps do not contain repeated/zero readings. / 操作優先且缺值留白。                                         | Not run | Not run |
| Source changes / 來源變更  | Unplug selected sensor; replace its type; change mode through a brick-side program. Recording stops with reason; no automatic restart. / 停止並標示原因。                                                              | Not run | Not run |
| Session / 連線             | Disconnect while read is pending. USB recovery or manual Wi-Fi reconnect never appends an old reply or resumes recording. Reapply profile manually. / 不採用舊回覆、不自動續錄。                                       | Not run | Not run |
| Sleep / 睡眠               | Sleep computer during capture, wake/reconnect; previous recording is stopped with sleep reason. / 睡眠前結束保存。                                                                                                     | Not run | Not run |
| Close/update / 關閉更新    | Close or install a prepared update while recording; last completed frames persist. Simulated save failure blocks close/update until retry succeeds. / 失敗不關閉。                                                     | Not run | Not run |
| Recovery / 復原            | After a checkpoint, terminate the app unexpectedly and restart. Recover interrupted record, no auto recording. / 復原最後檢查點。                                                                                      | Not run | Not run |
| Compare/export / 比較匯出  | Save two records, overlay matching sources, inspect time points; CSV matches frozen calibration and gaps. Cancel creates no file. / 校正固定且缺值一致。                                                               | Not run | Not run |

Do not change firmware calibration or reset motor counters during these checks. This tool is intended for general experiment logging, not high-rate PID tuning. Append dated observations and file paths for exported evidence after running the checks; leave untested rows marked Not run.

以上項目均未執行；實際測試後再填入日期、系統版本、韌體、埠位、模式與 CSV 證據。不得以模擬測試取代實機驗收，也不要將低速記錄當作 PID 即時控制量測。

## Final-candidate record / 最終成品紀錄

H1–H6 and S3-13–S3-15 remain **NOT RUN / 尚未執行**. Use the final regression-tested artifact after its automated/platform gates; no final candidate is certified by this checklist. Record tester/date, full commit and dirty state, installer **and executable** SHA-256, OS/version/architecture, Electron/runtime, EV3 firmware, transport, sensor/motor/load, locale/theme, case, actual result and logs/screenshots/video. Repeat platform-specific USB/Wi-Fi cases on Windows x64, macOS arm64 and Linux x64; an untested platform remains open. Windows device execution/recovery first needs verified Windows journal durability and packaging, not a successful prototype alone.

依 [Stage 3 H1–H6 procedures](../../docs/superpowers/specs/2026-10-17-plugin-system-stage-3-design.md#s3-human-checklist) 使用最終完成回歸測試的成品，逐筆記錄測試人／日期、完整 commit 與 dirty 狀態、安裝包及執行檔雜湊、OS／架構、runtime、韌體、硬體／負載、語系／主題、案例與原始結果。未測平台保持未執行；Windows 先完成 Windows journal 持久性及封裝證據。既有 stage-2 V01–V04 不變。

Append each named result after execution; preserve earlier failures and identify the corrected artifact on rerun. Stop requested, host readback and physical stop are separate observations. Native fake-provider/AX output cannot sign physical stopping, screen-reader speech or clean-machine usability. Do not prefill PASS.

## Stage 3 additional observations / 補充觀察

All rows below are **NOT RUN** over both USB and Wi-Fi. / 以下 USB、Wi-Fi 均未執行。

| Case / 案例                        | Required observation / 必要結果                                                                                                                                                                                               | Result / 結果 |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| Maximum recording / 最大錄製       | Four channels; run until 30 minutes or 3,600 snapshots, whichever occurs first; keep actual elapsed times, gaps and final committed record. / 四通道到原定上限，保留時間、缺口與最終紀錄。                                    | NOT RUN       |
| Background/reopen / 背景重開       | Hide, close only the panel, minimize, reopen; recording continues, status Open/Stop works, history/compare/delete and raw cursor values remain correct. / 不重啟錄製，狀態與原始值正確。                                      | NOT RUN       |
| Mode/arbitration / 模式仲裁        | Mode pin and stale-source refusal; motion exclusion; program/file priority, weak Wi-Fi and partial transfer with explicit confirmation; actual battery/program state. / 缺值不補零或重複。                                    | NOT RUN       |
| Save/recovery / 儲存復原           | Trusted Disconnect waits for stop/save; real sleep never replays; disk-full/read-only, retry expiry, close/update block, forced exit recovers only committed data. / 保存失敗可見，僅復原已提交資料。                         | NOT RUN       |
| User originals / 原檔              | Back up real profiles; migrate history/calibrations and device preferences, interrupt/retry/restart/delete; originals unchanged and no second import. / 不覆寫較新目標值。                                                    | NOT RUN       |
| CSV/calibration / 匯出校正         | Profiles persist; generated program agrees with float32 conversion; export explicitly bounded interval when over 8 MiB, cancel/replace/permission errors truthful; paste copied text. / 不截斷資料或假稱複製成功。            | NOT RUN       |
| Install/accessibility / 安裝無障礙 | Clean machine without checkout/user Node; independent/all-off switches, second launch during recording, both locales/themes, 320 px/125%, keyboard/IME/focus/dialog/cursor and actual screen reader. / 第二程序不打斷原錄製。 | NOT RUN       |

Cross-reference device H04–H14 and audit H2–H6 when the same observation covers both procedures; retain every expected result. / 可共用具名觀察，不能省略預期結果。
