import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { Locale } from "../i18n/copy.js";
import type { CollabApi, CollabConnection, CollabSharePreview } from "../../shared/collab.js";
import type { CollabStore } from "./store.js";
import type { CollabSession } from "./types.js";
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

function Room({
  session,
  store,
  api,
  locale,
  onLeave,
  onLeavingChange,
  control,
}: PanelProps & { session: CollabSession }): React.JSX.Element {
  const copy = collabCopy[locale],
    zh = locale === "zh-TW";
  const snapshot = useSessionSnapshot(session)!;
  const entries = useRoster(session, snapshot);
  const { connection } = session;
  const chat = useChatController(session)!;
  const chatState = useSyncExternalStore(chat.subscribe, chat.getSnapshot);
  const [view, setView] = useState<"people" | "chat">("people");
  const [copied, setCopied] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const closed = snapshot.status === "closed";
  const online = entries.filter((entry) => entry.online).length;
  const leave = async (end = false): Promise<void> => {
    if (busy) return;
    setBusy(true);
    onLeavingChange?.(true);
    setError("");
    try {
      await onLeave?.();
      if (end) {
        const result = await api.closeRoom(connection.roomId);
        if (!result.ok) throw new Error(collabErrorMessage(copy, result.error));
      }
      await api.leave(connection.roomId);
      store.stop();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      onLeavingChange?.(false);
      setBusy(false);
    }
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
          <span>
            {online}/16 {zh ? "在線" : "online"}
          </span>
        </div>
        {connection.inviteCode && !closed && (
          <div className="collab-invite-row">
            <code className="collab-invite-code" data-testid="collab-invite-value">
              {connection.inviteCode}
            </code>
            <button
              data-testid="collab-copy-invite"
              onClick={() => {
                void navigator.clipboard.writeText(connection.inviteCode!).then(
                  () => setCopied(copy.copied),
                  () => setCopied(copy.copyFailed),
                );
              }}
            >
              {copy.copy}
            </button>
            <span role="status">{copied}</span>
          </div>
        )}
        {!closed && entries.some((entry) => entry.role === "host" && !entry.online) && (
          <p className="collab-muted">
            {zh
              ? "主持人已離線，主持權不會自動轉移。"
              : "The host is offline. Ownership stays with the host."}
          </p>
        )}
      </header>
      <TabList<"people" | "chat">
        className="collab-subtabs"
        variant="compact"
        label={zh ? "協作工具" : "Collaboration"}
        value={view}
        onChange={setView}
        tabs={(["people", "chat"] as const).map((value) => ({
          value,
          id: `collab-view-${value}`,
          panelId: `collab-page-${value}`,
          label: value === "people" ? copy.people : zh ? "聊天" : "Chat",
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
          isHost={snapshot.role === "host" && snapshot.status === "connected"}
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
      {error && (
        <p className="collab-error" role="alert">
          {error}
        </p>
      )}
      <footer className="collab-room-footer">
        <button disabled={busy} data-testid="collab-leave" onClick={() => void leave()}>
          {closed ? copy.backToLobby : copy.leave}
        </button>
        <ActionMenu label={zh ? "房間操作" : "Room actions"}>
          <button
            role="menuitem"
            onClick={() => {
              void api.saveCopy(connection.roomId).then(
                (file) => setCopied(`${zh ? "副本已保存：" : "Copy saved: "}${file}`),
                (failure) => setError(String(failure)),
              );
            }}
          >
            {zh ? "另存專案副本" : "Save project copy"}
          </button>
          {snapshot.role === "host" && !closed && (
            <button role="menuitem" className="danger" onClick={() => setConfirmEnd(true)}>
              {zh ? "結束房間" : "End room"}
            </button>
          )}
        </ActionMenu>
      </footer>
      {confirmEnd && (
        <Dialog
          title={zh ? "結束房間？" : "End this room?"}
          onClose={() => {
            if (!busy) setConfirmEnd(false);
          }}
        >
          <p>
            {zh
              ? "所有成員都會斷線，此房間將失效。本機檔案會保留。"
              : "Everyone will be disconnected and this room will expire. Local files are kept."}
          </p>
          <DialogActions>
            <button data-modal-initial disabled={busy} onClick={() => setConfirmEnd(false)}>
              {copy.cancel}
            </button>
            <button className="danger" disabled={busy} onClick={() => void leave(true)}>
              {zh ? "結束房間" : "End room"}
            </button>
          </DialogActions>
          {error && <p role="alert">{error}</p>}
        </Dialog>
      )}
    </div>
  );
}
