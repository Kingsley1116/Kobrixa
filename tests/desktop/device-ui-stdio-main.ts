import assert from "node:assert/strict";
import path from "node:path";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { app, BrowserWindow } from "electron";
import { spawnPluginProcess, type PluginLauncher } from "@kobrixa/plugin-runtime";
import { processTable } from "./builtin-installed-client.mjs";
import type { ResourceOwner } from "@kobrixa/plugin-protocol";
import {
  composeDesktopMain,
  desktopUi,
  desktopDeviceAccess,
  desktopFoundationTestHandles,
} from "../../apps/desktop/src/main/plugins/controller.js";
import {
  createDesktopFoundation,
  type DesktopMainComposition,
} from "../../apps/desktop/src/main/device-broker/lifecycle-coordinator.js";
import { AuthorityContexts } from "../../apps/desktop/src/main/device-broker/authority-context.js";
import {
  createFakeDeviceProvider,
  type FakeProviderControl,
} from "../../apps/desktop/src/main/device-broker/fake-provider.js";
import { createJournal } from "../../apps/desktop/src/main/device-broker/journal.js";
import { createJournalFilesystem } from "../../apps/desktop/src/main/device-broker/journal-filesystem.js";
import { createCoreActionLedger } from "../../apps/desktop/src/main/plugins/core-recovery.js";
import { startPrimary } from "../../apps/desktop/src/main/plugins/profile-writer-lock.js";
import { filePluginStateStore } from "../../apps/desktop/src/main/plugins/state-store.js";
import { BUILTIN_PLUGIN_SOURCES } from "../../apps/desktop/src/main/plugins/builtin.js";
import { diagnosticsFor } from "../../apps/desktop/src/main/plugins/ui-bridge.js";
import {
  persistenceWorkerCount,
  diagnosticsFor as workerDiagnostics,
} from "../../apps/desktop/src/main/plugins/persistence/worker.js";

type Json = Record<string, unknown>;
function object(value: unknown): Json {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Json;
}
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until<T>(
  check: () => T | Promise<T>,
  label: string,
  ms = 15_000,
): Promise<NonNullable<T>> {
  const end = performance.now() + ms;
  for (;;) {
    const result = await check();
    if (result) return result as NonNullable<T>;
    assert.ok(performance.now() < end, `Missing observation: ${label}`);
    await pause(20);
  }
}

/** Inert until called before app readiness. This fixture is synthetic Python device acceptance,
 * not the product EV3 process, renderer acceptance or installed evidence. */
