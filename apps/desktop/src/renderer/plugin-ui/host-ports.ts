import { recoveryTimers } from "./recovery-support.js";
export { registerRecoveryDiagnostics } from "./recovery-support.js";
import type { CoreRecoveryPort, PluginUiBridge, SettingsFormBinding, ContributedSettingsForm, SettingsFieldMap, FoundationDiagnostics } from "@kobrixa/plugin-runtime";
import type { UiBinding, SettingsSnapshot, SettingsResourceV1, SettingsScalar, SettingsText, SettingKey, Values } from "@kobrixa/plugin-protocol";
import { RendererSession, bootstrapPluginUi } from "./bootstrap.js";
export interface PluginUiRendererHost {
  start(): Promise<void>;
  setVisibility(binding: UiBinding, visible: boolean, reason: Parameters<PluginUiBridge["visibility"]>[0]["reason"]): Promise<void>;
  dispose(): void;
}
export type SettingsDraftState = {
  baseline: SettingsSnapshot; draft: Values; busyKeys: SettingKey[];
  errors: Array<{ key: SettingKey; message: SettingsText }>;
};
export interface SettingsControlsPort {
  render(binding: SettingsFormBinding, resource: SettingsResourceV1, state: SettingsDraftState): void;
  onChange(listener: (binding: SettingsFormBinding, key: SettingKey, value: SettingsScalar, phase: "change" | "blur" | "enter" | "reset") => void): () => void;
  dispose(binding: SettingsFormBinding): void;
}
export type { UiLabels } from "./recovery-support.js";
type SettingsAttachment = {
  retry: ContributedSettingsForm["retry"]; reload: ContributedSettingsForm["reload"];
  fieldMap: (resource: SettingsResourceV1) => SettingsFieldMap;
};
const attachments = new WeakMap<SettingsControlsPort, SettingsAttachment>();
export function attachSettingsControls(controls: SettingsControlsPort, input: SettingsAttachment): () => void {
  if (attachments.has(controls)) throw new Error("Settings controls already attached");
  attachments.set(controls, input);
  return () => { if (attachments.get(controls) === input) attachments.delete(controls); };
}
export function settingsAttachment(controls: SettingsControlsPort): SettingsAttachment | undefined {
  return attachments.get(controls);
}
const sessions = new WeakMap<PluginUiRendererHost, RendererSession>();
export function diagnosticsFor(instance: object): FoundationDiagnostics {
  const session = sessions.get(instance as PluginUiRendererHost);
  const timers = recoveryTimers(instance);
  if (!session && !timers) throw new Error("Unknown renderer host instance");
  return Object.freeze({
    snapshot: () => Object.freeze({ owners: 0, bindings: 0, subscriptions: 0, queuedEvents: 0,
      queuedBytes: 0, timers: timers?.() ?? 0, pendingInvocations: 0, actionTokens: 0,
      resourceReaders: session?.catalog.retainedReaders() ?? 0, workerJobs: 0 }),
    onEvent: (_listener: Parameters<FoundationDiagnostics["onEvent"]>[0]) => () => {},
  });
}
export function rendererSession(host: PluginUiRendererHost): RendererSession {
  const session = sessions.get(host); if (!session) throw new Error("Unknown UI host"); return session;
}
export function createPluginUiRendererHost(input: { bridge: PluginUiBridge; recovery: CoreRecoveryPort }): PluginUiRendererHost {
  const session = new RendererSession(input.bridge);
  const host: PluginUiRendererHost = {
    start: () => bootstrapPluginUi(session),
    setVisibility: (binding, visible, reason) => session.setVisibility(binding, visible, reason),
    dispose: () => session.dispose(),
  };
  sessions.set(host, session); return host;
}
