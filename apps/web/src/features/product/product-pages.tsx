import { Icon, type IconName } from "../../components/ui/icon.js";
import { AppLink } from "../../components/app-link.js";
import { useEffect } from "react";
import { SiteHeader } from "../../components/site-header.js";
import { DiagnosticShowcase } from "./diagnostic-showcase.js";
import metadata from "../../../../../package.json" with { type: "json" };
import "./product-pages.css";

type Locale = "zh-TW" | "en";
type Props = { locale: Locale; onLocaleChange: (locale: Locale) => void };
const mediaCode =
  'LCD.Clear()\nLCD.BmpFile(1, 0, 0, "assets/deploy/kobrixa-mascot")\nLCD.Update()\nSpeaker.Play(35, "assets/deploy/kobrixa-chime")\nSpeaker.Wait()';
export function FeaturesPage({ locale, onLocaleChange }: Props) {
  const t = (zh: string, en: string) => (locale === "zh-TW" ? zh : en);
  useEffect(() => {
    document.title = locale === "zh-TW" ? "功能 — Kobrixa" : "Features — Kobrixa";
  }, [locale]);
  const features: {
    tag: string;
    icon: IconName;
    title: string;
    body: string;
    link: string;
    label: string;
  }[] = [
    {
      icon: "code",
      tag: "EDITOR",
      title: t("在本機，專心寫程式。", "A focused place to write."),
      body: t(
        "在多個專案間切換，保留分頁與草稿。使用補全、雙語離線診斷與 Quick Fix；編輯器與編譯器不需要雲端帳號。",
        "Switch between projects while keeping tabs and drafts. Use completion, bilingual offline diagnostics and Quick Fix without a cloud account.",
      ),
      link: "/docs/tutorial/first-program",
      label: t("寫第一個程式", "Write your first program"),
    },
    {
      icon: "build",
      tag: "COMPILER",
      title: t("從 .bp 到原生 .rbf。", "From .bp to native .rbf."),
      body: t(
        "將支援的 Basic Plus 程式在本機編譯成 EV3 執行檔。不支援的語法會提供明確診斷，方便回到原始碼修正。",
        "Compile supported Basic Plus programs locally into native EV3 executables. Unsupported syntax produces diagnostics you can act on.",
      ),
      link: "/docs/reference/language-support",
      label: t("了解語言支援", "Explore language support"),
    },
    {
      icon: "device",
      tag: "CONNECTION",
      title: t("把程式帶到機器人上。", "Put your code on the brick."),
      body: t(
        "透過 USB 或 Wi-Fi 上傳、執行、停止程式及管理 EV3 檔案。內建馬達點動、定時與角度測試；實體 EV3 驗收已由維護者確認通過。",
        "Upload, run and stop programs and manage EV3 files over USB or Wi-Fi. Test motors with jog, timed and angle controls; physical EV3 acceptance is confirmed by the maintainer.",
      ),
      link: "/docs/reference/device-support",
      label: t("查看裝置支援", "Check device support"),
    },
    {
      icon: "users",
      tag: "COLLABORATION",
      title: t("同一個專案，一起完成。", "Work on the same project together."),
      body: t(
        "不需帳號，以邀請碼與選填密碼共同編輯、聊天及分配 EV3 控制權。candidate.14 提供本機變更處理與更新的房間面板；協作需要網路連線。",
        "Co-edit, chat and share EV3 control using an invite code and optional password, without an account. Candidate.14 adds local-change choices and an updated room panel. Collaboration requires internet access.",
      ),
      link: "/docs/reference/collaboration",
      label: t("了解雲端協作", "Explore cloud collaboration"),
    },
    {
      icon: "chart",
      tag: "SENSOR LAB",
      title: t("把讀值，變成看得見的曲線。", "Turn readings into visible patterns."),
      body: t(
        "記錄感測器與馬達計數、比較實驗曲線，並匯出 CSV。兩點校正與歸零可產生 Basic Plus 範例，方便帶回程式使用。",
        "Record sensor readings and motor counts, compare experiments and export CSV. Generate Basic Plus examples for two-point calibration and zeroing.",
      ),
      link: "/docs/reference/sensor-lab",
      label: t("使用 Sensor Lab", "Use Sensor Lab"),
    },
    {
      icon: "audio",
      tag: "MEDIA STUDIO",
      title: t("讓 EV3 有畫面，也有聲音。", "Give your EV3 a face and a voice."),
      body: t(
        "在瀏覽器將圖片轉為 RGF、音頻轉為 RSF。使用黑白預覽、抖色與波形裁切，檔案全程留在本機。",
        "Convert images to RGF and audio to RSF in your browser. Use monochrome previews, dithering and waveform trimming while your files stay local.",
      ),
      link: "/tools",
      label: t("開啟媒體工作室", "Open the media studio"),
    },
    {
      icon: "image",
      tag: "COMMUNITY GALLERY",
      title: t("讓素材，也能一起分享。", "Share what your robot shows and plays."),
      body: t(
        "瀏覽與下載已審核的 EV3 圖片、音訊及播放範例。用 GitHub 登入後可提交作品，經審核後以 CC BY 4.0 公開分享。",
        "Browse and download reviewed EV3 images, audio and playback examples. Sign in with GitHub to submit your own work for review and publication under CC BY 4.0.",
      ),
      link: "/gallery",
      label: t("瀏覽社群素材庫", "Browse the community gallery"),
    },
    {
      icon: "book",
      tag: "LEARNING",
      title: t("從小練習，走到完整專案。", "Start small. Build something real."),
      body: t(
        "透過教學、API 參考和可閱讀的範例，逐步練習顯示、聲音、馬達與感測器，再組合成自己的機器人專案。",
        "Learn displays, sound, motors and sensors through tutorials, API references and readable examples, then bring them together in a robot project.",
      ),
      link: "/docs/tutorial",
      label: t("瀏覽學習路徑", "Explore the learning path"),
    },
  ];
  return (
    <>
      <AppLink className="skip-link" href="#content">
        {t("跳到主要內容", "Skip to content")}
      </AppLink>
      <SiteHeader locale={locale} page="features" onLocaleChange={onLocaleChange} />
      <main id="content" className="product-page">
        <section className="product-hero feature-hero">
          <div>
            <p className="product-eyebrow">KOBRIXA / FEATURES</p>
            <h1>{t("從一行程式，\n到真正的動作。", "From a line of code\nto real movement.")}</h1>
            <p className="product-lead">
              {t(
                "為學生、創客與教學者，把編寫、建置和 EV3 實作串在一起。每個小想法，都有下一步。",
                "A connected workflow for students, makers and educators: write, build and bring your EV3 to life. Give every small idea a next step.",
              )}
            </p>
            <div className="product-actions">
              <AppLink className="product-button primary" href="/download">
                {t("取得 Kobrixa", "Get Kobrixa")}{" "}
                <span>
                  <Icon name="external" />
                </span>
              </AppLink>
              <AppLink className="product-button secondary" href="/docs">
                {t("開始學習", "Start learning")}{" "}
                <span>
                  <Icon name="arrow" />
                </span>
              </AppLink>
            </div>
            <p className="product-note">
              v{metadata.version} · {t("本機優先", "Local-first")} · Apache-2.0
            </p>
          </div>
          <div className="feature-visual">
            <div className="visual-caption">
              <span className="visual-dot" /> BASIC PLUS <Icon name="arrow" /> EV3
            </div>
            <div className="product-code">
              <div>
                <span className="code-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>{" "}
                original-media.bp
              </div>
              <pre>
                <code>{mediaCode}</code>
              </pre>
              <p>
                {t(
                  "取自原創媒體範例；需一併部署圖片與音頻素材。",
                  "From the original-media example; deploy its image and audio assets too.",
                )}
              </p>
            </div>
            <div className="build-path" aria-label={t("程式建置流程", "Build workflow")}>
              <span>
                .bp <small>{t("原始碼", "Source")}</small>
              </span>
              <i aria-hidden="true">
                <Icon name="arrow" />
              </i>
              <span>
                .rbf <small>{t("建置成品", "Build")}</small>
              </span>
              <i aria-hidden="true">
                <Icon name="arrow" />
              </i>
              <span>
                EV3 <small>{t("實際動作", "Motion")}</small>
              </span>
            </div>
          </div>
        </section>
        <section className="product-section">
          <div className="product-section-heading">
            <div>
              <p className="product-eyebrow">THE TOOLKIT</p>
              <h2>{t("需要的工具，都在同一條路上。", "Everything along the way.")}</h2>
            </div>
            <p>
              {t(
                "從程式碼到實體機器人，逐步完成。",
                "One step at a time, from source code to a physical robot.",
              )}
            </p>
          </div>
          <div className="capability-grid">
            {features.map((feature, index) => (
              <article className="capability-card" key={feature.tag}>
                <div className="capability-meta">
                  <span>
                    <Icon name={feature.icon} size={20} />
                  </span>
                  <span>{feature.tag}</span>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                </div>
                <h3>{feature.title}</h3>
                <p>{feature.body}</p>
                <AppLink
                  href={feature.link}
                  {...(feature.link.startsWith("https:")
                    ? { target: "_blank", rel: "noreferrer" }
                    : {})}
                >
                  {feature.label}{" "}
                  <span aria-hidden="true">
                    <Icon name="external" />
                  </span>
                </AppLink>
              </article>
            ))}
          </div>
        </section>
        <DiagnosticShowcase locale={locale} />
        <section className="product-roadmap">
          <div>
            <p className="product-eyebrow">WHAT’S NEXT</p>
            <h2>{t("把現在做好，再走向下一步。", "Build the foundation. Then go further.")}</h2>
            <p>
              {t(
                "目前候選版已包含雲端協作與設備實驗工具。實體 EV3 驗收已通過；1.0.0 以未簽章版本發佈，模擬器不納入正式發佈。接下來持續擴充 Basic Plus 相容覆蓋與發布驗證。Python、TypeScript、C++ 前端、藍牙與積木編輯器仍屬未來規劃。",
                "The current candidate includes cloud collaboration and device experiments. Physical EV3 acceptance is complete; 1.0.0 ships unsigned and the simulator is excluded from official releases. Work continues on Basic Plus compatibility and release verification. Python, TypeScript and C++ frontends, Bluetooth and a block editor remain future plans.",
              )}
            </p>
          </div>
          <AppLink className="product-button secondary" href="/docs/reference/roadmap">
            {t("查看開發路線圖", "View the roadmap")} <Icon name="arrow" />
          </AppLink>
        </section>
      </main>
    </>
  );
}
