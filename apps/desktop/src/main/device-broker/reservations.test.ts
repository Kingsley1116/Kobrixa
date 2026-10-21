import { expect, it, vi } from "vitest";
import { Reservations } from "./reservations.js";
import { channel, frame, pluginPrincipal, ID } from "./fake-provider.js";
it("F12/F19/A-RF5 one end linearization preserves the original drain grant", async () => {
  let now = 0;
  const owner = pluginPrincipal().owner;
  const ended = vi.fn();
  const reservations = new Reservations(() => now);
  reservations.onEnded(ended);
  const result = await reservations.reserve({
    owner,
    sessionId: ID,
    providerGeneration: 1,
    channels: [channel()],
    sourceRevision: 1,
    check: () => {},
    fresh: async () => ({
      sessionId: ID,
      revision: 1,
      status: "fresh",
      ageMs: 2500,
      frame: frame(),
    }),
  });
  const id = result.reservation.reservationId;
  expect(reservations.validate(owner, id)).not.toBeNull();
  const first = reservations.end(id, "released", true)!;
  now = 9000;
  expect(reservations.end(id, "retired", true)).toBe(first);
  expect(first.drain?.expiresMonotonicMs).toBe(10000);
  expect(ended).toHaveBeenCalledTimes(1);
  expect(reservations.validate(owner, id)).toBeNull();
  now = 10000;
  expect(() => reservations.read(owner, id, 0, 64)).toThrow();
});
it("F07/F12 atomic admission revalidates source after await and releases all pins on failure", async () => {
  const reservations = new Reservations(() => 0);
  let valid = true,
    release!: (value: {
      sessionId: string;
      revision: number;
      status: "fresh";
      ageMs: number;
      frame: ReturnType<typeof frame>;
    }) => void;
  const input = {
    owner: pluginPrincipal().owner,
    sessionId: ID,
    providerGeneration: 1,
    channels: [channel()],
    sourceRevision: 1,
    check: () => {
      if (!valid) throw new Error("source changed");
    },
    fresh: () =>
      new Promise<{
        sessionId: string;
        revision: number;
        status: "fresh";
        ageMs: number;
        frame: ReturnType<typeof frame>;
      }>((resolve) => {
        release = resolve;
      }),
  };
  const pending = reservations.reserve(input);
  const rejected = expect(pending).rejects.toThrow("source changed");
  await expect(reservations.reserve(input)).rejects.toThrow();
  valid = false;
  release({ sessionId: ID, revision: 1, status: "fresh", ageMs: 0, frame: frame() });
  await rejected;
  expect(reservations.active).toBe(false);
});
it.each([2499, 2500, 2501])("F12 freshness %i uses inclusive sample boundary", async (age) => {
  const reservations = new Reservations(() => 0);
  const result = reservations.reserve({
    owner: pluginPrincipal().owner,
    sessionId: ID,
    providerGeneration: 1,
    channels: [channel()],
    sourceRevision: 1,
    check: () => {},
    fresh: async () => ({
      sessionId: ID,
      revision: 1,
      status: age <= 2500 ? "fresh" : "stale",
      ageMs: age,
      frame: frame(),
    }),
  });
  if (age <= 2500) expect((await result).firstFrame.sequence).toBe(1);
  else await expect(result).rejects.toThrow();
});
