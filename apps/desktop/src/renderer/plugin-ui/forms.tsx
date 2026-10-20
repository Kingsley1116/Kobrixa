import { CompositionInput } from "./composition-input.js";
import { useState, useSyncExternalStore } from "react";
import type { SettingsFormBinding } from "@kobrixa/plugin-runtime";
import type { SettingsResourceV1, SettingsScalar } from "@kobrixa/plugin-protocol";
import { settingsAttachment, type SettingsControlsPort, type SettingsDraftState, type UiLabels } from "./host-ports.js";
import { translated } from "./components.js";
import { numericDraft } from "./state-store.js";
type Field = SettingsResourceV1["fields"][number];
type Change = Parameters<SettingsControlsPort["onChange"]>[0];
type FormView = { binding: SettingsFormBinding; resource: SettingsResourceV1; state: SettingsDraftState; raw: Record<string, string>; invalid: string[] };
const keyOf = (binding: SettingsFormBinding) => JSON.stringify([binding.owner.sourceKey, binding.owner.pluginId, binding.owner.uiResourceGeneration, binding.scope.hostEpoch, binding.scope.workbenchInstance, binding.resourceDigest]);
export function settingValid(field: Field, value: SettingsScalar): boolean {
  switch (field.type) {
    case "boolean": return typeof value === "boolean";
    case "number": case "integer": return typeof value === "number" && Number.isFinite(value) && value >= field.minimum && value <= field.maximum && (field.type !== "integer" || Number.isInteger(value));
    case "string": return typeof value === "string" && Array.from(value).length >= field.minLength && Array.from(value).length <= field.maxLength && new TextEncoder().encode(value).length <= field.maxBytes;
    case "enum": return field.options.some((option) => option.value === value);
  }
}
export class SettingsControls implements SettingsControlsPort {
  private view: FormView | null = null;
  private listeners = new Set<() => void>(); private changes = new Set<Change>();
  private sent = new Map<string, SettingsScalar>();
  getSnapshot = (): FormView | null => this.view;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(): void { this.listeners.forEach((listener) => listener()); }
  render(binding: SettingsFormBinding, resource: SettingsResourceV1, state: SettingsDraftState): void {
    if (resource.fields.length > 128) throw new Error("Settings field limit");
    const previous = this.view; const same = previous && keyOf(previous.binding) === keyOf(binding);
    const raw = same ? { ...previous.raw } : {};
    if (!same) this.sent.clear();
    for (const item of state.baseline.values) {
      if (this.sent.has(item.key) && this.sent.get(item.key) === item.value && !state.busyKeys.includes(item.key) && !state.errors.some((error) => error.key === item.key)) {
        const field = resource.fields.find((candidate) => candidate.key === item.key);
        const currentRaw = raw[item.key];
        const current = currentRaw === undefined ? item.value : field?.type === "number" || field?.type === "integer" ? numericDraft(currentRaw) : currentRaw;
        if (current === item.value) { delete raw[item.key]; this.sent.delete(item.key); }
      }
    }
    this.view = { binding, resource, state, raw, invalid: same ? previous.invalid : [] }; this.publish();
  }
  onChange(listener: Change): () => void { this.changes.add(listener); return () => { this.changes.delete(listener); }; }
  dispose(binding: SettingsFormBinding): void { if (this.view && keyOf(this.view.binding) === keyOf(binding)) { this.view = null; this.sent.clear(); this.publish(); } }
  retry(key: string): Promise<void> {
    const view = this.view; const attachment = settingsAttachment(this);
    return view && attachment ? attachment.retry(view.binding, key) : Promise.resolve();
  }
  async reload(): Promise<void> {
    const view = this.view; const attachment = settingsAttachment(this);
    if (!view || !attachment) return;
    await attachment.reload(view.binding);
    if (this.view && keyOf(this.view.binding) === keyOf(view.binding)) {
      this.view = { ...this.view, raw: {}, invalid: [] }; this.sent.clear(); this.publish();
    }
  }
  destroy(): void { this.view = null; this.sent.clear(); this.changes.clear(); this.listeners.clear(); }
  fields(page: number): Field[] { return this.view?.resource.fields.slice(page * 16, page * 16 + 16) ?? []; }
  raw(key: string, raw: string): void { if (Array.from(raw).length > 4000 || !this.view) return; this.view = { ...this.view, raw: { ...this.view.raw, [key]: raw }, invalid: this.view.invalid.filter((item) => item !== key) }; this.publish(); }
  commit(key: string, phase: "change" | "blur" | "enter" | "reset", immediate?: SettingsScalar): void {
    const view = this.view; const field = view?.resource.fields.find((item) => item.key === key);
    if (!view || !field || view.state.busyKeys.includes(key)) return;
    const raw = view.raw[key]; const draft = view.state.draft.find((item) => item.key === key)?.value ?? field.default;
    const value = phase === "reset" ? field.default : immediate !== undefined ? immediate : raw === undefined ? draft
      : field.type === "number" || field.type === "integer" ? numericDraft(raw) : raw;
    if (value === null || !settingValid(field, value)) { this.view = { ...view, invalid: [...new Set([...view.invalid, key])] }; this.publish(); return; }
    if (phase === "blur" && this.sent.get(key) === value && !view.state.errors.some((error) => error.key === key)) return;
    this.sent.set(key, value);
    if (phase === "reset") { const next = { ...view.raw }; delete next[key]; this.view = { ...view, raw: next, invalid: view.invalid.filter((item) => item !== key) }; this.publish(); }
    this.changes.forEach((listener) => listener(view.binding, key, value, phase));
  }
}
export function SettingsControlsView({ controls, locale, labels }: { controls: SettingsControls; locale: "en" | "zh-TW"; labels: UiLabels }) {
  const view = useSyncExternalStore(controls.subscribe, controls.getSnapshot); const [page, setPage] = useState(0);
  if (!view) return null;
  const pages = Math.max(1, Math.ceil(view.resource.fields.length / 16)); const currentPage = Math.min(page, pages - 1);
  return <section className="plugin-ui" aria-label={translated(view.resource.title, locale)}>
    <h3>{translated(view.resource.title, locale)}</h3>
    <button disabled={!settingsAttachment(controls) || view.state.busyKeys.length > 0} onClick={() => { void controls.reload().catch(() => {}); }}>{labels.refresh}</button>
    {controls.fields(currentPage).map((field, offset) => {
      const index = currentPage * 16 + offset;
      const map = settingsAttachment(controls)?.fieldMap(view.resource);
      const fieldId = map?.field(field.key) ?? `field${index}`;
      const key = map ? map.key(fieldId) : field.key;
      const id = `setting-${view.binding.scope.workbenchInstance}-${fieldId}`;
      const value = view.state.draft.find((item) => item.key === field.key)?.value ?? field.default;
      const error = view.state.errors.find((item) => item.key === field.key);
      const invalid = view.invalid.includes(field.key) || field.type === "enum" && !settingValid(field, value); const disabled = view.state.busyKeys.includes(field.key);
      const description = [field.help && `${id}-help`, (error || invalid) && `${id}-error`].filter(Boolean).join(" ") || undefined;
      const commit = (phase: "blur" | "enter") => controls.commit(field.key, phase);
      return <div key={field.key} className="plugin-ui-node"><label htmlFor={id}>{translated(field.label, locale)}</label>
        {field.type === "boolean" ? <input id={id} type="checkbox" disabled={disabled} checked={value === true} aria-describedby={description} onChange={(event) => controls.commit(field.key, "change", event.target.checked)} />
          : field.type === "enum" ? <select id={id} disabled={disabled} aria-invalid={!!error || invalid} aria-describedby={description} value={invalid ? "" : map ? map.option(key, value) : `option${field.options.findIndex((option) => option.value === value)}`}
            onChange={(event) => { const value = map ? map.value(key, event.target.value) : field.options[Number(event.target.value.slice(6))]?.value; if (value !== undefined) controls.commit(key, "change", value); }}>{invalid && <option value="" disabled>{labels.invalid}</option>}{field.options.map((option, optionIndex) => <option key={optionIndex} value={map ? map.option(key, option.value) : `option${optionIndex}`}>{translated(option.label, locale)}</option>)}</select>
            : <CompositionInput key={keyOf(view.binding)} id={id} type="text" maxLength={8000} inputMode={field.type === "string" ? "text" : "decimal"} disabled={disabled} aria-invalid={!!error || invalid} aria-describedby={description}
              value={view.raw[field.key] ?? String(value)} onValue={(value) => controls.raw(field.key, value)} onBlur={() => commit("blur")}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commit("enter"); } }} />}
        {field.help && <p id={`${id}-help`}>{translated(field.help, locale)}</p>}
        {(error || invalid) && <p id={`${id}-error`} role="alert">{error ? translated(error.message, locale) : labels.invalid}</p>}
        {error && <button disabled={disabled} onClick={() => { void controls.retry(key).catch(() => {}); }}>{labels.retry}</button>}
        <button disabled={disabled} onClick={() => controls.commit(field.key, "reset")}>{labels.reset}</button>
      </div>;
    })}
    {pages > 1 && <nav aria-label={translated(view.resource.title, locale)}><button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{labels.previous}</button><span>{currentPage + 1} / {pages}</span><button disabled={currentPage + 1 === pages} onClick={() => setPage(currentPage + 1)}>{labels.next}</button></nav>}
  </section>;
}
