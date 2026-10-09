# Projects and includes

<a href="../README.md">All examples</a> · <a href="./README.zh-TW.md">繁體中文</a>

Split a program into project-relative `.bpi` include files and `.bpm` import modules. Include and Import names omit the extension, matching the public Basic Plus syntax.

Lift the robot before running projects that drive motors so they can turn safely.

## Projects

| Example                                     | What it teaches                                      | Hardware                                 |
| ------------------------------------------- | ---------------------------------------------------- | ---------------------------------------- |
| [include-settings](./include-settings/)     | One extension-free `Include` and shared values       | Motors A and D                           |
| [include-multiple](./include-multiple/)     | Multiple project-relative `.bpi` files               | Motor A                                  |
| [include-behaviors](./include-behaviors/)   | Two `.bpi` files share motor settings and RGB output | Medium motors A and B; color sensor on 1 |
| [import-functions](./import-functions/)     | Imported `.bpm` Function return value                | Display                                  |
| [import-module](./import-module/)           | A private helper from an imported module             | Display                                  |
| [import-calibration](./import-calibration/) | An imported Function clamps values to 0–100          | Display                                  |
| [nested-imports](./nested-imports/)         | Includes plus a module importing another module      | Display                                  |
