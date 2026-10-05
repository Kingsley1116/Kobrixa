# Sensor lab physical acceptance / 曲線與校正實機驗收

Status on 2026-10-05: **NOT RUN / 尚未執行**. Implementation checks use simulated transports, the bytecode VM and Electron smoke. No sensor lab hardware result is claimed.

Record application revision, OS, EV3 firmware, connection, sensor type, port and mode. Repeat every row over **USB and Wi-Fi** with Color reflected light, Gyro and Ultrasonic sensors. Use an unloaded motor and turn its shaft by hand when checking angles; no motor-drive command is required.

| Check / 項目               | Expected / 預期                                                                                                                                                                                                        | USB     | Wi-Fi   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------- |
| Raw SI / 原始 SI           | Compare monitor, exported raw CSV and a generated `ReadSIValue` program at stable inputs. Check Ultrasonic fractions and cm/in units, Gyro signed angles/rate, Color reflected %. / 比對穩定輸入、小數及單位。         | Not run | Not run |
| Calibration / 校正         | Capture two known points; check 0–100, reversed targets, raw-only zero and two-point zero. Generated program and tool agree within float32/display precision. Motor count is not reset. / 驗證正反向、歸零與程式結果。 | Not run | Not run |
| Four channels / 四通道     | Record three sensors and motor; common elapsed time, separate Y axes. Sampling interval includes response time plus 500 ms. / 檢查時間與採樣間隔。                                                                     | Not run | Not run |
| Background / 背景          | Switch tabs, collapse panel, minimize and restore; recording continues, footer stops it, editor focus/undo survive. / 背景持續，底部可停止。                                                                           | Not run | Not run |
| Foreground work / 前景操作 | Explicitly upload/run/stop a display-only program and browse/transfer files. Operations proceed first; busy gaps do not contain repeated/zero readings. / 操作優先且缺值留白。                                         | Not run | Not run |
| Source changes / 來源變更  | Unplug selected sensor; replace its type; change mode through a brick-side program. Recording stops with reason; no automatic restart. / 停止並標示原因。                                                              | Not run | Not run |
| Session / 連線             | Disconnect while read is pending. USB recovery or manual Wi-Fi reconnect never appends an old reply or resumes recording. Reapply profile manually. / 不採用舊回覆、不自動續錄。                                       | Not run | Not run |
| Sleep / 睡眠               | Sleep computer during capture, wake/reconnect; previous recording is stopped with sleep reason. / 睡眠前結束保存。                                                                                                     | Not run | Not run |
| Close/update / 關閉更新    | Close or install a prepared update while recording; last completed frames persist. Simulated save failure blocks close/update until retry succeeds. / 失敗不關閉。                                                     | Not run | Not run |
| Recovery / 復原            | After a checkpoint, terminate the app unexpectedly and restart. Recover interrupted record, no auto recording. / 復原最後檢查點。                                                                                      | Not run | Not run |
| Compare/export / 比較匯出  | Save two records, overlay matching sources, inspect time points; CSV matches frozen calibration and gaps. Cancel creates no file. / 校正固定且缺值一致。                                                               | Not run | Not run |

Do not change firmware calibration or reset motor counters during these checks. This tool is intended for general experiment logging, not high-rate PID tuning. Append dated observations and file paths for exported evidence after running the checks; leave untested rows marked Not run.

以上項目均未執行；實際測試後再填入日期、系統版本、韌體、埠位、模式與 CSV 證據。不得以模擬測試取代實機驗收，也不要將低速記錄當作 PID 即時控制量測。
