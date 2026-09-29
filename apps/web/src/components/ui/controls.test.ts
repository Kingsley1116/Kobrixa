// @vitest-environment jsdom
import { act, createElement as h, useState } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Select } from "./select.js";
import { AudioPlayer } from "./audio-player.js";
import { FileDrop } from "./file-drop.js";

let root: Root;
let container: HTMLDivElement;
const t = (_zh: string, en: string) => en;
const query = <T extends Element = HTMLElement>(selector: string) => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
};
const render = async (node: ReactNode) => {
  await act(async () => root.render(node));
};
const click = async (element: HTMLElement) => {
  await act(async () => element.click());
};
const key = async (element: HTMLElement, value: string) => {
  await act(async () =>
    element.dispatchEvent(
      new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }),
    ),
  );
};
const emit = async (element: Element, event: string) => {
  await act(async () => {
    element.dispatchEvent(new Event(event, { bubbles: true }));
  });
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollIntoView = vi.fn();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    this.dispatchEvent(new Event("pause"));
  });
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async function (
    this: HTMLMediaElement,
  ) {
    this.dispatchEvent(new Event("play"));
    this.dispatchEvent(new Event("playing"));
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const options = [
  { value: "all", label: "All media" },
  { value: "image", label: "Images" },
  { value: "audio", label: "Audio" },
];
function Filter({ change }: { change: (value: string) => void }) {
  const [value, setValue] = useState("all");
  return h(Select, {
    value,
    options,
    label: "Media type",
    onValueChange: (next) => {
      setValue(next);
      change(next);
    },
  });
}
describe("custom select interaction", () => {
  it("explores with arrows, cancels with Escape, and commits with Enter without submitting forms", async () => {
    const change = vi.fn(),
      submit = vi.fn();
    await render(h("form", { onSubmit: submit }, h(Filter, { change })));
    const trigger = query<HTMLButtonElement>('[role="combobox"]');
    trigger.focus();
    await key(trigger, "ArrowDown");
    await key(trigger, "ArrowDown");
    expect(document.activeElement).toBe(trigger);
    expect(change).not.toHaveBeenCalled();
    await key(trigger, "Escape");
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(trigger.textContent).toContain("All media");
    await key(trigger, "Enter");
    await key(trigger, "End");
    await key(trigger, "Enter");
    expect(change).toHaveBeenCalledWith("audio");
    expect(trigger.textContent).toContain("Audio");
    expect(submit).not.toHaveBeenCalled();
  });
  it("supports typeahead, Tab selection, pointer selection and outside dismissal", async () => {
    const change = vi.fn();
    await render(h(Filter, { change }));
    const trigger = query<HTMLButtonElement>('[role="combobox"]');
    trigger.focus();
    await key(trigger, "i");
    await key(trigger, "m");
    await key(trigger, "Tab");
    expect(change).toHaveBeenLastCalledWith("image");
    await click(trigger);
    await click(query('[role="option"][data-index="2"]'));
    expect(change).toHaveBeenLastCalledWith("audio");
    expect(document.activeElement).toBe(trigger);
    await click(trigger);
    await act(async () => {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });
  it("positions the popup above a trigger near the viewport bottom and clamps its width", async () => {
    await render(h(Filter, { change: vi.fn() }));
    const trigger = query<HTMLButtonElement>('[role="combobox"]');
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      top: 700,
      bottom: 744,
      left: 1000,
      right: 1100,
      width: 100,
      height: 44,
      x: 1000,
      y: 700,
      toJSON() {},
    });
    await click(trigger);
    const popup = query('[role="listbox"]');
    expect(popup.style.bottom).not.toBe("");
    expect(parseFloat(popup.style.left) + parseFloat(popup.style.width)).toBeLessThanOrEqual(
      innerWidth - 12,
    );
    expect(popup.parentElement).toBe(document.body);
  });
  it("does not open when disabled and cleans up the popup on unmount", async () => {
    const props = { value: "all", options, label: "Media", onValueChange: vi.fn(), disabled: true };
    await render(h(Select, props));
    await click(query<HTMLButtonElement>('[role="combobox"]'));
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    await render(h(Select, { ...props, disabled: false }));
    await click(query<HTMLButtonElement>('[role="combobox"]'));
    await render(null);
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });
});

describe("audio player interaction", () => {
  it("loads on demand, plays, seeks, mutes and returns to Play after ending", async () => {
    await render(h(AudioPlayer, { src: "/sample.wav", title: "Chime", duration: 10, t }));
    const audio = query<HTMLAudioElement>("audio");
    expect(audio.preload).toBe("none");
    expect(audio.controls).toBe(false);
    expect(query<HTMLInputElement>('input[type="range"]').disabled).toBe(true);
    await click(query('[aria-label="Play"]'));
    expect(audio.play).toHaveBeenCalledTimes(1);
    Object.defineProperty(audio, "duration", { value: 10, configurable: true });
    await emit(audio, "loadedmetadata");
    const range = query<HTMLInputElement>('input[type="range"]');
    expect(range.disabled).toBe(false);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(range, "5");
      range.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(audio.currentTime).toBe(5);
    await click(query('[aria-label="Mute"]'));
    expect(audio.muted).toBe(true);
    await emit(audio, "ended");
    expect(query('[aria-label="Play"]')).toBeTruthy();
  });
  it("pauses another player and stops playback on a source change", async () => {
    await render(
      h(
        "div",
        null,
        h(AudioPlayer, { src: "/one.wav", title: "One", t }),
        h(AudioPlayer, { src: "/two.wav", title: "Two", t }),
      ),
    );
    const first = query<HTMLAudioElement>('audio[src="/one.wav"]');
    await click(query('[aria-label="Preview: One"] button'));
    await click(query('[aria-label="Preview: Two"] button'));
    expect(query('[aria-label="Preview: One"] button').getAttribute("aria-label")).toBe("Play");
    expect(query('[aria-label="Preview: Two"] button').getAttribute("aria-label")).toBe("Pause");
    expect(first.pause).toHaveBeenCalled();
    await render(h(AudioPlayer, { src: "/new.wav", title: "New", t }));
    expect(query("audio").getAttribute("src")).toBe("/new.wav");
    expect(query('[aria-label="Play"]')).toBeTruthy();
  });
  it("shows failed playback and retries on user request", async () => {
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new Error("network"));
    await render(h(AudioPlayer, { src: "/bad.wav", title: "Broken", t }));
    await click(query('[aria-label="Play"]'));
    expect(query('[role="status"]').textContent).toContain("could not load");
    await click(query('[aria-label="Retry audio"]'));
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalledTimes(1);
    expect(query('[aria-label="Pause"]')).toBeTruthy();
    await emit(query("audio"), "error");
    expect(query('[aria-label="Retry audio"]')).toBeTruthy();
  });
  it("ignores a stale play rejection after the source changes", async () => {
    let reject!: (error: Error) => void;
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    await render(h(AudioPlayer, { src: "/old.wav", title: "Old", t }));
    await click(query('[aria-label="Play"]'));
    expect(query('[role="status"]').textContent).toContain("Loading");
    await render(h(AudioPlayer, { src: "/new.wav", title: "New", t }));
    await act(async () => reject(new Error("old network error")));
    expect(query('[role="status"]').textContent).toBe("");
    expect(query('[aria-label="Play"]')).toBeTruthy();
  });
});

