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
  const tools = {
    image: {
      title: t("圖片工作室", "Image studio"),
      hint: t("把圖片轉成 EV3 螢幕的黑白點陣", "Turn pictures into EV3 screen pixels"),
      spec: "RGF · 176 × 128 · 1-BIT",
    },
    audio: {
      title: t("音頻工作室", "Audio studio"),
      hint: t("剪出一段聲音，讓 EV3 播放", "Trim a sound for your EV3 to play"),
      spec: "RSF · 8 kHz",
    },
  };
  return (
    <>
      <AppLink className="skip-link" href="#content">
        {t("跳到主要內容", "Skip to content")}
      </AppLink>
      <SiteHeader locale={locale} page="tools" onLocaleChange={onLocaleChange} />
      <main id="content" className="studio">
        <header className="studio-hero">
          <p className="studio-eyebrow">
            <i aria-hidden="true" />
            KOBRIXA / MEDIA STUDIO
          </p>
          <h1>{t("小素材，大創意。", "Small files. Big possibilities.")}</h1>
          <p className="studio-lead">
            {t(
              "把你喜歡的畫面與聲音，帶進 EV3 的世界。",
              "Bring your favorite images and sounds into the world of EV3.",
            )}
          </p>
          <p className="local-badge">
            <Icon name="shield" />
            <span>{t("只在你的瀏覽器處理", "Processed in your browser")}</span>
            <small>{t("檔案不會上傳", "Your files stay with you")}</small>
          </p>
        </header>
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
              <span className="studio-tab-icon">
                <Icon name={key} size={22} />
              </span>
              <span className="studio-tab-copy">
                <strong>{tools[key].title}</strong>
                <span>{tools[key].hint}</span>
              </span>
              <small>{tools[key].spec}</small>
            </button>
          ))}
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
        <footer className="studio-footer">
          <span>KOBRIXA · {t("為 EV3 而做", "Made for EV3")}</span>
          <AppLink href="/docs">
            {t("需要幫忙？閱讀文件", "Need a hand? Read the docs")} <Icon name="external" />
          </AppLink>
        </footer>
      </main>
    </>
  );
}
