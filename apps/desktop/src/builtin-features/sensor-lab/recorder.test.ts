import { afterEach, expect, it, vi } from "vitest";
import { setup, ok, fail, id, deferred } from "./recorder-fixture.js";
afterEach(() => vi.useRealTimers());
it("uses initial receipt then checkpoint acknowledgement, keeps payload UUID separate and dedupes firstFrame", async () => {
  vi.useFakeTimers();
  const f = setup();
  await f.recorder.start(f.options);
  expect(f.recorder.state.phase).toBe("recording");
  expect(f.recorder.snapshot?.frames[0]).toMatchObject({
    elapsedMs: 0,
    sessionElapsedMs: 2_000_000,
    sequence: 10,
  });
  expect(f.recorder.snapshot?.id).not.toBe(f.recorder.state.record?.id);
  expect(f.storage.registerCheckpoint).toHaveBeenCalledWith(
    { id: id(50), expectedRevision: `r_${"1".padStart(32, "0")}`, reservation: id(1) },
    expect.any(AbortSignal),
  );
  vi.mocked(f.recording.read).mockResolvedValueOnce(
    ok({
      reservation: f.recorder.state.reservation!,
      frames: [f.frame(10), f.frame(11)],
      gap: null,
      nextSequence: 11,
      hasMore: false,
    }),
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(f.recorder.snapshot?.frames.map((x) => x.sequence)).toEqual([10, 11]);
  expect(f.recording.read).toHaveBeenCalledWith(
    { reservationId: id(1), afterSequence: 10, limit: 64 },
    expect.any(AbortSignal),
  );
  f.recorder.dispose();
});
it("a no-frame monotonic 30 minute deadline releases and only host drain finalizes", async () => {
  vi.useFakeTimers();
  const f = setup();
  await f.recorder.start(f.options);
  f.time(1_800_000);
  await vi.advanceTimersByTimeAsync(1_800_000);
  expect(f.recording.release).toHaveBeenCalledOnce();
  expect(f.recorder.snapshot?.reason).toBeUndefined();
  const result = await f.recorder.drain(f.drain());
  expect(result).toMatchObject({
    ok: true,
    value: { status: "submitted", writes: [expect.any(String)] },
  });
  expect(f.recorder.snapshot).toMatchObject({
    reason: "limit",
    durationMs: 1_800_000,
    frameCount: 1,
  });
  expect(f.storage.flush).not.toHaveBeenCalled();
  expect(f.recorder.state.phase).toBe("submitted");
  f.recorder.dispose();
});
it.each(["save", "register"])(
  "%s failure releases and preserves confirmed evidence",
  async (mode) => {
    vi.useFakeTimers();
    const f = setup();
    if (mode === "save") vi.mocked(f.storage.beginWrite).mockResolvedValueOnce(fail());
    else vi.mocked(f.storage.registerCheckpoint).mockResolvedValueOnce(fail());
    await expect(f.recorder.start(f.options)).rejects.toThrow();
    expect(f.recording.release).toHaveBeenCalledOnce();
    expect(f.recorder.state.phase).toBe("error");
    expect(!!f.recorder.state.record).toBe(mode === "register");
    await expect(f.recorder.start(f.options)).rejects.toThrow();
    f.recorder.dispose();
  },
);
it("end during checkpoint registration never reports recording ready", async () => {
  vi.useFakeTimers();
  const f = setup();
  const pending = deferred<Awaited<ReturnType<typeof f.storage.registerCheckpoint>>>();
  vi.mocked(f.storage.registerCheckpoint).mockReturnValueOnce(pending.promise);
  const start = f.recorder.start(f.options);
  await vi.waitFor(() => expect(f.storage.registerCheckpoint).toHaveBeenCalledOnce());
  f.end("disconnected");
  pending.resolve(ok({ checkpoint: id(60) }));
  await start;
  expect(f.recorder.state.phase).toBe("ended");
  expect(f.recording.read).not.toHaveBeenCalled();
  expect((await f.recorder.drain(f.drain())).ok).toBe(true);
  expect(f.recorder.snapshot?.reason).toBe("disconnected");
  f.recorder.dispose();
});
it("checkpoint scheduling is single-flight without full-record queue", async () => {
  vi.useFakeTimers();
  const f = setup();
  await f.recorder.start(f.options);
  const pending = deferred<Awaited<ReturnType<typeof f.storage.commitWrite>>>();
  const real = vi.mocked(f.storage.commitWrite).getMockImplementation()!;
  vi.mocked(f.storage.commitWrite).mockImplementationOnce(() => pending.promise);
  await vi.advanceTimersByTimeAsync(5000);
  await vi.advanceTimersByTimeAsync(15000);
  expect(f.storage.beginWrite).toHaveBeenCalledTimes(2);
  const call = vi.mocked(f.storage.commitWrite).mock.calls[1]!;
  pending.resolve(await real(...call));
  await vi.advanceTimersByTimeAsync(0);
  expect(f.storage.beginWrite).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.storage.beginWrite).toHaveBeenCalledTimes(3);
  f.recorder.dispose();
});
it("drain uses its independent signal after disposal and consumes exactly the fixed lastSequence", async () => {
  vi.useFakeTimers();
  const f = setup();
  await f.recorder.start(f.options);
  f.append(f.frame(11));
  f.end("renderer-lost");
  const grant = f.drain("shutdown");
  f.append(f.frame(12));
  f.recorder.dispose();
  const result = await f.recorder.drain(grant);
  expect(result.ok).toBe(true);
  expect(f.recorder.snapshot?.frames.map((x) => x.sequence)).toEqual([10, 11]);
  expect(f.recorder.snapshot?.reason).toBe("interrupted");
  expect(f.recording.read).toHaveBeenCalledWith(
    { reservationId: id(1), afterSequence: 10, limit: 64 },
    grant.signal,
  );
  expect(grant.signal.aborted).toBe(false);
  expect(f.recorder.state.end?.reservation.reason).toBe("renderer-lost");
});
it.each([
  ["source-changed", "source-changed"],
  ["overflow", "interrupted"],
  ["renderer-lost", "interrupted"],
  ["suspended", "suspend"],
  ["retired", "update"],
] as const)("host %s overrides a feature limit", async (host, payload) => {
  vi.useFakeTimers();
  const f = setup();
  await f.recorder.start(f.options);
  f.time(1_800_000);
  await vi.advanceTimersByTimeAsync(1_800_000);
  f.end(host);
  await f.recorder.drain(f.drain("update"));
  expect(f.recorder.snapshot?.reason).toBe(payload);
  expect(f.recorder.state.end?.reservation.reason).toBe(host);
  f.recorder.dispose();
});
it("old timers cannot release an explicitly started new reservation", async () => {
  vi.useFakeTimers();
  const f = setup();
  await f.recorder.start(f.options);
  await f.recorder.stop();
  await f.recorder.drain(f.drain());
  f.time(1000);
  await vi.advanceTimersByTimeAsync(1000);
  f.next();
  await f.recorder.start(f.options);
  vi.mocked(f.recording.release).mockClear();
  f.time(1_800_000);
  await vi.advanceTimersByTimeAsync(1_799_000);
  expect(f.recording.release).not.toHaveBeenCalled();
  f.time(1_801_000);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.recording.release).toHaveBeenCalledExactlyOnceWith({ reservationId: id(5) });
  f.recorder.dispose();
});
it("checkpoint failure releases and retains unresolved write rather than claiming saved/retryable", async () => {
  vi.useFakeTimers();
  const f = setup();
  await f.recorder.start(f.options);
  vi.mocked(f.storage.commitWrite).mockRejectedValueOnce(new Error("lost checkpoint reply"));
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.recording.release).toHaveBeenCalledOnce();
  expect(f.recorder.state.pendingWrite).not.toBeNull();
  expect(f.recorder.state.phase).toBe("error");
  const result = await f.recorder.drain(f.drain());
  expect(result.ok).toBe(false);
  expect(f.recorder.state.phase).toBe("error");
  expect(f.recorder.state.pendingWrite).not.toBeNull();
  f.recorder.dispose();
});

