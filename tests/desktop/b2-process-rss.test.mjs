import assert from "node:assert/strict";
import test from "node:test";
import { approval, evaluateRss, phases } from "./b2-process-rss.mjs";
function fixture(p = approval.peakBytes, r = approval.retainedBytes) {
  const markers = phases.map((phase, i) => ({
    phase,
    at: [0, 5000, 10000, 11000, 12000, 22000][i],
  }));
  const samples = Array.from({ length: 1100 }, (_, seq) => {
    const at = seq * 20,
      phase = markers.findLast((m) => m.at <= at).phase;
    return {
      phase,
      at,
      seq,
      pid: 17,
      bytes:
        at < 10000 ? 1000 + (seq % 2 ? 2 : 0) : 1001 + (at === 11000 ? p : at === 17000 ? r : 0),
    };
  });
  return { markers, samples, trailer: { at: 22000, count: samples.length } };
}
for (const [p, r, status] of [
  [0, 0, "PASS"],
  [approval.peakBytes, approval.retainedBytes, "PASS"],
  [approval.peakBytes + 1, 0, "FAIL"],
  [approval.retainedBytes + 1, approval.retainedBytes + 1, "FAIL"],
]) {
  test(`caps at ${p} / ${r}`, () =>
    assert.deepEqual(evaluateRss(fixture(p, r)), {
      status,
      baseline: 1001,
      peak: 1001 + p,
      retained: 1001 + r,
      peakDelta: p,
      retainedDelta: r,
      peakPass: p <= approval.peakBytes,
      retainedPass: r <= approval.retainedBytes,
    }));
}
for (const [reason, alter] of Object.entries({
  "missing phase": (f) => f.markers.splice(2, 1),
  "short warmup": (f) => f.markers[1].at--,
  "short baseline": (f) => f.markers[2].at--,
  "short retained": (f) => f.markers[4].at++,
  gap: (f) => (f.samples[450].at += 101),
  "skipped slot": (f) => (f.samples[60].at += 20),
  "missing sequence": (f) => f.samples[100].seq++,
  "clock reversal": (f) => (f.samples[20].at -= 21),
  "pid switch": (f) => f.samples[501].pid++,
  "wrong phase": (f) => (f.samples[500].phase = "baseline"),
  truncated: (f) => f.samples.pop(),
  "missing footer": (f) => delete f.trailer,
  "missing tail": (f) => {
    f.samples.splice(-5);
    f.trailer.count -= 5;
  },
}))
  test(reason, () => {
    const f = fixture();
    alter(f);
    assert.equal(evaluateRss(f).status, "INVALID");
  });
test("signed deltas", () => {
  const f = fixture(-3, -4);
  for (const s of f.samples) if (s.at >= 10000) s.bytes = 990;
  assert.equal(evaluateRss(f).retainedDelta, -11);
});

test("fractional even median and one spike in final five seconds", () => {
  const f = fixture(0, 0);
  for (const s of f.samples) if (s.phase === "baseline") s.bytes = 1000 + (s.seq % 2);
  f.samples.at(-1).bytes = 123456;
  assert.equal(evaluateRss(f).baseline, 1000.5);
  assert.equal(evaluateRss(f).retained, 123456);
});