describe("file drop interaction", () => {
  it("preserves selection on cancel and allows reselecting the same files", async () => {
    const onFiles = vi.fn();
    await render(
      h(FileDrop, { accept: ".rgf,.rsf", multiple: true, label: "EV3 files", onFiles, t }),
    );
    const input = query<HTMLInputElement>('input[type="file"]');
    const files = [new File(["1"], "part10.rsf"), new File(["2"], "part2.rsf")];
    Object.defineProperty(input, "files", { value: files, configurable: true });
    await emit(input, "change");
    expect(onFiles).toHaveBeenCalledWith(files);
    expect(Array.from(document.querySelectorAll("li"), (e) => e.textContent)).toEqual([
      "part2.rsf",
      "part10.rsf",
    ]);
    expect(input.value).toBe("");
    await emit(input, "change");
    expect(onFiles).toHaveBeenCalledTimes(2);
    Object.defineProperty(input, "files", { value: [], configurable: true });
    await emit(input, "change");
    expect(onFiles).toHaveBeenCalledTimes(2);
    expect(query('[role="status"]').textContent).toContain("2 file(s)");
  });
  it("accepts drops but blocks them while its containing fieldset is disabled", async () => {
    const onFiles = vi.fn();
    const drop = () => {
      const event = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", {
        value: { files: [new File(["1"], "image.rgf")] },
      });
      query(".ui-file-drop").dispatchEvent(event);
    };
    await render(
      h(
        "fieldset",
        { disabled: true },
        h(FileDrop, { accept: ".rgf", label: "EV3 files", onFiles, t }),
      ),
    );
    await act(async () => drop());
    expect(onFiles).not.toHaveBeenCalled();
    await render(
      h(
        "fieldset",
        { disabled: false },
        h(FileDrop, { accept: ".rgf", label: "EV3 files", onFiles, t }),
      ),
    );
    await act(async () => drop());
    expect(onFiles).toHaveBeenCalledTimes(1);
  });
});