it("frame cap fixes limit before release and includes exactly 3600 unique frames", async () => {
  vi.useFakeTimers();
  const f = setup();
  await f.recorder.start(f.options);
  for (let n = 11; n < 3615; n++) f.append(f.frame(n));
  await vi.advanceTimersByTimeAsync(0);
  for (let n = 0; n < 65 && f.recorder.state.phase === "recording"; n++)
    await vi.advanceTimersByTimeAsync(1);
  expect(f.recorder.snapshot?.frameCount).toBe(3600);
  expect(f.recording.release).toHaveBeenCalledOnce();
  expect(f.recorder.snapshot?.reason).toBeUndefined();
  expect((await f.recorder.drain(f.drain())).ok).toBe(true);
  expect(f.recorder.snapshot?.reason).toBe("limit");
  expect(f.recorder.snapshot?.frameCount).toBe(3600);
  f.recorder.dispose();
});
it.each(["session", "revision", "not-ready", "duplicate"])(
  "rejects %s sources before reservation",
  async (mode) => {
    vi.useFakeTimers();
    const f = setup();
    const source = f.options.channels[0]!.source;
    if (source.origin !== "public") throw new Error("fixture");
    if (mode === "session") source.provenance.sessionId = id(90);
    if (mode === "revision") source.provenance.sourceRevision = 8;
    if (mode === "not-ready") source.channel.state = "error";
    if (mode === "duplicate") f.options.channels.push(structuredClone(f.options.channels[0]!));
    await expect(f.recorder.start(f.options)).rejects.toThrow();
    expect(f.recording.reserve).not.toHaveBeenCalled();
    f.recorder.dispose();
  },
);
it("drain during registration uses host checkpoint evidence even when its ack is aborted", async () => {
  vi.useFakeTimers();
  const f = setup();
  const called = deferred<void>();
  vi.mocked(f.storage.registerCheckpoint).mockImplementationOnce(
    (_p, signal) =>
      new Promise((_r, reject) => {
        called.resolve();
        signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
      }),
  );
  const starting = f.recorder.start(f.options);
  const caught = starting.catch(() => {});
  await called.promise;
  f.end("disconnected");
  const result = await f.recorder.drain(f.drain());
  await caught;
  expect(result.ok).toBe(true);
  expect(f.recorder.state.phase).toBe("submitted");
  expect(f.recorder.snapshot?.reason).toBe("disconnected");
  f.recorder.dispose();
});
it("a pending poll is aborted before the drain becomes the only read consumer", async () => {
  vi.useFakeTimers();
  const f = setup();
  await f.recorder.start(f.options);
  let primary: AbortSignal | undefined;
  vi.mocked(f.recording.read).mockImplementationOnce(
    (_p, signal) =>
      new Promise((_r, reject) => {
        primary = signal;
        signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
      }),
  );
  await vi.advanceTimersByTimeAsync(0);
  f.append(f.frame(11));
  f.end("released");
  const drain = f.drain();
  expect((await f.recorder.drain(drain)).ok).toBe(true);
  expect(primary?.aborted).toBe(true);
  expect(vi.mocked(f.recording.read).mock.calls.at(-1)?.[1]).toBe(drain.signal);
  expect(f.recorder.snapshot?.frameCount).toBe(2);
  f.recorder.dispose();
});
it("drain failure cannot advertise a final write or saved state", async () => {
  vi.useFakeTimers();
  const f = setup();
  await f.recorder.start(f.options);
  await f.recorder.stop();
  vi.mocked(f.storage.commitWrite).mockRejectedValueOnce(new Error("final reply lost"));
  const result = await f.recorder.drain(f.drain());
  expect(result.ok).toBe(false);
  expect(result).not.toHaveProperty("value.writes");
  expect(f.recorder.state.phase).toBe("error");
  expect(f.recorder.state.pendingWrite).not.toBeNull();
  expect(f.storage.flush).not.toHaveBeenCalled();
  f.recorder.dispose();
});

