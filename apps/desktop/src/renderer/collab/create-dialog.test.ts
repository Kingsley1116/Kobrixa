// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collabCopy } from "./collab-copy.js";
import { CreateDialog } from "./create-dialog.js";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

type Props = ComponentProps<typeof CreateDialog>;
const locales = ["en", "zh-TW"] as const;
const query = <T extends Element = HTMLElement>(selector: string): T | null =>
  document.querySelector<T>(selector);
const nameInput = () => query<HTMLInputElement>("[data-testid=collab-display-name]")!;
const passwordInput = () => query<HTMLInputElement>("[data-testid=collab-create-password]")!;
const submit = () => query<HTMLButtonElement>(".collab-create-dialog button[type=submit]")!;

async function render(locale: (typeof locales)[number], props: Partial<Props> = {}) {
  const full: Props = {
    copy: collabCopy[locale],
    projectName: "Robot",
    displayName: "Ada",
    onName: vi.fn(),
    pending: false,
    error: null,
    onCreate: vi.fn(),
    onClose: vi.fn(),
    ...props,
  };
  await act(async () => root.render(createElement(CreateDialog, full)));
  return full;
}
async function typePassword(value: string): Promise<void> {
  await act(async () => {
    const element = passwordInput();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("create room dialog", () => {
  it.each(locales)(
    "explains an empty display name only after a submit attempt in %s",
    async (locale) => {
      const copy = collabCopy[locale];
      const props = await render(locale, { displayName: "" });
      expect(nameInput().hasAttribute("data-modal-initial")).toBe(true);
      expect(submit().hasAttribute("data-modal-initial")).toBe(false);
      expect(query("[data-testid=collab-display-name-error]")).toBeNull();
      expect(nameInput().getAttribute("aria-invalid")).toBe("false");
      expect(query(".collab-create-dialog")!.textContent).not.toContain(copy.hostingAs(""));
      expect(submit().disabled).toBe(false);

      await act(async () => submit().click());
      expect(props.onCreate).not.toHaveBeenCalled();
      const message = query("[data-testid=collab-display-name-error]")!;
      expect(message.textContent).toBe(copy.displayNameProblems.empty);
      expect(nameInput().getAttribute("aria-invalid")).toBe("true");
      expect(nameInput().getAttribute("aria-describedby")).toContain(message.id);
      expect(document.activeElement).toBe(nameInput());
    },
  );

  it.each(locales)(
    "rejects control characters instead of failing silently in %s",
    async (locale) => {
      const copy = collabCopy[locale];
      const props = await render(locale, { displayName: "Ada\u0007" });
      expect(query("[data-testid=collab-display-name-error]")!.textContent).toBe(
        copy.displayNameProblems.invalid,
      );
      await act(async () => submit().click());
      expect(props.onCreate).not.toHaveBeenCalled();
    },
  );

  it.each(locales)("hosts with a valid name and a revealable password in %s", async (locale) => {
    const copy = collabCopy[locale];
    const props = await render(locale);
    expect(submit().hasAttribute("data-modal-initial")).toBe(true);
    expect(query(".collab-create-dialog")!.textContent).toContain(copy.hostingAs("Ada"));
    expect(query("[data-testid=collab-create-privacy]")!.textContent).toContain(copy.createIntro);
    expect(query("[data-testid=collab-create-privacy]")!.textContent).toContain(
      copy.shareLimits(200, 1, 8),
    );
    expect(passwordInput().getAttribute("aria-describedby")!.split(" ")).toHaveLength(2);
    expect(query(".collab-create-dialog")!.textContent).toContain(copy.createPasswordShare);

    await typePassword("s3cret");
    const toggle = query<HTMLButtonElement>("[data-testid=collab-create-password-toggle]")!;
    expect(passwordInput().type).toBe("password");
    expect(toggle.getAttribute("aria-label")).toBe(copy.showPasswordLabel);
    await act(async () => toggle.click());
    expect(passwordInput().type).toBe("text");
    expect(toggle.getAttribute("aria-label")).toBe(copy.hidePasswordLabel);
    expect(props.onCreate).not.toHaveBeenCalled();

    await act(async () => submit().click());
    expect(props.onCreate).toHaveBeenCalledWith("s3cret");
  });

  it.each(locales)("keeps fields read-only while the room starts in %s", async (locale) => {
    await render(locale, { pending: true });
    expect(nameInput().readOnly).toBe(true);
    expect(nameInput().disabled).toBe(false);
    expect(passwordInput().readOnly).toBe(true);
    expect(submit().disabled).toBe(true);
  });

  it.each(locales)(
    "groups excluded files apart from the collapsed shared list in %s",
    async (locale) => {
      const copy = collabCopy[locale];
      await render(locale, {
        preview: {
          shared: ["main.bp", "lib/util.bpm"],
          skipped: [
            { path: "photo.png", reason: "format" },
            { path: "huge.bp", reason: "size" },
          ],
        },
      });
      const excluded = query<HTMLDetailsElement>("[data-testid=collab-share-excluded]")!;
      const shared = query<HTMLDetailsElement>("[data-testid=collab-share-shared]")!;
      expect(excluded.open).toBe(true);
      expect(shared.open).toBe(false);
      expect(excluded.querySelector("summary")!.textContent).toBe(copy.sharePreviewExcluded(2));
      expect(shared.querySelector("summary")!.textContent).toBe(copy.sharePreviewShared(2));
      expect(excluded.textContent).toContain(copy.shareSkipReasons.format);
      expect(excluded.textContent).toContain(copy.shareSkipReasons.size);
      expect(excluded.textContent).not.toContain("main.bp");
      expect(shared.textContent).not.toContain("photo.png");
      expect(query("[data-testid=collab-share-preview]")!.textContent).toContain(
        copy.sharePreviewSummary(2, 2),
      );
    },
  );

  it.each(locales)("omits the excluded group when every file is shared in %s", async (locale) => {
    await render(locale, { preview: { shared: ["main.bp"], skipped: [] } });
    expect(query("[data-testid=collab-share-excluded]")).toBeNull();
    expect(query("[data-testid=collab-share-shared]")).not.toBeNull();
  });

  it.each(locales)(
    "reports preview progress and offers a retry on failure in %s",
    async (locale) => {
      const copy = collabCopy[locale];
      await render(locale, { previewLoading: true });
      expect(query("[role=status]")!.textContent).toBe(copy.sharePreviewChecking);
      expect(submit().disabled).toBe(true);

      const onRetryPreview = vi.fn();
      await render(locale, { previewLoading: true, previewError: "Disk error", onRetryPreview });
      expect(query("[role=status]")).toBeNull();
      expect(query("[data-testid=collab-share-preview-error]")!.textContent).toBe("Disk error");
      expect(submit().disabled).toBe(false);
      const retry = query<HTMLButtonElement>("[data-testid=collab-share-preview-retry]")!;
      expect(retry.textContent).toBe(copy.sharePreviewRetry);
      await act(async () => retry.click());
      expect(onRetryPreview).toHaveBeenCalledOnce();

      await render(locale, { previewError: "Disk error" });
      expect(query("[data-testid=collab-share-preview-retry]")).toBeNull();
    },
  );
});
