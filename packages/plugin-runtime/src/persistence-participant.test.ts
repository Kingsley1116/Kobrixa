import { expectTypeOf, it } from "vitest";
import type { ResourceOwner, DrainRequest, Handle, PersistenceResult } from "@kobrixa/plugin-protocol";
import type { DeviceDrainGrant, ReservationEnded } from "./device-resources.js";
import type { DrainReason } from "@kobrixa/plugin-protocol";
import type { PersistenceOwner, PersistenceParticipant, DrainOffer, DrainDispatcher } from "./persistence-participant.js";
import type * as Root from "./index.js";
import type * as Forms from "./settings-form-port.js";
import type * as Lifecycle from "./ui-lifecycle.js";
import type * as UiHost from "./ui-host-ports.js";
import type * as Events from "./ui-subscriptions.js";
it("exports the complete frozen form, lifecycle and diagnostics contracts", () => {
  expectTypeOf<Root.SettingsFormBinding>().toEqualTypeOf<Forms.SettingsFormBinding>();
  expectTypeOf<Root.SettingsFormPort>().toEqualTypeOf<Forms.SettingsFormPort>();
  expectTypeOf<Root.BoundSettingsService>().toEqualTypeOf<Forms.BoundSettingsService>();
  expectTypeOf<Root.ContributedSettingsForm>().toEqualTypeOf<Forms.ContributedSettingsForm>();
  expectTypeOf<Root.SettingsFieldMap>().toEqualTypeOf<Forms.SettingsFieldMap>();
  expectTypeOf<Root.Stage3RuntimePorts>().toEqualTypeOf<Lifecycle.Stage3RuntimePorts>();
  expectTypeOf<Root.Stage3HostAttachment>().toEqualTypeOf<Lifecycle.Stage3HostAttachment>();
  expectTypeOf<Root.Stage3ChannelContext>().toEqualTypeOf<Lifecycle.Stage3ChannelContext>();
  expectTypeOf<Root.Stage3ChannelBinding>().toEqualTypeOf<Lifecycle.Stage3ChannelBinding>();
  expectTypeOf<Root.UiRuntimeAttachment>().toEqualTypeOf<Lifecycle.UiRuntimeAttachment>();
  expectTypeOf<Root.OwnerRetirement>().toEqualTypeOf<Lifecycle.OwnerRetirement>();
  expectTypeOf<Root.PluginUiBridge>().toEqualTypeOf<UiHost.PluginUiBridge>();
  expectTypeOf<Root.UiCatalogPort>().toEqualTypeOf<UiHost.UiCatalogPort>();
  expectTypeOf<Root.UiBridgeEvent>().toEqualTypeOf<UiHost.UiBridgeEvent>();
  expectTypeOf<Root.FoundationDiagnostics>().toEqualTypeOf<UiHost.FoundationDiagnostics>();
  expectTypeOf<Root.FoundationCounters>().toEqualTypeOf<UiHost.FoundationCounters>();
  expectTypeOf<Root.FoundationDiagnosticEvent>().toEqualTypeOf<UiHost.FoundationDiagnosticEvent>();
  expectTypeOf<Root.UiEventLedgerPort>().toEqualTypeOf<Events.UiEventLedgerPort>();
});
it("pins the explicit 1.7 drain result projection", () => {
  expectTypeOf<DrainDispatcher>().toEqualTypeOf<(
    owner: PersistenceOwner, request: DrainRequest, signal: AbortSignal,
  ) => Promise<PersistenceResult<{status:"submitted"|"checkpoint-only";writes:Handle[]}>>>();
});
it("passes the original grant in argument four and never accepts null", () => {
  expectTypeOf<PersistenceOwner>().toEqualTypeOf<ResourceOwner>();
  expectTypeOf<PersistenceParticipant["freeze"]>().toEqualTypeOf<(
    owner: PersistenceOwner, reason: DrainReason, deadline: number,
    deviceDrain?: DeviceDrainGrant
  ) => DrainOffer>();
  expectTypeOf<PersistenceParticipant["endReservation"]>().toEqualTypeOf<(
    event: ReservationEnded, deadline: number
  ) => DrainOffer | null>();
});
function compileOnly(p: PersistenceParticipant, owner: PersistenceOwner, grant: DeviceDrainGrant) {
  p.freeze(owner, "disable", 10_000, grant);
  p.freeze(owner, "disable", 10_000);
  // @ts-expect-error null must be omitted, never forwarded
  p.freeze(owner, "disable", 10_000, null);
}
void compileOnly;
