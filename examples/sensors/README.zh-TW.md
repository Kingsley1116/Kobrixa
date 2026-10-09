# 感測器

<a href="../README.zh-TW.md">所有範例</a> · <a href="./README.md">English</a>

請將感測器接到表格所列的輸入埠；每個專案都會先等待感測器就緒，再讀取數值。

## 專案

| 範例                                                | 學習內容                            | 硬體需求                                 |
| --------------------------------------------------- | ----------------------------------- | ---------------------------------------- |
| [sensor-threshold](./sensor-threshold/)             | 等待、讀取百分比並選擇回饋          | 觸碰感測器接 1                           |
| [sensor-sampling](./sensor-sampling/)               | 在有限迴圈中重複取樣                | 觸碰感測器接 1                           |
| [color-sensor](./color-sensor/)                     | 以 Color 模式讀取顏色               | 顏色感測器接 1                           |
| [gyro-sensor](./gyro-sensor/)                       | 以 Angle 模式讀取旋轉角度           | 陀螺儀感測器接 1                         |
| [sensor-details](./sensor-details/)                 | 感測器身分、模式與原始值            | 任一感測器接 4                           |
| [raw-and-mode](./raw-and-mode/)                     | 選擇模式後讀取原始通道              | 顏色感測器接 4                           |
| [three-zone-light](./three-zone-light/)             | 反射光的兩個門檻邊界                | 顏色感測器接 1                           |
| [five-sample-average](./five-sample-average/)       | 以浮點累加器平均五次取樣            | 顏色感測器接 1                           |
| [mode-inspector](./mode-inspector/)                 | 身分、忙碌旗標與模式切換            | 顏色感測器接 1                           |
| [raw-channel-dashboard](./raw-channel-dashboard/)   | 百分比與多通道原始值                | 顏色感測器接 1                           |
| [rgb-function](./rgb-function/)                     | RGB 模式與三個輸出通道              | 顏色感測器接 1                           |
| [port-raw-access](./port-raw-access/)               | 指定埠 `Sensor1`–`Sensor4` 原始讀值 | 顏色感測器接 1；2–4 接支援原始值的感測器 |
| [touch-port-grid](./touch-port-grid/)               | 讀取並顯示四個輸入埠                | 1–4 各接觸碰感測器                       |
| [i2c-registers](./i2c-registers/)                   | 讀取文件化的 I2C 暫存器             | 接在 1 的已知 I2C 裝置                   |
| [i2c-register-workbench](./i2c-register-workbench/) | 單筆與多筆暫存器讀寫                | 接在 1 的自製 I2C 測試裝置               |
