// Timestamps are milliseconds on process.hrtime's monotonic clock, shared by isolates.
export const contract = "b2-process-rss/v1";
export const approval = Object.freeze({
  contract,
  owner: "Kingsley1116",
  date: "2026-11-18",
  peakBytes: 41943040,
  retainedBytes: 16777216,
});
export const phases = ["warmup", "baseline", "work", "cleanup", "idle", "end"];
export function evaluateRss(input) {
  const { markers, samples, trailer } = input ?? {};
  const invalid = (reason) => ({ status: "INVALID", reason });
  if (
    !Array.isArray(markers) ||
    markers.length !== phases.length ||
    !markers.every(
      (m, i) =>
        m?.phase === phases[i] &&
        Number.isFinite(m.at) &&
        m.at >= 0 &&
        (!i || m.at > markers[i - 1].at),
    )
  )
    return invalid("missing or unordered phase");
  const [start, baseline, work, , idle, end] = markers.map((m) => m.at);
  if (baseline !== start + 5000 || work !== start + 10000 || end !== idle + 10000)
    return invalid("wrong warmup, baseline or retained idle duration");
  if (
    !Array.isArray(samples) ||
    !samples.length ||
    trailer?.count !== samples.length ||
    trailer.at !== end
  )
    return invalid("missing or truncated sample stream");
  const baselineValues = [];
  let peak = -Infinity,
    retained = -Infinity,
    phase = 0;
  const pid = samples[0]?.pid;
  if (!Number.isSafeInteger(pid) || pid < 1) return invalid("missing PID");
  for (const [i, s] of samples.entries()) {
    if (
      !s ||
      s.seq !== i ||
      s.pid !== pid ||
      !Number.isSafeInteger(s.bytes) ||
      s.bytes <= 0 ||
      !Number.isFinite(s.at) ||
      s.at < start ||
      s.at > end ||
      (i && (s.at <= samples[i - 1].at || s.at - samples[i - 1].at > 100))
    )
      return invalid("invalid sequence, PID, clock, gap or RSS");
    // Never fill a missed tick with back-to-back catch-up observations.
    if (Math.floor((s.at - start) / 20) !== i) return invalid("missing or duplicate 20 ms slot");
    while (phase < phases.length - 2 && s.at >= markers[phase + 1].at) phase++;
    if (s.phase !== phases[phase]) return invalid("sample phase disagrees with markers");
    if (s.at >= work - 5000 && s.at < work) baselineValues.push(s.bytes);
    if (s.at >= work) peak = Math.max(peak, s.bytes);
    if (s.at >= end - 5000) retained = Math.max(retained, s.bytes);
  }
  if (
    end - samples.at(-1).at > 20 ||
    !baselineValues.length ||
    !Number.isFinite(retained) ||
    markers.some((m) => !samples.some((s) => Math.abs(m.at - s.at) <= 100))
  )
    return invalid("uncovered window or endpoint");
  baselineValues.sort((a, b) => a - b);
  const mid = Math.floor(baselineValues.length / 2);
  const b =
    baselineValues.length % 2
      ? baselineValues[mid]
      : baselineValues[mid - 1] + (baselineValues[mid] - baselineValues[mid - 1]) / 2;
  const peakDelta = peak - b,
    retainedDelta = retained - b;
  const peakPass = peakDelta <= approval.peakBytes,
    retainedPass = retainedDelta <= approval.retainedBytes;
  return {
    status: peakPass && retainedPass ? "PASS" : "FAIL",
    baseline: b,
    peak,
    retained,
    peakDelta,
    retainedDelta,
    peakPass,
    retainedPass,
  };
}
