import { randomUUID } from "node:crypto";
import {
  type PluginDefinition,
  type PluginContext,
  type ContextCommandContext,
  type DeviceSubscription,
  type PersistenceDrainContext,
} from "@kobrixa/plugin-sdk";
import {
  contextCommandDeclarationSchema,
  datasetDeclarationV2Schema,
  validateDatasetPanelV2,
  type UiBinding,
  type UiScalar,
  type UiStateSnapshot,
  type UiEventEnvelopeV2,
  type CommandValue,
  type DeviceSessionSnapshot,
  type SourceCatalog,
  type RecordMeta,
  type DatasetV2,
  type ReadSnapshot,
  type DeviceSubscriptionParams,
} from "@kobrixa/plugin-protocol";
import manifest from "../kobrixa-plugin.json";
import panel from "../ui/panel.json";
import { calibrationDraft, calibrationForm, draftSlot, draftZero } from "./calibration-draft.js";
import { LabPreview, currentSource, freshReading } from "./preview.js";
import { calibrate, identityCalibration } from "./model/calibration.js";
import {
  compatible,
  immutableSnapshot,
  snapshotPublicSource,
  type CalibrationProfile,
  type CalibratedChannel,
  type Recording,
} from "./model/data.js";
import { compatibleEv3Sources, generateEv3CalibrationCode } from "./ev3-source.js";
import { LabRecorder } from "./recorder.js";
import { LabLibrary, type LabRecordKind } from "./library.js";
import { CalibrationWriter } from "./profile-writer.js";
import { LabExport, prepareCsv, copyCalibrationCode } from "./export-actions.js";
import { labCharts, labCursorReadings, type LabChartInput } from "./presentation.js";
import { LabPresentationPublisher } from "./presentation-publisher.js";

const PREFIX = "kobrixa.sensor-lab.";
const key = (b: UiBinding) =>
  JSON.stringify([
    b.contributionId,
    b.panelInstance,
    b.kind,
    b.uiResourceGeneration,
    b.generation,
    b.hostEpoch,
    b.processEpoch,
  ]);
const bounded = (text: string, limit = 1000) => Array.from(text).slice(0, limit).join("");
function value<T>(
  r: { ok: true; value: T } | { ok: false; error: { code: string; message: string } },
): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}
const answer = (): CommandValue => ({ output: {}, fieldErrors: [] });
type Observation = {
  params: Extract<DeviceSubscriptionParams, { topic: "catalog" | "session" }>;
  control: AbortController;
  subscription: DeviceSubscription | undefined;
  work: Promise<void> | undefined;
  terminal: boolean;
  pendingTerminal: Set<string>;
  delivery: number;
  restarts: number;
  failed: boolean;
};
type Page = { entries: RecordMeta[]; nextCursor?: string | undefined };
const sameForm = (a: Record<string, UiScalar>, b: Record<string, UiScalar>) =>
  Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => a[k] === b[k]);
