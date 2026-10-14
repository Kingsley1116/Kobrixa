import type { Locale } from "../i18n/copy.js";

export const pluginCopy = {
  en: {
    trust:
      "Development plugins run as normal programs on this computer. Kobrixa permissions only limit what a plugin asks Kobrixa to do; they are not a sandbox. Load only plugins you trust.",
    howTo:
      "To load development plugins, start Kobrixa with --plugin-dev-dir=<folder>. Python plugins also need --plugin-python=<interpreter>.",
    safeMode:
      "Safe mode: development plugins are off for this session. Disable a problem plugin here, then restart normally.",
    loading: "Loading plugins…",
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
    howTo:
      "要載入開發插件，請以 --plugin-dev-dir=<資料夾> 啟動 Kobrixa；Python 插件另需 --plugin-python=<直譯器>。",
    safeMode: "安全模式：本次啟動已關閉所有開發插件。可以在這裡停用有問題的插件，再正常重新啟動。",
    loading: "正在載入插件…",
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
};

export function problemText(problem: { code: string; message: string }, locale: Locale): string {
  const text = problems[problem.code];
  const summary = text ? text[locale === "zh-TW" ? 0 : 1] : problem.code;
  return locale === "zh-TW" ? `${summary}：${problem.message}` : `${summary}: ${problem.message}`;
}
