import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { sensorLabImportDescriptors } from "./sensor-lab-import.js";
import { WorkerSources } from "./worker.js";
import { AtomicStore } from "./atomic-store.js";
import { createNodePersistenceFs } from "./filesystem.js";
import { legacy, id, bytes } from "../../../builtin-features/sensor-lab/legacy-import.test.js";

function input(value: unknown, basename = `${id}.json`) {
  const data = bytes(value);
  return {
    sourceKind: "sensor-lab" as const,
    bytes: data,
    sha256: createHash("sha256").update(data).digest("hex"),
    file: { basename },
  };
}
it("maps each real legacy envelope with exact filename identity and target digest", () => {
  const recording = legacy(),
    profile = { schemaVersion: 1, profile: { id, name: "Profile", ...recording.channels[0]! } };
  for (const [index, value] of [recording, profile].entries()) {
    const descriptor = sensorLabImportDescriptors[index]!;
    const original = input(value);
    expect(descriptor.validate(original)).toBe(true);
    const mapped = descriptor.map(original);
    expect(mapped.kind).toBe("record");
    if (mapped.kind !== "record") throw Error("record expected");
    expect(mapped.metadata.schemaVersion).toBe(2);
    expect(mapped.metadata.kind).toBe(index ? "sensor-lab.calibration" : "sensor-lab.recording");
    expect(mapped.metadata.sha256).toBe(createHash("sha256").update(mapped.bytes).digest("hex"));
    expect(mapped.metadata.byteLength).toBe(mapped.bytes.length);
    expect(JSON.parse(new TextDecoder().decode(mapped.bytes)).id).toBe(id);
    for (const invalid of [
      { sourceKind: original.sourceKind, bytes: original.bytes, sha256: original.sha256 },
      input(value, `${randomUUID()}.json`),
      input(value, `../${id}.json`),
      input(value, `${id.toUpperCase()}.json`),
      { ...original, sha256: "0".repeat(64) },
      input({ ...value, schemaVersion: 2 }),
      input({ ...value, formatVersion: 1 }),
      input(index ? recording : profile),
    ])
      expect(descriptor.validate(invalid)).toBe(false);
  }
});
it("inventories and revalidates actual schemaVersion files through WorkerSources", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "lab-import-")));
  await mkdir(path.join(root, "destination"));
  const fs = await createNodePersistenceFs(path.join(root, "destination"), {
    hostEpoch: randomUUID(),
    assertHeld() {},
  });
  const store = new AtomicStore(fs);
  try {
    const folders = sensorLabImportDescriptors.map((_, i) =>
      path.join(root, i ? "calibrations" : "recordings"),
    );
    await Promise.all(folders.map((folder) => mkdir(folder)));
    const recording = legacy();
    await writeFile(path.join(folders[0]!, `${id}.json`), bytes(recording));
    await writeFile(
      path.join(folders[1]!, `${id}.json`),
      bytes({ schemaVersion: 1, profile: { id, name: "Profile", ...recording.channels[0]! } }),
    );
    const sources = new WorkerSources(
      fs.root,
      store,
      new Map(sensorLabImportDescriptors.map((d) => [d.id, d])),
      new Map(sensorLabImportDescriptors.map((d, i) => [d.id, folders[i]!])),
    );
    for (const descriptor of sensorLabImportDescriptors) {
      await sources.register({
        descriptorId: descriptor.id,
        mapperId: descriptor.id,
        sourceKind: descriptor.sourceKind,
      });
      const inventory = await sources.inventory(descriptor.id);
      expect(inventory.state).toBe("present");
      expect(inventory.entries[0]).toMatchObject({ key: `${id}.json`, format: 1 });
      const mapped = await sources.map(descriptor.id, `${id}.json`);
      expect(mapped.kind).toBe("record");
      await sources.releaseMapped(mapped.mapped);
    }
    await writeFile(
      path.join(folders[0]!, `${id}.json`),
      bytes({ ...recording, id: randomUUID() }),
    );
    expect((await sources.inventory(sensorLabImportDescriptors[0]!.id)).state).toBe("blocked");
    await expect(sources.map(sensorLabImportDescriptors[0]!.id, `${id}.json`)).rejects.toThrow();
  } finally {
    await store.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
