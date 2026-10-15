import type { Locale } from "../i18n/copy.js";
import type { PythonChoice } from "../../shared/plugins.js";

export const pluginCopy = {
  en: {
    trust:
      "Development plugins run as normal programs on this computer. Kobrixa permissions only limit what a plugin asks Kobrixa to do; they are not a sandbox. Load only plugins you trust.",
    howTo: "Turn on developer mode below to link plugin folders.",
    safeMode:
      "Safe mode: Kobrixa was started with --safe-mode, so third-party plugins are paused for this session. You can still disable or unlink a problem plugin.",
    safeModeLocked:
      "Kobrixa did not shut down normally last time, so third-party plugins are paused.",
    restore: "Restore plugins",
    openSettings: "Open plugin settings",
    notPersisted:
      "Applied for this session, but the setting could not be saved. It may be undone after a restart.",
    alreadyLinked: "This folder is already linked.",
    unknownError: "Unknown error",
    developerMode: "Developer mode",
    developerToggle: "Turn on developer mode",
    developerHint: "Runs code from the folders you link on this computer. It is not a sandbox.",
    developerCommandLine: "Turned on by --plugin-dev-dir for this session only; not saved.",
    keptLinks: (count: number) =>
      `${count} linked folder(s) are kept and load again when developer mode is on.`,
    linkFolder: "Link folder…",
    reload: "Reload",
    relink: "Choose folder again…",
    unlink: "Unlink",
    showLog: "Show log",
    hideLog: "Hide log",
    cancel: "Cancel",
    sessionSource: "From launch options",
    pendingReload: "Reload to use the new Python interpreter.",
    python: "Python interpreter",
    pythonNone: "Not chosen",
    pythonOther: "Other…",
    pythonRefresh: "Detect again",
    pythonCommandLine: (label: string) =>
      `This session uses ${label} from --plugin-python; the choice here applies next time.`,
    pythonProblems: {
      "sdk-missing": "kobrixa SDK not installed",
      "sdk-incompatible": "kobrixa SDK version is incompatible",
      "too-old": "Needs Python 3.10 or later",
      failed: "Could not run",
    },
    logTitle: "Plugin log",
    logEmpty: "No output yet.",
    logTruncated: "Earlier output was dropped.",
    severity: { info: "Info", warning: "Warning", error: "Error" },
    loading: "Loading plugins…",
    requestFailed: "Plugin request failed",
    builtin: "Built-in",
    development: "Development",
    status: {
      enabled: "Enabled",
      disabled: "Disabled",
      invalid: "Cannot load",
      failed: "Stopped after errors",
    },
    running: "Running",
    enable: "Enable",
    disable: "Disable",
    keepDisabled: "Keep disabled after restart",
    commands: "Commands",
    notices: "Messages from plugins",
    noNotices: "No messages yet.",
  },
  "zh-TW": {
    trust:
      "開發插件會以一般程式身分在這部電腦執行。Kobrixa 權限只限制插件透過 Kobrixa 提出的要求，並不是沙箱。請只載入你信任的插件。",
    howTo: "開啟下方的開發者模式後，就能連結插件資料夾。",
    safeMode:
      "安全模式：因為以 --safe-mode 啟動，本次已暫停所有第三方插件。仍然可以停用或解除連結有問題的插件。",
    safeModeLocked: "Kobrixa 上次沒有正常結束，已暫停第三方插件。",
    restore: "恢復插件",
    openSettings: "前往插件設定",
    notPersisted: "已套用到本次啟動，但設定未能保存，重新啟動後可能會還原。",
    alreadyLinked: "這個資料夾已經連結過了。",
    unknownError: "未知錯誤",
    developerMode: "開發者模式",
    developerToggle: "開啟開發者模式",
    developerHint: "會在這部電腦上執行你連結的資料夾裡的程式碼，不是沙箱。",
    developerCommandLine: "本次由 --plugin-dev-dir 開啟，只在這次有效，不會保存。",
    keptLinks: (count: number) => `已保留 ${count} 個連結的資料夾，開啟開發者模式後會重新載入。`,
    linkFolder: "連結資料夾…",
    reload: "重新載入",
    relink: "重新指定資料夾…",
    unlink: "解除連結",
    showLog: "查看日誌",
    hideLog: "收起日誌",
    cancel: "取消",
    sessionSource: "本次啟動參數",
    pendingReload: "重新載入後套用新的 Python 直譯器。",
    python: "Python 直譯器",
    pythonNone: "尚未選擇",
    pythonOther: "其他…",
    pythonRefresh: "重新偵測",
    pythonCommandLine: (label: string) =>
      `本次使用 --plugin-python 指定的 ${label}，這裡的選擇下次啟動才會套用。`,
    pythonProblems: {
      "sdk-missing": "沒有安裝 kobrixa SDK",
      "sdk-incompatible": "kobrixa SDK 版本不相容",
      "too-old": "需要 Python 3.10 以上",
      failed: "無法執行",
    },
    logTitle: "插件日誌",
    logEmpty: "目前沒有輸出。",
    logTruncated: "較早的輸出已截斷。",
    severity: { info: "資訊", warning: "警告", error: "錯誤" },
    loading: "正在載入插件…",
    requestFailed: "插件要求失敗",
    builtin: "內建",
    development: "開發",
    status: {
      enabled: "已啟用",
      disabled: "已停用",
      invalid: "無法載入",
      failed: "多次出錯後已停止",
    },
    running: "執行中",
    enable: "啟用",
    disable: "停用",
    keepDisabled: "重新啟動後也保持停用",
    commands: "命令",
    notices: "插件訊息",
    noNotices: "目前沒有訊息。",
  },
} as const;

