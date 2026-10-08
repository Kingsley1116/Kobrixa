import type { Role } from "@kobrixa/collab-protocol";
import type { Locale } from "../i18n/copy.js";
import type { CollabErrorCode, CollabJoinChange } from "../../shared/collab.js";
import type { CollabFileSyncErrorCode, CollabSkipReason } from "./file-sync.js";
import type { CollabCloseReason, CollabStatus } from "./types.js";

export type DisplayNameProblem = "empty" | "too-long" | "invalid";

const en = {
  lobbyTitle: "Work together",
  lobbyIntro: "Share a project with classmates or teammates. Everyone edits the same files live.",
  displayName: "Your display name",
  displayNameHint: "Shown to everyone in the room.",
  displayNameProblems: {
    empty: "Enter a display name to start or join a room.",
    "too-long": "Use 40 characters or fewer.",
    invalid: "Remove control characters from the name.",
  } satisfies Record<DisplayNameProblem, string>,
  startRoom: "Start a room",
  startHint: (project: string) => `Invite others to edit “${project}”.`,
  startNeedsProject: "Open a project to start a room.",
  starting: "Starting room…",
  createIntro: "Project files will be shared with everyone who joins using your invite code.",
  roomPassword: "Room password (optional)",
  createPasswordHint: "Leave blank to allow joining with just the invite code.",
  joinPasswordHint: "If the host set a password, enter it here. It won't be remembered.",
  hostingAs: (name: string) => `You will host as ${name}.`,
  joinRoom: "Join a room",
  joinHint: "Have an invite code? Join someone else's project.",
  recentRooms: "Recent rooms",
  noRecentRooms: "Rooms you start or join appear here.",
  rejoin: "Rejoin",
  roles: { host: "Host", editor: "Editor", viewer: "Viewer" } satisfies Record<Role, string>,
  joinedAt: (date: string) => `Joined ${date}`,

  joinTitle: "Join a room",
  joinIntro: "Enter the invite code you received from the host.",
  inviteCode: "Invite code",
  inviteCodeHint: "12 letters and digits, for example ABCD-EFGH-JK23.",
  inviteCodeInvalid:
    "That doesn't look like an invite code. Check it has 12 letters and digits (no I, O, 0 or 1).",
  joiningAs: (name: string) => `You'll join as ${name}.`,
  join: "Join",
  joining: "Joining…",
  cancel: "Cancel",

  joinConflictTitle: "Local changes found",
  joinConflictIntro: (project: string) =>
    `Files in “${project}” changed on this computer since the last room sync. Joining syncs the room's version over them.`,
  joinConflictFiles: (count: number) =>
    `${count} ${count === 1 ? "file differs" : "files differ"} from the last sync`,
  joinConflictChanges: {
    added: "Added",
    changed: "Changed",
    removed: "Removed",
  } satisfies Record<CollabJoinChange["change"], string>,
  joinKeepCopy: "Keep a local copy, then join",
  joinKeepCopyHint:
    "Saves the current files and unsaved drafts to a separate folder first. If saving fails, nothing is changed.",
  joinReplace: "Replace with room version",
  joinReplaceHint:
    "Overwrites the local changes without a separate copy. Earlier versions of overwritten files can still be restored from local history while it is turned on.",
  joinBackupSaved: (path: string) => `Local copy saved to ${path}`,

  room: "Room",
  inviteCodeLabel: "Invite code",
  inviteShare: "Share this code and, if you set one, the room password.",
  copy: "Copy",
  copied: "Copied",
  copyFailed: "Couldn't copy. Select the code and copy it manually.",
  noInviteCode: "Only the host can see the invite code.",
  leave: "Leave room",
  backToLobby: "Back to lobby",
  status: {
    connecting: "Connecting…",
    syncing: "Syncing project…",
    connected: "Connected",
    reconnecting: "Connection lost. Reconnecting…",
    closed: "Disconnected",
  } satisfies Record<CollabStatus, string>,
  closeReasons: {
    left: "You left the room.",
    kicked: "You were removed by the host.",
    "room-closed": "The host closed this room.",
    "session-replaced": "This room was opened in another window. This window will stay offline.",
    unauthorized: "Your invite is no longer valid. Ask the host for a new code.",
    error: "The connection failed. Try joining again.",
  } satisfies Record<CollabCloseReason, string>,
  people: "People",
  peopleCount: (online: number, total: number) => `${online} online · ${total} total`,
  you: "(you)",
  online: "Online",
  offline: "Offline",
  makeViewer: "Make viewer",
  makeEditor: "Make editor",
  changeRoleLabel: (name: string, role: string) => `Change ${name} to ${role}`,
  remove: "Remove",
  removeLabel: (name: string) => `Remove ${name} from the room`,
  removeTitle: (name: string) => `Remove ${name}?`,
  removeIntro: "They will be disconnected from this room.",
  noParticipants: "Waiting for others to join…",
  chipLabel: (status: string, online: number) =>
    `Collaboration: ${status}, ${online} ${online === 1 ? "person" : "people"} online. Open collaboration panel`,

  sync: {
    label: "Shared file sync",
    syncing: "Syncing project files…",
    errors: {
      seed: () =>
        "Couldn't share the project files. Check that the project folder is still available.",
      read: (file?: string) =>
        file ? `Couldn't read “${file}” from disk.` : "Couldn't read the project folder.",
      write: (file?: string) => `Couldn't save the room's version of “${file ?? ""}” to disk.`,
      busy: (file?: string) =>
        `“${file ?? ""}” keeps changing on disk, so the room's version couldn't be saved. Close other programs that edit it, then retry.`,
      tree: (file?: string) => `Couldn't create, move or delete “${file ?? ""}” on disk.`,
      sync: () => "Shared files couldn't be synced to this computer.",
    } satisfies Record<CollabFileSyncErrorCode, (file?: string) => string>,
    details: "Details",
    retry: "Retry sync",
    retryOffline: "Reconnect to the room to retry.",
    skipped: (count: number) => `${count} ${count === 1 ? "file" : "files"} not shared`,
    skippedHint: "These files stay on this computer. Others in the room can't see them.",
    skipReasons: {
      format: "only .bp, .bpi, .bpm and .json files with simple names can be shared",
      size: "larger than the 1 MiB file limit",
      count: "over the 200-file room limit",
      total: "over the 8 MiB room limit",
    } satisfies Record<CollabSkipReason, string>,
    replacedTitle: (count: number) =>
      `The room's version replaced ${count} local ${count === 1 ? "file" : "files"}`,
    replacedBody:
      "These files had changes that weren't in the room. To get them back, open the file and choose Local history.",
    trashedTitle: (count: number) =>
      `${count} local ${count === 1 ? "item was" : "items were"} moved to the trash`,
    trashedBody:
      "They aren't part of the room. Restore them from the system Trash if you still need them.",
    dismiss: "Dismiss",
  },
  removedFiles: {
    title: (count: number) =>
      count === 1
        ? "A file with unsaved changes was deleted"
        : `${count} files with unsaved changes were deleted`,
    intro:
      "Someone in the room deleted these files while you had unsaved changes. Keep your changes as a local copy or discard them.",
    keep: "Keep as local copy",
    keepHint:
      "Saves a copy of the project, including your changes, outside the room and shows it in your file manager. It isn't shared.",
    keeping: "Saving copy…",
    discard: "Discard changes",
    failed: "Couldn't save the copy. Try again, or discard the changes.",
    saved: (target: string) => `Saved a local copy to ${target}`,
  },

  errors: {
    "room-closed": "This room has been ended. Create a new room from your retained project.",
    removed: "Your room access was revoked. Ask the host for a new invitation.",
    "identity-missing":
      "This room has no saved recovery credential. Open your retained project to create a new room.",
    "identity-unsupported":
      "The collaboration service didn't provide a recovery credential, so the room was closed. Try again later.",
    "project-required": "Open a project before starting a room.",
    "project-location-missing":
      "The original project location wasn't saved. Open your retained project and create a new room.",
    "project-unavailable": "Open the shared project before saving a copy.",
    "backup-failed":
      "Couldn't save a local copy, so nothing was changed. Check free disk space and folder permissions, then try again.",
    "prepare-failed":
      "Couldn't open the room's project on this computer. Check that the folder is available, then try again.",
    network: "Can't reach the collaboration service. Check your internet connection.",
    unavailable: "Collaboration isn't available right now. Try again later.",
    "not-found": "No room matches that invite code. Check the code and try again.",
    "room-full": "This room is full.",
    "rate-limited": "Too many attempts. Wait a minute and try again.",
    expired: "This invite has expired. Ask the host for a new code.",
    "bad-request": "The request was invalid. Check the details and try again.",
    unauthorized: "You're not allowed to do that. Try joining the room again.",
    "password-required": "This room requires a password. Ask the host for it.",
    "invalid-password": "The room password is incorrect. Try again.",
    forbidden: "Only the host can do that.",
    internal: "The collaboration service had a problem. Try again later.",
  } satisfies Record<CollabErrorCode, string>,
  unknownError: "Something went wrong. Try again.",
};

