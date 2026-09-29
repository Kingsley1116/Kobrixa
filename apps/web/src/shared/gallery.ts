import { SAMPLE_RATE, rsfPreviewWav } from "../features/tools/lib/media.js";
import { mediaZip } from "../features/tools/lib/media-zip.js";
import { sequenceProgram } from "../features/tools/lib/audio-segments.js";

export const GALLERY_LIMITS = {
  imageSource: 20 * 1024 * 1024,
  audioSource: 50 * 1024 * 1024,
  duration: 60,
  dailySubmissions: 20,
  dailyUploads: 100,
  requestBytes: 1024 * 1024,
  pageSize: 24,
} as const;
export const LICENSE = "CC BY 4.0";
export const LICENSE_URL = "https://creativecommons.org/licenses/by/4.0/";
export type MediaKind = "image" | "audio";
export type GalleryStatus = "draft" | "pending" | "published" | "rejected" | "withdrawn";
export type GalleryErrorCode =
  | "invalid"
  | "unsupported"
  | "too_large"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "quota"
  | "unavailable"
  | "internal";
export class GalleryError extends Error {
  constructor(
    public code: GalleryErrorCode,
    public status = 400,
  ) {
    super(code);
  }
}
export type GalleryUser = { id: string; login: string; admin: boolean };
export type MediaInfo = {
  kind: MediaKind;
  width?: number;
  height?: number;
  samples?: number;
  duration?: number;
};
export type GalleryFile = MediaInfo & { name: string; size: number; key: string };
export type GalleryEntry = {
  id: string;
  owner_id: string;
  author: string;
  title: string;
  description: string;
  kind: MediaKind;
  status: GalleryStatus;
  version: number;
  files: GalleryFile[];
  reason: string;
  created_at: number;
  published_at: number | null;
  updated_at: number;
};
export type GalleryList = { items: GalleryEntry[]; more: boolean };
export type MediaExport = { kind: MediaKind; name: string; parts: Uint8Array<ArrayBuffer>[] };
export type GalleryEditorProps = {
  onExport?: (value: MediaExport | undefined) => void;
  sourceLimit?: number;
  durationLimit?: number;
};

export function inspectMedia(name: string, bytes: Uint8Array): MediaInfo {
  if (/\.rgf$/i.test(name)) {
    const width = bytes[0] ?? 0,
      height = bytes[1] ?? 0;
    if (
      width < 1 ||
      width > 176 ||
      height < 1 ||
      height > 128 ||
      bytes.length !== 2 + Math.ceil(width / 8) * height
    )
      throw new GalleryError("invalid");
    return { kind: "image", width, height };
  }
  if (!/\.rsf$/i.test(name)) throw new GalleryError("unsupported");
  if (bytes.length < 9) throw new GalleryError("invalid");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0) !== 0x0100 || view.getUint16(4) !== SAMPLE_RATE || view.getUint16(6) !== 0)
    throw new GalleryError("unsupported");
  const samples = view.getUint16(2);
  if (!samples || bytes.length !== samples + 8) throw new GalleryError("invalid");
  return { kind: "audio", samples, duration: samples / SAMPLE_RATE };
}
export function validateParts(parts: { name: string; bytes: Uint8Array }[]) {
  if (!parts.length || parts.length > 8) throw new GalleryError("invalid");
  const infos = parts.map((p) => inspectMedia(p.name, p.bytes));
  const kind = infos[0]!.kind;
  if (infos.some((i) => i.kind !== kind) || (kind === "image" && parts.length !== 1))
    throw new GalleryError("invalid");
  if (infos.reduce((sum, i) => sum + (i.samples ?? 0), 0) > GALLERY_LIMITS.duration * SAMPLE_RATE)
    throw new GalleryError("too_large");
  return infos;
}
export function imageSvg(bytes: Uint8Array) {
  const { width, height } = inspectMedia("image.rgf", bytes);
  let path = "";
  for (let y = 0; y < height!; y++)
    for (let x = 0; x < width!; x++)
      if (bytes[2 + y * Math.ceil(width! / 8) + Math.floor(x / 8)]! & (1 << (x % 8)))
        path += `M${x} ${y}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><path fill="white" d="M0 0h${width}v${height}H0z"/><path fill="black" shape-rendering="crispEdges" d="${path}"/></svg>`;
}
export function audioWav(parts: Uint8Array[]) {
  // rsfPreviewWav only reads the PCM payload; a combined preview need not fit one RSF header.
  const bytes = new Uint8Array(8 + parts.reduce((sum, p) => sum + p.length - 8, 0));
  let offset = 8;
  for (const p of parts) {
    bytes.set(p.subarray(8), offset);
    offset += p.length - 8;
  }
  return rsfPreviewWav(bytes);
}
export function attribution(entry: Pick<GalleryEntry, "title" | "author" | "id">, origin: string) {
  return `${entry.title} — ${entry.author}\n${origin}/gallery/${entry.id}\n${LICENSE} — ${LICENSE_URL}\n`;
}
export function galleryArchive(
  entry: GalleryEntry,
  parts: Uint8Array<ArrayBuffer>[],
  origin: string,
) {
  const encode = (s: string) => new Uint8Array(new TextEncoder().encode(s));
  const files = parts.map((bytes, i) => ({ name: `assets/deploy/${entry.files[i]!.name}`, bytes }));
  if (entry.kind === "audio" && parts.length > 1)
    files.push({ name: "play-sequence.bp", bytes: encode(sequenceProgram("sound", parts.length)) });
  files.push({
    name: "ATTRIBUTION.txt",
    bytes: encode(attribution(entry, origin) + "Converted to EV3 format / 已轉換為 EV3 格式。\n"),
  });
  files.push({
    name: "README.txt",
    bytes: encode(
      'Copy assets/deploy into your project and add "assets/deploy/**/*" to kobrixa.json assets.\n將 assets/deploy 複製到專案，並加入 kobrixa.json 的 assets 清單。\nFor sequences, include play-sequence.bp in your program. EV3 may pause between files.\n音訊組合請將 play-sequence.bp 加入主程式；EV3 換檔時可能短暫停頓。\n',
    ),
  });
  return mediaZip(files);
}
