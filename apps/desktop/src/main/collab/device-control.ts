import type { IpcMainInvokeEvent, WebContents } from "electron";
import { z } from "zod";

export const DEVICE_CONTROL_DENIED = "Device control is held by another collaborator.";

/**
 * Channels that write to or drive an EV3. They are rejected while the sending
 * window is in a collaboration room without holding device control. Stop
 * channels, monitoring reads and connection management stay available.
 */
const GATED_CHANNELS = new Set([
  "device:upload",
  "device:deploy",
  "device:run",
  "device:delete",
  "device:motor-test-start",
  "device:motor-test-keepalive",
  "device:set-input-mode",
]);

/** `device:files` single-entry actions that change the brick's filesystem. */
const GATED_FILE_ACTIONS = new Set(["upload", "mkdir", "rename", "delete"]);

/**
 * Per-window device-control flag reported by the renderer. `false` means the
 * window is in a room and another participant holds control; `true`/absent means
 * no restriction.
 */
export class DeviceControlGate {
  readonly #holders = new Map<number, boolean>();
  readonly #watched = new Set<number>();
  readonly #downloadPlans = new Map<number, string>();

  set(sender: Pick<WebContents, "id" | "once">, holder: boolean | null): void {
    if (holder === null) {
      this.#holders.delete(sender.id);
      return;
    }
    this.#holders.set(sender.id, holder);
    this.#watch(sender);
  }

  #watch(sender: Pick<WebContents, "id" | "once">): void {
    if (this.#watched.has(sender.id)) return;
    this.#watched.add(sender.id);
    const senderId = sender.id;
    sender.once("destroyed", () => {
      this.#holders.delete(senderId);
      this.#downloadPlans.delete(senderId);
      this.#watched.delete(senderId);
    });
  }

  /** Trust only a plan returned by the main-process file service, never renderer claims. */
  rememberBatch(sender: Pick<WebContents, "id" | "once">, snapshot: unknown): void {
    this.#watch(sender);
    this.#downloadPlans.delete(sender.id);
    if (actionOf(snapshot) === "download") {
      const key = batchKey(snapshot);
      if (key) this.#downloadPlans.set(sender.id, key);
    }
  }

  get(senderId: number): boolean | null {
    return this.#holders.get(senderId) ?? null;
  }

  /** Throws when `channel` is a device write and the sender does not hold control. */
  assert(senderId: number, channel: string, args: readonly unknown[]): void {
    if (this.#holders.get(senderId) !== false) return;
    if (
      GATED_CHANNELS.has(channel) ||
      (channel === "device:files" && gatedFileAction(args[0])) ||
      (channel === "device:files-prepare" && actionOf(args[0]) !== "download") ||
      (channel === "device:files-execute" &&
        (!batchKey(args[0]) || this.#downloadPlans.get(senderId) !== batchKey(args[0])))
    )
      throw new Error(DEVICE_CONTROL_DENIED);
  }
}

function actionOf(request: unknown): unknown {
  return request && typeof request === "object"
    ? (request as { action?: unknown }).action
    : undefined;
}

function batchKey(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const ref = value as Record<string, unknown>;
  const parts = [ref.sessionId, ref.requestId, ref.planId];
  return parts.every((part) => typeof part === "string") ? JSON.stringify(parts) : undefined;
}

function gatedFileAction(request: unknown): boolean {
  const action = actionOf(request);
  return typeof action === "string" && GATED_FILE_ACTIONS.has(action);
}

type Handle = <T extends unknown[], R>(
  channel: string,
  action: (event: IpcMainInvokeEvent, ...args: T) => R,
) => void;

/** Registers `collab:set-device-control` through the caller's trusted `handle`. */
export function registerDeviceControlIpc(
  handle: Handle,
  gate: DeviceControlGate,
  onRevoke?: () => Promise<void>,
): void {
  handle("collab:set-device-control", async (event, holder: unknown) => {
    const parsed = z.boolean().nullable().parse(holder);
    const previous = gate.get(event.sender.id);
    gate.set(event.sender, parsed);
    if (parsed === false && previous !== false) await onRevoke?.();
  });
}
