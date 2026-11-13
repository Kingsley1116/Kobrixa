# 設備與平台支援

## 歷史 v1 支援矩陣（2026-10-12）

| 桌面目標            | USB HID            | Wi-Fi              | Bluetooth |
| ------------------- | ------------------ | ------------------ | --------- |
| Windows x64         | 維護者確認驗收通過 | 維護者確認驗收通過 | 未實作    |
| macOS Apple Silicon | 維護者確認驗收通過 | 維護者確認驗收通過 | 未實作    |
| Linux x64           | 維護者確認驗收通過 | 維護者確認驗收通過 | 未實作    |

只有在該平台的自動 transport 測試和實體參考 EV3 測試都通過後，才能宣告已提供支援。

共用 USB 與 Wi-Fi transport 已存在於 `packages/device`。維護者已於 2026-10-12 確認實體 EV3 驗收通過；此處記錄該確認，未附逐平台測試日誌。每次驗收應記錄作業系統、韌體、傳輸方式、確切應用程式版本與觀察結果。桌面簽章有效性另依[程式碼簽章政策](../zh-TW/code-signing.md)驗證。

## Stage 3 開發中的介面

Stage 3 開發分支改由 **插件工具 → EV3 裝置**主動搜尋、連線與監測，連線偏好移至插件設定。開啟面板不會連線；切換 USB／Wi-Fi 立即保存選擇。記住 Wi-Fi 位址仍需先啟用且連線成功；連線後保存偏好失敗，不會斷線或重做連線。

核心建置／部署、版本檢查、遠端檔案與待執行 Run 的取消仍使用同一 session。Disconnect 由 host 先停止並保存再斷線。關閉設備面板只解除自己的觀察需求，其他 recorder 仍負責其記錄；重連不恢復已取消的 Run 或記錄意圖。

上方 v1 平台確認不代表本次遷移驗收完成。Stage 3 的 native／installed 與實體驗收仍列於[設備介面清單](../../tests/hardware/device-ui.md)。此分支已撤除舊設備監測與連線設定 renderer UI。renderer 現在導向插件工具，核心電池狀態保留一條由 host 支援的路徑。過時 main IPC、preload 與 shared contracts 的撤除仍在進行；最終 native 撤除證據仍未完成。馬達與 Lab 私有路徑已移除。S3-13–S3-15 仍為 **NOT RUN／尚未執行**；歷史矩陣不是 Stage 3 平台核准。

## USB

- 只搜尋支援的 EV3 USB HID，不掃描無關介面。
- 將缺少權限或驅動程式存取與「找不到設備」分開回報。
- 使用有界讀寫、驗證封包長度並拒絕格式錯誤的回覆。
- 取消、斷線、應用程式離開或錯誤時關閉 handle。
- 只在必要時提供平台設定指引；Linux 權限說明必須使用範圍精確的設備規則。

## Wi-Fi

- 連線至使用者輸入的位址或搜尋到的相容 endpoint。目前搜尋會接收 IPv4 UDP 3015 廣播；手動輸入的位址交由 TCP client 連線。
- 使用 EV3 相容 TCP 協定，建立 session 前驗證 handshake。
- 對連線、讀取、寫入與整體操作套用逾時。
- 將非預期斷線視為可復原錯誤，不得把未完成上傳回報為成功。
- 對 EV3 的 TCP 5555 建立向外連線。搜尋期間會暫時監聽 UDP，應用程式不提供可供遠端操作設備的伺服器。

## 操作行為

搜尋是唯讀操作。上傳、執行、停止和刪除都需要明確使用者操作。UI 顯示 `disconnected`、`connecting`、`connected`、`busy` 或 `error`，並標明目前 transport。

上傳會直接串流寫入選定的遠端路徑，並驗證傳輸長度與韌體回覆，不提供既有遠端檔案的原子替換。取消或斷線可能留下未完成檔案；請重連、確認目的地後重新上傳。流程會盡可能關閉傳輸 handle。

