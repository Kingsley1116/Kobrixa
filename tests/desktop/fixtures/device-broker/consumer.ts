import { readFileSync } from "node:fs";
import { definePlugin, runPlugin } from "@kobrixa/plugin-sdk";

const fixture = JSON.parse(readFileSync("fixture.json", "utf8")) as {
  contextRef: string;
  motionScopeRef: string;
  negotiateOnly?: boolean;
  expectedSatisfied?: boolean;
  expectedRpcError?: number;
  subscriptionProbe?: string;
  eventTimeoutMs?: number;
};
function value<T>(
  result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } },
): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}
void runPlugin(
  definePlugin({
    activate(context) {
      context.commands.register("kobrixa-fixture.devices.probe", async () => {
        const scenario: string[] = [];
        const devices = context.devices;
        let negotiated;
        try {
          negotiated = value(await devices.negotiate());
        } catch (error) {
          if (
            fixture.expectedRpcError !== undefined &&
            error instanceof Error &&
            "code" in error &&
            error.code === fixture.expectedRpcError
          ) {
            await context.ui.showMessage(JSON.stringify({ ok: true, rpcError: error.code }));
            return;
          }
          throw error;
        }
        if (fixture.expectedRpcError !== undefined)
          throw new Error("Host accepted hostile requirements");
        if (negotiated.devicesContractVersion !== 1) throw new Error("Wrong contract version");
        if (fixture.subscriptionProbe) {
          const abort = new AbortController();
          let deliveries = 0;
          const pending = devices
            .subscribe(
              { topic: "catalog" },
              () => {
                deliveries++;
              },
              abort.signal,
            )
            .then(
              (result) => ({ result }),
              (error: unknown) => ({ error }),
            );
          if (fixture.subscriptionProbe === "subscribe-cancel") {
            await context.ui.showMessage(JSON.stringify({ readyToCancel: true }));
            abort.abort();
          }
          const outcome = await pending;
          if ("error" in outcome) {
            const error = outcome.error;
            if (!(error instanceof Error) || !("code" in error)) throw error;
            await context.ui.showMessage(
              JSON.stringify({ ok: true, rpcError: error.code, deliveries }),
            );
          } else if (!outcome.result.ok) {
            await context.ui.showMessage(
              JSON.stringify({ ok: true, businessError: outcome.result.error.code, deliveries }),
            );
          } else {
            await context.ui.showMessage(JSON.stringify({ eventBarrier: true }));
            await outcome.result.value.dispose();
            await context.ui.showMessage(
              JSON.stringify({ ok: true, subscribed: true, deliveries }),
            );
          }
          return;
        }
        if (fixture.negotiateOnly) {
          if (negotiated.requirementsSatisfied !== fixture.expectedSatisfied)
            throw new Error("Requirements mismatch");
          await context.ui.showMessage(JSON.stringify({ ok: true, negotiated }));
          return;
        }
        scenario.push("negotiate");
        const listed = value(await devices.list({}));
        const sessionId = listed.sessions[0]?.sessionId;
        if (!sessionId) throw new Error("Trusted host did not connect its fixture");
        scenario.push("list");
        const { sources } = value(await devices.session({ sessionId }));
        scenario.push("session");
        const channelIds = sources.channels.slice(0, 4).map((channel) => channel.channelId);
        value(await devices.read({ sessionId, channelIds, freshness: "fresh" }));
        scenario.push("read");
        type Event = Parameters<Parameters<typeof devices.subscribe>[1]>[0];
        let delivered!: (event: Event) => void;
        const received = new Promise<Event>((resolve) => {
          delivered = resolve;
        });
        const subscription = value(
          await devices.subscribe(
            { topic: "telemetry", sessionId, channelIds, intervalMs: 500 },
            delivered,
          ),
        );
        scenario.push("subscribe");
        let timer: ReturnType<typeof setTimeout> | undefined;
        let eventReceipt: object | undefined;
        try {
          const event = await Promise.race([
            received,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("SDK telemetry event deadline")),
                fixture.eventTimeoutMs ?? 5000,
              );
            }),
          ]);
          clearTimeout(timer);
          if (
            event.kind !== "devices.telemetry" ||
            event.subscriptionId !== subscription.subscriptionId ||
            event.data.sessionId !== sessionId ||
            event.data.frames.length === 0 ||
            !Number.isSafeInteger(event.sequence) ||
            event.sequence <= 0
          )
            throw new Error("Unexpected SDK telemetry event");
          eventReceipt = {
            kind: event.kind,
            subscriptionId: event.subscriptionId,
            sequence: event.sequence,
            sessionId,
            owner: event.owner,
          };
          const portId = sources.channels[0]!.portId!;
          const modes = value(
            await devices.inputModes.query({
              sessionId,
              portId,
              expectedSourceRevision: sources.sourceRevision,
            }),
          );
          scenario.push("mode-query");
          const changed = value(
            await devices.inputModes.set({
              sessionId,
              portId,
              expectedSourceRevision: modes.sourceRevision,
              modeId: modes.modes[0]!.modeId,
              contextRef: fixture.contextRef,
            }),
          );
          scenario.push("mode-set");
          const freshChannels = changed.sources.channels
            .slice(0, 4)
            .map((channel) => channel.channelId);
          const reserved = value(
            await devices.recording.reserve({
              sessionId,
              channelIds: freshChannels,
              expectedSourceRevision: changed.sources.sourceRevision,
            }),
          );
          scenario.push("reserve");
          value(
            await devices.recording.read({
              reservationId: reserved.reservation.reservationId,
              afterSequence: 0,
              limit: 64,
            }),
          );
          scenario.push("recording-read");
          value(
            await devices.recording.release({ reservationId: reserved.reservation.reservationId }),
          );
          scenario.push("release");
          const prepared = value(
            await devices.motion.prepare({
              sessionId,
              contextRef: fixture.contextRef,
              motionScopeRef: fixture.motionScopeRef,
              motion: {
                mode: "timed",
                actuatorId: changed.sources.actuators[0]!.actuatorId,
                power: 1,
                direction: 1,
                brake: false,
                durationMs: 100,
              },
            }),
          );
          const operationId = prepared.operation.operationId;
          scenario.push("prepare");
          value(await devices.motion.start({ operationId }));
          scenario.push("start");
          value(await devices.motion.stop({ operationId, stopMode: "brake" }));
          scenario.push("stop");
          const deadline = performance.now() + 20_000;
          let operation = value(await devices.motion.query({ operationId })).operation;
          while (["preparing", "running", "stopping"].includes(operation.phase)) {
            if (performance.now() >= deadline) throw new Error("Fixture stop did not settle");
            await new Promise((resolve) => setTimeout(resolve, 10));
            operation = value(await devices.motion.query({ operationId })).operation;
          }
          if (operation.stopConfirmation !== "confirmed" && operation.dispatch !== "not-sent")
            throw new Error("Fixture has unresolved stop outcome");
          scenario.push("query");
        } finally {
          clearTimeout(timer);
          await subscription.dispose();
          await subscription.dispose();
        }
        scenario.push("unsubscribe");
        await context.ui.showMessage(JSON.stringify({ ok: true, scenario, eventReceipt }));
      });
    },
  }),
);