it("a late drain from the preceding reservation cannot abort a new recording", async () => {
  vi.useFakeTimers();
  const f = setup();
  await f.recorder.start(f.options);
  await f.recorder.stop();
  const old = f.drain();
  await f.recorder.drain(old);
  f.next();
  await f.recorder.start(f.options);
  expect((await f.recorder.drain(old)).ok).toBe(false);
  expect(f.recorder.state.phase).toBe("recording");
  expect(f.recorder.state.reservation?.reservationId).toBe(id(5));
  f.recorder.dispose();
});
it("an explicit Stop can retry an uncertain release without writing a final payload", async () => {
  vi.useFakeTimers();
  const f = setup();
  await f.recorder.start(f.options);
  vi.mocked(f.recording.release).mockRejectedValueOnce(new Error("release reply lost"));
  await f.recorder.stop();
  expect(f.recorder.state.phase).toBe("error");
  await f.recorder.stop();
  expect(f.recording.release).toHaveBeenCalledTimes(2);
  expect(f.recorder.snapshot?.reason).toBeUndefined();
  f.recorder.dispose();
});

it("a committed checkpoint with lost reply reconciles its original identity before final CAS", async () => {
  vi.useFakeTimers();
  const f = setup();
  await f.recorder.start(f.options);
  const real = vi.mocked(f.storage.commitWrite).getMockImplementation()!;
  vi.mocked(f.storage.commitWrite).mockImplementationOnce(async (...args) => {
    await real(...args);
    throw new Error("committed reply lost");
  });
  await vi.advanceTimersByTimeAsync(5000);
  const pending = f.recorder.state.pendingWrite;
  expect(pending).not.toBeNull();
  const result = await f.recorder.drain(f.drain());
  expect(result).toMatchObject({ ok: true, value: { status: "submitted" } });
  const calls = vi.mocked(f.storage.commitWrite).mock.calls;
  expect(calls.some(([p]) => p.write === pending && p.drainToken !== undefined)).toBe(false);
  const final = vi.mocked(f.storage.beginWrite).mock.calls.at(-1)![0];
  expect(final).toMatchObject({
    target: { mode: "replace", expectedRevision: `r_${"2".padStart(32, "0")}` },
    checkpoint: { handle: id(60), phase: "final" },
    drainToken: id(70),
  });
  if (result.ok) {
    expect(result.value.writes).toEqual([id(103)]);
    expect(result.value.writes).not.toContain(pending);
  }
  f.recorder.dispose();
});

