import type {
  Handle, Counter, ResourceOwner, Id, UiOwner, UiCatalogPage, UiBinding,
  UiStateSnapshot, CommandValue, LocalId, UiScalar as Scalar, UiRevokeReason,
  Result, PanelResourceV1, StatusResourceV1, UiValidationContext,
} from "@kobrixa/plugin-protocol";
export type FoundationDiagnosticEvent = {kind: "apply" | "revoke" | "stop-dispatch";
  owner: ResourceOwner; binding?: UiBinding; time: number};
export type FoundationCounters = Readonly<{owners:number; bindings:number; subscriptions:number;
  queuedEvents:number; queuedBytes:number; timers:number; pendingInvocations:number;
  actionTokens:number; resourceReaders:number; workerJobs:number}>;
export interface FoundationDiagnostics {
  snapshot(): FoundationCounters;
  onEvent(listener: (event: FoundationDiagnosticEvent) => void): () => void;
}
export type UiBridgeEvent =
  | { type: "catalog"; hostEpoch: Handle; revision: Counter; owners: UiOwner[] }
  | { type: "state"; binding: UiBinding; revision: Counter }
  | { type: "pulse"; binding: UiBinding; challenge: Handle }
  | { type: "revoked"; binding: UiBinding; reason: UiRevokeReason };
export interface PluginUiBridge {
  catalog(input: { cursor?: Handle }): Promise<Result<UiCatalogPage>>;
  resource(input: {
    sourceKey: string;
    id: Id;
    uiResourceGeneration: Counter;
    resourceDigest: string;
  }): Promise<
    Result<{
      owner: UiOwner;
      id: Id;
      version: 1;
      resource: PanelResourceV1 | StatusResourceV1;
      validationContext: UiValidationContext;
      rawBytes: number;
    }>
  >;
  open(input: {
    sourceKey: string;
    id: Id;
    uiResourceGeneration: Counter;
  }): Promise<Result<UiStateSnapshot>>;
  close(input: { binding: UiBinding }): Promise<Result<{ closed: true }>>;
  visibility(input: {
    binding: UiBinding;
    visible: boolean;
    reason: "tab" | "sidebar" | "collapse" | "document" | "window";
  }): Promise<Result<{ accepted: true }>>;
  invoke(input: {
    binding: UiBinding;
    nodeId: LocalId;
    formRevision: Counter;
    form: Record<LocalId, Scalar>;
  }): Promise<Result<CommandValue>>;
  hold(input: {
    binding: UiBinding;
    nodeId: LocalId;
    phase: "begin" | "end" | "cancel";
    inputToken: Handle;
    formRevision: Counter;
    form: Record<LocalId, Scalar>;
  }): Promise<Result<{ gesture: Handle | null }>>;
  pulse(input: {
    binding: UiBinding;
    challenge: Handle;
    gesture: Handle | null;
    inputToken: Handle | null;
  }): Promise<Result<{ accepted: true }>>;
  snapshot(input: { binding: UiBinding }): Promise<Result<UiStateSnapshot>>;
  reportFailure(input: {
    sourceKey: string;
    id: Id;
    uiResourceGeneration: Counter;
    catalogRevision: Counter;
    reason: "validation" | "renderer";
    fieldPath?: string;
  }): Promise<Result<{ accepted: boolean }>>;
  onEvent(listener: (event: UiBridgeEvent) => void): () => void;
}
export interface UiCatalogPort {
  catalog(input: { cursor?: Handle }): Promise<Result<UiCatalogPage>>;
  resource(
    input: Parameters<PluginUiBridge["resource"]>[0],
  ): ReturnType<PluginUiBridge["resource"]>;
  retire(owner: ResourceOwner): void;
  onEvent(listener: (event: UiBridgeEvent) => void): () => void;
}

export function unavailableUiCatalog(): UiCatalogPort {
  const unavailable = () => ({ ok: false as const, error: {
    code: "PLUGIN_E_PROTOCOL" as const, message: "UI catalog is not attached.",
  } });
  return { catalog: async () => unavailable(), resource: async () => unavailable(),
    retire() {}, onEvent: () => () => {} };
}
