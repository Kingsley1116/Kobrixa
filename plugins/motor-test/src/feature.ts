import {
  definePlugin,
  type ContextCommandContext,
  type DeviceSubscription,
  type PluginContext,
} from "@kobrixa/plugin-sdk";
import type {
  CommandValue,
  DeviceEvent,
  DeviceSessionSnapshot,
  MotionSnapshot,
  MotionSpec,
  SourceCatalog,
  UiBinding,
  UiEventEnvelope,
  UiScalar,
} from "@kobrixa/plugin-protocol";
import {
  PORTS,
  availabilityText,
  boundedText,
  isPort,
  localize,
  motionFromForm,
  presentMotion,
  selectSource,
} from "./model.js";

const PANEL = "kobrixa.motor-test.panel";
const STATUS = "kobrixa.motor-test.status";
const key = (binding: UiBinding) => JSON.stringify(binding);
const answer = (message?: string): CommandValue => ({
  output: message ? { message: boundedText(message) } : {},
  fieldErrors: [],
});
type Instance = {
  binding: UiBinding;
  visible: boolean;
  dirty: boolean;
  busy: boolean;
  retired: boolean;
  version: number;
  timer?: ReturnType<typeof setTimeout>;
  last: number;
  subscription?: string;
  retries: number;
};
type Selected = { sessionId: string; identity: string };
type Attempt = {
  binding: UiBinding;
  generation: number;
  cancelled: boolean;
  forced: boolean;
  gesture?: string;
  spec?: MotionSpec;
  id?: string;
  snapshot?: MotionSnapshot;
  subscription?: DeviceSubscription;
  authority?: DeviceSubscription;
  observation?: ReturnType<typeof setTimeout>;
  queryPending: boolean;
  stopConfigured: boolean;
  stopBrake: boolean;
  settled: boolean;
  detach: () => void;
};
const identity = (session: DeviceSessionSnapshot, sources: SourceCatalog) =>
  JSON.stringify([
    session.sessionId,
    session.providerId,
    session.providerGeneration,
    session.sourceRevision,
    sources.sourceRevision,
    sources.actuators.map((a) => [a.portId, a.actuatorId, a.state]).sort(),
  ]);

/** Public SDK authoring only. Host owns authority, leases, movement bounds and recovery. */
class MotorFeature {
  private live = true;
  private readonly abort = new AbortController();
  private readonly instances = new Map<string, Instance>();
  private readonly subscriptions = new Set<DeviceSubscription>();
  private globalUi?: string;
  private selected: Selected | undefined;
  private generation = 0;
  private active: Attempt | undefined;
  private sources: SourceCatalog | undefined;
  private session: DeviceSessionSnapshot | undefined;
  private locale: PluginContext["locale"];
  private capable = false;
  private readyStarted = false;
  private error = "";
  private catalogVersion = 0;
  private readTicket = 0;
  private uiCatalogVersion = 0;
  private refreshPending = false;
  private refreshAgain = false;
  private sessionSubscription: DeviceSubscription | undefined;
  private sessionWatch: string | undefined;
  private uiResyncPending = false;
  private readonly sequences = new Map<string, number>();

