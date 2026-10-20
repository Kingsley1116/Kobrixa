import type { Handle, DispatchOutcome } from "@kobrixa/plugin-protocol";
import type { ProviderStep, ProviderCatalogPort, BuiltinDeviceProvider } from "./provider.js";
export type FakeProviderPoint = "before-exchange" | "after-exchange" | "before-stop-readback";
export interface FakeProviderControl {
  block(point: FakeProviderPoint, step: ProviderStep): void;
  reached(point: FakeProviderPoint, step: ProviderStep): Promise<void>;
  release(point: FakeProviderPoint, step: ProviderStep): void;
  trace(): readonly {step: ProviderStep; operationId: Handle; time: number; dispatch: DispatchOutcome}[];
}
export declare function createFakeDeviceProvider(input: {
  catalog: ProviderCatalogPort; now: () => number;
}): {provider: BuiltinDeviceProvider; control: FakeProviderControl};
