import { PolicyNotice } from "../../components/legal-links.js";
import { Select } from "../../components/ui/select.js";
import { AudioPlayer } from "../../components/ui/audio-player.js";
import { useEffect, useState } from "react";
import { Link, NavLink, useLocation, useSearchParams } from "react-router";
import { SiteHeader } from "../../components/site-header.js";
import { attribution, LICENSE_URL } from "../../shared/gallery.js";
import type {
  GalleryEntry,
  GalleryList,
  GalleryStatus,
  GalleryUser,
} from "../../shared/gallery.js";
import type { PageContext } from "../../app/app.js";
import type { Translate } from "../tools/components/tools-ui.js";
import { GalleryEditor } from "./gallery-editor.js";
import { api, errorText } from "./api.js";
import "./gallery.css";

function statusText(status: GalleryStatus, t: Translate) {
  const labels: Record<GalleryStatus, [string, string]> = {
    draft: ["草稿", "Draft"],
    pending: ["待審核", "Pending review"],
    published: ["已公開", "Published"],
    rejected: ["已拒絕", "Rejected"],
    withdrawn: ["已撤下", "Withdrawn"],
  };
  return t(...labels[status]);
}
function details(entry: GalleryEntry) {
  return entry.kind === "image"
    ? `${entry.files[0]?.width} × ${entry.files[0]?.height} px`
    : `${entry.files.reduce((sum, f) => sum + (f.duration ?? 0), 0).toFixed(2)} s · ${entry.files.length} RSF`;
}
function Preview({ entry, t }: { entry: GalleryEntry; t: Translate }) {
  const url = `/api/gallery/${entry.id}/preview?v=${entry.version}`;
  return (
    <div className={`gallery-preview ${entry.kind}`}>
      {entry.kind === "image" ? (
        <img src={url} alt={entry.title} />
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
          <AudioPlayer
            src={url}
            title={entry.title}
            t={t}
            duration={entry.files.reduce((sum, file) => sum + (file.duration ?? 0), 0)}
          />
        </>
      )}
    </div>
  );
}
function EntryDetail({
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
  return (
    <article className="gallery-detail">
      <Link className="gallery-back" to="/gallery">
        ← {t("返回素材庫", "Back to gallery")}
      </Link>
      <div className="gallery-detail-head">
        <div>
          <span className={`gallery-status ${entry.status}`}>{statusText(entry.status, t)}</span>
          <h1>{entry.title}</h1>
          <p>
            <a
              href={`https://github.com/${encodeURIComponent(entry.author)}`}
              target="_blank"
              rel="noreferrer"
            >
              @{entry.author}
            </a>{" "}
            · {details(entry)} ·{" "}
            <a href={LICENSE_URL} target="_blank" rel="noreferrer">
              CC BY 4.0
            </a>
          </p>
        </div>
      </div>
      {entry.reason && (
        <p className="gallery-note">
          {t("審核說明：", "Review note: ")}
          {entry.reason}
        </p>
      )}
      <Preview entry={entry} t={t} />
      <p className="gallery-description">{entry.description}</p>
      <div className="gallery-actions">
        <a
          className="gallery-primary"
          href={`/api/gallery/${entry.id}/${entry.files.length > 1 ? "archive" : "files/0"}`}
        >
          {entry.files.length > 1
            ? t("下載音訊組合 ZIP", "Download audio ZIP")
            : t("下載 EV3 檔案", "Download EV3 file")}
        </a>
        <a href={`/api/gallery/${entry.id}/archive`}>
          {t("含署名與說明的 ZIP", "ZIP with attribution & instructions")}
        </a>
        <button
          className="gallery-button"
          onClick={() => {
            void navigator.clipboard
              .writeText(attribution(entry, window.location.origin))
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
          {copied ? t("已複製", "Copied") : t("複製署名", "Copy attribution")}
        </button>
      </div>
      <pre className="gallery-attribution">{attribution(entry, window.location.origin)}</pre>
      {entry.files.length > 1 && (
        <>
          <details>
            <summary className="ui-disclosure">
              {t("個別 RSF 檔案", "Individual RSF files")}
            </summary>
            <ol>
              {entry.files.map((f, i) => (
                <li key={f.name}>
                  <a href={`/api/gallery/${entry.id}/files/${i}`}>{f.name}</a> ·{" "}
                  {f.duration?.toFixed(2)} s
                </li>
              ))}
            </ol>
          </details>
          <p className="gallery-muted">
            {t(
              "EV3 換檔時可能短暫停頓；瀏覽器試聽不模擬載入延遲。",
              "EV3 may pause between files. Browser preview does not simulate loading delays.",
            )}
          </p>
        </>
      )}
      {owner && (
        <div className="gallery-management">
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
        </div>
      )}
      {editing && editable && <GalleryEditor entry={entry} t={t} onSaved={refresh} />}
      {user?.admin && ["pending", "published"].includes(entry.status) && (
        <div className="gallery-management">
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
        </div>
      )}
      {error && (
        <p role="alert" className="gallery-error">
          {error}
        </p>
      )}
    </article>
  );
}
export function GalleryPage({ locale, onLocaleChange }: PageContext) {
  const t: Translate = (zh, en) => (locale === "zh-TW" ? zh : en);
  const { pathname } = useLocation();
  const [params, setParams] = useSearchParams();
  const section = pathname.split("/")[2] ?? "";
  const list = ["", "mine", "admin"].includes(section),
    submit = section === "submit";
  const [auth, setAuth] = useState<{ user: GalleryUser | null; loginAvailable: boolean }>();
  const [data, setData] = useState<GalleryList>(),
    [entry, setEntry] = useState<GalleryEntry>();
  const [error, setError] = useState<unknown>(),
    [loading, setLoading] = useState(true),
    [revision, setRevision] = useState(0);
  const [search, setSearch] = useState(params.get("q") ?? "");
  const query = params.toString();
  useEffect(() => {
    document.title = t("EV3 素材庫 — Kobrixa", "EV3 Gallery — Kobrixa");
  }, [locale]);
  useEffect(() => {
    let alive = true;
    void api<{ user: GalleryUser | null; loginAvailable: boolean }>("auth/me")
      .then((result) => {
        if (alive) setAuth(result);
      })
      .catch((e) => {
        if (alive) setError(e);
      });
    return () => {
      alive = false;
    };
  }, [revision]);
  useEffect(() => {
    let alive = true;
    setError(undefined);
    setData(undefined);
    setEntry(undefined);
    setLoading(true);
    setSearch(params.get("q") ?? "");
    if (submit) {
      setLoading(false);
      return;
    }
    const route = list
      ? `gallery?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(query)), scope: section === "mine" ? "mine" : section === "admin" ? "admin" : "public" })}`
      : `gallery/${encodeURIComponent(section)}`;
    void api<GalleryList | GalleryEntry>(route)
      .then((result) => {
        if (alive) {
          if ("items" in result) setData(result);
          else setEntry(result);
        }
      })
      .catch((e) => {
        if (alive) setError(e);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [pathname, query, revision]);
  const refresh = () => setRevision((n) => n + 1);
  const page = Number(params.get("page") ?? 1);
  const updateQuery = (patch: Record<string, string>) =>
    setParams({ ...Object.fromEntries(params), ...patch });
  return (
    <>
      <a className="skip-link" href="#content">
        {t("跳到主要內容", "Skip to content")}
      </a>
      <SiteHeader locale={locale} page="gallery" onLocaleChange={onLocaleChange} />
      <main id="content" className="gallery">
        <div className="gallery-toolbar">
          <nav aria-label={t("素材庫導覽", "Gallery navigation")}>
            <NavLink to="/gallery" end>
              {t("探索素材", "Explore")}
            </NavLink>
            <NavLink to="/gallery/submit">{t("分享素材", "Share media")}</NavLink>
            {auth?.user && <NavLink to="/gallery/mine">{t("我的作品", "My works")}</NavLink>}
            {auth?.user?.admin && (
              <NavLink to="/gallery/admin">{t("審核管理", "Moderation")}</NavLink>
            )}
          </nav>
          <div>
            {auth?.user ? (
              <>
                <span>@{auth.user.login}</span>
                <button
                  className="gallery-button"
                  onClick={() => {
                    void api("auth/logout", { method: "POST" })
                      .then(() => {
                        setAuth({ ...auth, user: null });
                        refresh();
                      })
                      .catch(setError);
                  }}
                >
                  {t("登出", "Sign out")}
                </button>
              </>
            ) : auth?.loginAvailable ? (
              <a href="/api/auth/github">{t("GitHub 登入", "Sign in with GitHub")} ↗</a>
            ) : auth ? (
              <span className="gallery-muted">{t("登入服務待設定", "Sign-in not configured")}</span>
            ) : null}
          </div>
        </div>
        {!auth?.user && <PolicyNotice t={t} action="signin" />}
        {(list || submit) && (
          <header className="gallery-hero">
            <p className="gallery-eyebrow">KOBRIXA / COMMUNITY GALLERY</p>
            <h1>
              {submit
                ? t("把你的創意，分享給下一個作品。", "Share a spark for the next creation.")
                : section === "mine"
                  ? t("我的作品", "My works")
                  : section === "admin"
                    ? t("審核管理", "Moderation")
                    : t("讓 EV3，有聲有色。", "Give your EV3 a little character.")}
            </h1>
            <p>
              {submit
                ? t(
                    "轉換、預覽、送審。讓每個人都能用你的素材創作。",
                    "Convert, preview, submit. Help everyone create with your media.",
                  )
                : t(
                    "探索社群分享的圖片與音效。免費下載，署名使用。",
                    "Discover community images and sounds. Download freely, use with attribution.",
                  )}
            </p>
          </header>
        )}
        {params.get("auth") === "failed" && (
          <p role="alert" className="gallery-error">
            {t(
              "GitHub 登入未完成，請再試一次。",
              "GitHub sign-in did not complete. Please try again.",
            )}
          </p>
        )}
        {submit &&
          (auth?.user ? (
            <GalleryEditor t={t} />
          ) : (
            <div className="gallery-empty">
              <h2>{t("登入後開始分享", "Sign in to start sharing")}</h2>
              <p>
                {t(
                  "所有投稿都會經過審核，公開下載不需登入。",
                  "All submissions are reviewed. Public downloads need no account.",
                )}
              </p>
              {auth?.loginAvailable ? (
                <a className="gallery-primary" href="/api/auth/github">
                  {t("使用 GitHub 登入", "Continue with GitHub")}
                </a>
              ) : (
                <p>
                  {auth
                    ? t("登入服務尚未設定完成。", "Sign-in is not configured yet.")
                    : t("正在載入…", "Loading…")}
                </p>
              )}
            </div>
          ))}
        {list && (
          <form
            className="gallery-filters"
            onSubmit={(e) => {
              e.preventDefault();
              updateQuery({ q: search, page: "1" });
            }}
          >
            <label className="gallery-field gallery-search">
              <span className="sr-only">{t("搜尋素材", "Search media")}</span>
              <input
                className="ui-control gallery-input"
                type="search"
                placeholder={t("搜尋標題、說明或作者…", "Search title, description or creator…")}
                value={search}
                maxLength={120}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <button className="gallery-button" type="submit">
              {t("搜尋", "Search")}
            </button>
            <Select
              label={t("素材類型", "Media type")}
              value={params.get("kind") ?? ""}
              options={[
                { value: "", label: t("全部素材", "All media") },
                { value: "image", label: t("圖片", "Images") },
                { value: "audio", label: t("音訊", "Audio") },
              ]}
              onValueChange={(kind) => updateQuery({ kind, page: "1" })}
            />
          </form>
        )}
        {error !== undefined && (
          <div role="alert" className="gallery-error">
            {errorText(error, t)}{" "}
            <button className="gallery-button" onClick={refresh}>
              {t("重新載入", "Reload")}
            </button>
          </div>
        )}
        {loading && <p role="status">{t("正在載入素材…", "Loading media…")}</p>}
        {data && (
          <>
            {data.items.length ? (
              <div className="gallery-grid">
                {data.items.map((item) => (
                  <article className="gallery-card" key={item.id}>
                    <Preview entry={item} t={t} />
                    <div className="gallery-card-body">
                      <div className="gallery-card-meta">
                        <span>{item.kind === "image" ? "RGF" : "RSF"}</span>
                        <span>{statusText(item.status, t)}</span>
                      </div>
                      <h2>
                        <Link to={`/gallery/${item.id}`}>{item.title}</Link>
                      </h2>
                      <p className="gallery-muted">
                        @{item.author} · {details(item)}
                      </p>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="gallery-empty">
                <h2>{t("這裡還沒有素材", "No media here yet")}</h2>
                <p>
                  {t(
                    "試試其他搜尋條件，或分享第一件作品。",
                    "Try another search, or share the first creation.",
                  )}
                </p>
                <Link className="gallery-primary" to="/gallery/submit">
                  {t("分享素材", "Share media")}
                </Link>
              </div>
            )}
            <nav className="gallery-pagination" aria-label={t("分頁", "Pagination")}>
              <button
                className="gallery-button"
                disabled={page <= 1}
                onClick={() => updateQuery({ page: String(page - 1) })}
              >
                {t("上一頁", "Previous")}
              </button>
              <span>{page}</span>
              <button
                className="gallery-button"
                disabled={!data.more}
                onClick={() => updateQuery({ page: String(page + 1) })}
              >
                {t("下一頁", "Next")}
              </button>
            </nav>
          </>
        )}
        {entry && (
          <EntryDetail
            key={`${entry.id}-${entry.version}`}
            entry={entry}
            user={auth?.user ?? null}
            t={t}
            refresh={refresh}
          />
        )}
      </main>
    </>
  );
}