const problems: Record<string, readonly [zh: string, en: string]> = {
  PLUGIN_E_MANIFEST: ["kobrixa-plugin.json 無效", "kobrixa-plugin.json is invalid"],
  PLUGIN_E_API_VERSION: [
    "插件需要其他版本的插件 API",
    "The plugin needs a different plugin API version",
  ],
  PLUGIN_E_DUPLICATE_ID: ["另一個插件已使用相同 id", "Another plugin uses the same id"],
  PLUGIN_E_COMMAND_NAMESPACE: [
    "命令 id 必須以插件 id 開頭",
    "Command ids must start with the plugin id",
  ],
  PLUGIN_E_DUPLICATE_COMMAND: ["命令重複宣告", "A command is declared twice"],
  PLUGIN_E_ACTIVATION: ["啟用事件指向不存在的命令", "An activation event names a missing command"],
  PLUGIN_E_RUNTIME_NOT_ALLOWED: ["不允許的執行方式", "This runtime is not allowed"],
  PLUGIN_E_FRONTEND_REQUIRES_BUILTIN: [
    "目前只有內建插件能提供編譯前端",
    "Only built-in plugins can provide compiler frontends for now",
  ],
  PLUGIN_E_ENTRY: [
    "找不到入口檔，或入口檔在插件資料夾外",
    "The entry file is missing or outside the plugin folder",
  ],
  PLUGIN_E_LAUNCH: [
    "無法啟動插件（例如找不到 Python）",
    "The plugin could not start (for example, Python was not found)",
  ],
  PLUGIN_E_HANDSHAKE: ["插件啟動握手失敗", "The plugin failed its startup handshake"],
  PLUGIN_E_PROTOCOL: [
    "插件送出無效的協定資料（日誌請寫到 stderr）",
    "The plugin sent invalid protocol data (write logs to stderr)",
  ],
  PLUGIN_E_UNRESPONSIVE: [
    "插件取消後沒有回應，已被終止",
    "The plugin did not respond to cancellation and was stopped",
  ],
  PLUGIN_E_CRASHED: [
    "插件意外結束；命令不會自動重試",
    "The plugin exited unexpectedly; the command is not retried",
  ],
  PLUGIN_E_CRASH_LOOP: [
    "插件多次出錯，停用再啟用後才會重新啟動",
    "The plugin failed repeatedly; disable and enable it to try again",
  ],
  PLUGIN_E_TIMEOUT: ["命令逾時", "The command timed out"],
  PLUGIN_E_CANCELLED: ["命令已取消", "The command was cancelled"],
  PLUGIN_E_COMMAND_FAILED: ["命令執行失敗", "The command failed"],
  PLUGIN_E_UNKNOWN_COMMAND: [
    "沒有已啟用的插件提供這個命令",
    "No enabled plugin provides this command",
  ],
  PLUGIN_E_UNKNOWN_PLUGIN: ["找不到插件", "Plugin not found"],
  PLUGIN_E_DISABLED: ["插件正在停止", "The plugin is stopping"],
  PLUGIN_E_BUILTIN_REQUIRED: ["內建插件不能停用", "Built-in plugins cannot be disabled"],
  PLUGIN_E_SAFE_MODE: [
    "安全模式下不能啟用開發插件",
    "Development plugins cannot be enabled in safe mode",
  ],
  PLUGIN_E_STATE_SAVE: ["無法儲存插件設定", "Plugin settings could not be saved"],
  PLUGIN_E_STATE_CORRUPT: [
    "插件設定檔已損毀，已暫停開發插件",
    "The plugin settings file was damaged; development plugins are paused",
  ],
  PLUGIN_E_SHUTTING_DOWN: ["Kobrixa 正在關閉插件", "Kobrixa is shutting down plugins"],
  PLUGIN_E_SOURCE_TIMEOUT: ["讀取插件資料夾逾時", "Reading the plugin folder timed out"],
  PLUGIN_E_SOURCE_EXISTS: ["這個資料夾已經載入", "This folder is already loaded"],
  PLUGIN_E_DEVELOPER_MODE: ["請先開啟開發者模式", "Turn on developer mode first"],
  PLUGIN_E_SESSION_SOURCE: ["這個來源來自啟動參數", "This source comes from launch options"],
  PLUGIN_E_PYTHON_UNUSABLE: ["這個 Python 無法使用", "This Python interpreter cannot be used"],
};

export function problemText(problem: { code: string; message: string }, locale: Locale): string {
  const text = problems[problem.code];
  const summary = text ? text[locale === "zh-TW" ? 0 : 1] : problem.code;
  return locale === "zh-TW" ? `${summary}：${problem.message}` : `${summary}: ${problem.message}`;
}

/** Readable text for anything an IPC call rejects with; never "[object Object]". */
export function readableError(reason: unknown): string | undefined {
  if (reason instanceof Error) return reason.message || undefined;
  if (typeof reason === "string") return reason || undefined;
  if (
    reason &&
    typeof reason === "object" &&
    typeof (reason as { message?: unknown }).message === "string"
  )
    return (reason as { message: string }).message;
  return undefined;
}

const statusIcons = { ok: "✅", warning: "⚠️", error: "❌" } as const;

export function pythonChoiceText(choice: PythonChoice, locale: Locale): string {
  const { probe } = choice;
  return [
    `${statusIcons[probe.status]} ${choice.label}`,
    probe.version && `Python ${probe.version}`,
    probe.path,
    probe.problem && pluginCopy[locale].pythonProblems[probe.problem],
  ]
    .filter(Boolean)
    .join(" · ");
}
