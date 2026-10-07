import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { Locale } from "../i18n/copy.js";
import type { CollabApi } from "../../shared/collab.js";
import type { CollabStore } from "./store.js";
import type { CollabSession, CollabSessionSnapshot } from "./types.js";
import { collabCopy, collabErrorMessage, type CollabCopy } from "./collab-copy.js";
import { CollabLobby, displayNameProblem, type LobbySnapshot } from "./collab-lobby.js";
import { JoinDialog } from "./join-dialog.js";
import { CreateDialog } from "./create-dialog.js";
import { Participants } from "./participants.js";
import { useCollabSession, useRoster, useSessionSnapshot } from "./use-collab.js";

/**
 * Room lobby and participant management: create/join, invite code, roster,
 * connection status.
 */
export function CollabPanel({
  store,
  api,
  locale,
  projectName,
}: {
  store: CollabStore;
  api: CollabApi;
  locale: Locale;
  /** Name of the active project; starting a room requires one. */
  projectName?: string | undefined;
}): React.JSX.Element {
  const copy = collabCopy[locale];
  const session = useCollabSession(store);
  const [lobby, setLobby] = useState<CollabLobby | null>(null);
  useEffect(() => {
    const next = new CollabLobby(api, (connection) => store.start(connection));
    setLobby(next);
    void next.load();
    return () => next.dispose();
  }, [api, store]);

  return (
    <div className="collab-panel" lang={locale}>
      {session ? (
        <Room
          key={session.connection.roomId}
          session={session}
          store={store}
          api={api}
          copy={copy}
        />
      ) : lobby ? (
        <Lobby lobby={lobby} copy={copy} projectName={projectName} locale={locale} />
      ) : null}
    </div>
  );
}

