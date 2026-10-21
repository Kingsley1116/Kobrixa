import { filePreferencesPatchSchema } from "./workspace/preferences.js";
import { devicePreferencesPatchSchema } from "./device/preferences.js";
import type { UpdateService, UpdateOperationGate } from "./updates/service.js";
import { setKeyboardContext } from "./window/keyboard.js";
import { validStroke } from "../shared/keyboard.js";
import { app, ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from "electron";
import type { PluginController } from "./plugins/controller.js";
import { documentationUrl } from "./window/documentation.js";
import {
  quickFixRequestIdSchema,
  validateQuickFixRequest,
  languageFeatureRequestSchema,
  languageSyncRequestSchema,
  completionSyncRequestSchema,
} from "./language/quick-fix-request.js";
import { isIP } from "node:net";
import { z } from "zod";
import type { BuildService } from "./workspace/build.js";
import type { DeviceService } from "./device/device.js";
import type { LanguageService } from "./language/language.js";
import type { WorkspaceService } from "./workspace/workspace.js";
import { workspaceSessionSchema } from "../shared/workspace-session.js";
import { workspaceSearchRequestSchema } from "./workspace/search.js";
import type { MonitorService } from "./device/monitor-service.js";
import {
  motorTestRefSchema,
  motorTestRequestSchema,
  type MotorTestService,
} from "./device/motor-test-service.js";
import type { MotorTestRequest } from "../shared/motor-test.js";
import type { SensorLabService } from "./sensor-lab/service.js";
import { sensorLabStartSchema, sensorLabCalibrationSchema } from "./sensor-lab/schema.js";
import { exportSensorCsv } from "./sensor-lab-export.js";
import { registerCollabMirrorIpc } from "./collab/mirror.js";
import { DeviceControlGate, registerDeviceControlIpc } from "./collab/device-control.js";

const id = z.string().uuid();
const inputPort = z.number().int().min(0).max(3);
const inputType = z.number().int().min(1).max(127);
const inputMode = z.number().int().min(0).max(7);
const file = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => !value.includes("\0"));
const directory = z
  .string()
  .max(1024)
  .refine((value) => !value.includes("\0"));
const entryName = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => !value.includes("\0"));
const content = z.string().max(8 * 1024 * 1024);
const fileRevision = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .nullable();
const descriptor = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  transport: z.enum(["usb", "wifi", "mock"]),
  address: z.string().optional(),
  serialNumber: z.string().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});

function parseDescriptor(value: unknown) {
  const parsed = descriptor.parse(value);
  return {
    id: parsed.id,
    name: parsed.name,
    transport: parsed.transport,
    ...(parsed.address ? { address: parsed.address } : {}),
    ...(parsed.serialNumber ? { serialNumber: parsed.serialNumber } : {}),
    ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
  };
}

/** The trusted-sender `ipcMain.handle` wrapper, for feature modules that register their own channels. */
export type IpcHandle = <T extends unknown[], R>(
  channel: string,
  action: (event: IpcMainInvokeEvent, ...args: T) => R,
) => void;

