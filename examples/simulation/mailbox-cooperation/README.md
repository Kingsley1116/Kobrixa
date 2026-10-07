# Two-entry mailbox cooperation / 雙入口信箱合作

[Simulation lessons / 模擬課程](../README.md)

## Run / 執行

Open this **single project folder** in the Simulator. Its scene assigns `src/main.bp` to A1 / Scout and `src/runner.bp` to A2 / Runner. Both robots belong to team A and compile separately from the same project snapshot. Keep the saved communication names `Scout` and `Runner` unless you also edit the source.

在模擬器開啟這個**單一專案資料夾**。場景將 `src/main.bp` 指派給 A1 / Scout，將 `src/runner.bp` 指派給 A2 / Runner。兩車同屬 A 隊，從同一專案快照分別編譯。除非同時修改原始碼，請保留 `Scout` 與 `Runner` 通訊名稱。

## Expected result / 預期結果

Runner opens its numeric inbox and sends a readiness message. Scout then measures the orange ball with input 4's synthetic vision and sends its distance (about 325 mm). Runner drives that distance along its own parallel lane, stops, and sends `Runner arrived` back. Select each robot to inspect its independent LCD, variables and mailbox events. The scout does not move.

Runner 先建立數字收件匣並通知就緒。Scout 接著透過輸入 4 的合成視覺量測橘球，傳送約 325 mm 的距離。Runner 沿自己的平行車道前進相同距離、停止，再回傳 `Runner arrived`。選取不同機器人，可以查看各自獨立的 LCD、變數及信箱事件；偵察車不移動。

Messages become visible at the next 10 ms world tick. Each mailbox keeps the latest unread value; receiving consumes it. This is local, same-team transport with explicit id/name targets, not external Bluetooth networking. Scout checks the synthetic sensor name and exits on hardware without it. Running `runner.bp` alone waits for its missing teammate.

訊息於下一個 10 ms 世界步進才可見；每個信箱保留最新的未讀值，讀取後即消耗。這是明確指定 id／名稱的同隊本機通訊，不會連接外部 Bluetooth。Scout 會檢查合成感測器名稱，在缺少此感測器的實機上直接結束。單獨執行 `runner.bp` 則會等待尚未啟動的隊友。
