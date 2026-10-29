import type {
  PluginContext,
  PluginDefinition,
  ContextCommandContext,
  DeviceSubscription,
} from "@kobrixa/plugin-sdk";
import {
  addressSchema,
  canonicalIp,
  contextCommandDeclarationSchema,
  type UiBinding,
  type UiEventEnvelopeV2,
  type UiScalar,
  type DeviceCandidate,
  type DeviceSessionSnapshot,
  type SourceCatalog,
  type ReadSnapshot,
  type ConnectionRecoverySnapshot,
  type SettingsSnapshot,
  type DeviceSubscriptionParamsV180,
  type DeviceEventV180,
  type DatasetRowV2,
} from "@kobrixa/plugin-protocol";
import manifest from "../kobrixa-plugin.json";
import { bounded, fresh, readings, recoveryText, publish, value } from "./presentation.js";
const PREFIX = "kobrixa.device-ev3.",
  PROVIDER = "kobrixa.device-ev3";
const key = (b: UiBinding) =>
  JSON.stringify([
    b.contributionId,
    b.panelInstance,
    b.kind,
    b.generation,
    b.uiResourceGeneration,
    b.hostEpoch,
    b.processEpoch,
  ]);
const answer = () => ({ output: {}, fieldErrors: [] });
type Authority = Extract<
  Awaited<ReturnType<PluginContext["devices"]["context"]>>,
  { ok: true }