export type CollabCopy = typeof en;

const zhTW: CollabCopy = {
  lobbyTitle: "一起協作",
  lobbyIntro: "與同學或隊友共享專案，所有人即時編輯同一份檔案。",
  displayName: "你的顯示名稱",
  displayNameHint: "房間內的所有人都會看到這個名稱。",
  displayNameProblems: {
    empty: "請輸入顯示名稱，才能建立或加入房間。",
    "too-long": "名稱最多 40 個字元。",
    invalid: "名稱不可包含控制字元。",
  },
  startRoom: "建立房間",
  startHint: (project) => `邀請其他人編輯「${project}」。`,
  startNeedsProject: "請先開啟專案，才能建立房間。",
  starting: "正在建立房間…",
  createIntro: "透過邀請碼加入的人將能存取此專案的檔案。",
  roomPassword: "房間密碼（選填）",
  createPasswordHint: "留空時，其他人只需邀請碼即可加入。",
  joinPasswordHint: "若主持人有設定密碼，請在此輸入。應用程式不會記住密碼。",
  hostingAs: (name) => `你將以「${name}」的身分主持房間。`,
  joinRoom: "加入房間",
  joinHint: "有邀請碼嗎？加入別人的專案。",
  recentRooms: "最近的房間",
  noRecentRooms: "你建立或加入的房間會顯示在這裡。",
  rejoin: "重新加入",
  roles: { host: "主持人", editor: "編輯者", viewer: "檢視者" },
  joinedAt: (date) => `加入於 ${date}`,

  joinTitle: "加入房間",
  joinIntro: "輸入主持人提供的邀請碼。",
  inviteCode: "邀請碼",
  inviteCodeHint: "12 個英文字母與數字，例如 ABCD-EFGH-JK23。",
  inviteCodeInvalid: "邀請碼格式不正確。請確認共有 12 個英文字母與數字（不含 I、O、0、1）。",
  joiningAs: (name) => `你將以「${name}」的身分加入。`,
  join: "加入",
  joining: "正在加入…",
  cancel: "取消",

  joinConflictTitle: "發現本機修改",
  joinConflictIntro: (project) =>
    `自上次同步房間後，「${project}」在這台電腦上有檔案變更。加入後，房間版本會同步覆蓋這些檔案。`,
  joinConflictFiles: (count) => `有 ${count} 個檔案與上次同步不同`,
  joinConflictChanges: {
    added: "新增",
    changed: "修改",
    removed: "刪除",
  },
  joinKeepCopy: "保留本機副本後加入",
  joinKeepCopyHint: "先將目前的檔案與未儲存草稿另存到獨立資料夾；保存失敗時不會變更任何內容。",
  joinReplace: "以房間版本取代",
  joinReplaceHint:
    "直接覆蓋本機修改，不另存副本。啟用本機歷史時，仍可從本機歷史還原被覆蓋檔案的先前版本。",
  joinBackupSaved: (path) => `本機副本已保存至 ${path}`,

  room: "房間",
  inviteCodeLabel: "邀請碼",
  inviteShare: "分享此邀請碼；若有設定房間密碼，請一併告知對方。",
  copy: "複製",
  copied: "已複製",
  copyFailed: "無法複製，請手動選取並複製邀請碼。",
  noInviteCode: "只有主持人可以看到邀請碼。",
  leave: "離開房間",
  backToLobby: "返回大廳",
  status: {
    connecting: "正在連線…",
    syncing: "正在同步專案…",
    connected: "已連線",
    reconnecting: "連線中斷，正在重新連線…",
    closed: "已中斷連線",
  },
  closeReasons: {
    left: "你已離開房間。",
    kicked: "你已被主持人移出房間。",
    "room-closed": "主持人已關閉此房間。",
    "session-replaced": "此身分已在另一個視窗連線，本視窗已停止重連。",
    unauthorized: "你的邀請已失效，請向主持人索取新的邀請碼。",
    error: "連線失敗，請重新加入。",
  },
  people: "成員",
  peopleCount: (online, total) => `${online} 人在線 · 共 ${total} 人`,
  you: "（你）",
  online: "在線",
  offline: "離線",
  makeViewer: "設為檢視者",
  makeEditor: "設為編輯者",
  changeRoleLabel: (name, role) => `將 ${name} 改為${role}`,
  remove: "移除",
  removeLabel: (name) => `將 ${name} 移出房間`,
  removeTitle: (name) => `要移除 ${name} 嗎？`,
  removeIntro: "對方將被中斷與此房間的連線。",
  noParticipants: "正在等待其他人加入…",
  chipLabel: (status, online) => `協作：${status}，${online} 人在線。開啟協作面板`,

  sync: {
    label: "共享檔案同步",
    syncing: "正在同步專案檔案…",
    errors: {
      seed: () => "無法分享專案檔案。請確認專案資料夾仍然存在。",
      read: (file) => (file ? `無法從磁碟讀取「${file}」。` : "無法讀取專案資料夾。"),
      write: (file) => `無法將房間版本的「${file ?? ""}」儲存到磁碟。`,
      busy: (file) =>
        `「${file ?? ""}」在磁碟上不斷變更，無法儲存房間版本。請關閉其他正在編輯此檔案的程式後重試。`,
      tree: (file) => `無法在磁碟上建立、移動或刪除「${file ?? ""}」。`,
      sync: () => "無法將共享檔案同步到這台電腦。",
    },
    details: "詳細資訊",
    retry: "重試同步",
    retryOffline: "請先重新連線到房間，才能重試。",
    skipped: (count) => `${count} 個檔案未分享`,
    skippedHint: "這些檔案只保留在這台電腦上，房間內的其他人看不到。",
    skipReasons: {
      format: "只能分享名稱簡單的 .bp、.bpi、.bpm 與 .json 檔案",
      size: "超過單一檔案 1 MiB 的限制",
      count: "超過房間 200 個檔案的上限",
      total: "超過房間 8 MiB 的總容量上限",
    },
    replacedTitle: (count) => `房間版本已取代 ${count} 個本機檔案`,
    replacedBody: "這些檔案有房間中沒有的修改。如需找回，請開啟檔案並選擇「本機歷史」。",
    trashedTitle: (count) => `已將 ${count} 個本機項目移至垃圾桶`,
    trashedBody: "這些項目不屬於此房間。如仍需要，可從系統垃圾桶還原。",
    dismiss: "關閉",
  },
  removedFiles: {
    title: (count) =>
      count === 1 ? "有未儲存修改的檔案已被刪除" : `${count} 個有未儲存修改的檔案已被刪除`,
    intro: "房間內有人刪除了這些檔案，而你仍有未儲存的修改。你可以將修改保留為本機副本，或捨棄。",
    keep: "保留為本機副本",
    keepHint: "會在房間以外儲存一份包含你修改的專案副本，並在檔案管理員中顯示。此副本不會分享。",
    keeping: "正在儲存副本…",
    discard: "捨棄修改",
    failed: "無法儲存副本。請再試一次，或捨棄修改。",
    saved: (target) => `已將本機副本儲存到 ${target}`,
  },

  errors: {
    "room-closed": "房間已結束。可以保留的專案建立新房間。",
    removed: "你的房間存取權已撤銷，請向主持人取得新的邀請。",
    "identity-missing": "此房間沒有保存恢復憑證。請開啟保留的專案並建立新房間。",
    "identity-unsupported": "協作服務未提供恢復憑證，房間已關閉。請稍後再試。",
    "project-required": "請先開啟專案，才能建立房間。",
    "project-location-missing": "未保存原專案位置。請開啟保留的專案並建立新房間。",
    "project-unavailable": "請先開啟共享專案，再另存副本。",
    "backup-failed": "無法保存本機副本，因此未做任何變更。請確認磁碟空間與資料夾權限後再試一次。",
    "prepare-failed": "無法在這台電腦上開啟房間的專案。請確認資料夾可以存取後再試一次。",
    network: "無法連線到協作服務，請檢查網路連線。",
    unavailable: "協作功能目前無法使用，請稍後再試。",
    "not-found": "找不到符合此邀請碼的房間，請確認後再試一次。",
    "room-full": "此房間已滿。",
    "rate-limited": "嘗試次數過多，請稍候一分鐘再試。",
    expired: "此邀請已過期，請向主持人索取新的邀請碼。",
    "bad-request": "要求無效，請確認內容後再試一次。",
    unauthorized: "你沒有權限執行此操作，請重新加入房間。",
    "password-required": "此房間需要密碼，請向主持人索取。",
    "invalid-password": "房間密碼不正確，請再試一次。",
    forbidden: "只有主持人可以執行此操作。",
    internal: "協作服務發生問題，請稍後再試。",
  },
  unknownError: "發生錯誤，請再試一次。",
};

export const collabCopy: Record<Locale, CollabCopy> = { en, "zh-TW": zhTW };

export function collabErrorMessage(
  copy: CollabCopy,
  error: CollabErrorCode | "unknown" | undefined,
): string {
  return (error && error !== "unknown" && copy.errors[error]) || copy.unknownError;
}
