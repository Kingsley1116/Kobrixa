import type { Handle } from "@kobrixa/plugin-protocol";
export declare const exportDestinationBrand: unique symbol;
export type ExportDestination = { readonly [exportDestinationBrand]: true };
export interface PersistenceActionAdapter {
  chooseDestination(
    action: Handle,
    suggestedName: string,
    signal: AbortSignal,
  ): Promise<ExportDestination | null>;
  copyText(action: Handle, text: string): Promise<void>;
}
