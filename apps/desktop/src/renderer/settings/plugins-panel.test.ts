// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginEvent, PluginsApi, PluginsView, PythonChoice } from "../../shared/plugins.js";
import { DEFAULT_DEVICE_PREFERENCES } from "../../shared/device-preferences.js";
import { DEFAULT_FILE_PREFERENCES } from "../../shared/file-preferences.js";
import type { Locale } from "../i18n/copy.js";
import type { KeyboardSettings } from "../keybindings/keyboard-state.js";
import { PluginsPanel, localizedText } from "./plugins-panel.js";
import { pluginCopy, problemText, readableError } from "./plugin-copy.js";
import { PluginRecoveryNotice } from "./plugin-recovery.js";
import { LOG_POLL_MS } from "./plugin-log.js";
import { SettingsPanel } from "./settings-panel.js";
import { defaultSettings } from "./settings.js";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";

vi.mock("../keybindings/shortcuts-panel.js", () => ({ ShortcutsPanel: () => null }));
vi.mock("../updates/updates.js", () => ({ UpdatesPanel: () => null }));

let root: Root;
let container: HTMLDivElement;
let emit: (event: PluginEvent) => void;
const originalScrollTo = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTo");
const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
const unhandledRejection = vi.fn();
const snapshot: PluginsView = {
  revision: 1,
  diagnosticHelpRevision: 0,
  staticLanguagesRevision: 0,
  staticLanguageOwners: [],
  safeMode: false,
  developmentMode: true,
  developer: { enabled: true, commandLine: false, linkedCount: 1 },
  origins: { "builtin:kobrixa.basic-plus": "builtin", "dev:0123456789abcdef": "linked" },
  python: { pendingReload: [] },
  inflight: [],
  plugins: [
    {
      id: "kobrixa.basic-plus",
      sourceKey: "builtin:kobrixa.basic-plus",
      source: "builtin",
      runtime: "builtin",
      version: "1.0.0",
      status: "enabled",
      running: false,
      problems: [],
      commands: [],
      displayName: "Basic Plus",
    },
    {
      id: "acme.hello",
      sourceKey: "dev:0123456789abcdef",
      source: "development",
      runtime: "python",
      version: "1.0.0",
      status: "enabled",
      running: false,
      problems: [{ code: "PLUGIN_E_LAUNCH", message: "python not found" }],
      commands: [{ id: "acme.hello.greet", title: { en: "Greet", "zh-TW": "打招呼" } }],
    },
  ],
};
const unsubscribe = vi.fn();
const api = {
  state: vi.fn(async () => snapshot),
  execute: vi.fn<PluginsApi["execute"]>(async () => ({
    ok: false as const,
    code: "PLUGIN_E_LAUNCH" as const,
    message: "python not found",
  })),
  setEnabled: vi.fn<PluginsApi["setEnabled"]>(async () => ({
    ok: true as const,
    state: {
      ...snapshot,
      plugins: [
        snapshot.plugins[0]!,
        {
          ...snapshot.plugins[1]!,
          status: "disabled" as const,
          disabledBy: "user" as const,
          commands: [],
        },
      ],
    },
  })),
  staticLanguages: vi.fn<PluginsApi["staticLanguages"]>(async () => ({
    formatVersion: 1,
    limitsVersion: 1,
    revision: 0,
    languages: [],
    extensionRoutes: {},
    conflicts: [],
  })),
  reportLanguageRegistrationFailure: vi.fn<PluginsApi["reportLanguageRegistrationFailure"]>(
    async () => ({ accepted: false, revision: 0 }),
  ),
  notices: vi.fn<PluginsApi["notices"]>(async () => []),
  diagnosticHelp: vi.fn<PluginsApi["diagnosticHelp"]>(async () => ({ revision: 0, plugins: {} })),
  cancel: vi.fn<PluginsApi["cancel"]>(async () => {}),
  setDeveloperMode: vi.fn<PluginsApi["setDeveloperMode"]>(),
  linkFolder: vi.fn<PluginsApi["linkFolder"]>(),
  relinkFolder: vi.fn<PluginsApi["relinkFolder"]>(),
  unlink: vi.fn<PluginsApi["unlink"]>(),
  reload: vi.fn<PluginsApi["reload"]>(),
  pythonCandidates: vi.fn<PluginsApi["pythonCandidates"]>(async () => []),
  setPython: vi.fn<PluginsApi["setPython"]>(),
  readLog: vi.fn<PluginsApi["readLog"]>(async () => ({ lines: [], next: 0, truncated: false })),
  clearSafeModeLock: vi.fn<PluginsApi["clearSafeModeLock"]>(),
  onEvent: vi.fn((listener: (event: PluginEvent) => void) => {
    emit = listener;
    return unsubscribe;
  }),
} satisfies PluginsApi;
beforeEach(() => {
  vi.clearAllMocks();
  process.on("unhandledRejection", unhandledRejection);
  api.state.mockResolvedValue(snapshot);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("kobrixa", { plugins: api });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  process.off("unhandledRejection", unhandledRejection);
  if (originalScrollTo) Object.defineProperty(Element.prototype, "scrollTo", originalScrollTo);
  else delete (Element.prototype as Partial<Element>).scrollTo;
  if (originalScrollIntoView)
    Object.defineProperty(Element.prototype, "scrollIntoView", originalScrollIntoView);
  else delete (Element.prototype as Partial<Element>).scrollIntoView;
  vi.unstubAllGlobals();
});
const render = async (locale: Locale = "zh-TW") => {
  await act(async () => root.render(createElement(PluginsPanel, { locale })));
};
const button = (text: string) =>
  [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(text))!;
