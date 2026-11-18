import { mkdtemp, realpath, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { build } from "vite";
import { it, expect } from "vitest";
import { startPersistenceWorker } from "./worker.js";
import { openStoreRoot } from "./filesystem.js";
import { SensorLabMigrationGate } from "./sensor-lab-migration.js";
import type { PublicationTicket } from "./engine-port.js";
import { publicationTicketSchema } from "./namespace.js";
import { channelKey } from "../../../../../../plugins/sensor-lab/src/model/data.js";
import { identityCalibration } from "../../../../../../plugins/sensor-lab/src/model/calibration.js";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

it("imports fifty maximum-byte legacy files and profiles, then a real worker restart preserves deletion and original bytes", async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "lab-import-load-")));
  let worker: Awaited<ReturnType<typeof startPersistenceWorker>> | undefined;
  let stage = "prepare";
  try {
    const source = path.join(directory, "entry.ts"),
      entry = path.join(directory, "bundle/worker.cjs");
    await writeFile(
      source,
      `import { runShippedPersistenceWorker } from ${JSON.stringify(fileURLToPath(new URL("./worker.ts", import.meta.url)))};runShippedPersistenceWorker();`,
    );
    await build({
      configFile: false,
      logLevel: "error",

      build: {
        target: "node24",
        outDir: path.dirname(entry),
        emptyOutDir: true,
        lib: { entry: source, formats: ["cjs"], fileName: () => "worker.cjs" },
        rollupOptions: { external: [/^node:/] },
        minify: false,
      },
    });
    const userData = path.join(directory, "profile"),
      legacyRoot = path.join(userData, "sensor-lab");
    await mkdir(path.join(legacyRoot, "recordings"), { recursive: true });
    await mkdir(path.join(legacyRoot, "calibrations"));
    const channel = {
      id: "",
      kind: "input" as const,
      port: 0,
      type: 30,
      mode: 0,
      channel: 1,
      name: "US",
      modeName: "distance",
      unit: "cm",
      decimals: 1,
    };
    channel.id = channelKey(channel);
    const calibration = identityCalibration("cm"),
      original = new Map<string, string>();
    // Whitespace is legal JSON. This deliberately stresses source-byte bounds,
    // not a claim that the mapped canonical model itself consumes 8 MiB.
    for (let n = 0; n < 50; n++) {
      const id = randomUUID();
      const json = JSON.stringify({
        schemaVersion: 1,
        id,
        name: `Trial ${n}`,
        startedAt: 100,
        durationMs: 0,
        frameCount: 1,
        device: { id: "brick", name: "EV3", transport: "usb" },
        channels: [{ source: channel, calibration }],
        frames: [{ sampledAt: 100, elapsedMs: 0, values: [3], status: "ok", segment: 0 }],
      });
      const bytes = Buffer.alloc(8 * 1024 * 1024, 32);
      bytes.write(json);
      const file = path.join(legacyRoot, "recordings", `${id}.json`);
      await writeFile(file, bytes);
      original.set(file, hash(bytes));
      if (n < 4) {
        const file = path.join(legacyRoot, "calibrations", `${id}.json`);
        const bytes = Buffer.from(
          JSON.stringify({
            schemaVersion: 1,
            profile: { id, name: `Profile ${n}`, source: channel, calibration },
          }),
        );
        await writeFile(file, bytes);
        original.set(file, hash(bytes));
      }
    }
    const launch = async () => {
      const profile = { hostEpoch: randomUUID(), assertHeld() {} };
      const root = await openStoreRoot({ userData, profile });
      worker = await startPersistenceWorker({
        profile,
        root,
        workerEntry: entry,
        now: () => performance.now(),
      });
      const owner = {
        sourceKey: "builtin:kobrixa.sensor-lab",
        pluginId: "kobrixa.sensor-lab",
        generation: 1,
        hostEpoch: profile.hostEpoch,
        processEpoch: randomUUID(),
      };
      const gate = new SensorLabMigrationGate({
        backend: worker.backend,
        writers: [],
        active: () => true,
        owner: () => owner,
        currentScope: () => true,
      });
      await gate.prepare(new AbortController().signal);
      gate.assertReady();
      return owner;
    };
    stage = "first migration";
    const owner = await launch();
    stage = "first list";
    const records = (await worker!.backend.reads.list(owner, { limit: 64 })).entries;
    expect(records.filter((r) => r.kind === "sensor-lab.recording")).toHaveLength(50);
    expect(records.filter((r) => r.kind === "sensor-lab.calibration")).toHaveLength(4);
    const removed = records.find((r) => r.kind === "sensor-lab.recording")!;
    const ticket: PublicationTicket = publicationTicketSchema.parse({
      id: randomUUID(),
      owner,
      deadlineMonotonicMs: performance.now() + 10000,
      target: { kind: "record", id: removed.id, expectedRevision: removed.revision },
      metadata: {
        kind: "record",
        record: { ...removed, revision: `r_${randomUUID().replaceAll("-", "")}` },
        deleted: true,
      },
    });
    stage = "delete reserve";
    await worker!.backend.engine.reserve(ticket, 0);
    await worker!.backend.engine.seal(ticket, 0, hash(new Uint8Array()));
    stage = "delete publish";
    expect((await worker!.backend.engine.publish(ticket)).disposition).toBe("committed");
    stage = "first worker close";
    await worker!.backend.dispose();
    worker = undefined;
    stage = "restarted migration";
    const restartedOwner = await launch();
    stage = "restarted list";
    const restarted = (await worker!.backend.reads.list(restartedOwner, { limit: 64 })).entries;
    expect(restarted).toHaveLength(53);
    expect(restarted.some((record) => record.id === removed.id)).toBe(false);
    expect(restarted.map((record) => record.id).sort()).toEqual(
      records
        .filter((record) => record.id !== removed.id)
        .map((record) => record.id)
        .sort(),
    );
    for (const [file, digest] of original) expect(hash(await readFile(file))).toBe(digest);
  } catch (error) {
    throw new Error(`Migration load failed during ${stage}`, { cause: error });
  } finally {
    await worker?.backend.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);
