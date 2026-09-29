import { Link } from "react-router";
import { PolicyNotice } from "../../components/legal-links.js";
import { FileDrop } from "../../components/ui/file-drop.js";
import { AudioPlayer } from "../../components/ui/audio-player.js";
import { useRef, useState } from "react";
import { useNavigate } from "react-router";
import { ImageTool } from "../tools/components/image-tool.js";
import { AudioTool } from "../tools/components/audio-tool.js";
import {
  GalleryError,
  GALLERY_LIMITS,
  LICENSE_URL,
  validateParts,
  imageSvg,
  audioWav,
} from "../../shared/gallery.js";
import type { GalleryEntry, MediaExport } from "../../shared/gallery.js";
import { useBlobUrl } from "../tools/components/tools-ui.js";
import { useMemo } from "react";
import type { Translate } from "../tools/components/tools-ui.js";
import { api, errorText } from "./api.js";
import "../tools/tools.css";

function NativePreview({ media, t }: { media: MediaExport; t: Translate }) {
  const blob = useMemo(
    () =>
      media.kind === "image"
        ? new Blob([imageSvg(media.parts[0]!)], { type: "image/svg+xml" })
        : new Blob([audioWav(media.parts)], { type: "audio/wav" }),
    [media],
  );
  const url = useBlobUrl(blob);
  return url ? (
    media.kind === "image" ? (
      <img className="gallery-native-image" src={url} alt="EV3" />
    ) : (
      <AudioPlayer
        src={url}
        title={t("匯入音訊", "Imported audio")}
        t={t}
        duration={validateParts(
          media.parts.map((bytes, index) => ({ name: `${index}.rsf`, bytes })),
        ).reduce((sum, part) => sum + (part.duration ?? 0), 0)}
      />
    )
  ) : null;
}
export function GalleryEditor({
  entry,
  t,
  onSaved,
}: {
  entry?: GalleryEntry;
  t: Translate;
  onSaved?: () => void;
}) {
  const navigate = useNavigate();
  const nativeVersion = useRef(0);
  const [saved, setSaved] = useState(entry);
  const [title, setTitle] = useState(entry?.title ?? "");
  const [description, setDescription] = useState(entry?.description ?? "");
  const [mode, setMode] = useState<"image" | "audio" | "native">("image");
  const [replace, setReplace] = useState(!entry);
  const [media, setMedia] = useState<MediaExport>();
  const [agreement, setAgreement] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function native(files: File[]) {
    const current = ++nativeVersion.current;
    setMedia(undefined);
    setError("");
    try {
      if (!files?.length) return;
      const list = Array.from(files).sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true }),
      );
      if (list.length > 8 || list.reduce((sum, f) => sum + f.size, 0) > GALLERY_LIMITS.requestBytes)
        throw new GalleryError("too_large");
      const parts = await Promise.all(
        list.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })),
      );
      const infos = validateParts(parts);
      if (current !== nativeVersion.current) return;
      setMedia({ kind: infos[0]!.kind, name: "media", parts: parts.map((p) => p.bytes) });
    } catch (e) {
      if (current === nativeVersion.current) setError(errorText(e, t));
    }
  }
  async function save(submit: boolean) {
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.set("title", title);
      form.set("description", description);
      if (saved) form.set("version", String(saved.version));
      if (replace && media)
        for (const [i, bytes] of media.parts.entries())
          form.append("files", new Blob([bytes]), `${i}.${media.kind === "image" ? "rgf" : "rsf"}`);
      const result = await api<GalleryEntry>(`gallery${saved ? `/${saved.id}` : ""}`, {
        method: saved ? "PUT" : "POST",
        body: form,
      });
      setSaved(result);
      if (submit)
        await api(`gallery/${result.id}/submit`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ version: result.version, agreement }),
        });
      onSaved?.();
      navigate(`/gallery/${result.id}`);
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  }
  const ready = title.trim().length > 0 && (!replace || Boolean(media));
  return (
    <section className="gallery-editor">
      <div className="gallery-note">
        {t(
          "原始檔只在瀏覽器處理；儲存草稿或送審時，只上傳 EV3 成品。",
          "Originals stay in your browser. Saving a draft or submitting uploads only the EV3 output.",
        )}
      </div>
      <fieldset className="gallery-editor-fields" disabled={busy}>
        <label className="gallery-field">
          {t("作品標題", "Title")}
          <input
            className="ui-control gallery-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={120}
            required
          />
        </label>
        <label className="gallery-field">
          {t("說明（選填）", "Description (optional)")}
          <textarea
            className="ui-control gallery-input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={2000}
            rows={3}
          />
        </label>
        {entry && (
          <label className="gallery-field gallery-check ui-choice-label">
            <input
              className="ui-choice gallery-input"
              type="checkbox"
              checked={replace}
              onChange={(e) => setReplace(e.target.checked)}
            />
            {t("替換媒體檔案", "Replace media files")}
          </label>
        )}
        {replace && (
          <>
            <div className="gallery-tabs" role="group" aria-label={t("素材來源", "Media source")}>
              {(["image", "audio", "native"] as const).map((key) => (
                <button
                  className="gallery-button"
                  type="button"
                  key={key}
                  aria-pressed={mode === key}
                  onClick={() => {
                    nativeVersion.current++;
                    setMode(key);
                    setMedia(undefined);
                    setError("");
                  }}
                >
                  {key === "image"
                    ? t("轉換圖片", "Convert image")
                    : key === "audio"
                      ? t("轉換音訊", "Convert audio")
                      : t("匯入 EV3 檔案", "Import EV3 files")}
                </button>
              ))}
            </div>
            <p className="gallery-muted">
              {t(
                "圖片最多 20 MiB；音訊最多 50 MiB，選取範圍最長 60 秒。長音訊請選擇分段匯出。",
                "Images: 20 MiB. Audio: 50 MiB, up to 60 seconds selected. Choose sequence export for longer audio.",
              )}
            </p>
            <div className="studio gallery-studio">
              {mode === "image" && (
                <ImageTool
                  t={t}
                  active
                  onExport={setMedia}
                  sourceLimit={GALLERY_LIMITS.imageSource}
                />
              )}
              {mode === "audio" && (
                <AudioTool
                  t={t}
                  active
                  onExport={setMedia}
                  sourceLimit={GALLERY_LIMITS.audioSource}
                  durationLimit={GALLERY_LIMITS.duration}
                />
              )}
              {mode === "native" && (
                <div className="gallery-native">
                  <FileDrop
                    accept=".rgf,.rsf"
                    multiple
                    disabled={busy}
                    t={t}
                    label={t(
                      "選擇一張 RGF 或一至八個 RSF",
                      "Choose one RGF or up to eight RSF files",
                    )}
                    onFiles={(files) => void native(files)}
                  />
                  <p>
                    {t(
                      "RSF 依檔名排序，僅接受 8 kHz 未壓縮格式。",
                      "RSF files are ordered by file name; only uncompressed 8 kHz files are supported.",
                    )}
                  </p>
                  {media && <NativePreview media={media} t={t} />}
                </div>
              )}
            </div>
          </>
        )}
        <PolicyNotice t={t} action="save" />
        <label className="gallery-field gallery-check ui-choice-label">
          <input
            className="ui-choice gallery-input"
            type="checkbox"
            checked={agreement}
            onChange={(e) => setAgreement(e.target.checked)}
          />
          <span>
            {t("我同意", "I agree to the ")}{" "}
            <Link to="/terms" target="_blank" rel="noreferrer">
              {t("服務條款", "Terms of Service")}
            </Link>
            {t(
              "，確認有權分享此素材，並同意以 ",
              ", confirm my right to share this material, and license it under ",
            )}
            <a href={LICENSE_URL} target="_blank" rel="noreferrer">
              CC BY 4.0
            </a>
            {t(
              " 公開，允許署名後分享及改作。",
              ", allowing sharing and adaptation with attribution.",
            )}
          </span>
        </label>
        <div className="gallery-actions">
          <button
            className="gallery-button"
            type="button"
            disabled={!ready}
            onClick={() => void save(false)}
          >
            {t("儲存草稿", "Save draft")}
          </button>
          <button
            type="button"
            className="gallery-button gallery-primary"
            disabled={!ready || !agreement}
            onClick={() => void save(true)}
          >
            {busy ? t("處理中…", "Working…") : t("送交審核", "Submit for review")}
          </button>
        </div>
      </fieldset>
      {error && (
        <p role="alert" className="gallery-error">
          {error}
        </p>
      )}
    </section>
  );
}
