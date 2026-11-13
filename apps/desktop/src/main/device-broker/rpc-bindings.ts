import { RPC_ERRORS, RpcError } from "@kobrixa/plugin-protocol";
import type { Principal } from "@kobrixa/plugin-runtime";

export function ownerKey(principal: Principal): string {
  return principal.kind === "plugin"
    ? JSON.stringify([
        "plugin",
        principal.owner.sourceKey,
        principal.owner.pluginId,
        principal.owner.generation,
        principal.owner.hostEpoch,
        principal.owner.processEpoch,
      ])
    : JSON.stringify(["core", principal.adapter, principal.hostEpoch, principal.workbenchInstance]);
}
function capture(principal: Principal): Principal {
  const authorityContext = principal.authorityContext
    ? Object.freeze({ ...principal.authorityContext })
    : null;
  return principal.kind === "plugin"
    ? Object.freeze({
        kind: "plugin",
        owner: Object.freeze({ ...principal.owner }),
        authorityContext,
      })
    : Object.freeze({ ...principal, authorityContext });
}
export class DeviceRpcBinding {
  readonly #owner: string;
  #closed = false;
  constructor(private readonly principal: () => Principal) {
    this.#owner = ownerKey(principal());
  }
  capture(): Principal {
    if (this.#closed) throw new RpcError(RPC_ERRORS.connectionClosed, "Device channel closed.");
    const principal = capture(this.principal());
    if (ownerKey(principal) !== this.#owner)
      throw new RpcError(RPC_ERRORS.invalidRequest, "Device channel owner changed.");
    return principal;
  }
  close(): void {
    this.#closed = true;
  }
}
