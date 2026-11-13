import { expectTypeOf, it } from "vitest";
import type { ResourceOwner } from "@kobrixa/plugin-protocol";
import type {
  DeviceResourceParticipant,
  RetirementReason,
  DeviceDrainGrant,
  DeviceDisposition,
  ReservationBindingPort,
  ReservationEnded,
  DeviceSessionControlPort,
  SessionQuiesceCause,
  SessionQuiescence,
} from "./device-resources.js";
it("F19 retire returns synchronously with the original nullable grant", () => {
  expectTypeOf<DeviceResourceParticipant["retire"]>().toEqualTypeOf<
    (
      owner: ResourceOwner,
      reason: RetirementReason,
    ) => {
      drain: DeviceDrainGrant | null;
      settled: Promise<DeviceDisposition>;
    }
  >();
  expectTypeOf<ReservationBindingPort["onEnded"]>().toEqualTypeOf<
    (listener: (event: ReservationEnded) => void) => () => void
  >();
  expectTypeOf<DeviceSessionControlPort["quiesce"]>().toEqualTypeOf<
    (sessionId: string, cause: SessionQuiesceCause) => SessionQuiescence
  >();
});

it("F19 retire revokes synchronously and returns the original optional grant", () => {
  expectTypeOf<DeviceResourceParticipant["retire"]>().toEqualTypeOf<
    (
      owner: ResourceOwner,
      reason: RetirementReason,
    ) => { drain: DeviceDrainGrant | null; settled: Promise<DeviceDisposition> }
  >();
});
