// Wall-clock expiries cross integer-only public and durable boundaries. Keep the
// monotonic deadline untouched and never round its wall projection later.
export function wallExpiry(clock: { wall(): number; now(): number }, deadline: number): number {
  return Math.max(0, Math.floor(clock.wall() + deadline - clock.now()));
}
