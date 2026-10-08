import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { Locale } from "../i18n/copy.js";
import { COLLAB_LIMITS } from "@kobrixa/collab-protocol";
import type {
  CollabApi,
  CollabConnection,
  CollabResult,
  CollabSharePreview,
} from "../../shared/collab.js";
import type { CollabStore } from "./store.js";
import { CollabPendingUpdatesError, type CollabCloseReason, type CollabSession } from "./types.js";
import { collabCopy, collabErrorMessage } from "./collab-copy.js";
import { CollabLobby } from "./collab-lobby.js";
import { JoinDialog } from "./join-dialog.js";
import { CreateDialog } from "./create-dialog.js";
import { Participants } from "./participants.js";
import { useCollabSession, useRoster, useSessionSnapshot } from "./use-collab.js";
import { ChatPanel, useChatController } from "./chat-panel.js";
import { TabList } from "../components/tab-list.js";
import { ActionMenu } from "../components/action-menu.js";
import { Dialog, DialogActions } from "../components/dialog.js";

type PanelProps = {
  store: CollabStore;
  api: CollabApi;
  locale: Locale;
  projectName?: string | undefined;
  projectId?: string | undefined;
  onOpenProject?(): void;
  onStart?(connection: CollabConnection): Promise<boolean>;
  onLeave?(): Promise<void>;
  onLeavingChange?(leaving: boolean): void;
  control?: ReactNode;
};

