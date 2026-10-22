import type { CoreRecoveryPort } from "@kobrixa/plugin-runtime";
import { z } from "zod";
import { compilerIdSchema, namespacedIdSchema } from "@kobrixa/plugin-protocol";
import { sourceKeySchema } from "@kobrixa/plugin-runtime";
import type { PluginEvent } from "../../shared/plugins.js";
import type { ReportLanguageRegistrationFailureInput } from "../../shared/static-languages.js";
import type { IpcHandle } from "../ipc.js";
import type { PluginController } from "./controller.js";

export type PluginIpcTarget = Pick<
  PluginController,
  | "state"
  | "diagnosticHelp"
  | "staticLanguages"
  | "reportLanguageRegistrationFailure"
  | "notices"
  | "execute"
  | "cancel"
  | "setEnabled"
  | "setDeveloperMode"
  | "linkFolder"
  | "relinkFolder"
  | "unlink"
  | "reload"
  | "pythonCandidates"
  | "setPython"
  | "readLog"
  | "clearSafeModeLock"
  | "onEvent"
>;
const pythonChoiceSchema = z.enum(["python3", "python", "py", "saved", "other"]);
const cursorSchema = z.number().int().nonnegative();
const reportCounterSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const registrationFailureSchema: z.ZodType<ReportLanguageRegistrationFailureInput> = z.strictObject(
  {
    sourceKey: sourceKeySchema,
    generation: reportCounterSchema,
    languageId: compilerIdSchema,
    revision: reportCounterSchema,
    reason: z.enum(["dto-version", "validation", "adapter", "monaco", "session-language-ids"]),
    detail: z
      .string()
      .max(4096)
      .refine((value) => Array.from(value).length <= 2048, "Detail exceeds 2,048 code points.")
      .refine(
        (value) => !/(?:^|[\s"'(=])(?:\/[^\s]|[a-z]:[\\/]|\\\\|file:\/\/)/iu.test(value),
        "Registration detail must not contain a physical path.",
      ),
  },
);

/**
 * Every channel goes through the trusted-sender wrapper. The renderer sends only source keys,
 * command ids, booleans, interpreter ids and log cursors, never a path or an executable; the
 * controller checks developer mode, safe mode and shutdown itself.
 */
export function registerPluginIpc(
  handle: IpcHandle,
  plugins: PluginIpcTarget,
  publish: (event: PluginEvent) => void,
): () => void {
  const key = (value: unknown) => sourceKeySchema.parse(value);
  handle("plugins:state", () => plugins.state());
  handle("plugins:diagnosticHelp", () => plugins.diagnosticHelp());
  handle("plugins:static-languages", () => plugins.staticLanguages());
  handle("plugins:report-language-registration-failure", (_event, input: unknown) =>
    plugins.reportLanguageRegistrationFailure(registrationFailureSchema.parse(input)),
  );
  handle("plugins:notices", () => plugins.notices());
  handle("plugins:execute", (_event, commandId: unknown) =>
    plugins.execute(namespacedIdSchema.parse(commandId)),
  );
  handle("plugins:cancel", (_event, sourceKey: unknown) => plugins.cancel(key(sourceKey)));
  handle("plugins:set-enabled", (_event, sourceKey: unknown, enabled: unknown) =>
    plugins.setEnabled(key(sourceKey), z.boolean().parse(enabled)),
  );
  handle("plugins:setDeveloperMode", (_event, enabled: unknown) =>
    plugins.setDeveloperMode(z.boolean().parse(enabled)),
  );
  handle("plugins:linkFolder", () => plugins.linkFolder());
  handle("plugins:relinkFolder", (_event, sourceKey: unknown) =>
    plugins.relinkFolder(key(sourceKey)),
  );
  handle("plugins:unlink", (_event, sourceKey: unknown) => plugins.unlink(key(sourceKey)));
  handle("plugins:reload", (_event, sourceKey: unknown) => plugins.reload(key(sourceKey)));
  handle("plugins:pythonCandidates", () => plugins.pythonCandidates());
  handle("plugins:setPython", (_event, id: unknown) =>
    plugins.setPython(pythonChoiceSchema.parse(id)),
  );
  handle("plugins:readLog", (_event, sourceKey: unknown, after: unknown) =>
    plugins.readLog(key(sourceKey), cursorSchema.parse(after)),
  );
  handle("plugins:clearSafeModeLock", () => plugins.clearSafeModeLock());
  return plugins.onEvent(publish);
}

export function registerCoreRecoveryIpc(
  handle: IpcHandle,
  recovery: CoreRecoveryPort,
  changed: () => void,
): () => void {
  const reference = z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  handle("plugins:recovery:snapshot", (_event, value: unknown) => {
    const parsed = z.strictObject({ cursor: reference.optional() }).parse(value);
    return recovery.snapshot(parsed.cursor === undefined ? {} : { cursor: parsed.cursor });
  });
  handle("plugins:recovery:act", (_event, value: unknown) =>
    recovery.act(z.strictObject({ itemId: reference, actionId: reference }).parse(value)),
  );
  return recovery.onChanged(changed);
}

import type {
  BoundSettingsService,
  CoreWindowScope,
  SettingsFormBinding,
} from "@kobrixa/plugin-runtime";
import type { PluginsApi } from "../../shared/plugins.js";
import { settingsRequestSchemas } from "@kobrixa/plugin-protocol";

export const settingsBinding170 = z.strictObject({
  owner: z.strictObject({
    sourceKey: sourceKeySchema,
    pluginId: namespacedIdSchema,
    uiResourceGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }),
  scope: z.strictObject({ hostEpoch: z.uuid(), workbenchInstance: z.uuid() }),
  resourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
const sameScope170 = (a: CoreWindowScope, b: CoreWindowScope) =>
  a.hostEpoch === b.hostEpoch && a.workbenchInstance === b.workbenchInstance;
const sameSettings170 = (a: SettingsFormBinding, b: SettingsFormBinding) =>
  sameScope170(a.scope, b.scope) &&
  a.owner.sourceKey === b.owner.sourceKey &&
  a.owner.pluginId === b.owner.pluginId &&
  a.owner.uiResourceGeneration === b.owner.uiResourceGeneration &&
  a.resourceDigest === b.resourceDigest;
export function bindSettingsBridge(
  service: BoundSettingsService,
  scope: () => CoreWindowScope,
): PluginsApi["settings"] {
  return settingsBridge170(service, scope).bridge;
}
function settingsBridge170(service: BoundSettingsService, scope: () => CoreWindowScope) {
  let generation = 0;
  let openingTail: Promise<void> = Promise.resolve();
  let issued: SettingsFormBinding | undefined;
  const watches = new Set<() => void>();
  const clear = () => {
    ++generation;
    for (const off of watches) off();
    watches.clear();
    const old = issued;
    issued = undefined;
    if (old) service.dispose(old);
  };
  const currentScope = (expected: CoreWindowScope) => {
    try {
      return sameScope170(expected, scope());
    } catch {
      return false;
    }
  };
  const check = (binding: SettingsFormBinding) => {
    let current: CoreWindowScope;
    try {
      current = scope();
    } catch {
      clear();
      throw new Error("Stale settings binding");
    }
    if (issued && !sameScope170(issued.scope, current)) clear();
    if (!issued || !sameSettings170(issued, binding) || !sameScope170(binding.scope, current))
      throw new Error("Stale settings binding");
    return issued;
  };
  const bridge: PluginsApi["settings"] = {
    async open(input) {
      clear();
      const opening = generation;
      const admitted = structuredClone(scope());
      const previous = openingTail;
      let release!: () => void;
      openingTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      if (opening !== generation || !currentScope(admitted)) {
        release();
        throw new Error("Stale settings open");
      }
      let opened: Awaited<ReturnType<BoundSettingsService["open"]>>;
      try {
        opened = await service.open({ ...input, scope: admitted });
      } catch (error) {
        release();
        throw error;
      }
      release();
      if (
        opening !== generation ||
        !currentScope(admitted) ||
        !sameScope170(opened.binding.scope, admitted) ||
        opened.binding.owner.sourceKey !== input.sourceKey ||
        opened.binding.resourceDigest !== input.resourceDigest
      ) {
        service.dispose(opened.binding);
        throw new Error("Stale settings open");
      }
      issued = structuredClone(opened.binding);
      return opened;
    },
    async read(binding) {
      const original = check(binding),
        epoch = generation;
      const result = await service.read(original);
      check(original);
      if (epoch !== generation) throw new Error("Stale settings read");
      return result;
    },
    async update(binding, params) {
      const original = check(binding),
        epoch = generation;
      const result = await service.update(original, params);
      check(original);
      if (epoch !== generation) throw new Error("Stale settings update");
      return result;
    },
    async reset(binding, params) {
      const original = check(binding),
        epoch = generation;
      const result = await service.reset(original, params);
      check(original);
      if (epoch !== generation) throw new Error("Stale settings reset");
      return result;
    },
    watch(binding, changed) {
      const original = check(binding);
      let active = true;
      let offService = () => {};
      const off = () => {
        if (!active) return;
        active = false;
        offService();
        watches.delete(off);
      };
      watches.add(off);
      try {
        offService = service.watch(original, () => {
          if (!active) return;
          try {
            check(original);
          } catch {
            off();
            return;
          }
          changed();
        });
      } catch (error) {
        off();
        throw error;
      }
      if (!active) offService();
      return off;
    },
    dispose(binding) {
      check(binding);
      clear();
    },
  };
  return { bridge, retire: clear };
}

export function registerSettingsIpc170(input: {
  handle: IpcHandle;
  service: BoundSettingsService;
  scope: () => CoreWindowScope;
  publish: (scope: CoreWindowScope, channel: string, payload: unknown) => void;
}): () => void {
  const { bridge, retire } = settingsBridge170(input.service, input.scope);
  let binding: SettingsFormBinding | undefined;
  let off: () => void = () => {};
  let closed = false;
  let watching = 0;
  let lastWatch = 0;
  let openGeneration = 0;
  const openSchema = z.strictObject({
    sourceKey: sourceKeySchema,
    resourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  });
  const watchSchema = z.strictObject({
    binding: settingsBinding170,
    watch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  });
  const active = () => {
    if (closed) throw new Error("Settings window retired");
  };
  input.handle("plugins:settings:open", async (_event, value: unknown) => {
    active();
    const request = openSchema.parse(value);
    const generation = ++openGeneration;
    off();
    off = () => {};
    binding = undefined;
    const opened = await bridge.open(request);
    if (closed) {
      bridge.dispose(opened.binding);
      throw new Error("Settings window retired");
    }
    if (generation !== openGeneration) throw new Error("Stale settings open");
    binding = opened.binding;
    return opened;
  });
  input.handle("plugins:settings:read", (_event, value: unknown) => {
    active();
    return bridge.read(settingsBinding170.parse(value));
  });
  input.handle("plugins:settings:update", (_event, value: unknown, params: unknown) => {
    active();
    return bridge.update(
      settingsBinding170.parse(value),
      settingsRequestSchemas["settings/update"].params.parse(params),
    );
  });
  input.handle("plugins:settings:reset", (_event, value: unknown, params: unknown) => {
    active();
    return bridge.reset(
      settingsBinding170.parse(value),
      settingsRequestSchemas["settings/reset"].params.parse(params),
    );
  });
  input.handle("plugins:settings:watch", (_event, value: unknown) => {
    active();
    const request = watchSchema.parse(value);
    if (request.watch <= lastWatch) throw new Error("Stale settings watch");
    const next = bridge.watch(request.binding, () =>
      input.publish(request.binding.scope, "plugins:settings:changed", request),
    );
    off();
    off = next;
    watching = request.watch;
    lastWatch = request.watch;
  });
  input.handle("plugins:settings:unwatch", (_event, value: unknown) => {
    active();
    const request = watchSchema.parse(value);
    // Validate ownership even for removal; a foreign window cannot remove a watch.
    if (
      !binding ||
      !sameSettings170(binding, request.binding) ||
      !sameScope170(binding.scope, input.scope())
    )
      throw new Error("Stale settings binding");
    if (request.watch === watching) {
      off();
      off = () => {};
      watching = 0;
    }
  });
  input.handle("plugins:settings:dispose", (_event, value: unknown) => {
    active();
    const candidate = settingsBinding170.parse(value);
    bridge.dispose(candidate);
    ++openGeneration;
    off();
    off = () => {};
    binding = undefined;
  });
  return () => {
    if (closed) return;
    closed = true;
    ++openGeneration;
    off();
    off = () => {};
    retire();
    binding = undefined;
  };
}

import type { PersistenceRecoveryBridge } from "../../shared/plugin-persistence.js";
export function registerPersistenceRecoveryIpc170(input: {
  handle: IpcHandle;
  bridge: PersistenceRecoveryBridge;
  scope: () => CoreWindowScope;
  publish: (scope: CoreWindowScope, channel: string, value: unknown) => void;
}): () => void {
  const original = structuredClone(input.scope());
  let disposed = false;
  const valid = () => {
    try {
      return !disposed && sameScope170(original, input.scope());
    } catch {
      return false;
    }
  };
  const requireScope = () => {
    if (!valid()) throw new Error("Stale recovery window");
  };
  const snapshot = z.strictObject({ itemId: z.uuid() });
  const action = snapshot.extend({ optionId: z.uuid() });
  let offOpen = () => {};
  let offChanged = () => {};
  const unsubscribe = () => {
    offOpen();
    offChanged();
    offOpen = () => {};
    offChanged = () => {};
  };
  input.handle("plugins:persistence-recovery:snapshot", (_event, value: unknown) => {
    requireScope();
    return input.bridge.snapshot(snapshot.parse(value));
  });
  input.handle("plugins:persistence-recovery:act", (_event, value: unknown) => {
    requireScope();
    return input.bridge.act(action.parse(value));
  });
  input.handle("plugins:persistence-recovery:subscribe", () => {
    requireScope();
    unsubscribe();
    offOpen = input.bridge.onOpen((value) => {
      if (valid()) input.publish(original, "plugins:persistence-recovery:open", value);
    });
    offChanged = input.bridge.onChanged(() => {
      if (valid()) input.publish(original, "plugins:persistence-recovery:changed", null);
    });
  });
  input.handle("plugins:persistence-recovery:unsubscribe", () => {
    requireScope();
    unsubscribe();
  });
  return () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
  };
}
