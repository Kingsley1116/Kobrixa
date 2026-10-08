import { useCallback, useId, useSyncExternalStore } from "react";
import type { Locale } from "../i18n/copy.js";
import { collabCopy, type CollabCopy } from "./collab-copy.js";
import type { CollabFileSync, CollabFileSyncNotice } from "./file-sync.js";

function Notice({
  notice,
  copy,
  onDismiss,
}: {
  notice: CollabFileSyncNotice;
  copy: CollabCopy["sync"];
  onDismiss(): void;
}): React.JSX.Element {
  const count = notice.files.length;
  return (
    <div
      className="collab-sync-notice"
      data-kind={notice.kind}
      data-testid={`collab-sync-notice-${notice.kind}`}
    >
      <p>
        <strong>
          {notice.kind === "replaced" ? copy.replacedTitle(count) : copy.trashedTitle(count)}
        </strong>{" "}
        {notice.kind === "replaced" ? copy.replacedBody : copy.trashedBody}
      </p>
      <ul>
        {notice.files.map((file) => (
          <li key={file}>{file}</li>
        ))}
      </ul>
      <button type="button" data-testid={`collab-sync-dismiss-${notice.kind}`} onClick={onDismiss}>
        {copy.dismiss}
      </button>
    </div>
  );
}

/** Keep partial shares, replaced local data and disk failures visible alongside the room controls. */
export function CollabSyncStatus({
  sync,
  locale,
}: {
  sync: CollabFileSync | undefined;
  locale: Locale;
}): React.JSX.Element | null {
  const subscribe = useCallback(
    (listener: () => void) => sync?.subscribe(listener) ?? (() => {}),
    [sync],
  );
  const snapshot = useSyncExternalStore(subscribe, () => sync?.getSnapshot());
  const subscribeSession = useCallback(
    (listener: () => void) => sync?.session.subscribe(listener) ?? (() => {}),
    [sync],
  );
  const canRetry = useSyncExternalStore(subscribeSession, () => sync?.canRetry ?? false);
  const retryHintId = useId();
  if (!sync || !snapshot) return null;
  const copy = collabCopy[locale].sync;
  const error = snapshot.errorCode
    ? copy.errors[snapshot.errorCode](snapshot.errorFile)
    : snapshot.error
      ? copy.errors.sync()
      : undefined;
  const syncing = !error && snapshot.phase !== "syncing";
  if (!error && !syncing && !snapshot.notices.length && !snapshot.skipped.length) return null;
  return (
    <section className="collab-sync" aria-label={copy.label} data-testid="collab-sync-status">
      {error && (
        <div className="collab-sync-notice" data-kind="error">
          <p className="collab-error" role="alert" data-testid="collab-sync-error">
            {error}
          </p>
          {snapshot.error && (
            <details>
              <summary>{copy.details}</summary>
              <code>{snapshot.error}</code>
            </details>
          )}
          <div className="collab-sync-actions">
            <button
              type="button"
              data-testid="collab-sync-retry"
              disabled={!canRetry}
              aria-describedby={canRetry ? undefined : retryHintId}
              onClick={() => void sync.retry()}
            >
              {copy.retry}
            </button>
            {!canRetry && (
              <small id={retryHintId} className="collab-muted">
                {copy.retryOffline}
              </small>
            )}
          </div>
        </div>
      )}
      {syncing && (
        <p className="collab-sync-progress" role="status">
          <span className="collab-sync-spinner" aria-hidden="true" />
          {copy.syncing}
        </p>
      )}
      {snapshot.notices.map((notice) => (
        <Notice
          key={notice.id}
          notice={notice}
          copy={copy}
          onDismiss={() => sync.dismissNotice(notice.id)}
        />
      ))}
      {snapshot.skipped.length > 0 && (
        <details className="collab-sync-notice" data-testid="collab-sync-skipped">
          <summary>{copy.skipped(snapshot.skipped.length)}</summary>
          <p className="collab-muted">{copy.skippedHint}</p>
          <ul>
            {snapshot.skipped.map((file) => {
              const reason = snapshot.skipReasons[file];
              return (
                <li key={file}>
                  {file}
                  {reason && <span className="collab-muted"> — {copy.skipReasons[reason]}</span>}
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </section>
  );
}
