import { normalizeDeviceError, type DeviceSession } from "@kobrixa/device";
import type { Principal } from "@kobrixa/plugin-runtime";
import type { Handle } from "@kobrixa/plugin-protocol";
import type { LegacyOperationPort } from "./broker-port.js";
import type { LegacyProviderRequest } from "./provider.js";
import { BrokerFailure } from "./registry.js";
import { RpcError } from "@kobrixa/plugin-protocol";
import { admitLegacyExecution } from "./broker.js";
export function canFallbackAfterListing(error: unknown): boolean {
  if (error instanceof BrokerFailure || error instanceof RpcError) return false;
  if (typeof error !== "object" || error === null) return true;
  if ("name" in error && error.name === "AbortError") return false;
  if (["cancelled", "permission", "connection"].includes(normalizeDeviceError(error).category))
    return false;
  return (
    !("reason" in error) ||
    ![
      "cancelled",
      "authority-changed",
      "unbound",
      "joining",
      "unsynced",
      "not-holder",
      "viewer",
      "scope-expired",
      "disconnected",
      "connection-lost",
      "quarantined",
      "provider-disabled",
      "disabled",
      "process-lost",
      "shutting-down",
      "safe-mode",
    ].includes(String(error.reason))
  );
}
export interface LegacyFileSession extends Pick<
  DeviceSession,
  "list" | "download" | "upload" | "uploadStream" | "createDirectory" | "rename" | "delete" | "run"
> {
  confirm<T>(dialog: () => Promise<T>): Promise<T>;
  renewConfirmation(): void;
  remaining(): { idleRemainingMs: number; totalRemainingMs: number };
  cancel(): Promise<void>;
}
export class LegacyFiles {
  constructor(
    private operations: LegacyOperationPort,
    private principal: (
      operationClass: "file-read" | "file-write" | "deployment" | "program-launch",
    ) => Principal,
    private now = () => performance.now(),
  ) {}
  async run<T>(
    sessionId: Handle,
    work: (session: LegacyFileSession, signal: AbortSignal) => Promise<T>,
    operationClass: "file-read" | "file-write" | "deployment" | "program-launch" = "file-write",
  ): Promise<T> {
    const created = this.now(),
      hardDeadline = created + 600000;
    const controller = new AbortController();
    const operation = await this.operations.begin({
      principal: this.principal(operationClass),
      sessionId,
      operationClass,
      signal: controller.signal,
    });
    let idleDeadline: number | null = null,
      ended = false,
      executionAdmitted = false,
      cancelled: Promise<void> | undefined;
    let rejectExpiry!: (error: Error) => void;
    const expiry = new Promise<never>((_, reject) => {
      rejectExpiry = reject;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = (): Promise<void> => {
      if (!cancelled) {
        ended = true;
        controller.abort(new Error("File operation ended; partial device changes may remain."));
        cancelled = operation.cancel();
      }
      return cancelled!;
    };
    const assert = () => {
      if (
        ended ||
        controller.signal.aborted ||
        (!executionAdmitted && this.now() >= hardDeadline) ||
        (idleDeadline !== null && this.now() >= idleDeadline)
      )
        throw new Error("File operation expired; partial device changes may remain.");
    };
    const schedule = () => {
      clearTimeout(timer);
      if (executionAdmitted && idleDeadline === null) return;
      const deadline = Math.min(hardDeadline, idleDeadline ?? hardDeadline);
      timer = setTimeout(
        () => {
          const error = new Error("File operation expired; partial device changes may remain.");
          void cancel().catch(() => {});
          rejectExpiry(error);
        },
        Math.max(0, deadline - this.now()),
      );
    };
    const execute = async (request: LegacyProviderRequest) => {
      assert();
      if (request.kind !== "list" && !executionAdmitted) {
        admitLegacyExecution(operation);
        executionAdmitted = true;
        schedule();
      }
      const result = await operation.execute(request);
      assert();
      if (result.error || !result.value)
        throw Object.assign(
          new Error(result.error?.message ?? "Device operation outcome is unknown."),
          { reason: result.error?.reason ?? "unknown" },
        );
      return result.value;
    };
    const session: LegacyFileSession = {
      async list(remotePath, signal) {
        signal.throwIfAborted();
        const value = await execute({ kind: "list", remotePath });
        if (value.kind !== "entries") throw new Error("provider-contract");
        return value.entries;
      },
      async download(remotePath, sink, signal, progress = () => {}) {
        signal.throwIfAborted();
        await execute({
          kind: "download",
          remotePath,
          sink: async (bytes) => {
            assert();
            await sink(bytes);
            assert();
          },
          progress,
        });
      },
      async upload(remotePath, data, signal) {
        return session.uploadStream(
          remotePath,
          data.length,
          (async function* () {
            yield data;
          })(),
          signal,
        );
      },
      async uploadStream(remotePath, size, chunks, signal, progress = () => {}) {
        signal.throwIfAborted();
        const guarded = async function* () {
          for await (const bytes of chunks) {
            assert();
            yield bytes;
            assert();
          }
        };
        await execute({ kind: "upload", remotePath, size, chunks: guarded(), progress });
      },
      async createDirectory(remotePath, signal) {
        signal.throwIfAborted();
        await execute({ kind: "mkdir", remotePath });
      },
      async rename(remotePath, destination, signal) {
        signal.throwIfAborted();
        await execute({ kind: "rename", remotePath, destination });
      },
      async delete(remotePath, signal) {
        signal.throwIfAborted();
        await execute({ kind: "delete", remotePath });
      },
      async run(remotePath, signal) {
        signal.throwIfAborted();
        await execute({ kind: "run", remotePath });
      },
      async confirm(dialog) {
        assert();
        idleDeadline = Math.min(thisNow() + 120000, hardDeadline);
        operation.renewConfirmation();
        schedule();
        try {
          const value = await Promise.race([dialog(), expiry]);
          assert();
          admitLegacyExecution(operation);
          executionAdmitted = true;
          return value;
        } finally {
          idleDeadline = null;
          if (!ended) schedule();
        }
      },
      renewConfirmation() {
        assert();
        if (idleDeadline === null) throw new Error("File plan is not awaiting confirmation.");
        operation.renewConfirmation();
        idleDeadline = Math.min(thisNow() + 120000, hardDeadline);
        schedule();
      },
      remaining: () => ({
        idleRemainingMs: Math.max(0, Math.ceil((idleDeadline ?? hardDeadline) - this.now())),
        totalRemainingMs: Math.max(0, Math.ceil(hardDeadline - this.now())),
      }),
      cancel,
    };
    const thisNow = () => this.now();
    schedule();
    try {
      return await Promise.race([
        Promise.resolve().then(() => work(session, controller.signal)),
        expiry,
      ]);
    } catch (error) {
      await cancel();
      throw error;
    } finally {
      ended = true;
      clearTimeout(timer);
      await operation.finish();
    }
  }
}