export function runDeviceStdio(): void {
  assert.equal(app.isReady(), false);
  const root = app.commandLine.getSwitchValue("stdio-root");
  assert.ok(path.isAbsolute(root));
  app.setPath("userData", path.join(root, "profile"));
  const wire: Array<{
    owner: ResourceOwner;
    direction: "host-plugin" | "plugin-host";
    sequence: number;
    at: number;
    message: Json;
  }> = [];
  const launches: Json[] = [],
    exits: Json[] = [],
    logs: string[] = [],
    failures: string[] = [];
  const checkpoints: Json = {};
  let seq = 0,
    stage = "startup";
  let live: DesktopMainComposition | undefined,
    window: BrowserWindow | undefined,
    cleanup: Json | undefined;
  let control: FakeProviderControl | undefined;
  let blocked = false;
  const now = () => performance.now();
  const primary = startPrimary(
    app,
    async (profile) => {
      try {
        const config = object(JSON.parse(await readFile(path.join(root, "config.json"), "utf8")));
        assert.equal(typeof config.python, "string");
        const folders = ["owner", "denied"].map((role) => path.join(root, role));
        const settings = filePluginStateStore(app.getPath("userData"));
        await settings.load();
        await settings.update((s) => ({
          ...s,
          developerMode: true,
          sources: folders.map((directory) => ({ directory })),
          python: { executable: String(config.python), args: [] },
        }));
        window = new BrowserWindow({
          show: false,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        });
        const sender = window.webContents.id;
        const authority = new AuthorityContexts(profile.hostEpoch),
          document = authority.open(sender);
        authority.report(sender, {
          document,
          sequence: 1,
          state: "local",
          roomId: null,
          connected: true,
          synced: true,
          role: null,
          isHolder: true,
        });
        const scope = () => {
          const p = authority.core(sender, "recovery");
          return { hostEpoch: p.hostEpoch, workbenchInstance: p.workbenchInstance };
        };
        const currentScope = (s: ReturnType<typeof scope>) =>
          !!window &&
          !window.isDestroyed() &&
          s.hostEpoch === scope().hostEpoch &&
          s.workbenchInstance === scope().workbenchInstance;
        const journal = createJournal(
          createJournalFilesystem(await realpath(app.getPath("userData"))),
          profile,
        );
        await journal.load();
        const launcher: (hooks: {
          onOutput?(plugin: unknown, line: string): void;
        }) => PluginLauncher = (hooks) => async (plugin) => {
          assert.equal(plugin.runtime, "python");
          assert.ok(plugin.channelOwner);
          const owner = structuredClone(plugin.channelOwner);
          const role = path.basename(plugin.directory);
          assert.ok(["owner", "denied"].includes(role));
          const env = {
            ...process.env,
            PYTHONPATH: path.join(root, "python"),
            PYTHONDONTWRITEBYTECODE: "1",
            KOBRIXA_RESOURCE_OWNER: JSON.stringify(owner),
          };
          // spawnPluginProcess wraps the real child pipes with production stdioProcess.
          const child = await spawnPluginProcess(
            String(config.python),
            ["-u", "-B", plugin.entry, role],
            {
              cwd: plugin.directory,
              env,
              onOutput: (line) => {
                hooks.onOutput?.(plugin, line);
                logs.push(line);
              },
            },
          );
          launches.push({ owner, role, entry: plugin.entry, at: now() });
          child.onExit((exit) => exits.push({ owner, exit, at: now() }));
          const observe = (direction: "host-plugin" | "plugin-host", text: string) =>
            wire.push({
              owner,
              direction,
              sequence: ++seq,
              at: now(),
              message: object(JSON.parse(text)),
            });
          return {
            ...child,
            send(text) {
              observe("host-plugin", text);
              child.send(text);
            },
            onMessage(listener) {
              return child.onMessage((text) => {
                observe("plugin-host", text);
                listener(text);
              });
            },
          };
        };
        live = await composeDesktopMain(
          {
            createFoundation: (options) =>
              createDesktopFoundation({
                ...options,
                providerFactory: (catalog) => {
                  const fake = createFakeDeviceProvider({ catalog, now: options.now });
                  control = fake.control;
                  return fake.provider;
                },
              }),
            foundationOptions: {
              profile,
              authority,
              journal,
              coreActions: createCoreActionLedger({ now, current: currentScope }),
              now,
              hasPermission: (p, permission) =>
                p.kind === "core"
                  ? currentScope(p) && ["devices.read", "devices.connect"].includes(permission)
                  : !!live && desktopDeviceAccess(live.plugins).hasPermission(p.owner, permission),
              requirements: (owner) =>
                live ? desktopDeviceAccess(live.plugins).requirements(owner) : null,
              connectionPolicy: () => ({
                wifiConnectTimeoutMs: 10000,
                wifiHandshakeTimeoutMs: 5000,
                usbAutoReconnect: false,
                usbRetryInterval: 2000,
                usbRetryLimit: 3,
              }),
              operationGate: () => ({ ok: true, value: null }),
            },
            plugins: {
              userData: app.getPath("userData"),
              builtins: BUILTIN_PLUGIN_SOURCES,
              commandLine: { developmentDirectories: [], safeMode: false },
              locale: "en",
              launcher,
              dialogs: {
                confirmDeveloperMode: async () => true,
                chooseFolder: async () => undefined,
                confirmLink: async () => true,
                confirmUnlink: async () => true,
                choosePython: async () => undefined,
              },
            },
            principal: (owner) => authority.plugin(sender, owner),
            scope,
            currentScope,
            legacyFlush: async () => {},
            report: (error) => failures.push(String(error)),
          },
          { worker: { entry: path.join(root, "worker.cjs"), control() {} } },
        );
        const composition = live,
          ui = desktopUi(live),
          handles = desktopFoundationTestHandles(live);
        const catalog = await ui.bridge.catalog({});
        assert.ok(catalog.ok);
        const entry = catalog.value.entries.find(
          (e) => e.pluginId === "acceptance.device-stdio" && e.kind === "panel",
        );
        assert.ok(entry);
        const opened = await ui.bridge.open({
          sourceKey: entry.sourceKey,
          id: entry.id,
          uiResourceGeneration: entry.uiResourceGeneration,
        });
        assert.ok(opened.ok);
        const binding = opened.value.binding;
        assert.ok((await ui.bridge.visibility({ binding, visible: true, reason: "tab" })).ok);
        checkpoints.binding = binding;
        const execute = async (id: string) => {
          const result = await composition.plugins.execute(id);
          assert.ok(result.ok, JSON.stringify(result));
        };
        stage = "owner";
        await execute("acceptance.device-stdio.run");
        stage = "denied";
        assert.ok(control);
        checkpoints.deniedBefore = control.trace();
        await execute("acceptance.device-stdio-denied.run");
        checkpoints.deniedAfter = control.trace();
        // Python's reported PID is independently matched against the OS parent table.
        const table = await processTable();
        for (const launch of launches) {
          const ready = logs
            .filter((line) => line.startsWith("DEVICE_STDIO:"))
            .map((line) => object(JSON.parse(line.slice(13))))
            .find(
              (row) =>
                row.role === launch.role &&
                row.stage === (launch.role === "owner" ? "ready" : "done"),
            );
          assert.ok(ready && Number.isSafeInteger(ready.pid));
          const os = table.find((row) => row.pid === ready.pid && row.ppid === process.pid);
          assert.ok(os, "Missing actual Python child PID");
          launch.pid = os.pid;
          launch.parentPid = os.ppid;
        }
        checkpoints.processes = {
          parentPid: process.pid,
          rows: table.filter((row) => launches.some((l) => l.pid === row.pid)),
        };
        stage = "cancel";
        assert.ok(control);
        control.block("before-exchange", "read");
        blocked = true;
        const cancellation = execute("acceptance.device-stdio.cancel");
        // Install rejection observation immediately while the provider barrier is outstanding.
        void cancellation.catch(() => {});
        let reached = false;
        void control.reached("before-exchange", "read").then(() => {
          reached = true;
        });
        await until(() => reached, "controlled read barrier");
        const request = wire.findLast(
          (row) => row.direction === "plugin-host" && row.message.method === "devices/read",
        );
        assert.ok(request);
        checkpoints.cancel = {
          owner: request.owner,
          requestId: request.message.id,
          reachedAt: now(),
        };
        await writeFile(path.join(root, "owner/cancel.json"), "{}");
        await until(
          () =>
            wire.some(
              (row) =>
                row.direction === "plugin-host" &&
                row.message.method === "$/cancelRequest" &&
                JSON.stringify(row.owner) === JSON.stringify(request.owner) &&
                row.message.params &&
                object(row.message.params).id === request.message.id,
            ),
          "SDK cancellation frame",
        );
        control.release("before-exchange", "read");
        blocked = false;
        await cancellation;
        await until(
          () =>
            wire.some(
              (row) =>
                row.direction === "host-plugin" &&
                JSON.stringify(row.owner) === JSON.stringify(request.owner) &&
                row.message.id === request.message.id &&
                !row.message.method &&
                row.message.error,
            ),
          "cancelled read response",
        );
        checkpoints.providerTrace = control.trace();
        stage = "cleanup";
        await live.dispose();
        await until(() => exits.length === launches.length, "all Python exits");
        cleanup = {
          bridge: diagnosticsFor(ui.bridge).snapshot(),
          worker: workerDiagnostics(handles.backend).snapshot(),
          workers: persistenceWorkerCount(handles.backend),
        };
        for (const counters of [cleanup.bridge, cleanup.worker])
          for (const [key, count] of Object.entries(object(counters))) assert.equal(count, 0, key);
        assert.equal(cleanup.workers, 0);
        assert.deepEqual(failures, []);
        stage = "complete";
      } catch (error) {
        failures.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
        if (blocked) {
          control?.release("before-exchange", "read");
          blocked = false;
        }
        await live?.dispose().catch((error) => failures.push(String(error)));
      } finally {
        await writeFile(
          path.join(root, "producer.json"),
          JSON.stringify(
            {
              schema: 1,
              claim: "synthetic-device-python-stdio",
              stage,
              wire,
              launches,
              exits,
              checkpoints,
              cleanup,
              logs,
              failures,
            },
            null,
            2,
          ),
        );
        if (window && !window.isDestroyed()) window.destroy();
        app.exit(stage === "complete" ? 0 : 1);
      }
    },
    () => false,
  );
  assert.ok(primary);
  void primary.ready.catch(async (error) => {
    await writeFile(
      path.join(root, "producer.json"),
      JSON.stringify({ stage, failures: [String(error)] }),
    );
    app.exit(1);
  });
}