function Lobby({
  lobby,
  copy,
  projectName,
  locale,
}: {
  lobby: CollabLobby;
  copy: CollabCopy;
  projectName?: string | undefined;
  locale: Locale;
}): React.JSX.Element {
  const state: LobbySnapshot = useSyncExternalStore(lobby.subscribe, lobby.getSnapshot);
  const [joinCode, setJoinCode] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [nameTouched, setNameTouched] = useState(false);
  const id = useId();
  const problem = displayNameProblem(state.displayName);
  const showProblem = problem && (nameTouched || state.displayName !== "") ? problem : null;
  const project = projectName?.trim();
  const busy = state.pending !== null;
  const openJoin = (code = ""): void => {
    lobby.clearJoinError();
    setJoinCode(code);
  };

  return (
    <div className="collab-lobby" data-testid="collab-lobby">
      <header className="collab-intro">
        <h3>{copy.lobbyTitle}</h3>
        <p>{copy.lobbyIntro}</p>
      </header>
      <label className="collab-field">
        <span>{copy.displayName}</span>
        <input
          data-testid="collab-display-name"
          value={state.displayName}
          disabled={!state.loaded}
          autoComplete="nickname"
          spellCheck={false}
          aria-invalid={Boolean(showProblem)}
          aria-describedby={`${id}-name-hint`}
          onChange={(event) => lobby.setDisplayName(event.target.value)}
          onBlur={() => {
            setNameTouched(true);
            void lobby.flush();
          }}
        />
        <small id={`${id}-name-hint`} className={showProblem ? "collab-error" : undefined}>
          {showProblem ? copy.displayNameProblems[showProblem] : copy.displayNameHint}
        </small>
      </label>

      <div className="collab-actions-card">
        <div className="collab-action">
          <button
            type="button"
            className="primary"
            data-testid="collab-start"
            disabled={!state.loaded || busy || Boolean(problem) || !project}
            aria-describedby={`${id}-start-hint`}
            onClick={() => {
              if (project) setCreating(true);
            }}
          >
            {state.pending === "start" ? copy.starting : copy.startRoom}
          </button>
          <p id={`${id}-start-hint`} className="collab-muted">
            {project ? copy.startHint(project) : copy.startNeedsProject}
          </p>
        </div>
        <div className="collab-action">
          <button
            type="button"
            data-testid="collab-join"
            disabled={!state.loaded || busy || Boolean(problem)}
            aria-describedby={`${id}-join-hint`}
            onClick={() => openJoin()}
          >
            {copy.joinRoom}
          </button>
          <p id={`${id}-join-hint`} className="collab-muted">
            {copy.joinHint}
          </p>
        </div>
        <p className="collab-error" role="alert" data-testid="collab-start-error">
          {state.startError ? collabErrorMessage(copy, state.startError) : ""}
        </p>
      </div>

      <section className="collab-section" aria-labelledby={`${id}-recent`}>
        <div className="collab-section-heading">
          <h3 id={`${id}-recent`}>{copy.recentRooms}</h3>
        </div>
        {state.recentRooms.length === 0 ? (
          <p className="collab-muted">{copy.noRecentRooms}</p>
        ) : (
          <ul className="collab-recent">
            {state.recentRooms.map((room) => (
              <li key={room.roomId}>
                <span className="collab-recent-main">
                  <span className="collab-recent-name" title={room.projectName}>
                    {room.projectName}
                  </span>
                  <span className="collab-participant-meta">
                    <span className={`collab-role collab-role-${room.role}`}>
                      {copy.roles[room.role]}
                    </span>
                    <span>
                      {copy.joinedAt(
                        new Date(room.joinedAt).toLocaleDateString(locale, {
                          month: "short",
                          day: "numeric",
                        }),
                      )}
                    </span>
                  </span>
                </span>
                {room.inviteCode && (
                  <button
                    type="button"
                    disabled={!state.loaded || busy || Boolean(problem)}
                    aria-label={`${copy.rejoin}: ${room.projectName}`}
                    onClick={() => openJoin(room.inviteCode)}
                  >
                    {copy.rejoin}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {creating && project && (
        <CreateDialog
          copy={copy}
          projectName={project}
          displayName={state.displayName}
          pending={state.pending === "start"}
          error={state.startError}
          onCreate={(password) => void lobby.startRoom(project, password)}
          onClose={() => setCreating(false)}
        />
      )}

      {joinCode !== null && (
        <JoinDialog
          copy={copy}
          displayName={state.displayName}
          initialCode={joinCode}
          pending={state.pending === "join"}
          error={state.joinError}
          onEdit={() => lobby.clearJoinError()}
          onJoin={(code, password) => void lobby.joinRoom(code, password)}
          onClose={() => setJoinCode(null)}
        />
      )}
    </div>
  );
}

function statusMessage(copy: CollabCopy, snapshot: CollabSessionSnapshot): string {
  if (snapshot.status === "closed")
    return snapshot.closeReason ? copy.closeReasons[snapshot.closeReason] : copy.status.closed;
  return copy.status[snapshot.status];
}

function Room({
  session,
  store,
  api,
  copy,
}: {
  session: CollabSession;
  store: CollabStore;
  api: CollabApi;
  copy: CollabCopy;
}): React.JSX.Element {
  const snapshot = useSessionSnapshot(session)!;
  const entries = useRoster(session, snapshot);
  const { connection } = session;
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(resetTimer.current), []);
  const closed = snapshot.status === "closed";

  const copyInvite = async (code: string): Promise<void> => {
    clearTimeout(resetTimer.current);
    try {
      await navigator.clipboard.writeText(code);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    resetTimer.current = setTimeout(() => setCopyState("idle"), 2500);
  };
  const leave = (): void => {
    store.stop();
    void api.leave(connection.roomId).catch(() => undefined);
  };

  return (
    <div className="collab-room" data-testid="collab-room">
      <header className="collab-room-header">
        <div className="collab-room-title">
          <span className="collab-muted">{copy.room}</span>
          <h3 title={connection.projectName}>{connection.projectName}</h3>
        </div>
        <p
          className="collab-status"
          data-status={snapshot.status}
          data-testid="collab-status"
          role="status"
        >
          <span className="collab-status-dot" aria-hidden="true" />
          {statusMessage(copy, snapshot)}
        </p>
      </header>

      {!closed &&
        (connection.inviteCode ? (
          <section className="collab-invite" aria-labelledby="collab-invite-label">
            <span id="collab-invite-label" className="collab-muted">
              {copy.inviteCodeLabel}
            </span>
            <div className="collab-invite-row">
              <code className="collab-invite-code" data-testid="collab-invite-value">
                {connection.inviteCode}
              </code>
              <button
                type="button"
                data-testid="collab-copy-invite"
                onClick={() => void copyInvite(connection.inviteCode!)}
              >
                {copy.copy}
              </button>
            </div>
            <p className="collab-muted" aria-live="polite">
              {copyState === "copied"
                ? copy.copied
                : copyState === "failed"
                  ? copy.copyFailed
                  : copy.inviteShare}
            </p>
          </section>
        ) : (
          <p className="collab-muted">{copy.noInviteCode}</p>
        ))}

      {!closed && (
        <Participants
          copy={copy}
          api={api}
          roomId={connection.roomId}
          entries={entries}
          isHost={snapshot.role === "host"}
        />
      )}

      <div className="collab-room-footer">
        <button
          type="button"
          className={closed ? "primary" : "danger"}
          data-testid="collab-leave"
          onClick={leave}
        >
          {closed ? copy.backToLobby : copy.leave}
        </button>
      </div>
    </div>
  );
}
