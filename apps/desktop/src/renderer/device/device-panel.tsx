import type { DeviceDescriptor } from "../../shared/api.js";
import type { Copy, Locale } from "../i18n/copy.js";
import type { ExecutionState } from "../execution/execution.js";
import { versionLabel } from "../execution/version-label.js";
import { Icon } from "../components/icon.js";
import { Picker } from "../components/picker.js";

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
          {state.connectionNotice === "manual-required" ? t.manualReconnect : t.uploadRequired}
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
