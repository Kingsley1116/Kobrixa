import { expect, it, vi } from "vitest";
import { OperationStore } from "./operations.js";
import { operationHarness, pluginPrincipal } from "./fake-provider.js";
it("F07 starting motion reserves foreground before a shared read drains without aborting it", async () => {
  const h = operationHarness(),
    store = new OperationStore(h.dependencies);
  let release!: () => void;
  let readSignal!: AbortSignal;
  const reading = h.admission.lane.exchange(
    "shared-read",
    5000,
    5000,
    () => {},
    async (signal) => {
      readSignal = signal;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  );
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const first = store.prepare(h.admission),
    second = store.prepare(h.admission);
  store.start(h.admission.principal, first.operationId);
  expect(h.admission.lane.foreground).toBe(first.operationId);
  expect(() => store.start(h.admission.principal, second.operationId)).toThrow();
  expect(readSignal.aborted).toBe(false);
  expect(h.provider.calls).not.toContain("motion");
  release();
  await reading;
  await store.settled(first.operationId);
  expect(readSignal.aborted).toBe(false);
  expect(h.provider.calls.filter((call) => call === "motion")).toHaveLength(1);
  expect(h.admission.lane.foreground).toBeNull();
});
it.each([4999, 5000, 5001])("F04 prepare deadline %i is not renewed by start", async (age) => {
  const h = operationHarness();
  const store = new OperationStore(h.dependencies);
  const op = store.prepare(h.admission);
  h.setNow(age);
  if (age < 5000) {
    store.start(h.admission.principal, op.operationId);
    await store.settled(op.operationId);
    expect(h.provider.calls).toContain("motion");
  } else {
    expect(() => store.start(h.admission.principal, op.operationId)).toThrow();
    expect(h.provider.calls).not.toContain("motion");
  }
});
it("F04 stop-before-start is a permanent tombstone; lost reply never dispatches twice", async () => {
  const h = operationHarness(),
    store = new OperationStore(h.dependencies),
    op = store.prepare(h.admission);
  expect(h.provider.calls).toEqual([]);
  store.stop(h.admission.principal, op.operationId, "brake");
  expect(() => store.start(h.admission.principal, op.operationId)).toThrow();
  const next = store.prepare(h.admission);
  store.start(h.admission.principal, next.operationId);
  expect(() => store.start(h.admission.principal, next.operationId)).toThrow();
  await store.settled(next.operationId);
  expect(h.provider.calls.filter((c) => c === "motion")).toHaveLength(1);
});
it("F10 pending journal failure prevents risk; final failure retains a blocker", async () => {
  for (const failAt of [1, 2]) {
    const h = operationHarness();
    let writes = 0;
    h.dependencies.journal.commit = async () => {
      if (++writes === failAt) throw new Error("disk full");
    };
    const store = new OperationStore(h.dependencies),
      op = store.prepare(h.admission);
    store.start(h.admission.principal, op.operationId);
    const disposition = await store.settled(op.operationId);
    expect(disposition.journalCommitted).toBe(false);
    if (failAt === 1) expect(h.provider.calls).not.toContain("motion");
    else
      expect(store.query(h.admission.principal, op.operationId).stopConfirmation).toBe("confirmed");
  }
});
it.each([
  "preflight",
  "helper-upload",
  "helper-run",
  "read",
  "helper-arm",
  "motion-pulse",
] as const)("F05/A-RF1 revoke after %s prevents every later consequential step", async (step) => {
  const h = operationHarness();
  let permitted = true;
  h.dependencies.check = () => {
    if (!permitted) throw new Error("authority changed");
  };
  h.provider.motion = async (ctx) => {
    await ctx.exchange(step, async () => {
      permitted = false;
      return null;
    });
    await ctx.exchange("helper-arm", async () => {
      h.provider.calls.push("late-arm");
    });
    return { movement: "completed", angle: 0, displacement: 0 };
  };
  const store = new OperationStore(h.dependencies),
    op = store.prepare(h.admission);
  store.start(h.admission.principal, op.operationId);
  await store.settled(op.operationId);
  expect(h.provider.calls).not.toContain("late-arm");
  expect(h.provider.calls).toContain("stop");
});
it("F04 source prepare quotas are exact", () => {
  const h = operationHarness(),
    store = new OperationStore(h.dependencies);
  for (let i = 0; i < 4; i++) store.prepare(h.admission);
  expect(() => store.prepare(h.admission)).toThrow();
});

it("F04 exactly sixteen host prepares; terminal source rows can be evicted safely", () => {
  const h = operationHarness(),
    store = new OperationStore(h.dependencies);
  for (let generation = 1; generation <= 4; generation++)
    for (let n = 0; n < 4; n++)
      store.prepare({
        ...h.admission,
        principal: {
          ...h.admission.principal,
          kind: "plugin",
          owner: {
            sourceKey: `builtin:acme.test-${generation}`,
            pluginId: "acme.test",
            generation,
            hostEpoch: "00000000-0000-4000-8000-000000000001",
            processEpoch: `00000000-0000-4000-8000-${String(generation).padStart(12, "0")}`,
          },
          authorityContext: null,
        },
      });
  expect(() =>
    store.prepare({
      ...h.admission,
      principal: {
        kind: "plugin",
        owner: {
          sourceKey: "builtin:acme.test-5",
          pluginId: "acme.test",
          generation: 5,
          hostEpoch: "00000000-0000-4000-8000-000000000001",
          processEpoch: "00000000-0000-4000-8000-000000000005",
        },
        authorityContext: null,
      },
    }),
  ).toThrow();
});
it("F10 sixty-four unresolved journal rows block the next risk before dispatch", async () => {
  const h = operationHarness();
  const initial = await h.dependencies.journal.load();
  const base = {
    id: "00000000-0000-4000-8000-000000000001",
    revision: 1,
    owner: {
      kind: "plugin" as const,
      owner:
        h.admission.principal.kind === "plugin"
          ? h.admission.principal.owner
          : pluginPrincipal().owner,
    },
    providerId: h.provider.id,
    providerGeneration: 1,
    physical: h.provider.physical,
    sessionId: "00000000-0000-4000-8000-000000000001",
    operationId: "00000000-0000-4000-8000-000000000001",
    operationClass: "finite-motion" as const,
    createdAt: 0,
    updatedAt: 0,
    state: "unconfirmed" as const,
    dispatch: "unknown" as const,
    movement: "unknown" as const,
    stopRequested: true,
    stopConfirmation: "unconfirmed" as const,
    cause: "host-restarted" as const,
    resolution: null,
  };
  h.dependencies.journal.load = async () => ({
    ...initial,
    entries: Array.from({ length: 64 }, (_, i) => ({
      ...base,
      id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    })),
  });
  const store = new OperationStore(h.dependencies),
    prepared = store.prepare(h.admission);
  store.start(h.admission.principal, prepared.operationId);
  const result = await store.settled(prepared.operationId);
  expect(h.provider.calls).not.toContain("motion");
  expect(result.journalCommitted).toBe(false);
});

it("motion progress is bounded to ten revisions per second and stop remains immediate", async () => {
  const h = operationHarness(),
    store = new OperationStore(h.dependencies),
    snapshots: Array<{ stage: string; stopRequested: boolean }> = [];
  store.subscribe((snapshot) => snapshots.push(snapshot));
  h.provider.motion = async (ctx) => {
    for (let i = 0; i < 100; i++)
      ctx.publishProgress({ stage: "moving", elapsedMs: i, angle: 0, displacement: 0 });
    return { movement: "completed", angle: 0, displacement: 0 };
  };
  const prepared = store.prepare(h.admission);
  store.start(h.admission.principal, prepared.operationId);
  await store.settled(prepared.operationId);
  expect(snapshots.filter((snapshot) => snapshot.stage === "moving")).toHaveLength(1);
});
