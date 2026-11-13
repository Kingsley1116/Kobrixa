import { persistenceTestNodePaths } from "./persistence-source-loader.mjs";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  realpath,
  readFile,
  writeFile,
  readdir,
  rm,
  symlink,
  link,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  startPersistenceWorker,
  diagnosticsFor,
} from "../../apps/desktop/src/main/plugins/persistence/worker.ts";
import { createRecordService } from "../../apps/desktop/src/main/plugins/persistence/record-service.ts";
import {
  openStoreRoot,
  NodePersistenceFs,
  writeAll,
  classifyFsError,
} from "../../apps/desktop/src/main/plugins/persistence/filesystem.ts";
import {
  produceStorageNegative,
  storageNegativeScenarios,
  assertStorageNegativeObservation,
  storageHash,
} from "./plugin-persistence-negative-storage.ts";

let directory, entry, trigger;
const receipts = [];
before(async () => {
  directory = await realpath(await mkdtemp(path.join(tmpdir(), "w09b-storage-")));
  entry = path.join(directory, "worker.cjs");
  trigger = path.join(directory, "injection.json");
  const worker = fileURLToPath(
    new URL("../../apps/desktop/src/main/plugins/persistence/worker.ts", import.meta.url),
  );
  const filesystem = fileURLToPath(
    new URL("../../apps/desktop/src/main/plugins/persistence/filesystem.ts", import.meta.url),
  );
  await build({
    stdin: {
      contents: `
      import {runPersistenceWorker} from ${JSON.stringify(worker)};
      import {NodePersistenceFs} from ${JSON.stringify(filesystem)};
      import {readFileSync,existsSync} from 'node:fs';
      const mode=()=>existsSync(${JSON.stringify(trigger)})?JSON.parse(readFileSync(${JSON.stringify(trigger)},'utf8')).scenario:null;
      const write=NodePersistenceFs.prototype.write;
      NodePersistenceFs.prototype.write=async function(fd,offset,bytes){
        const m=mode();
        if(m==='short-write')return write.call(this,fd,offset,bytes.subarray(0,2));
        if(m==='zero-write')return 0;
        if(['ENOSPC','EDQUOT','EROFS','EACCES'].includes(m))throw Object.assign(new Error('injected syscall failure'),{code:m});
        return write.call(this,fd,offset,bytes);
      };
      const sync=NodePersistenceFs.prototype.directorySync;
      NodePersistenceFs.prototype.directorySync=async function(name){
        if(mode()==='directory-EIO')throw Object.assign(new Error('injected directory failure'),{code:'EIO'});
        return sync.call(this,name);
      };
      const unlink=NodePersistenceFs.prototype.unlink;
      NodePersistenceFs.prototype.unlink=async function(p){
        if(mode()==='cleanup-unlink')throw Object.assign(new Error('injected unlink failure'),{code:'EACCES'});
        return unlink.call(this,p);
      };
      runPersistenceWorker({mappers:new Map()});
    `,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    outfile: entry,
    nodePaths: persistenceTestNodePaths(),
    logLevel: "silent",
  });
});
after(async () => {
  // Optional raw output is a caller-selected NEW absolute path, never archived evidence.
  if (process.env.W09B_OBSERVATIONS) {
    assert.ok(path.isAbsolute(process.env.W09B_OBSERVATIONS));
    await writeFile(
      process.env.W09B_OBSERVATIONS,
      JSON.stringify(
        {
          scope: "host-worker-subproof",
          platform: process.platform,
          node: process.version,
          receipts,
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
  }
  await rm(directory, { recursive: true, force: true });
});
async function environment(userData) {
  await mkdir(userData, { recursive: true });
  const profile = { hostEpoch: randomUUID(), assertHeld() {} };
  const root = await openStoreRoot({ userData, profile });
  let fault;
  const started = await startPersistenceWorker({
    profile,
    root,
    workerEntry: entry,
    now: () => performance.now(),
    testControl: (c) => {
      fault = c;
    },
  });
  const owner = {
    sourceKey: "builtin:test.w09b",
    pluginId: "test.w09b",
    generation: 1,
    hostEpoch: profile.hostEpoch,
    processEpoch: randomUUID(),
  };
  const service = createRecordService({
    now: () => performance.now(),
    wall: Date.now,
    live: () => true,
    permission: () => true,
    engine: started.backend.engine,
    read: started.backend.reads,
    evidence: started.backend.evidence,
    checkpoint: {
      authorize: () => "none",
      committed() {},
      open: () => false,
      register: async () => {
        throw new Error("No checkpoint binding in subproof");
      },
      abandon: async () => {
        throw new Error("No checkpoint binding in subproof");
      },
    },
  });
  let closed = false;
  return {
    owner,
    backend: started.backend,
    request: service.request.bind(service),
    fault,
    snapshot: async () => ({
      core: null,
      handles: {
        scope: "record-write-projection-and-worker-jobs-only",
        writes: service.admittedWrites().map((w) => ({
          id: w.ticket.id,
          state: w.state,
          created: w.created,
          progress: w.progress,
          deadline: w.ticket.deadlineMonotonicMs,
        })),
        worker: diagnosticsFor(started.backend).snapshot(),
      },
    }),
    close: async () => {
      if (!closed) {
        closed = true;
        await service.close();
        await started.backend.dispose();
      }
    },
  };
}
async function files(root) {
  const found = [];
  for (const e of await readdir(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) found.push(...(await files(p)));
    else if (e.isFile()) found.push(p);
  }
  return found;
}
for (const [row, scenarios] of Object.entries(storageNegativeScenarios)) {
  for (const scenario of scenarios)
    test(
      `${row}: ${scenario} through production record service and real worker; reopen same profile`,
      { timeout: 60000 },
      async () => {
        const userData = path.join(directory, randomUUID());
        const env = await environment(userData);
        let outside, outsideHash;
        try {
          const observation = await produceStorageNegative(
            {
              ...env,
              root: userData,
              inject: async (mode, id) => {
                if (
                  [
                    "corrupt-object",
                    "unknown-version",
                    "symlink-object",
                    "hardlink-object",
                  ].includes(mode)
                ) {
                  const candidates = (await files(userData)).filter((p) =>
                    p.endsWith(`${path.sep}head.json`),
                  );
                  const heads = await Promise.all(
                    candidates.map(async (file) => ({
                      file,
                      document: JSON.parse(await readFile(file, "utf8")),
                    })),
                  );
                  const head = heads.find((h) => h.document.metadata?.record?.id === id);
                  assert.ok(head, "Find actual record head, never guess namespace directory");
                  if (mode === "unknown-version") {
                    head.document.formatVersion = 999;
                    await writeFile(head.file, JSON.stringify(head.document));
                  } else {
                    const object = path.join(
                      path.dirname(head.file),
                      "objects",
                      head.document.object,
                    );
                    if (mode === "corrupt-object") await writeFile(object, "damaged payload");
                    else {
                      outside = path.join(directory, `${randomUUID()}-outside`);
                      await writeFile(outside, await readFile(object));
                      outsideHash = storageHash(await readFile(outside));
                      await rm(object);
                      if (mode === "symlink-object") await symlink(outside, object);
                      else await link(outside, object);
                    }
                  }
                } else await writeFile(trigger, JSON.stringify({ scenario: mode }));
              },
              clearInjection: () => rm(trigger, { force: true }),
              reopen: async () => {
                await env.close();
                return environment(userData);
              },
            },
            row,
            scenario,
          );
          assertStorageNegativeObservation(observation);
          assert.ok(observation.gaps.some((g) => g.includes("core snapshot unavailable")));
          if (outside) assert.equal(storageHash(await readFile(outside)), outsideHash);
          receipts.push(observation);
          const broken = structuredClone(observation);
          broken.snapshots[2].epoch = broken.snapshots[0].epoch;
          assert.throws(() => assertStorageNegativeObservation(broken));
          broken.snapshots[2].epoch = randomUUID();
          broken.gaps = [];
          assert.throws(() => assertStorageNegativeObservation(broken));
        } finally {
          await rm(trigger, { force: true });
          await env.close();
        }
      },
    );
}

test("N11: explicit unsupported adapter policy differs from EIO; no silent downgrade", async () => {
  const root = path.join(directory, randomUUID());
  await mkdir(root);
  const profile = { hostEpoch: randomUUID(), assertHeld() {} };
  const unsupported = new NodePersistenceFs(root, profile, { directorySyncSupported: false });
  const supported = new NodePersistenceFs(root, profile, { directorySyncSupported: true });
  let calls = 0;
  const fail = async () => {
    calls++;
    throw Object.assign(new Error("injected"), { code: "EIO" });
  };
  unsupported.directorySync = fail;
  supported.directorySync = fail;
  await unsupported.syncDirectory(unsupported.path());
  assert.equal(calls, 0);
  assert.equal(unsupported.durability, "file-sync-only");
  await assert.rejects(supported.syncDirectory(supported.path()), { code: "EIO" });
  assert.equal(calls, 1);
  assert.equal(supported.durability, "file-and-directory-sync");
  assert.equal(classifyFsError({ code: "EIO" }), "io");
});
test("N07: real descriptor short writes preserve exact payload and zero progress fails", async () => {
  const root = path.join(directory, randomUUID());
  await mkdir(root);
  const fs = new NodePersistenceFs(root, { hostEpoch: randomUUID(), assertHeld() {} });
  const p = fs.path("short.bin"),
    fd = await fs.open(p, "create-exclusive");
  const bytes = Buffer.from("short write loop"),
    write = fs.write.bind(fs);
  let calls = 0;
  try {
    fs.write = (handle, offset, data) => {
      calls++;
      return write(handle, offset, data.subarray(0, 2));
    };
    await writeAll(fs, fd, 0, bytes);
    await fs.sync(fd);
    assert.ok(calls > 1);
    assert.deepEqual(await readFile(path.join(root, "short.bin")), bytes);
    fs.write = async () => 0;
    await assert.rejects(writeAll(fs, fd, bytes.length, Buffer.from("x")), /io/);
    assert.deepEqual(await readFile(path.join(root, "short.bin")), bytes);
  } finally {
    await fs.close(fd);
  }
});