「在 EV3 執行」先儲存與建置，成功後確認舊程式已停止，再上傳新版。啟動程式（包含「執行已上傳版本」）會停止使用者程式槽、檢查映像載入，並等待韌體確認啟動。活動紀錄會區分「上傳完成」與「已確認程式啟動」。短程式可能在確認回覆抵達前已正常結束，這不算啟動失敗。啟動失敗或中斷時不會自動重試；僅上傳與 USB 重連也不會啟動程式。

遠端檔案瀏覽器另支援目錄列表、下載、建立資料夾、重新命名與刪除，批次傳輸會先預覽衝突。本機下載先寫入暫存檔，傳輸完成後才提交；EV3 韌體不提供原子 rename，因此遠端重新命名採複製、驗證再刪除的流程。

遠端路徑依 EV3 路徑規則正規化。Transport I/O 前必須拒絕父目錄跳脫、內嵌 null、無效長度和不支援名稱。

## 即時監測

透過 USB 或 Wi-Fi 連線後，開啟 **插件工具 → EV3 裝置**。面板顯示本機輸入埠 1–4、輸出埠 A–D、電池百分比與電壓，以及 EV3 使用者程式槽的狀態。此狀態代表 EV3 上的程式，不代表目前編輯的專案；讀取馬達角度時不會重設計數。 此分支已將舊 Monitor 目的地改為插件工具連結；以下行為保留作 parity 基準，最終 replacement 驗收仍未完成。

未記錄時，只有選取設備監測 view、工具面板開啟且視窗可見時才會取樣；開始記錄後，同一個主程序採樣排程會在背景持續運作。每次完成後等待 500 ms 再讀取。同時最多一個取樣請求，前景操作優先；上傳、檔案批次與確認等待期間會暫停監測。暫停、忙碌或失敗時保留最後讀值，並標示不是即時資料。時間戳記代表最後成功取樣的時間，不保證持續更新。空埠、初始化中、未知裝置與無效讀值分別呈現，無效數值不會顯示為零。

官方 EV3 UART 感測器可透過「切換模式」選擇韌體 Port View 支援的模式；Touch、馬達及第三方／I2C 裝置只提供讀取，不列出內部或校正模式。只有確定使用者程式已停止時才允許切換，執行中或狀態未知時會停用控制項。送出前再次檢查程式狀態與感測器身分，套用後確認實際模式。應用程式不會自動停止程式、保存模式偏好，或在關閉監測與重連後還原先前模式；從 EV3 本體啟動的程式仍可能再次改變感測器模式。

所有可用通道都會顯示，未標示的多通道資料使用通道編號。記錄、比較、CSV 匯出與數值校正改由 **插件工具 → 感測器工具**提供，見[感測器工具](sensor-lab.md)；點動、定時與角度測試改由 **插件工具 → 馬達測試**提供，見[馬達測試](motor-test.md)。舊 Lab 子頁與馬達卡片已移除。馬達測試暫停一般監測，不能與錄製同時執行；不包含菊鏈監測。USB recovery 使用替換 session 並丟棄舊回覆。沒有錄製時關閉監測會停止後續取樣，不中斷已送出的 USB exchange 或斷線。

