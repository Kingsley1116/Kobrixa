import { useState } from "react";
import { AudioPlayer } from "../../components/ui/audio-player.js";
import { Icon } from "../../components/ui/icon.js";
import type { GalleryEntry, GalleryStatus } from "../../shared/gallery.js";
import type { Translate } from "../tools/components/tools-ui.js";

export function statusText(status: GalleryStatus, t: Translate) {
  const labels: Record<GalleryStatus, [string, string]> = {
    draft: ["草稿", "Draft"],
    pending: ["待審核", "Pending review"],
    published: ["已公開", "Published"],
    rejected: ["已拒絕", "Rejected"],
    withdrawn: ["已撤下", "Withdrawn"],
  };
  return t(...labels[status]);
}
export function totalDuration(entry: GalleryEntry) {
  return entry.files.reduce((sum, f) => sum + (f.duration ?? 0), 0);
}
export function details(entry: GalleryEntry) {
  return entry.kind === "image"
    ? `${entry.files[0]?.width} × ${entry.files[0]?.height} px`
    : `${totalDuration(entry).toFixed(2)} s · ${entry.files.length} RSF`;
}
export function formatDate(seconds: number | null, t: Translate) {
  if (!seconds) return "";
  return new Intl.DateTimeFormat(t("zh-TW", "en"), { dateStyle: "medium" }).format(seconds * 1000);
}
/** GitHub avatar for a user id; falls back to the login's initial when the image fails. */
export function Avatar({ id, login, size = 24 }: { id: string; login: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="gallery-avatar" style={{ width: size, height: size }} aria-hidden="true">
      {failed ? (
        login.slice(0, 1).toUpperCase()
      ) : (
        <img
          src={`https://avatars.githubusercontent.com/u/${encodeURIComponent(id)}?s=${size * 2}`}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}
export function StatusBadge({ status, t }: { status: GalleryStatus; t: Translate }) {
  return <span className={`gallery-status ${status}`}>{statusText(status, t)}</span>;
}
export function KindBadge({ entry }: { entry: GalleryEntry }) {
  return (
    <span className={`gallery-kind ${entry.kind}`}>
      <Icon name={entry.kind} />
      {entry.kind === "image" ? "RGF" : "RSF"}
    </span>
  );
}
export function Eyebrow({ children }: { children: string }) {
  return (
    <p className="gallery-eyebrow">
      <i aria-hidden="true" />
      {children}
    </p>
  );
}
export function Preview({ entry, t }: { entry: GalleryEntry; t: Translate }) {
  const url = `/api/gallery/${entry.id}/preview?v=${entry.version}`;
  return (
    <div className={`gallery-preview ${entry.kind}`}>
      {entry.kind === "image" ? (
        <div className="gallery-lcd">
          <img src={url} alt={entry.title} loading="lazy" />
        </div>
      ) : (
        <>
          <svg className="gallery-sound-mark" viewBox="0 0 160 48" aria-hidden="true">
            {[16, 32, 46, 24, 38, 16, 30].map((height, index) => (
              <rect
                key={index}
                x={index * 23}
                y={(48 - height) / 2}
                width={12}
                height={height}
                rx={3}
              />
            ))}
          </svg>
          <AudioPlayer src={url} title={entry.title} t={t} duration={totalDuration(entry)} />
        </>
      )}
    </div>
  );
}