it("corrected preflight inputs can explicitly retry, but an unknown reserve cannot replay Start", async () => {
  vi.useFakeTimers();
  const f = setup();
  await expect(f.recorder.start({ ...f.options, name: "" })).rejects.toThrow();
  await f.recorder.start(f.options);
  expect(f.recorder.state.phase).toBe("recording");
  f.recorder.dispose();
  const other = setup();
  vi.mocked(other.recording.reserve).mockRejectedValueOnce(new Error("reserve reply lost"));
  await expect(other.recorder.start(other.options)).rejects.toThrow();
  await expect(other.recorder.start(other.options)).rejects.toThrow();
  expect(other.recording.reserve).toHaveBeenCalledOnce();
  other.recorder.dispose();
});

it("permits a fresh explicit Start after a definite not-sent reserve rejection", async () => {
  vi.useFakeTimers();
  const f = setup();
  vi.mocked(f.recording.reserve).mockResolvedValueOnce({
    ok: false,
    error: {
      code: "PLUGIN_E_DEVICE_BUSY",
      message: "Busy",
      detail: {
        kind: "device",
        reason: "recording",
        dispatch: "not-sent",
        stopConfirmation: "not-required",
      },
    },
  });
  await expect(f.recorder.start(f.options)).rejects.toThrow("Busy");
  expect(f.recorder.state.reservation).toBeNull();
  expect(f.recording.reserve).toHaveBeenCalledTimes(1);
  await f.recorder.start(f.options);
  expect(f.recording.reserve).toHaveBeenCalledTimes(2);
  expect(f.recorder.state.phase).toBe("recording");
  f.recorder.dispose();
});

it("checks full history before reserve and allows an explicit retry after space is freed", async () => {
  vi.useFakeTimers();
  const f = setup();
  vi.mocked(f.storage.list).mockResolvedValueOnce(ok({ entries: Array(50).fill({}) }));
  await expect(f.recorder.start(f.options)).rejects.toThrow(/history/i);
  expect(f.recording.reserve).not.toHaveBeenCalled();
  expect(f.recording.release).not.toHaveBeenCalled();
  expect(f.storage.beginWrite).not.toHaveBeenCalled();
  await f.recorder.start(f.options);
  expect(f.recording.reserve).toHaveBeenCalledOnce();
  expect(f.storage.list).toHaveBeenCalledTimes(3); // failed preflight, fresh preflight, writer recheck
  expect(f.recorder.state.phase).toBe("recording");
  f.recorder.dispose();
});

