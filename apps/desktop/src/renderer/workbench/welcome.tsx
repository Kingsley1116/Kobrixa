import kobrixaMark from "../../../../../assets/brand/kobrixa-mark.svg";
import type { Copy } from "../i18n/copy.js";
import { Icon } from "../components/icon.js";

export function Welcome({
  t,
  onNew,
  onOpen,
}: {
  t: Copy;
  onNew(): void;
  onOpen(): void;
}): React.JSX.Element {
  return (
    <section className="welcome">
      <div className="welcome-main">
        <div className="welcome-emblem">
          <img src={kobrixaMark} alt="" />
        </div>
        <p className="eyebrow">{t.welcomeNote}</p>
        <h1>{t.welcome}</h1>
        <p className="welcome-intro">{t.intro}</p>
        <div className="welcome-actions">
          <button className="primary large" onClick={onNew}>
            <Icon name="plus" />
            {t.newProject}
            <Icon name="arrow" />
          </button>
          <button className="secondary large" onClick={onOpen}>
            <Icon name="folder" />
            {t.open}
          </button>
        </div>
      </div>
      <ol className="welcome-steps">
        {(
          [
            ["code", t.editStep, t.editHint],
            ["device", t.connectStep, t.connectHint],
            ["play", t.runStep, t.runHint],
          ] as const
        ).map(([icon, title, hint], index) => (
          <li key={icon}>
            <div className="step-top">
              <Icon name={icon} />
              <span>0{index + 1}</span>
            </div>
            <h2>{title}</h2>
            <p>{hint}</p>
          </li>
        ))}
      </ol>
      <p className="offline-note">
        <span />
        {t.offline}
      </p>
    </section>
  );
}
