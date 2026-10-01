import { setKeyboardContext } from "./window/keyboard.js";
import { validStroke } from "../shared/keyboard.js";
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import { isIP } from "node:net";
import { z } from "zod";
import type { BuildService } from "./workspace/build.js";
import type { DeviceService } from "./device/device.js";
import type { LanguageService } from "./language/language.js";
import type { WorkspaceService } from "./workspace/workspace.js";

const id = z.string().uuid();
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

export function registerIpc(
  trustedRenderer: () => WebContents | undefined,
  workspaces: WorkspaceService,
  builds: BuildService,
  language: LanguageService,
  devices: DeviceService,
): void {
  const trusted = (event: IpcMainInvokeEvent): void => {
    const renderer = trustedRenderer();
    if (!renderer || event.sender.id !== renderer.id || event.senderFrame !== renderer.mainFrame) {
      throw new Error("Rejected IPC from an untrusted sender.");
    }
  };
  const handle = <T extends unknown[], R>(
    channel: string,
    action: (event: IpcMainInvokeEvent, ...args: T) => R,
  ): void => {
    ipcMain.handle(channel, (event, ...args: T) => {
      trusted(event);
      return action(event, ...args);
    });
  };

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
  handle("workspace:open", () => workspaces.open());
  handle("workspace:create", (_event, name: unknown) =>
    workspaces.create(z.string().min(1).max(80).parse(name)),
  );
  handle("workspace:select-entry", (_event, workspaceId: unknown, entry: unknown) =>
    workspaces.selectEntry(id.parse(workspaceId), file.parse(entry)),
  );
  handle("workspace:read", (_event, workspaceId: unknown, sourceFile: unknown) =>
    workspaces.read(id.parse(workspaceId), file.parse(sourceFile)),
  );
  handle("workspace:write", (_event, workspaceId: unknown, sourceFile: unknown, source: unknown) =>
    workspaces.write(id.parse(workspaceId), file.parse(sourceFile), content.parse(source)),
  );
  handle(
    "workspace:save-draft",
    (_event, workspaceId: unknown, sourceFile: unknown, source: unknown) =>
      workspaces.saveDraft(
        id.parse(workspaceId),
        file.parse(sourceFile),
        z.union([content, z.undefined()]).parse(source),
      ),
  );
  handle(
    "workspace:create-entry",
    (_event, workspaceId: unknown, parent: unknown, kind: unknown, name: unknown) =>
      workspaces.createEntry(
        id.parse(workspaceId),
        directory.parse(parent),
        z.enum(["file", "directory"]).parse(kind),
        entryName.parse(name),
      ),
  );
  handle("workspace:move-entry", (_event, workspaceId: unknown, source: unknown, target: unknown) =>
    workspaces.moveEntry(id.parse(workspaceId), file.parse(source), file.parse(target)),
  );
  handle("workspace:trash-entry", (_event, workspaceId: unknown, entry: unknown) =>
    workspaces.trashEntry(id.parse(workspaceId), file.parse(entry)),
  );

  handle("build:start", (_event, workspaceId: unknown, overlays: unknown) =>
    builds.start(id.parse(workspaceId), z.record(file, content).parse(overlays)),
  );
  handle("build:cancel", (_event, buildId: unknown) => builds.cancel(id.parse(buildId)));
  handle("build:artifacts", (_event, buildId: unknown) => builds.artifacts(id.parse(buildId)));

  handle("language:completion-sync", (_event, workspaceId: unknown, request: unknown) =>
    language.completionSync(
      id.parse(workspaceId),
      z
        .object({
          session: z.string().min(1).max(100),
          revision: z.number().int().positive(),
          baseRevision: z.number().int().nonnegative().nullable(),
          refresh: z.boolean(),
          updates: z.array(
            z.discriminatedUnion("kind", [
              z.object({
                kind: z.literal("reset"),
                file,
                document: z.object({ version: z.number().int().nonnegative(), text: content }),
              }),
              z.object({ kind: z.literal("remove"), file }),
              z.object({
                kind: z.literal("edit"),
                file,
                before: z.number().int().nonnegative(),
                version: z.number().int().positive(),
                changes: z.array(
                  z.object({
                    offset: z.number().int().nonnegative(),
                    length: z.number().int().nonnegative(),
                    text: content,
                  }),
                ),
              }),
            ]),
          ),
        })
        .parse(request),
    ),
  );
  handle("language:analyze", (_event, workspaceId: unknown, overlays: unknown) =>
    language.analyze(id.parse(workspaceId), z.record(file, content).parse(overlays)),
  );
  handle("language:sync", (_event, workspaceId: unknown, update: unknown) =>
    language.sync(
      id.parse(workspaceId),
      z
        .object({
          session: z.string().min(1).max(100),
          revision: z.number().int().positive(),
          baseRevision: z.number().int().nonnegative().nullable(),
          analysisBase: z.number().int().positive().nullable(),
          overlays: z.object({ set: z.record(file, content), removed: z.array(file) }),
        })
        .parse(update),
    ),
  );
  handle("language:diagnostics", (_event, workspaceId: unknown, overlays: unknown) =>
    language.diagnostics(id.parse(workspaceId), z.record(file, content).parse(overlays)),
  );
  handle("language:cancel", () => language.cancel());

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
  const batchRef = z.object({ sessionId: id, requestId: id, planId: id });
  handle("device:files-prepare", (event, request: unknown) => {
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
    return devices.prepareFiles(parsed, event.sender);
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
  handle("device:disconnect", (_event, sessionId: unknown) =>
    devices.disconnect(id.parse(sessionId)),
  );
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
  handle("device:stop", (_event, sessionId: unknown) => devices.stop(id.parse(sessionId)));
  handle("device:delete", (_event, sessionId: unknown, remotePath: unknown) =>
    devices.delete(id.parse(sessionId), file.parse(remotePath)),
  );
}