it("Stop releases a known reservation before a pending register acknowledgement", async () => {
  vi.useFakeTimers();
  const f = setup();
  const registered = deferred<Awaited<ReturnType<typeof f.storage.registerCheckpoint>>>();
  vi.mocked(f.storage.registerCheckpoint).mockReturnValueOnce(registered.promise);
  const starting = f.recorder.start(f.options);
  await vi.waitFor(() => expect(f.storage.registerCheckpoint).toHaveBeenCalledOnce());
  const stopping = f.recorder.stop();
  expect(f.recording.release).toHaveBeenCalledExactlyOnceWith({ reservationId: id(1) });
  await stopping;
  registered.resolve(ok({ checkpoint: id(60) }));
  await starting;
  expect(f.recorder.state.phase).toBe("ended");
  expect(f.recorder.state.checkpoint).toBe(id(60));
  expect(f.recording.read).not.toHaveBeenCalled();
  expect(f.storage.beginWrite).toHaveBeenCalledOnce();
  expect((await f.recorder.drain(f.drain())).ok).toBe(true);
  f.recorder.dispose();
});

it.each(["sent", "unknown"] as const)("keeps a %s reserve failure fenced", async (dispatch) => {
  vi.useFakeTimers();
  const f = setup();
  vi.mocked(f.recording.reserve).mockResolvedValueOnce({
    ok: false,
    error: {
      code: "PLUGIN_E_DEVICE_OPERATION",
      message: "Unresolved reserve",
      detail: { kind: "device", reason: "recording", dispatch, stopConfirmation: "unconfirmed" },
    },
  });
  await expect(f.recorder.start(f.options)).rejects.toThrow();
  await expect(f.recorder.start(f.options)).rejects.toThrow(/unresolved/);
  expect(f.recording.reserve).toHaveBeenCalledOnce();
  f.recorder.dispose();
});

it("rejects insufficient estimated initial capacity before reserving and rechecks actual capacity in writer", async () => {
  vi.useFakeTimers();
  const f = setup();
  const quota = await f.storage.quota({});
  if (!quota.ok) throw Error("fixture");
  vi.mocked(f.storage.quota).mockClear();
  vi.mocked(f.storage.quota).mockResolvedValueOnce(ok({ ...quota.value, hostAvailableBytes: 1 }));
  await expect(f.recorder.start(f.options)).rejects.toThrow(/quota/i);
  expect(f.recording.reserve).not.toHaveBeenCalled();
  await f.recorder.start(f.options);
  expect(f.storage.quota).toHaveBeenCalledTimes(3);
  expect(vi.mocked(f.storage.quota).mock.invocationCallOrder[1]).toBeLessThan(
    vi.mocked(f.recording.reserve).mock.invocationCallOrder[0]!,
  );
  expect(vi.mocked(f.storage.quota).mock.invocationCallOrder[2]).toBeGreaterThan(
    vi.mocked(f.recording.reserve).mock.invocationCallOrder[0]!,
  );
  f.recorder.dispose();
});

it("Stop releases immediately while initial commit is pending and preserves its late receipt", async () => {
  vi.useFakeTimers();
  const f = setup();
  const committed = deferred<Awaited<ReturnType<typeof f.storage.commitWrite>>>();
  const real = vi.mocked(f.storage.commitWrite).getMockImplementation()!;
  vi.mocked(f.storage.commitWrite).mockReturnValueOnce(committed.promise);
  const starting = f.recorder.start(f.options);
  await vi.waitFor(() => expect(f.storage.commitWrite).toHaveBeenCalledOnce());
  const stopping = f.recorder.stop();
  expect(f.recording.release).toHaveBeenCalledExactlyOnceWith({ reservationId: id(1) });
  await stopping;
  committed.resolve(await real(...vi.mocked(f.storage.commitWrite).mock.calls[0]!));
  await starting;
  expect(f.recorder.state.record?.id).toBe(id(50));
  expect(f.recorder.state.pendingWrite).toBeNull();
  expect(f.recorder.state.phase).toBe("ended");
  expect(f.storage.registerCheckpoint).not.toHaveBeenCalled();
  expect(f.recording.read).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.storage.beginWrite).toHaveBeenCalledOnce();
  await expect(f.recorder.start(f.options)).rejects.toThrow(/unresolved/);
  f.recorder.dispose();
});

