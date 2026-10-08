// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collabCopy, collabErrorMessage } from "./collab-copy.js";
import type { LobbyError } from "./collab-lobby.js";
import { JoinDialog } from "./join-dialog.js";

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

type Props = ComponentProps<typeof JoinDialog>;
const locales = ["en", "zh-TW"] as const;
const query = <T extends Element = HTMLElement>(selector: string): T | null =>
  document.querySelector<T>(selector);
const nameInput = () => query<HTMLInputElement>("[data-testid=collab-display-name]")!;
const codeInput = () => query<HTMLInputElement>("[data-testid=collab-invite-code]")!;
const passwordInput = () => query<HTMLInputElement>("[data-testid=collab-join-password]")!;
const submit = () => query<HTMLButtonElement>(".collab-join-dialog button[type=submit]")!;

let props: Props | undefined;
async function render(locale: (typeof locales)[number], patch: Partial<Props> = {}) {
  const base: Props = props ?? {
    copy: collabCopy[locale],
    displayName: "Ada",
    onName: vi.fn(),
    initialCode: "ABCD-EFGH-JK23",
    pending: false,
    error: null,
    onJoin: vi.fn(),
    onEdit: vi.fn(),
    onClose: vi.fn(),
  };
  props = { ...base, ...patch };
  await act(async () => root.render(createElement(JoinDialog, props)));
}
async function type(element: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
beforeEach(() => {
  props = undefined;
});

describe("join room dialog", () => {
  it.each(locales)("starts with the name when it is missing in %s", async (locale) => {
    const copy = collabCopy[locale];
    await render(locale, { displayName: "" });
    expect(nameInput().hasAttribute("data-modal-initial")).toBe(true);
    expect(codeInput().hasAttribute("data-modal-initial")).toBe(false);
    expect(query(".collab-join-as")).toBeNull();
    expect(query("[data-testid=collab-display-name-error]")).toBeNull();

    await act(async () => submit().click());
    expect(props!.onJoin).not.toHaveBeenCalled();
    expect(query("[data-testid=collab-display-name-error]")!.textContent).toBe(
      copy.displayNameProblems.empty,
    );
    expect(nameInput().getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(nameInput());
  });

  it.each(locales)("starts with the code when the name is set in %s", async (locale) => {
    const copy = collabCopy[locale];
    await render(locale);
    expect(codeInput().hasAttribute("data-modal-initial")).toBe(true);
    expect(nameInput().hasAttribute("data-modal-initial")).toBe(false);
    expect(query(".collab-join-as")!.textContent).toBe(copy.joiningAs("Ada"));
    await act(async () => submit().click());
    expect(props!.onJoin).toHaveBeenCalledWith("ABCD-EFGH-JK23", "");
  });

  it.each(locales)("flags a malformed code before contacting the service in %s", async (locale) => {
    const copy = collabCopy[locale];
    await render(locale, { initialCode: "" });
    await act(async () => submit().click());
    expect(props!.onJoin).not.toHaveBeenCalled();
    expect(codeInput().getAttribute("aria-invalid")).toBe("true");
    expect(query("[data-testid=collab-join-error]")!.textContent).toBe(copy.inviteCodeInvalid);
    expect(document.activeElement).toBe(codeInput());
  });

  it.each(locales)("names the room when rejoining in %s", async (locale) => {
    await render(locale, { roomName: "Robot" });
    expect(query("[data-testid=collab-join-room]")!.textContent).toBe(
      collabCopy[locale].joinRoomContext("Robot"),
    );
    await render(locale, { roomName: undefined });
    expect(query("[data-testid=collab-join-room]")).toBeNull();
  });

  it.each(locales)("only marks the code invalid for code errors in %s", async (locale) => {
    await render(locale);
    for (const error of ["network", "rate-limited", "room-full", "unavailable"] as LobbyError[]) {
      await render(locale, { error });
      expect(codeInput().getAttribute("aria-invalid"), error).toBe("false");
      expect(passwordInput().getAttribute("aria-invalid"), error).toBe("false");
      expect(query("[data-testid=collab-join-error]")!.textContent).toBe(
        collabErrorMessage(collabCopy[locale], error),
      );
    }
    for (const error of ["not-found", "expired", "bad-request"] as LobbyError[]) {
      await render(locale, { error: null });
      await render(locale, { error });
      expect(codeInput().getAttribute("aria-invalid"), error).toBe("true");
      expect(document.activeElement, error).toBe(codeInput());
    }
  });

  it.each(locales)("returns focus to the password after a password error in %s", async (locale) => {
    await render(locale);
    await type(passwordInput(), "wrong");
    await render(locale, { error: "invalid-password" });
    expect(passwordInput().value).toBe("");
    expect(passwordInput().getAttribute("aria-invalid")).toBe("true");
    expect(codeInput().getAttribute("aria-invalid")).toBe("false");
    expect(document.activeElement).toBe(passwordInput());

    await render(locale, { error: null });
    await type(passwordInput(), "kept");
    await render(locale, { error: "password-required" });
    expect(passwordInput().value).toBe("kept");
    expect(document.activeElement).toBe(passwordInput());
  });

  it.each(locales)("keeps every field read-only while joining in %s", async (locale) => {
    await render(locale, { pending: true });
    for (const input of [nameInput(), codeInput(), passwordInput()]) {
      expect(input.readOnly).toBe(true);
      expect(input.disabled).toBe(false);
    }
    expect(submit().disabled).toBe(true);
  });

  it.each(locales)("reveals the password on request in %s", async (locale) => {
    const copy = collabCopy[locale];
    await render(locale);
    const toggle = query<HTMLButtonElement>("[data-testid=collab-join-password-toggle]")!;
    expect(passwordInput().type).toBe("password");
    await act(async () => toggle.click());
    expect(passwordInput().type).toBe("text");
    expect(toggle.textContent).toBe(copy.hidePassword);
    expect(props!.onJoin).not.toHaveBeenCalled();
  });
});
