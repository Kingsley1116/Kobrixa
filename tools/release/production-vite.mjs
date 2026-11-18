// Vite resolves mode and NODE_ENV independently. React and the JSX transform
// use the latter, even when the caller passes mode: "production".
let pending = Promise.resolve();
export function withSavedNodeEnv(operation) {
  // NODE_ENV is process-wide. Overlapping callers must restore it in order.
  const result = pending.then(async () => {
    const previous = process.env.NODE_ENV;
    try {
      return await operation();
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });
  pending = result.catch(() => {});
  return result;
}

export function buildProduction(build, config) {
  return withSavedNodeEnv(() => {
    process.env.NODE_ENV = "production";
    return build({ ...config, mode: "production" });
  });
}
