import * as Y from "yjs";
import * as monaco from "monaco-editor";
import { presenceStateSchema, type PresenceState } from "@kobrixa/collab-protocol";
import type { CollabSession } from "./types.js";
import { textPositionAt } from "./text-positions.js";

/** Class names used by remote selection and caret decorations (see `styles/collab.css`). */
export const REMOTE_SELECTION_CLASS = "kobrixa-remote-selection";
export const REMOTE_CARET_CLASS = "kobrixa-remote-caret";

const COLOR = /^#[0-9a-f]{6}$/i;

/** Index of a JSON-encoded relative position inside `text`, or undefined when it is elsewhere. */
export function resolveRelativeIndex(doc: Y.Doc, text: Y.Text, json: unknown): number | undefined {
  if (!json || typeof json !== "object") return undefined;
  try {
    const relative = Y.createRelativePositionFromJSON(json);
    const absolute = Y.createAbsolutePositionFromRelativePosition(relative, doc);
    return absolute && absolute.type === text ? absolute.index : undefined;
  } catch {
    return undefined;
  }
}

function cssString(value: string): string {
  // Escape everything that could close the string or the rule.
  return `"${value.replace(/[\\"\n\r\f<>]|[^\x20-\x7e]/g, (char) => `\\${char.codePointAt(0)!.toString(16)} `)}"`;
}

/**
 * One shared `<style>` element holds per-participant color rules, keyed by Yjs
 * client ID. Reference counted so it disappears when no editor shows cursors.
 */
class ParticipantStyles {
  #element: HTMLStyleElement | undefined;
  #rules = new Map<number, string>();
  #users = 0;

  acquire(): void {
    this.#users++;
  }

  release(): void {
    if (--this.#users > 0) return;
    this.#users = 0;
    this.#rules.clear();
    this.#element?.remove();
    this.#element = undefined;
  }

  ensure(clientId: number, color: string, name: string): void {
    const rule =
      `.${REMOTE_SELECTION_CLASS}-${clientId}{background-color:${color}33;}` +
      `.${REMOTE_CARET_CLASS}-${clientId}{border-left-color:${color};}` +
      `.${REMOTE_CARET_CLASS}-${clientId}::after{content:${cssString(name)};background-color:${color};}`;
    if (this.#rules.get(clientId) === rule) return;
    this.#rules.set(clientId, rule);
    this.#write();
  }

  #write(): void {
    if (typeof document === "undefined") return;
    if (!this.#element) {
      this.#element = document.createElement("style");
      this.#element.dataset.kobrixaCollab = "cursors";
      document.head.append(this.#element);
    }
    this.#element.textContent = [...this.#rules.values()].join("\n");
  }
}

const styles = new ParticipantStyles();

/**
 * Renders other participants' selections and carets on a model bound to a
 * shared `Y.Text`. Decorations live on the model, so they survive switching
 * the editor between files.
 */
export class RemoteCursors {
  #decorations: string[] = [];
  #disposed = false;
  readonly #onAwareness = () => this.render();

  constructor(
    private readonly session: CollabSession,
    private readonly file: string,
    private readonly text: Y.Text,
    private readonly model: monaco.editor.ITextModel,
  ) {
    styles.acquire();
    session.awareness.on("change", this.#onAwareness);
    this.render();
  }

  render(): void {
    if (this.#disposed || this.model.isDisposed()) return;
    const { awareness, doc } = this.session;
    const decorations: monaco.editor.IModelDeltaDecoration[] = [];
    for (const [clientId, raw] of awareness.getStates()) {
      if (clientId === awareness.clientID || !Number.isInteger(clientId)) continue;
      const parsed = presenceStateSchema.safeParse(raw);
      if (!parsed.success) continue;
      const state: PresenceState = parsed.data;
      if (state.file !== this.file || !state.selection || !COLOR.test(state.color)) continue;
      const anchor = resolveRelativeIndex(doc, this.text, state.selection.anchor);
      const head = resolveRelativeIndex(doc, this.text, state.selection.head);
      if (anchor === undefined || head === undefined) continue;
      styles.ensure(clientId, state.color, state.name);
      const start = textPositionAt(this.text.toString(), Math.min(anchor, head));
      const end = textPositionAt(this.text.toString(), Math.max(anchor, head));
      const caret = textPositionAt(this.text.toString(), head);
      const hoverMessage = { value: state.name, isTrusted: false, supportHtml: false };
      if (anchor !== head)
        decorations.push({
          range: monaco.Range.fromPositions(start, end),
          options: {
            className: `${REMOTE_SELECTION_CLASS} ${REMOTE_SELECTION_CLASS}-${clientId}`,
            hoverMessage,
            stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          },
        });
      decorations.push({
        range: monaco.Range.fromPositions(caret, caret),
        options: {
          beforeContentClassName: `${REMOTE_CARET_CLASS} ${REMOTE_CARET_CLASS}-${clientId}`,
          hoverMessage,
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      });
    }
    this.#decorations = this.model.deltaDecorations(this.#decorations, decorations);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.session.awareness.off("change", this.#onAwareness);
    if (!this.model.isDisposed()) this.model.deltaDecorations(this.#decorations, []);
    this.#decorations = [];
    styles.release();
  }
}
