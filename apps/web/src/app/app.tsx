import { SiteFooter } from "../components/site-footer.js";
import { useEffect, useRef, useState } from "react";
import { Outlet, ScrollRestoration, useLocation, useNavigate } from "react-router";

type Locale = "zh-TW" | "en";

export type PageContext = {
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
};

export function App() {
  const [savedLocale, setLocale] = useState<Locale>(() =>
    localStorage.getItem("kobrixa-locale") === "en" ? "en" : "zh-TW",
  );
  const { pathname, search, hash } = useLocation();
  const navigate = useNavigate();
  const isDocumentation = /^\/docs(?:\/|$)/.test(pathname);
  const isDiagnostics = /^\/docs\/diagnostics(?:\/|$)/.test(pathname);
  const requestedLocale = isDocumentation ? new URLSearchParams(search).get("lang") : null;
  const locale =
    requestedLocale === "zh-TW" || requestedLocale === "en" ? requestedLocale : savedLocale;
  const previousPath = useRef(pathname);

  useEffect(() => {
    document.documentElement.lang = locale;
    localStorage.setItem("kobrixa-locale", locale);
    setLocale(locale);
  }, [locale]);

  function onLocaleChange(nextLocale: Locale) {
    setLocale(nextLocale);
    const parameters = new URLSearchParams(search);
    if (isDiagnostics || (isDocumentation && parameters.has("lang"))) {
      parameters.set("lang", nextLocale);
      void navigate({ pathname, search: `?${parameters}`, hash }, { replace: true });
    }
  }

  useEffect(() => {
    if (previousPath.current === pathname) return;
    previousPath.current = pathname;
    const content = document.getElementById("content");
    if (content) {
      content.tabIndex = -1;
      content.focus({ preventScroll: true });
    }
  }, [pathname]);

  return (
    <>
      <Outlet context={{ locale, onLocaleChange } satisfies PageContext} />
      <SiteFooter locale={locale} />
      <ScrollRestoration />
    </>
  );
}