it("Stop during reserve releases the original late handle without writing or replaying reserve", async () => {
  vi.useFakeTimers();
  const f = setup();
  const real = vi.mocked(f.recording.reserve).getMockImplementation()!;
  const reserved = deferred<Awaited<ReturnType<typeof f.recording.reserve>>>();
  vi.mocked(f.recording.reserve).mockReturnValueOnce(reserved.promise);
  const starting = f.recorder.start(f.options);
  await vi.waitFor(() => expect(f.recording.reserve).toHaveBeenCalledOnce());
  await f.recorder.stop();
  expect(f.recording.release).not.toHaveBeenCalled();
  reserved.resolve(await real(...vi.mocked(f.recording.reserve).mock.calls[0]!));
  await starting;
  expect(f.recording.release).toHaveBeenCalledExactlyOnceWith({ reservationId: id(1) });
  expect(f.storage.beginWrite).not.toHaveBeenCalled();
  expect(f.recording.reserve).toHaveBeenCalledOnce();
  expect(f.recorder.state.phase).toBe("ended");
  // Confirmed release and no attempted write permit only a new explicit Start.
  f.next();
  await f.recorder.start(f.options);
  expect(f.recorder.state.reservation?.reservationId).toBe(id(5));
  f.recorder.dispose();
});

it("late active query after Stop cannot announce recording or restart timers", async () => {
  vi.useFakeTimers();
  const f = setup();
  const query = deferred<Awaited<ReturnType<typeof f.recording.query>>>();
  vi.mocked(f.recording.query).mockReturnValueOnce(query.promise);
  const starting = f.recorder.start(f.options);
  await vi.waitFor(() => expect(f.recording.query).toHaveBeenCalledOnce());
  const active = f.recorder.state.reservation!;
  await f.recorder.stop();
  query.resolve(ok({ reservation: active }));
  await starting;
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.recorder.state.phase).toBe("ended");
  expect(f.recording.read).not.toHaveBeenCalled();
  expect(f.storage.beginWrite).toHaveBeenCalledOnce();
  f.recorder.dispose();
});

it("Stop during registration preserves the single host drain owner when the ack is aborted", async () => {
  vi.useFakeTimers();
  const f = setup();
  vi.mocked(f.storage.registerCheckpoint).mockImplementationOnce(
    (_p, signal) =>
      new Promise((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
      }),
  );
  const starting = f.recorder.start(f.options).catch(() => {});
  await vi.waitFor(() => expect(f.storage.registerCheckpoint).toHaveBeenCalledOnce());
  await f.recorder.stop();
  const context = f.drain();
  const first = f.recorder.drain(context);
  expect(f.recorder.drain(context)).toBe(first);
  expect((await first).ok).toBe(true);
  await starting;
  expect(f.recording.release).toHaveBeenCalledOnce();
  expect(f.storage.beginWrite).toHaveBeenCalledTimes(2);
  expect(f.recorder.state.phase).toBe("submitted");
  expect(f.recorder.snapshot?.reason).toBe("manual");
  f.recorder.dispose();
});

it("an uncertain Stop during registration never becomes recording on the late ack", async () => {
  vi.useFakeTimers();
  const f = setup();
  const registered = deferred<Awaited<ReturnType<typeof f.storage.registerCheckpoint>>>();
  vi.mocked(f.storage.registerCheckpoint).mockReturnValueOnce(registered.promise);
  const starting = f.recorder.start(f.options);
  await vi.waitFor(() => expect(f.storage.registerCheckpoint).toHaveBeenCalledOnce());
  vi.mocked(f.recording.release).mockRejectedValueOnce(new Error("release reply lost"));
  await f.recorder.stop();
  registered.resolve(ok({ checkpoint: id(60) }));
  await starting;
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.recorder.state.phase).toBe("error");
  expect(f.recorder.state.checkpoint).toBe(id(60));
  expect(f.recording.read).not.toHaveBeenCalled();
  expect(f.recording.release).toHaveBeenCalledOnce();
  await f.recorder.stop();
  expect(f.recording.release).toHaveBeenCalledTimes(2);
  f.recorder.dispose();
});

it("an initial begin with a lost reply stays fenced despite the earlier preflight", async () => {
  vi.useFakeTimers();
  const f = setup();
  const begin = vi.mocked(f.storage.beginWrite).getMockImplementation()!;
  vi.mocked(f.storage.beginWrite).mockImplementationOnce(async (...args) => {
    await begin(...args);
    throw new Error("begin reply lost");
  });
  await expect(f.recorder.start(f.options)).rejects.toThrow(/begin reply lost/);
  await expect(f.recorder.start(f.options)).rejects.toThrow(/unresolved/);
  expect(f.storage.beginWrite).toHaveBeenCalledOnce();
  expect(f.recording.release).toHaveBeenCalledOnce();
  expect(f.recorder.state.record).toBeNull();
  f.recorder.dispose();
});
