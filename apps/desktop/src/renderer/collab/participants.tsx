import { ActionMenu } from "../components/action-menu.js";
import { useState } from "react";
import { Dialog, DialogActions } from "../components/dialog.js";
import type { CollabApi, CollabErrorCode, CollabResult } from "../../shared/collab.js";
import { collabErrorMessage, type CollabCopy } from "./collab-copy.js";
import { onlineCount, type RosterEntry } from "./roster.js";

type Busy = { participantId: string; action: "role" | "kick" } | null;

/** Room roster with host-only role changes and removal. */
export function Participants({
  copy,
  api,
  roomId,
  entries,
  isHost,
}: {
  copy: CollabCopy;
  api: Pick<CollabApi, "kick" | "setRole">;
  roomId: string;
  entries: readonly RosterEntry[];
  isHost: boolean;
}): React.JSX.Element {
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<CollabErrorCode | "unknown" | null>(null);
  const [confirmKick, setConfirmKick] = useState<RosterEntry | null>(null);

  const run = async (
    participantId: string,
    action: "role" | "kick",
    request: () => Promise<CollabResult<null>>,
  ): Promise<void> => {
    setBusy({ participantId, action });
    setError(null);
    try {
      const result = await request();
      if (!result.ok) setError(result.error ?? "unknown");
    } catch {
      setError("network");
    } finally {
      setBusy(null);
    }
  };

  const [showOffline, setShowOffline] = useState(false);
  const offline = entries.filter((entry) => !entry.online);
  const visible = [...entries.filter((entry) => entry.online), ...(showOffline ? offline : [])];
  const others = entries.filter((entry) => !entry.self);
  return (
    <section className="collab-section" aria-labelledby="collab-people-title">
      <div className="collab-section-heading">
        <h3 id="collab-people-title">{copy.people}</h3>
        <span className="collab-count">
          {copy.peopleCount(onlineCount(entries), entries.length)}
        </span>
      </div>
      <ul className="collab-participants" data-testid="collab-participants">
        {visible.map((entry) => {
          const manageable = isHost && !entry.self && entry.role !== "host";
          const nextRole = entry.role === "viewer" ? "editor" : "viewer";
          const pending = busy?.participantId === entry.participantId;
          return (
            <li
              key={entry.participantId}
              className={`collab-participant ${entry.online ? "is-online" : "is-offline"}`}
              data-participant={entry.participantId}
            >
              <span
                className="collab-color"
                style={entry.color ? { background: entry.color } : undefined}
                aria-hidden="true"
              />
              <span className="collab-participant-main">
                <span className="collab-participant-name">
                  <span className="collab-name-text" title={entry.name}>
                    {entry.name}
                  </span>
                  {entry.self && <span className="collab-you"> {copy.you}</span>}
                </span>
                <span className="collab-participant-meta">
                  <span className={`collab-role collab-role-${entry.role}`}>
                    {copy.roles[entry.role]}
                  </span>
                  <span className="collab-presence">
                    {entry.online ? copy.online : copy.offline}
                  </span>
                </span>
              </span>
              {manageable && (
                <ActionMenu label={`${copy.people}: ${entry.name}`}>
                  <button
                    role="menuitem"
                    type="button"
                    disabled={Boolean(busy)}
                    aria-busy={pending && busy?.action === "role"}
                    aria-label={copy.changeRoleLabel(entry.name, copy.roles[nextRole])}
                    title={copy.changeRoleLabel(entry.name, copy.roles[nextRole])}
                    onClick={() =>
                      void run(entry.participantId, "role", () =>
                        api.setRole(roomId, { participantId: entry.participantId, role: nextRole }),
                      )
                    }
                  >
                    {nextRole === "viewer" ? copy.makeViewer : copy.makeEditor}
                  </button>
                  <button
                    role="menuitem"
                    type="button"
                    className="danger"
                    disabled={Boolean(busy)}
                    aria-busy={pending && busy?.action === "kick"}
                    aria-label={copy.removeLabel(entry.name)}
                    title={copy.removeLabel(entry.name)}
                    onClick={() => setConfirmKick(entry)}
                  >
                    {copy.remove}
                  </button>
                </ActionMenu>
              )}
            </li>
          );
        })}
      </ul>
      {offline.length > 0 && (
        <button aria-expanded={showOffline} onClick={() => setShowOffline((value) => !value)}>
          {showOffline ? "▾" : "▸"} {copy.offline} ({offline.length})
        </button>
      )}
      {others.length === 0 && <p className="collab-muted">{copy.noParticipants}</p>}
      {error && (
        <p className="collab-error" role="alert">
          {collabErrorMessage(copy, error)}
        </p>
      )}
      {confirmKick && (
        <Dialog
          role="alertdialog"
          className="collab-kick-confirm"
          title={copy.removeTitle(confirmKick.name)}
          titleId="collab-kick-title"
          descriptionId="collab-kick-intro"
          intro={<p id="collab-kick-intro">{copy.removeIntro}</p>}
          onClose={() => setConfirmKick(null)}
        >
          <DialogActions>
            <button type="button" data-modal-initial onClick={() => setConfirmKick(null)}>
              {copy.cancel}
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => {
                const target = confirmKick;
                setConfirmKick(null);
                void run(target.participantId, "kick", () =>
                  api.kick(roomId, target.participantId),
                );
              }}
            >
              {copy.remove}
            </button>
          </DialogActions>
        </Dialog>
      )}
    </section>
  );
}
