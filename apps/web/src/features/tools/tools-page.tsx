import { Icon } from "../../components/ui/icon.js";
import { AppLink } from "../../components/app-link.js";
import { SiteHeader } from "../../components/site-header.js";
import { useEffect, useState } from "react";
import { ImageTool } from "./components/image-tool.js";
import { AudioTool } from "./components/audio-tool.js";
import "./tools.css";
export function ToolsPage({
  locale,
  onLocaleChange,
}: {
  locale: "zh-TW" | "en";
  onLocaleChange: (locale: "zh-TW" | "en") => void;
}) {
  const t = (zh: string, en: string) => (locale === "zh-TW" ? zh : en);
  const [tab, setTab] = useState<"image" | "audio">("image");
  useEffect(() => {
    document.title = locale === "zh-TW" ? "EV3 媒體工作室 — Kobrixa" : "EV3 Media Studio — Kobrixa";
  }, [locale]);
  return (
    <>
      <AppLink className="skip-link" href="#content">
        {t("跳到主要內容", "Skip to content")}
      </AppLink>
      <SiteHeader locale={locale} page="tools" onLocaleChange={onLocaleChange} />
      <main id="content" className="studio">
        <div className="studio-hero">
          <div>
            <p className="studio-eyebrow">
              <span />
              KOBRIXA / MEDIA STUDIO
            </p>
            <h1>{t("小素材，大創意。", "Small files. Big possibilities.")}</h1>
            <p>
              {t(
                "把你喜歡的畫面與聲音，帶進 EV3 的世界。",
                "Bring your favorite images and sounds into the world of EV3.",
              )}
            </p>
          </div>
          <div className="local-badge">
            <Icon name="check" />
            <span>
              {t("只在你的瀏覽器處理", "Processed in your browser")}
              <small>{t("檔案不會上傳", "Your files stay with you")}</small>
            </span>
          </div>
        </div>
        <div className="studio-topbar">
          <div className="studio-tabs" role="tablist" aria-label={t("媒體工具", "Media tools")}>
            {(["image", "audio"] as const).map((key) => (
              <button
                key={key}
                id={`tab-${key}`}
                role="tab"
                aria-selected={tab === key}
                aria-controls={`panel-${key}`}
                tabIndex={tab === key ? 0 : -1}
                onClick={() => setTab(key)}
                onKeyDown={(e) => {
                  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
                  e.preventDefault();
                  const next =
                    e.key === "Home"
                      ? "image"
                      : e.key === "End"
                        ? "audio"
                        : tab === "image"
                          ? "audio"
                          : "image";
                  setTab(next);
                  document.getElementById(`tab-${next}`)?.focus();
                }}
              >
                <Icon name={key} size={22} />
                <span>
                  {key === "image"
                    ? t("圖片工作室", "Image studio")
                    : t("音頻工作室", "Audio studio")}
                </span>
                <small>{key === "image" ? "RGF" : "RSF"}</small>
              </button>
            ))}
          </div>
        </div>
        <section
          id="panel-image"
          role="tabpanel"
          aria-labelledby="tab-image"
          hidden={tab !== "image"}
        >
          <ImageTool t={t} active={tab === "image"} />
        </section>
        <section
          id="panel-audio"
          role="tabpanel"
          aria-labelledby="tab-audio"
          hidden={tab !== "audio"}
        >
          <AudioTool t={t} active={tab === "audio"} />
        </section>
        <div className="studio-footer">
          <span>KOBRIXA · {t("為 EV3 而做", "Made for EV3")}</span>
          <AppLink href="/docs">
            {t("需要幫忙？閱讀文件", "Need a hand? Read the docs")} <Icon name="external" />
          </AppLink>
        </div>
      </main>
    </>
  );
}
