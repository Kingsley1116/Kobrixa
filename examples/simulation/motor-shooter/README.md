# Motor shooter / 馬達發射器

[Simulation lessons / 模擬課程](../README.md)

## Run / 執行

Open this project in the Simulator. A ball is placed 35 mm in front of the configured muzzle. Motor D controls the launcher; B/C remain available for driving. The saved launcher uses a 180° positive stroke, a 20° elevation, and a 1700 mm/s launch speed.

在模擬器開啟此專案。場景將球放在設定的發射口前方 35 mm 處。D 馬達控制發射器，B/C 仍可供底盤使用。發射器設定為正向 180° 行程、20° 仰角、1700 mm/s 初速。

## Expected result / 預期結果

After half a second, the positive D stroke launches the nearby orange ball. The following negative stroke retracts the motor without firing again. Watch the ball's flight, landing, and rolling motion and the `Shot released` LCD message. The chassis stays still.

等待半秒後，D 的正向行程會發射附近的橘球；接續的負向行程用於回位，不會再次發射。可觀察球的飛行、落地與滾動，以及 LCD 的 `Shot released` 訊息。底盤保持不動。

Moving the ball outside the configured capture range leaves the stroke with nothing to launch. Shaft motion triggers the launcher; `Motor.ResetCount` cannot create or cancel a shot. This is a simplified mechanism model, not a prediction of a real spring launcher.

若將球移到設定的捕捉範圍外，馬達行程不會憑空產生球。發射由實際軸行程觸發，`Motor.ResetCount` 不會創造或取消發射。這是簡化機構模型，不是實體彈簧發射器的精確預測。
