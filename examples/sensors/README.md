# Sensors

<a href="../README.md">All examples</a> · <a href="./README.zh-TW.md">繁體中文</a>

Connect each sensor to the input port listed in the table. Each project waits for sensor readiness before reading a value.

## Projects

| Example                                             | What it teaches                               | Hardware                              |
| --------------------------------------------------- | --------------------------------------------- | ------------------------------------- |
| [sensor-threshold](./sensor-threshold/)             | Wait, read a percentage, and select feedback  | Touch sensor on 1                     |
| [sensor-sampling](./sensor-sampling/)               | Repeated sampling in a finite loop            | Touch sensor on 1                     |
| [color-sensor](./color-sensor/)                     | Detected color in Color mode                  | Color sensor on 1                     |
| [gyro-sensor](./gyro-sensor/)                       | Rotation angle in Angle mode                  | Gyro sensor on 1                      |
| [sensor-details](./sensor-details/)                 | Sensor identity, mode, and raw values         | A sensor on 4                         |
| [raw-and-mode](./raw-and-mode/)                     | Choose a mode, then read a raw channel        | Color sensor on 4                     |
| [three-zone-light](./three-zone-light/)             | Two reflected-light threshold boundaries      | Color sensor on 1                     |
| [five-sample-average](./five-sample-average/)       | Average five samples with a float accumulator | Color sensor on 1                     |
| [mode-inspector](./mode-inspector/)                 | Identity, busy flag, and mode switching       | Color sensor on 1                     |
| [raw-channel-dashboard](./raw-channel-dashboard/)   | Percent and multichannel raw values           | Color sensor on 1                     |
| [rgb-function](./rgb-function/)                     | RGB mode with three output channels           | Color sensor on 1                     |
| [port-raw-access](./port-raw-access/)               | Port-specific `Sensor1`–`Sensor4` raw reads   | Color sensor on 1; raw sensors on 2–4 |
| [touch-port-grid](./touch-port-grid/)               | Read and draw all four input ports            | Touch sensors on 1–4                  |
| [i2c-registers](./i2c-registers/)                   | Read a documented I2C register                | Documented I2C device on 1            |
| [i2c-register-workbench](./i2c-register-workbench/) | Single and multiple register reads and writes | Custom I2C test device on 1           |
