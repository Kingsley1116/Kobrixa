# 插件設定與資料紀錄

作者階段狀態：API 1.7 公開發布、實際 transport、原生使用者動作及安裝版驗收仍 **BLOCKED**，等待 P170／R170／D170／V170／K170 與 B1-T9 artifacts。以下為預定 1.7 契約，不代表目前 checkout 已發布或驗收完成。

基礎範例：[JavaScript](../../tests/desktop/fixtures/plugin-persistence/consumer.ts)、[Python](../../tests/desktop/fixtures/plugin-persistence/consumer.py)。已撰寫 settings read／CAS／衝突／重新讀取、watch 訂閱／取消、record 分塊／seal／commit／讀回、flush 與 drain。export／copy helper 只接受真正 SDK invocation context 中的新 actionRef，activation 與 reference cases 不會執行它們。watch invalidation／ACK／callback 與 export／copy routing 仍需保留實際公開流量證據；Python SKIP 不能通過 parity。產品 mapping 範例留待 3D／3E。

Plugin API 1.7.0 提供型別化設定、有上限的 records、明確使用者觸發的匯出／複製，以及協作式 drain。設定宣告使用 version 1 與封裝內的 JSON path。settings 與 record 的 schemaVersion 是資料版本，和 Plugin API、UI resource version 分開。

只宣告需要的 settings.read、settings.write、storage.read、storage.write、storage.export、ui.clipboard 權限。host 將請求綁定到來源與執行世代；ID 或 handle 不能授權另一個來源。這些資料不是加密的秘密儲存區，程序隔離也不是 OS sandbox。

設定逐欄立即套用：boolean／enum 選擇後提交，文字與數字在 blur／Enter 時提交，沒有 Apply 按鈕。CAS 成功並收到 receipt 後才發布值。驗證或保存失敗會保留該欄 draft 與錯誤；revision 衝突時先讀取新 snapshot，再由使用者明確重試，不能覆蓋另一視窗的修改。單欄 Reset 走同一 CAS 路徑。

設定最多 128 keys、序列化 values 共 64 KiB，單一字串最多 4 KiB。key 可含點號；數字 1 與字串 "1" 是不同 enum 值。watch 只傳 invalidation，不傳值；需要時重新 read。settings.unwatch 包裝 events/unsubscribe，首次移除回 true，重複 tombstone 回 false，沒有 settings/unwatch wire method。

單筆 record 最多 8 MiB，每來源最多 256 筆／512 MiB，host 總上限 1 GiB。依序 beginWrite、writeChunk、sealWrite、commitWrite；chunk 是 canonical base64，解碼後最多 256 KiB。每來源最多兩個 staging、host 最多十六個，受理時預留完整 payload。replacement 需要 expected revision，先預留新資料才釋放舊 object。read handle 固定一個 revision，list 是有期限的 snapshot，每頁最多 64 筆；讀完要 close。

receipt 證明已提交的 head。unknown 表示必須對帳，不能解讀成 rollback；不要自動重送 create、commit、delete、export 或 copy。flush 不會替 caller 提交不完整 payload。staging／read／list 最多閒置 30 秒、總計 120 秒；重試不延長原本總期限。

匯出與複製需要 host 真實使用者動作產生、有效五秒且只可用一次的 actionRef。invocationId 不能替代它，activation、timer、watch callback 都不能取得它。匯出先建立非同步 dialog job，使用者取消不是保存錯誤。host 管理目的地並檢查身分，不回傳實體路徑。每來源一個／host 四個 export jobs，與 staging slots 分開。copy 只寫純文字，最多 64 KiB／16,384 code points，不能讀剪貼簿。

錄製前應 registerCheckpoint。drain callback 使用獨立取消範圍，最多十秒；submitted 不表示 saved。只有 final records 已收到 commit receipt 且 host flush 成功，才可宣稱保存完成。當機可能只留下最後 checkpoint；只有 host 已持有完整 payload 且原保留期限未到，才有 retry。停用 optional features 或進入 safe mode 後，核心 recovery 仍可使用。

同一 profile 只允許一個 primary instance。第二次啟動聚焦現有視窗後退出，不初始化另一個 writer。關閉 app 會協調 storage drain、device stop 與 fault journal；取消關閉不會復活舊 handles、motion 或錄製。Disconnect 先確認 stop／save 才斷線。suspend 會要求 final save，但 OS 可能先凍結 I/O；wake 不自動續錄。

Legacy import 是 host allowlist 管理的一次性作業。原始檔保留不變；plan、逐項 receipt 與 complete marker 持久化，重啟沿用原先配置的目標 IDs。缺 renderer evidence 時維持 pending。完成後使用者刪掉新 record，不會再次匯入。此基礎階段只含 synthetic mapper；真正 Sensor Lab 對應在 3D、device preferences 對應在 3E 驗收。

JavaScript method 使用 camelCase；Python method 使用 snake_case，但 params dict 的 wire keys 保留 camelCase。兩者保留相同 ok／value／error business envelope，transport／numeric protocol failure 才拋 RpcError。1.4、1.5、1.6 consumers 維持相容，不收到 persistence drain 或 settings events。UI v2 與 Plugin API 1.8 由 3D 發布。
