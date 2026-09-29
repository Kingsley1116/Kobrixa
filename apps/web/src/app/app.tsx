import { SiteFooter } from "../components/site-footer.js";
import { useEffect, useRef, useState } from "react";
import { Outlet, ScrollRestoration, useLocation } from "react-router";

type Locale = "zh-TW" | "en";

export type PageContext = {
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
};

export function App() {
  const [locale, setLocale] = useState<Locale>(() =>
    localStorage.getItem("kobrixa-locale") === "en" ? "en" : "zh-TW",
  );
  const { pathname } = useLocation();
  const previousPath = useRef(pathname);

  useEffect(() => {
    document.documentElement.lang = locale;
    localStorage.setItem("kobrixa-locale", locale);
  }, [locale]);

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
      <Outlet context={{ locale, onLocaleChange: setLocale } satisfies PageContext} />
      <SiteFooter locale={locale} />
      <ScrollRestoration />
    </>
  );
}
