// Observe the production close path without replacing its cleanup or disposition.
export function observeBlockedCleanup(
  logger: Pick<Console, "error">,
  fail: (error: Error) => void,
): () => void {
  const original = logger.error;
  logger.error = (...args: unknown[]) => {
    original.apply(logger, args);
    if (args[0] !== "Device cleanup blocked.") return;
    const disposition = JSON.stringify(args.slice(1), (_key, value: unknown) =>
      value instanceof Error
        ? { ...value, name: value.name, message: value.message, stack: value.stack }
        : value,
    );
    fail(new Error(`Device cleanup blocked: ${disposition}`));
  };
  return () => {
    logger.error = original;
  };
}