>["value"];
type View = {
  binding: UiBinding & { kind: "panel" };
  life: AbortController;
  work: AbortController;
  visible: boolean;
  ui?: string;
  form: Record<string, UiScalar>;
  candidates: DeviceCandidate[];
  discovery: number;
  discoveredAt: number;
  phase: string;
  modes: DatasetRowV2[];
  modeIdentity: string;
  revisions: Map<string, number>;
  busy: boolean;
  last: number;
  dirty: boolean;
  initialized: boolean;
  formRevision: number;
  visibilityEvents: number;
  initialTransportPatch?: { revision: number; value: UiScalar };
  transportIntent?: { revision: number; value: "usb" | "wifi" };
  transportWrite?: Promise<void>;
  preferenceError: string;
};
/** Public process controller. Host retains connection, authority and recovery ownership. */
export class DeviceController {
  private readonly life = new AbortController();
  private readonly views = new Map<string, View>();
  private observing: AbortController | undefined;
  private subscriptions = new Map<string, DeviceSubscription>();
  private preferenceTail: Promise<void> = Promise.resolve();
  private authoritySubscription: DeviceSubscription | undefined;
  private readonly cleanup = new Set<Promise<unknown>>();
  private settingsWatch: string | undefined;
  private globalUi: string | undefined;
  private session: DeviceSessionSnapshot | undefined;
  private sources: SourceCatalog | undefined;
  private read: ReadSnapshot | undefined;
  private received = 0;
  private recovery: ConnectionRecoverySnapshot | undefined;
  private settings: SettingsSnapshot | undefined;
  private error = "";
  private authority = "Unknown / 未知";
  private authorityRevision = -1;
  private authorityEpoch = 0;
  private sessionKey = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private uiRevision = 0;
  private catalogRevision = -1;
  private refreshNeeded = true;
  private commandBusy = false;
  private detach: (() => void) | undefined;
  constructor(
    private readonly ctx: PluginContext,
    private readonly now = () => performance.now(),
  ) {}
  register(): void {
    for (const raw of manifest.contributes.commands) {
      const d = contextCommandDeclarationSchema.parse(raw);
      this.ctx.commands.registerContext(d.id, d.arguments, (c) =>
        this.command(d.id.slice(PREFIX.length), c),
      );
    }
  }
  async ready(): Promise<void> {
    this.detach = this.ctx.ui.onResyncRequired(() => {
      this.stopObservation();
      for (const v of this.views.values()) {
        v.work.abort();
        v.visible = false;
      }
      this.error = "UI observation ended; reopen panel / 請重新開啟面板";
    });
    const s = value(
      await this.ctx.ui.subscribe(
        { topics: ["instances"] },
        (e) => this.uiEvent(e),
        this.life.signal,
      ),
    );
    if (this.life.signal.aborted) {
      await this.ctx.ui.unsubscribe(s.subscriptionId);
      return;
    }
    this.globalUi = s.subscriptionId;
    const rev = this.uiRevision;
    const list = value(await this.ctx.ui.instances(this.life.signal));
    if (rev === this.uiRevision) await this.instances(list.instances);
    this.tick();
  }
  private background(p: Promise<unknown>): void {
    this.cleanup.add(p);
    void p.finally(() => this.cleanup.delete(p)).catch(() => {});
    void p.catch((e) => {
      if (!this.life.signal.aborted) {
        this.error = bounded(String(e));
        this.dirty();
      }
    });
  }
  private alive(v: View): boolean {
    return (
      !this.life.signal.aborted &&
      !v.life.signal.aborted &&
      v.visible &&
      !v.work.signal.aborted &&
      this.views.get(key(v.binding)) === v
    );
  }
  private dirty(): void {
    for (const v of this.views.values()) v.dirty = true;
  }
  private uiEvent(e: UiEventEnvelopeV2): void {
    if (this.life.signal.aborted) return;
    if (e.kind === "ui.instances") {
      this.uiRevision++;
      this.background(this.instances(e.data.instances));
      return;
    }
    if (!("binding" in e.data)) return;
    const v = this.views.get(key(e.data.binding));
    if (!v) return;
    if (e.kind === "ui.revoked") {
      this.retire(v);
      return;
    }
    if (e.kind === "ui.visibility") {
      v.visibilityEvents++;
      this.visibility(v, e.data.visible);
      return;
    }
    if (e.kind === "ui.form") {
      const initial = v.initialTransportPatch;
      const initialized =
        initial?.revision === e.data.revision && initial.value === e.data.values.transport;
      if (initialized) delete v.initialTransportPatch;
      if (e.data.revision <= v.formRevision) return;
      const previous = v.form.transport;
      v.formRevision = e.data.revision;
      v.form = { ...e.data.values };
      if (
        !initialized &&
        previous !== v.form.transport &&
        (v.form.transport === "usb" || v.form.transport === "wifi")
      ) {
        v.transportIntent = { revision: v.formRevision, value: v.form.transport };
        this.background(this.saveTransport(v));
      }
      v.discovery++;
      v.candidates = [];
      v.modes = [];
      v.phase = "Discover explicitly / 請主動搜尋";
      v.dirty = true;
    }
  }
  private async instances(bindings: UiBinding[]): Promise<void> {
    const ours = bindings.filter(
      (b) => b.contributionId === PREFIX + "panel" && b.kind === "panel",
    );
    for (const v of this.views.values())
      if (!ours.some((b) => key(b) === key(v.binding))) this.retire(v);
    for (const b of ours) {
      if (this.life.signal.aborted) return;
      if (this.views.has(key(b))) continue;
      const v: View = {
        binding: { ...b, kind: "panel" },
        life: new AbortController(),
        work: new AbortController(),
        visible: false,
        form: {},
        candidates: [],
        discovery: 0,
        discoveredAt: 0,
        phase: "Discover explicitly / 請主動搜尋",
        modes: [],
        modeIdentity: "",
        revisions: new Map(),
        busy: false,
        last: -Infinity,
        dirty: true,
        initialized: false,
        formRevision: -1,
        visibilityEvents: 0,
        preferenceError: "",
      };
      this.views.set(key(b), v);
      const s = value(
        await this.ctx.ui.subscribe(
          { binding: b, topics: ["visibility", "form", "state"] },
          (e) => this.uiEvent(e),
          v.life.signal,
        ),
      );
      if (v.life.signal.aborted) {
        await this.ctx.ui.unsubscribe(s.subscriptionId);
        continue;
      }
      v.ui = s.subscriptionId;
      const visibilityEvents = v.visibilityEvents;
      const state = value(await this.ctx.ui.state(b, v.life.signal));
      if (v.life.signal.aborted) continue;
      if (state.formRevision >= v.formRevision) {
        v.form = state.form;
        v.formRevision = state.formRevision;
      }
      if (visibilityEvents === v.visibilityEvents) this.visibility(v, state.visible);
    }
  }
  private visibility(v: View, visible: boolean): void {
    v.work.abort();
    v.work = new AbortController();
    v.visible = visible;
    v.candidates = [];
    v.modes = [];
    v.revisions.clear();
    v.discovery++;
    v.dirty = true;
    if (!visible) v.work.abort();
    if (![...this.views.values()].some((x) => x.visible)) {
      this.stopObservation();
      return;
    }
    if (!this.observing) this.background(this.startObservation());
    else if (visible) this.background(this.saveTransport(v));
  }
  private retire(v: View): void {
    v.life.abort();
    v.work.abort();
    this.views.delete(key(v.binding));
    if (v.ui) this.background(this.ctx.ui.unsubscribe(v.ui));
    if (![...this.views.values()].some((x) => x.visible)) this.stopObservation();
  }
  private stopObservation(): void {
    this.observing?.abort();
    this.observing = undefined;
    const subs = [...this.subscriptions.values()];
    this.subscriptions.clear();
    for (const s of subs) this.background(s.dispose());
    if (this.settingsWatch) {
      const id = this.settingsWatch;
      this.settingsWatch = undefined;
      this.background(this.ctx.settings.unwatch({ subscriptionId: id }));
    }
    if (this.authoritySubscription) {
      this.background(this.authoritySubscription.dispose());
      this.authoritySubscription = undefined;
    }
    this.session = undefined;
    this.sources = undefined;
    this.read = undefined;
    this.recovery = undefined;
    this.settings = undefined;
    this.sessionKey = "";
    this.catalogRevision = -1;
    this.authority = "Unknown / 未知";
    this.authorityRevision = -1;
    this.authorityEpoch++;
  }
  private async observe(
    params: DeviceSubscriptionParamsV180,
    owner: AbortController,
  ): Promise<void> {
    const s = value(
      await this.ctx.devices.subscribe(
        params,
        (e) => {
          if (this.observing !== owner || owner.signal.aborted) return;
          this.deviceEvent(e);
        },
        owner.signal,
      ),
    );
    if (this.observing !== owner || owner.signal.aborted) {
      await s.dispose();
      return;
    }
    this.subscriptions.set(params.topic, s);
  }
  private deviceEvent(e: DeviceEventV180): void {
    if (e.kind === "events.resyncRequired") {
      this.stopObservation();
      this.error = "Observation ended. Refresh explicitly / 觀察已結束，請重新整理";
      this.dirty();
      return;
    }
    if (e.kind === "devices.connectionRecovery") {
      this.acceptRecovery(e.data);
      return;
    }
    if (e.kind === "devices.catalog") {
      if (e.data.revision <= this.catalogRevision) return;
      this.catalogRevision = e.data.revision;
      this.read = undefined;
      this.refreshNeeded = true;
    }
    if (
      e.kind === "devices.session" &&
      e.data.session.sessionId === this.session?.sessionId &&
      e.data.session.revision > this.session.revision
    ) {
      this.session = e.data.session;
      this.read = undefined;
      this.refreshNeeded = true;
    }
    if (e.kind === "devices.telemetry" && e.data.sessionId === this.session?.sessionId)
      this.acceptRead(e.data.snapshot);
    this.dirty();
  }
  private acceptRead(read: ReadSnapshot, received = this.now()): void {
    if (
      read.sessionId !== this.session?.sessionId ||
      read.frame?.sourceRevision !== this.sources?.sourceRevision
    )
      return;
    if (this.read && read.revision < this.read.revision) return;
    if (this.read?.frame && read.frame && read.frame.sequence < this.read.frame.sequence) return;
    this.read = read;
    this.received = received;
  }
  private acceptRecovery(r: ConnectionRecoverySnapshot): void {
    if (
      this.recovery &&
      r.hostEpoch === this.recovery.hostEpoch &&
      r.revision <= this.recovery.revision
    )
      return;
    this.recovery = r;
    this.dirty();
  }
  private async startObservation(): Promise<void> {
    if (this.observing || this.life.signal.aborted) return;
    const owner = new AbortController();
    this.observing = owner;
    this.refreshNeeded = true;
    this.error = "";
    try {
      await this.observe({ topic: "catalog" }, owner);
      await this.observe({ topic: "connectionRecovery" }, owner);
      const r = value(await this.ctx.devices.connectionRecovery.read({}, owner.signal));
      if (this.observing !== owner) return;
      this.acceptRecovery(r);
      const s = value(
        await this.ctx.settings.watch({ schemaVersion: 1 }, owner.signal, () => {
          if (this.observing === owner) this.background(this.readSettings(owner));
        }),
      );
      if (this.observing !== owner) {
        await this.ctx.settings.unwatch({ subscriptionId: s.subscriptionId });
        return;
      }
      this.settingsWatch = s.subscriptionId;
      await this.readSettings(owner);
      if (this.observing !== owner) return;
      for (const v of this.views.values()) this.background(this.saveTransport(v));
    } catch (e) {
      if (this.observing === owner) {
        this.stopObservation();
        this.error = bounded(String(e));
        this.dirty();
      }
    }
  }
  private async readSettings(owner: AbortController): Promise<void> {
    // Read the committed public snapshot; failures never substitute policy defaults.
    try {
      const s = value(await this.ctx.settings.read({ schemaVersion: 1 }, owner.signal));
      if (this.observing !== owner) return;
      this.settings = s;
      for (const v of this.views.values()) {
        if (!this.alive(v) || v.initialized) continue;
        v.initialized = true;
        const state = value(await this.ctx.ui.state(v.binding, v.work.signal));
        if (!this.alive(v)) continue;
        if (state.formRevision !== 0 || v.transportIntent) continue;
        const values = Object.fromEntries(s.values.map((x) => [x.key, x.value]));
        const set: Record<string, UiScalar> = {
          transport: values.connectionMode === "wifi" ? "wifi" : "usb",
          "wifi-address":
            values.rememberWifiAddress === true && typeof values.lastWifiAddress === "string"
              ? values.lastWifiAddress
              : "",
        };
        v.initialTransportPatch = { revision: state.formRevision + 1, value: set.transport! };
        const patched = value(
          await this.ctx.ui.formPatch(v.binding, state.formRevision, set, v.work.signal),
        );
        if (this.alive(v) && v.formRevision <= patched.formRevision) {
          v.form = { ...v.form, ...set };
          v.formRevision = patched.formRevision;
        }
      }
      this.dirty();
    } catch (e) {
      if (this.observing === owner) {
        this.settings = undefined;
        this.error = bounded(String(e));
        this.dirty();
      }
    }
  }
  private preferences(work: () => Promise<void>): Promise<void> {
    const next = this.preferenceTail.then(work, work);
    this.preferenceTail = next.catch(() => {});
    return next;
  }
  private saveTransport(v: View): Promise<void> {
    if (v.transportWrite) return v.transportWrite;
    const owner = this.observing,
      work = v.work;
    const current = () =>
      this.alive(v) &&
      v.work === work &&
      this.observing === owner &&
      !!owner &&
      !owner.signal.aborted;
    if (!v.transportIntent || !this.settings || !current()) return Promise.resolve();
    const signal = AbortSignal.any([work.signal, owner!.signal]);
    let attempted = v.transportIntent;
    const pending = this.preferences(async () => {
      while (current() && v.transportIntent) {
        const intent = v.transportIntent;
        attempted = intent;
        try {
          const prefs = value(await this.ctx.settings.read({ schemaVersion: 1 }, signal));
          if (!current()) return;
          if (v.transportIntent !== intent) continue;
          if (prefs.values.find((x) => x.key === "connectionMode")?.value !== intent.value) {
            const saved = value(
              await this.ctx.settings.update(
                {
                  schemaVersion: 1,
                  expectedRevision: prefs.revision,
                  changes: [{ key: "connectionMode", value: intent.value }],
                },
                signal,
              ),
            );
            if (!current()) return;
            this.settings = saved.snapshot;
          }
          if (v.transportIntent === intent) delete v.transportIntent;
          v.preferenceError = "";
        } catch (e) {
          if (!current()) return;
          v.preferenceError = bounded(`Connection preference was not saved: ${String(e)}`);
          if (v.transportIntent === intent) return; // retain for explicit Refresh
        }
      }
    }).finally(() => {
      delete v.transportWrite;
      this.dirty();
      if (current() && v.transportIntent && v.transportIntent !== attempted)
        this.background(this.saveTransport(v));
    });
    v.transportWrite = pending;
    return pending;
  }
  private tick(): void {
    if (this.life.signal.aborted) return;
    if (this.running) return;
    this.running = true;
    this.background(
      (async () => {
        try {
          const owner = this.observing;
          if (owner)
            try {
              await this.refresh(owner);
            } catch (e) {
              if (this.observing === owner) {
                this.read = undefined;
                this.error = bounded(String(e));
              }
            }
          for (const v of this.views.values())
            if (this.alive(v) && this.now() - v.last >= 1000) await this.paint(v);
        } finally {
          this.running = false;
          if (!this.life.signal.aborted) this.timer = setTimeout(() => this.tick(), 1000);
        }
      })(),
    );
  }
  private async refresh(owner: AbortController): Promise<void> {
    const signal = owner.signal;
    const list = value(await this.ctx.devices.list({}, signal));
    if (this.observing !== owner) return;
    if (list.revision < this.catalogRevision) return;
    this.catalogRevision = list.revision;
    const selected = list.sessions.find(
      (s) => s.providerId === PROVIDER && s.state === "connected",
    );
    const identity = selected ? `${selected.sessionId}:${selected.sourceRevision}` : "";
    if (identity !== this.sessionKey) {
      this.authority = "Unknown / 未知";
      this.read = undefined;
      this.sources = undefined;
      for (const v of this.views.values()) v.modes = [];
      // Shared observers may finish adoption after a session observer. Never
      // derive their lifetime from asynchronous completion order.
      for (const topic of ["session", "telemetry"]) {
        const old = this.subscriptions.get(topic);
        this.subscriptions.delete(topic);
        if (old) await old.dispose();
      }
      if (this.observing !== owner) return;
      this.sessionKey = identity;
      this.refreshNeeded = true;
      this.session = selected;
      if (selected) await this.observe({ topic: "session", sessionId: selected.sessionId }, owner);
    }
    if (this.observing !== owner) return;
    this.session = selected;
    if (!selected) return;
    if (this.refreshNeeded) {
      this.refreshNeeded = false;
      const current = value(
        await this.ctx.devices.session({ sessionId: selected.sessionId }, signal),
      );
      if (this.observing !== owner || this.sessionKey !== identity) return;
      this.session = current.session;
      this.sources = current.sources;
      if (current.sources.channels.length && !this.subscriptions.has("telemetry"))
        await this.observe(
          {
            topic: "telemetry",
            sessionId: selected.sessionId,
            channelIds: current.sources.channels.map((c) => c.channelId),
            intervalMs: 500,
          },
          owner,
        );
    }
    if (this.sources?.channels.length) {
      const started = this.now();
      const read = value(
        await this.ctx.devices.read(
          {
            sessionId: selected.sessionId,
            channelIds: this.sources.channels.map((c) => c.channelId),
            freshness: "cached",
          },
          signal,
        ),
      );
      if (this.observing === owner && this.sessionKey === identity) this.acceptRead(read, started);
    }
  }
  private async paint(v: View): Promise<void> {
    const work = v.work;
    v.last = this.now();
    const discovery = v.discovery;
    const modes = v.modes;
    const modeIdentity = v.modeIdentity;
    const candidates = v.candidates
      .filter(
        (c) => c.transport === v.form.transport && this.now() - v.discoveredAt < c.expiresInMs,
      )
      .map((c) => ({
        key: c.candidateId,
        version: String(discovery),
        cells: [c.name, c.transport, c.address ?? ""],
      }));
    const projected =
      this.session?.foreground !== "none" && this.read
        ? { ...this.read, status: "busy" as const }
        : this.read;
    const rows = readings(this.sources, projected, this.received, this.now());
    const can = fresh(this.session, this.sources, this.read, this.received, this.now());
    const r = this.recovery?.recovery;
    try {
      const revisions = await publish(
        this.ctx.ui,
        v.binding,
        { candidates, modes, readings: rows },
        {
          connection: this.session
            ? `${this.session.name} · ${this.session.state}`
            : "No connection / 無連線",
          "session-id": this.session?.sessionId ?? null,
          discovery: v.phase,
          recovery: recoveryText(this.recovery),
          "recovery-id": r?.recoveryId ?? null,
          monitor: `${can ? "Live" : "Waiting / stale / unavailable"} · program: ${can ? (this.read?.frame?.program ?? "unknown") : "unknown"}`,
          authority: this.authority,
          preferences: this.settings
            ? "Preferences: host settings form / 偏好設定：主機設定表單"
            : "Preferences unavailable / 偏好設定無法讀取",
          error: this.error || v.preferenceError,
          "can-mode":
            can &&
            this.authority === "Allowed / 允許" &&
            v.modeIdentity === `${this.sessionKey}:${v.form.port}`,
        },
        work.signal,
      );
      if (
        this.alive(v) &&
        v.work === work &&
        v.discovery === discovery &&
        v.modeIdentity === modeIdentity
      )
        v.revisions = revisions;
    } catch (e) {
      if (this.alive(v) && v.work === work) this.error = bounded(String(e));
    }
  }
  private acceptAuthority(authority: Authority): void {
    if (authority.revision < this.authorityRevision) return;
    this.authorityRevision = authority.revision;
    this.authority =
      (authority.state === "local" && authority.reason === "local") ||
      (authority.state === "allowed" && authority.reason === "holder")
        ? "Allowed / 允許"
        : "Read only / 唯讀";
  }
  private async command(name: string, c: ContextCommandContext) {
    const b = c.context.binding;
    const v = b ? this.views.get(key(b)) : undefined;
    // Terminal UI subscriptions cannot deliver a later visibility event. A real,
    // explicit Refresh can re-read the original host binding and replace them.
    if (
      name === "refresh" &&
      v &&
      !this.alive(v) &&
      !this.life.signal.aborted &&
      !c.signal.aborted &&
      c.context.origin === "panel" &&
      !this.commandBusy
    ) {
      this.commandBusy = true;
      try {
        const state = value(await this.ctx.ui.state(v.binding, c.signal));
        if (!state.visible || c.signal.aborted) return answer();
        for (const existing of [...this.views.values()]) this.retire(existing);
        if (this.globalUi) await this.ctx.ui.unsubscribe(this.globalUi);
        clearTimeout(this.timer);
        await this.ready();
      } catch (e) {
        this.error = bounded(String(e));
      } finally {
        this.commandBusy = false;
      }
      return answer();
    }
    if (
      !v ||
      !this.alive(v) ||
      c.context.origin !== "panel" ||
      c.context.trigger.kind !== "activate" ||
      c.signal.aborted ||
      this.commandBusy
    )
      return answer();
    const work = v.work;
    const signal = AbortSignal.any([work.signal, c.signal]);
    const current = () => this.alive(v) && v.work === work && !signal.aborted;
    this.commandBusy = true;
    let connected = false;
    try {
      if (name === "refresh") {
        this.stopObservation();
        await this.startObservation();
        return answer();
      }
      if (!this.observing || !this.settings)
        throw new Error("Observations/settings unavailable. Refresh explicitly.");
      const state = value(await this.ctx.ui.state(v.binding, signal));
      if (!current() || !state.visible) return answer();
      if (!c.context.form || state.formRevision !== c.context.form.revision)
        throw new Error("Form changed. Retry.");
      v.form = state.form;
      if (name === "discover") {
        v.phase = "Searching / 搜尋中";
        v.candidates = [];
        const discovery = ++v.discovery;
        v.revisions.delete("candidates");
        const result = value(await this.ctx.devices.discover({ providerId: PROVIDER }, signal));
        if (!current() || v.discovery !== discovery) return answer();
        v.candidates = result.candidates;
        v.discoveredAt = this.now();
        v.phase = result.candidates.some((x) => x.transport === v.form.transport)
          ? "Choose a device / 選擇裝置"
          : "No devices / 無裝置";
      } else if (name === "connect" || name === "candidate") {
        let target: Parameters<PluginContext["devices"]["connect"]>[0]["target"];
        let address: string | undefined;
        if (name === "connect") {
          if (v.form.transport !== "wifi") throw new Error("Select Wi-Fi");
          address = addressSchema.parse(String(v.form["wifi-address"] ?? "").trim());
          if (!canonicalIp(address)) throw new Error("Enter a canonical IP address");
          target = { kind: "wifi-address", providerId: PROVIDER, address };
        } else {
          if (
            c.arguments.dataset !== v.revisions.get("candidates") ||
            c.arguments.version !== String(v.discovery)
          )
            throw new Error("Stale candidate. Discover again.");
          const candidate = v.candidates.find(
            (x) => x.candidateId === c.arguments.key && x.transport === v.form.transport,
          );
          if (!candidate || this.now() - v.discoveredAt >= candidate.expiresInMs)
            throw new Error("Candidate expired. Discover again.");
          target = { kind: "candidate", candidateId: candidate.candidateId };
          address = candidate.transport === "wifi" ? candidate.address : undefined;
        }
        await this.saveTransport(v);
        if (!current()) return answer();
        v.phase = "Connecting / 連線中";
        value(await this.ctx.devices.connect({ target }, signal));
        connected = true;
        if (!current()) return answer();
        v.candidates = [];
        v.discovery++;
        v.phase = "Connected / 已連線";
        this.refreshNeeded = true;
        if (address)
          await this.preferences(async () => {
            if (!current()) return;
            const prefs = value(await this.ctx.settings.read({ schemaVersion: 1 }, signal));
            if (!current()) return;
            const remember =
              prefs.values.find((x) => x.key === "rememberWifiAddress")?.value === true;
            if (!remember) return;
            const saved = value(
              await this.ctx.settings.update(
                {
                  schemaVersion: 1,
                  expectedRevision: prefs.revision,
                  changes: [{ key: "lastWifiAddress", value: address! }],
                },
                signal,
              ),
            );
            if (current()) this.settings = saved.snapshot;
          });
      } else if (name === "modes" || name === "mode") {
        const session = this.session,
          sources = this.sources;
        if (!session || !sources || !c.context.contextRef) throw new Error("No bound session");
        const identity = this.sessionKey;
        const port = String(v.form.port);
        const authorityEpoch = ++this.authorityEpoch;
        this.authorityRevision = -1;
        this.authority = "Unknown / 未知";
        let authority = value(
          await this.ctx.devices.context({ contextRef: c.context.contextRef }, signal),
        );
        if (!current() || identity !== this.sessionKey) return answer();
        if (this.authoritySubscription) {
          await this.authoritySubscription.dispose();
          this.authoritySubscription = undefined;
        }
        if (!current()) return answer();
        const owner = this.observing;
        const observed = value(
          await this.ctx.devices.subscribe(
            { topic: "authority", contextRef: c.context.contextRef },
            (event) => {
              if (
                this.observing !== owner ||
                !owner ||
                owner.signal.aborted ||
                authorityEpoch !== this.authorityEpoch
              )
                return;
              if (event.kind === "events.resyncRequired") {
                this.stopObservation();
                this.error = "Authority observation ended. Refresh explicitly.";
              }
              if (event.kind === "devices.authority") this.acceptAuthority(event.data);
              this.dirty();
            },
            signal,
          ),
        );
        if (!current() || this.observing !== owner) {
          await observed.dispose();
          return answer();
        }
        this.authoritySubscription = observed;
        authority = value(
          await this.ctx.devices.context({ contextRef: c.context.contextRef }, signal),
        );
        if (!current()) return answer();
        this.acceptAuthority(authority);
        if (name === "modes") {
          const queried = value(
            await this.ctx.devices.inputModes.query(
              {
                sessionId: session.sessionId,
                portId: port,
                expectedSourceRevision: sources.sourceRevision,
              },
              signal,
            ),
          );
          if (
            !current() ||
            identity !== this.sessionKey ||
            queried.sourceRevision !== sources.sourceRevision
          )
            return answer();
          v.modeIdentity = `${identity}:${port}`;
          v.revisions.delete("modes");
          v.modes = queried.modes.map((m) => ({
            key: m.modeId,
            version: v.modeIdentity,
            cells: [m.name],
          }));
        } else {
          if (
            this.authority !== "Allowed / 允許" ||
            c.arguments.dataset !== v.revisions.get("modes") ||
            c.arguments.version !== v.modeIdentity ||
            v.modeIdentity !== `${identity}:${port}` ||
            !v.modes.some((m) => m.key === c.arguments.key)
          )
            throw new Error("Stale mode or authority. Query again.");
          const live = value(
            await this.ctx.devices.session({ sessionId: session.sessionId }, signal),
          );
          const started = this.now();
          const read = value(
            await this.ctx.devices.read(
              {
                sessionId: session.sessionId,
                channelIds: sources.channels.map((x) => x.channelId),
                freshness: "cached",
              },
              signal,
            ),
          );
          if (
            !current() ||
            identity !== this.sessionKey ||
            live.sources.sourceRevision !== sources.sourceRevision ||
            !fresh(live.session, live.sources, read, started, this.now()) ||
            !live.sources.channels.some((x) => x.portId === port && x.state === "ready")
          )
            throw new Error("Mode requires a fresh idle ready input");
          const result = value(
            await this.ctx.devices.inputModes.set(
              {
                sessionId: session.sessionId,
                portId: port,
                expectedSourceRevision: sources.sourceRevision,
                modeId: String(c.arguments.key),
                contextRef: c.context.contextRef,
              },
              signal,
            ),
          );
          if (!current() || identity !== this.sessionKey) return answer();
          this.read = undefined;
          v.modes = [];
          this.refreshNeeded = true;
          this.sources = result.sources;
        }
      }
      if (current()) this.error = "";
    } catch (e) {
      if (current()) {
        this.error = bounded(
          connected ? `Connected; preferences were not saved: ${String(e)}` : String(e),
        );
        if (name === "discover") v.phase = "Discovery failed / 搜尋失敗";
        if (name === "connect" || name === "candidate")
          v.phase = connected ? "Connected / 已連線" : "Connection failed / 連線失敗";
      }
    } finally {
      this.commandBusy = false;
      this.dirty();
    }
    return answer();
  }
  async dispose(): Promise<void> {
    this.life.abort();
    clearTimeout(this.timer);
    this.detach?.();
    this.stopObservation();
    for (const v of [...this.views.values()]) {
      v.life.abort();
      v.work.abort();
      if (v.ui) await this.ctx.ui.unsubscribe(v.ui).catch(() => {});
    }
    this.views.clear();
    if (this.globalUi) await this.ctx.ui.unsubscribe(this.globalUi).catch(() => {});
    await Promise.allSettled([...this.cleanup]);
  }
}
export function createDevicePlugin(): PluginDefinition {
  let controller: DeviceController | undefined;
  return {
    activate(ctx) {
      controller = new DeviceController(ctx);
      controller.register();
    },
    ready() {
      return controller?.ready();
    },
    deactivate() {
      return controller?.dispose();
    },
  };
}
