import { Icon } from "../../components/ui/icon.js";
import { PolicyNotice } from "../../components/legal-links.js";
import { Select } from "../../components/ui/select.js";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Link, NavLink, useLocation, useSearchParams } from "react-router";
import { SiteHeader } from "../../components/site-header.js";
import type { GalleryEntry, GalleryList, GalleryUser, MediaKind } from "../../shared/gallery.js";
import type { PageContext } from "../../app/app.js";
import type { Translate } from "../tools/components/tools-ui.js";
import { GalleryEditor } from "./gallery-editor.js";
import { EntryDetail } from "./entry-detail.js";
import { api, errorText } from "./api.js";
import {
  Avatar,
  details,
  Eyebrow,
  formatDate,
  KindBadge,
  Preview,
  StatusBadge,
} from "./gallery-parts.js";
import "./gallery.css";

type Section = "" | "mine" | "admin";
function GalleryCard({ item, section, t }: { item: GalleryEntry; section: Section; t: Translate }) {
  const date = section ? item.updated_at : item.published_at;
  return (
    <article className="gallery-card">
      <div className="gallery-card-media">
        <Preview entry={item} t={t} />
        <div className="gallery-card-badges">
          <KindBadge entry={item} />
          {section && <StatusBadge status={item.status} t={t} />}
        </div>
      </div>
      <div className="gallery-card-body">
        <h2>
          <Link to={`/gallery/${item.id}`}>{item.title}</Link>
        </h2>
        <p className="gallery-card-meta">
          <span className="gallery-author">
            <Avatar id={item.owner_id} login={item.author} size={22} />@{item.author}
          </span>
          <span>{details(item)}</span>
        </p>
        {date && (
          <p className="gallery-card-date">
            {section ? t("更新於 ", "Updated ") : ""}
            {formatDate(date, t)}
          </p>
        )}
      </div>
    </article>
  );
}
function SkeletonGrid({ t }: { t: Translate }) {
  return (
    <div className="gallery-grid" aria-busy="true">
      <p role="status" className="sr-only">
        {t("正在載入素材…", "Loading media…")}
      </p>
      {Array.from({ length: 6 }, (_, i) => (
        <div className="gallery-card gallery-skeleton" key={i} aria-hidden="true">
          <div className="gallery-card-media" />
          <div className="gallery-card-body">
            <i />
            <i />
          </div>
        </div>
      ))}
    </div>
  );
}
function EmptyState({
  title,
  body,
  children,
}: {
  title: string;
  body: string;
  children?: ReactNode;
}) {
  return (
    <div className="gallery-empty">
      <div className="gallery-empty-art" aria-hidden="true">
        <span>
          <Icon name="image" />
        </span>
        <span>
          <Icon name="audio" />
        </span>
      </div>
      <h2>{title}</h2>
      <p>{body}</p>
      {children}
    </div>
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
  const results = useRef<HTMLDivElement>(null);
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
  const kind = params.get("kind") ?? "",
    q = params.get("q") ?? "",
    sort = params.get("sort") ?? "";
  const filtered = Boolean(kind || q);
  const counts = data?.counts;
  const updateQuery = (patch: Record<string, string>) => {
    const next = { ...Object.fromEntries(params), ...patch };
    for (const key of Object.keys(next)) if (!next[key]) delete next[key];
    if (next.page === "1") delete next.page;
    setParams(next);
  };
  const goToPage = (next: number) => {
    updateQuery({ page: String(next) });
    results.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const kinds: { value: "" | MediaKind; label: string; count: number | undefined }[] = [
    { value: "", label: t("全部", "All"), count: counts?.all },
    { value: "image", label: t("圖片", "Images"), count: counts?.image },
    { value: "audio", label: t("音訊", "Audio"), count: counts?.audio },
  ];
  const resultCount = counts ? (kind ? counts[kind as MediaKind] : counts.all) : undefined;
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
          <div className="gallery-account">
            {auth?.user ? (
              <>
                <Avatar id={auth.user.id} login={auth.user.login} size={30} />
                <span>@{auth.user.login}</span>
                <button
                  className="gallery-link-button"
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
              <a className="gallery-button" href="/api/auth/github">
                {t("GitHub 登入", "Sign in with GitHub")} <Icon name="external" />
              </a>
            ) : auth ? (
              <span className="gallery-muted">{t("登入服務待設定", "Sign-in not configured")}</span>
            ) : null}
          </div>
        </div>
        {!auth?.user && <PolicyNotice t={t} action="signin" />}
        {section === "" && (
          <header className="gallery-hero">
            <div>
              <Eyebrow>{t("社群素材庫", "COMMUNITY GALLERY")}</Eyebrow>
              <h1>{t("EV3 素材庫", "EV3 Gallery")}</h1>
              <p className="gallery-lead">
                {t(
                  "探索社群分享的圖片與音效。免費下載，署名使用。",
                  "Discover community images and sounds. Download freely, use with attribution.",
                )}
              </p>
              <div className="gallery-hero-cta">
                <Link className="gallery-primary" to="/gallery/submit">
                  <Icon name="upload" />
                  {t("分享你的素材", "Share your media")}
                </Link>
                <Link className="gallery-text-link" to="/tools">
                  {t("先用 EV3 工具轉換", "Convert with EV3 tools")} <Icon name="arrow" />
                </Link>
              </div>
            </div>
            <div className="gallery-hero-card" aria-hidden="true">
              <div className="gallery-screen-bar">
                <i />
                <i />
                <i />
              </div>
              <div className="gallery-hero-lcd">
                <Icon name="image" size="56" />
                <Icon name="audio" size="56" />
              </div>
              <dl>
                <div>
                  <dt>{t("圖片", "Images")}</dt>
                  <dd>{counts && !q ? counts.image : "—"}</dd>
                </div>
                <div>
                  <dt>{t("音訊", "Sounds")}</dt>
                  <dd>{counts && !q ? counts.audio : "—"}</dd>
                </div>
                <div>
                  <dt>{t("授權", "License")}</dt>
                  <dd>CC BY 4.0</dd>
                </div>
              </dl>
            </div>
          </header>
        )}
        {(submit || section === "mine" || section === "admin") && (
          <header className="gallery-hero compact">
            <Eyebrow>{t("社群素材庫", "COMMUNITY GALLERY")}</Eyebrow>
            <h1>
              {submit
                ? t("分享素材", "Share media")
                : section === "mine"
                  ? t("我的作品", "My works")
                  : t("審核管理", "Moderation")}
            </h1>
            <p className="gallery-lead">
              {submit
                ? t(
                    "轉換、預覽、送審。讓每個人都能用你的素材創作。",
                    "Convert, preview, submit. Help everyone create with your media.",
                  )
                : section === "mine"
                  ? t(
                      "草稿、待審與已公開的作品都在這裡。",
                      "Your drafts, pending and published works, all in one place.",
                    )
                  : t(
                      "核准、拒絕或下架社群投稿。",
                      "Approve, reject or remove community submissions.",
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
            <EmptyState
              title={t("登入後開始分享", "Sign in to start sharing")}
              body={t(
                "所有投稿都會經過審核，公開下載不需登入。",
                "All submissions are reviewed. Public downloads need no account.",
              )}
            >
              {auth?.loginAvailable ? (
                <a className="gallery-primary" href="/api/auth/github">
                  {t("使用 GitHub 登入", "Continue with GitHub")}
                </a>
              ) : (
                <p className="gallery-muted">
                  {auth
                    ? t("登入服務尚未設定完成。", "Sign-in is not configured yet.")
                    : t("正在載入…", "Loading…")}
                </p>
              )}
            </EmptyState>
          ))}
        {list && (
          <div className="gallery-filters" ref={results}>
            <form
              className="gallery-search"
              role="search"
              onSubmit={(e) => {
                e.preventDefault();
                updateQuery({ q: search.trim(), page: "1" });
              }}
            >
              <label>
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
              <button className="gallery-search-submit" type="submit">
                {t("搜尋", "Search")}
              </button>
            </form>
            <div className="gallery-segments" role="group" aria-label={t("素材類型", "Media type")}>
              {kinds.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={kind === option.value}
                  onClick={() => updateQuery({ kind: option.value, page: "1" })}
                >
                  {option.value && <Icon name={option.value} />}
                  {option.label}
                  {option.count !== undefined && <small>{option.count}</small>}
                </button>
              ))}
            </div>
            <Select
              label={t("排序", "Sort")}
              value={sort}
              options={[
                { value: "", label: t("最新", "Newest") },
                { value: "old", label: t("最舊", "Oldest") },
                { value: "title", label: t("標題 A–Z", "Title A–Z") },
              ]}
              onValueChange={(value) => updateQuery({ sort: value, page: "1" })}
            />
          </div>
        )}
        {list && data && (filtered || resultCount !== undefined) && (
          <p className="gallery-summary">
            {resultCount !== undefined && (
              <span>
                {t(
                  `共 ${resultCount} 件`,
                  `${resultCount} ${resultCount === 1 ? "work" : "works"}`,
                )}
              </span>
            )}
            {q && <span>{t(`搜尋「${q}」`, `matching “${q}”`)}</span>}
            {filtered && (
              <button
                className="gallery-link-button"
                type="button"
                onClick={() => updateQuery({ q: "", kind: "", page: "1" })}
              >
                {t("清除篩選", "Clear filters")}
              </button>
            )}
          </p>
        )}
        {error !== undefined && (
          <div role="alert" className="gallery-error">
            {errorText(error, t)}{" "}
            <button className="gallery-link-button" onClick={refresh}>
              {t("重新載入", "Reload")}
            </button>
          </div>
        )}
        {loading && list && <SkeletonGrid t={t} />}
        {loading && !list && !submit && (
          <p role="status" className="gallery-muted">
            {t("正在載入素材…", "Loading media…")}
          </p>
        )}
        {data && (
          <>
            {data.items.length ? (
              <div className="gallery-grid">
                {data.items.map((item) => (
                  <GalleryCard key={item.id} item={item} section={section as Section} t={t} />
                ))}
              </div>
            ) : filtered ? (
              <EmptyState
                title={t("找不到符合的素材", "No matching media")}
                body={t("換個關鍵字或類型試試。", "Try another keyword or media type.")}
              >
                <button
                  className="gallery-button"
                  type="button"
                  onClick={() => updateQuery({ q: "", kind: "", page: "1" })}
                >
                  {t("清除篩選", "Clear filters")}
                </button>
              </EmptyState>
            ) : (
              <EmptyState
                title={
                  section === "admin"
                    ? t("目前沒有待處理的投稿", "Nothing to review")
                    : section === "mine"
                      ? t("你還沒有作品", "You have no works yet")
                      : t("這裡還沒有素材", "No media here yet")
                }
                body={
                  section === "admin"
                    ? t("新的投稿會出現在這裡。", "New submissions will appear here.")
                    : t(
                        "上傳圖片或音訊，審核通過後會公開在這裡。",
                        "Upload an image or sound. Approved works appear here.",
                      )
                }
              >
                {section !== "admin" && (
                  <Link className="gallery-primary" to="/gallery/submit">
                    <Icon name="upload" />
                    {t("分享素材", "Share media")}
                  </Link>
                )}
              </EmptyState>
            )}
            {(page > 1 || data.more) && (
              <nav className="gallery-pagination" aria-label={t("分頁", "Pagination")}>
                <button
                  className="gallery-button"
                  disabled={page <= 1}
                  onClick={() => goToPage(page - 1)}
                >
                  <Icon name="chevron-left" />
                  {t("上一頁", "Previous")}
                </button>
                <span aria-current="page">{t(`第 ${page} 頁`, `Page ${page}`)}</span>
                <button
                  className="gallery-button"
                  disabled={!data.more}
                  onClick={() => goToPage(page + 1)}
                >
                  {t("下一頁", "Next")}
                  <Icon name="chevron-right" />
                </button>
              </nav>
            )}
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
