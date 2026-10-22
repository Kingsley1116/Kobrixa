import { expect, expectTypeOf, it } from "vitest";
import { unavailableUiCatalog, type PluginUiBridge } from "./ui-host-ports.js";
import type { DeviceIntentPort, DeviceDrainGrant } from "./device-resources.js";
import type { ResourceOwner, Handle } from "@kobrixa/plugin-protocol";
import type { CoreActionTarget } from "./core-actions.js";
import type { CoreActionTarget as RootCoreActionTarget, UiEventLedgerPort as RootUiEventLedgerPort,
  Stage3HostAttachment as RootStage3HostAttachment, FoundationDiagnostics as RootFoundationDiagnostics } from "@kobrixa/plugin-runtime";
import type { UiEventLedgerPort } from "./ui-subscriptions.js";
import type { Stage3HostAttachment } from "./ui-lifecycle.js";
import type { FoundationDiagnostics } from "./ui-host-ports.js";
import type { PersistenceParticipant, DrainOffer } from "./persistence-participant.js";
import type { DrainReason } from "@kobrixa/plugin-protocol";
it("pins shared intent and optional fourth drain argument without wiring I/O", async () => {
  expectTypeOf<RootCoreActionTarget>().toEqualTypeOf<CoreActionTarget>();
  expectTypeOf<RootUiEventLedgerPort>().toEqualTypeOf<UiEventLedgerPort>();
  expectTypeOf<RootStage3HostAttachment>().toEqualTypeOf<Stage3HostAttachment>();
  expectTypeOf<RootFoundationDiagnostics>().toEqualTypeOf<FoundationDiagnostics>();
  expectTypeOf<Extract<CoreActionTarget, {kind: "device-current-stop"}>>().toEqualTypeOf<
    {kind: "device-current-stop"; sessionId: Handle}
  >();
  expectTypeOf<DeviceIntentPort["pulsePanel"]>().toEqualTypeOf<(scope: string, trustedSequence: number) => void>();
  expectTypeOf<PersistenceParticipant["freeze"]>().toEqualTypeOf<
    (owner: ResourceOwner, reason: DrainReason, deadline: number, deviceDrain?: DeviceDrainGrant) => DrainOffer
  >();
  expectTypeOf<Parameters<PluginUiBridge["invoke"]>[0]>().toMatchTypeOf<{
    nodeId: string; formRevision: number;
  }>();
  expect(await unavailableUiCatalog().catalog({})).toMatchObject({ ok: false });
});

import type { UiCatalog } from "./ui-catalog.js";
import type { UiCatalogPort } from "./ui-host-ports.js";
it("keeps the concrete catalog assignable to the one frozen catalog port", () => {
  expectTypeOf<UiCatalog>().toMatchTypeOf<UiCatalogPort>();
  expectTypeOf<UiCatalogPort["retire"]>().toEqualTypeOf<(owner: ResourceOwner) => void>();
  expectTypeOf<UiCatalogPort["resource"]>().toEqualTypeOf<PluginUiBridge["resource"]>();
});
