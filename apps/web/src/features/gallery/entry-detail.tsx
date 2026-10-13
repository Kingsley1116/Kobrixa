import { useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { Icon } from "../../components/ui/icon.js";
import { attribution, LICENSE_URL } from "../../shared/gallery.js";
import type { GalleryEntry, GalleryUser } from "../../shared/gallery.js";
import type { Translate } from "../tools/components/tools-ui.js";
import { GalleryEditor } from "./gallery-editor.js";
import { api, errorText } from "./api.js";
import { Avatar, details, formatDate, KindBadge, Preview, StatusBadge } from "./gallery-parts.js";

export function EntryDetail({
  entry,
  user,
  t,
  refresh,
}: {
  entry: GalleryEntry;
  user: GalleryUser | null;
  t: Translate;
  refresh: () => void;
}) {
  const [editing, setEditing] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [reason, setReason] = useState(""),
    [copied, setCopied] = useState(false);
  async function act(action: string) {
    setBusy(true);
    setError("");
    try {
      await api(`gallery/${entry.id}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: entry.version, reason }),
      });
      refresh();
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  }
  const owner = user?.id === entry.owner_id;
  const editable = ["draft", "rejected", "withdrawn"].includes(entry.status);
  const multiple = entry.files.length > 1;
  const credit = attribution(entry, window.location.origin);
  const specs: [string, ReactNode][] = [
    [
      t("類型", "Type"),
      entry.kind === "image" ? t("EV3 圖片", "EV3 image") : t("EV3 音效", "EV3 sound"),
    ],
    [entry.kind === "image" ? t("尺寸", "Size") : t("長度", "Length"), details(entry)],
    [t("檔案", "Files"), `${entry.files.length} × ${entry.kind === "image" ? "RGF" : "RSF"}`],
    [
      t("授權", "License"),
      <a href={LICENSE_URL} target="_blank" rel="noreferrer">
        CC BY 4.0
      </a>,
    ],
  ];
  if (entry.published_at)
    specs.push([t("發佈日期", "Published"), formatDate(entry.published_at, t)]);
  return (
    <article className="gallery-detail">
      <Link className="gallery-back" to="/gallery">
        <Icon name="arrow-left" /> {t("返回素材庫", "Back to gallery")}
      </Link>
      <div className="gallery-detail-layout">
        <div className="gallery-detail-main">
          <div className="gallery-screen">
            <div className="gallery-screen-bar" aria-hidden="true">
              <i />
              <i />
              <i />
              <KindBadge entry={entry} />
            </div>
            <Preview entry={entry} t={t} />
          </div>
          {entry.reason && (
            <p className={`gallery-note ${entry.status}`}>
              <strong>{t("審核說明", "Review note")}</strong>
              {entry.reason}
            </p>
          )}
          {entry.description && <p className="gallery-description">{entry.description}</p>}
          {multiple && (
            <section className="gallery-files">
              <h2>{t("個別 RSF 檔案", "Individual RSF files")}</h2>
              <ol>
                {entry.files.map((f, i) => (
                  <li key={f.name}>
                    <span className="gallery-file-index">{String(i + 1).padStart(2, "0")}</span>
                    <span className="gallery-file-name">{f.name}</span>
                    <span className="gallery-file-time">{f.duration?.toFixed(2)} s</span>
                    <a
                      href={`/api/gallery/${entry.id}/files/${i}`}
                      aria-label={`${t("下載", "Download")} ${f.name}`}
                    >
                      <Icon name="download" />
                    </a>
                  </li>
                ))}
              </ol>
              <p className="gallery-muted">
                {t(
                  "EV3 換檔時可能短暫停頓；瀏覽器試聽不模擬載入延遲。",
                  "EV3 may pause between files. Browser preview does not simulate loading delays.",
                )}
              </p>
            </section>
          )}
        </div>
        <aside className="gallery-detail-side">
          <div className="gallery-side-card">
            <StatusBadge status={entry.status} t={t} />
            <h1>{entry.title}</h1>
            <p className="gallery-byline">
              <Avatar id={entry.owner_id} login={entry.author} size={28} />
              {t("作者", "By")}{" "}
              <a
                href={`https://github.com/${encodeURIComponent(entry.author)}`}
                target="_blank"
                rel="noreferrer"
              >
                @{entry.author}
              </a>
            </p>
            <dl className="gallery-specs">
              {specs.map(([term, value]) => (
                <div key={term}>
                  <dt>{term}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            <a
              className="gallery-download"
              href={`/api/gallery/${entry.id}/${multiple ? "archive" : "files/0"}`}
            >
              <span className="gallery-download-glyph">
                <Icon name="download" />
              </span>
              <span>
                <strong>
                  {multiple
                    ? t("下載音訊組合 ZIP", "Download audio ZIP")
                    : t("下載 EV3 檔案", "Download EV3 file")}
                </strong>
                <small>
                  {multiple
                    ? `${entry.files.length} × .rsf`
                    : entry.kind === "image"
                      ? ".rgf"
                      : ".rsf"}
                </small>
              </span>
            </a>
            <div className="gallery-side-actions">
              <a className="gallery-button" href={`/api/gallery/${entry.id}/archive`}>
                {t("含署名 ZIP", "ZIP with attribution")}
              </a>
              <button
                className="gallery-button"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(credit)
                    .then(() => setCopied(true))
                    .catch(() =>
                      setError(
                        t(
                          "無法複製，請選取下方署名文字。",
                          "Could not copy. Select the attribution text below.",
                        ),
                      ),
                    );
                }}
              >
                <Icon name={copied ? "check" : "copy"} />
                {copied ? t("已複製", "Copied") : t("複製署名", "Copy attribution")}
              </button>
            </div>
            <details className="gallery-credit">
              <summary className="ui-disclosure">{t("署名文字", "Attribution text")}</summary>
              <pre className="gallery-attribution">{credit}</pre>
            </details>
          </div>
          {owner && (
            <section className="gallery-panel manage">
              <h2>{t("管理作品", "Manage work")}</h2>
              {editable ? (
                <button className="gallery-button" onClick={() => setEditing(!editing)}>
                  {editing ? t("收起編輯器", "Close editor") : t("修改及重新送審", "Edit & submit")}
                </button>
              ) : (
                <>
                  <p>
                    {t(
                      "修改前需先撤下作品；修改後重新送審。",
                      "Withdraw before editing, then submit again for review.",
                    )}
                  </p>
                  <button
                    className="gallery-button"
                    disabled={busy}
                    onClick={() => void act("withdraw")}
                  >
                    {t("撤下作品", "Withdraw")}
                  </button>
                </>
              )}
            </section>
          )}
          {user?.admin && ["pending", "published"].includes(entry.status) && (
            <section className="gallery-panel moderate">
              <h2>{t("審核管理", "Moderation")}</h2>
              <label className="gallery-field">
                {t("拒絕／下架原因", "Reason for rejection / removal")}
                <textarea
                  className="ui-control gallery-input"
                  value={reason}
                  maxLength={2000}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
              <div className="gallery-actions">
                {entry.status === "pending" ? (
                  <>
                    <button
                      className="gallery-button gallery-primary"
                      disabled={busy}
                      onClick={() => void act("approve")}
                    >
                      {t("核准並公開", "Approve & publish")}
                    </button>
                    <button
                      className="gallery-button"
                      disabled={busy || !reason.trim()}
                      onClick={() => void act("reject")}
                    >
                      {t("拒絕", "Reject")}
                    </button>
                  </>
                ) : (
                  <button
                    className="gallery-button"
                    disabled={busy || !reason.trim()}
                    onClick={() => void act("takedown")}
                  >
                    {t("下架", "Remove from public gallery")}
                  </button>
                )}
              </div>
            </section>
          )}
          {error && (
            <p role="alert" className="gallery-error">
              {error}
            </p>
          )}
        </aside>
      </div>
      {editing && editable && <GalleryEditor entry={entry} t={t} onSaved={refresh} />}
    </article>
  );
}
