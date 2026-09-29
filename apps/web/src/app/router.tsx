import { LegalPage } from "../features/legal/legal-page.js";
import { GalleryPage } from "../features/gallery/gallery-page.js";
import { useEffect } from "react";
import { createBrowserRouter, useLocation, useOutletContext } from "react-router";
import { FeaturesPage, DownloadPage } from "../features/product/product-pages.js";
import { HomePage } from "../features/home/home-page.js";
import { ToolsPage } from "../features/tools/tools-page.js";
import { DocsPage } from "../features/docs/docs-page.js";
import { App } from "./app.js";
import type { PageContext } from "./app.js";

function Page({
  page,
}: {
  page: "home" | "features" | "download" | "tools" | "docs" | "gallery" | "terms" | "privacy";
}) {
  const props = useOutletContext<PageContext>();
  const { pathname } = useLocation();
  useEffect(() => {
    if (page === "home")
      document.title =
        props.locale === "zh-TW"
          ? "Kobrixa — 用程式驅動創意"
          : "Kobrixa — Make ideas move with code";
  }, [page, props.locale]);

  switch (page) {
    case "terms":
    case "privacy":
      return <LegalPage {...props} kind={page} />;
    case "gallery":
      return <GalleryPage {...props} />;
    case "features":
      return <FeaturesPage {...props} />;
    case "download":
      return <DownloadPage {...props} />;
    case "tools":
      return <ToolsPage {...props} />;
    case "docs":
      return <DocsPage {...props} path={pathname} />;
    default:
      return <HomePage {...props} />;
  }
}

export const router = createBrowserRouter([
  {
    element: <App />,
    children: [
      { index: true, element: <Page page="home" /> },
      { path: "features", element: <Page page="features" /> },
      { path: "download", element: <Page page="download" /> },
      { path: "tools", element: <Page page="tools" /> },
      { path: "terms", element: <Page page="terms" /> },
      { path: "privacy", element: <Page page="privacy" /> },
      { path: "gallery/*", element: <Page page="gallery" /> },
      { path: "docs/*", element: <Page page="docs" /> },
      { path: "*", element: <Page page="home" /> },
    ],
  },
]);
