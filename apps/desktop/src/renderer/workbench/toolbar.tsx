import type { ReactNode } from "react";
import kobrixaMark from "../../../../../assets/brand/kobrixa-mark.svg";
import type { AppCommand } from "../keybindings/keybindings.js";
import type { Copy, Locale } from "../i18n/copy.js";
import type { ExecutionState } from "../execution/execution.js";
import { versionLabel } from "../execution/version-label.js";
import { Icon } from "../components/icon.js";
import { ActionMenu } from "../components/action-menu.js";

export function Toolbar({
  t,
  locale,
  appearance,
  shortcutHint,
  onSaveAll,
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
  shortcutHint(command: AppCommand): string;
  onSaveAll(): void;
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
  const hint = (label: string, command: AppCommand) =>
    [label, shortcutHint(command)].filter(Boolean).join(" · ");
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
        <button disabled={locked} title={hint(t.newProject, "newProject")} onClick={onNew}>
          <Icon name="plus" />
        </button>
        <button disabled={locked} title={hint(t.open, "openProject")} onClick={onOpen}>
          <Icon name="folder" />
        </button>
        {name && (
          <button disabled={!canSave || locked} title={hint(t.save, "save")} onClick={onSave}>
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
              title={hint(t.showDevice, "device")}
            >
              <span className="status-dot" />
              EV3{" "}
              <span className="connection-label">
                {state.session ? t.connectionStates.connected : t.connectionStates.disconnected}
              </span>
            </button>
            <button
              className="primary run-button"
              disabled={deviceLocked}
              title={hint(t.runOnDevice, "run")}
              onClick={onRun}
            >
              <Icon name="play" />
              {t.runOnDevice}
            </button>
            {state.phase === "building" ? (
              <button title={hint(t.cancel, "stop")} onClick={onCancel}>
                {t.cancel}
              </button>
            ) : (
              <button
                className="stop-button"
                title={hint(t.stop, "stop")}
                aria-label={t.stop}
                disabled={!state.session || deviceLocked}
                onClick={onStop}
              >
                <Icon name="stop" />
              </button>
            )}
            <ActionMenu label={t.advanced}>
              <button
                role="menuitem"
                disabled={locked}
                title={hint(locale === "zh-TW" ? "全部儲存" : "Save all", "saveAll")}
                onClick={onSaveAll}
              >
                {locale === "zh-TW" ? "全部儲存" : "Save all"}
              </button>
              <button
                role="menuitem"
                title={hint(t.build, "build")}
                disabled={deviceLocked}
                onClick={onBuild}
              >
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
