import { describe, expect, it } from "vitest";
import { encodeRgf, encodeRsf } from "../features/tools/lib/media.js";
import { encodeRsfSegments } from "../features/tools/lib/audio-segments.js";
import { inspectMedia, validateParts, audioWav, imageSvg, galleryArchive } from "./gallery.js";
import type { GalleryEntry } from "./gallery.js";
describe("Gallery media boundary", () => {
  it("validates native image dimensions and exact byte lengths", () => {
    const image = encodeRgf(new Uint8Array(9 * 2 * 4), 9, 2);
    expect(inspectMedia("test.rgf", image)).toEqual({ kind: "image", width: 9, height: 2 });
    expect(() => inspectMedia("test.rgf", image.subarray(1))).toThrow();
    expect(() =>
      inspectMedia("test.rgf", new Uint8Array([177, 1, ...Array(23).fill(0)])),
    ).toThrow();
    expect(imageSvg(new Uint8Array([1, 1, 1]))).toContain("M0 0h1v1h-1z");
  });
  it("rejects unsupported and forged sound headers", () => {
    const sound = encodeRsf(new Float32Array([0, 1, -1]));
    expect(inspectMedia("test.RSF", sound).samples).toBe(3);
    const compressed = sound.slice();
    compressed[1] = 1;
    expect(() => inspectMedia("test.rsf", compressed)).toThrow("unsupported");
    const rate = sound.slice();
    rate[4] = 0;
    expect(() => inspectMedia("test.rsf", rate)).toThrow("unsupported");
    expect(() => inspectMedia("test.rsf", sound.subarray(0, 9))).toThrow("invalid");
    expect(() => inspectMedia("evil.zip", sound)).toThrow("unsupported");
  });
  it("preserves every quantized sample across long preview and archive", () => {
    const segments = encodeRsfSegments(
      Float32Array.from({ length: 70000 }, (_, i) => (i % 100) / 100),
    );
    const named = segments.map((bytes, i) => ({ name: `${i}.rsf`, bytes }));
    expect(validateParts(named)).toHaveLength(2);
    const wav = audioWav(segments);
    expect([...wav.slice(44, 44 + 70000)]).toEqual(segments.flatMap((p) => [...p.slice(8)]));
    const entry = {
      id: "id",
      title: "Example",
      author: "creator",
      kind: "audio",
      files: segments.map((p, i) => ({ name: `sound-00${i + 1}.rsf` })),
    } as GalleryEntry;
    const archive = new TextDecoder().decode(
      galleryArchive(entry, segments, "https://kobrixa.com"),
    );
    expect(archive).toContain("play-sequence.bp");
    expect(archive).toContain("ATTRIBUTION.txt");
    expect(archive).toContain("CC BY 4.0");
    expect(archive).toContain('Speaker.Play(35, "assets/deploy/sound-001")');
  });
  it("limits duration and rejects mixed or multiple images", () => {
    const parts = encodeRsfSegments(new Float32Array(480001)).map((bytes) => ({
      name: "x.rsf",
      bytes,
    }));
    expect(() => validateParts(parts)).toThrow("too_large");
    const img = { name: "x.rgf", bytes: new Uint8Array([1, 1, 0]) };
    expect(() => validateParts([img, img])).toThrow();
    expect(() => validateParts([img, parts[0]!])).toThrow();
    expect(() => validateParts([])).toThrow();
  });
});
