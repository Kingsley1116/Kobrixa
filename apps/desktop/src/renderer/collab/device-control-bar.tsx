import { useEffect, useId, useState, useSyncExternalStore, useRef, useCallback } from "react";
import type { Locale } from "../i18n/copy.js";
import type { CollabApi, DeviceAuthorityReport } from "../../shared/collab.js";
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

type AuthorityApi = Pick<CollabApi, "deviceControlContext" | "setDeviceControl">;
export function useDeviceControl(
  store: CollabStore,
  api: AuthorityApi,
): { control: DeviceControl; state: DeviceControlSnapshot } | null {
  const session = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [control, setControl] = useState<DeviceControl | null>(null);
  const document = useRef<string | null>(null);
  const sequence = useRef(0);
  const currentReport = useRef<() => void>(() => {});
  const send = useCallback(
    (value: Omit<DeviceAuthorityReport, "document" | "sequence">) => {
      if (!document.current) return;
      const report = { ...value, document: document.current, sequence: ++sequence.current };
      try {
        void api.setDeviceControl(report).catch(() => undefined);
      } catch {
        /* teardown */
      }
    },
    [api],
  );
  useEffect(() => {
    let disposed = false;
    void api
      .deviceControlContext()
      .then((value) => {
        if (disposed) return;
        document.current = value.document;
        currentReport.current();
      })
      .catch(() => {
        document.current = null;
      });
    return () => {
      disposed = true;
      send({
        state: "invalid",
        roomId: null,
        connected: false,
        synced: false,
        role: null,
        isHolder: false,
      });
      document.current = null;
    };
  }, [api, send]);
  useEffect(() => {
    if (!session) {
      setControl(null);
      currentReport.current = () =>
        send({
          state: "local",
          roomId: null,
          connected: true,
          synced: true,
          role: null,
          isHolder: true,
        });
      currentReport.current();
      return;
    }
    const next = new DeviceControl(session);
    const reportState = () => {
      const snapshot = session.getSnapshot();
      const connected = snapshot.status === "connected";
      const state =
        connected && snapshot.synced
          ? "room"
          : snapshot.status === "connecting" || snapshot.status === "syncing"
            ? "joining"
            : "unsynced";
      send({
        state,
        roomId: session.connection.roomId,
        connected,
        synced: snapshot.synced,
        role: snapshot.role,
        isHolder: next.getSnapshot().isHolder,
      });
    };
    currentReport.current = reportState;
    const offControl = next.subscribe(reportState);
    const offSession = session.subscribe(reportState);
    reportState();
    setControl(next);
    return () => {
      offControl();
      offSession();
      next.dispose();
    };
  }, [session, send]);
  const current = control && control.session === session ? control : null;
  const state = useSyncExternalStore(
    current?.subscribe ?? subscribeNothing,
    current?.getSnapshot ?? getNothing,
  );
  return current && state ? { control: current, state } : null;
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