桌面 smoke 使用模擬資料。維護者於 2026-10-12 的實體 EV3 確認適用先前實作，不代表 Stage 3 已驗收；後續回歸請依[監測驗收步驟](https://github.com/Kingsley1116/Kobrixa/blob/main/tests/hardware/README.md#live-monitor--即時監測)操作並記錄各平台結果。

## 必要驗收情境

請依實機紀錄中的治具條件與限制，使用[手動硬體工具](https://github.com/Kingsley1116/Kobrixa/blob/main/tests/hardware/README.md)。這些檢查需要連接 EV3，不會在一般 CI 執行。

- 三平台以 USB 完成搜尋、連線、上傳、執行、停止、刪除與斷線。
- 三平台透過位址連線，並以 Wi-Fi 完成相同生命週期。
- 權限拒絕、沒有設備、錯誤位址、拒絕連線、逾時、錯誤回覆、空間不足和上傳期間斷線。
- 使用者在搜尋、連線與上傳期間取消。
- 可復原錯誤後不必重新啟動 IDE 即可重連。
- 驗證失敗永遠不會讓 UI 或 API 結果進入成功狀態。
- 驗證 Color 切換模式、IR 多通道、Gyro 初始化、馬達負角度、電量，以及從 EV3 本體啟動／停止程式；確認暫停／恢復與取樣尚未完成時的 USB 重連。

Bluetooth 不屬於 v1，因為各作業系統的搜尋、配對、serial profile、權限與封裝方式差異明顯。

<a id="windows-stage-3-journal-policy"></a>

## Windows Stage 3 日誌政策

R1 的 2026-11-12 follow-up 允許 native safety-journal adapter 在可驗證的 local fixed NTFS 上支援，以文件語意與 kill-at-phase tests 作為依據。production 使用 handle-relative `SetFileInformationByHandle(FileRenameInfoEx)` 的 replace／POSIX flags、temp／published-file `FlushFileBuffers` 與逐次檢查的 directory flush；要求 Windows 10 1709+。未做實體斷電測試，也不要求此 gate。歷史 19/19 candidate suite 使用 `MoveFileExW` 與 attribute-only pins，不是目前 production code 的驗收。目前 Windows native／installed acceptance 在新 CI 證據出現前仍為 **NOT RUN／尚未執行**。

產品建立 Windows journal directory 與 staging file 時即以明確 protected DACL 禁止繼承，只授予目前 token user、SYSTEM 與 BUILTIN\Administrators full control；即使 elevated token 的預設 owner 為 Administrators，建立時仍明確指定 token user 為 owner。既有 directory 只驗證，不修補 ACL。既有 owner 可為目前 user、SYSTEM 或 Administrators。有效 mutation grant（generic all/write、file write/append、extended-attribute/attribute write、delete-child、delete、DACL 或 owner 變更）只接受上述 principal，或代表已驗證 owner 的 OWNER RIGHTS；其他 principal 可有 read/execute。繼承自相同可信 principal 的 grant 可接受。inherit-only ACE（包含 CREATOR OWNER template）不授予物件本身存取權；有效且未替換的 CREATOR OWNER mutation grant 則拒絕。null／無法驗證的 DACL 仍拒絕。journal 與 existing/staged/published file 均保留這些檢查；pinned profile parent 驗證 path/volume 並必須 flush，但不要求整個 profile 具有 journal 的 private DACL。

不支援的 volume、缺失／不相容 addon、不安全路徑／ACL 及 barrier 失敗仍 fail closed；Windows production 不再一律回 `ENOTSUP`。初始化無法授權寫入時，仍顯示已驗證的舊 faults。commit 失敗會阻擋 motion／program admission 與 resolution；可信 Stop 仍 best-effort dispatch 實體停止，保留 journal failure 與未解決的 close/update 義務。編輯／編譯、被動讀取與乾淨 idle quit 須分開判定。同 user／privileged target-name 與 ACL race 限制見[架構政策](architecture.md)。

上述關卡通過前，Windows Stage 3 設備執行／復原**尚未驗收**。沒有核准縮減平台範圍或降低安全保證，B2 record-store 政策也不能豁免設備 journal。見 [Windows 驗收帳本](../superpowers/plans/2026-10-17-plugin-system-3a-acceptance.md)。所有交付平台仍須最終 native／installed 證據及具名實機／人工結果。第二次啟動只能聚焦／還原 primary，不得產生另一 writer／provider／recording；真實 suspend 必須結束工作，wake 不重播。硬體／介面清單保留這些明確案例。
