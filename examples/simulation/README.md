# Local 2D simulator

<a href="../README.md">All examples</a> · <a href="./README.zh-TW.md">繁體中文</a>

Open a project folder in Kobrixa, choose **Local simulator** (Alt+F5), and run its saved `kobrixa.simulator.json`. These practice scenes isolate one lesson on the WRO Double Tennis 2026 field. They are teaching configurations, not certified competition submissions. No EV3 or network connection is needed.

Default differential wheels are **B left / C right**, 56 mm diameter and 120 mm track width. The synthetic vision examples check `Sensor.GetName(4)` before using the simulator-only sensor. The ordinary motor examples can also compile for hardware; verify the actual robot's ports and geometry before using Run on EV3.

## Projects

| Example                                       | What it teaches                                   | Hardware                 |
| --------------------------------------------- | ------------------------------------------------- | ------------------------ |
| [differential-route](./differential-route/)   | Encoder travel and a 90° turn                     | Simulator; no EV3 needed |
| [omni-lateral](./omni-lateral/)               | Lateral and forward motion with four omni wheels  | Simulator; no EV3 needed |
| [vision-search](./vision-search/)             | Synthetic vision with a sensor identity guard     | Simulator; no EV3 needed |
| [pixy2-search](./pixy2-search/)               | Pixy2 LEGO I2C signature counts and blocks        | Simulator; no EV3 needed |
| [motor-shooter](./motor-shooter/)             | A motor stroke launches a nearby ball             | Simulator; no EV3 needed |
| [mailbox-cooperation](./mailbox-cooperation/) | Two entries exchange a target and acknowledgement | Simulator; no EV3 needed |
