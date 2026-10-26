import { expect, it } from "vitest";
import type { ReadSnapshot } from "@kobrixa/plugin-protocol";
import { LabPreview, freshReading } from "../../../../../plugins/sensor-lab/src/preview.js";
import { setup } from "./recorder-fixture.js";
function fixture() {
  const f = setup();
  const source = f.options.channels[0]!.source;
  const read = (sequence = 10, elapsed = 0): ReadSnapshot => ({
    sessionId: f.options.sessionId,
    revision: 1,
    status: "fresh",
    ageMs: 0,
    frame: f.frame(sequence, elapsed),
  });
  return { f, source, read };
}
it("bounds independent preview to 60s/240 samples; keeps original session origin, gaps and immutable snapshots", () => {
  const { source, read } = fixture(),
    preview = new LabPreview();
  expect(preview.accept([source], read())).toBe(true);
  expect(preview.accept([source], read())).toBe(false);
  for (let i = 1; i < 300; i++) preview.accept([source], read(10 + i, i * 500));
  expect(preview.frames).toHaveLength(121);
  expect(preview.frames.at(-1)?.elapsedMs).toBe(149500);
  expect(preview.frames.at(-1)?.sessionElapsedMs).toBe(2149500);
  const snapshot = preview.frames;
  const stale = read(310, 150000);
  stale.status = "stale";
  preview.accept([source], stale);
  expect(preview.frames.at(-1)).toMatchObject({ status: "gap", values: [null] });
  expect(snapshot.at(-1)?.elapsedMs).toBe(149500);
  preview.reset();
  expect(preview.frames).toEqual([]);
});
it("Capture/Zero require finite original-session/source revision and age at most 2500ms", () => {
  const { source, read } = fixture();
  expect(freshReading(source, { ...read(), ageMs: 2500 })).toBe(10);
  for (const change of [
    { ageMs: 2501 },
    { ageMs: null },
    { ageMs: -1 },
    { sessionId: "foreign" },
    { status: "stale" as const },
  ])
    expect(() => freshReading(source, { ...read(), ...change })).toThrow();
  const reading = read();
  reading.frame!.sourceRevision++;
  expect(() => freshReading(source, reading)).toThrow();
  reading.frame!.sourceRevision--;
  reading.frame!.values[0]!.value = null;
  expect(() => freshReading(source, reading)).toThrow();
});
it("changed sources reset preview and very long paused intervals remain bounded", () => {
  const { source, read } = fixture(),
    preview = new LabPreview();
  preview.accept([source], read());
  preview.accept([source], read(11, 100));
  const foreign = read(12, 200);
  foreign.frame!.sourceRevision++;
  expect(preview.accept([source], foreign)).toBe(false);
  expect(preview.frames).toHaveLength(2);
  expect(preview.accept([source], read(13, 3600000))).toBe(true);
  expect(preview.frames).toHaveLength(1);
  expect(preview.frames[0]?.elapsedMs).toBe(0);
});
