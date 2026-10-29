import type { ReadSnapshot, SourceCatalog, DeviceSessionSnapshot } from "@kobrixa/plugin-protocol";
import {
  immutableSnapshot,
  publicFrame,
  type SourceSnapshot,
  type Frame,
  type RecordingMonotonicOrigin,
} from "./model/data.js";

export function currentSource(
  source: SourceSnapshot,
  session: DeviceSessionSnapshot | undefined,
  catalog: SourceCatalog | undefined,
): boolean {
  return (
    source.origin === "public" &&
    session?.state === "connected" &&
    source.provenance.sessionId === session.sessionId &&
    source.provenance.providerId === session.providerId &&
    source.provenance.sourceRevision === session.sourceRevision &&
    catalog?.sessionId === session.sessionId &&
    catalog.sourceRevision === session.sourceRevision &&
    catalog.channels.some(
      (channel) =>
        channel.state === "ready" &&
        Object.keys(channel).every(
          (key) =>
            channel[key as keyof typeof channel] === source.channel[key as keyof typeof channel],
        ),
    )
  );
}
export function freshReading(source: SourceSnapshot, read: ReadSnapshot): number {
  if (
    source.origin !== "public" ||
    read.sessionId !== source.provenance.sessionId ||
    read.status !== "fresh" ||
    read.ageMs === null ||
    read.ageMs < 0 ||
    read.ageMs > 2500 ||
    !Number.isFinite(read.ageMs) ||
    !read.frame ||
    read.frame.status !== "ok" ||
    read.frame.sourceRevision !== source.provenance.sourceRevision
  )
    throw new Error("Fresh reading from the original source is unavailable");
  const value = read.frame.values.find((v) => v.channelId === source.channel.channelId)?.value;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Reading unavailable");
  return value;
}
/** Preview has its own bounded origin; recording owns a separate, immutable origin. */
export class LabPreview {
  #frames: Frame[] = [];
  #origin: RecordingMonotonicOrigin | undefined;
  #identity = "";
  #sequence = -1;
  #segment = 0;
  get frames(): readonly Frame[] {
    return immutableSnapshot(this.#frames);
  }
  reset(): void {
    this.#frames = [];
    this.#origin = undefined;
    this.#sequence = -1;
    this.#identity = "";
    this.#segment = 0;
  }
  accept(sources: readonly SourceSnapshot[], read: ReadSnapshot): boolean {
    const first = sources[0];
    if (
      !first ||
      first.origin !== "public" ||
      sources.length > 4 ||
      read.sessionId !== first.provenance.sessionId ||
      !read.frame ||
      read.frame.sourceRevision !== first.provenance.sourceRevision
    )
      return false;
    const identity = JSON.stringify(sources);
    if (identity !== this.#identity) {
      this.reset();
      this.#identity = identity;
    }
    const frame = read.frame;
    if (frame.sequence <= this.#sequence) return false;
    if (!this.#origin) this.#origin = { ...first.provenance, sessionElapsedMs: frame.elapsedMs };
    if (
      frame.elapsedMs < this.#origin.sessionElapsedMs ||
      frame.elapsedMs < (this.#frames.at(-1)?.sessionElapsedMs ?? 0)
    )
      return false;
    if (frame.elapsedMs - (this.#frames.at(-1)?.sessionElapsedMs ?? frame.elapsedMs) > 60000) {
      this.#frames = [];
      this.#origin = { ...this.#origin, sessionElapsedMs: frame.elapsedMs };
    }
    // Rebase a long-lived preview before the model's 30-minute recording bound.
    if (frame.elapsedMs - this.#origin.sessionElapsedMs > 1800000) {
      const shift = this.#frames[0]?.elapsedMs ?? 0;
      this.#origin = { ...this.#origin, sessionElapsedMs: this.#origin.sessionElapsedMs + shift };
      this.#frames = this.#frames.map((f) => ({ ...f, elapsedMs: f.elapsedMs - shift }));
    }
    if (
      frame.status !== "ok" ||
      frame.gap ||
      (this.#sequence >= 0 && frame.sequence !== this.#sequence + 1)
    )
      this.#segment++;
    const sample = publicFrame(sources, frame, this.#segment, this.#origin);
    this.#sequence = frame.sequence;
    this.#frames.push(
      read.status === "fresh" &&
        read.ageMs !== null &&
        Number.isFinite(read.ageMs) &&
        read.ageMs >= 0 &&
        read.ageMs <= 2500
        ? sample
        : { ...sample, status: "gap", values: sample.values.map(() => null) },
    );
    this.#frames = this.#frames.filter((f) => f.elapsedMs >= sample.elapsedMs - 60000).slice(-240);
    return true;
  }
}
