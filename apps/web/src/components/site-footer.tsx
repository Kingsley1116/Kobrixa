import { Link } from "react-router";
import { LEGAL_EMAIL } from "../features/legal/legal-content.js";
import "./site-footer.css";

function ExternalArrow() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 12 12 4M4 4h8v8" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function SiteFooter({ locale }: { locale: "zh-TW" | "en" }) {
  const zh = locale === "zh-TW";
  const github = "https://github.com/Kingsley1116/Kobrixa";
  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <div className="site-footer-main">
          <div className="site-footer-brand">
            <Link
              className="site-footer-logo"
              to="/"
              aria-label={zh ? "Kobrixa — 首頁" : "Kobrixa — Home"}
            >
              <img src="/icons/kobrixa-mark.svg" alt="" width="36" height="36" />
              <span>Kobrixa</span>
            </Link>
            <p className="site-footer-tagline">
              {zh ? "讓想法，接上 EV3。" : "Connect your ideas to EV3."}
            </p>
            <p className="site-footer-description">
              {zh
                ? "獨立、開源的程式開發環境。\n從第一行程式，到機器人的下一步。"
                : "An independent, open-source programming environment.\nFrom your first line of code to your robot’s next move."}
            </p>
            <a className="site-footer-contact" href={`mailto:${LEGAL_EMAIL}`}>
              {LEGAL_EMAIL} <ExternalArrow />
            </a>
          </div>
          <div className="site-footer-navigation">
            <nav aria-label={zh ? "頁尾：探索" : "Footer: Explore"}>
              <h2>{zh ? "探索" : "Explore"}</h2>
              <ul>
                <li>
                  <Link to="/features">{zh ? "功能介紹" : "Features"}</Link>
                </li>
                <li>
                  <Link to="/download">{zh ? "下載 Kobrixa" : "Get Kobrixa"}</Link>
                </li>
                <li>
                  <Link to="/tools">{zh ? "媒體工具" : "Media tools"}</Link>
                </li>
                <li>
                  <Link to="/gallery">{zh ? "社群素材庫" : "Community gallery"}</Link>
                </li>
              </ul>
            </nav>
            <nav aria-label={zh ? "頁尾：學習與開源" : "Footer: Learn & contribute"}>
              <h2>{zh ? "學習與開源" : "Learn & contribute"}</h2>
              <ul>
                <li>
                  <Link to="/docs">{zh ? "使用文件" : "Documentation"}</Link>
                </li>
                <li>
                  <Link to={`/docs/diagnostics?lang=${locale}`}>
                    {zh ? "錯誤索引" : "Diagnostic index"}
                  </Link>
                </li>
                <li>
                  <Link to="/docs/reference/code-signing">Code signing policy</Link>
                </li>
                <li>
                  <a href={`${github}/tree/main/docs/${locale}`} target="_blank" rel="noreferrer">
                    {zh ? "GitHub 文件" : "Docs on GitHub"}
                    <ExternalArrow />
                  </a>
                </li>
                <li>
                  <a href={github} target="_blank" rel="noreferrer">
                    {zh ? "原始碼" : "Source code"}
                    <ExternalArrow />
                  </a>
                </li>
              </ul>
            </nav>
          </div>
        </div>
        <div className="site-footer-bottom">
          <span className="site-footer-note">MADE FOR EV3 · OPEN SOURCE</span>
          <nav aria-label={zh ? "條款與隱私" : "Terms and privacy"}>
            <Link to="/terms">{zh ? "服務條款" : "Terms of Service"}</Link>
            <Link to="/privacy">{zh ? "隱私政策" : "Privacy Policy"}</Link>
            <a href={`${github}/blob/main/LICENSE`} target="_blank" rel="noreferrer">
              Apache-2.0
              <ExternalArrow />
            </a>
          </nav>
        </div>
        <p className="site-footer-trademark">
          {zh
            ? "LEGO、MINDSTORMS 與 EV3 是 LEGO Group 的商標。Kobrixa 與 LEGO Group 無隸屬、認可或贊助關係。"
            : "LEGO, MINDSTORMS and EV3 are trademarks of the LEGO Group. Kobrixa is not affiliated with, endorsed by, or sponsored by the LEGO Group."}
        </p>
      </div>
    </footer>
  );
}
