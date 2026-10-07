# Pixy2 signature search / Pixy2 色碼搜尋

[Simulation lessons / 模擬課程](../README.md)

## Run / 執行

Open this project and press **Alt+F5**, then Start. Input 4 is a **Pixy2 camera (LEGO)**, mounted 100 mm above the mat, tilted 10° down. Orange is trained as signature 1; purple is signature 2. This stationary probe does not start motors.

開啟此專案，按 **Alt+F5** 再開始。輸入 4 為 **Pixy2 相機（LEGO）**，高度 100 mm、向下俯仰 10°。橘球設定為色碼 1，紫球為色碼 2。此範例固定探測，不會啟動馬達。

## Expected result / 預期結果

The LCD displays the number of visible signature-1 objects and the largest object's X/Y centre and width/height for two seconds. The saved scene detects one orange ball and ignores the purple ball. X increases right and Y down. The values use the LEGO firmware's 0–255 byte coordinates; they are not distances or the raw Pixy2 image coordinates. Bigger blocks generally mean closer balls; no range is returned.

LCD 在兩秒內顯示可見色碼 1 物件的數量，以及最大色塊的 X/Y 中心和寬／高。隨附場景會偵測一顆橘球、忽略紫球。X 向右增加、Y 向下增加；數值使用 LEGO 韌體的 0–255 位元組座標，不是距離或 Pixy2 原始影像座標。色塊越大通常表示球越近，不直接回傳距離。

Reset and move a ball, rotate the camera, or change its trained signatures to compare the readings. Setting orange to **Not trained** yields five zero bytes for signature 1. Changing `signature = 2` reads purple through register 82. These calls also compile to the existing EV3 I2C API; a real camera must be wired, configured for LEGO, and taught the corresponding colors separately.

重設後可移動球、轉動相機或修改訓練色碼，比較讀值。橘球選擇「**未訓練**」時，色碼 1 讀回五個零。將程式改為 `signature = 2`，會由暫存器 82 讀取紫球。這些呼叫也可編譯成既有 EV3 I2C API；實體相機需另外完成接線、LEGO 介面設定和色彩訓練。

## Interface / 介面

`Sensor.ReadI2CRegisters(4, 1, 80 + signature, 5)` returns `[count, x, y, width, height]` for signatures 1–7. Register 80 with length 6 returns the largest block across all signatures as `[signatureLow, signatureHigh, x, y, width, height]`. A missing target returns zeros. `Sensor.GetName(4)` is `Pixy2` in the simulator. This is the LEGO I2C color-connected-components interface, distinct from the synthetic `KOBRIXA-VISION` SI channels.

`Sensor.ReadI2CRegisters(4, 1, 80 + signature, 5)` 針對色碼 1–7 回傳 `[數量, x, y, 寬, 高]`。暫存器 80 搭配長度 6，會回傳所有色碼中最大色塊的 `[色碼低位元組, 色碼高位元組, x, y, 寬, 高]`。沒有目標時回傳零；模擬器的 `Sensor.GetName(4)` 為 `Pixy2`。此為 LEGO I2C 色塊辨識介面，與合成 `KOBRIXA-VISION` 的 SI 通道不同。

The simulator generates blocks from visible balls and models mounting geometry, field of view and occlusion. It does not process real images or emulate line tracking, RGB reads, color codes, tracking IDs or video. / 模擬器依可見球體、安裝幾何、視野和遮蔽產生色塊；不處理真實影像，也不模擬巡線、RGB、組合色碼、追蹤 ID 或影片。

References / 參考：[LEGO block guide](https://docs.pixycam.com/wiki/doku.php?id=wiki:v2:pixy_lego_block), [manufacturer LEGO I2C firmware](https://github.com/charmedlabs/pixy2/blob/master/src/device/main_m4/src/serial.cpp).
