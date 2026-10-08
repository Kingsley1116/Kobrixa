import { useEffect, useState, useSyncExternalStore } from "react";
import type { Locale } from "../i18n/copy.js";
import type { CollabApi } from "../../shared/collab.js";
import type { CollabStore } from "./store.js";
import {
  DeviceControl,
  deviceControlNotice,
  type DeviceControlSnapshot,
} from "./device-control.js";
import "./device-control.css";

const subscribeNothing = (): (() => void) => () => {};
const getNothing = (): null => null;

/**
 * Tracks device control for the store's current session and reports it to the
 * main process (`null` outside a room). Returns `null` when there is no session.
 */
export function useDeviceControl(
  store: CollabStore,
  api: Pick<CollabApi, "setDeviceControl">,
): { control: DeviceControl; state: DeviceControlSnapshot } | null {
  const session = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [control, setControl] = useState<DeviceControl | null>(null);
  useEffect(() => {
    if (!session) {
      setControl(null);
      report(api, null);
      return;
    }
    report(api, false);
    const next = new DeviceControl(session);
    // Report revocations in the shared-document notification itself instead of
    // waiting for a React paint; subsequent device IPC sees the new gate first.
    const reportState = () => report(api, next.getSnapshot().isHolder);
    const unsubscribe = next.subscribe(reportState);
    reportState();
    setControl(next);
    return () => {
      unsubscribe();
      next.dispose();
    };
  }, [session, api]);
  const current = control && control.session === session ? control : null;
  const state = useSyncExternalStore(
    current?.subscribe ?? subscribeNothing,
    current?.getSnapshot ?? getNothing,
  );
  useEffect(() => () => report(api, null), [api]);
  return current && state ? { control: current, state } : null;
}

function report(api: Pick<CollabApi, "setDeviceControl">, holder: boolean | null): void {
  try {
    void Promise.resolve(api.setDeviceControl(holder)).catch(() => undefined);
  } catch {
    // Avoid an unhandled rejection when the bridge disappears during teardown.
  }
}

/** Holder notice for disabled device actions, or `undefined` when allowed. */
export function blockedNotice(
  locale: Locale,
  device: { state: DeviceControlSnapshot } | null,
): string | undefined {
  if (!device || device.state.isHolder) return undefined;
  return deviceControlNotice(locale, device.state.holderName);
}

/** Shown at the top of the Connection tab while in a collaboration room. */
export function DeviceControlBar({
  control,
  state,
  locale,
}: {
  control: DeviceControl;
  state: DeviceControlSnapshot;
  locale: Locale;
}): React.JSX.Element {
  const zh = locale === "zh-TW";
  const connected = control.session.getSnapshot().status === "connected";
  const holder = state.isHolder
    ? zh
      ? "你持有裝置控制權"
      : "You have device control"
    : deviceControlNotice(locale, state.holderName);
  return (
    <section className="device-control-bar" aria-label={zh ? "裝置控制權" : "Device control"}>
      <p className="device-control-holder" role="status">
        <span className={`status-dot ${state.isHolder ? "is-holder" : ""}`} />
        <span>
          {holder}
          {!state.holderOnline && (zh ? "（離線）" : " (offline)")}
        </span>
      </p>
      <div className="device-control-actions">
        {state.requested ? (
          <button disabled={!connected} onClick={() => control.cancelRequest()}>
            {zh ? "取消請求" : "Cancel request"}
          </button>
        ) : (
          !state.isHolder &&
          !state.isHost && (
            <button
              disabled={!state.canRequest}
              title={
                state.canRequest
                  ? undefined
                  : !connected
                    ? zh
                      ? "等待連線與同步完成"
                      : "Waiting for connection and sync"
                    : zh
                      ? "檢視者無法請求控制權"
                      : "Viewers cannot request control"
              }
              onClick={() => control.request()}
            >
              {zh ? "請求控制權" : "Request control"}
            </button>
          )
        )}
        {state.isHolder && !state.isHost && (
          <button onClick={() => control.release()}>
            {zh ? "交還控制權" : "Give back control"}
          </button>
        )}
        {state.isHost && !state.isHolder && (
          <button disabled={!connected} onClick={() => control.reclaim()}>
            {zh ? "收回控制權" : "Take back control"}
          </button>
        )}
      </div>
      {state.isHost && state.requests.length > 0 && (
        <ul className="device-control-requests" aria-label={zh ? "控制權請求" : "Control requests"}>
          {state.requests.map((request) => (
            <li key={request.participantId}>
              <span>{zh ? `${request.name} 請求控制權` : `${request.name} requests control`}</span>
              <button
                className="primary"
                disabled={!connected}
                onClick={() => control.grant(request.participantId)}
              >
                {zh ? "給予控制權" : "Give control"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
