import assert from "node:assert/strict";
import path from "node:path";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { app, BrowserWindow, clipboard } from "electron";
import {
  spawnPluginProcess,
  type DrainOffer,
  type DrainReport,
  type PluginLauncher,
} from "@kobrixa/plugin-runtime";
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
import { createFakeDeviceProvider } from "../../apps/desktop/src/main/device-broker/fake-provider.js";
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
function value(result: unknown): Json {
  const r = object(result);
  assert.equal(r.ok, true, JSON.stringify(r));
  return object(r.value);
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

/** Inert until called before app readiness. This fixture is synthetic Python parity,
 * not the product Lab process, renderer acceptance or installed evidence. */
export function runStdio(): void {
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
  const drains: Array<{ offer: DrainOffer; at: number; report?: DrainReport }> = [];
  const checkpoints: Json = {};
  let seq = 0,
    stage = "startup";
  let live: DesktopMainComposition | undefined,
    window: BrowserWindow | undefined,
    cleanup: Json | undefined;
  let restoreDrain = () => {};
  const now = () => performance.now();
  const primary = startPrimary(
    app,
    async (profile) => {
      try {
        const config = object(JSON.parse(await readFile(path.join(root, "config.json"), "utf8")));
        assert.equal(typeof config.python, "string");
        const folders = ["owner", "foreign", "denied"].map((role) => path.join(root, role));
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
          assert.ok(["owner", "foreign", "denied"].includes(role));
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
                providerFactory: (catalog) =>
                  createFakeDeviceProvider({ catalog, now: options.now }).provider,
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
        const original = handles.host.participant.drain;
        handles.host.participant.drain = function (offer, dispatch) {
          const row: (typeof drains)[number] = { offer: structuredClone(offer), at: now() };
          drains.push(row);
          return original.call(this, offer, dispatch).then((report) => {
            row.report = structuredClone(report);
            return report;
          });
        };
        restoreDrain = () => {
          handles.host.participant.drain = original;
        };
        value(
          await live.foundation.broker.request(
            authority.core(sender, "recovery"),
            "devices/connect",
            {
              target: {
                kind: "wifi-address",
                providerId: "kobrixa.device-ev3",
                address: "127.0.0.1",
              },
            },
            new AbortController().signal,
          ),
        );
        const catalog = await ui.bridge.catalog({});
        assert.ok(catalog.ok);
        const entry = catalog.value.entries.find(
          (e) => e.pluginId === "acceptance.lab-stdio" && e.kind === "panel",
        );
        assert.ok(entry);
        const opened = await ui.bridge.open({
          sourceKey: entry.sourceKey,
          id: entry.id,
          uiResourceGeneration: entry.uiResourceGeneration,
        });
        assert.ok(opened.ok);
        const binding = opened.value.binding;
        assert.equal(binding.kind, "panel");
        assert.ok((await ui.bridge.visibility({ binding, visible: true, reason: "tab" })).ok);
        checkpoints.binding = structuredClone(binding);
        const execute = async (id: string) => {
          await until(
            () =>
              logs.some(
                (line) =>
                  line.includes('"stage": "ready"') &&
                  line.includes(
                    `"role": "${id.includes("foreign") ? "foreign" : id.includes("denied") ? "denied" : "owner"}"`,
                  ),
              ) || id !== "acceptance.lab-stdio.run",
            "owner ready",
          );
          const result = await composition.plugins.execute(id);
          assert.ok(result.ok, JSON.stringify(result));
        };
        stage = "python-owner";
        await execute("acceptance.lab-stdio.run");
        const owner = object(launches.find((row) => row.role === "owner")).owner;
        const exchanges = (method: string) =>
          wire
            .filter(
              (r) =>
                JSON.stringify(r.owner) === JSON.stringify(owner) &&
                r.direction === "plugin-host" &&
                r.message.method === method,
            )
            .flatMap((request) => {
              const response = wire.find(
                (r) =>
                  r.direction === "host-plugin" &&
                  JSON.stringify(r.owner) === JSON.stringify(owner) &&
                  r.sequence > request.sequence &&
                  r.message.id === request.message.id &&
                  !r.message.method,
              );
              return response ? [{ request, response }] : [];
            });
        const first = (method: string) =>
          exchanges(method).find((r) => object(r.response.message.result).ok === true);
        const reserved = first("devices/recording/reserve"),
          pinned = first("storage/openRead");
        assert.ok(reserved && pinned);
        const reference = {
          binding,
          read: value(pinned.response.message.result).read,
          reservation: object(value(reserved.response.message.result).reservation).reservationId,
        };
        for (const role of ["foreign", "denied"]) {
          await writeFile(path.join(root, role, "reference.json"), JSON.stringify(reference));
          stage = `python-${role}`;
          await execute(`acceptance.lab-stdio-${role}.run`);
        }
        stage = "original-drain";
        await execute("acceptance.lab-stdio.finish");
        await until(
          () =>
            drains.find(
              (row) => row.report?.state === "saved" && row.offer.checkpoints.length === 1,
            ),
          "original host saved report",
          20000,
        );
        await execute("acceptance.lab-stdio.verify");
        stage = "admitted-copy";
        const state = await ui.bridge.snapshot({ binding });
        assert.ok(state.ok);
        // Existing trusted host action port: it resolves the registered node and
        // mints the real single-use claim. No invented actionRef/core impersonation.
        // This is explicit host admission, NOT a physical/native gesture proof.
        const copied = await ui.bridge.invoke({
          binding,
          nodeId: "copy",
          formRevision: state.value.formRevision + 1,
          form: state.value.form,
        });
        assert.ok(copied.ok, JSON.stringify(copied));
        assert.equal(copied.value.output.copied, true);
        checkpoints.copy = { result: copied, text: await clipboard.readText() };
        stage = "cleanup";
        await live.dispose();
        await until(() => exits.length === launches.length, "all original Python exits");
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
        await live?.dispose().catch((error) => failures.push(String(error)));
      } finally {
        restoreDrain();
        await writeFile(
          path.join(root, "producer.json"),
          JSON.stringify(
            {
              schema: 1,
              claim: "synthetic-python-stdio-parity",
              stage,
              wire,
              launches,
              exits,
              drains,
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
