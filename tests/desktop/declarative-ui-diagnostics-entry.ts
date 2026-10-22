// Test entry only: the App and diagnostics share this Vite module graph, so the
// WeakMap lookups observe the real production singleton and its actual stores.
import "../../apps/desktop/src/renderer/index.js";
import * as presentation from "./declarative-ui-presentation.js";
import { pluginUiWindow } from "../../apps/desktop/src/renderer/settings/settings-state.js";
import { diagnosticsFor as hostDiagnostics } from "../../apps/desktop/src/renderer/plugin-ui/host-ports.js";
import { diagnosticsFor as stateDiagnostics } from "../../apps/desktop/src/renderer/plugin-ui/state-store.js";
import type {
  FoundationCounters,
  FoundationDiagnostics,
  FoundationDiagnosticEvent,
} from "../../packages/plugin-runtime/src/ui-host-ports.js";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const owner = pluginUiWindow();
const instances = new Map<object, FoundationDiagnostics>();
const events: FoundationDiagnosticEvent[] = [];
const unsubscribe: (() => void)[] = [];
function retain(instance: object, lookup: (value: object) => FoundationDiagnostics) {
  if (instances.has(instance)) return;
  const diagnostics = lookup(instance);
  instances.set(instance, diagnostics);
  unsubscribe.push(diagnostics.onEvent((event) => events.push(structuredClone(event))));
}
function discover() {
  for (const entry of owner.session.catalog.getSnapshot().entries) {
    const record = owner.session.record(entry);
    if (record) retain(record.state, stateDiagnostics);
  }
}
retain(owner.host, hostDiagnostics);
retain(owner.session.catalog, stateDiagnostics);
unsubscribe.push(owner.session.subscribe(discover), owner.session.catalog.subscribe(discover));
discover();
function sample() {
  const counters = {
    owners: 0,
    bindings: 0,
    subscriptions: 0,
    queuedEvents: 0,
    queuedBytes: 0,
    timers: 0,
    pendingInvocations: 0,
    actionTokens: 0,
    resourceReaders: 0,
    workerJobs: 0,
  } satisfies FoundationCounters;
  const raw = [...instances.values()].map((diagnostics, id) => ({
    id,
    snapshot: { ...diagnostics.snapshot() },
  }));
  for (const row of raw)
    for (const key of Object.keys(counters) as (keyof FoundationCounters)[]) {
      const value = row.snapshot[key];
      check(Number.isSafeInteger(value) && value >= 0, `invalid diagnostic ${row.id}/${key}`);
      counters[key] += value;
      check(Number.isSafeInteger(counters[key]), `overflow diagnostic ${key}`);
    }
  return { clock: { origin: performance.timeOrigin, sampledAt: performance.now() }, counters, raw };
}
async function run(cycles: number) {
  check(Number.isInteger(cycles) && cycles > 0 && cycles <= 1000, "invalid renderer cycle count");
  await owner.ready;
  check(pluginUiWindow() === owner, "diagnostics are not using the production singleton");
  for (const lookup of [hostDiagnostics, stateDiagnostics]) {
    let rejected = false;
    try {
      lookup({});
    } catch {
      rejected = true;
    }
    check(rejected, "unknown diagnostics instance accepted");
  }
  const entries = owner.session.catalog
    .getSnapshot()
    .entries.filter(
      (entry) =>
        entry.pluginId.startsWith("acceptance.ui-") &&
        entry.kind === "panel" &&
        entry.availability === "available",
    );
  check(entries.length === 2, "actual diagnostic panels absent");
  for (const entry of entries) owner.session.close(entry);
  await frame();
  await frame();
  const baseline = sample();
  const observations: ReturnType<typeof sample>[] = [];
  for (let n = 0; n < cycles; n++) {
    const entry = entries[n % entries.length]!;
    await owner.session.open(entry);
    const record = owner.session.record(entry);
    check(record && instances.has(record.state), `missing registered store on cycle ${n}`);
    const size = instances.size;
    discover();
    discover();
    check(instances.size === size, "duplicate instance registration");
    await frame();
    await frame();
    const close = document.querySelector<HTMLButtonElement>(
      ".plugin-tools-pane [data-close-contribution]",
    );
    check(
      close && document.querySelector(".plugin-tools-pane .plugin-ui"),
      `actual React tree missing on cycle ${n}`,
    );
    close.click();
    await frame();
    check(!owner.session.record(entry), `record retained after close ${n}`);
    check(
      !document.querySelector(".plugin-tools-pane .plugin-ui"),
      `React tree retained after close ${n}`,
    );
    check(instances.has(record.state), "retired store missing from final observation");
    check(
      Object.values(stateDiagnostics(record.state).snapshot()).every((value) => value === 0),
      `retired store resources on cycle ${n}`,
    );
    if ((n + 1) % 100 === 0 || n + 1 === cycles) observations.push(sample());
  }
  const statuses = owner.session.catalog
    .getSnapshot()
    .entries.filter(
      (entry) => entry.pluginId.startsWith("acceptance.ui-") && entry.kind === "status",
    )
    .map((entry) => owner.session.record(entry));
  check(statuses.length === 2 && statuses.every(Boolean), "live statuses lost during cycles");
  const revisions = statuses.map((record) => record!.state.getSnapshot().snapshot.revision);
  await new Promise((resolve) => setTimeout(resolve, 500));
  check(
    statuses.every(
      (record, index) => record!.state.getSnapshot().snapshot.revision > revisions[index]!,
    ),
    "status producer stopped during renderer cycles",
  );
  owner.dispose();
  await frame();
  await frame();
  const final = sample();
  check(
    Object.values(final.counters).every((value) => value === 0),
    `renderer teardown retains ${JSON.stringify(final.counters)}`,
  );
  const result = {
    cycles,
    singleton: true,
    unknownRejected: true,
    baseline,
    observations,
    final,
    events: [...events],
  };
  for (const off of unsubscribe.splice(0)) off();
  instances.clear();
  events.length = 0;
  return result;
}
Object.assign(window, { declarativeDiagnostics: { run }, declarativePresentation: presentation });
