import type {
  PluginUiBridge,
  UiInteractionRequest,
  UiInteractionView,
} from "@kobrixa/plugin-runtime";
import { effectiveTimeDomainV2, type PanelResourceV2 } from "@kobrixa/plugin-protocol";
import type { UiStateStore } from "./state-store.js";
import type { UiDatasetStore } from "./data-store.js";

type PanelRequest = Exclude<UiInteractionRequest, { kind: "viewState" | "core" }>;
type WithoutCommon<T> = T extends PanelRequest
  ? Omit<T, "binding" | "presentation" | "viewGeneration" | "formRevision" | "form">
  : never;
export type PanelInteraction = WithoutCommon<PanelRequest>;
export type InteractionView = Readonly<{
  view: UiInteractionView | null;
  busy: boolean;
  requestedCursor: number | null;
  readings: Readonly<Record<string, number | null>> | null;
  problem: string | null;
}>;

/** A binding-local controller. All action arguments are resolved by the host.
 * Cursor responses have independent fences and never apply a feature state patch. */
export class UiInteractionStore {
  #snapshot: InteractionView = {
    view: null,
    busy: false,
    requestedCursor: null,
    readings: null,
    problem: null,
  };
  #listeners = new Set<() => void>();
  #epoch = 0;
  #alive = true;
  #viewCurrent = false;
  #signature = "";
  #refresh: Promise<void> | undefined;
  #refreshAgain = false;
  #offs: (() => void)[];
  #cursorSequence = 0;
  #cursorPending: Extract<PanelInteraction, { kind: "cursor" }> | undefined;
  #cursorRunning = false;
  #cursorTimer: ReturnType<typeof setTimeout> | undefined;
  #lastCursorAt = -Infinity;
  constructor(
    private bridge: Pick<PluginUiBridge, "interact">,
    private state: UiStateStore,
    private data: UiDatasetStore,
    private resource: PanelResourceV2,
  ) {
    this.#offs = [state.subscribe(() => this.#changed()), data.subscribe(() => this.#changed())];
    this.#changed();
  }
  getSnapshot = (): InteractionView => this.#snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  #publish(update: Partial<InteractionView>): void {
    this.#snapshot = { ...this.#snapshot, ...update };
    for (const listener of this.#listeners) listener();
  }
  #acceptView(view: UiInteractionView): void {
    this.#viewCurrent = true;
    if (this.#snapshot.view && this.#snapshot.view.generation !== view.generation) {
      this.#epoch++;
      this.#cursorSequence++;
      this.#cursorPending = undefined;
      if (this.#cursorTimer) this.state.clearInputTimer(this.#cursorTimer);
      this.#cursorTimer = undefined;
    }
    this.#publish({ view, readings: null, problem: null });
  }
  #changed(): void {
    const s = this.state.getSnapshot();
    if (!s.active) {
      this.dispose();
      return;
    }
    const signature = JSON.stringify([
      s.snapshot.visible,
      ...(this.state.formSync
        ? [s.localRevision, s.snapshot.formRevision, this.state.formCurrent()]
        : []),
      s.snapshot.data[this.resource.presentationKey],
      this.data.getSnapshot().presentation,
      Object.keys(this.resource.datasets).map((id) => [id, this.data.revision(id)]),
    ]);
    if (signature === this.#signature) return;
    this.#signature = signature;
    this.#epoch++;
    this.#cursorSequence++;
    this.#cursorPending = undefined;
    if (this.#cursorTimer) this.state.clearInputTimer(this.#cursorTimer);
    this.#cursorTimer = undefined;
    this.#viewCurrent = false;
    this.#publish({ view: s.snapshot.visible ? this.#snapshot.view : null, readings: null });
    if (s.snapshot.visible && this.state.formCurrent())
      void this.refresh().then(() => this.#followCursor());
  }
  async refresh(): Promise<void> {
    if (
      !this.#alive ||
      !this.bridge.interact ||
      !this.state.getSnapshot().snapshot.visible ||
      !this.state.formCurrent()
    )
      return;
    this.#refreshAgain = true;
    if (this.#refresh) return this.#refresh;
    this.#refresh = (async () => {
      while (this.#refreshAgain && this.#alive) {
        this.#refreshAgain = false;
        const epoch = this.#epoch;
        try {
          const result = await this.state.actionReply(
            this.bridge.interact!({ kind: "viewState", binding: this.state.form().binding }),
          );
          if (!this.#alive || epoch !== this.#epoch) continue;
          if (result.ok && result.value.kind === "view") this.#acceptView(result.value.view);
          else {
            this.#viewCurrent = false;
            this.#publish({ problem: result.ok ? "view" : result.error.code });
          }
        } catch {
          if (this.#alive && epoch === this.#epoch) {
            this.#viewCurrent = false;
            this.#publish({ problem: "view" });
          }
        }
      }
    })().finally(() => {
      this.#refresh = undefined;
    });
    return this.#refresh;
  }
  async act(action: Exclude<PanelInteraction, { kind: "cursor" }>): Promise<void> {
    if (!this.#alive || !this.bridge.interact) return;
    const node = this.resource.nodes.find((n) => n.id === action.nodeId);
    const closing =
      action.kind === "dialogClose" ||
      (action.kind === "action" &&
        node?.type === "action" &&
        node.action.kind === "view" &&
        node.action.action === "closeDialog");
    if (this.#snapshot.busy && !closing) return;
    const viewOnly =
      action.kind === "chartView" ||
      action.kind === "dialogClose" ||
      (action.kind === "action" && node?.type === "action" && node.action.kind === "view") ||
      (action.kind === "list" &&
        node?.type === "list" &&
        node.actions.find((a) => a.id === action.actionId)?.action.kind === "view");
    this.#publish({ ...(closing ? {} : { busy: true }), problem: null });
    let submitted = false;
    const local = this.state.getSnapshot().localRevision;
    let epoch = this.#epoch;
    try {
      if (!viewOnly) {
        if (!this.state.valid() || this.state.getSnapshot().busy) return;
        if (this.state.needsReconcile() && !(await this.state.reconcileAction())) return;
        if (this.state.formSync && !(await this.state.flushForm())) return;
      }
      if (!viewOnly && !this.state.derivedCurrent()) return;
      await this.refresh();
      const view = this.#snapshot.view;
      if (
        !this.#alive ||
        !view ||
        !this.#viewCurrent ||
        local !== this.state.getSnapshot().localRevision ||
        !this.state.getSnapshot().snapshot.visible
      )
        return;
      if (!viewOnly) {
        if (!this.state.nextAction()) return;
        submitted = true;
      }
      epoch = this.#epoch;
      const s = this.state.getSnapshot();
      const result = await this.state.actionReply(
        this.bridge.interact({
          ...action,
          ...this.state.form(),
          formRevision: viewOnly ? s.snapshot.formRevision : this.state.form().formRevision,
          form: viewOnly ? { ...s.snapshot.form } : this.state.form().form,
          presentation: this.data.getSnapshot().presentation,
          viewGeneration: view.generation,
        }),
      );
      if (!this.#alive || epoch !== this.#epoch || local !== this.state.getSnapshot().localRevision)
        return;
      if (!result.ok) {
        this.#publish({ problem: result.error.code });
        return;
      }
      if (result.value.kind === "view") {
        this.#acceptView(result.value.view);
        this.#followCursor();
      } else if (result.value.kind === "command")
        this.state.applyCommandValue(result.value.value, action.nodeId);
    } catch {
      if (this.#alive && epoch === this.#epoch && local === this.state.getSnapshot().localRevision)
        this.#publish({ problem: "interaction" });
    } finally {
      if (submitted) this.state.actionFinished();
      if (this.#alive && !closing) this.#publish({ busy: false });
    }
  }
  cursor(nodeId: string, dataset: string, time: number | null): void {
    const revision = this.data.revision(dataset);
    if (
      !this.#alive ||
      !this.state.formCurrent() ||
      !this.#snapshot.view ||
      revision === undefined ||
      (time !== null && !Number.isFinite(time))
    )
      return;
    this.#cursorSequence++;
    this.#cursorPending = { kind: "cursor", nodeId, dataset, revision, time };
    this.#publish({ requestedCursor: time, readings: null });
    this.#scheduleCursor();
  }
  #followCursor(): void {
    const view = this.#snapshot.view;
    if (!this.#alive || !view || !this.#viewCurrent || !this.state.getSnapshot().snapshot.visible)
      return;
    const nodes = this.state.presentation(view.dialogId);
    const node = this.resource.nodes.find(
      (n) =>
        n.type === "lineChart" &&
        nodes.get(n.id)?.visible &&
        nodes.get(n.id)?.enabled &&
        (view.dialogId ? n.timeView === "inspect" : n.timeView === "default"),
    );
    if (!node || node.type !== "lineChart") return;
    const dataset = this.data.dataset(node.dataset),
      revision = this.data.revision(node.dataset);
    if (!dataset || dataset.header.kind !== "chart" || revision === undefined) return;
    const [from, to] = effectiveTimeDomainV2(
      dataset.header,
      node.timeView === "inspect" ? (view.inspectView ?? dataset.header.view) : dataset.header.view,
    );
    const requested = this.#snapshot.requestedCursor;
    this.#cursorSequence++;
    this.#cursorPending = {
      kind: "cursor",
      nodeId: node.id,
      dataset: node.dataset,
      revision,
      time: requested === null ? null : Math.max(from, Math.min(to, requested)),
    };
    this.#scheduleCursor();
  }
  #scheduleCursor(): void {
    if (
      !this.#alive ||
      !this.#viewCurrent ||
      this.#cursorRunning ||
      this.#cursorTimer ||
      !this.#cursorPending
    )
      return;
    const delay = Math.max(0, 100 - (performance.now() - this.#lastCursorAt));
    this.#cursorTimer = setTimeout(() => {
      if (this.#cursorTimer) this.state.clearInputTimer(this.#cursorTimer);
      this.#cursorTimer = undefined;
      void this.#runCursor();
    }, delay);
    this.state.trackInputTimer(this.#cursorTimer);
  }
  async #runCursor(): Promise<void> {
    const action = this.#cursorPending,
      view = this.#snapshot.view;
    this.#cursorPending = undefined;
    if (
      !action ||
      !view ||
      !this.#viewCurrent ||
      !this.bridge.interact ||
      !this.#alive ||
      !this.state.formCurrent()
    )
      return;
    this.#cursorRunning = true;
    this.#lastCursorAt = performance.now();
    const epoch = this.#epoch,
      sequence = this.#cursorSequence,
      presentation = this.data.getSnapshot().presentation;
    try {
      const s = this.state.getSnapshot();
      const result = await this.state.actionReply(
        this.bridge.interact({
          ...action,
          ...this.state.form(),
          formRevision: s.snapshot.formRevision,
          form: { ...s.snapshot.form },
          presentation,
          viewGeneration: view.generation,
        }),
      );
      if (
        !this.#alive ||
        epoch !== this.#epoch ||
        sequence !== this.#cursorSequence ||
        this.#snapshot.view?.generation !== view.generation
      )
        return;
      if (
        result.ok &&
        result.value.kind === "cursor" &&
        result.value.presentation === presentation &&
        result.value.viewGeneration === view.generation
      ) {
        const output = result.value.output;
        if (
          Object.keys(output).length <= 16 &&
          Object.values(output).every(
            (x) => x === null || (typeof x === "number" && Number.isFinite(x)),
          )
        )
          this.#publish({ readings: Object.freeze({ ...output }), problem: null });
      } else if (!result.ok) this.#publish({ problem: result.error.code });
    } catch {
      if (
        this.#alive &&
        epoch === this.#epoch &&
        sequence === this.#cursorSequence &&
        this.#snapshot.view?.generation === view.generation
      )
        this.#publish({ problem: "cursor" });
    } finally {
      this.#cursorRunning = false;
      this.#scheduleCursor();
    }
  }
  dispose(): void {
    if (!this.#alive) return;
    this.#alive = false;
    this.#viewCurrent = false;
    this.#epoch++;
    this.#cursorPending = undefined;
    if (this.#cursorTimer) this.state.clearInputTimer(this.#cursorTimer);
    this.#cursorTimer = undefined;
    for (const off of this.#offs) off();
    this.#publish({ view: null, readings: null, busy: false });
    this.#listeners.clear();
  }
}
