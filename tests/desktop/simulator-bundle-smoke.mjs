import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { app, BrowserWindow } from "electron";

const directory = process.argv[2];
app.setPath("userData", path.join(directory, "test-profile"));
app.commandLine.appendSwitch("disable-background-networking");
const timeout = setTimeout(
  () => {
    console.error("Offline simulator bundle smoke timed out.");
    app.exit(1);
  },
  process.env.KOBRIXA_MAIN_SIMPLE_PROJECT ? 150_000 : 60_000,
);

// This function is serialized into the sandboxed renderer. It deliberately uses
// only browser APIs and the actual worker command protocol.
async function runWorkerCase(workerUrl, fixture) {
  const worker = new Worker(new URL(workerUrl, location.href), { type: "module" });
  const activeIds = fixture.scene.robots
    .filter((robot) => robot.controller.kind === "program")
    .map((robot) => robot.id);
  let waiters = [];
  let latest;
  let failure;
  const observedEvents = new Map();
  const observedRouteStates = new Set();
  let autoContinue = false;
  let lastContinuedViolation = 0;
  let continuations = 0;
  let previousPose;
  let backwardsDistance = 0;
  let reverseAfterCollision;
  let collisionCount = 0;
  let maxBlockedMs = 0;
  let mainSimple;
  worker.onerror = (event) => {
    failure = new Error(event.message);
    for (const waiter of waiters) waiter.reject(failure);
    waiters = [];
  };
  worker.onmessage = (event) => {
    if (event.data.type === "error") {
      failure = new Error(event.data.message);
    } else {
      latest = event.data.snapshot;
      const errors = latest.events.filter((item) => item.kind === "error");
      if (errors.length) failure = new Error(JSON.stringify(errors));
      if (fixture.mainSimple) {
        if (
          latest.status === "completed" &&
          latest.timeMs < (fixture.mainSimple.durationMs ?? 120_000)
        )
          failure = new Error(
            `Match ended at ${latest.timeMs} ms before the route observation target. Use practice mode for observations beyond match time.`,
          );
        for (const item of latest.events) {
          if (observedEvents.has(item.id)) continue;
          observedEvents.set(item.id, item);
          if (
            item.kind === "collision" &&
            item.robotId === "A1" &&
            /wall|barrier/.test(item.message)
          )
            collisionCount++;
        }
        const robot = latest.robots.find((robot) => robot.id === "A1");
        if (robot && (!previousPose || latest.timeMs > previousPose.timeMs)) {
          if (previousPose) {
            const heading = (previousPose.pose.heading * Math.PI) / 180;
            const forward =
              (robot.pose.x - previousPose.pose.x) * Math.cos(heading) +
              (robot.pose.y - previousPose.pose.y) * Math.sin(heading);
            if (forward < 0 && collisionCount) backwardsDistance -= forward;
          }
          previousPose = { timeMs: latest.timeMs, pose: robot.pose };
        }
        const motors = latest.debug?.device.motors;
        const globals = latest.debug?.globals;
        const span = latest.debug?.currentSpan;
        if (span?.file === "Main_Simple_L_2026.bp") {
          const label = fixture.mainSimple.stateLabels.findLast(
            (label) => label.line <= span.start.line,
          );
          if (label) observedRouteStates.add(label.name);
        }
        if (
          globals?.buttonstate === "E" &&
          Number(globals.last_time) > 0 &&
          Math.abs(motors.B.speed) + Math.abs(motors.C.speed) > 20
        ) {
          maxBlockedMs = Math.max(maxBlockedMs, latest.timeMs - Number(globals.last_time));
          if (maxBlockedMs >= 2000)
            failure = new Error(
              `Main_Simple route stalled at ${latest.timeMs} ms: Y=${globals.y}, is_stuck=${globals.is_stuck}. ${JSON.stringify(latest.debug.currentSpan)}`,
            );
        }
        if (collisionCount && !reverseAfterCollision && motors?.B.speed > 0 && motors?.C.speed < 0)
          reverseAfterCollision = {
            timeMs: latest.timeMs,
            motors: { B: motors.B.speed, C: motors.C.speed },
          };
        const violation = latest.events.findLast((item) => item.kind === "violation");
        if (
          autoContinue &&
          latest.status === "paused" &&
          violation &&
          violation.id > lastContinuedViolation
        ) {
          lastContinuedViolation = violation.id;
          continuations++;
          // A test action equivalent to choosing Continue practice in the UI.
          worker.postMessage({ type: "run" });
        }
      }
    }
    waiters = waiters.filter((waiter) => {
      if (failure) waiter.reject(failure);
      else if (waiter.matches(latest)) waiter.resolve(latest);
      else return true;
      return false;
    });
  };
  const waitFor = (matches) => {
    if (failure) return Promise.reject(failure);
    if (latest && matches(latest)) return Promise.resolve(latest);
    return new Promise((resolve, reject) => waiters.push({ matches, resolve, reject }));
  };
  const command = async (message, matches) => {
    latest = undefined;
    worker.postMessage(message);
    return waitFor(matches);
  };
  const completed = (snapshot) =>
    activeIds.every(
      (id) => snapshot.robots.find((robot) => robot.id === id)?.status === "completed",
    );
  try {
    await command(
      { type: "load", scene: fixture.scene, prepared: fixture.prepared },
      (snapshot) => snapshot.status === "ready",
    );
    worker.postMessage({ type: "speed", value: 4 });
    autoContinue = !!fixture.mainSimple;
    if (fixture.mainSimple?.startAtMs !== undefined) {
      // Reproduce the user's exact input time independently of browser scheduling.
      // Enter at 1700 ms previously wedged the unguarded reverse loop
      // at Y=1913.57666 after ~54 seconds despite a "running" runtime status.
      for (let time = 10; time <= fixture.mainSimple.startAtMs; time += 10)
        await command({ type: "step" }, (snapshot) => snapshot.timeMs === time);
    } else worker.postMessage({ type: "run" });
    if (fixture.mainSimple) {
      const gyro = await waitFor((snapshot) => snapshot.debug?.globals.gyroresetresult === "True");
      const gyroResetAt = gyro.timeMs;
      const click = async (button) => {
        const pressed = await command(
          { type: "buttons", robotId: "A1", buttons: [button] },
          (snapshot) => snapshot.debug.device.buttons.includes(button),
        );
        await waitFor((snapshot) => snapshot.timeMs >= pressed.timeMs + 20);
        await command(
          { type: "buttons", robotId: "A1", buttons: [] },
          (snapshot) => snapshot.debug.device.buttons.length === 0,
        );
      };
      let pixyReadAt, pixyReply;
      if (fixture.mainSimple.startAtMs !== undefined) {
        await command({ type: "buttons", robotId: "A1", buttons: ["enter"] }, (snapshot) =>
          snapshot.debug.device.buttons.includes("enter"),
        );
        await command(
          { type: "buttons", robotId: "A1", buttons: [] },
          (snapshot) => snapshot.debug.device.buttons.length === 0,
        );
        worker.postMessage({ type: "run" });
      } else {
        await waitFor((snapshot) => snapshot.timeMs >= gyroResetAt + 200);
        await click("down");
        const pixy = await waitFor((snapshot) => snapshot.debug?.globals.reply?.[0] > 0);
        pixyReadAt = pixy.timeMs;
        pixyReply = pixy.debug.globals.reply;
        await waitFor((snapshot) => snapshot.timeMs >= pixyReadAt + 1500);
        await click("enter");
      }
      const driving = await waitFor(
        (snapshot) =>
          snapshot.status === "running" &&
          snapshot.timeMs >= (fixture.mainSimple.durationMs ?? 120_000),
      );
      mainSimple = {
        ...fixture.mainSimple,
        gyroResetAt,
        gyroResetResult: gyro.debug.globals.gyroresetresult,
        pixyReadAt,
        pixyReply,
        instructions: driving.debug.instructions,
        routeStates: [...observedRouteStates],
        programStatus: driving.robots.find((robot) => robot.id === "A1").status,
        distanceMm: driving.robots.find((robot) => robot.id === "A1").distance,
        backwardsDistanceMm: backwardsDistance,
        maxBlockedMs,
        reverseAfterCollision,
        collisions: [...observedEvents.values()].filter(
          (event) =>
            event.kind === "collision" &&
            event.robotId === "A1" &&
            /wall|barrier/.test(event.message),
        ),
        violations: [...observedEvents.values()].filter((event) => event.kind === "violation"),
        continuations,
        sensors: Object.fromEntries(
          Object.entries(driving.debug.device.sensors).map(([port, sensor]) => [
            port,
            { type: sensor.type, name: sensor.name, mode: sensor.mode },
          ]),
        ),
        first: driving.debug.globals.first,
        isStuck: driving.debug.globals.is_stuck,
      };
    } else await waitFor(completed);
    autoContinue = false;
    const state = await command({ type: "pause" }, (snapshot) => snapshot.status === "paused");
    const pausedAt = state.timeMs;
    await new Promise((resolve) => setTimeout(resolve, 80));
    if (latest.timeMs !== pausedAt) throw new Error("Paused worker advanced virtual time.");
    let teammate;
    if (fixture.name === "mailbox-cooperation")
      teammate = await command(
        { type: "select", robotId: "A2" },
        (snapshot) => snapshot.selectedRobotId === "A2",
      );
    const reset = await command({ type: "reset" }, (snapshot) => snapshot.status === "ready");
    const stepped = await command({ type: "step" }, (snapshot) => snapshot.timeMs === 10);
    const stopped = await command({ type: "stop" }, (snapshot) => snapshot.status === "stopped");
    return { state, teammate, reset, stepped, stopped, mainSimple };
  } finally {
    worker.terminate();
  }
}

