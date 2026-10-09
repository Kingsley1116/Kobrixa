# 馬達

<a href="../README.zh-TW.md">所有範例</a> · <a href="./README.md">English</a>

> 安全提醒：第一次執行前請架高機器人，讓所有連接的馬達都能自由轉動；上傳前請確認列出的連接埠。

## 專案

| 範例                                          | 學習內容                     | 硬體需求        |
| --------------------------------------------- | ---------------------------- | --------------- |
| [motor-move](./motor-move/)                   | 阻塞式移動、等待與煞車       | 馬達 A 與 D     |
| [motor-start-stop](./motor-start-stop/)       | 持續啟動馬達後安全停止       | 馬達 A 與 D     |
| [motor-reverse](./motor-reverse/)             | 負速度與反向移動             | 馬達 A          |
| [motor-sequence](./motor-sequence/)           | 依序執行兩次阻塞式移動       | 馬達 A 與 D     |
| [motor-counter](./motor-counter/)             | 讀取馬達編碼器並以 `If` 分支 | 馬達 A          |
| [motor-steer-sync](./motor-steer-sync/)       | 協調轉向與同步移動           | 馬達 A 與 D     |
| [motor-schedule](./motor-schedule/)           | 帶加減速的排程移動           | 馬達 A 與 D     |
| [power-ramp](./power-ramp/)                   | 有限次的開迴路功率漸增       | 馬達 A          |
| [encoder-profile](./encoder-profile/)         | 功率排程中記錄編碼器取樣     | 馬達 A          |
| [polarity-feedback](./polarity-feedback/)     | 反轉極性、讀取回饋並恢復     | 馬達 A          |
| [steering-lifecycle](./steering-lifecycle/)   | 連續、阻塞與排程轉向         | 同型馬達 A 與 D |
| [sync-lifecycle](./sync-lifecycle/)           | 連續、阻塞與排程同步         | 同型馬達 A 與 D |
| [paired-trajectories](./paired-trajectories/) | 先排程兩顆馬達再等待         | 馬達 A 與 D     |
