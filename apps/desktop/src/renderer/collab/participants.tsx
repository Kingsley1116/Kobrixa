import { ActionMenu } from "../components/action-menu.js";
import { useState } from "react";
import { Dialog, DialogActions } from "../components/dialog.js";
import type { CollabApi, CollabErrorCode, CollabResult } from "../../shared/collab.js";
import { participantErrorMessage, type CollabCopy } from "./collab-copy.js";
import { onlineCount, rosterLoading, type RosterEntry } from "./roster.js";

type Action = "role" | "kick";
type Busy = { participantId: string; name: string; action: Action } | null;
type Failure = { name: string; action: Action; code: CollabErrorCode | "unknown" } | null;

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
  const [error, setError] = useState<Failure>(null);
  const [notice, setNotice] = useState("");
  const [confirmKick, setConfirmKick] = useState<RosterEntry | null>(null);
  const [confirmDemote, setConfirmDemote] = useState<RosterEntry | null>(null);

  const run = async (
    entry: RosterEntry,
    action: Action,
    request: () => Promise<CollabResult<null>>,
    success: string,
  ): Promise<void> => {
    setBusy({ participantId: entry.participantId, name: entry.name, action });
    setError(null);
    setNotice("");
    try {
      const result = await request();
      if (result.ok) setNotice(success);
      else setError({ name: entry.name, action, code: result.error ?? "unknown" });
    } catch {
      setError({ name: entry.name, action, code: "network" });
    } finally {
      setBusy(null);
    }
  };
  const changeRole = (entry: RosterEntry, role: "editor" | "viewer"): void =>
    void run(
      entry,
      "role",
      () => api.setRole(roomId, { participantId: entry.participantId, role }),
      copy.roleChanged(entry.name, role),
    );

  const [showOffline, setShowOffline] = useState(false);
  const loading = rosterLoading(entries);
  const offline = entries.filter((entry) => !entry.online);
  const visible = [...entries.filter((entry) => entry.online), ...(showOffline ? offline : [])];
  const others = entries.filter((entry) => !entry.self);
  const status = busy
    ? busy.action === "role"
      ? copy.changingRole(busy.name)
      : copy.removing(busy.name)
    : notice;
  return (
    <section
      className="collab-section"
      aria-labelledby="collab-people-title"
      aria-busy={loading || undefined}
    >
      <div className="collab-section-heading">
        <h3 id="collab-people-title">{copy.people}</h3>
        {!loading && (
          <span className="collab-count">
            {copy.peopleCount(onlineCount(entries), entries.length)}
          </span>
        )}
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
              aria-busy={pending || undefined}
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
                  {entry.controlHolder && (
                    <span
                      className="collab-control-badge"
                      title={copy.controlBadgeTitle(entry.name)}
                      data-testid="collab-control-badge"
                    >
                      {copy.controlBadge}
                    </span>
                  )}
                  <span className="collab-presence">
                    {entry.online ? copy.online : copy.offline}
                  </span>
                </span>
                {entry.online && entry.file && (
                  <span
                    className="collab-editing"
                    title={entry.file}
                    data-testid="collab-participant-file"
                  >
                    {copy.editingFile(entry.file)}
                  </span>
                )}
              </span>
              {pending && (
                <span
                  className="collab-row-spinner"
                  aria-hidden="true"
                  data-testid="collab-participant-pending"
                />
              )}
              {manageable && !pending && (
                <ActionMenu label={copy.participantActions(entry.name)}>
                  <button
                    role="menuitem"
                    type="button"
                    disabled={Boolean(busy)}
                    aria-label={copy.changeRoleLabel(entry.name, copy.roles[nextRole])}
                    title={copy.changeRoleLabel(entry.name, copy.roles[nextRole])}
                    onClick={() =>
                      nextRole === "viewer" ? setConfirmDemote(entry) : changeRole(entry, nextRole)
                    }
                  >
                    {nextRole === "viewer" ? copy.makeViewer : copy.makeEditor}
                  </button>
                  <button
                    role="menuitem"
                    type="button"
                    className="danger"
                    disabled={Boolean(busy)}
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
          <span aria-hidden="true">{showOffline ? "▾" : "▸"}</span>{" "}
          {`${copy.offline} (${offline.length})`}
        </button>
      )}
      {loading ? (
        <p className="collab-muted" data-testid="collab-participants-loading">
          {copy.peopleLoading}
        </p>
      ) : (
        others.length === 0 && <p className="collab-muted">{copy.noParticipants}</p>
      )}
      <p className="collab-muted" role="status" data-testid="collab-participants-status">
        {status}
      </p>
      {error && (
        <p className="collab-error" role="alert">
          {participantErrorMessage(copy, error.action, error.name, error.code)}
        </p>
      )}
      {confirmDemote && (
        <Dialog
          role="alertdialog"
          className="collab-demote-confirm"
          title={copy.demoteTitle(confirmDemote.name)}
          titleId="collab-demote-title"
          descriptionId="collab-demote-intro"
          intro={<p id="collab-demote-intro">{copy.demoteIntro(confirmDemote.name)}</p>}
          onClose={() => setConfirmDemote(null)}
        >
          <DialogActions>
            <button type="button" data-modal-initial onClick={() => setConfirmDemote(null)}>
              {copy.cancel}
            </button>
            <button
              type="button"
              className="danger"
              data-testid="collab-demote-confirm"
              onClick={() => {
                const target = confirmDemote;
                setConfirmDemote(null);
                changeRole(target, "viewer");
              }}
            >
              {copy.makeViewer}
            </button>
          </DialogActions>
        </Dialog>
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
                void run(
                  target,
                  "kick",
                  () => api.kick(roomId, target.participantId),
                  copy.removed(target.name),
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