  constructor(private readonly context: PluginContext) {
    this.locale = context.locale;
  }
  private t(en: string, zh: string) {
    return this.locale === "zh-TW" ? zh : en;
  }
  private failure(error?: { code: string; message: string; detail?: unknown }) {
    if (!this.live) return;
    this.error = error
      ? boundedText(`${error.code}: ${error.message} ${JSON.stringify(error.detail ?? {})}`)
      : localize(availabilityText.transportFailure, this.locale);
    this.paint();
  }
  private attemptFailure(a: Attempt, error?: { code: string; message: string; detail?: unknown }) {
    if (this.active === a) this.failure(error);
  }
  private background(work: Promise<unknown>) {
    void work.catch(() => this.failure());
  }
  private valid(a: Attempt) {
    return (
      this.live &&
      this.active === a &&
      !a.cancelled &&
      a.generation === this.generation &&
      this.instances.get(key(a.binding))?.visible === true
    );
  }
  private invalidate() {
    this.generation++;
    this.selected = undefined;
    if (this.active) this.cancel(this.active, true);
    this.paint();
  }
  register() {
    const register = this.context.commands.registerContext;
    register("kobrixa.motor-test.select-current", {}, async (c) => {
      const generation = this.generation;
      if (!this.panel(c))
        return answer(this.t("Open the live motor panel.", "請開啟有效的馬達面板。"));
      const current = await this.readCurrent();
      if (!this.live || c.signal.aborted || generation !== this.generation || !this.panel(c))
        return answer();
      if (!current) return answer(localize(availabilityText.unavailable, this.locale));
      this.selected = {
        sessionId: current.session.sessionId,
        identity: identity(current.session, current.sources),
      };
      this.error = "";
      this.paint();
      return answer();
    });
    register("kobrixa.motor-test.refresh", {}, () => {
      this.refresh();
      if (this.active && !this.active.settled) this.query(this.active);
      return answer();
    });
    register("kobrixa.motor-test.start", {}, (c) => this.begin(c));
    register(
      "kobrixa.motor-test.jog",
      { direction: { type: "enum", values: ["1", "-1"], nullable: false } },
      (c) => {
        const trigger = c.context.trigger;
        if (trigger.kind !== "hold") return answer();
        if (trigger.phase !== "begin") {
          const a = this.active;
          if (
            a &&
            a.gesture === trigger.gestureRef &&
            c.context.binding &&
            key(a.binding) === key(c.context.binding)
          )
            this.cancel(a, trigger.phase === "cancel");
          return answer();
        }
        return this.begin(
          c,
          c.arguments.direction === "1" ? 1 : c.arguments.direction === "-1" ? -1 : undefined,
        );
      },
    );
  }
  private panel(c: ContextCommandContext) {
    const b = c.context.binding;
    return (
      !c.signal.aborted &&
      this.live &&
      c.context.origin === "panel" &&
      b?.contributionId === PANEL &&
      b.kind === "panel" &&
      this.instances.get(key(b))?.visible === true &&
      !!this.instances.get(key(b))?.subscription
    );
  }
  private begin(c: ContextCommandContext, direction?: 1 | -1): CommandValue {
    const x = c.context;
    if (
      !this.capable ||
      !this.panel(c) ||
      !x.contextRef ||
      !x.motionScopeRef ||
      !x.form ||
      !this.selected ||
      (this.active && !this.active.settled)
    )
      return answer();
    if (
      direction === undefined
        ? x.trigger.kind !== "activate"
        : x.trigger.kind !== "hold" || x.trigger.phase !== "begin"
    )
      return answer();
    const port = x.form.values.port;
    const actuator = isPort(port)
      ? this.sources?.actuators.find((a) => a.portId === port && a.state === "ready")
      : undefined;
    if (!actuator) return answer(localize(availabilityText.unavailable, this.locale));
    const checked = motionFromForm(x.form.values, actuator, direction);
    if (!checked.ok) return { output: {}, fieldErrors: checked.fieldErrors };
    if (direction === undefined ? checked.spec.mode === "jog" : checked.spec.mode !== "jog")
      return answer();
    const a: Attempt = {
      binding: x.binding!,
      generation: this.generation,
      cancelled: false,
      forced: false,
      ...(x.trigger.kind === "hold" ? { gesture: x.trigger.gestureRef } : {}),
      spec: checked.spec,
      queryPending: false,
      stopConfigured: false,
      stopBrake: false,
      settled: false,
      detach: () => {},
    };
    // Lock synchronously, before any await; release/cancel never waits for this task.
    this.active = a;
    const cancel = () => this.cancel(a, true);
    c.signal.addEventListener("abort", cancel, { once: true });
    a.detach = () => c.signal.removeEventListener("abort", cancel);
    this.error = "";
    this.paint();
    this.background(this.start(a, c));
    return answer();
  }
  private async start(a: Attempt, c: ContextCommandContext) {
    let prepareSent = false;
    try {
      const selected = this.selected;
      const current = await this.readCurrent();
      if (!this.valid(a)) return;
      if (
        !current ||
        !selected ||
        this.selected !== selected ||
        selected.identity !== identity(current.session, current.sources)
      ) {
        this.invalidate();
        return;
      }
      const port = c.context.form!.values.port;
      if (!isPort(port)) return;
      const source = selectSource(current.session, current.sources, port);
      if (!source || source.actuatorId !== a.spec!.actuatorId) {
        this.invalidate();
        return;
      }
      const authority = await this.context.devices.context(
        { contextRef: c.context.contextRef! },
        this.abort.signal,
      );
      if (!this.valid(a)) return;
      if (!authority.ok) {
        this.attemptFailure(a, authority.error);
        a.settled = true;
        return;
      }
      if (authority.value.state !== "local" && authority.value.state !== "allowed") {
        this.cancel(a, true);
        a.settled = true;
        return;
      }
      prepareSent = true;
      const prepared = await this.context.devices.motion.prepare({
        sessionId: source.sessionId,
        contextRef: c.context.contextRef!,
        motionScopeRef: c.context.motionScopeRef!,
        motion: a.spec!,
        ...(a.gesture ? { gestureRef: a.gesture } : {}),
      });
      if (!prepared.ok) {
        this.attemptFailure(a, prepared.error);
        const detail = prepared.error.detail;
        a.settled =
          detail?.kind === "permission" ||
          detail?.kind === "resource" ||
          (detail?.kind === "device" &&
            detail.dispatch === "not-sent" &&
            (detail.stopConfirmation === "not-required" ||
              detail.stopConfirmation === "confirmed"));
        return;
      }
      a.id = prepared.value.operation.operationId;
      this.accept(a, prepared.value.operation);
      if (!this.valid(a)) {
        this.cancel(a, true);
        return;
      }
      if (a.settled) return;
      this.observe(a, c.context.contextRef!);
      // No retry path can reach start. Query and stop always keep this original ID.
      try {
        const started = await this.context.devices.motion.start({ operationId: a.id });
        if (started.ok) this.accept(a, started.value.operation);
        else {
          this.attemptFailure(a, started.error);
          this.query(a);
          this.cancel(a, true);
        }
      } catch {
        this.attemptFailure(a);
        this.query(a);
        this.cancel(a, true);
      }
      if (!this.valid(a) && !a.settled) this.cancel(a, a.forced);
    } catch {
      this.attemptFailure(a);
      if (a.id) {
        this.query(a);
        this.cancel(a, true);
      } else if (!prepareSent) a.settled = true;
      // Lost prepare has no public ID: retain the lock/uncertainty for core recovery.
    } finally {
      if (!prepareSent) a.settled = true;
      if (a.settled) this.finish(a);
      this.paint();
    }
  }
  private accept(a: Attempt, snapshot: MotionSnapshot) {
    if (
      !this.live ||
      this.active !== a ||
      snapshot.operationId !== a.id ||
      (a.snapshot && snapshot.revision <= a.snapshot.revision)
    )
      return;
    a.snapshot = snapshot;
    if (a.cancelled && snapshot.brakeRequired && !a.stopBrake) this.cancel(a, true);
    if (presentMotion(snapshot, a.spec!, this.locale).terminal) {
      // Unconfirmed remains locked. A later confirmed snapshot may resolve it.
      a.settled =
        snapshot.stopConfirmation === "confirmed" ||
        (snapshot.stopConfirmation === "not-required" && snapshot.dispatch === "not-sent");
      this.finish(a);
    }
    this.paint();
  }
  private finish(a: Attempt) {
    a.detach();
    clearTimeout(a.observation);
    if (a.subscription) {
      this.disposeDevice(a.subscription);
      delete a.subscription;
    }
    if (a.authority) {
      this.disposeDevice(a.authority);
      delete a.authority;
    }
  }
  private query(a: Attempt) {
    if (!this.live || !a.id || a.queryPending) return;
    a.queryPending = true;
    this.background(
      (async () => {
        try {
          const result = await this.context.devices.motion.query(
            { operationId: a.id! },
            this.abort.signal,
          );
          if (result.ok) this.accept(a, result.value.operation);
          else this.attemptFailure(a, result.error);
        } catch {
          this.attemptFailure(a);
        } finally {
          a.queryPending = false;
        }
      })(),
    );
  }
  private cancel(a: Attempt, forced: boolean) {
    if (a.settled) return;
    const brakeRequired = a.forced || forced || a.snapshot?.brakeRequired === true;
    const changed = !a.cancelled || a.forced !== brakeRequired;
    a.cancelled = true;
    a.forced = brakeRequired;
    a.detach();
    if (!a.id) {
      if (changed) this.paint();
      return;
    }
    const brake = a.forced;
    if (brake ? a.stopBrake : a.stopConfigured || a.stopBrake) return;
    if (brake) a.stopBrake = true;
    else a.stopConfigured = true;
    this.background(
      (async () => {
        try {
          const result = await this.context.devices.motion.stop({
            operationId: a.id!,
            stopMode: brake ? "brake" : "configured",
          });
          if (result.ok) this.accept(a, result.value.operation);
          else this.attemptFailure(a, result.error);
        } catch {
          this.attemptFailure(a);
        } finally {
          if (this.live && !a.settled) this.query(a);
        }
      })(),
    );
    this.paint();
  }
  private observe(a: Attempt, contextRef: string) {
    this.background(
      (async () => {
        const result = await this.context.devices.subscribe(
          { topic: "authority", contextRef },
          (event) => {
            if (!this.live || this.active !== a) return;
            if (
              this.gap(event) ||
              event.kind === "events.resyncRequired" ||
              (event.kind === "devices.authority" &&
                event.data.state !== "local" &&
                event.data.state !== "allowed")
            )
              this.cancel(a, true);
          },
          this.abort.signal,
        );
        if (!result.ok) {
          this.attemptFailure(a, result.error);
          this.cancel(a, true);
          return;
        }
        if (!this.live || this.active !== a || a.settled) {
          this.disposeDevice(result.value);
          return;
        }
        a.authority = result.value;
        this.subscriptions.add(result.value);
        const snapshot = result.value.snapshot;
        if ("contextRef" in snapshot && snapshot.state !== "local" && snapshot.state !== "allowed")
          this.cancel(a, true);
      })(),
    );
    this.background(
      (async () => {
        const result = await this.context.devices.subscribe(
          { topic: "motion", operationId: a.id! },
          (event) => {
            if (!this.live || this.active !== a) return;
            const gap = this.gap(event);
            if (gap || event.kind === "events.resyncRequired") this.query(a);
            else if (event.kind === "devices.motion") this.accept(a, event.data);
          },
          this.abort.signal,
        );
        if (!result.ok) {
          this.attemptFailure(a, result.error);
          this.query(a);
          return;
        }
        if (
          !this.live ||
          this.active !== a ||
          a.settled ||
          (a.snapshot && presentMotion(a.snapshot, a.spec!, this.locale).terminal)
        ) {
          this.disposeDevice(result.value);
          return;
        }
        a.subscription = result.value;
        this.subscriptions.add(result.value);
        if ("operationId" in result.value.snapshot) this.accept(a, result.value.snapshot);
      })(),
    );
    this.query(a);
    // One deadline, no plugin pulses, keepalives or perpetual query timer.
    a.observation = setTimeout(() => {
      this.cancel(a, true);
      this.query(a);
      this.finish(a);
    }, 15000);
  }
  private gap(event: DeviceEvent | UiEventEnvelope) {
    const last = this.sequences.get(event.subscriptionId) ?? 0;
    if (event.sequence <= last) return true;
    this.sequences.set(event.subscriptionId, event.sequence);
    return event.sequence !== last + 1;
  }
  private disposeDevice(subscription: DeviceSubscription) {
    this.subscriptions.delete(subscription);
    this.sequences.delete(subscription.subscriptionId);
    void subscription.dispose().catch(() => {});
  }
  private async readCurrent() {
    const version = this.catalogVersion;
    const ticket = ++this.readTicket;
    const list = await this.context.devices.list({}, this.abort.signal);
    if (!this.live || ticket !== this.readTicket) return null;
    if (!list.ok) {
      this.session = undefined;
      this.sources = undefined;
      if (this.selected) this.invalidate();
      this.failure(list.error);
      return null;
    }
    if (version !== this.catalogVersion) {
      this.refresh();
      return null;
    }
    const session = list.value.sessions[0];
    if (
      !session ||
      session.state !== "connected" ||
      !session.capabilities.includes("finiteMotion.v1") ||
      !list.value.providers.some(
        (p) =>
          p.providerId === session.providerId &&
          p.state === "available" &&
          p.capabilities.includes("finiteMotion.v1"),
      )
    ) {
      this.session = session;
      this.sources = undefined;
      this.sessionWatch = undefined;
      if (this.sessionSubscription) {
        this.disposeDevice(this.sessionSubscription);
        this.sessionSubscription = undefined;
      }
      if (this.selected) this.invalidate();
      this.paint();
      return null;
    }
    const result = await this.context.devices.session(
      { sessionId: session.sessionId },
      this.abort.signal,
    );
    if (!this.live || ticket !== this.readTicket) return null;
    if (!result.ok) {
      this.sources = undefined;
      this.failure(result.error);
      if (this.selected) this.invalidate();
      return null;
    }
    if (version !== this.catalogVersion) {
      this.refresh();
      return null;
    }
    const value = result.value;
    if (
      value.session.sessionId !== session.sessionId ||
      value.session.state !== "connected" ||
      !value.session.capabilities.includes("finiteMotion.v1") ||
      value.sources.sessionId !== session.sessionId ||
      value.sources.sourceRevision !== value.session.sourceRevision
    ) {
      this.invalidate();
      return null;
    }
    this.session = value.session;
    this.sources = value.sources;
    if (this.selected && this.selected.identity !== identity(value.session, value.sources))
      this.invalidate();
    this.watchSession(value.session.sessionId);
    this.paint();
    return value;
  }
  private watchSession(sessionId: string) {
    if (this.sessionWatch === sessionId) return;
    this.sessionWatch = sessionId;
    if (this.sessionSubscription) {
      this.disposeDevice(this.sessionSubscription);
      this.sessionSubscription = undefined;
    }
    this.background(
      (async () => {
        const result = await this.context.devices.subscribe(
          { topic: "session", sessionId },
          (event) => {
            if (!this.live || this.sessionWatch !== sessionId) return;
            this.catalogVersion++;
            const gap = this.gap(event);
            if (gap || event.kind === "events.resyncRequired") this.invalidate();
            if (gap || event.kind === "events.resyncRequired" || event.kind === "devices.session") {
              if (
                event.kind === "devices.session" &&
                (event.data.sourcesChanged ||
                  event.data.session.state !== "connected" ||
                  event.data.session.sourceRevision !== this.session?.sourceRevision ||
                  event.data.session.providerGeneration !== this.session?.providerGeneration ||
                  !event.data.session.capabilities.includes("finiteMotion.v1"))
              )
                this.invalidate();
              this.refresh();
            }
          },
          this.abort.signal,
        );
        if (!result.ok) {
          this.failure(result.error);
          return;
        }
        if (!this.live || this.sessionWatch !== sessionId) {
          this.disposeDevice(result.value);
          return;
        }
        this.sessionSubscription = result.value;
        this.subscriptions.add(result.value);
        this.refresh();
      })(),
    );
  }
  private refresh() {
    if (!this.live) return;
    if (this.refreshPending) {
      this.refreshAgain = true;
      return;
    }
    this.refreshPending = true;
    this.background(
      this.readCurrent().finally(() => {
        this.refreshPending = false;
        if (this.refreshAgain) {
          this.refreshAgain = false;
          this.refresh();
        }
      }),
    );
  }
  ready() {
    if (!this.live || this.readyStarted) return;
    this.readyStarted = true;
    // Launch bounded SDK reads/subscriptions, then release the host ready callback.
    // Their replies must not consume the remaining activation budget or await hardware.
    this.background(
      Promise.allSettled([
        this.context.devices.negotiate().then((result) => {
          // SDK negotiation is cached. Availability must follow the current catalog,
          // so a provider enabled after launch is not pinned to its initial state.
          if (this.live) this.capable = result.ok;
          if (!result.ok) this.failure(result.error);
        }),
        this.readCurrent(),
        this.resyncInstances(),
        this.subscribeUi(),
        this.context.devices
          .subscribe(
            { topic: "catalog" },
            (event) => {
              if (!this.live) return;
              this.catalogVersion++;
              if (this.gap(event) || event.kind === "events.resyncRequired") {
                this.invalidate();
                this.refresh();
                return;
              }
              if (event.kind === "devices.catalog") {
                const session = event.data.sessions[0];
                if (
                  this.selected &&
                  (!session ||
                    session.sessionId !== this.selected.sessionId ||
                    session.sourceRevision !== this.session?.sourceRevision ||
                    session.providerGeneration !== this.session?.providerGeneration ||
                    session.state !== "connected" ||
                    !session.capabilities.includes("finiteMotion.v1") ||
                    !event.data.providers.some(
                      (p) =>
                        p.providerId === session.providerId &&
                        p.state === "available" &&
                        p.capabilities.includes("finiteMotion.v1"),
                    ))
                )
                  this.invalidate();
                this.refresh();
              }
            },
            this.abort.signal,
          )
          .then((result) => {
            if (!result.ok) this.failure(result.error);
            else if (!this.live) this.disposeDevice(result.value);
            else {
              this.subscriptions.add(result.value);
              this.refresh();
            }
          }),
      ]).then(() => this.paint()),
    );
  }
  private async subscribeUi() {
    const version = this.uiCatalogVersion;
    const result = await this.context.ui.subscribe(
      { topics: ["instances", "environment"] },
      (event) => this.uiEvent(event),
      this.abort.signal,
    );
    if (!result.ok) {
      this.failure(result.error);
      return;
    }
    if (!this.live) {
      void this.context.ui.unsubscribe(result.value.subscriptionId).catch(() => {});
      return;
    }
    this.globalUi = result.value.subscriptionId;
    if (version === this.uiCatalogVersion) {
      this.locale = result.value.snapshot.locale;
      this.replaceInstances(result.value.snapshot.instances);
    } else this.background(this.resyncInstances());
  }
  private resyncInstances() {
    if (this.uiResyncPending || !this.live) return Promise.resolve();
    this.uiResyncPending = true;
    const version = this.uiCatalogVersion;
    return this.context.ui
      .instances(this.abort.signal)
      .then((result) => {
        if (!this.live) return;
        if (result.ok) {
          if (version === this.uiCatalogVersion) this.replaceInstances(result.value.instances);
        } else this.failure(result.error);
      })
      .finally(() => {
        this.uiResyncPending = false;
      });
  }
  private uiEvent(event: UiEventEnvelope) {
    if (!this.live) return;
    if ("binding" in event.data && !this.instances.has(key(event.data.binding))) return;
    if (this.gap(event)) {
      this.invalidate();
      this.background(this.resyncInstances());
    }
    switch (event.kind) {
      case "ui.instances":
        this.uiCatalogVersion++;
        this.replaceInstances(event.data.instances);
        break;
      case "ui.environment":
        this.locale = event.data.locale;
        this.paint();
        break;
      case "ui.visibility": {
        const instance = this.instances.get(key(event.data.binding));
        if (instance) {
          instance.visible = event.data.visible;
          instance.version++;
        }
        if (
          !event.data.visible &&
          this.active &&
          key(this.active.binding) === key(event.data.binding)
        )
          this.cancel(this.active, true);
        this.paint();
        break;
      }
      case "ui.revoked":
        if (this.active && key(this.active.binding) === key(event.data.binding))
          this.cancel(this.active, event.data.reason !== "release");
        if (
          [
            "closed",
            "generation-retired",
            "resource-replaced",
            "renderer-gone",
            "process-gone",
          ].includes(event.data.reason)
        ) {
          this.uiCatalogVersion++;
          const instance = this.instances.get(key(event.data.binding));
          if (instance) this.retire(instance);
          this.invalidate();
        }
        break;
      case "ui.state":
        break; // Our own patches also emit state; do not create a feedback loop.
      case "ui.form":
        break; // Host owns drafts; accepted invocation is the only start snapshot.
    }
  }
  private replaceInstances(bindings: UiBinding[]) {
    if (!this.live) return;
    const ours = bindings.filter((b) => b.contributionId === PANEL || b.contributionId === STATUS);
    for (const [id, instance] of this.instances)
      if (!ours.some((b) => key(b) === id)) {
        this.retire(instance);
        if (instance.binding.kind === "panel") this.invalidate();
      }
    for (const binding of ours)
      if (!this.instances.has(key(binding))) {
        const instance: Instance = {
          binding,
          visible: false,
          dirty: true,
          busy: false,
          retired: false,
          version: 0,
          last: -Infinity,
          retries: 0,
        };
        this.instances.set(key(binding), instance);
        this.background(
          (async () => {
            const version = instance.version;
            const result = await this.context.ui.subscribe(
              { binding, topics: ["visibility", "state"] },
              (event) => this.uiEvent(event),
              this.abort.signal,
            );
            if (!result.ok) {
              this.failure(result.error);
              return;
            }
            if (!this.current(instance)) {
              void this.context.ui.unsubscribe(result.value.subscriptionId).catch(() => {});
              return;
            }
            instance.subscription = result.value.subscriptionId;
            if (version === instance.version)
              instance.visible = result.value.snapshot.states[0]?.visible ?? false;
            this.schedule(instance);
          })(),
        );
      }
    this.paint();
  }
  private current(instance: Instance) {
    return this.live && !instance.retired && this.instances.get(key(instance.binding)) === instance;
  }
  private retire(instance: Instance) {
    instance.retired = true;
    instance.version++;
    clearTimeout(instance.timer);
    this.instances.delete(key(instance.binding));
    if (instance.subscription) {
      this.sequences.delete(instance.subscription);
      void this.context.ui.unsubscribe(instance.subscription).catch(() => {});
    }
  }
  private data(): Record<string, UiScalar> {
    const available =
      this.capable &&
      !!this.session &&
      this.session.state === "connected" &&
      !!this.sources &&
      this.session.capabilities.includes("finiteMotion.v1");
    const a = this.active;
    const motion = a?.snapshot && a.spec ? presentMotion(a.snapshot, a.spec, this.locale).data : {};
    return {
      session: boundedText(
        this.session?.name ?? this.t("No connection selected", "尚未選取連線"),
        256,
      ),
      transport: this.session?.transport ?? "—",
      "session-state": this.session
        ? this.locale === "en"
          ? this.session.state
          : {
              connected: "已連線",
              quarantined: "已隔離",
              disconnecting: "斷線中",
              disconnected: "已斷線",
            }[this.session.state]
        : "—",
      available,
      "can-start": available && !!this.selected && (!a || a.settled),
      availability: available
        ? this.selected
          ? this.t("Current connection selected.", "已選取目前連線。")
          : this.t("Use current connection to select explicitly.", "請按使用目前連線，明確選取。")
        : localize(availabilityText.unavailable, this.locale),
      summary: available ? this.t("Available", "可使用") : this.t("Unavailable", "無法使用"),
      ...Object.fromEntries(
        PORTS.map((p) => [
          `port-${p.toLowerCase()}`,
          (() => {
            const state = this.sources?.actuators.find((a) => a.portId === p)?.state ?? "unknown";
            return this.locale === "en"
              ? state
              : {
                  ready: "準備就緒",
                  empty: "無裝置",
                  initializing: "初始化中",
                  unknown: "未知",
                  error: "錯誤",
                }[state];
          })(),
        ]),
      ),
      error: "",
      "has-error": false,
      ...motion,
      ...(a && !a.snapshot
        ? {
            // No public snapshot means no evidence about dispatch or stop confirmation.
            // Patch merges data, so replace every reading/result from the previous attempt.
            operation: null,
            phase: this.t("Preparing", "準備中"),
            stage: "—",
            movement: this.t("Unknown", "未知"),
            dispatch: this.t("Unknown", "未知"),
            "stop-requested": this.t("No", "否"),
            confirmation: this.t("Unknown", "未知"),
            angle: this.t("No reading", "無讀值"),
            displacement: this.t("No reading", "無讀值"),
            elapsed: "—",
            progress: null,
            summary: a.cancelled
              ? this.t("Cancelled; awaiting reconciliation", "已取消；等待對帳")
              : this.t("Preparing", "準備中"),
          }
        : {}),
      ...(a?.cancelled && !a.settled
        ? {
            "can-start": false,
            phase: this.t("Stopping", "停止中"),
            "stop-requested": this.t("Yes", "是"),
            summary: this.t("Stop requested; check core recovery", "已要求停止；請查看核心復原"),
          }
        : {}),
      ...(this.error ? { error: this.error, "has-error": true } : {}),
    };
  }
  private paint() {
    for (const instance of this.instances.values()) {
      instance.dirty = true;
      instance.retries = 0;
      this.schedule(instance);
    }
  }
  private schedule(instance: Instance) {
    if (!this.current(instance) || instance.busy || instance.timer || !instance.dirty) return;
    instance.timer = setTimeout(
      () => {
        delete instance.timer;
        this.background(this.patch(instance));
      },
      Math.max(0, 100 - (performance.now() - instance.last)),
    );
  }
  private async patch(instance: Instance) {
    if (!this.current(instance)) return;
    instance.busy = true;
    instance.dirty = false;
    try {
      const version = instance.version;
      const state = await this.context.ui.state(instance.binding, this.abort.signal);
      if (!this.current(instance)) return;
      if (!state.ok) {
        this.error = localize(availabilityText.uiFailure, this.locale);
        return;
      }
      if (version === instance.version) instance.visible = state.value.visible;
      if (
        !instance.visible &&
        this.active &&
        !this.active.settled &&
        key(this.active.binding) === key(instance.binding)
      )
        this.cancel(this.active, true);
      const data = this.data();
      const set = instance.binding.kind === "status" ? { summary: data.summary! } : data;
      instance.last = performance.now();
      const result = await this.context.ui.patch(
        instance.binding,
        state.value.revision,
        set,
        this.abort.signal,
      );
      if (!this.current(instance)) return;
      if (!result.ok) {
        // One presentation retry on the next event/tick; never replay device effects.
        this.error = localize(availabilityText.uiFailure, this.locale);
        const resync = await this.context.ui.state(instance.binding, this.abort.signal);
        if (!this.current(instance)) return;
        if (resync.ok && resync.value.revision !== state.value.revision && instance.retries++ < 1)
          instance.dirty = true;
      }
    } catch {
      if (this.current(instance)) this.error = localize(availabilityText.uiFailure, this.locale);
    } finally {
      instance.busy = false;
      this.schedule(instance);
    }
  }
  deactivate() {
    if (!this.live) return;
    if (this.active && !this.active.settled) this.cancel(this.active, true);
    this.live = false;
    this.abort.abort();
    this.generation++;
    if (this.active) this.finish(this.active);
    for (const instance of this.instances.values()) this.retire(instance);
    for (const subscription of this.subscriptions) this.disposeDevice(subscription);
    if (this.globalUi) void this.context.ui.unsubscribe(this.globalUi).catch(() => {});
    this.sequences.clear();
  }
}

export function createMotorPlugin() {
  let feature: MotorFeature | undefined;
  return definePlugin({
    activate(context) {
      if (!feature) {
        feature = new MotorFeature(context);
        feature.register();
      }
    },
    ready() {
      return feature?.ready();
    },
    deactivate() {
      feature?.deactivate();
    },
  });
}
