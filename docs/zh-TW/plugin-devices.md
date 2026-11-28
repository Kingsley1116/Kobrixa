# 設備插件（API 1.8.0）

consumer 在 manifest 要求 `devices.read`、`devices.connect`、`devices.control`。permission 只是受理資格，不是永久 lease。initialize 完成後才 negotiate，檢查 provider／capability availability，並檢查每個 business result。provider 停用時不可自動啟用。

只有 host allowlist 可註冊 `kobrixa.device-ev3`。development source 只要有 `contributes.deviceProviders`，即使為空陣列或 null 也 invalid；沒有 `devices.provide` permission。插件是使用者信任的本機程式；此 API 提供安全仲裁與相容性邊界，不是敵意程式碼的 sandbox。

JavaScript 使用 `context.devices`，Python 使用 `ctx.devices`；Python 的 `input_modes`、`connection_recovery` 對應 JS 的 `inputModes`、`connectionRecovery`；wire keys 保留 camelCase。兩者回傳 `{ok:true,value}` 或 `{ok:false,error:{code,message,detail?}}`，transport failure 另計。完整對照案例位於 `tests/desktop/fixtures/device-broker/` 的兩個 consumer。

讀取流程為 negotiate → list → session → read/subscribe。`devices/context` 只回 host 綁定的 reference 與受限 snapshot；沒有綁定就是 unbound，不視為 local authority。connect 只接受 host candidate 或 canonical IP literal，不接受 hostname、credentials 或 native transport path。讀取、瀏覽、下載與停止自己的操作不要求 holder，但仍檢查 source／session 與 permission。

motion 需要 host 發給可見 panel 的 scope、目前 authority 與 `devices.control`；jog 還需要真實 gesture。consumer 不得自行建立 scope、heartbeat 或 gesture。1.5 transport fixture 的 reference 由可信 test host 提供；1.6 起由 host 綁定宣告式 UI；1.8 新增 version-2 資料檢視。沒有 UI scope 必須明確回 unavailable。

prepare 不做設備 I/O。start 在 5 秒內一次消耗 reference。送 start 前保存 operation ID；timeout／reply 遺失不能重送 start，應 query／stop 原 ID。強制停止的 brake 不會被原本 coast 設定覆寫。stop acknowledgement 只表示已登記停止意圖；readback 才能證實停止。未確認的停止在功能消失後仍保留於核心復原。

SDK query／control 為 5 秒、read 為 15 秒、connection 為 65 秒。provider exchange 保留 motor 2 秒、一般 5 秒、file transfer 10 秒，並受原 deadline 限制。stop/readback 的 15 秒包含已送 exchange 的等待，之後 journal disposition 最多另 5 秒。取消與重試不得延長期限。

monitor、battery、recorder 共用同一 session sampler；完成一次 read 後等 500 ms，僅 battery demand 時等 30 秒。recording 保留一至四個固定 channels，source change 即結束。frames 可含明確 gap；subscription queue 與 recording ring 有界，不能假定離線期間無限保存。先檢查 subscribe 的 business result，再取得 subscription。JS subscription 有 `subscriptionId`、`snapshot`、`lastSequence`、`dispose()`；Python 使用 `subscription_id`、`snapshot`、`last_sequence`、`close()`。SDK 在驗證與有界 enqueue 後 ack，不等待任意 consumer callback。

reservation 第一次 end 固定 final-read grant 與 deadline。provider loss、suspend、core Disconnect 不 retire 健康 consumer generation。使用者一次 Disconnect 先停止、保存，再斷線；失敗顯示 blocker。wake 不自動續作。新 settings/storage API 在 1.7 前 unavailable；遷移後的 Lab 使用真正 persistence participant 與 committed checkpoints。私有 recorder／store 已撤除；原檔 import 及 close/update/save 保護仍保留。

remote-files confirmation 閒置 120 秒到期，只有明確使用者確認可續租，總 lifetime 最多 600 秒。native dialog 晚回覆不可執行舊 plan。取消或失權阻止後續 chunks／entries，但不能假裝已送寫入能 rollback。

journal 在風險 motion/program dispatch 前持久記錄；full、corrupt、unwritable 時拒絕新風險。同 IP 不代表同一實體設備。所有 optional features 停用或 safe mode 時仍可使用 core recovery。

synthetic provider、實際 Electron/Python transport、installed artifact、真實 USB/Wi-Fi 分列驗收。本基礎不代簽 3C motor UI、3D Lab storage/charts、stage-2 V01–V04 或 3E 最終 closeout。

## 連線觀察與內建介面

內建 EV3 面板使用 consumer 的同一套公開 SDK。隨附 Node entry、宣告式面板及設定資源都屬於既有 `kobrixa.device-ev3` source；開啟面板不註冊第二個 provider。原生傳輸仍由 host-only builtin provider 負責。建置／部署／版本檢查、待執行 Run 的取消及遠端檔案仍屬核心功能；核心 adapter 觀察公開連線，不另外建立原生連線。

JS 使用 `devices.connectionRecovery.read({})`，Python 使用 `devices.connection_recovery.read({})`，並可訂閱 `connectionRecovery` topic。必須先確認協商版本支援；這些操作只提供有界觀察，不提供重新連線或取消 RPC。取消由宣告式 `cancelConnectionRecovery` 可信核心動作處理。恢復與 snapshot 不重播舊 Run 或馬達操作；owner 結束時需解除訂閱並拒絕晚到 callback。

實際觀察到的輸入埠即使沒有當前數值，仍保留一個 component-0 觀察位置及真實狀態；未出現在讀取結果的埠不會被補出。null 表示缺值，不是零。ready/null 可記錄為缺口，但不能當作校正量測；非 ready 輸入不可保留記錄或查詢／寫入模式。metadata 變更仍依既有 source revision／handle 規則失效。

連線偏好透過插件設定與 revision CAS 保存。六個 main 偏好與三個 renderer 偏好一次共同匯入；匯入待處理或無法讀取時，不得以預設政策允許新 I/O。選擇傳輸方式會獨立於連線結果保存；關閉記住位址時，同一 revision 清除位址。renderer 的擷取提示不代表 authoritative 匯入已完成。

以上是 Stage 3 開發中的契約。完整 native／installed 遷移與[硬體及介面清單](../../tests/hardware/device-ui.md)仍是分別驗收的門檻。

R1 的 2026-11-12 follow-up 以文件語意加 kill-at-phase tests 為依據，支援可驗證 local fixed NTFS 上的 Windows native journal。production 使用 handle-relative `FileRenameInfoEx` replace／POSIX 語意，加上 file／directory flush（Windows 10 1709+）。未做實體斷電測試，也不要求此測試。歷史 candidate tests 不證明這次 production sequence；目前 Windows native／installed acceptance 在新 CI 證據出現前仍為 **NOT RUN／尚未執行**。不支援的 volume、不安全路徑／ACL、缺失／不相容 addon 與 barrier 失敗仍 fail closed。已驗證的舊 faults 保持可見；journal failure 仍阻擋 motion／Run 與 resolution，可信 Stop 則 best-effort dispatch，並保留未解決的 close/update 義務。見[平台政策](device-support.md#windows-stage-3-journal-policy)。B2 storage-policy waiver 不適用。
