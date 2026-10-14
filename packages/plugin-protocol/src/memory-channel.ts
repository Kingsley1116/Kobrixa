import type { MessageChannelLike } from "./peer.js";

/** Two connected in-memory channels for tests; delivery is asynchronous like real ports. */
export function createMemoryChannelPair(): [MessageChannelLike, MessageChannelLike] {
  const listeners = [new Set<(text: string) => void>(), new Set<(text: string) => void>()] as const;
  const end = (self: 0 | 1): MessageChannelLike => ({
    send: (text) =>
      queueMicrotask(() => listeners[self === 0 ? 1 : 0].forEach((listener) => listener(text))),
    onMessage: (listener) => {
      listeners[self].add(listener);
      return () => listeners[self].delete(listener);
    },
  });
  return [end(0), end(1)];
}
