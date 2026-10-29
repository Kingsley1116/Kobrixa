import { readFileSync } from "node:fs";
import { it, expect } from "vitest";
const root = new URL("../../../../../plugins/device-ev3/", import.meta.url);
it("ships an entry using runPlugin and imports only public SDK/protocol, local feature, and crypto", () => {
  for (const name of ["main.ts", "controller.ts", "presentation.ts"]) {
    const text = readFileSync(new URL("src/" + name, root), "utf8");
    const imports = [...text.matchAll(/from\s+["']([^"']+)["']/g)].map((x) => x[1]);
    for (const specifier of imports)
      expect([
        "@kobrixa/plugin-sdk",
        "@kobrixa/plugin-protocol",
        "node:crypto",
        "./controller.js",
        "./presentation.js",
        "../kobrixa-plugin.json",
      ]).toContain(specifier);
    expect(text).not.toMatch(
      /(?:window\.|ipcRenderer|@kobrixa\/device|DeviceDescriptor|DeviceMonitorSnapshot|\.devices\.disconnect\(|\.motion\.|\.recording\.)/,
    );
  }
  expect(readFileSync(new URL("src/main.ts", root), "utf8")).toContain(
    "runPlugin(createDevicePlugin())",
  );
});
it("does not pretend E0 pending parity is accepted", () => {
  const text = readFileSync(new URL("./parity-fixtures.ts", import.meta.url), "utf8");
  expect(text).toContain('publicParity: "unrun"');
  expect(text).toContain("All public/v2/D1 evidence is UNRUN");
});
