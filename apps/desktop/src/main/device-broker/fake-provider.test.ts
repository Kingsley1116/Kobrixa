import { expect, it } from "vitest";
import { createContexts } from "./provider.js";
import { operationHarness, ID } from "./fake-provider.js";
it("F09 fake provider exercises the same exchange boundary, without transport", async () => {
  const h = operationHarness();
  h.admission.lane.reserve(ID);
  const c = createContexts({
    id: ID,
    sessionId: ID,
    generation: 1,
    operationClass: "finite-motion",
    deadline: 30000,
    now: h.dependencies.now,
    lane: h.admission.lane,
    check: () => {},
    progress: () => {},
    onStop: () => {},
  });
  const result = await h.provider.executeFiniteMotion(
    h.provider.session,
    h.admission.motion,
    c.work,
  );
  expect(result.dispatch).toBe("sent");
  expect(result.value?.movement).toBe("completed");
  c.stop("cancelled", true);
  expect(
    (
      await h.provider.stopAndReadback(
        h.provider.session,
        { kind: "operation", operationId: ID },
        c.cleanup,
      )
    ).stopConfirmation,
  ).toBe("confirmed");
});

import { createFakeDeviceProvider, pluginPrincipal } from "./fake-provider.js";
import { createProviderCatalog, EventLedger } from "./registry.js";
import { IntentRegistry } from "./intent.js";
it.each(["before-exchange", "after-exchange"] as const)(
  "formal fake %s cancellation has single dispatch and original cleanup",
  async (point) => {
    const h = operationHarness(),
      fake = createFakeDeviceProvider({
        catalog: createProviderCatalog(),
        now: h.dependencies.now,
      });
    h.admission.lane.reserve(ID);
    const c = createContexts({
      id: ID,
      sessionId: ID,
      generation: 1,
      operationClass: "finite-motion",
      deadline: 30000,
      now: h.dependencies.now,
      lane: h.admission.lane,
      check: () => {},
      progress: () => {},
      onStop: () => {},
    });
    fake.control.block(point, "motion-pulse");
    const pending = fake.provider.executeFiniteMotion(
      h.provider.session,
      h.admission.motion,
      c.work,
    );
    const rejected = expect(pending).rejects.toThrow();
    await fake.control.reached(point, "motion-pulse");
    c.stop("cancelled", true);
    fake.control.release(point, "motion-pulse");
    await rejected;
    fake.control.block("before-stop-readback", "stop");
    const cleanup = fake.provider.stopAndReadback(
      h.provider.session,
      { kind: "operation", operationId: ID },
      c.cleanup,
    );
    await fake.control.reached("before-stop-readback", "stop");
    expect(c.cleanup.brakeRequired()).toBe(true);
    fake.control.release("before-stop-readback", "stop");
    expect((await cleanup).stopConfirmation).toBe("confirmed");
    const sent = fake.control.trace().filter((row) => row.dispatch === "sent");
    expect(sent.filter((row) => row.step === "motion-pulse")).toHaveLength(
      point === "before-exchange" ? 0 : 1,
    );
    expect(sent.filter((row) => row.step === "stop")).toHaveLength(1);
  },
);
it("control pressure immediately revokes motion intent before any ACK", () => {
  const owner = pluginPrincipal().owner,
    intent = new IntentRegistry(
      () => 0,
      () => {},
    ),
    scope = intent.bindMotionScope({
      owner,
      contextRef: ID,
      panelInstance: ID,
      uiResourceGeneration: 1,
      workbenchInstance: ID,
    });
  intent.pulsePanel(scope, 1);
  const events = new EventLedger(
      () => 0,
      () => {},
      (owner) => intent.retire(owner),
    ),
    row = events.create(owner);
  if (!row.ok) throw new Error("subscription");
  for (let i = 0; i < 8; i++)
    events.publish(
      owner,
      row.value.subscriptionId,
      { kind: "devices.catalog", data: { revision: i, providers: [], sessions: [] } },
      "control",
    );
  expect(() => intent.assert(owner, scope, ID)).toThrow();
  expect(events.diagnostics().queuedEvents).toBe(8);
  events.disposeOwner(owner);
});