const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

it("lists plugins in Traditional Chinese with the trust warning and problems", async () => {
  await render();
  expect(container.textContent).toContain("並不是沙箱");
  expect(container.textContent).toContain("acme.hello");
  expect(container.textContent).toContain("找不到 Python");
  expect(button("打招呼").disabled).toBe(false);
});

it("runs a command and shows the translated failure", async () => {
  await render();
  await act(async () => button("打招呼").click());
  expect(api.execute).toHaveBeenCalledWith("acme.hello.greet");
  expect(container.querySelector("[role=alert]")?.textContent).toContain("python not found");
});

it.each(["execute", "setEnabled"] as const)(
  "handles a rejected %s request, restores controls, and follows the current locale",
  async (method) => {
    let reject!: (reason: Error) => void;
    api[method].mockImplementationOnce(
      () =>
        new Promise<never>((_resolve, rejectPromise) => {
          reject = rejectPromise;
        }),
    );
    await render();
    await act(async () => button(method === "execute" ? "打招呼" : "停用").click());
    expect(api[method]).toHaveBeenCalledOnce();
    expect(button("打招呼").disabled).toBe(true);
    expect(button("停用").disabled).toBe(method === "setEnabled");

    await act(async () => {
      reject(new Error("IPC connection lost"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(unhandledRejection).not.toHaveBeenCalled();
    expect(container.querySelector("[role=alert]")?.textContent).toBe(
      "插件要求失敗：IPC connection lost",
    );
    expect(button("打招呼").disabled).toBe(false);
    expect(button("停用").disabled).toBe(false);

    await render("en");
    expect(container.querySelector("[role=alert]")?.textContent).toBe(
      "Plugin request failed: IPC connection lost",
    );
    expect(api.state).toHaveBeenCalledOnce();
    expect(api[method]).toHaveBeenCalledOnce();
  },
);

it("replaces loading with a localized alert when the initial state request rejects", async () => {
  let reject!: (reason: Error) => void;
  api.state.mockImplementationOnce(
    () =>
      new Promise<never>((_resolve, rejectPromise) => {
        reject = rejectPromise;
      }),
  );
  await render();
  expect(container.textContent).toContain("正在載入插件…");
  await act(async () => {
    reject(new Error("state unavailable"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(unhandledRejection).not.toHaveBeenCalled();
  expect(container.querySelector("[role=alert]")?.textContent).toBe(
    "插件要求失敗：state unavailable",
  );
  expect(container.textContent).not.toContain("正在載入插件…");

  await render("en");
  expect(container.querySelector("[role=alert]")?.textContent).toBe(
    "Plugin request failed: state unavailable",
  );
  expect(container.textContent).not.toContain("Loading plugins…");
  expect(api.state).toHaveBeenCalledOnce();
});

it("handles an initial state rejection after the panel unmounts", async () => {
  let reject!: (reason: Error) => void;
  api.state.mockImplementationOnce(
    () =>
      new Promise<never>((_resolve, rejectPromise) => {
        reject = rejectPromise;
      }),
  );
  await render();
  await act(async () => root.render(null));
  await act(async () => {
    reject(new Error("state unavailable"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(unhandledRejection).not.toHaveBeenCalled();
  expect(container.textContent).toBe("");
  expect(unsubscribe).toHaveBeenCalledOnce();
});

it("retranslates a structured failure when the locale changes", async () => {
  await render();
  await act(async () => button("打招呼").click());
  expect(container.querySelector("[role=alert]")?.textContent).toBe(
    "無法啟動插件（例如找不到 Python）：python not found",
  );
  await render("en");
  expect(container.querySelector("[role=alert]")?.textContent).toBe(
    "The plugin could not start (for example, Python was not found): python not found",
  );
  expect(api.execute).toHaveBeenCalledOnce();
  expect(api.state).toHaveBeenCalledOnce();
});

it("disables development plugins but never offers it for built-ins", async () => {
  await render();
  const toggles = [...container.querySelectorAll("button")].filter(
    (item) => item.textContent === "停用",
  );
  expect(toggles).toHaveLength(1);
  await act(async () => toggles[0]!.click());
  expect(api.setEnabled).toHaveBeenCalledWith("dev:0123456789abcdef", false);
  expect(container.textContent).toContain("已停用");
});

it("shows notices with their plugin id", async () => {
  await render();
  await act(async () =>
    emit({
      type: "notice",
      notice: {
        id: 1,
        pluginId: "acme.hello",
        sourceKey: "dev:0123456789abcdef",
        severity: "info",
        message: "哈囉",
        at: 0,
      },
    }),
  );
  expect(container.querySelector("[aria-live=polite]")?.textContent).toContain("acme.hello");
  expect(container.querySelector("[aria-live=polite]")?.textContent).toContain("哈囉");
});

it("explains developer mode and command-line safe mode", async () => {
  api.state.mockResolvedValueOnce({
    ...snapshot,
    safeMode: true,
    developmentMode: false,
    plugins: [snapshot.plugins[0]!],
    developer: { enabled: false, commandLine: false, linkedCount: 0 },
  });
  await render();
  expect(container.textContent).toContain(pluginCopy["zh-TW"].howTo);
  expect(container.textContent).toContain("--safe-mode");
  expect(container.textContent).not.toContain("--plugin-dev-dir");
});

it("renders English names, metadata, commands and translated errors", async () => {
  api.state.mockResolvedValueOnce({
    ...snapshot,
    plugins: [
      snapshot.plugins[0]!,
      {
        ...snapshot.plugins[1]!,
        displayName: { en: "Hello plugin", "zh-TW": "哈囉插件" },
        directory: "/plugins/hello",
        running: true,
      },
    ],
  });
  await render("en");
  expect(container.textContent).toContain(pluginCopy.en.trust);
  expect(container.textContent).toContain("Hello plugin");
  expect(container.textContent).toContain(
    "acme.hello · 1.0.0 · Development · python · Enabled · Running",
  );
  expect(container.textContent).toContain("/plugins/hello");
  expect(container.textContent).toContain("Built-in");
  expect(container.textContent).toContain("No messages yet.");
  expect(container.textContent).not.toContain("--plugin-dev-dir");
  await act(async () => button("Greet").click());
  expect(container.querySelector("[role=alert]")?.textContent).toBe(
    "The plugin could not start (for example, Python was not found): python not found",
  );
});

it("localizes text with English fallback and preserves unknown problem codes", () => {
  expect(localizedText("Basic Plus", "zh-TW")).toBe("Basic Plus");
  expect(localizedText({ en: "Hello" }, "zh-TW")).toBe("Hello");
  expect(localizedText({ en: "Hello", "zh-TW": "哈囉" }, "zh-TW")).toBe("哈囉");
  expect(localizedText({ en: "Hello", "zh-TW": "哈囉" }, "en")).toBe("Hello");
  expect(problemText({ code: "FUTURE_ERROR", message: "raw detail" }, "en")).toBe(
    "FUTURE_ERROR: raw detail",
  );
  expect(problemText({ code: "FUTURE_ERROR", message: "raw detail" }, "zh-TW")).toBe(
    "FUTURE_ERROR：raw detail",
  );
  expect(readableError(new Error("boom"))).toBe("boom");
  expect(readableError({ message: "from main" })).toBe("from main");
  expect(readableError({ reason: "opaque" })).toBeUndefined();
  expect(readableError("text")).toBe("text");
});

it.each(["disabled", "invalid", "failed"] as const)(
  "blocks commands when a plugin is %s, even if commands remain in the snapshot",
  async (status) => {
    api.state.mockResolvedValueOnce({
      ...snapshot,
      plugins: [{ ...snapshot.plugins[1]!, status }],
    });
    await render();
    expect(button("打招呼").disabled).toBe(true);
    await act(async () => button("打招呼").click());
    expect(api.execute).not.toHaveBeenCalled();
    if (status === "invalid") expect(button("停用")).toBeUndefined();
  },
);

it("enables a user-disabled development plugin and uses the acknowledged state", async () => {
  api.state.mockResolvedValueOnce({
    ...snapshot,
    plugins: [{ ...snapshot.plugins[1]!, status: "disabled", disabledBy: "user", commands: [] }],
  });
  api.setEnabled.mockResolvedValueOnce({ ok: true, state: snapshot });
  await render();
  await act(async () => button("啟用").click());
  expect(api.setEnabled).toHaveBeenCalledWith("dev:0123456789abcdef", true);
  expect(button("打招呼").disabled).toBe(false);
});

it("lets a safe-mode plugin stay disabled after restart but blocks re-enabling", async () => {
  api.state.mockResolvedValueOnce({
    ...snapshot,
    safeMode: true,
    plugins: [
      { ...snapshot.plugins[1]!, status: "disabled", disabledBy: "safe-mode", commands: [] },
    ],
  });
  api.setEnabled.mockResolvedValueOnce({
    ok: true,
    state: {
      ...snapshot,
      safeMode: true,
      plugins: [{ ...snapshot.plugins[1]!, status: "disabled", disabledBy: "user", commands: [] }],
    },
  });
  await render();
  expect(container.querySelector("[role=status]")?.textContent).toBe(pluginCopy["zh-TW"].safeMode);
  await act(async () => button("重新啟動後也保持停用").click());
  expect(api.setEnabled).toHaveBeenCalledWith("dev:0123456789abcdef", false);
  expect(button("啟用").disabled).toBe(true);
  await act(async () => button("啟用").click());
  expect(api.setEnabled).toHaveBeenCalledOnce();
});

it("shows a translated save failure without changing the acknowledged plugin state", async () => {
  api.setEnabled.mockResolvedValueOnce({
    ok: false,
    code: "PLUGIN_E_STATE_SAVE",
    message: "disk full",
  });
  await render();
  await act(async () => button("停用").click());
  expect(container.querySelector("[role=alert]")?.textContent).toBe("無法儲存插件設定：disk full");
  expect(button("打招呼").disabled).toBe(false);
  expect(button("停用").disabled).toBe(false);
});

it("updates from state events and unsubscribes when unmounted", async () => {
  await render();
  await act(async () =>
    emit({
      type: "state",
      state: { ...snapshot, plugins: [snapshot.plugins[0]!] },
    }),
  );
  expect(container.textContent).not.toContain("acme.hello");
  await act(async () => root.render(null));
  expect(unsubscribe).toHaveBeenCalledOnce();
});

it("keeps only the latest 20 notices, newest first, and renders plugin text literally", async () => {
  await render();
  await act(async () => {
    for (let at = 0; at < 21; at++)
      emit({
        type: "notice",
        notice: {
          id: at + 1,
          pluginId: "acme.hello",
          sourceKey: "dev:0123456789abcdef",
          severity: "info",
          message: `<img src=x> notice-${at}`,
          at,
        },
      });
  });
  const notices = container.querySelectorAll("[aria-live=polite] li");
  expect(notices).toHaveLength(20);
  expect(notices[0]?.textContent).toBe("資訊 acme.hello <img src=x> notice-20");
  expect(notices[19]?.textContent).toBe("資訊 acme.hello <img src=x> notice-1");
  expect(container.querySelector("img")).toBeNull();
});

it.each(["en", "zh-TW"] as const)(
  "opens the %s plugins category before updates without an empty-settings message",
  async (locale) => {
    vi.stubGlobal("kobrixa", {
      plugins: api,
      device: { getPreferences: vi.fn(async () => DEFAULT_DEVICE_PREFERENCES) },
    });
    Element.prototype.scrollTo = vi.fn();
    await act(async () =>
      root.render(
        createElement(SettingsPanel, {
          settings: defaultSettings(locale),
          onChange: vi.fn(),
          onReset: vi.fn(),
          active: true,
          saveError: false,
          onRetry: vi.fn(),
          keyboard: {} as KeyboardSettings,
          requestedCategory: { category: "appearance", request: 0 },
          updates: undefined,
          updateBusy: false,
          onInstallUpdate: vi.fn(),
          reducedMotion: false,
          filePreferences: {
            value: DEFAULT_FILE_PREFERENCES,
            busy: false,
            error: false,
            change: vi.fn(),
            retry: vi.fn(),
          },
        }),
      ),
    );
    expect(api.state).not.toHaveBeenCalled();
    const category = button(locale === "en" ? "Plugins" : "插件");
    expect(category.nextElementSibling?.textContent).toBe(
      locale === "en" ? "About & updates" : "關於與更新",
    );
    await act(async () => category.click());
    expect(container.querySelector("#settings-plugins")?.textContent).toBe(
      locale === "en" ? "Plugins" : "插件",
    );
    expect(container.querySelector(".plugins-panel")?.textContent).toContain(
      pluginCopy[locale].trust,
    );
    expect(container.querySelector(".settings-empty")).toBeNull();
    await act(async () => {
      const search = container.querySelector<HTMLInputElement>('input[type="search"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        search,
        "nonexistent-setting",
      );
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelector(".plugins-panel")).toBeNull();
    expect(container.querySelector(".settings-empty")).not.toBeNull();
    expect(unsubscribe).toHaveBeenCalledOnce();
  },
);

it("ignores an older snapshot that arrives after a newer state event", async () => {
  let finish!: (result: Awaited<ReturnType<PluginsApi["setEnabled"]>>) => void;
  api.setEnabled.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  await act(async () => button("停用").click());
  act(() =>
    emit({
      type: "state",
      state: {
        ...snapshot,
        revision: 5,
        plugins: [snapshot.plugins[0]!, { ...snapshot.plugins[1]!, running: true }],
      },
    }),
  );
  await act(async () =>
    finish({
      ok: true,
      state: {
        ...snapshot,
        revision: 3,
        plugins: [snapshot.plugins[0]!, { ...snapshot.plugins[1]!, status: "invalid" }],
      },
    }),
  );
  expect(container.textContent).toContain("執行中");
  expect(container.textContent).not.toContain("無法載入");
});

it("shows a corrupt settings file and an unsaved disable", async () => {
  api.state.mockResolvedValueOnce({
    ...snapshot,
    stateProblem: { code: "PLUGIN_E_STATE_CORRUPT", message: "moved aside" },
  });
  api.setEnabled.mockResolvedValueOnce({
    ok: true,
    persisted: false,
    state: {
      ...snapshot,
      revision: 2,
      plugins: [
        snapshot.plugins[0]!,
        { ...snapshot.plugins[1]!, status: "disabled", disabledBy: "user", commands: [] },
      ],
    },
  });
  await render();
  expect(container.textContent).toContain("插件設定檔已損毀，已暫停開發插件：moved aside");
  await act(async () => button("停用").click());
  expect(container.querySelector("[role=alert]")?.textContent).toBe(
    pluginCopy["zh-TW"].notPersisted,
  );
});

it("keeps row actions usable while that row's command runs, and cancels it", async () => {
  let finish!: (result: Awaited<ReturnType<PluginsApi["execute"]>>) => void;
  api.execute.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  await act(async () => button("打招呼").click());
  expect(button("打招呼").disabled).toBe(true);
  expect(button("停用").disabled).toBe(false);
  expect(button("重新載入").disabled).toBe(false);
  expect(button("解除連結").disabled).toBe(false);
  await act(async () => button("取消").click());
  expect(api.cancel).toHaveBeenCalledWith("dev:0123456789abcdef");
  await act(async () => finish({ ok: false, code: "PLUGIN_E_CANCELLED", message: "cancelled" }));
  expect(button("取消")).toBeUndefined();
  expect(button("打招呼").disabled).toBe(false);
  expect(container.querySelector("[role=alert]")?.textContent).toBe("命令已取消：cancelled");
});

it("shows a cancel button for a command main reports as running", async () => {
  api.state.mockResolvedValueOnce({ ...snapshot, inflight: ["dev:0123456789abcdef"] });
  await render();
  expect(button("打招呼").disabled).toBe(true);
  expect(button("取消")).toBeDefined();
});

it("never shows [object Object] and clears a stale request failure on newer state", async () => {
  api.reload.mockRejectedValueOnce({ reason: "opaque" });
  await render();
  await act(async () => button("重新載入").click());
  expect(container.querySelector("[role=alert]")?.textContent).toBe("插件要求失敗：未知錯誤");
  await act(async () => emit({ type: "state", state: { ...snapshot, revision: 2 } }));
  expect(container.querySelector("[role=alert]")).toBeNull();
});

it("turns developer mode on through main and then offers linking", async () => {
  api.state.mockResolvedValueOnce({
    ...snapshot,
    developmentMode: false,
    plugins: [snapshot.plugins[0]!],
    developer: { enabled: false, commandLine: false, linkedCount: 2 },
  });
  api.setDeveloperMode.mockResolvedValueOnce({ ok: true, state: { ...snapshot, revision: 2 } });
  await render();
  expect(container.textContent).toContain("已保留 2 個連結的資料夾");
  expect(button("連結資料夾…")).toBeUndefined();
  const toggle = () => container.querySelector<HTMLInputElement>("input[type=checkbox]")!;
  expect(toggle().checked).toBe(false);
  await act(async () => toggle().click());
  expect(api.setDeveloperMode).toHaveBeenCalledWith(true);
  expect(toggle().checked).toBe(true);
  expect(button("連結資料夾…")).toBeDefined();
});

it("links a folder and scrolls to one that is already linked", async () => {
  const scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
  api.linkFolder.mockResolvedValueOnce({
    ok: true,
    state: snapshot,
    outcome: "duplicate",
    sourceKey: "dev:0123456789abcdef",
  });
  await render();
  await act(async () => button("連結資料夾…").click());
  expect(api.linkFolder).toHaveBeenCalledOnce();
  expect(container.querySelector("[role=alert]")?.textContent).toBe(
    pluginCopy["zh-TW"].alreadyLinked,
  );
  expect(
    container.querySelector("#plugin-dev-0123456789abcdef")?.hasAttribute("data-highlighted"),
  ).toBe(true);
  expect(scrollIntoView).toHaveBeenCalled();
});

it("labels session sources, offers relinking a broken folder and unlinks only linked ones", async () => {
  api.state.mockResolvedValueOnce({
    ...snapshot,
    plugins: [
      {
        ...snapshot.plugins[1]!,
        status: "invalid",
        commands: [],
        problems: [{ code: "PLUGIN_E_MANIFEST", message: "missing" }],
      },
      { ...snapshot.plugins[1]!, sourceKey: "dev:fedcba9876543210", id: "acme.cli", commands: [] },
    ],
    origins: { "dev:0123456789abcdef": "linked", "dev:fedcba9876543210": "session" },
  });
  api.relinkFolder.mockResolvedValueOnce({
    ok: true,
    state: snapshot,
    sourceKey: "dev:0123456789abcdef",
  });
  await render();
  const [linked, session] = [...container.querySelectorAll(".plugins-list > li")];
  expect(linked!.textContent).toContain("重新指定資料夾…");
  expect(session!.textContent).toContain("本次啟動參數");
  expect(session!.textContent).not.toContain("解除連結");
  await act(async () => button("重新指定資料夾…").click());
  expect(api.relinkFolder).toHaveBeenCalledWith("dev:0123456789abcdef");
});

it("reloads and unlinks a row through main", async () => {
  api.reload.mockResolvedValueOnce({ ok: true, state: { ...snapshot, revision: 2 } });
  api.unlink.mockResolvedValueOnce({
    ok: true,
    state: { ...snapshot, revision: 3, plugins: [snapshot.plugins[0]!] },
  });
  await render();
  await act(async () => button("重新載入").click());
  expect(api.reload).toHaveBeenCalledWith("dev:0123456789abcdef");
  await act(async () => button("解除連結").click());
  expect(api.unlink).toHaveBeenCalledWith("dev:0123456789abcdef");
  expect(container.textContent).not.toContain("acme.hello");
});

it("lists Python candidates with their status and saves a choice by id", async () => {
  const choices: PythonChoice[] = [
    {
      id: "python3",
      label: "python3",
      selected: true,
      probe: { status: "ok", version: "3.12.1", path: "/usr/bin/python3", sdkApiVersion: "1.0.0" },
    },
    {
      id: "python",
      label: "python",
      selected: false,
      probe: {
        status: "warning",
        problem: "sdk-missing",
        version: "3.11.0",
        path: "/usr/bin/python",
      },
    },
    {
      id: "saved",
      label: "/old/python",
      selected: false,
      probe: { status: "error", problem: "too-old", version: "3.8.0" },
    },
  ];
  // Once for the first load and once for the refresh after saving.
  api.pythonCandidates.mockResolvedValueOnce(choices).mockResolvedValueOnce(choices);
  api.setPython.mockResolvedValueOnce({ ok: true, state: { ...snapshot, revision: 2 } });
  await render();
  await flush();
  const select = container.querySelector<HTMLSelectElement>("select")!;
  expect([...select.options].map((option) => option.textContent)).toEqual([
    "✅ python3 · Python 3.12.1 · /usr/bin/python3",
    "⚠️ python · Python 3.11.0 · /usr/bin/python · 沒有安裝 kobrixa SDK",
    "❌ /old/python · Python 3.8.0 · 需要 Python 3.10 以上",
    "其他…",
  ]);
  expect(select.value).toBe("python3");
  expect(select.options[2]!.disabled).toBe(true);
  await act(async () => {
    select.value = "python";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
  expect(api.setPython).toHaveBeenCalledWith("python");
  expect(api.pythonCandidates).toHaveBeenCalledTimes(2);
});

it("explains pending Python reloads and a --plugin-python override", async () => {
  api.state.mockResolvedValueOnce({
    ...snapshot,
    python: {
      current: { label: "/cli/python", origin: "command-line" },
      pendingReload: ["dev:0123456789abcdef"],
    },
  });
  await render();
  expect(container.textContent).toContain(pluginCopy["zh-TW"].pendingReload);
  expect(container.textContent).toContain(pluginCopy["zh-TW"].pythonCommandLine("/cli/python"));
});

it("reads a row's log in batches only while the viewer is open", async () => {
  vi.useFakeTimers();
  try {
    api.readLog
      .mockResolvedValueOnce({ lines: [{ seq: 1, text: "first" }], next: 1, truncated: true })
      .mockResolvedValueOnce({ lines: [{ seq: 2, text: "second" }], next: 2, truncated: false });
    await render();
    expect(api.readLog).not.toHaveBeenCalled();
    await act(async () => button("查看日誌").click());
    expect(api.readLog).toHaveBeenLastCalledWith("dev:0123456789abcdef", 0);
    const log = () => container.querySelector("[role=log]")!.textContent;
    expect(log()).toContain(pluginCopy["zh-TW"].logTruncated);
    expect(log()).toContain("first");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOG_POLL_MS);
    });
    expect(api.readLog).toHaveBeenLastCalledWith("dev:0123456789abcdef", 1);
    expect(log()).toContain("second");
    await act(async () => button("收起日誌").click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOG_POLL_MS * 3);
    });
    expect(api.readLog).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

it("shows notices main kept while the panel was closed, with their severity", async () => {
  const kept = {
    id: 7,
    pluginId: "acme.hello",
    sourceKey: "dev:0123456789abcdef",
    severity: "error" as const,
    message: "broke",
    at: 0,
  };
  api.notices.mockResolvedValueOnce([kept]);
  await render();
  expect(container.querySelector("[aria-live=polite] li")?.textContent).toBe(
    "錯誤 acme.hello broke",
  );
  await act(async () => emit({ type: "notice", notice: kept }));
  expect(container.querySelectorAll("[aria-live=polite] li")).toHaveLength(1);
});

it("restores plugins from a safe-mode lock inside the panel", async () => {
  api.state.mockResolvedValueOnce({
    ...snapshot,
    safeMode: true,
    safeModeLock: { since: "2026-10-15T00:00:00.000Z", reason: "unclean-exit" },
  });
  api.clearSafeModeLock.mockResolvedValueOnce({ ok: true, state: { ...snapshot, revision: 2 } });
  await render();
  expect(container.textContent).toContain("Kobrixa 上次沒有正常結束，已暫停第三方插件。");
  expect(button("重新載入").disabled).toBe(true);
  expect(button("連結資料夾…").disabled).toBe(true);
  await act(async () => button("恢復插件").click());
  expect(api.clearSafeModeLock).toHaveBeenCalledOnce();
  expect(container.textContent).not.toContain("上次沒有正常結束");
});

describe("PluginRecoveryNotice", () => {
  const locked: PluginsView = {
    ...snapshot,
    safeMode: true,
    safeModeLock: { since: "2026-10-15T00:00:00.000Z", reason: "renderer-unresponsive" },
  };
  const renderNotice = async () => {
    const onOpenSettings = vi.fn();
    await act(async () =>
      root.render(createElement(PluginRecoveryNotice, { locale: "zh-TW", onOpenSettings })),
    );
    return onOpenSettings;
  };
  it("renders nothing without a lock", async () => {
    await renderNotice();
    expect(container.textContent).toBe("");
  });
  it("restores plugins or opens the plugin settings", async () => {
    api.state.mockResolvedValueOnce(locked);
    api.clearSafeModeLock.mockResolvedValueOnce({ ok: true, state: { ...snapshot, revision: 2 } });
    const onOpenSettings = await renderNotice();
    expect(container.textContent).toContain("Kobrixa 上次沒有正常結束，已暫停第三方插件。");
    await act(async () => button("前往插件設定").click());
    expect(onOpenSettings).toHaveBeenCalledOnce();
    await act(async () => button("恢復插件").click());
    expect(container.textContent).toBe("");
  });
  it("keeps the banner with a readable failure", async () => {
    api.state.mockResolvedValueOnce(locked);
    api.clearSafeModeLock.mockResolvedValueOnce({
      ok: false,
      code: "PLUGIN_E_STATE_SAVE",
      message: "disk full",
    });
    await renderNotice();
    await act(async () => button("恢復插件").click());
    expect(container.querySelector("[role=alert]")?.textContent).toBe(
      "無法儲存插件設定：disk full",
    );
    expect(button("恢復插件").disabled).toBe(false);
  });
});

it.each(
  (["en", "zh-TW"] as const).flatMap((locale) =>
    (["panel", "banner"] as const).map((surface) => ({ locale, surface })),
  ),
)(
  "restores session recovery without a lock from the $surface in $locale",
  async ({ locale, surface }) => {
    const t = pluginCopy[locale];
    api.state.mockResolvedValueOnce({ ...snapshot, safeMode: true, sessionRecovery: true });
    api.clearSafeModeLock
      .mockResolvedValueOnce({ ok: false, code: "PLUGIN_E_STATE_SAVE", message: "disk full" })
      .mockResolvedValueOnce({ ok: true, state: { ...snapshot, revision: 2 } });
    if (surface === "panel") await render(locale);
    else
      await act(async () =>
        root.render(createElement(PluginRecoveryNotice, { locale, onOpenSettings: vi.fn() })),
      );
    expect(container.textContent).toContain(t.sessionRecovery);
    expect(container.textContent).not.toContain(t.safeMode);
    expect(container.textContent).not.toContain(t.safeModeLocked);
    expect(button(t.restore).disabled).toBe(false);
    await act(async () => button(t.restore).click());
    expect(container.querySelector("[role=alert]")?.textContent).toContain("disk full");
    expect(container.textContent).toContain(t.sessionRecovery);
    expect(button(t.restore).disabled).toBe(false);
    await act(async () => button(t.restore).click());
    expect(api.clearSafeModeLock).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain(t.sessionRecovery);
    expect(button(t.restore)).toBeUndefined();
  },
);

const toyManifest = JSON.parse(
  readFileSync(
    new NodeURL(
      "../../../../../packages/plugin-protocol/test-fixtures/static-languages/toy/kobrixa-plugin.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { id: string; runtime: { kind: "static" } };

it.each(["en", "zh-TW"] as const)(
  "shows enabled static contributions without a process in %s",
  async (locale) => {
    api.state.mockResolvedValueOnce({
      ...snapshot,
      plugins: [
        snapshot.plugins[0]!,
        {
          ...snapshot.plugins[1]!,
          id: toyManifest.id,
          runtime: toyManifest.runtime.kind,
          status: "enabled",
          running: false,
          commands: [],
          problems: [],
        },
      ],
    });
    await render(locale);
    expect(container.textContent).toContain(locale === "en" ? "Static contributions" : "靜態貢獻");
    expect(container.textContent).toContain(locale === "en" ? "Enabled" : "已啟用");
    expect(container.textContent).not.toContain(locale === "en" ? "Running" : "執行中");
    const label = locale === "en" ? "Disable" : "停用";
    const toggles = [...container.querySelectorAll("button")].filter(
      (item) => item.textContent === label,
    );
    expect(toggles).toHaveLength(1);
    await act(async () => toggles[0]!.click());
    expect(api.setEnabled).toHaveBeenCalledWith(snapshot.plugins[1]!.sourceKey, false);
    expect(api.execute).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      locale === "en" ? "static regular expressions" : "靜態正規表示式",
    );
  },
);
it.each(["en", "zh-TW"] as const)(
  "shows complete static resource, conflict and registration problems in %s",
  async (locale) => {
    api.state.mockResolvedValueOnce({
      ...snapshot,
      plugins: [
        {
          ...snapshot.plugins[1]!,
          runtime: "static",
          commands: [],
          problems: [
            {
              code: "PLUGIN_E_STATIC_LANGUAGE",
              message: "acme.toy resource rejected",
              detail: {
                languageId: "toy",
                resourcePath: "language/tokenizer.json",
                fieldPath: "states[0].rules[0].regex.pattern",
                limit: "STATIC_LANGUAGE_LIMITS_V1.patternLength",
                allowed: 2048,
                actual: 2049,
              },
            },
            {
              code: "PLUGIN_E_STATIC_LANGUAGE_CONFLICT",
              message: "acme.toy extension conflict",
              detail: {
                languageId: "toy",
                conflictingSources: [
                  { pluginId: "acme.toy", sourceKey: "dev:toy", languageId: "toy" },
                  { pluginId: "acme.other", sourceKey: "dev:other", languageId: "other" },
                ],
              },
            },
            {
              code: "PLUGIN_E_STATIC_LANGUAGE_REGISTRATION",
              message: "acme.toy registration rejected",
              detail: {
                languageId: "toy",
                limit: "STATIC_LANGUAGE_LIMITS_V1.sessionLanguageIds",
                allowed: 256,
                actual: 257,
              },
            },
          ],
        },
      ],
    });
    await render(locale);
    for (const text of [
      "language/tokenizer.json",
      "states[0].rules[0].regex.pattern",
      "2048",
      "2049",
      "acme.other",
      "dev:other",
      "256",
      "257",
    ])
      expect(container.textContent).toContain(text);
    expect(container.textContent).toContain(
      locale === "en" ? "Restart Kobrixa" : "重新啟動 Kobrixa",
    );
    expect(container.textContent).not.toContain("[object Object]");
  },
);
