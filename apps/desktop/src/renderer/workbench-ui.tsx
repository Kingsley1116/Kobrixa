import { useEffect, useRef, useState, type ReactNode } from "react";
import kobrixaMark from "../../../../assets/brand/kobrixa-mark.svg";
import type { DeviceDescriptor, Diagnostic } from "../shared/api.js";
import type { Copy, Locale } from "./copy.js";
import type { ExecutionState } from "./execution.js";
import { Picker } from "./picker.js";
export { Modal } from "./modal.js";

export function Icon({
  name,
}: {
  name:
    | "play"
    | "stop"
    | "sun"
    | "moon"
    | "plus"
    | "folder"
    | "device"
    | "code"
    | "arrow"
    | "settings"
    | "language";
}): React.JSX.Element {
  const paths = {
    settings:
      "M9 3h6v3l2 1 2.5-1.5 3 5L20 12v2l2.5 1.5-3 5L17 19l-2 1v3H9v-3l-2-1-2.5 1.5-3-5L4 14v-2L1.5 10.5l3-5L7 7l2-1Z M15 13a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
    language: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z",
    play: "m8 5 11 7-11 7Z",
    stop: "M6 6h12v12H6Z",
    sun: "M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
    moon: "M20 14A8 8 0 0 1 10 4a8 8 0 1 0 10 10Z",
    plus: "M12 5v14M5 12h14",
    folder: "M3 7V5h6l2 2h10v13H3Z",
    device: "M6 3h12v18H6ZM9 6h6v5H9Zm1 10h4m-2-2v4",
    code: "m8 7-5 5 5 5m8-10 5 5-5 5M14 4l-4 16",
    arrow: "M4 12h16m-6-6 6 6-6 6",
  };
  return (
    <svg
      className="ui-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}

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

export function ActionMenu({
  label,
  visibleLabel,
  children,
}: {
  label: string;
  visibleLabel?: ReactNode;
  children: ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLButtonElement>("[role=menu] button:not(:disabled)")?.focus();
    const outside = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return (
    <div
      className="action-menu"
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
        if (open && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const items = [
            ...(root.current?.querySelectorAll<HTMLButtonElement>(
              "[role=menu] button:not(:disabled)",
            ) ?? []),
          ];
          const index = items.indexOf(document.activeElement as HTMLButtonElement);
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? items.length - 1
                : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
          items[next]?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        className="more-button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {visibleLabel ?? "•••"}
      </button>
      {open && (
        <div
          className="action-menu-content"
          role="menu"
          aria-label={label}
          onClick={(event) => {
            if ((event.target as HTMLElement).closest("button")) {
              setOpen(false);
              trigger.current?.focus();
            }
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export function Toolbar({
  t,
  locale,
  appearance,
  name,
  locked,
  canSave,
  deviceLocked,
  state,
  onNew,
  onOpen,
  onSave,
  onRun,
  onStop,
  onBuild,
  onUpload,
  onRunUploaded,
  onDelete,
  onCancel,
  onDevice,
}: {
  t: Copy;
  locale: Locale;
  appearance: ReactNode;
  name: string | undefined;
  locked: boolean;
  canSave: boolean;
  deviceLocked: boolean;
  state: ExecutionState;
  onNew(): void;
  onOpen(): void;
  onSave(): void;
  onRun(): void;
  onStop(): void;
  onBuild(): void;
  onUpload(): void;
  onRunUploaded(): void;
  onDelete(): void;
  onCancel(): void;
  onDevice(): void;
}): React.JSX.Element {
  return (
    <header className="topbar">
      <div className="brand">
        <img className="brand-mark" src={kobrixaMark} alt="" />
        <span>Kobrixa</span>
        <small>IDE</small>
      </div>
      <div className="toolbar-project" title={name}>
        {name ?? t.workspace}
      </div>
      <nav className="file-actions" aria-label={t.files}>
        <button disabled={locked} title={t.newProject} onClick={onNew}>
          <Icon name="plus" />
        </button>
        <button disabled={locked} title={t.open} onClick={onOpen}>
          <Icon name="folder" />
        </button>
        {name && (
          <button disabled={!canSave || locked} onClick={onSave}>
            {t.save}
          </button>
        )}
      </nav>
      <div className="run-actions">
        {name && (
          <>
            <button
              className={`connection-chip ${state.session ? "is-connected" : ""}`}
              onClick={onDevice}
              title={t.showDevice}
            >
              <span className="status-dot" />
              EV3{" "}
              <span className="connection-label">
                {state.session ? t.connectionStates.connected : t.connectionStates.disconnected}
              </span>
            </button>
            <button className="primary run-button" disabled={deviceLocked} onClick={onRun}>
              <Icon name="play" />
              {t.runOnDevice}
            </button>
            {state.phase === "building" ? (
              <button onClick={onCancel}>{t.cancel}</button>
            ) : (
              <button
                className="stop-button"
                title={t.stop}
                aria-label={t.stop}
                disabled={!state.session || deviceLocked}
                onClick={onStop}
              >
                <Icon name="stop" />
              </button>
            )}
            <ActionMenu label={t.advanced}>
              <button role="menuitem" disabled={deviceLocked} onClick={onBuild}>
                {t.build}
              </button>
              <button
                role="menuitem"
                disabled={deviceLocked || !state.session || !state.successfulBuild}
                onClick={onUpload}
              >
                {t.uploadLatest}
              </button>
              <button
                role="menuitem"
                disabled={deviceLocked || !state.deployed}
                onClick={onRunUploaded}
              >
                {t.runUploaded}
              </button>
              <button
                role="menuitem"
                className="danger"
                disabled={deviceLocked || !state.deployed}
                onClick={onDelete}
              >
                {t.deleteUploaded}
              </button>
              <div className="menu-version">
                {t.latestBuild}:{" "}
                {state.successfulBuild ? versionLabel(state.successfulBuild, locale) : t.noBuild}
                <br />
                {t.deployedVersion}:{" "}
                {state.deployed ? versionLabel(state.deployed, locale) : t.noUpload}
              </div>
            </ActionMenu>
          </>
        )}
      </div>
      <div className="preferences">{appearance}</div>
    </header>
  );
}

function versionLabel(version: { path: string; time: number }, locale: Locale): string {
  return `${version.path.split("/").at(-1)} · ${new Date(version.time).toLocaleTimeString(locale, { hour12: false })}`;
}

export function DevicePanel({
  t,
  locale,
  state,
  devices,
  discovering,
  locked,
  mode,
  onMode,
  selected,
  onSelect,
  address,
  onAddress,
  onDiscover,
  onConnect,
  onDisconnect,
  onCancel,
}: {
  t: Copy;
  locale: Locale;
  state: ExecutionState;
  devices: DeviceDescriptor[];
  discovering: boolean;
  locked: boolean;
  mode: "usb" | "wifi";
  onMode(mode: "usb" | "wifi"): void;
  selected: string | undefined;
  onSelect(id: string): void;
  address: string;
  onAddress(value: string): void;
  onDiscover(): void;
  onConnect(): void;
  onDisconnect(): void;
  onCancel(): void;
}): React.JSX.Element {
  const connectionBusy = locked && state.phase !== "awaitingDevice";
  const found = devices.filter((device) => device.transport === mode);
  return (
    <>
      <div className="device-identity">
        <div className="device-symbol">
          <Icon name="device" />
        </div>
        <div>
          <strong>{state.session?.name ?? "LEGO MINDSTORMS"}</strong>
          <span>{state.session ? state.session.transport.toUpperCase() : "EV3"}</span>
        </div>
      </div>
      <div className={`connection-banner ${state.session ? "is-connected" : ""}`}>
        <span className="status-dot" />
        {state.session
          ? t.connectionStates.connected
          : state.phase === "connecting"
            ? t.connectionStates.connecting
            : t.connectionStates.disconnected}
      </div>
      <p className="panel-hint">{state.session ? t.connectionReady : t.connectionHint}</p>
      {state.phase === "awaitingDevice" && (
        <div className="pending-run">
          <p>{t.connectionRequired}</p>
          <button onClick={onCancel}>{t.cancel}</button>
        </div>
      )}
      {!state.session ? (
        <>
          <div className="connection-method" role="group" aria-label={t.mode}>
            <button
              aria-pressed={mode === "usb"}
              disabled={connectionBusy}
              onClick={() => onMode("usb")}
            >
              USB
            </button>
            <button
              aria-pressed={mode === "wifi"}
              disabled={connectionBusy}
              onClick={() => onMode("wifi")}
            >
              Wi-Fi
            </button>
          </div>
          <p className="panel-hint">{mode === "usb" ? t.usbHint : t.wifiHint}</p>
          <button className="wide" disabled={connectionBusy || discovering} onClick={onDiscover}>
            {discovering ? t.searching : t.discover}
          </button>
          <label>
            {t.selectDevice}
            <Picker
              locale={locale}
              label={t.selectDevice}
              searchable
              value={selected}
              disabled={connectionBusy || !found.length}
              onChange={onSelect}
              options={found.map((device) => ({
                value: device.id,
                label: `${device.name} · ${device.transport.toUpperCase()}`,
              }))}
            />
          </label>
          {mode === "wifi" && (
            <label>
              {t.address}
              <input
                disabled={connectionBusy}
                placeholder="192.168.0.42"
                value={address}
                onChange={(event) => onAddress(event.target.value)}
              />
            </label>
          )}
          <button
            className="primary wide"
            disabled={connectionBusy || (!selected && !(mode === "wifi" && address.trim()))}
            onClick={onConnect}
          >
            {state.phase === "connecting" ? t.phases.connecting : t.connect}
          </button>
        </>
      ) : (
        <button className="wide" disabled={locked} onClick={onDisconnect}>
          {t.disconnect}
        </button>
      )}
      {state.error && (
        <div className="operation-error" role="alert">
          <strong>{t.phases.error}</strong>
          <p>
            {[
              "connecting",
              "uploading",
              "running",
              "stopping",
              "deleting",
              "disconnecting",
              "idle",
            ].includes(state.error.phase)
              ? t.reconnectHint
              : t.errorHint}
          </p>
          <details>
            <summary>{t.details}</summary>
            <pre>{state.error.detail}</pre>
          </details>
        </div>
      )}
      <div className="version-card">
        <span>{t.latestBuild}</span>
        <strong>
          {state.successfulBuild ? versionLabel(state.successfulBuild, locale) : t.noBuild}
        </strong>
        <span>{t.deployedVersion}</span>
        <strong>{state.deployed ? versionLabel(state.deployed, locale) : t.noUpload}</strong>
        {state.deployed && <code>{state.deployed.path}</code>}
      </div>
    </>
  );
}

export function BottomPanel({
  t,
  open,
  onToggle,
  diagnostics,
  selected,
  checking,
  onJump,
}: {
  t: Copy;
  open: boolean;
  onToggle(): void;
  diagnostics: Diagnostic[];
  selected: number;
  checking: boolean;
  onJump(item: Diagnostic, index: number): void;
}): React.JSX.Element {
  return (
    <section className={`problems ${open ? "" : "collapsed"}`}>
      <div className="problems-header">
        <div className="bottom-tabs">
          <button aria-expanded={open} onClick={onToggle}>
            {open ? "⌄" : "›"} {t.diagnostics} <strong>{diagnostics.length}</strong>
          </button>
        </div>
        <div className="diagnostic-summary">
          {checking && <span>{t.checking}</span>}
          <span className="error-count">
            {diagnostics.filter((item) => item.severity === "error").length} {t.errors}
          </span>
          <span className="warning-count">
            {diagnostics.filter((item) => item.severity === "warning").length} {t.warnings}
          </span>
        </div>
      </div>
      {open && (
        <div className="problem-list">
          {diagnostics.length ? (
            diagnostics.map((item, index) => (
              <button
                className={selected === index ? "active" : ""}
                key={`${item.code}-${index}`}
                onClick={() => onJump(item, index)}
              >
                <b className={item.severity}>{item.code}</b>
                <span>{item.message}</span>
                <small>
                  {item.file}:{item.range.startLine}:{item.range.startColumn}
                </small>
              </button>
            ))
          ) : (
            <p>{checking ? t.checking : t.noProblems}</p>
          )}
        </div>
      )}
    </section>
  );
}

/** Shared focus trap and focus restoration for every existing dialog. */
