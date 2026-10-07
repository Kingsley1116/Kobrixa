# Synthetic vision search / 合成視覺搜尋

[Simulation lessons / 模擬課程](../README.md)

## Run / 執行

Open this project in the Simulator. B/C drive the differential chassis. Input 4 is the mounted **KOBRIXA-VISION** synthetic sensor with a 60° field of view. The robot initially faces away from the orange target; a purple distractor is also present.

在模擬器開啟此專案。B/C 驅動差速底盤；輸入 4 配置視野 60° 的 **KOBRIXA-VISION** 合成感測器。機器人開始時沒有朝向橘色目標，場景中也有一顆紫色干擾球。

## Expected result / 預期結果

The robot rotates clockwise until it sees an orange ball, steers toward its bearing, and stops with the target about 140 mm from the sensor. Mode 1 filters out purple balls. The search stops after eight seconds if no target can be reached. The LCD shows `Orange ball found` or `Search timed out`.

機器人先順時針旋轉，看到橘球後依相對角度修正方向，直到球距感測器約 140 mm 時停止。模式 1 會排除紫球；若無法接近目標，搜尋會在八秒後停止。LCD 顯示 `Orange ball found` 或 `Search timed out`。

SI channels 0–3 are detected (0/1), relative bearing in degrees, distance in mm, and class (1 orange / 2 purple). This is an ideal local geometry sensor, not an image recognition implementation. The program checks the exact sensor name and exits before starting motors on a stock EV3 without this extension.

SI 通道 0–3 依序為偵測旗標（0/1）、相對角度（度）、距離（mm）、類別（1 橘 / 2 紫）。這是理想化的本機幾何感測器，不是影像辨識實作。程式會檢查感測器完整名稱，在沒有此擴充的原生 EV3 上，會於啟動馬達前結束。
