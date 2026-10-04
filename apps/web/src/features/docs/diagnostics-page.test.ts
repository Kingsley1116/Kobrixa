// @vitest-environment jsdom
import { transferableAbortController } from "node:util";
import {
  DIAGNOSTIC_HELP,
  DIAGNOSTIC_HELP_VARIANTS,
  diagnosticDocumentationUrl,
  getDiagnosticHelp,
} from "@kobrixa/compiler/diagnostic-help";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider, useLocation, useOutletContext } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, type PageContext } from "../../app/app.js";
import { DocsPage } from "./docs-page.js";

let root: Root;
let container: HTMLDivElement;
let router: ReturnType<typeof createMemoryRouter>;

function DocsRoute() {
  const props = useOutletContext<PageContext>();
  const { pathname } = useLocation();
  return h(DocsPage, { ...props, path: pathname });
}

async function render(path: string) {
  router = createMemoryRouter(
    [{ element: h(App), children: [{ path: "/docs/*", element: h(DocsRoute) }] }],
    { initialEntries: [path] },
  );
  await act(async () => root.render(h(RouterProvider, { router })));
}

function query<T extends Element = HTMLElement>(selector: string): T {
  const element = container.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

async function search(value: string) {
  const input = query<HTMLInputElement>('input[type="search"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // React Router uses Node's Request in jsdom; give it a matching Node signal.
  vi.stubGlobal("AbortController", transferableAbortController);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true })),
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  HTMLElement.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  router?.dispose();
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("diagnostic documentation", () => {
  it("lists every code and filters by code, translated title, keyword, and family", async () => {
    await render("/docs/diagnostics?lang=en");
    expect(query("h1").textContent).toBe("Diagnostic index");
    expect(container.querySelectorAll(".diagnostics-list li")).toHaveLength(DIAGNOSTIC_HELP.length);
    expect(query(".knowledge-sidebar a[aria-current='page']").textContent).toBe("Diagnostic index");

    const entry = getDiagnosticHelp("BP1013")!;
    await search(" bp1013 ");
    expect(container.querySelectorAll(".diagnostics-list li")).toHaveLength(1);
    expect(query(".diagnostics-list code").textContent).toBe("BP1013");
    await search(entry.title["zh-TW"]);
    expect(query(".diagnostics-list").textContent).toContain("BP1013");
    const keywordEntry = DIAGNOSTIC_HELP.find((help) => help.keywords.length)!;
    await search(keywordEntry.keywords[0]!);
    expect(query(".diagnostics-list").textContent).toContain(keywordEntry.code);

    await search("");
    await click(query('[role="combobox"]'));
    await click(document.querySelector<HTMLElement>('[role="option"][data-index="2"]')!);
    expect(
      Array.from(container.querySelectorAll(".diagnostics-list code"), (el) => el.textContent),
    ).toEqual(
      DIAGNOSTIC_HELP.filter((help) => help.code.startsWith("MAN")).map((help) => help.code),
    );
    await search("no-such-diagnostic");
    expect(query('[role="status"]').textContent).toBe("0 diagnostic codes");
    expect(query(".diagnostics-empty").textContent).toContain("No matching");
    await click(query(".diagnostics-empty button"));
    expect(container.querySelectorAll(".diagnostics-list li")).toHaveLength(DIAGNOSTIC_HELP.length);
  });

  it("opens code details with examples and links, and returns to the localized index", async () => {
    await render("/docs/diagnostics?lang=en");
    await search("BP1013");
    await click(query(".diagnostics-list a"));
    const entry = getDiagnosticHelp("BP1013")!;
    expect(router.state.location.pathname).toBe("/docs/diagnostics/BP1013");
    expect(router.state.location.search).toBe("?lang=en");
    expect(query("h1").textContent).toBe(entry.title.en);
    expect(query(".diagnostics-explanation").textContent).toContain(entry.cause.en);
    expect(query(".diagnostics-examples pre").textContent).toBe(entry.example!.before);
    expect(query(".diagnostics-related a").getAttribute("href")).toBe(entry.related[0]!.path);
    await click(query(".diagnostics-detail .back-link"));
    expect(router.state.location.pathname).toBe("/docs/diagnostics");
    expect(query("h1").textContent).toBe("Diagnostic index");
  });

  it("honors desktop deep links and keeps their variant fragment when switching language", async () => {
    const variant = DIAGNOSTIC_HELP_VARIANTS.find((entry) => entry.helpKey)!;
    const url = new URL(diagnosticDocumentationUrl(variant.code, variant.helpKey, "en")!);
    await render(`${url.pathname}${url.search}${url.hash}`);
    expect(document.documentElement.lang).toBe("en");
    expect(localStorage.getItem("kobrixa-locale")).toBe("en");
    const section = document.getElementById(variant.helpKey!)!;
    expect(section.textContent).toContain(variant.title.en);
    expect(section.scrollIntoView).toHaveBeenCalled();
    expect(
      query(".diagnostics-variants").querySelector(`a[href="#${variant.helpKey}"]`),
    ).not.toBeNull();

    await click(query('[aria-label="Switch to Traditional Chinese"]'));
    expect(document.documentElement.lang).toBe("zh-TW");
    expect(router.state.location.search).toBe("?lang=zh-TW");
    expect(router.state.location.hash).toBe(url.hash);
    expect(document.getElementById(variant.helpKey!)!.textContent).toContain(
      variant.title["zh-TW"],
    );
    expect(localStorage.getItem("kobrixa-locale")).toBe("zh-TW");

    await act(async () => router.navigate("/docs/diagnostics/BP1013?lang=en"));
    expect(document.documentElement.lang).toBe("en");
    expect(query("h1").textContent).toBe(getDiagnosticHelp("BP1013")!.title.en);
    await act(async () => router.navigate(-1));
    expect(document.documentElement.lang).toBe("zh-TW");
    expect(router.state.location.hash).toBe(url.hash);
  });

  it("uses the saved locale for invalid language values and handles unknown codes", async () => {
    localStorage.setItem("kobrixa-locale", "en");
    await render("/docs/diagnostics/BP9999?lang=unknown&source=help#details");
    expect(query("h1").textContent).toBe("Diagnostic code not found");
    expect(query(".diagnostics-reference code").textContent).toBe("BP9999");
    await click(query('[aria-label="Switch to Traditional Chinese"]'));
    expect(router.state.location.search).toBe("?lang=zh-TW&source=help");
    expect(router.state.location.hash).toBe("#details");
    expect(query("h1").textContent).toBe("找不到這個診斷代碼");
    await click(query(".diagnostics-reference .back-link"));
    expect(query("h1").textContent).toBe("錯誤索引");
    expect(router.state.location.search).toBe("?lang=zh-TW");
  });

  it.each([
    ["BP1013", "Functions and projects", "函式與專案"],
    ["BP0000", "Architecture and public contracts", "架構與公共契約"],
  ])("honors locale in a desktop related-document link for %s", async (code, english, chinese) => {
    localStorage.setItem("kobrixa-locale", "zh-TW");
    const path = getDiagnosticHelp(code)!.related[0]!.path;
    await render(`${path}?lang=en&source=help#content`);
    expect(document.documentElement.lang).toBe("en");
    expect(query("h1").textContent).toBe(english);
    expect(localStorage.getItem("kobrixa-locale")).toBe("en");

    await click(query('[aria-label="Switch to Traditional Chinese"]'));
    expect(document.documentElement.lang).toBe("zh-TW");
    expect(query("h1").textContent).toBe(chinese);
    expect(router.state.location.pathname).toBe(path);
    expect(router.state.location.search).toBe("?lang=zh-TW&source=help");
    expect(router.state.location.hash).toBe("#content");
  });
});
