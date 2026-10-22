import assert from "node:assert/strict";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { app } from "electron";
import {
  RpcPeer,
  RPC_ERRORS,
  type CommandInvocation,
  type PluginManifest,
} from "@kobrixa/plugin-protocol";
import { createDesktopLauncher } from "../../apps/desktop/src/main/plugins/launchers.js";
import { resolveBuiltinLaunch } from "../../apps/desktop/src/main/plugins/builtin-launch.js";

const output = app.commandLine.getSwitchValue("ui-acceptance-output");
const inputFile = app.commandLine.getSwitchValue("ui-acceptance-input");
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, label: string, timeout = 5000) {
  const deadline = performance.now() + timeout;
  while (!check()) {
    assert.ok(performance.now() < deadline, `Timed out: ${label}`);
    await pause(10);
  }
}
const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw error;
  }
};

function installedDescriptor() {
  assert.equal(app.isPackaged, true);
  return resolveBuiltinLaunch({
    sourceKey: "builtin:kobrixa.motor-test",
    pluginId: "kobrixa.motor-test",
    slug: "motor-test",
    packaged: true,
    appPath: app.getAppPath(),
    buildRoot: "intentionally-unavailable",
  });
}
async function transport(
  directory: string,
  language: "js" | "python",
  python: string,
  installed = false,
) {
  if (installed) {
    const descriptor = await installedDescriptor();
    assert.equal(descriptor.policy, "optional");
    assert.equal(descriptor.runtime, "node");
    assert.equal(descriptor.entry, "main.cjs");
    assert.equal(descriptor.packageRoot, await realpath(directory));
  }
  const manifest: PluginManifest = JSON.parse(
    await readFile(path.join(directory, "kobrixa-plugin.json"), "utf8"),
  );
  assert.ok(manifest.runtime.kind === "node" || manifest.runtime.kind === "python");
  let pid = 0;
  const logs: string[] = [];
  const wire: { direction: "host" | "plugin"; at: number; message: unknown }[] = [];
  const launcher = createDesktopLauncher({
    python: () => ({ executable: python, args: [] }),
    onOutput: (_plugin, line) => {
      logs.push(line);
      const match = /UI_PID:([0-9]+)/.exec(line);
      if (match) pid = Number(match[1]);
    },
  });
  const child = await launcher({
    id: manifest.id,
    sourceKey: installed ? `builtin:${manifest.id}` : `development:${directory}`,
    directory,
    entry: path.join(directory, manifest.runtime.entry),
    runtime: manifest.runtime.kind,
    permissions: manifest.permissions ?? [],
    commands: (manifest.contributes?.commands ?? []).map((command) => command.id),
  });
  let exited = false;
  const offExit = child.onExit(() => {
    exited = true;
  });
  const peer = new RpcPeer(
    {
      send(message) {
        wire.push({ direction: "host", at: performance.now(), message: JSON.parse(message) });
        child.send(message);
      },
      onMessage(listener) {
        return child.onMessage((message) => {
          wire.push({ direction: "plugin", at: performance.now(), message: JSON.parse(message) });
          listener(message);
        });
      },
    },
    { timeoutMs: 5000 },
  );
  // Deliberately a mock UI host: this receipt is SDK/transport parity only.
  peer.handle("ui/instances", () => ({ ok: true, value: { instances: [] } }));
  const attempt = async () => {
    const initialize = {
      pluginId: manifest.id,
      apiVersion: "1.6.0",
      locale: "en" as const,
      grantedPermissions: manifest.permissions ?? [],
    };
    const hello = await peer.request("initialize", initialize);
    assert.equal(hello.apiVersion, "1.6.0");
    const negotiated = await peer.request("ui/negotiate", {
      commandEnvelopeVersions: [1],
      uiResourceVersions: [1],
    });
    assert.ok(negotiated.ok);
    assert.deepEqual(await peer.request("ui/ready", {}), { ok: true, value: {} });
    const legacy = await peer.request("command/execute", { command: `${manifest.id}.legacy` });
    assert.equal(legacy, null);
    const management: CommandInvocation = {
      version: 1,
      invocationId: randomUUID(),
      command: `${manifest.id}.inspect`,
      arguments: {},
      context: {
        contextRef: null,
        origin: "management",
        locale: "en",
        trigger: { kind: "activate" },
      },
    };
    const inspection = await peer.request("command/invoke", management);
    assert.ok(inspection.ok, JSON.stringify(inspection));
    assert.deepEqual(inspection.value.output, {
      "has-binding": false,
      "has-motion": false,
      "argument-count": 0,
    });
    await assert.rejects(
      peer.request("command/invoke", { ...management, arguments: { unexpected: true } }),
      { code: RPC_ERRORS.invalidParams },
    );
    // Synthetic host binding belongs only to this documented mock transport run.
    const invocation: CommandInvocation = {
      ...management,
      invocationId: randomUUID(),
      command: `${manifest.id}.activate`,
      arguments: { speed: 20, mode: "brake" },
      context: {
        contextRef: null,
        origin: "panel",
        locale: "en",
        trigger: { kind: "activate" },
        binding: {
          contributionId: `${manifest.id}.panel`,
          panelInstance: randomUUID(),
          kind: "panel",
          uiResourceGeneration: 1,
          generation: 1,
          hostEpoch: randomUUID(),
          processEpoch: randomUUID(),
        },
        form: { revision: 0, values: { speed: 20, mode: "brake" } },
      },
    };
    const first = await peer.request("command/invoke", invocation);
    assert.ok(first.ok);
    assert.equal(first.value.output.calls, 1);
    assert.equal(first.value.output.unicode, "🙂界");
    assert.deepEqual(await peer.request("command/invoke", invocation), first);
    const failed = await peer.request("command/invoke", {
      ...invocation,
      invocationId: randomUUID(),
      arguments: { speed: -99, mode: "brake" },
    });
    assert.equal(failed.ok, false);
    if (failed.ok) throw new Error("Callback error was swallowed.");
    assert.equal(failed.error.code, "PLUGIN_E_COMMAND_FAILED");
    assert.equal(JSON.stringify(failed).includes(directory), false);
    const cancellationId = randomUUID();
    const cancel = new AbortController();
    const pending = peer.request(
      "command/invoke",
      { ...invocation, invocationId: cancellationId, arguments: { speed: -98, mode: "brake" } },
      { signal: cancel.signal },
    );
    const cancelled = assert.rejects(pending, { code: RPC_ERRORS.requestCancelled });
    await until(
      () => logs.some((line) => line.includes(`UI_CALLBACK_WAIT:${cancellationId}`)),
      "actual callback entry",
    );
    cancel.abort();
    await cancelled;
    const after = await peer.request("command/invoke", {
      ...invocation,
      invocationId: randomUUID(),
    });
    assert.ok(after.ok);
    assert.equal(after.value.output.calls, 2);
    assert.equal(await peer.request("shutdown", {}, { timeoutMs: 2000 }), null);
    peer.notify("exit", {});
    await until(() => exited, "original child exit");
    assert.ok(pid > 0, "No PID from the actual fixture stderr");
    await until(() => gone(pid), "OS process removal");
    return {
      language,
      initializeKeys: Object.keys(initialize).sort(),
      apiVersion: hello.apiVersion,
      legacy,
      negotiated: negotiated.value,
      duplicateCalls: first.value.output.calls,
      managementHasBinding: inspection.value.output["has-binding"],
      managementHasMotion: inspection.value.output["has-motion"],
      unicode: first.value.output.unicode,
      callbackError: failed.error.code,
      cancelled: true,
      cancellationId,
      callbackStarted: true,
      afterCancellationCalls: after.value.output.calls,
      exited,
      pid,
      logs,
      wire,
    };
  };
  const failures: unknown[] = [];
  let receipt: Awaited<ReturnType<typeof attempt>> | undefined;
  try {
    receipt = await attempt();
  } catch (error) {
    failures.push(error);
    await writeFile(
      `${output}.${language}.failure.json`,
      JSON.stringify(
        {
          language,
          error: String(error),
          pid,
          exited,
          logs,
          wire,
        },
        null,
        2,
      ),
    ).catch((saveError) => failures.push(saveError));
  } finally {
    peer.close();
    try {
      if (!exited) {
        child.forceKill();
        await until(() => exited, "failed-run child cleanup");
      }
      if (pid > 0) await until(() => gone(pid), "failed-run OS cleanup");
    } catch (cleanupError) {
      failures.push(cleanupError);
    } finally {
      offExit();
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "Transport failed with additional receipt/cleanup errors", {
      cause: failures[0],
    });
  assert.ok(receipt);
  return receipt;
}

async function run() {
  const mode = app.commandLine.getSwitchValue("ui-acceptance-mode");
  if (mode === "installed") {
    await app.whenReady();
    assert.equal(app.isPackaged, true);
    const input = JSON.parse(await readFile(inputFile, "utf8"));
    let isolation: { source: string; dependency: string; network: string } | undefined;
    if (input.isolation) {
      const deniedRead = async (file: string) => {
        try {
          await readFile(file);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          assert.ok(
            code === "EPERM" || code === "EACCES",
            `Expected OS denial for ${file}, received ${code}`,
          );
          return code;
        }
        throw new Error(`OS isolation did not deny ${file}`);
      };
      const network = await new Promise<string>((resolve, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port: input.isolation.networkPort });
        socket.setTimeout(2000, () => socket.destroy(new Error("Network denial probe timed out")));
        socket.once("connect", () =>
          socket.destroy(new Error("OS isolation allowed a network connection")),
        );
        socket.once("error", (error: NodeJS.ErrnoException) => {
          if (error.code === "EPERM" || error.code === "EACCES") resolve(error.code);
          else reject(error);
        });
      });
      isolation = {
        source: await deniedRead(input.isolation.sourceFile),
        dependency: await deniedRead(input.isolation.dependencyFile),
        network,
      };
    }
    if (input.expectRejected) {
      // A resolver failure must precede any launcher invocation, not merely any later error.
      await assert.rejects(installedDescriptor(), { code: "PLUGIN_E_ENTRY" });
      await writeFile(
        output,
        JSON.stringify({
          kind: "installed-rejection",
          rejected: true,
          phase: "resolve-before-launch",
          launched: false,
          isolation,
        }),
      );
    } else {
      const directory = path.join(`${app.getAppPath()}.unpacked`, ".vite/build/plugins/motor-test");
      const result = await transport(directory, "js", "unavailable-python", true);
      await writeFile(
        output,
        JSON.stringify(
          {
            kind: "installed-builtin",
            mockHost: true,
            packaged: app.isPackaged,
            cwd: process.cwd(),
            appPath: app.getAppPath(),
            results: [result],
            resolvedFromInstalledRoot: true,
            remainingPids: gone(result.pid) ? [] : [result.pid],
            versions: process.versions,
            isolation,
          },
          null,
          2,
        ),
      );
    }
    app.quit();
    return;
  }
  assert.equal(
    mode,
    "transport",
    "This entry currently implements transport only; no browser acceptance claim",
  );
  await app.whenReady();
  const input = JSON.parse(await readFile(inputFile, "utf8"));
  const results = [];
  for (const language of ["js", "python"] as const)
    results.push(await transport(input[language], language, input.pythonExecutable));
  await writeFile(
    output,
    JSON.stringify(
      {
        kind: "ui-transport",
        mockHost: true,
        results,
        versions: process.versions,
        artifact: input.artifact,
      },
      null,
      2,
    ),
  );
  app.quit();
}
void run().catch(async (error) => {
  console.error(error);
  if (output)
    await writeFile(
      `${output}.failure.json`,
      JSON.stringify({ error: String(error), stack: error?.stack }),
    );
  app.exit(1);
});