export function CollabPanel(props: PanelProps): React.JSX.Element {
  const { store, api, locale, projectName } = props;
  const latest = useRef(props);
  latest.current = props;
  const copy = collabCopy[locale];
  const session = useCollabSession(store);
  const [lobby] = useState(
    () =>
      new CollabLobby(
        {
          ...api,
          createRoom: (request) =>
            latest.current.projectId
              ? api.createRoom(request, latest.current.projectId)
              : api.createRoom(request),
        },
        (connection) =>
          latest.current.onStart ? latest.current.onStart(connection) : store.start(connection),
      ),
  );
  useEffect(() => {
    void lobby.load();
    return () => lobby.dispose();
  }, [lobby]);
  useEffect(() => {
    if (!session) void lobby.load();
  }, [session, lobby]);
  const state = useSyncExternalStore(lobby.subscribe, lobby.getSnapshot);
  const [joinCode, setJoinCode] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [preview, setPreview] = useState<CollabSharePreview>();
  const [previewError, setPreviewError] = useState("");
  useEffect(() => {
    if (!creating || !props.projectId) return;
    let active = true;
    setPreview(undefined);
    setPreviewError("");
    void api.previewProject(props.projectId).then(
      (value) => {
        if (active) setPreview(value);
      },
      (error) => {
        if (active) setPreviewError(String(error));
      },
    );
    return () => {
      active = false;
    };
  }, [creating, props.projectId, api]);
  const busy = state.pending !== null;
  useEffect(() => {
    if (session) {
      setJoinCode(null);
      setCreating(false);
    }
  }, [session]);
  if (session) return <Room key={session.connection.roomId} {...props} session={session} />;
  return (
    <div className="collab-panel collab-lobby" lang={locale} data-testid="collab-lobby">
      <header className="collab-intro">
        <h3>{copy.lobbyTitle}</h3>
        <p>{copy.lobbyIntro}</p>
      </header>
      <div className="collab-lobby-actions">
        <button
          className="primary"
          data-testid="collab-start"
          disabled={!state.loaded || busy || !projectName}
          onClick={() => setCreating(true)}
        >
          {copy.startRoom}
        </button>
        <button
          data-testid="collab-join"
          disabled={!state.loaded || busy}
          onClick={() => {
            lobby.clearJoinError();
            setJoinCode("");
          }}
        >
          {copy.joinRoom}
        </button>
      </div>
      <p className="collab-muted">
        {projectName ? copy.startHint(projectName) : copy.startNeedsProject}
      </p>
      {!projectName && (
        <button onClick={props.onOpenProject}>
          {locale === "zh-TW" ? "開啟專案" : "Open project"}
        </button>
      )}
      {state.startError && (
        <p className="collab-error" role="alert">
          {collabErrorMessage(copy, state.startError)}
        </p>
      )}
      <section className="collab-section">
        <h3>{copy.recentRooms}</h3>
        {!state.recentRooms.length && <p className="collab-muted">{copy.noRecentRooms}</p>}
        <ul className="collab-recent">
          {state.recentRooms.map((room) => (
            <li key={room.roomId}>
              <span className="collab-recent-main">
                <strong className="collab-recent-name" title={room.projectName}>
                  {room.projectName}
                </strong>
                <span className="collab-muted">{copy.roles[room.role]}</span>
              </span>
              <button
                disabled={busy}
                onClick={() => {
                  if (room.canResume) void lobby.resumeRoom(room.roomId);
                  else if (room.inviteCode) setJoinCode(room.inviteCode);
                }}
              >
                {copy.rejoin}
              </button>
              {!room.canResume && room.role === "host" && (
                <p className="collab-muted">
                  {locale === "zh-TW"
                    ? "舊版主持憑證未保存，無法以名稱或密碼恢復主持權。請開啟保留的專案並建立新房間。"
                    : "This older room has no saved host credential. A name or password cannot restore ownership. Open your retained project to create a new room."}
                </p>
              )}
            </li>
          ))}
        </ul>
      </section>
      {creating && projectName && (
        <CreateDialog
          locale={locale}
          preview={preview}
          previewError={previewError}
          previewLoading={!!props.projectId && !preview}
          copy={copy}
          projectName={projectName}
          displayName={state.displayName}
          onName={(name) => lobby.setDisplayName(name)}
          pending={state.pending === "start"}
          error={state.startError}
          onCreate={(password) => void lobby.startRoom(projectName, password)}
          onClose={() => setCreating(false)}
        />
      )}
      {joinCode !== null && (
        <JoinDialog
          copy={copy}
          displayName={state.displayName}
          onName={(name) => lobby.setDisplayName(name)}
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

type RoomError = { text: string; retry?: () => void };
type RoomBusy = "leave" | "end" | "rejoin";

/** Close reasons the user can recover from by resuming with the saved credential. */
const RECOVERABLE = new Set<CollabCloseReason>([
  "error",
  "unauthorized",
  "room-full",
  "session-replaced",
]);
const COPIED_RESET_MS = 2000;

function Room({
  session,
  store,
  api,
  locale,
  onStart,
  onLeave,
  onLeavingChange,
  control,
}: PanelProps & { session: CollabSession }): React.JSX.Element {
  const copy = collabCopy[locale];
  const snapshot = useSessionSnapshot(session)!;
  const entries = useRoster(session, snapshot);
  const { connection } = session;
  const chat = useChatController(session)!;
  const chatState = useSyncExternalStore(chat.subscribe, chat.getSnapshot);
  const [view, setView] = useState<"people" | "chat">("people");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const copyTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(copyTimer.current), []);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<RoomError | null>(null);
  const [busy, setBusyState] = useState<RoomBusy | null>(null);
  const busyRef = useRef<RoomBusy | null>(null);
  const setBusy = (value: RoomBusy | null): void => {
    busyRef.current = value;
    setBusyState(value);
  };
  const [confirmEnd, setConfirmEnd] = useState(false);
  /** Open leave confirmation; `pending` when some edits are not acknowledged yet. */
  const [confirmLeave, setConfirmLeave] = useState<{ pending: boolean } | null>(null);
  const closed = snapshot.status === "closed";
  const isHost = snapshot.role === "host";
  const online = entries.filter((entry) => entry.online).length;
  const recoverable = closed && !!snapshot.closeReason && RECOVERABLE.has(snapshot.closeReason);

  const failureText = (failure: unknown, fallback: string): string => {
    console.warn("[collab] Room action failed", failure);
    return failure instanceof CollabPendingUpdatesError ? copy.pendingUpdates : fallback;
  };
  /** Set once a closed session's unsent edits were preserved, so retries don't save duplicate copies. */
  const preserved = useRef(false);
  const preserve = async (): Promise<void> => {
    if (preserved.current) return;
    await onLeave?.();
    if (session.getSnapshot().status === "closed") preserved.current = true;
  };
  const leave = async (end = false): Promise<void> => {
    if (busyRef.current) return;
    setBusy(end ? "end" : "leave");
    onLeavingChange?.(true);
    setError(null);
    setMessage("");
    try {
      await preserve();
      if (end) {
        const result = await api.closeRoom(connection.roomId);
        if (!result.ok) {
          // Shown inside the end-room dialog, whose End button is the retry.
          setError({ text: collabErrorMessage(copy, result.error) });
          return;
        }
      }
      await api.leave(connection.roomId);
      store.stop();
    } catch (failure) {
      setError({ text: failureText(failure, copy.leaveFailed), retry: () => void leave(end) });
    } finally {
      onLeavingChange?.(false);
      setBusy(null);
    }
  };
  const requestLeave = (): void => {
    const pending = !!session.hasPendingUpdates?.();
    // Hosts choose between leaving (the room stays open) and ending it for everyone.
    if (pending || (isHost && !closed)) setConfirmLeave({ pending });
    else void leave();
  };
  const rejoin = async (): Promise<void> => {
    if (busyRef.current) return;
    setBusy("rejoin");
    onLeavingChange?.(true);
    setError(null);
    setMessage("");
    const retry = (): void => void rejoin();
    try {
      // Preserve unconfirmed edits before a new session replaces this one.
      await preserve();
      let result: CollabResult<CollabConnection>;
      try {
        result = await api.resumeRoom(connection.roomId);
      } catch {
        result = { ok: false, error: "network" };
      }
      if (!result.ok) {
        setError({ text: collabErrorMessage(copy, result.error), retry });
        return;
      }
      const started = onStart ? await onStart(result.value) : !!store.start(result.value);
      if (!started) setError({ text: copy.unknownError, retry });
    } catch (failure) {
      setError({ text: failureText(failure, copy.unknownError), retry });
    } finally {
      onLeavingChange?.(false);
      setBusy(null);
    }
  };
  const saveCopy = (): void => {
    setError(null);
    setMessage("");
    void api.saveCopy(connection.roomId).then(
      (file) => setMessage(copy.copySaved(file)),
      (failure: unknown) => {
        console.warn("[collab] Saving a project copy failed", failure);
        setError({ text: copy.saveCopyFailed, retry: saveCopy });
      },
    );
  };
  const copyInvite = (): void => {
    clearTimeout(copyTimer.current);
    void navigator.clipboard.writeText(connection.inviteCode!).then(
      () => {
        setCopyState("copied");
        copyTimer.current = setTimeout(() => setCopyState("idle"), COPIED_RESET_MS);
      },
      () => setCopyState("failed"),
    );
  };
  return (
    <div className="collab-room" lang={locale} data-testid="collab-room">
      <header className="collab-room-header">
        <div className="collab-room-title">
          <h3 title={connection.projectName}>{connection.projectName}</h3>
          <span className={`collab-role collab-role-${snapshot.role}`}>
            {copy.roles[snapshot.role]}
          </span>
        </div>
        <div className="collab-room-meta">
          <p
            className="collab-status"
            role="status"
            data-status={snapshot.status}
            data-testid="collab-status"
          >
            <span className="collab-status-dot" aria-hidden="true" />
            {closed && snapshot.closeReason
              ? copy.closeReasons[snapshot.closeReason]
              : copy.status[snapshot.status]}
          </p>
          <span data-testid="collab-online-count">
            {copy.onlineCount(online, COLLAB_LIMITS.participants)}
          </span>
        </div>
        {snapshot.status === "reconnecting" && (
          <div className="collab-room-recovery" data-testid="collab-reconnecting">
            <p className="collab-muted">{copy.reconnectingHint}</p>
            {session.reconnectNow && (
              <button data-testid="collab-reconnect-now" onClick={() => session.reconnectNow?.()}>
                {copy.reconnectNow}
              </button>
            )}
          </div>
        )}
        {recoverable && (
          <div className="collab-room-recovery">
            <button
              className="primary"
              data-testid="collab-rejoin"
              disabled={busy !== null}
              onClick={() => void rejoin()}
            >
              {busy === "rejoin"
                ? copy.rejoining
                : snapshot.closeReason === "session-replaced"
                  ? copy.reconnectHere
                  : copy.rejoin}
            </button>
          </div>
        )}
        {connection.inviteCode && !closed && (
          <div className="collab-invite-block">
            <div className="collab-invite-row">
              <div className="collab-invite-field">
                <span className="collab-invite-label" id="collab-invite-label">
                  {copy.inviteCodeLabel}
                </span>
                <code
                  className="collab-invite-code"
                  data-testid="collab-invite-value"
                  aria-labelledby="collab-invite-label"
                  aria-describedby={isHost ? "collab-invite-share" : undefined}
                >
                  {connection.inviteCode}
                </code>
              </div>
              <button
                data-testid="collab-copy-invite"
                data-copied={copyState === "copied" || undefined}
                aria-live="polite"
                title={isHost ? copy.inviteShare : undefined}
                onClick={copyInvite}
              >
                {copyState === "copied" ? `${copy.copied} ✓` : copy.copy}
              </button>
            </div>
            {isHost && (
              <p className="collab-muted collab-invite-share" id="collab-invite-share">
                {copy.inviteShare}
              </p>
            )}
            <span role="status" className="collab-invite-status">
              {copyState === "failed" ? copy.copyFailed : ""}
            </span>
          </div>
        )}
        {!closed && entries.some((entry) => entry.role === "host" && !entry.online) && (
          <p className="collab-muted" data-testid="collab-host-offline">
            {copy.hostOffline}
          </p>
        )}
      </header>
      <TabList<"people" | "chat">
        className="collab-subtabs"
        variant="compact"
        label={copy.roomTools}
        value={view}
        onChange={setView}
        tabs={(["people", "chat"] as const).map((value) => ({
          value,
          id: `collab-view-${value}`,
          panelId: `collab-page-${value}`,
          label: value === "people" ? copy.people : copy.chat,
          ...(value === "chat" && chatState.unread ? { badge: chatState.unread } : {}),
        }))}
      />
      <div
        id="collab-page-people"
        className="collab-people-page"
        role="tabpanel"
        aria-labelledby="collab-view-people"
        hidden={view !== "people"}
      >
        {control}
        <Participants
          copy={copy}
          api={api}
          roomId={connection.roomId}
          entries={entries}
          isHost={isHost && snapshot.status === "connected"}
        />
      </div>
      <div
        id="collab-page-chat"
        role="tabpanel"
        aria-labelledby="collab-view-chat"
        hidden={view !== "chat"}
      >
        <ChatPanel session={session} locale={locale} />
      </div>
      <p className="collab-room-message" role="status" data-testid="collab-room-message">
        {message}
      </p>
      {error && !confirmEnd && (
        <div className="collab-room-error">
          <p className="collab-error" role="alert" data-testid="collab-room-error">
            {error.text}
          </p>
          {error.retry && (
            <button data-testid="collab-room-retry" disabled={busy !== null} onClick={error.retry}>
              {copy.retry}
            </button>
          )}
        </div>
      )}
      <footer className="collab-room-footer">
        <button disabled={busy !== null} data-testid="collab-leave" onClick={requestLeave}>
          {busy === "leave" ? copy.leaving : closed ? copy.backToLobby : copy.leave}
        </button>
        <ActionMenu label={copy.roomActions}>
          <button role="menuitem" data-testid="collab-save-copy" onClick={saveCopy}>
            {copy.saveCopy}
          </button>
          {isHost && !closed && (
            <button role="menuitem" className="danger" onClick={() => setConfirmEnd(true)}>
              {copy.endRoom}
            </button>
          )}
        </ActionMenu>
      </footer>
      {confirmLeave && (
        <Dialog
          role="alertdialog"
          className="collab-leave-confirm"
          title={isHost && !closed ? copy.leaveTitle : copy.leavePendingTitle}
          titleId="collab-leave-title"
          descriptionId="collab-leave-intro"
          intro={
            <div id="collab-leave-intro">
              {isHost && !closed && <p>{copy.leaveHostHint}</p>}
              {confirmLeave.pending && <p>{copy.leavePendingIntro}</p>}
            </div>
          }
          onClose={() => setConfirmLeave(null)}
        >
          <DialogActions>
            <button type="button" data-modal-initial onClick={() => setConfirmLeave(null)}>
              {copy.stay}
            </button>
            {isHost && !closed && (
              <button
                type="button"
                className="danger"
                data-testid="collab-leave-end"
                onClick={() => {
                  setConfirmLeave(null);
                  setConfirmEnd(true);
                }}
              >
                {copy.endForEveryone}
              </button>
            )}
            <button
              type="button"
              className={confirmLeave.pending ? "danger" : "primary"}
              data-testid="collab-leave-confirmed"
              onClick={() => {
                setConfirmLeave(null);
                void leave();
              }}
            >
              {confirmLeave.pending ? copy.leaveAnyway : copy.leave}
            </button>
          </DialogActions>
        </Dialog>
      )}
      {confirmEnd && (
        <Dialog
          role="alertdialog"
          className="collab-end-confirm"
          title={copy.endRoomTitle}
          titleId="collab-end-title"
          descriptionId="collab-end-intro"
          intro={<p id="collab-end-intro">{copy.endRoomIntro}</p>}
          onClose={() => {
            if (busyRef.current) return;
            setConfirmEnd(false);
            setError(null);
          }}
        >
          <DialogActions>
            <button
              type="button"
              data-modal-initial
              disabled={busy !== null}
              onClick={() => {
                setConfirmEnd(false);
                setError(null);
              }}
            >
              {copy.cancel}
            </button>
            <button
              type="button"
              className="danger"
              data-testid="collab-end-confirm"
              disabled={busy !== null}
              onClick={() => void leave(true)}
            >
              {busy === "end" ? copy.ending : copy.endRoom}
            </button>
          </DialogActions>
          {error && (
            <p className="collab-error" role="alert">
              {error.text}
            </p>
          )}
        </Dialog>
      )}
    </div>
  );
}
