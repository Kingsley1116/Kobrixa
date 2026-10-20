import { expectTypeOf, it } from "vitest";
import type { FaultJournalDocument } from "@kobrixa/plugin-runtime";
import type { JournalPort, DeviceRecoverySnapshot } from "./journal-port.js";
it("freezes the single journal result and subscription surface", () => {
  expectTypeOf<JournalPort["load"]>().toEqualTypeOf<() => Promise<FaultJournalDocument>>();
  expectTypeOf<JournalPort["commit"]>().toEqualTypeOf<(document: FaultJournalDocument) => Promise<void>>();
  expectTypeOf<JournalPort["subscribe"]>().toEqualTypeOf<(listener: (snapshot: DeviceRecoverySnapshot) => void) => () => void>();
});
