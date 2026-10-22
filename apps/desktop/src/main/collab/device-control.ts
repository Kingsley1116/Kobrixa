import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import type { Principal } from "@kobrixa/plugin-runtime";
import type { IpcHandle } from "../ipc.js";
import { AuthorityContexts } from "../device-broker/authority-context.js";

export const DEVICE_CONTROL_DENIED =
  "Device control is held by another collaborator or is unavailable.";
const writes = new Set([
  "device:upload",
  "device:deploy",
  "device:run",
  "device:delete",
  "device:motor-test-start",
  "device:motor-test-keepalive",
  "device:set-input-mode",
]);
const fileWrites = new Set(["upload", "mkdir", "rename", "delete"]);
type Sender = Pick<WebContents, "id" | "once">;
const actionOf = (value: unknown): unknown =>
  value && typeof value === "object" && "action" in value ? value.action : undefined;
function batchKey(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const object = value as Record<string, unknown>;
  return ["sessionId", "requestId", "planId"].every((key) => typeof object[key] === "string")
    ? JSON.stringify([object.sessionId, object.requestId, object.planId])
    : null;
}
export class DeviceControlGate {
  readonly #watched = new Set<number>();
  readonly #downloads = new Map<number, string>();
  constructor(readonly contexts = new AuthorityContexts(randomUUID())) {}
  open(sender: Sender): { document: string } {
    if (!this.#watched.has(sender.id)) {
      this.#watched.add(sender.id);
      sender.once("destroyed", () => {
        this.invalidate(sender.id);
        this.#watched.delete(sender.id);
      });
    }
    return { document: this.contexts.open(sender.id) };
  }
  set(sender: Sender, report: unknown): void {
    this.contexts.report(sender.id, report);
  }
  invalidate(sender: number): void {
    this.#downloads.delete(sender);
    this.contexts.invalidate(sender);
  }
  principal(sender: number, adapter: Extract<Principal, { kind: "core" }>["adapter"]): Principal {
    return this.contexts.core(sender, adapter);
  }
  get(sender: number): boolean {
    try {
      const p = this.contexts.core(sender, "deployment");
      this.contexts.assertContinuation(p, p.authorityContext!.ref);
      return true;
    } catch {
      return false;
    }
  }
  rememberBatch(sender: Sender, snapshot: unknown): void {
    const key = batchKey(snapshot);
    if (actionOf(snapshot) === "download" && key) this.#downloads.set(sender.id, key);
    else this.#downloads.delete(sender.id);
  }
  assert(sender: number, channel: string, args: readonly unknown[]): void {
    const gated =
      writes.has(channel) ||
      (channel === "device:files" && fileWrites.has(String(actionOf(args[0])))) ||
      (channel === "device:files-prepare" && actionOf(args[0]) !== "download") ||
      (channel === "device:files-execute" && this.#downloads.get(sender) !== batchKey(args[0]));
    if (gated && !this.get(sender)) throw new Error(DEVICE_CONTROL_DENIED);
  }
}
export function registerDeviceControlIpc(
  handle: IpcHandle,
  gate: DeviceControlGate,
  onRevoke: () => Promise<void> = async () => {},
): void {
  handle("collab:device-control-context", (event) => gate.open(event.sender));
  handle("collab:set-device-control", async (event, report: unknown) => {
    const previous = gate.get(event.sender.id);
    gate.set(event.sender, report);
    if (previous && !gate.get(event.sender.id)) await onRevoke();
  });
}
