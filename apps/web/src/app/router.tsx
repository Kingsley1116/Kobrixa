import { useEffect, type ComponentType } from "react";
import { createBrowserRouter, useLocation, useOutletContext } from "react-router";
import { HomePage } from "../features/home/home-page.js";
import { App } from "./app.js";
import type { PageContext } from "./app.js";

type Page = ComponentType<PageContext & { path: string }>;
// Resolve before navigation commits, so focus and scroll restoration see the real page.
const lazyPage = (load: () => Promise<Page>) => async () => {
  const Component = await load();
  return {
    Component: function PageRoute() {
      const props = useOutletContext<PageContext>();
      const { pathname } = useLocation();
      return <Component {...props} path={pathname} />;
    },
  };
};
function HomeRoute() {
  const props = useOutletContext<PageContext>();
  useEffect(() => {
    document.title =
      props.locale === "zh-TW" ? "Kobrixa — 用程式驅動創意" : "Kobrixa — Make ideas move with code";
  }, [props.locale]);
  return <HomePage {...props} />;
}

function RouteStatus({ failed = false }: { failed?: boolean }) {
  const en = document.documentElement.lang === "en";
  return (
    <main id="content" className="route-message" role={failed ? "alert" : "status"}>
      <h1>
        {failed
          ? en
            ? "Unable to load this page"
            : "無法載入此頁"
          : en
            ? "Loading…"
            : "正在載入…"}
      </h1>
      {failed && (
        <>
          <p>
            {en ? "Check your connection and reload to try again." : "請確認網路連線，再重新載入。"}
          </p>
          <button className="button primary" onClick={() => window.location.reload()}>
            {en ? "Reload" : "重新載入"}
          </button>
        </>
      )}
    </main>
  );
}
const legalPage = (kind: "terms" | "privacy") =>
  lazyPage(async () => {
    const { LegalPage } = await import("../features/legal/legal-page.js");
    return function LegalRoute(props: PageContext) {
      return <LegalPage {...props} kind={kind} />;
    };
  });

export const router = createBrowserRouter([
  {
    element: <App />,
    HydrateFallback: RouteStatus,
    ErrorBoundary: () => <RouteStatus failed />,
    children: [
      { index: true, element: <HomeRoute /> },
      {
        path: "features",
        lazy: lazyPage(
          async () => (await import("../features/product/product-pages.js")).FeaturesPage,
        ),
      },
      {
        path: "download",
        lazy: lazyPage(
          async () => (await import("../features/product/product-pages.js")).DownloadPage,
        ),
      },
      {
        path: "tools",
        lazy: lazyPage(async () => (await import("../features/tools/tools-page.js")).ToolsPage),
      },
      { path: "terms", lazy: legalPage("terms") },
      { path: "privacy", lazy: legalPage("privacy") },
      {
        path: "gallery/*",
        lazy: lazyPage(
          async () => (await import("../features/gallery/gallery-page.js")).GalleryPage,
        ),
      },
      {
        path: "docs/*",
        lazy: lazyPage(async () => (await import("../features/docs/docs-page.js")).DocsPage),
      },
      { path: "*", element: <HomeRoute /> },
    ],
  },
]);
