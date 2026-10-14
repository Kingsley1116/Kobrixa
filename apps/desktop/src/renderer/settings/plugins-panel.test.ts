// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PluginEvent, PluginsApi, PluginsSnapshot } from "../../shared/plugins.js";
import { DEFAULT_DEVICE_PREFERENCES } from "../../shared/device-preferences.js";
import { DEFAULT_FILE_PREFERENCES } from "../../shared/file-preferences.js";
import type { Locale } from "../i18n/copy.js";
import type { KeyboardSettings } from "../keybindings/keyboard-state.js";
import { PluginsPanel, localizedText } from "./plugins-panel.js";
import { pluginCopy, problemText } from "./plugin-copy.js";
import { SettingsPanel } from "./settings-panel.js";
import { defaultSettings } from "./settings.js";

vi.mock("../keybindings/shortcuts-panel.js", () => ({ ShortcutsPanel: () => null }));
vi.mock("../updates/updates.js", () => ({ UpdatesPanel: () => null }));

let root: Root;
let container: HTMLDivElement;
let emit: (event: PluginEvent) => void;
const originalScrollTo = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTo");
const unhandledRejection = vi.fn();
const snapshot: PluginsSnapshot = {
  safeMode: false,
  developmentMode: true,
  plugins: [
    {
      id: "kobrixa.basic-plus",
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
  vi.unstubAllGlobals();
});
const render = async (locale: Locale = "zh-TW") => {
  await act(async () => root.render(createElement(PluginsPanel, { locale })));
};
const button = (text: string) =>
  [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(text))!;

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
    expect(button("停用").disabled).toBe(true);

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
  expect(api.setEnabled).toHaveBeenCalledWith("acme.hello", false);
  expect(container.textContent).toContain("已停用");
});

it("shows notices with their plugin id", async () => {
  await render();
  await act(async () =>
    emit({
      type: "notice",
      notice: { pluginId: "acme.hello", severity: "info", message: "哈囉", at: 0 },
    }),
  );
  expect(container.querySelector("[aria-live=polite]")?.textContent).toContain("acme.hello");
  expect(container.querySelector("[aria-live=polite]")?.textContent).toContain("哈囉");
});

it("explains how to load development plugins and safe mode", async () => {
  api.state.mockResolvedValueOnce({
    safeMode: true,
    developmentMode: false,
    plugins: [snapshot.plugins[0]!],
  });
  await render();
  expect(container.textContent).toContain("--plugin-dev-dir");
  expect(container.textContent).toContain("--plugin-python");
  expect(container.textContent).toContain("安全模式");
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
  expect(api.setEnabled).toHaveBeenCalledWith("acme.hello", true);
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
  expect(api.setEnabled).toHaveBeenCalledWith("acme.hello", false);
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

it("blocks concurrent commands and toggles until the command finishes", async () => {
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
  expect(button("停用").disabled).toBe(true);
  await act(async () => {
    button("打招呼").click();
    button("停用").click();
  });
  expect(api.execute).toHaveBeenCalledOnce();
  expect(api.setEnabled).not.toHaveBeenCalled();
  await act(async () => finish({ ok: true }));
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
          pluginId: "acme.hello",
          severity: "info",
          message: `<img src=x> notice-${at}`,
          at,
        },
      });
  });
  const notices = container.querySelectorAll("[aria-live=polite] li");
  expect(notices).toHaveLength(20);
  expect(notices[0]?.textContent).toBe("acme.hello <img src=x> notice-20");
  expect(notices[19]?.textContent).toBe("acme.hello <img src=x> notice-1");
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
