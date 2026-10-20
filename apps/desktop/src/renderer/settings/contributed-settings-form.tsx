import { validateSettingsValues } from "../../../../../packages/plugin-protocol/src/settings.js";
import type { SettingsResourceV1, SettingKey, LocalId } from "@kobrixa/plugin-protocol";
import type {
  SettingsFormBinding,
  BoundSettingsService,
  SettingsFieldMap,
  ContributedSettingsForm,
} from "@kobrixa/plugin-runtime";
import type { SettingsControlsPort } from "../plugin-ui/host-ports.js";
import { createContributedSettingsStore } from "./contributed-settings-store.js";
const identity = (binding: SettingsFormBinding) =>
  JSON.stringify([
    binding.owner.sourceKey,
    binding.owner.pluginId,
    binding.owner.uiResourceGeneration,
    binding.scope.hostEpoch,
    binding.scope.workbenchInstance,
    binding.resourceDigest,
  ]);
export function createSettingsFieldMap(resource: SettingsResourceV1): SettingsFieldMap {
  if (
    !resource.fields.length ||
    resource.fields.length > 128 ||
    new Set(resource.fields.map((f) => f.key)).size !== resource.fields.length
  )
    throw new Error("Invalid fields.");
  const fields = structuredClone(resource.fields);
  for (const f of fields)
    if (
      f.type === "enum" &&
      (f.options.length < 1 ||
        f.options.length > 32 ||
        new Set(f.options.map((o) => JSON.stringify([typeof o.value, o.value]))).size !==
          f.options.length)
    )
      throw new Error("Invalid options.");
  const index = (key: SettingKey) => {
    const n = fields.findIndex((f) => f.key === key);
    if (n < 0) throw new Error("Unknown field.");
    return n;
  };
  const ordinal = (id: LocalId, prefix: string, maximum: number) => {
    if (!new RegExp(`^${prefix}-(0|[1-9][0-9]*)$`).test(id)) throw new Error("Invalid ID.");
    const n = Number(id.slice(prefix.length + 1));
    if (n >= maximum) throw new Error("Unknown ID.");
    return n;
  };
  const options = (key: SettingKey) => {
    const f = fields[index(key)]!;
    if (f.type !== "enum") throw new Error("Not an enum.");
    return f.options;
  };
  return {
    field: (key) => `field-${index(key)}`,
    key: (field) => fields[ordinal(field, "field", fields.length)]!.key,
    option(key, value) {
      const n = options(key).findIndex((o) => o.value === value);
      if (n < 0) throw new Error("Unknown option.");
      return `option-${n}`;
    },
    value: (key, option) => {
      const all = options(key);
      return all[ordinal(option, "option", all.length)]!.value;
    },
  };
}
export type { ContributedSettingsForm, SettingsFieldMap } from "@kobrixa/plugin-runtime";
export function createContributedSettingsForm(
  controls: SettingsControlsPort,
  service: BoundSettingsService,
): ContributedSettingsForm {
  let current:
    | {
        binding: SettingsFormBinding;
        resource: SettingsResourceV1;
        store: ReturnType<typeof createContributedSettingsStore>;
        off: () => void;
        change: () => void;
      }
    | undefined;
  function matches(binding: SettingsFormBinding) {
    return current && identity(current.binding) === identity(binding);
  }
  function close() {
    if (!current) return;
    current.off();
    current.change();
    current.store.dispose();
    service.dispose(current.binding);
    controls.dispose(current.binding);
    current = undefined;
  }
  return {
    open(binding, resource, snapshot) {
      close();
      createSettingsFieldMap(resource);
      const store = createContributedSettingsStore(snapshot, {
        validate: (key, value) => {
          try {
            validateSettingsValues(resource, [{ key, value }], false);
            return true;
          } catch {
            return false;
          }
        },
        async read() {
          const result = await service.read(binding);
          if (!result.ok) throw result.error;
          return result.value;
        },
        mutate: (input) =>
          input.reset
            ? service.reset(binding, {
                schemaVersion: input.schemaVersion,
                expectedRevision: input.expectedRevision,
                keys: [input.key],
              })
            : service.update(binding, {
                schemaVersion: input.schemaVersion,
                expectedRevision: input.expectedRevision,
                changes: [{ key: input.key, value: input.value }],
              }),
      });
      const draw = () => controls.render(binding, resource, store.state());
      const offDraw = store.subscribe(draw);
      const offWatch = service.watch(binding, () => {
        void service
          .read(binding)
          .then((result) => {
            if (!matches(binding)) return;
            if (result.ok) store.external(result.value);
            else store.fail(result.error.message);
          })
          .catch(() => {
            if (matches(binding)) store.fail("Current saved values are unavailable.");
          });
      });
      const off = () => {
        offDraw();
        offWatch();
      };
      const change = controls.onChange((incoming, key, value, phase) => {
        if (!matches(incoming)) return;
        const field = resource.fields.find((x) => x.key === key);
        if (!field) return;
        store.edit(
          key,
          phase === "reset" ? field.default : value,
          phase,
          field.type === "boolean" || field.type === "enum",
        );
      });
      current = { binding: structuredClone(binding), resource, store, off, change };
      draw();
    },
    replaceSnapshot(binding, snapshot) {
      if (matches(binding)) current!.store.external(snapshot);
    },
    showFailure(binding, error) {
      if (matches(binding)) current!.store.fail(error.message);
    },
    dispose(binding) {
      if (matches(binding)) close();
    },
    async retry(binding, key) {
      if (matches(binding)) await current!.store.retry(key);
    },
    async reload(binding) {
      if (matches(binding)) await current!.store.reload();
    },
  };
}