app
  .whenReady()
  .then(async () => {
    if (process.platform === "darwin") app.setActivationPolicy("accessory");
    const { worker, fixtures } = JSON.parse(await readFile(path.join(directory, "fixtures.json")));
    const window = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    const deniedRequests = [];
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      const allowed = /^(file|data|blob):/.test(details.url);
      if (!allowed) deniedRequests.push(details.url);
      callback({ cancel: !allowed });
    });
    window.webContents.session.enableNetworkEmulation({ offline: true });
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    await window.loadFile(path.join(directory, "renderer/simulator-bundle-smoke.html"));
    assert.equal(window.webContents.getLastWebPreferences().sandbox, true);
    assert.deepEqual(
      await window.webContents.executeJavaScript(
        "({protocol:location.protocol,require:typeof require,process:typeof process})",
      ),
      { protocol: "file:", require: "undefined", process: "undefined" },
    );
    const reports = [];
    for (const fixture of fixtures) {
      const result = await window.webContents.executeJavaScript(
        `(${runWorkerCase.toString()})(${JSON.stringify(worker)},${JSON.stringify(fixture)})`,
      );
      const { state, teammate, reset, stepped, stopped, mainSimple } = result;
      assert.ok(state.debug.device.lcd.pixels.some(Boolean), `${fixture.name}: LCD output`);
      assert.equal(reset.timeMs, 0);
      assert.equal(stepped.timeMs, 10);
      assert.equal(stopped.status, "stopped");
      assert.ok(Object.values(stopped.debug.device.motors).every((motor) => motor.speed === 0));
      const a1 = state.robots.find((robot) => robot.id === "A1");
      switch (fixture.name) {
        case "differential-route":
          assert.ok(Math.abs(a1.pose.x - 602) < 5 && Math.abs(a1.pose.y - 926) < 5);
          assert.ok(Math.abs(a1.pose.heading - 90) < 1);
          assert.ok(state.debug.device.events.some((event) => event.detail === "Route complete"));
          break;
        case "omni-lateral":
          assert.ok(a1.pose.x > 435 && a1.pose.y > 885 && a1.pose.heading > 45);
          break;
        case "vision-search":
          assert.equal(state.debug.globals.found, true);
          assert.ok(a1.pose.x > 480);
          assert.ok(
            state.debug.device.events.some((event) => event.detail === "Orange ball found"),
          );
          break;
        case "pixy2-search":
          assert.equal(state.debug.globals.count, 1);
          assert.ok(state.debug.globals.width > 0 && state.debug.globals.height > 0);
          assert.equal(a1.distance, 0);
          break;
        case "motor-shooter":
          assert.ok(a1.distance < 1 && state.balls[0].x > 800);
          assert.equal(
            state.events.filter((event) => event.message.includes("fired loaded-orange")).length,
            1,
          );
          break;
        case "mailbox-cooperation":
          assert.equal(state.debug.globals.done, "Runner arrived");
          assert.ok(Math.abs(teammate.debug.globals.distance - 325) < 0.1);
          assert.ok(Math.abs(state.robots.find((robot) => robot.id === "A2").pose.x - 575) < 1);
          break;
        case "Main_Simple_L_2026":
          assert.deepEqual(mainSimple.controller, {
            kind: "program",
            entry: "Main_Simple_L_2026.bp",
          });
          assert.equal(mainSimple.gyroResetResult, "True");
          for (const phase of ["State_FIRST", "State_BACK", "State_SECOND"])
            assert.ok(
              mainSimple.routeStates.includes(phase),
              `The real program must reach ${phase}.`,
            );
          if (mainSimple.startAtMs === undefined)
            assert.ok(
              mainSimple.pixyReply[0] > 0,
              "The Down-button Pixy2 diagnostic must detect a ball.",
            );
          assert.ok(
            state.timeMs >= (mainSimple.durationMs ?? 120_000),
            "The original main loop must run for at least two virtual minutes.",
          );
          assert.equal(
            mainSimple.programStatus,
            "running",
            "The main loop should remain live after the smoke interval.",
          );
          assert.ok(mainSimple.instructions > 0 && mainSimple.distanceMm > 100);
          assert.ok(
            mainSimple.maxBlockedMs < 2000,
            "Running status must not hide a stalled route.",
          );
          assert.ok(
            mainSimple.collisions.length > 0,
            "The configured robot must encounter a wall or barrier.",
          );
          assert.ok(
            mainSimple.reverseAfterCollision && mainSimple.backwardsDistanceMm > 1,
            "The robot must command reverse and travel backwards after a collision.",
          );
          assert.deepEqual(Object.keys(mainSimple.sensors), ["1", "2", "3", "4"]);
          assert.ok(
            Object.values(mainSimple.sensors).every((sensor) => sensor.name && sensor.type > 0),
          );
          break;
      }
      const report = {
        example: fixture.name,
        elapsedMs: state.timeMs,
        robots: state.robots.map(({ id, pose, status }) => ({ id, pose, status })),
        lcdPixels: state.debug.device.lcd.pixels.filter(Boolean).length,
        ...(mainSimple ? { mainSimple } : {}),
      };
      reports.push(report);
      console.log(`PASS offline file:// module worker: ${fixture.name}`, report);
    }
    assert.deepEqual(deniedRequests, [], "The worker attempted an external network request.");
    await writeFile(
      path.join(directory, "simulator-bundle-results.json"),
      JSON.stringify({ worker, networkRequests: deniedRequests, reports }, null, 2),
    );
    clearTimeout(timeout);
    window.destroy();
    app.exit(0);
  })
  .catch((error) => {
    console.error(error);
    clearTimeout(timeout);
    app.exit(1);
  });
