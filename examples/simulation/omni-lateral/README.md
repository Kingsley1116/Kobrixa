# Omni lateral movement / 全向橫移

[Simulation lessons / 模擬課程](../README.md)

## Run / 執行

Open this folder in the Simulator. Four tangential wheels use A at the front, B on the left, C at the rear and D on the right. Their rolling directions are 90°, 180°, 270° and 360° relative to chassis forward. This scene has no shooter because every motor port is occupied.

在模擬器開啟此資料夾。四顆切向全向輪配置為 A 前、B 左、C 後、D 右，相對車身前方的滾動方向分別為 90°、180°、270°、360°。所有馬達埠皆已使用，因此本場景不配置發射器。

## Expected result / 預期結果

First the robot slides about 141 mm to its left while keeping its initial heading. Next it moves about 141 mm forward. Finally it rotates counterclockwise in place for 0.8 seconds, then stops. The LCD labels each stage and finishes with `Omni complete`.

首先機器人保持原朝向，向自身左側橫移約 141 mm；接著向前移動約 141 mm；最後原地逆時針旋轉 0.8 秒並停止。LCD 依序顯示各階段，最後顯示 `Omni complete`。

These signs depend on the saved wheel angles. Changing a wheel's mounting direction or inversion requires changing the commands. The robot has no sideways differential-wheel shortcut: motion is solved from the actual wheel geometry.

正負轉速取決於場景中的輪子方向。修改安裝方向或反轉設定時，也要相應修改指令。橫移由實際輪子幾何求解，不是讓差速輪憑空側滑。
