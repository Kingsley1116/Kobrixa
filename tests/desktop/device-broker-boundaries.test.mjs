import { sensorLabAcceptanceHandoff } from "./sensor-lab-smoke.mjs";
import { motorAcceptanceHandoff } from "./motor-test-smoke.mjs";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { root } from "./device-broker-harness.mjs";

async function sources(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await sources(file)));
    else if (/\.(?:ts|tsx|mjs|py)$/.test(entry.name) && !/\.test\./.test(entry.name))
      result.push(file);
  }
  return result;
}

test("F14: SDK consumers have no private device, transport or gesture authority", async () => {
  for (const name of ["consumer.ts", "consumer.py"]) {
    const text = await readFile(
      path.join(root, "tests/desktop/fixtures/device-broker", name),
      "utf8",
    );
    assert.doesNotMatch(
      text,
      /@kobrixa\/(?:device|plugin-runtime)|apps\/desktop|kobrixa\._|beginGesture|pulseGesture|bindMotionScope|isHolder/,
    );
    assert.match(
      text,
      name.endsWith(".ts") ? /from "@kobrixa\/plugin-sdk"/ : /from kobrixa import Plugin/,
    );
  }
});

test("F14: runtime imports no desktop implementation; legacy services own no transport", async () => {
  for (const file of await sources(path.join(root, "packages/plugin-runtime/src"))) {
    const text = await readFile(file, "utf8");
    assert.doesNotMatch(
      text,
      /from\s+["'][^"']*(?:electron|apps\/desktop|device-providers)[^"']*["']/,
      file,
    );
  }
  for (const file of [
    "device/device.ts",
    "device/monitor-service.ts",
    "device/file-batch.ts",
    "device/remote-files.ts",
  ]) {
    const text = await readFile(path.join(root, "apps/desktop/src/main", file), "utf8");
    assert.doesNotMatch(
      text,
      /new\s+(?:Ev3Session|EV3Session|UsbTransport|WifiTransport|MotorTestEngine)\s*\(/,
      file,
    );
    assert.doesNotMatch(text, /(?:\.\/|\.\.\/)(?:device\/)?motor-test-image/, file);
  }
});

test("F07: battery owns no hardware polling clock", async () => {
  const text = await readFile(
    path.join(root, "apps/desktop/src/renderer/device/battery-status.ts"),
    "utf8",
  );
  assert.doesNotMatch(text, /setInterval|setTimeout|\.monitor\(/);
});

test("H-I runs device boundary/conformance tests and real transport smoke", async () => {
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(
    pkg.scripts["test:device-broker"],
    "node --test tests/desktop/device-broker-*.test.mjs",
  );
  assert.equal(pkg.scripts["test:device-broker:smoke"], "node tests/desktop/device-broker-run.mjs");
  assert.ok(pkg.scripts["test:desktop"].includes("pnpm test:device-broker"));
  const ci = await readFile(path.join(root, ".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /pnpm test:device-broker:smoke/);
});

test("retired motor smoke cannot silently satisfy dedicated public acceptance", async () => {
  assert.match(motorAcceptanceHandoff({}), /NOT RUN.*motor-test-public-run\.mjs --all/);
  assert.throws(
    () => motorAcceptanceHandoff({ KOBRIXA_SMOKE_MOTORS_ONLY: "1" }),
    /retired.*motor-test-public-run/,
  );
  for (const file of ["run-smoke.mjs", "smoke-main.mjs"]) {
    const text = await readFile(path.join(root, "tests/desktop", file), "utf8");
    assert.doesNotMatch(text, /motor-test-service|createMotorFixture|checkMotorTests|motorContext/);
    assert.match(text, /motorAcceptanceHandoff\(\)/);
  }
  const main = await readFile(path.join(root, "tests/desktop/smoke-main.mjs"), "utf8");
  assert.match(main, /await checkMonitor\(monitorContext\)/);
  assert.match(main, /await sampler\.disconnect\(args\[0\]\)/);
});

test("retired Lab smoke cannot silently satisfy dedicated public acceptance", async () => {
  const preload = await readFile(path.join(root, "tests/desktop/preload.cjs"), "utf8");
  assert.doesNotMatch(preload, /sensorLab|sensor-lab:|labGetState|labStart|labStop/);
  assert.doesNotMatch(
    preload,
    /startMotorTest|keepMotorTestAlive|stopMotorTest|motorTestState|onMotorTest|device:motor-test/,
  );
  assert.match(preload, /watchMonitor: call\("deviceWatchMonitor"\)/);
  const close = await readFile(path.join(root, "tests/desktop/close-smoke-main.mjs"), "utf8");
  assert.doesNotMatch(close, /sensorLab|sensor-lab:/);
  assert.match(close, /!window\.webContents\.isLoading\(\)/);
  assert.match(close, /document\.querySelector\("\.app-shell"\)/);
  assert.match(sensorLabAcceptanceHandoff({}), /NOT RUN.*sensor-lab-public-run\.mjs --run/);
  assert.throws(
    () => sensorLabAcceptanceHandoff({ KOBRIXA_SMOKE_SENSOR_LAB_ONLY: "1" }),
    /retired.*sensor-lab-public-run/,
  );
  for (const file of ["run-smoke.mjs", "smoke-main.mjs"]) {
    const text = await readFile(path.join(root, "tests/desktop", file), "utf8");
    assert.doesNotMatch(
      text,
      /SensorLabService|sensor-lab\/service|checkSensorLab|\blabContext\b|sensorLab\./,
    );
    assert.match(text, /sensorLabAcceptanceHandoff\(\)/);
  }
});
