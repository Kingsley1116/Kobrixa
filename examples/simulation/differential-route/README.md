# Differential route / 差速路線

[Simulation lessons / 模擬課程](../README.md)

## Run / 執行

Open this folder, choose Simulator, then Run. The saved practice scene uses B as the left wheel and C as the right wheel, with 56 mm wheels and a 120 mm track. Input 3 is the simulated gyro in angle mode. No physical EV3 is needed.

開啟此資料夾，選擇「模擬器」後執行。儲存的練習場景使用 B 左輪、C 右輪，輪徑 56 mm、輪距 120 mm；輸入 3 為角度模式的模擬陀螺儀。不需要實體 EV3。

## Expected result / 預期結果

The robot starts at (250, 750) mm facing right. It travels about 352 mm, turns left about 90°, then travels another 176 mm. The trace forms an L and ends near (602, 926) mm. The LCD reports its gyro angle change and `Route complete`; all drive motors stop.

機器人從 (250, 750) mm 朝右出發，前進約 352 mm、左轉約 90°，再前進約 176 mm。軌跡呈 L 形，終點約為 (602, 926) mm。LCD 顯示陀螺儀角度變化及 `Route complete`，驅動馬達均停止。

Change wheel diameter or gear ratio in the scene to see why encoder degrees alone do not specify a universal travel distance. The simulator uses ideal shaft speeds; real robots also need calibration for slip and load.

修改場景中的輪徑或齒比，可以觀察為何相同編碼器角度不一定對應相同路程。模擬器使用理想軸速；實機還需校正滑動與負載影響。
