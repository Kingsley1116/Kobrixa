import type { CoreActionValidationPort, CoreWindowScope, CoreActionTarget, CoreActionReference } from "@kobrixa/plugin-runtime";
export interface CoreActionLedger extends CoreActionValidationPort {
  mint(scope: CoreWindowScope, target: CoreActionTarget): CoreActionReference;
  retire(scope: CoreWindowScope): void;
}
export declare function createCoreActionLedger(input: {
  now: () => number; current: (scope: CoreWindowScope) => boolean;
}): CoreActionLedger;
