import { useEffect, useId, useState, useSyncExternalStore } from "react";
import type { Locale } from "../i18n/copy.js";
import type { CollabApi } from "../../shared/collab.js";
import { collabCopy } from "./collab-copy.js";
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
  const copy = collabCopy[locale];
  const hintId = useId();
  const holder = state.isHolder
    ? copy.deviceControlYours
    : deviceControlNotice(locale, state.holderName);
  const canAskHost = !state.isHolder && !state.isHost && !state.requested;
  // Explain disabled actions in visible text instead of a hover-only tooltip.
  const hint = !state.connected
    ? copy.deviceControlNotConnected
    : canAskHost && state.isViewer
      ? copy.requestControlViewer
      : undefined;
  const describedBy = (disabled: boolean) => (disabled && hint ? hintId : undefined);
  return (
    <section
      className="device-control-bar"
      aria-label={copy.deviceControl}
      data-testid="device-control-bar"
    >
      <p className="device-control-holder" role="status">
        <span className={`status-dot ${state.isHolder ? "is-holder" : ""}`} aria-hidden="true" />
        <span>{state.holderOnline ? holder : copy.deviceControlOffline(holder)}</span>
      </p>
      {state.requested && (
        <p className="device-control-pending" role="status" data-testid="device-control-pending">
          {copy.controlRequestPending}
        </p>
      )}
      {state.declined && (
        <p className="device-control-declined" role="status" data-testid="device-control-declined">
          <span>{copy.controlRequestDeclined}</span>
          <button onClick={() => control.dismissDeclined()}>{copy.dismiss}</button>
        </p>
      )}
      <div className="device-control-actions">
        {state.requested && (
          <button
            disabled={!state.connected}
            aria-describedby={describedBy(!state.connected)}
            onClick={() => control.cancelRequest()}
            data-testid="device-control-cancel"
          >
            {copy.cancelControlRequest}
          </button>
        )}
        {canAskHost && (
          <button
            disabled={!state.canRequest}
            aria-describedby={describedBy(!state.canRequest)}
            onClick={() => control.request()}
            data-testid="device-control-request"
          >
            {copy.requestControl}
          </button>
        )}
        {state.isHolder && !state.isHost && (
          <button onClick={() => control.release()}>{copy.giveBackControl}</button>
        )}
        {state.isHost && !state.isHolder && (
          <button
            disabled={!state.connected}
            aria-describedby={describedBy(!state.connected)}
            onClick={() => control.reclaim()}
          >
            {copy.takeBackControl}
          </button>
        )}
      </div>
      {state.isHost && state.requests.length > 0 && (
        <ul className="device-control-requests" aria-label={copy.controlRequests}>
          {state.requests.map((request) => (
            <li key={request.participantId} data-testid="device-control-request-item">
              <span>{copy.controlRequestFrom(request.name)}</span>
              <span className="device-control-request-actions">
                <button
                  disabled={!state.connected}
                  aria-describedby={describedBy(!state.connected)}
                  onClick={() => control.decline(request.participantId)}
                  data-testid="device-control-decline"
                >
                  {copy.declineControl}
                </button>
                <button
                  className="primary"
                  disabled={!state.connected}
                  aria-describedby={describedBy(!state.connected)}
                  onClick={() => control.grant(request.participantId)}
                  data-testid="device-control-grant"
                >
                  {copy.giveControl}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {hint && (
        <p id={hintId} className="device-control-hint" data-testid="device-control-hint">
          {hint}
        </p>
      )}
    </section>
  );
}
