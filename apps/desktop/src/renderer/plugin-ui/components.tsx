import { Component, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { DisplayText, DisplayValue, Text, UiScalar } from "@kobrixa/plugin-protocol";
import type { UiLabels } from "./host-ports.js";
import { condition, numericDraft, type UiStateStore } from "./state-store.js";
import type { UiIntentController } from "./intent-controller.js";
export const translated = (text: Text, locale: "en" | "zh-TW"): string => locale === "zh-TW" ? text["zh-TW"] ?? text.en : text.en;
export function displayText(value: DisplayText, data: Record<string, UiScalar>, locale: "en" | "zh-TW"): string {
  return "text" in value ? translated(value.text, locale) : String(data[value.ref.key] ?? "");
}
export function LiveText({ text, alert = false }: { text: string; alert?: boolean }) {
  const [announced, setAnnounced] = useState(text); const latest = useRef(text); latest.current = text;
  useEffect(() => {
    if (alert) { setAnnounced(text); return; }
    const timer = setInterval(() => setAnnounced(latest.current), 1000); return () => clearInterval(timer);
  }, [alert]);
  return <span role={alert ? "alert" : "status"} aria-live={alert ? "assertive" : "polite"} aria-atomic="true">{alert ? text : announced}</span>;
}
export class ContributionBoundary extends Component<{ children: ReactNode; onFailure: () => void; fallback: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onFailure(); }
  render() { return this.state.failed ? <p role="alert">{this.props.fallback}</p> : this.props.children; }
}
export function PanelTree({ state, intent, locale, labels }: { state: UiStateStore; intent: UiIntentController; locale: "en" | "zh-TW"; labels: UiLabels }) {
  const view = useSyncExternalStore(state.subscribe, state.getSnapshot, state.getSnapshot);
  useLayoutEffect(() => state.renderCommitted(view.snapshot.revision), [state, view.snapshot.revision]);
  const root = useRef<HTMLDivElement>(null); const focus = useRef<{ element: HTMLElement; groups: string[] } | null>(null);
  const presentation = state.presentation(); const nodes = new Map(state.resource.nodes.map((node) => [node.id, node]));
  useEffect(() => {
    const up = (event: PointerEvent) => intent.release("pointer", String(event.pointerId), false);
    const key = (event: KeyboardEvent) => intent.release("key", event.key, false);
    const cancel = () => intent.cancel();
    const visibility = () => { if (document.visibilityState !== "visible") cancel(); };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pointerup", up); window.addEventListener("keyup", key); window.addEventListener("blur", cancel);
    return () => { cancel(); document.removeEventListener("visibilitychange", visibility); window.removeEventListener("pointerup", up); window.removeEventListener("keyup", key); window.removeEventListener("blur", cancel); };
  }, [intent]);
  useLayoutEffect(() => {
    const remembered = focus.current;
    if (remembered && (!remembered.element.isConnected || remembered.element.closest("[hidden]") || remembered.element.matches(":disabled"))) {
      for (const id of remembered.groups) {
        const group = root.current?.querySelector<HTMLElement>(`[data-ui-group="${id}"]`);
        if (group && !group.closest("[hidden]")) { group.focus(); return; }
      }
      root.current?.focus();
    }
  }, [view]);
  const text = (value: Text) => translated(value, locale);
  const value = (input: DisplayValue): UiScalar => "literal" in input ? input.literal : (input.ref.scope === "data" ? view.snapshot.data : view.draft)[input.ref.key] ?? null;
  const render = (id: string): ReactNode => {
    const node = nodes.get(id); if (!node) throw new Error("Missing UI node");
    const available = presentation.get(id)!; const disabled = !available.enabled || !view.active;
    const domId = `ui-${view.snapshot.binding.panelInstance}-${id}`;
    const field = "field" in node ? node.field : undefined;
    const help = node.type === "holdAction" ? `${labels.holdHint}${node.help ? ` ${text(node.help)}` : ""}` : "help" in node && node.help ? text(node.help) : undefined;
    const error = field && view.errors[field] ? text(view.errors[field]!) : field && !state.fieldValid(node) ? labels.invalid : undefined;
    const description = [help && `${domId}-help`, error && `${domId}-error`].filter(Boolean).join(" ") || undefined;
    const descriptor = field ? state.resource.fields[field] : undefined;
    const required = !!descriptor && (descriptor.required || descriptor.requiredWhen !== undefined && condition(descriptor.requiredWhen, view.snapshot.data, view.draft));
    const common = { id: domId, disabled, "aria-describedby": description, "aria-invalid": !!error, "aria-required": required };
    const raw = (key: string): string => view.raw[key] ?? String(view.draft[key] ?? "");
    let content: ReactNode;
    switch (node.type) {
      case "group": content = <section data-ui-group={id} tabIndex={-1} aria-label={node.label ? text(node.label) : labels.tools} className={`plugin-ui-group plugin-ui-${node.layout}`}>
        {node.label && <h3>{text(node.label)}</h3>}{node.help && <p>{text(node.help)}</p>}{node.children.map(render)}</section>; break;
      case "text": content = node.emphasis === "strong" ? <strong>{displayText(node.value, view.snapshot.data, locale)}</strong> : <span>{displayText(node.value, view.snapshot.data, locale)}</span>; break;
      case "help": content = <p className="plugin-ui-help">{displayText(node.value, view.snapshot.data, locale)}</p>; break;
      case "textInput": content = <><label htmlFor={domId}>{text(node.label)}</label><input {...common} type="text" maxLength={8000} value={raw(node.field)} placeholder={node.placeholder && text(node.placeholder)} onChange={(event) => state.edit(node.field, event.target.value, event.target.value)} /></>; break;
      case "number": case "range": {
        const schema = state.resource.fields[node.field]!.schema;
        if (schema.type !== "number") throw new Error("Numeric field mismatch");
        content = <><label htmlFor={domId}>{text(node.label)}{node.unit && ` (${text(node.unit)})`}</label>
          <input {...common} type="text" maxLength={8000} inputMode="decimal" value={raw(node.field)} onChange={(event) => state.edit(node.field, numericDraft(event.target.value), event.target.value)} />
          {node.type === "range" && <input type="range" aria-label={text(node.label)} disabled={disabled} min={schema.min} max={schema.max} step={node.step}
            value={typeof view.draft[node.field] === "number" ? view.draft[node.field] as number : schema.min}
            onChange={(event) => state.edit(node.field, Number(event.target.value), event.target.value)} />}</>; break;
      }
      case "choice": content = node.presentation === "select" ? <><label htmlFor={domId}>{text(node.label)}</label><select {...common} value={String(view.draft[node.field] ?? "")} onChange={(event) => state.edit(node.field, event.target.value)}>{node.options.map((option) => <option key={option.value} value={option.value}>{text(option.label)}</option>)}</select></>
        : <fieldset disabled={disabled} role="radiogroup" aria-describedby={description}><legend>{text(node.label)}</legend>{node.options.map((option, index) => <label key={option.value}>
          <input type="radio" name={domId} checked={view.draft[node.field] === option.value} onChange={() => state.edit(node.field, option.value)}
            onKeyDown={(event) => { const delta = ["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : ["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 0;
              if (!delta) return; event.preventDefault(); const next = (index + delta + node.options.length) % node.options.length;
              state.edit(node.field, node.options[next]!.value); event.currentTarget.closest("fieldset")?.querySelectorAll<HTMLInputElement>("input")[next]?.focus(); }} />{text(option.label)}</label>)}</fieldset>; break;
      case "boolean": content = <label><input {...common} type="checkbox" checked={view.draft[node.field] === true} onChange={(event) => state.edit(node.field, event.target.checked)} />{text(node.label)}</label>; break;
      case "action": content = <button id={domId} disabled={disabled || view.busy || !state.valid()} data-variant={node.variant} onClick={() => void state.invoke(node.id)}>{text(node.label)}</button>; break;
      case "holdAction": content = <button {...common} disabled={disabled || !state.valid()}
        onPointerDown={(event) => { if (intent.begin(node.id, { trusted: event.nativeEvent.isTrusted, kind: "pointer", id: String(event.pointerId), primary: event.isPrimary && event.button === 0, repeat: false })) event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerUp={(event) => intent.release("pointer", String(event.pointerId), false)} onPointerCancel={() => intent.cancel()} onLostPointerCapture={() => intent.cancel()}
        onContextMenu={(event) => { event.preventDefault(); intent.cancel(); }} onBlur={() => intent.cancel()}
        onKeyDown={(event) => { if (event.key === "Escape") { intent.cancel(); return; } if (event.key === " " || event.key === "Enter") { event.preventDefault(); intent.begin(node.id, { trusted: event.nativeEvent.isTrusted, kind: "key", id: event.key, primary: true, repeat: event.repeat }); } }}
        onKeyUp={(event) => intent.release("key", event.key, false)}>{text(node.label)}</button>; break;
      case "status": content = <span data-tone={node.tone}><LiveText text={displayText(node.text, view.snapshot.data, locale)} /></span>; break;
      case "alert": content = <span data-tone={node.severity}><LiveText text={displayText(node.text, view.snapshot.data, locale)} alert /></span>; break;
      case "progress": { const amount = value(node.value); content = <label>{text(node.label)}<progress max={node.max} value={typeof amount === "number" ? amount : undefined} /></label>; break; }
      case "keyValue": content = <dl>{node.rows.map((row) => <div key={row.id}><dt>{text(row.label)}</dt><dd>{String(value(row.value) ?? "")}{row.unit && ` ${text(row.unit)}`}</dd></div>)}</dl>; break;
      default: throw new Error("Unsupported UI component");
    }
    return <div key={node.id} data-ui-node={node.id} hidden={!available.visible} className="plugin-ui-node">{content}
      {help && node.type !== "group" && <p id={`${domId}-help`} className="plugin-ui-help">{help}</p>}{error && <p id={`${domId}-error`} role="alert">{error}</p>}</div>;
  };
  return <div ref={root} className="plugin-ui" tabIndex={-1} onFocusCapture={(event) => {
    const groups: string[] = []; let element: HTMLElement | null = event.target;
    while (element && element !== root.current) { if (element.dataset.uiGroup) groups.push(element.dataset.uiGroup); element = element.parentElement; }
    focus.current = { element: event.target, groups };
  }}>{render(state.resource.root)}{!state.valid() && <p role="status">{labels.invalid}</p>}{view.problem && <p role="alert">{labels.unavailable}: {view.problem}</p>}</div>;
}
