import { Link, NavLink } from "react-router";
import "./site-header.css";

type Locale = "zh-TW" | "en";
type Page = "home" | "features" | "docs" | "tools" | "download" | "gallery" | "terms" | "privacy";
const labels = {
  "zh-TW": {
    home: "首頁",
    features: "功能",
    docs: "文件",
    tools: "工具",
    gallery: "素材庫",
    download: "下載",
    navigation: "主要導覽",
    language: "English",
    switchLanguage: "切換為英文",
  },
  en: {
    home: "Home",
    features: "Features",
    docs: "Docs",
    tools: "Tools",
    gallery: "Gallery",
    download: "Download",
    navigation: "Main navigation",
    language: "繁中",
    switchLanguage: "Switch to Traditional Chinese",
  },
};
const links = [
  { key: "home", href: "/" },
  { key: "features", href: "/features" },
  { key: "docs", href: "/docs" },
  { key: "tools", href: "/tools" },
  { key: "gallery", href: "/gallery" },
  { key: "download", href: "/download" },
] as const;

export function SiteHeader({
  locale,
  page,
  onLocaleChange,
}: {
  locale: Locale;
  page: Page;
  onLocaleChange: (locale: Locale) => void;
}) {
  const t = labels[locale];
  return (
    <header className="app-navbar" data-page={page}>
      <div className="app-navbar-inner">
        <Link className="app-navbar-brand" to="/" aria-label={`Kobrixa — ${t.home}`}>
          <img src="/icons/kobrixa-mark.svg" alt="" aria-hidden="true" />
          <span>Kobrixa</span>
        </Link>
        <nav className="app-navbar-links" aria-label={t.navigation}>
          {links.map((link) => (
            <NavLink key={link.key} to={link.href} end={link.key === "home"}>
              {t[link.key]}
            </NavLink>
          ))}
        </nav>
        <div className="app-navbar-actions">
          <a
            className="app-navbar-github"
            href="https://github.com/Kingsley1116/Kobrixa"
            target="_blank"
            rel="noreferrer"
          >
            GitHub <span aria-hidden="true">↗</span>
          </a>
          <button
            className="app-navbar-language"
            onClick={() => onLocaleChange(locale === "zh-TW" ? "en" : "zh-TW")}
            aria-label={t.switchLanguage}
          >
            {t.language}
          </button>
        </div>
      </div>
    </header>
  );
}