type View = {
  binding: UiBinding;
  abort: AbortController;
  visible: boolean;
  dirty: boolean;
  publisher: LabPresentationPublisher | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  busy: boolean;
  last: number;
  slot: number | undefined;
  subscription: string | undefined;
  published:
    | {
        form: Record<string, UiScalar>;
        formRevision: number;
        presentation: number;
        code: string;
        generatedCode: string;
        input: LabChartInput;
        revisions: Map<string, number>;
        available: SourceCatalog | undefined;
        history: RecordMeta[];
        profiles: RecordMeta[];
      }
    | undefined;
};
/** A single public-SDK process. Panel lifetimes never own the recording consumer or finalizer. */
export class LabController {
  private readonly abort = new AbortController();
  private readonly views = new Map<string, View>();
  private readonly preview = new LabPreview();
  private readonly recorder: LabRecorder;
  private readonly library: LabLibrary;
  private readonly writer: CalibrationWriter;
  private readonly exporter: LabExport;
  private selected: CalibratedChannel[] = [];
  private selectedSession: string | undefined;
  private session: DeviceSessionSnapshot | undefined;
  private catalog: SourceCatalog | undefined;
  private sourceEpoch = 0;
  private readonly observations = new Map<"catalog" | "session", Observation>();
  private sessionGeneration: number | undefined;
  private sessionRequest: Promise<void> | undefined;
  private sessionAgain = false;
  private globalUi: string | undefined;
  private uiEpoch = 0;
  private uiInstancesRevision = 0;
  private detachResync: (() => void) | undefined;
  private readyStarted = false;
  private commandBusy = false;
  private previewBusy = false;
  private latestReading: { read: ReadSnapshot; at: number; epoch: number } | undefined;
  private libraryEpoch = 0;
  private previewTimer: ReturnType<typeof setTimeout> | undefined;
  private history: Page = { entries: [] };
  private profiles: Page = { entries: [] };
  private livePreview = true;
  private current: { meta: RecordMeta; record: Recording } | undefined;
  private comparison: { meta: RecordMeta; record: Recording } | undefined;
  private error = "";
  private confirmedTerminal: string | undefined;
  // Non-evicting process-lifetime evidence: refresh/paging must not forget an
  // ambiguity. The first host identity plus a sticky flag is enough to refuse
  // duplicates without retaining an unbounded set of conflicting record IDs.
  private readonly models = new Map<
    string,
    { recordId: string; revision: string; ambiguous: boolean }
  >();
  private profileCache = new Map<string, CalibrationProfile>();
  private profileLoad: AbortController | undefined;
  private profileLoading = false;
  private locale: "en" | "zh-TW";
  constructor(private readonly context: PluginContext) {
    this.locale = context.locale;
    // RecordService admits one list per source. Share this bounded queue with
    // every helper, including startup, explicit Refresh and writer preflight.
    let listing: Promise<unknown> = Promise.resolve();
    let queued = 0;
    const storage: PluginContext["storage"] = {
      ...context.storage,
      list: (params, signal) => {
        if (queued >= 8) return Promise.reject(new Error("Library list queue full"));
        queued++;
        const work = listing
          .catch(() => {})
          .then(() => {
            this.abort.signal.throwIfAborted();
            signal?.throwIfAborted();
            return context.storage.list(params, signal);
          });
        listing = work.finally(() => {
          queued--;
        });
        void listing.catch(() => {});
        return work;
      },
    };
    this.library = new LabLibrary(storage);
    this.writer = new CalibrationWriter(storage);
    this.recorder = new LabRecorder({
      devices: context.devices,
      storage,
      onChange: () => this.paint(),
    });
    this.exporter = new LabExport(context.actions, () => this.paint());
  }
  register(): void {
    // Parse the exact shipped declarations; this is build-time JSON, not filesystem access.
    for (const raw of manifest.contributes.commands) {
      const declaration = contextCommandDeclarationSchema.parse(raw);
      this.context.commands.registerContext(declaration.id, declaration.arguments, (c) =>
        this.invoke(declaration.id.slice(PREFIX.length), c),
      );
    }
  }
  ready(): void {
    if (this.readyStarted || this.abort.signal.aborted) return;
    this.readyStarted = true;
    this.detachResync = this.context.ui.onResyncRequired(async (notice) => {
      // Common terminal may be carried by UI or any device stream. Only the
      // public notice/callback affected IDs identify our observation handles.
      this.terminalObservations(notice.event.data.affected);
      ++this.uiEpoch;
      for (const view of [...this.views.values()]) this.retire(view);
      const cleanup = await notice.cleanup;
      if (this.abort.signal.aborted) return;
      if (cleanup.some((r) => !r.ok)) {
        this.fail(new Error("UI resync cleanup failed; reopen the panel"));
        return;
      }
      if (this.globalUi) await this.context.ui.unsubscribe(this.globalUi).catch(() => {});
      this.globalUi = undefined;
      await this.subscribeUi();
    });
    this.background(this.subscribeUi());
    this.background(this.refreshLibrary());
    this.background(this.startObservation({ topic: "catalog" }));
    this.tick();
  }
  private background(work: Promise<unknown>): void {
    void work.catch((e: unknown) => this.fail(e));
  }
  private fail(e: unknown): void {
    if (this.abort.signal.aborted) return;
    this.error = bounded(e instanceof Error ? e.message : String(e));
    this.paint();
  }
  private alive(v: View): boolean {
    return (
      !this.abort.signal.aborted && !v.abort.signal.aborted && this.views.get(key(v.binding)) === v
    );
  }
  private async subscribeUi(): Promise<void> {
    const epoch = ++this.uiEpoch;
    const result = value(
      await this.context.ui.subscribe(
        { topics: ["instances", "environment"] },
        (event) => this.uiEvent(event),
        this.abort.signal,
      ),
    );
    if (this.abort.signal.aborted || epoch !== this.uiEpoch) {
      await this.context.ui.unsubscribe(result.subscriptionId);
      return;
    }
    this.globalUi = result.subscriptionId;
    this.locale = result.snapshot.locale;
    const revision = this.uiInstancesRevision;
    const instances = value(await this.context.ui.instances(this.abort.signal)).instances;
    if (epoch === this.uiEpoch && revision === this.uiInstancesRevision)
      await this.replaceInstances(instances);
  }
  private uiEvent(event: UiEventEnvelopeV2): void {
    if (this.abort.signal.aborted) return;
    if (event.kind === "ui.instances") {
      this.uiInstancesRevision++;
      this.background(this.replaceInstances(event.data.instances));
      return;
    }
    if (event.kind === "ui.environment") {
      this.locale = event.data.locale;
      this.paint();
      return;
    }
    if (!("binding" in event.data)) return;
    const view = this.views.get(key(event.data.binding));
    if (!view) return;
    if (event.kind === "ui.visibility") {
      view.visible = event.data.visible;
      if (!view.visible) {
        view.publisher?.dispose();
        view.publisher = undefined;
        view.published = undefined;
      } else if (view.binding.kind === "panel")
        view.publisher ??= new LabPresentationPublisher(this.context.ui, view.binding);
      this.paint();
    } else if (event.kind === "ui.form") {
      this.background(this.syncSlot(view));
      this.paint();
    } else if (
      event.kind === "ui.revoked" &&
      [
        "closed",
        "generation-retired",
        "resource-replaced",
        "renderer-gone",
        "process-gone",
        "shutdown",
      ].includes(event.data.reason)
    )
      this.retire(view);
    // ui.state/data include our own publications. They must not feed back into writes.
  }
  private async replaceInstances(bindings: UiBinding[]): Promise<void> {
    if (this.abort.signal.aborted) return;
    const ours = bindings.filter(
      (b) => b.contributionId === PREFIX + (b.kind === "panel" ? "panel" : "status"),
    );
    for (const v of this.views.values())
      if (!ours.some((b) => key(b) === key(v.binding))) this.retire(v);
    await Promise.all(
      ours.map(async (binding) => {
        if (this.views.has(key(binding))) return;
        const v: View = {
          binding,
          abort: new AbortController(),
          visible: false,
          dirty: true,
          publisher:
            binding.kind === "panel"
              ? new LabPresentationPublisher(this.context.ui, binding)
              : undefined,
          busy: false,
          last: -Infinity,
          slot: undefined,
          timer: undefined,
          subscription: undefined,
          published: undefined,
        };
        this.views.set(key(binding), v);
        const subscribed = value(
          await this.context.ui.subscribe(
            {
              binding,
              topics:
                binding.kind === "panel"
                  ? ["visibility", "form", "state"]
                  : ["visibility", "state"],
            },
            (e) => this.uiEvent(e),
            v.abort.signal,
          ),
        );
        if (!this.alive(v)) {
          await this.context.ui.unsubscribe(subscribed.subscriptionId);
          return;
        }
        v.subscription = subscribed.subscriptionId;
        const state = value(await this.context.ui.state(binding, v.abort.signal));
        if (!this.alive(v)) return;
        v.visible = state.visible;
        if (binding.kind === "panel") await this.syncSlot(v);
        this.schedule(v);
      }),
    );
  }
  private retire(v: View): void {
    v.abort.abort();
    v.publisher?.dispose();
    clearTimeout(v.timer);
    this.views.delete(key(v.binding));
    if (v.subscription) this.background(this.context.ui.unsubscribe(v.subscription));
  }
  private async state(v: View, signal?: AbortSignal): Promise<UiStateSnapshot> {
    if (!this.alive(v) || signal?.aborted) throw new Error("Panel retired");
    const state = value(await this.context.ui.state(v.binding, signal ?? v.abort.signal));
    if (
      !this.alive(v) ||
      signal?.aborted ||
      !state.visible ||
      key(state.binding) !== key(v.binding)
    )
      throw new Error("Panel unavailable");
    return state;
  }
  private async syncSlot(v: View): Promise<void> {
    if (!this.alive(v) || !v.visible || v.binding.kind !== "panel") return;
    const state = await this.state(v),
      slot = draftSlot(state.form);
    if (v.slot === slot) return;
    const channel = this.selected[slot];
    // Remember before emitting ui.form; never reset a numeric edit to the same slot.
    v.slot = slot;
    if (channel) {
      const r = await this.context.ui.formPatch(
        v.binding,
        state.formRevision,
        calibrationForm(channel.calibration),
        v.abort.signal,
      );
      if (!r.ok) {
        v.slot = undefined;
        throw new Error(r.error.message);
      }
    }
    this.paint();
  }
  private observationAlive(w: Observation): boolean {
    return (
      !this.abort.signal.aborted &&
      !w.control.signal.aborted &&
      this.observations.get(w.params.topic) === w
    );
  }
  private invalidateSource(): void {
    ++this.sourceEpoch;
    this.session = undefined;
    this.catalog = undefined;
    this.latestReading = undefined;
    this.preview.reset();
    this.paint();
  }
  private terminalObservations(affected: readonly string[], carrier?: Observation): void {
    let changed = false;
    for (const w of this.observations.values()) {
      if (!this.observationAlive(w)) continue;
      if (w.work && !w.subscription) {
        for (const id of affected) w.pendingTerminal.add(id);
        if (w.pendingTerminal.size > 32) {
          w.control.abort();
          this.fail(new Error("Observation terminal budget exceeded; refresh explicitly"));
          continue;
        }
      }
      if (w === carrier || (w.subscription && affected.includes(w.subscription.subscriptionId))) {
        if (w.terminal) continue;
        w.terminal = true;
        w.delivery++; // Ignore queued callbacks from the retired stream immediately.
        changed = true;
        this.background(this.observe(w));
      }
    }
    if (changed) this.invalidateSource();
  }
  private async stopObservation(topic: "catalog" | "session"): Promise<void> {
    const w = this.observations.get(topic);
    if (!w) return;
    this.observations.delete(topic);
    w.control.abort();
    await w.work?.catch(() => {});
    if (w.subscription) value(await w.subscription.dispose());
  }
  private async startObservation(params: Observation["params"]): Promise<void> {
    await this.stopObservation(params.topic);
    if (this.abort.signal.aborted) return;
    const w: Observation = {
      params: structuredClone(params),
      control: new AbortController(),
      subscription: undefined,
      work: undefined,
      terminal: false,
      pendingTerminal: new Set(),
      delivery: 0,
      restarts: 0,
      failed: false,
    };
    this.observations.set(params.topic, w);
    await this.observe(w);
  }
  private observe(w: Observation): Promise<void> {
    if (w.work) return w.work;
    const work = Promise.resolve()
      .then(async () => {
        do {
          if (!this.observationAlive(w)) return;
          if (w.subscription) {
            value(await w.subscription.dispose()); // Also closes the SDK's old inbox slot.
            w.subscription = undefined;
          }
          if (!this.observationAlive(w)) return;
          if (w.terminal) {
            if (w.restarts >= 3)
              throw new Error("Observation resync limit reached; refresh explicitly");
            w.restarts++;
            if (w.params.topic === "catalog")
              value(await this.context.devices.list({}, w.control.signal));
            else await this.refreshSession();
          }
          if (!this.observationAlive(w)) return;
          w.terminal = false;
          const delivery = ++w.delivery;
          const sub = value(
            await this.context.devices.subscribe(
              w.params,
              (event) => {
                if (!this.observationAlive(w) || delivery !== w.delivery) return;
                if (event.kind === "events.resyncRequired") {
                  this.terminalObservations(event.data.affected, w);
                  return;
                }
                this.invalidateSource();
                if (this.selectedSession) this.background(this.refreshSession());
              },
              w.control.signal,
            ),
          );
          if (!this.observationAlive(w)) {
            value(await sub.dispose());
            return;
          }
          w.subscription = sub;
          if (w.pendingTerminal.has(sub.subscriptionId)) {
            w.terminal = true;
            w.delivery++;
            this.invalidateSource();
          }
          w.pendingTerminal.clear();
          if (!w.terminal && this.selectedSession) await this.refreshSession();
        } while (w.terminal);
        w.failed = false;
      })
      .catch((error: unknown) => {
        w.failed = true;
        if (this.observationAlive(w)) throw error;
      })
      .finally(() => {
        if (w.work === work) w.work = undefined;
      });
    w.work = work;
    return work;
  }
  private refreshSession(): Promise<void> {
    if (this.sessionRequest) {
      this.sessionAgain = true;
      return this.sessionRequest;
    }
    const request = this.readSession().finally(() => {
      if (this.sessionRequest !== request) return;
      this.sessionRequest = undefined;
      if (this.sessionAgain && !this.abort.signal.aborted) {
        this.sessionAgain = false;
        this.background(this.refreshSession());
      }
    });
    this.sessionRequest = request;
    return request;
  }
  private async readSession(): Promise<void> {
    const id = this.selectedSession,
      epoch = this.sourceEpoch;
    if (!id) return;
    const response = value(
      await this.context.devices.session({ sessionId: id }, this.abort.signal),
    );
    if (this.abort.signal.aborted || epoch !== this.sourceEpoch || id !== this.selectedSession)
      return;
    if (
      response.session.sessionId !== id ||
      response.sources.sessionId !== id ||
      response.sources.sourceRevision !== response.session.sourceRevision ||
      response.session.providerGeneration !== this.sessionGeneration
    )
      throw new Error("Session/source identity mismatch");
    this.session = response.session;
    this.catalog = response.sources;
    this.paint();
  }
  private async selectCurrent(
    signal: AbortSignal,
    beforeCommit: () => Promise<unknown>,
  ): Promise<void> {
    const epoch = this.sourceEpoch;
    const listed = value(await this.context.devices.list({}, signal));
    const session = listed.sessions[0];
    if (!session || session.state !== "connected" || !session.capabilities.includes("telemetry.v1"))
      throw new Error("No connected telemetry session");
    const result = value(
      await this.context.devices.session({ sessionId: session.sessionId }, signal),
    );
    await beforeCommit();
    if (signal.aborted || this.abort.signal.aborted || epoch !== this.sourceEpoch)
      throw new Error("Selection superseded");
    if (
      result.session.sessionId !== session.sessionId ||
      result.sources.sessionId !== session.sessionId ||
      result.session.state !== "connected" ||
      result.session.sourceRevision !== result.sources.sourceRevision
    )
      throw new Error("Current session changed");
    if (
      this.selectedSession !== session.sessionId ||
      this.session?.providerGeneration !== result.session.providerGeneration ||
      this.session?.sourceRevision !== result.session.sourceRevision ||
      this.selected.some((s) => !currentSource(s.source, result.session, result.sources))
    )
      this.selected = [];
    this.sourceEpoch++;
    this.selectedSession = session.sessionId;
    this.sessionGeneration = result.session.providerGeneration;
    this.session = result.session;
    this.catalog = result.sources;
    this.preview.reset();
    await this.startObservation({ topic: "session", sessionId: session.sessionId });
    this.paint();
  }
  private editable(): boolean {
    const r = this.recorder.state;
    return (
      !this.current &&
      (r.phase === "idle" ||
        (r.phase === "submitted" &&
          this.confirmedTerminal === `${r.record?.id}:${r.record?.revision}`) ||
        (r.phase === "error" && !r.record && !r.pendingWrite)) &&
      !this.recorder.state.pendingWrite &&
      this.recorder.state.reservation?.state !== "active"
    );
  }
  private async fresh(
    channel: CalibratedChannel,
    signal: AbortSignal,
  ): Promise<{ raw: number; deadline: number }> {
    await this.refreshSession();
    if (
      !currentSource(channel.source, this.session, this.catalog) ||
      channel.source.origin !== "public"
    )
      throw new Error("Original channel is detached");
    const epoch = this.sourceEpoch;
    const read = value(
      await this.context.devices.read(
        {
          sessionId: channel.source.provenance.sessionId,
          channelIds: [channel.source.channel.channelId],
          freshness: "fresh",
        },
        signal,
      ),
    );
    if (
      signal.aborted ||
      epoch !== this.sourceEpoch ||
      !currentSource(channel.source, this.session, this.catalog)
    )
      throw new Error("Source changed during reading");
    return {
      raw: freshReading(channel.source, read),
      deadline: performance.now() + 2500 - read.ageMs!,
    };
  }
  private tick(): void {
    if (this.abort.signal.aborted) return;
    if (
      !this.previewBusy &&
      this.selected.length &&
      [...this.views.values()].some((v) => v.binding.kind === "panel" && v.visible) &&
      this.selected.every((s) => currentSource(s.source, this.session, this.catalog))
    ) {
      this.previewBusy = true;
      const epoch = this.sourceEpoch,
        selected = immutableSnapshot(this.selected);
      const first = selected[0]!.source;
      if (first.origin === "public")
        this.background(
          (async () => {
            const read = value(
              await this.context.devices.read(
                {
                  sessionId: first.provenance.sessionId,
                  channelIds: selected.map((s) =>
                    s.source.origin === "public" ? s.source.channel.channelId : "",
                  ),
                  freshness: "cached",
                },
                this.abort.signal,
              ),
            );
            if (!this.abort.signal.aborted && epoch === this.sourceEpoch) {
              this.latestReading = { read: immutableSnapshot(read), at: performance.now(), epoch };
              this.preview.accept(
                selected.map((s) => s.source),
                read,
              );
              this.paint();
            }
          })()
            .catch((error: unknown) => {
              if (epoch === this.sourceEpoch) this.latestReading = undefined;
              throw error;
            })
            .finally(() => {
              this.previewBusy = false;
            }),
        );
    }
    this.previewTimer = setTimeout(() => this.tick(), 500);
  }
  private paint(): void {
    if (!this.abort.signal.aborted)
      for (const v of this.views.values()) {
        v.dirty = true;
        this.schedule(v);
      }
  }
  private schedule(v: View): void {
    if (!this.alive(v) || !v.visible || !v.dirty || v.busy || v.timer) return;
    v.timer = setTimeout(
      () => {
        v.timer = undefined;
        v.busy = true;
        v.dirty = false;
        this.background(
          this.publish(v)
            .catch(async (e: unknown) => {
              // Surface failure without retrying the rejected dataset batch.
              this.error = bounded(e instanceof Error ? e.message : String(e));
              if (this.alive(v) && v.visible && v.binding.kind === "panel") {
                try {
                  const current = await this.state(v);
                  await this.context.ui.patch(
                    v.binding,
                    current.revision,
                    { error: this.error, "has-error": true },
                    v.abort.signal,
                  );
                } catch {
                  /* Retired or quota-limited; explicit Refresh can retry. */
                }
              }
            })
            .finally(() => {
              v.last = performance.now();
              v.busy = false;
              this.schedule(v);
            }),
        );
      },
      Math.max(0, 1500 - (performance.now() - v.last)),
    );
  }
  private summary(): string {
    const recording = this.recorder.state;
    return bounded(
      `${this.session?.name ?? "Select current connection / 選取目前連線"} · ${this.selected.length}/4 · ${recording.phase === "submitted" ? (this.confirmedTerminal === `${recording.record?.id}:${recording.record?.revision}` ? "Final record reconciled / 已對帳最終紀錄" : "Submitted to host; durable save not confirmed / 已提交主機，尚未確認保存") : recording.phase}${recording.error ? ` · ${recording.error}` : ""} · profiles: ${this.profileLoading ? "loading" : this.profiles.nextCursor ? "more pages available" : "last page"} · export: ${this.exporter.state.phase}${this.exporter.state.error ? ` · ${this.exporter.state.error}` : ""}`,
    );
  }
  private draftPreview(
    channel: CalibratedChannel | undefined,
    form: Record<string, UiScalar>,
    locale: "en" | "zh-TW",
  ): string {
    const zh = locale === "zh-TW";
    const label = zh
      ? "' 未套用校正預覽（此快照）"
      : "' Unapplied draft preview (at this snapshot)";
    if (!channel) return `${label}: ${zh ? "請選取通道" : "select a channel"}`;
    const sample = this.latestReading;
    let raw: number;
    try {
      if (
        !sample ||
        sample.epoch !== this.sourceEpoch ||
        !currentSource(channel.source, this.session, this.catalog)
      )
        throw new Error("stale");
      raw = freshReading(channel.source, {
        ...sample.read,
        ageMs:
          sample.read.ageMs === null
            ? null
            : sample.read.ageMs + Math.max(0, performance.now() - sample.at),
      });
    } catch {
      return `${label}: ${zh ? "讀值過期或來源無法使用" : "stale or unavailable reading"}`;
    }
    const rawText = `${zh ? "原始" : "raw"}=${raw}`;
    try {
      const draft = calibrationDraft(form);
      const result = calibrate(raw, draft);
      if (result === null) throw new Error("overflow");
      return `${label}: ${rawText}; ${zh ? "結果" : "result"}=${result} ${draft.unit}`;
    } catch {
      return `${label}: ${rawText}; ${zh ? "校正草稿無效" : "invalid calibration draft"}`;
    }
  }
  private async publish(v: View): Promise<void> {
    if (!this.alive(v) || !v.visible) return;
    const state = await this.state(v);
    const fields: Record<string, UiScalar> = {
      summary: this.summary(),
      reservation:
        this.recorder.state.reservation?.state === "active"
          ? this.recorder.state.reservation.reservationId
          : null,
    };
    if (v.binding.kind === "status") {
      value(await this.context.ui.patch(v.binding, state.revision, fields, v.abort.signal));
      return;
    }
    if (this.commandBusy) {
      v.dirty = true;
      return;
    }
    let code = "";
    const channel = this.selected[draftSlot(state.form)];
    try {
      const draft = calibrationDraft(state.form);
      if (channel) {
        const generated = generateEv3CalibrationCode(channel.source, draft, state.locale);
        code = generated.available ? generated.code : `Code unavailable: ${generated.reason}`;
      }
    } catch (e) {
      code = `Invalid draft: ${e instanceof Error ? e.message : String(e)}`;
    }
    const recording =
      this.current?.record ??
      (!this.livePreview && !this.confirmedTerminal
        ? (this.recorder.snapshot ?? undefined)
        : undefined);
    const input: LabChartInput = immutableSnapshot({
      selected: this.selected,
      preview: this.preview.frames,
      ...(recording ? { current: recording } : {}),
      ...(this.comparison ? { comparison: this.comparison.record } : {}),
      ...(!this.current && this.recorder.snapshot ? { activeId: this.recorder.snapshot.id } : {}),
      calibrated: state.form.calibrated === true,
    });
    const history = immutableSnapshot(this.history.entries),
      profiles = immutableSnapshot(
        this.profiles.entries.filter((meta) => {
          const profile = this.profileCache.get(`${meta.id}:${meta.revision}`);
          const candidate = profile && { source: profile.source, calibration: profile.calibration };
          return (
            channel &&
            candidate &&
            (compatible(channel, candidate, false) ||
              compatibleEv3Sources(channel, candidate, false))
          );
        }),
      );
    const available =
      this.catalog && this.session?.state === "connected"
        ? immutableSnapshot(this.catalog)
        : undefined;
    if ((available?.channels.length ?? 0) > 50)
      throw new Error(
        "Channel catalog exceeds the declared 50-row view; no rows were silently dropped",
      );
    const rows = (entries: RecordMeta[]) =>
      entries.map((m) => ({
        key: m.id,
        version: String(m.revision),
        cells: [bounded(m.label, 200)],
      }));
    const generatedCode = code;
    code = `${this.draftPreview(channel, state.form, state.locale)}\n${code}`;
    const chars = Array.from(code),
      codeEntries: string[] = [];
    while (chars.length) codeEntries.push(chars.splice(0, 1024).join(""));
    const datasets: Record<string, DatasetV2> = {
      ...Object.fromEntries(labCharts(input).map((chart, i) => [`chart${i}`, chart])),
      available: {
        header: { kind: "table" },
        entries: (available?.channels ?? [])
          .filter((c) => c.state === "ready")
          .map((c) => ({
            key: c.channelId,
            version: String(available!.sourceRevision),
            cells: [bounded(`${c.name} · ${c.modeName} · ${c.unit}`, 200)],
          })),
      },
      history: { header: { kind: "list" }, entries: rows(history) },
      profiles: { header: { kind: "list" }, entries: rows(profiles) },
      code: { header: { kind: "code" }, entries: codeEntries },
    };
    validateDatasetPanelV2(
      Object.entries(datasets).map(([name, data]) => ({
        declaration: datasetDeclarationV2Schema.parse(
          panel.datasets[name as keyof typeof panel.datasets],
        ),
        ...data,
      })),
    );
    const before = await this.state(v);
    if (before.formRevision !== state.formRevision || this.commandBusy) {
      v.dirty = true;
      return;
    }
    const publisher = v.publisher;
    if (
      !publisher ||
      !(await publisher.publish(datasets, {
        ...fields,
        summary: fields.summary!,
        error: this.error,
        "has-error": !!this.error,
        editable: this.editable(),
        "can-start":
          this.editable() &&
          this.selected.length > 0 &&
          this.selected.every((s) => currentSource(s.source, this.session, this.catalog)),
        "derived-form-revision": state.formRevision,
      }))
    )
      return;
    const after = await this.state(v);
    const metadata = value(await this.context.ui.data.snapshot(v.binding, v.abort.signal));
    if (!this.alive(v) || after.formRevision !== state.formRevision || publisher !== v.publisher) {
      v.dirty = true;
      return;
    }
    const presentation = after.data.presentation;
    if (
      typeof presentation !== "number" ||
      metadata.datasets.some((d) => d.presentation !== presentation)
    )
      return;
    v.published = {
      form: immutableSnapshot(state.form),
      formRevision: state.formRevision,
      presentation,
      input,
      code,
      generatedCode,
      revisions: new Map(metadata.datasets.map((d) => [d.dataset, d.revision])),
      available,
      history,
      profiles,
    };
  }
  private async refreshLibrary(signal = this.abort.signal): Promise<void> {
    const epoch = ++this.libraryEpoch;
    const history = await this.library.list("sensor-lab.recording", undefined, signal);
    const profiles = await this.library.list("sensor-lab.calibration", undefined, signal);
    if (signal.aborted || this.abort.signal.aborted || epoch !== this.libraryEpoch) return;
    this.history = history;
    this.profiles = profiles;
    this.loadProfiles();
    this.paint();
  }
  private rememberModel(meta: RecordMeta, modelId: string): void {
    const identity = JSON.stringify([meta.kind, modelId]);
    const known = this.models.get(identity);
    if (known) {
      if (known.recordId !== meta.id) known.ambiguous = true;
      else known.revision = meta.revision;
      return;
    }
    if (this.models.size >= 256) throw new Error("Library model identity capacity reached");
    this.models.set(identity, { recordId: meta.id, revision: meta.revision, ambiguous: false });
  }
  private assertModel(meta: RecordMeta, modelId: string): void {
    this.rememberModel(meta, modelId);
    if (this.models.get(JSON.stringify([meta.kind, modelId]))!.ambiguous)
      throw new Error("Ambiguous library model identity; selection is blocked");
  }
  private loadProfiles(): void {
    this.profileLoad?.abort();
    this.profileLoad = new AbortController();
    const load = this.profileLoad,
      signal = AbortSignal.any([load.signal, this.abort.signal]);
    const entries = [...this.profiles.entries];
    this.profileCache.clear();
    this.profileLoading = true;
    this.background(
      (async () => {
        for (const meta of entries) {
          const profile = await this.library.read(meta, signal);
          if (signal.aborted || this.profileLoad !== load) return;
          if (!("calibration" in profile)) throw new Error("Invalid profile record");
          this.rememberModel(meta, profile.id);
          this.profileCache.set(`${meta.id}:${meta.revision}`, profile);
        }
      })()
        .catch((error: unknown) => {
          if (!signal.aborted) throw error;
        })
        .finally(() => {
          if (this.profileLoad === load) {
            this.profileLoading = false;
            this.paint();
          }
        }),
    );
  }
  private async reconcileTerminal(signal: AbortSignal): Promise<void> {
    const original = this.recorder.state;
    if (original.phase !== "submitted" || !original.record) return;
    const record = value(
      await this.context.storage.stat({ id: original.record.id }, signal),
    ).record;
    if (
      signal.aborted ||
      this.abort.signal.aborted ||
      this.recorder.state.record?.revision !== original.record.revision
    )
      return;
    if (
      record.id !== original.record.id ||
      record.revision !== original.record.revision ||
      record.sha256 !== original.record.sha256 ||
      record.checkpoint !== "final" ||
      record.interrupted
    )
      throw new Error("Original final recording is not reconciled; use recovery");
    this.confirmedTerminal = `${record.id}:${record.revision}`;
  }
  private async invoke(name: string, c: ContextCommandContext): Promise<CommandValue> {
    const binding = c.context.binding;
    const view = binding && this.views.get(key(binding));
    if (!view || binding?.kind !== "panel" || c.context.origin !== "panel")
      throw new Error("Current panel required");
    if (name !== "cursor" && this.commandBusy) throw new Error("Lab command busy");
    if (name !== "cursor") this.commandBusy = true;
    const signal = AbortSignal.any([c.signal, view.abort.signal, this.abort.signal]);
    try {
      let state = await this.state(view, signal);
      if (!c.context.form || state.formRevision !== c.context.form.revision)
        throw new Error("Form changed; retry explicitly");
      const epoch = this.sourceEpoch;
      const fence = async () => {
        const current = await this.state(view, signal);
        if (current.formRevision !== state.formRevision || epoch !== this.sourceEpoch)
          throw new Error("Input/source changed; retry explicitly");
        return current;
      };
      const patch = async (
        set: Record<string, UiScalar>,
        deadline = Infinity,
        beforeWrite?: () => void,
      ) => {
        await fence();
        beforeWrite?.();
        if (performance.now() > deadline) throw new Error("Captured reading expired");
        const receipt = value(
          await this.context.ui.formPatch(binding, state.formRevision, set, signal),
        );
        state = { ...state, form: receipt.form, formRevision: receipt.formRevision };
        view.slot = draftSlot(receipt.form);
        this.paint();
      };
      const selected = () => {
        const s = this.selected[draftSlot(state.form)];
        if (!s) throw new Error("Select a channel");
        return s;
      };
      const editing = () => {
        if (!this.editable()) throw new Error("Calibration is locked during recording/history");
      };
      const action = () => {
        if (!c.context.actionRef) throw new Error("Original user action required");
        return c.context.actionRef;
      };
      const row = (dataset: "available" | "history" | "profiles") => {
        const p = view.published;
        if (
          !p ||
          p.presentation !== state.data.presentation ||
          p.revisions.get(dataset) !== c.arguments.dataset
        )
          throw new Error("Stale dataset selection");
        return p;
      };
      if (name === "cursor") {
        const p = view.published;
        if (
          !p ||
          p.presentation !== c.arguments.presentation ||
          p.presentation !== state.data.presentation ||
          p.formRevision !== state.formRevision ||
          typeof c.arguments.time !== "number"
        )
          throw new Error("Stale cursor");
        return { output: labCursorReadings(p.input, c.arguments.time), fieldErrors: [] };
      }
      if (name === "select-current") {
        editing();
        await this.selectCurrent(signal, fence);
      } else if (name === "refresh") {
        for (const w of this.observations.values()) {
          if (w.failed || w.control.signal.aborted) await this.startObservation(w.params);
          else if (w.terminal) await this.observe(w);
        }
        await this.refreshSession();
        if (this.writer.pendingWrite) await this.writer.reconcile(signal);
        if (this.exporter.state.phase === "unknown") await this.exporter.reconcile(signal);
        await this.reconcileTerminal(signal);
        await this.refreshLibrary(signal);
      } else if (name === "select-channel") {
        editing();
        const p = row("available");
        const channel = p.available?.channels.find((s) => s.channelId === c.arguments.key);
        if (
          !channel ||
          !this.session ||
          !this.catalog ||
          c.arguments.revision !== String(this.catalog.sourceRevision) ||
          p.available?.sessionId !== this.session.sessionId
        )
          throw new Error("Channel row changed");
        const source = snapshotPublicSource(channel, {
          providerId: this.session.providerId,
          sessionId: this.session.sessionId,
          sourceRevision: this.catalog.sourceRevision,
        });
        if (!currentSource(source, this.session, this.catalog))
          throw new Error("Channel unavailable");
        let slot = this.selected.findIndex(
          (s) => s.source.origin === "public" && s.source.channel.channelId === channel.channelId,
        );
        if (slot < 0) {
          if (this.selected.length >= 4) throw new Error("At most four selected channels");
          slot = this.selected.length;
        }
        const previous = this.selected[slot];
        // Only the explicit row action may replace a detached pin. A changed
        // source starts with identity calibration, as a newly selected channel
        // does; active recorder snapshots remain separately immutable.
        const chosen =
          previous && currentSource(previous.source, this.session, this.catalog)
            ? previous
            : { source, calibration: identityCalibration(channel.unit) };
        await patch({ slot: String(slot), ...calibrationForm(chosen.calibration) });
        this.selected = [
          ...this.selected.slice(0, slot),
          immutableSnapshot(chosen),
          ...this.selected.slice(slot + 1),
        ];
        this.sourceEpoch++;
        this.preview.reset();
      } else if (["capture-a", "capture-b", "zero"].includes(name)) {
        editing();
        const channel = selected();
        const reading = await this.fresh(channel, signal);
        await patch(
          name === "zero"
            ? { "zero-offset": draftZero(state.form, reading.raw) }
            : { [name === "capture-a" ? "source-a" : "source-b"]: String(reading.raw) },
          reading.deadline,
        );
      } else if (name === "clear-zero") {
        editing();
        await patch({ "zero-offset": "0" });
      } else if (name === "apply" || name === "reset") {
        editing();
        const channel = selected();
        const calibration =
          name === "reset"
            ? identityCalibration(channel.source.channel.unit)
            : calibrationDraft(state.form);
        if (name === "reset") await patch(calibrationForm(calibration));
        else await fence();
        this.selected = this.selected.map((s) =>
          s === channel ? immutableSnapshot({ ...s, calibration }) : s,
        );
      } else if (name === "remove-channel") {
        editing();
        const channel = selected(),
          remaining = this.selected.filter((s) => s !== channel);
        await patch({
          slot: "0",
          ...calibrationForm(remaining[0]?.calibration ?? identityCalibration("")),
        });
        this.selected = remaining;
        this.sourceEpoch++;
        this.preview.reset();
      } else if (name === "start") {
        editing();
        await this.refreshSession();
        await fence();
        if (
          !this.selectedSession ||
          !this.selected.length ||
          !this.selected.every((s) => currentSource(s.source, this.session, this.catalog))
        )
          throw new Error("Original selected channels must be ready");
        const name = state.form["recording-name"];
        if (typeof name !== "string" || !name.trim() || name.length > 100)
          throw new Error("Recording name must contain 1–100 characters");
        this.confirmedTerminal = undefined;
        this.livePreview = false;
        await this.recorder.start({
          name,
          sessionId: this.selectedSession,
          channels: immutableSnapshot(this.selected),
        });
      } else if (name === "live") {
        this.livePreview = true;
        this.current = undefined;
        this.comparison = undefined;
      } else if (name === "clear-comparison") this.comparison = undefined;
      else if (name === "save-profile") {
        editing();
        const channel = selected();
        const calibration = calibrationDraft(state.form);
        const name = state.form["profile-name"];
        if (typeof name !== "string" || !name.trim() || name.length > 128)
          throw new Error("Profile name required");
        await fence();
        await this.writer.save(
          { schemaVersion: 2, id: randomUUID(), name, source: channel.source, calibration },
          signal,
        );
        await this.refreshLibrary(signal);
      } else if (name === "history-next" || name === "profiles-next") {
        const page = name === "history-next" ? this.history : this.profiles;
        if (!page.nextCursor) throw new Error("No next page");
        const kind: LabRecordKind =
          name === "history-next" ? "sensor-lab.recording" : "sensor-lab.calibration";
        const epoch = ++this.libraryEpoch;
        const next = await this.library.list(kind, page.nextCursor, signal);
        await fence();
        if (epoch !== this.libraryEpoch) throw new Error("Library page superseded");
        if (name === "history-next") this.history = next;
        else {
          this.profiles = next;
          this.loadProfiles();
        }
      } else if (
        [
          "view-record",
          "compare-record",
          "apply-profile",
          "delete-history",
          "delete-profiles",
        ].includes(name)
      ) {
        const dataset =
          name.endsWith("profiles") || name === "apply-profile" ? "profiles" : "history";
        const meta = row(dataset)[dataset].find(
          (m) => m.id === c.arguments.key && String(m.revision) === c.arguments.revision,
        );
        if (!meta) throw new Error("Stale library row");
        if (name.startsWith("delete")) {
          const protectedIds = new Set(
            [
              this.current?.meta.id,
              this.comparison?.meta.id,
              this.recorder.state.record?.id,
            ].filter((id): id is string => !!id),
          );
          await fence();
          await this.library.remove(meta, protectedIds, signal);
          await this.refreshLibrary(signal);
        } else {
          if (name === "apply-profile") editing();
          const loaded = await this.library.read(meta, signal);
          await fence();
          this.assertModel(meta, loaded.id);
          if (name === "apply-profile") {
            if (!("calibration" in loaded)) throw new Error("Not a calibration profile");
            const channel = selected(),
              target = { source: loaded.source, calibration: loaded.calibration };
            if (
              !compatible(channel, target, false) &&
              !compatibleEv3Sources(channel, target, false)
            )
              throw new Error("Incompatible calibration profile");
            await patch(calibrationForm(loaded.calibration), Infinity, () =>
              this.assertModel(meta, loaded.id),
            );
            this.assertModel(meta, loaded.id);
            this.selected = this.selected.map((s) =>
              s === channel ? immutableSnapshot({ ...s, calibration: loaded.calibration }) : s,
            );
          } else {
            if (!("frames" in loaded)) throw new Error("Not a recording");
            if (name === "compare-record") {
              if (!this.current) throw new Error("Select a saved recording before comparison");
              this.comparison = { meta, record: loaded };
            } else {
              this.current = { meta, record: loaded };
              this.comparison = undefined;
            }
          }
        }
      } else if (name === "copy-code") {
        const p = view.published,
          channel = selected();
        const code = generateEv3CalibrationCode(
          channel.source,
          calibrationDraft(state.form),
          state.locale,
        );
        if (
          !p ||
          !sameForm(p.form, state.form) ||
          p.presentation !== state.data.presentation ||
          !code.available ||
          p.generatedCode !== code.code
        )
          throw new Error("Wait for the current draft code");
        await fence();
        await copyCalibrationCode(this.context.actions, action(), p.code, signal);
      } else if (name === "export") {
        if (this.current) this.assertModel(this.current.meta, this.current.record.id);
        const record = this.current?.record ?? this.recorder.snapshot;
        if (!record) throw new Error("Select a recording to export");
        const from = state.form["csv-start"],
          to = state.form["csv-end"];
        let interval: { startMs: number; endMs: number } | undefined;
        if (from !== "" || to !== "") {
          if (typeof from !== "string" || !from.trim() || typeof to !== "string" || !to.trim())
            throw new Error("Specify both interval endpoints in milliseconds");
          interval = { startMs: Number(from), endMs: Number(to) };
        }
        const prepared = prepareCsv(record, interval);
        await fence();
        await this.exporter.start(action(), prepared, signal);
      } else throw new Error(`Unimplemented Lab command: ${name}`);
      this.error = "";
      this.paint();
      return answer();
    } catch (error) {
      // Cursor replies are ephemeral; expected stale rejection must not replace
      // the global feature diagnostic or trigger another presentation.
      if (name !== "cursor") this.fail(error);
      throw error;
    } finally {
      if (name !== "cursor") {
        this.commandBusy = false;
        this.paint();
      }
    }
  }
  async drain(context: PersistenceDrainContext) {
    const result = await this.recorder.drain(context);
    this.paint();
    return result;
  }
  dispose(): void {
    this.abort.abort();
    this.profileLoad?.abort();
    for (const topic of [...this.observations.keys()])
      void this.stopObservation(topic).catch(() => {});
    this.detachResync?.();
    clearTimeout(this.previewTimer);
    for (const v of [...this.views.values()]) this.retire(v);
    if (this.globalUi) void this.context.ui.unsubscribe(this.globalUi).catch(() => {});
    this.exporter.dispose();
    this.recorder.dispose();
  }
}
export function createLabPlugin(): PluginDefinition {
  let feature: LabController | undefined;
  return {
    activate(context) {
      feature = new LabController(context);
      feature.register();
    },
    ready() {
      feature?.ready();
    },
    drain(context) {
      if (!feature) throw new Error("Lab is not active");
      return feature.drain(context);
    },
    deactivate() {
      feature?.dispose();
      feature = undefined;
    },
  };
}