export function registerIpc(
  trustedRenderer: () => WebContents | undefined,
  workspaces: WorkspaceService,
  builds: BuildService,
  language: LanguageService,
  devices: DeviceService,
  updates: UpdateService,
  operationGate: UpdateOperationGate,
  finishClose: (requestId: string, ready: boolean) => void = () => {},
  rendererReady: () => void = () => {},
  sensorTools?: { monitor: MonitorService; lab: SensorLabService; motors?: MotorTestService },
  modules: readonly ((handle: IpcHandle) => void)[] = [],
  /** Runs before quitAndInstall(); plugin processes must be gone before the installer quits. */
  beforeUpdateInstall: () => Promise<void> = async () => {},
  plugins?: Pick<PluginController, "diagnosticHelpEntry">,
  deviceFoundation?: DesktopDeviceIpc,
): void {
  const trusted = (event: IpcMainInvokeEvent): void => {
    const renderer = trustedRenderer();
    if (!renderer || event.sender.id !== renderer.id || event.senderFrame !== renderer.mainFrame) {
      throw new Error("Rejected IPC from an untrusted sender.");
    }
  };
  const deviceControl = deviceFoundation?.authority ?? new DeviceControlGate();
  const handle: IpcHandle = <T extends unknown[], R>(
    channel: string,
    action: (event: IpcMainInvokeEvent, ...args: T) => R,
  ): void => {
    ipcMain.handle(channel, (event, ...args: T) => {
      trusted(event);
      deviceControl.assert(event.sender.id, channel, args);
      if (
        /^(workspace|device|build|simulator|sensor-lab):/.test(channel) ||
        /^collab:(prepare-project|preview-project|save-copy)$/.test(channel)
      )
        return operationGate.run(channel, () => action(event, ...args));
      return action(event, ...args);
    });
  };

  for (const register of modules) register(handle);
  registerDeviceControlIpc(
    handle,
    deviceControl,
    () => sensorTools?.motors?.flush() ?? Promise.resolve(),
  );
  handle("updates:state", () => updates.getState());
  handle("simulator:cancel", (_event, workspaceId: unknown) =>
    builds.cancelSimulation(id.parse(workspaceId)),
  );
  handle("simulator:prepare", (_event, workspaceId: unknown, overlays: unknown, entries: unknown) =>
    builds.prepareSimulation(
      id.parse(workspaceId),
      z.record(file, content).parse(overlays),
      z.array(file).max(4).parse(entries),
    ),
  );
  if (sensorTools?.motors) {
    const motors = sensorTools.motors;
    handle("device:motor-test-state", () => motors.getState());
    handle("device:motor-test-start", (event, request: unknown) => {
      const parsed = motorTestRequestSchema.parse(request) as MotorTestRequest;
      try {
        return motors.start(parsed, event.sender.id);
      } catch (error) {
        return {
          request: parsed,
          phase: "failed",
          angle: null,
          displacement: null,
          elapsedMs: 0,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    });
    handle("device:motor-test-keepalive", (event, ref: unknown) =>
      motors.keepAlive(motorTestRefSchema.parse(ref), event.sender.id),
    );
    handle("device:motor-test-stop", (event, ref: unknown, brake: unknown) =>
      motors.stop(
        motorTestRefSchema.parse(ref),
        event.sender.id,
        z.boolean().default(true).parse(brake),
      ),
    );
  }
  if (sensorTools) {
    const { lab, monitor } = sensorTools;
    handle("device:watch-monitor", (_event, sessionId: unknown, enabled: unknown) =>
      monitor.watch(id.parse(sessionId), z.boolean().parse(enabled)),
    );
    handle("sensor-lab:state", () => lab.getState());
    handle("sensor-lab:start", (_event, request: unknown) =>
      lab.start(sensorLabStartSchema.parse(request)),
    );
    handle("sensor-lab:stop", async (_event, reason: unknown) => {
      const parsed = z.enum(["manual", "close", "update"]).default("manual").parse(reason);
      if (parsed === "manual") return lab.stop(parsed);
      await sensorTools.motors?.flush();
      await lab.flush(parsed);
      return lab.getState();
    });
    handle("sensor-lab:retry-save", () => lab.retrySave());
    handle("sensor-lab:list", () => lab.list());
    handle("sensor-lab:read", (_event, recordingId: unknown) => lab.read(id.parse(recordingId)));
    handle("sensor-lab:delete", (_event, recordingId: unknown) =>
      lab.delete(id.parse(recordingId)),
    );
    handle("sensor-lab:calibrations", () => lab.listCalibrations());
    handle("sensor-lab:save-calibration", (_event, profile: unknown) =>
      lab.saveCalibration(sensorLabCalibrationSchema.parse(profile)),
    );
    handle("sensor-lab:delete-calibration", (_event, profileId: unknown) =>
      lab.deleteCalibration(id.parse(profileId)),
    );
    handle("sensor-lab:export", (_event, recordingId: unknown) =>
      exportSensorCsv(lab, id.parse(recordingId)),
    );
  }
  handle("documentation:open", (_event, request: unknown) =>
    shell.openExternal(
      documentationUrl(request, (source, code, helpKey) =>
        plugins?.diagnosticHelpEntry(source, code, helpKey),
      ),
    ),
  );
  const afterRouting = <T>(
    workspaceId: string,
    work: () => T | Promise<T>,
    waitForRouting = true,
  ): Promise<T> =>
    Promise.resolve(work()).then(async (result) => {
      const routing = Promise.resolve()
        .then(() => language.refresh(workspaceId))
        .catch((error) => console.error("Failed to refresh language routing.", error));
      if (waitForRouting) await routing;
      return result;
    });

  handle("language:status", (_event, workspaceId: unknown, refresh: unknown) =>
    language.status(id.parse(workspaceId), z.boolean().parse(refresh)),
  );
  handle("language:feature", (_event, workspaceId: unknown, request: unknown) =>
    language.feature(id.parse(workspaceId), languageFeatureRequestSchema.parse(request)),
  );
  handle("language:cancel-feature", (_event, workspaceId: unknown, requestId: unknown) =>
    language.cancelFeature(id.parse(workspaceId), quickFixRequestIdSchema.parse(requestId)),
  );
  handle("language:quick-fixes", (_event, workspaceId: unknown, request: unknown) =>
    language.quickFixes(id.parse(workspaceId), validateQuickFixRequest(request)),
  );
  handle("language:cancel-quick-fix", (_event, workspaceId: unknown, requestId: unknown) =>
    language.cancelQuickFix(id.parse(workspaceId), quickFixRequestIdSchema.parse(requestId)),
  );
  handle("updates:preferences", (_event, value: unknown) =>
    updates.setPreferences(
      z
        .object({ enabled: z.boolean(), channel: z.enum(["stable", "preview"]) })
        .strict()
        .parse(value),
    ),
  );
  handle("updates:check", () => updates.check());
  handle("updates:prepare", async () => {
    await sensorTools?.motors?.flush();
    await sensorTools?.lab.flush("update");
    updates.prepareInstall();
  });
  handle("updates:cancel", () => updates.cancelInstall());
  handle("updates:install", async () => {
    await beforeUpdateInstall();
    updates.install();
  });
  handle("updates:open", () => updates.openRelease());
  handle("keyboard:context", (event, value: unknown) => {
    const context = z
      .object({
        editorFocused: z.boolean(),
        capturing: z.boolean(),
        chordPending: z.boolean(),
        managedKeys: z.array(z.string().max(80).refine(validStroke)).max(1000),
      })
      .strict()
      .parse(value);
    setKeyboardContext(event.sender, context);
  });
  handle("workspace:preferences", () => workspaces.getPreferences());
  handle("workspace:set-preferences", (_event, patch: unknown) =>
    workspaces.setPreferences(filePreferencesPatchSchema.parse(patch)),
  );
  handle("workspace:open", () => workspaces.open());
  registerCollabMirrorIpc(handle, workspaces, () => app.getPath("userData"));
  handle("workspace:search", (_event, workspaceId: unknown, request: unknown) =>
    workspaces.search(id.parse(workspaceId), workspaceSearchRequestSchema.parse(request)),
  );
  handle("workspace:renderer-ready", rendererReady);
  handle("workspace:restore-session", () => workspaces.restoreSession());
  handle("workspace:save-session", (_event, state: unknown) =>
    workspaces.saveSession(workspaceSessionSchema.parse(state)),
  );
  handle("workspace:close", (_event, workspaceId: unknown) => {
    const workspace = id.parse(workspaceId);
    const result = workspaces.close(workspace);
    language.close(workspace);
    return result;
  });
  handle("workspace:finish-close", async (_event, requestId: unknown, ready: unknown) => {
    const parsedId = id.parse(requestId),
      parsedReady = z.boolean().parse(ready);
    if (parsedReady) {
      await sensorTools?.motors?.flush();
      await sensorTools?.lab.flush("close");
      await deviceFoundation?.beforeClose();
    }
    finishClose(parsedId, parsedReady);
  });
  handle("workspace:create", (_event, name: unknown) =>
    workspaces.create(z.string().min(1).max(80).parse(name)),
  );
  handle("workspace:select-entry", (_event, workspaceId: unknown, entry: unknown) =>
    afterRouting(id.parse(workspaceId), () =>
      workspaces.selectEntry(id.parse(workspaceId), file.parse(entry)),
    ),
  );
  handle("workspace:read", (_event, workspaceId: unknown, sourceFile: unknown) =>
    workspaces.read(id.parse(workspaceId), file.parse(sourceFile)),
  );
  handle("workspace:read-file", (_event, workspaceId: unknown, sourceFile: unknown) =>
    workspaces.readFile(id.parse(workspaceId), file.parse(sourceFile)),
  );
  handle("workspace:refresh", (_event, workspaceId: unknown, known: unknown) =>
    afterRouting(
      id.parse(workspaceId),
      () =>
        workspaces.refresh(
          id.parse(workspaceId),
          z
            .record(file, fileRevision)
            .refine((value) => Object.keys(value).length <= 10000)
            .parse(known),
        ),
      false,
    ),
  );
  handle(
    "workspace:write",
    (_event, workspaceId: unknown, sourceFile: unknown, source: unknown, expected: unknown) => {
      const workspace = id.parse(workspaceId),
        name = file.parse(sourceFile);
      const text = content.parse(source),
        revision = fileRevision.parse(expected);
      const write = () => workspaces.write(workspace, name, text, revision);
      return /(?:^|\/)kobrixa\.json$/i.test(name) ? afterRouting(workspace, write) : write();
    },
  );
  handle("workspace:history", (_event, workspaceId: unknown, sourceFile: unknown) =>
    workspaces.history(id.parse(workspaceId), file.parse(sourceFile)),
  );
  handle(
    "workspace:history-content",
    (_event, workspaceId: unknown, sourceFile: unknown, entryId: unknown) =>
      workspaces.historyContent(id.parse(workspaceId), file.parse(sourceFile), id.parse(entryId)),
  );
  handle(
    "workspace:save-draft",
    (_event, workspaceId: unknown, sourceFile: unknown, source: unknown, baseRevision: unknown) =>
      workspaces.saveDraft(
        id.parse(workspaceId),
        file.parse(sourceFile),
        z.union([content, z.undefined()]).parse(source),
        fileRevision.optional().parse(baseRevision),
      ),
  );
  handle(
    "workspace:create-entry",
    (_event, workspaceId: unknown, parent: unknown, kind: unknown, name: unknown) =>
      afterRouting(id.parse(workspaceId), () =>
        workspaces.createEntry(
          id.parse(workspaceId),
          directory.parse(parent),
          z.enum(["file", "directory"]).parse(kind),
          entryName.parse(name),
        ),
      ),
  );
  handle("workspace:move-entry", (_event, workspaceId: unknown, source: unknown, target: unknown) =>
    afterRouting(id.parse(workspaceId), () =>
      workspaces.moveEntry(id.parse(workspaceId), file.parse(source), file.parse(target)),
    ),
  );
  handle("workspace:trash-entry", (_event, workspaceId: unknown, entry: unknown) =>
    afterRouting(id.parse(workspaceId), () =>
      workspaces.trashEntry(id.parse(workspaceId), file.parse(entry)),
    ),
  );

  handle("build:start", (_event, workspaceId: unknown, overlays: unknown, preview: unknown) =>
    builds.start(
      id.parse(workspaceId),
      z.record(file, content).parse(overlays),
      z.boolean().optional().parse(preview),
    ),
  );
  handle("build:preview", (_event, buildId: unknown) => builds.preview(id.parse(buildId)));
  handle("build:cancel", (_event, buildId: unknown) => builds.cancel(id.parse(buildId)));
  handle("build:artifacts", (_event, buildId: unknown) => builds.artifacts(id.parse(buildId)));

  handle("language:completion-sync", (_event, workspaceId: unknown, request: unknown) =>
    language.completionSync(id.parse(workspaceId), completionSyncRequestSchema.parse(request)),
  );
  handle("language:analyze", (_event, workspaceId: unknown, overlays: unknown) =>
    language.analyze(id.parse(workspaceId), z.record(file, content).parse(overlays)),
  );
  handle("language:sync", (_event, workspaceId: unknown, update: unknown) =>
    language.sync(id.parse(workspaceId), languageSyncRequestSchema.parse(update)),
  );
  handle("language:diagnostics", (_event, workspaceId: unknown, overlays: unknown) =>
    language.diagnostics(id.parse(workspaceId), z.record(file, content).parse(overlays)),
  );
  handle("language:cancel", () => language.cancel());

  handle("device:monitor", (_event, sessionId: unknown) => devices.monitor(id.parse(sessionId)));
  handle("device:input-modes", (_event, sessionId: unknown, port: unknown, type: unknown) =>
    (sensorTools?.monitor ?? devices).inputModes(
      id.parse(sessionId),
      inputPort.parse(port),
      inputType.parse(type),
    ),
  );
  handle(
    "device:set-input-mode",
    (_event, sessionId: unknown, port: unknown, type: unknown, mode: unknown) =>
      (sensorTools?.monitor ?? devices).setInputMode(
        id.parse(sessionId),
        inputPort.parse(port),
        inputType.parse(type),
        inputMode.parse(mode),
      ),
  );

  handle("device:files", (_event, request: unknown) =>
    devices.files(
      z
        .object({
          sessionId: id,
          requestId: id,
          action: z.enum(["list", "upload", "download", "mkdir", "rename", "delete"]),
          path: file,
          name: entryName.optional(),
          locale: z.enum(["en", "zh-TW"]),
        })
        .parse(request),
    ),
  );
  const batchRef = z.strictObject({ sessionId: id, requestId: id, planId: id });
  handle("device:files-prepare", async (event, request: unknown) => {
    const parsed = z
      .object({
        sessionId: id,
        requestId: id,
        action: z.enum(["upload", "download", "delete"]),
        path: file,
        paths: z.array(file).max(10000),
        source: z.enum(["files", "folders"]),
        locale: z.enum(["en", "zh-TW"]),
      })
      .parse(request);
    const snapshot = await devices.prepareFiles(parsed, event.sender);
    deviceControl.rememberBatch(event.sender, snapshot);
    return snapshot;
  });
handle("device:files-renew", (event, ref: unknown) => {
  const owner = deviceControl.principal(event.sender.id, "remote-files");
  if (owner.kind !== "core") throw new Error("Core file owner required.");
  devices.renewFilePlan(batchRef.parse(ref), owner);
});
  handle("device:files-execute", (event, ref: unknown, policy: unknown) =>
    devices.executeFiles(
      batchRef.parse(ref),
      z.enum(["skip", "replace"]).parse(policy),
      event.sender.id,
    ),
  );
  handle("device:files-stop", (event, ref: unknown) =>
    devices.stopFiles(batchRef.parse(ref), event.sender.id),
  );
  handle("device:preferences", () => devices.getPreferences());
  handle("device:set-preferences", (_event, patch: unknown) =>
    devices.setPreferences(devicePreferencesPatchSchema.parse(patch)),
  );
  handle("device:discover", () => devices.discover());
  handle("device:connect", (_event, target: unknown) => devices.connect(parseDescriptor(target)));
  handle("device:connect-wifi", (_event, address: unknown) =>
    devices.connectWifi(
      z
        .string()
        .refine((value) => isIP(value) !== 0, "Expected an IPv4 or IPv6 address.")
        .parse(address),
    ),
  );
  handle("device:disconnect", (event, sessionId: unknown) => {
    const session = id.parse(sessionId);
    if (!deviceFoundation) throw new Error("Device lifecycle coordinator is unavailable.");
    return deviceFoundation.disconnect(session, deviceControl.principal(event.sender.id, "recovery"));
  });
  handle("device:upload", (_event, sessionId: unknown, buildId: unknown, remotePath: unknown) =>
    devices.upload(id.parse(sessionId), id.parse(buildId), file.parse(remotePath)),
  );
  handle(
    "device:deploy",
    (_event, sessionId: unknown, buildId: unknown, remoteDirectory: unknown) =>
      devices.deploy(id.parse(sessionId), id.parse(buildId), directory.parse(remoteDirectory)),
  );
  handle("device:run", (_event, sessionId: unknown, remotePath: unknown) =>
    devices.run(id.parse(sessionId), file.parse(remotePath)),
  );
handle("device:stop", (event, sessionId: unknown) => {
  if (!deviceFoundation) throw new Error("Device foundation not attached.");
  return deviceFoundation.stop(id.parse(sessionId), deviceControl.principal(event.sender.id, "recovery"));
});
  handle("device:delete", (_event, sessionId: unknown, remotePath: unknown) =>
    devices.delete(id.parse(sessionId), file.parse(remotePath)),
  );
}

import type { Principal } from "@kobrixa/plugin-runtime";

export interface DesktopDeviceIpc {
  stop(sessionId: string, principal: Principal): Promise<void>;
  authority: DeviceControlGate;
  disconnect(sessionId: string, principal: Principal): Promise<void>;
  beforeClose(): Promise<void>;
}
