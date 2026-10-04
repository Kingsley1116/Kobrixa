import type { DeviceErrorCategory } from "./contracts.js";

export class DeviceOperationError extends Error {
  readonly name = "DeviceOperationError";

  constructor(
    readonly category: DeviceErrorCategory,
    message: string,
    readonly recoverable = true,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function normalizeDeviceError(
  error: unknown,
  fallback: DeviceErrorCategory = "internal",
): DeviceOperationError {
  if (error instanceof DeviceOperationError) return error;
  if (error instanceof Error && error.name === "AbortError")
    return new DeviceOperationError("cancelled", "Operation cancelled.", true, { cause: error });
  const code = error instanceof Error && "code" in error ? String(error.code) : "";
  if (["EACCES", "EPERM"].includes(code))
    return new DeviceOperationError(
      "permission",
      "Permission to access the EV3 was denied.",
      true,
      { cause: error },
    );
  if (["ECONNREFUSED", "ECONNRESET", "EPIPE", "ENOTCONN"].includes(code))
    return new DeviceOperationError("connection", "The EV3 connection was lost or refused.", true, {
      cause: error,
    });
  if (code === "ETIMEDOUT")
    return new DeviceOperationError("timeout", "The EV3 operation timed out.", true, {
      cause: error,
    });
  return new DeviceOperationError(
    fallback,
    error instanceof Error ? error.message : "Unknown device failure.",
    true,
    { cause: error },
  );
}

export async function withTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  if (signal.aborted)
    throw new DeviceOperationError("cancelled", "Operation cancelled.", true, {
      cause: signal.reason,
    });
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DeviceOperationError("timeout", "Operation timed out.")),
    timeoutMs,
  );
  const abort = (): void => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await work(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      if (signal.aborted)
        throw new DeviceOperationError("cancelled", "Operation cancelled.", true, { cause: error });
      throw new DeviceOperationError("timeout", "Operation timed out.", true, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}
