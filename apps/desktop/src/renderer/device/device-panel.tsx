import type { DeviceDescriptor } from "../../shared/api.js";
import type { Copy, Locale } from "../i18n/copy.js";
import type { ExecutionState } from "../execution/execution.js";
import { versionLabel } from "../execution/version-label.js";
import { Icon } from "../components/icon.js";

export function DevicePanel({
  t,
  locale,
  state,
  locked,
  onDisconnect,
  onCancel,
  onOpenConnectionTools,
}: {
  t: Copy;
  locale: Locale;
  state: ExecutionState;
  locked: boolean;
  onDisconnect(): void;
  onCancel(): void;
  onOpenConnectionTools?: () => void;
  // Ignored compatibility props for retained recovery callers. These never
  // render controls or invoke the retired discovery/connection writers.
  devices?: DeviceDescriptor[];
  discovering?: boolean;
  mode?: "usb" | "wifi";
  onMode?(mode: "usb" | "wifi"): void;
  selected?: string | undefined;
  onSelect?(id: string): void;
  address?: string;
  onAddress?(value: string): void;
  onDiscover?(): void;
  onConnect?(): void;
}): React.JSX.Element {
  return (
    <>
      <div className="device-identity">
        <div className="device-symbol">
          <Icon name="device" />
        </div>
        <div>
          <strong>{state.session?.name ?? state.recovery?.name ?? "LEGO MINDSTORMS"}</strong>
          <span>{state.session ? state.session.transport.toUpperCase() : "EV3"}</span>
        </div>
      </div>
      <div className={`connection-banner ${state.session ? "is-connected" : ""}`}>
        <span className="status-dot" />
        {state.recovery
          ? state.recovery.state === "waiting"
            ? t.connectionStates.waiting
            : t.connectionStates.reconnecting
          : state.session
            ? t.connectionStates.connected
            : state.phase === "connecting"
              ? t.connectionStates.connecting
              : t.connectionStates.disconnected}
      </div>
      <p className="panel-hint">
        {state.recovery ? t.recoveryHint : state.session ? t.connectionReady : t.connectionHint}
      </p>
      {state.connectionNotice && (
        <p className="panel-hint" role="status">
          {state.connectionNotice === "retry-exhausted"
            ? locale === "zh-TW"
              ? "已達自動重連次數上限，請手動重新連線。"
              : "Automatic reconnect attempts exhausted. Please reconnect manually."
            : state.connectionNotice === "manual-required"
              ? t.manualReconnect
              : t.uploadRequired}
        </p>
      )}
      {state.phase === "awaitingDevice" && (
        <div className="pending-run">
          <p>{t.connectionRequired}</p>
          <button onClick={onCancel}>{t.cancel}</button>
        </div>
      )}
      {state.recovery ? (
        <button className="wide" onClick={onDisconnect}>
          {t.cancelRecovery}
        </button>
      ) : !state.session ? (
        <button className="wide" disabled={!onOpenConnectionTools} onClick={onOpenConnectionTools}>
          {locale === "zh-TW" ? "開啟 EV3 插件工具" : "Open EV3 plugin tools"}
        </button>
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
            ].includes(state.error.phase) &&
            !state.recovery &&
            !state.session
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

/** Capture observation is not authoritative import readiness: completed profiles
 * deliberately reject fresh challenges. Keep the retry action neutral. */
export function DevicePreferenceCaptureNotice({
  locale,
  retry,
}: {
  locale: Locale;
  retry(): void;
}): React.JSX.Element {
  return (
    <div>
      {locale === "zh-TW"
        ? "需要時可重試匯入裝置偏好；已完成的匯入不會重做。"
        : "You can retry importing device preferences if needed. Completed imports are not repeated."}
      <button onClick={retry}>{locale === "zh-TW" ? "檢查匯入" : "Check import"}</button>
    </div>
  );
}
