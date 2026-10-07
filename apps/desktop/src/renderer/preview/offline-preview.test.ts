// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KobrixaIR, SourceSpan } from "@kobrixa/ir";
import type { PreviewCommand, PreviewResponse } from "./protocol.js";
import { OfflinePreview, parsePreviewValues, formatPreviewValue } from "./offline-preview.js";
import { PreviewWorkerSession } from "./worker-session.js";

const source: SourceSpan = {
  file: "main.bas",
  start: { line: 2, column: 1, offset: 0 },
  end: { line: 2, column: 12, offset: 11 },
};
const program: KobrixaIR = {
  version: 1,
  program: { name: "Preview", entryFunction: "main" },
  globals: [{ name: "answer", type: { kind: "integer" }, scope: "global" }],
  functions: [
    {
      name: "main",
      parameters: [],
      locals: [],
      returnType: { kind: "void" },
      entryBlock: "entry",
      blocks: [
        {
          id: "entry",
          instructions: [
            { op: "assign", target: "answer", value: { kind: "integer", value: 42 }, span: source },
          ],
          terminator: { op: "return" },
        },
      ],
    },
  ],
  resources: [],
  sourceFiles: ["main.bas"],
};
class TestWorker {
  static instances: TestWorker[] = [];
  onmessage: ((event: MessageEvent<PreviewResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  messages: PreviewCommand[] = [];
  terminated = false;
  private session = new PreviewWorkerSession((data) =>
    this.onmessage?.({ data } as MessageEvent<PreviewResponse>),
  );
  constructor() {
    TestWorker.instances.push(this);
  }
  postMessage(message: PreviewCommand) {
    this.messages.push(message);
    this.session.receive(message);
  }
  terminate() {
    this.terminated = true;
    this.session.dispose();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  TestWorker.instances = [];
});
function setup() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("Worker", TestWorker);
  vi.useFakeTimers();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    createImageData: (width: number, height: number) => ({
      data: new Uint8ClampedArray(width * height * 4),
    }),
    putImageData: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const button = (id: string) =>
    document.querySelector<HTMLButtonElement>(`[data-testid="preview-${id}"]`)!;
  return { root, container, button, worker: () => TestWorker.instances.at(-1)! };
}

describe("offline preview UI", () => {
  it.each(["en", "zh-TW"] as const)(
    "runs, steps, resets and restores inputs in %s",
    async (locale) => {
      const h = setup();
      const onSource = vi.fn();
      try {
        await act(async () =>
          h.root.render(
            createElement(OfflinePreview, {
              ir: program,
              locale,
              projectName: "Demo",
              onClose: vi.fn(),
              onSource,
            }),
          ),
        );
        expect(document.querySelector('[role="dialog"]')).not.toBeNull();
        expect(document.querySelector("canvas")?.width).toBe(178);
        await act(async () => h.button("step").click());
        expect(document.querySelector(".preview-variables")?.textContent).toContain("42");
        expect(document.querySelector(".preview-status")?.getAttribute("data-state")).toBe(
          "paused",
        );
        await act(async () =>
          document.querySelector<HTMLButtonElement>(".preview-inspector button")!.click(),
        );
        expect(onSource).toHaveBeenCalledWith(source);
        await act(async () =>
          h.worker().postMessage({
            type: "inputs",
            inputs: { sensors: { 1: { type: 29, si: [36] } }, batteryLevel: 80 },
          }),
        );
        await act(async () => h.button("reset").click());
        const reset = h
          .worker()
          .messages.filter((message) => message.type === "load")
          .at(-1);
        expect(reset).toMatchObject({
          inputs: { sensors: { 1: { type: 29, si: [36] } }, batteryLevel: 80, buttons: [] },
        });
        expect(document.querySelector(".preview-variables")?.textContent).toContain("0");
        await act(async () => h.button("run").click());
        expect(h.button("step").disabled).toBe(true);
        await act(async () => vi.advanceTimersByTime(32));
        expect(document.querySelector(".preview-status")?.getAttribute("data-state")).toBe(
          "completed",
        );
        expect(h.button("run").disabled).toBe(true);
      } finally {
        await act(async () => h.root.unmount());
        h.container.remove();
      }
      expect(h.worker().terminated).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["en", "zh-TW"] as const)(
    "keeps sensor names independent of %s UI labels",
    async (locale) => {
      const h = setup();
      try {
        await act(async () =>
          h.root.render(
            createElement(OfflinePreview, {
              ir: program,
              locale,
              projectName: "Demo",
              onClose: vi.fn(),
            }),
          ),
        );
        const select = document.querySelector<HTMLSelectElement>(".preview-sensor-fields select")!;
        for (const [type, name] of [
          [29, "EV3-COLOR"],
          [16, "EV3-TOUCH"],
          [30, "EV3-US"],
          [32, "EV3-GYRO"],
          [33, "EV3-IR"],
          [0, "NONE"],
        ] as const) {
          await act(async () => {
            select.value = String(type);
            select.dispatchEvent(new Event("change", { bubbles: true }));
          });
          expect(h.worker().messages.at(-1)).toEqual({
            type: "inputs",
            inputs: { sensors: { 1: { type, name, mode: 0 } } },
          });
        }
      } finally {
        await act(async () => h.root.unmount());
        h.container.remove();
      }
    },
  );

  it("releases keyboard-held virtual buttons on blur and terminates its worker on close", async () => {
    const h = setup();
    try {
      await act(async () =>
        h.root.render(
          createElement(OfflinePreview, {
            ir: program,
            locale: "en",
            projectName: "Demo",
            onClose: vi.fn(),
          }),
        ),
      );
      const enter = document.querySelector<HTMLButtonElement>('[data-preview-button="enter"]')!;
      await act(async () =>
        enter.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
      );
      expect(enter.getAttribute("aria-pressed")).toBe("true");
      expect(h.worker().messages.at(-1)).toMatchObject({
        type: "inputs",
        inputs: { buttons: ["enter"] },
      });
      await act(async () => window.dispatchEvent(new Event("blur")));
      expect(enter.getAttribute("aria-pressed")).toBe("false");
      expect(h.worker().messages.at(-1)).toMatchObject({ type: "inputs", inputs: { buttons: [] } });
      await act(async () =>
        enter.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })),
      );
      await act(async () =>
        enter.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowUp", bubbles: true })),
      );
      expect(h.worker().messages.at(-1)).toMatchObject({ inputs: { buttons: [] } });
    } finally {
      await act(async () => h.root.unmount());
      h.container.remove();
    }
    expect(h.worker().terminated).toBe(true);
  });

  it("shows source-linked unsupported-operation errors and allows reset", async () => {
    const h = setup();
    const unsupported = structuredClone(program);
    unsupported.functions[0]!.blocks[0]!.instructions = [
      { op: "ev3-call", operation: "Unsupported.Operation", args: [], span: source },
    ];
    try {
      await act(async () =>
        h.root.render(
          createElement(OfflinePreview, {
            ir: unsupported,
            locale: "en",
            projectName: "Demo",
            onClose: vi.fn(),
          }),
        ),
      );
      await act(async () => h.button("step").click());
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "Unsupported.Operation",
      );
      expect(h.button("run").disabled).toBe(true);
      expect(h.button("reset").disabled).toBe(false);
      await act(async () => h.button("reset").click());
      expect(document.querySelector('[role="alert"]')).toBeNull();
    } finally {
      await act(async () => h.root.unmount());
      h.container.remove();
    }
  });

  it("preserves nonfinite numbers and signed zero when inspecting values and arrays", () => {
    expect(formatPreviewValue(NaN)).toBe("NaN");
    expect(formatPreviewValue(Infinity)).toBe("Infinity");
    expect(formatPreviewValue(-Infinity)).toBe("-Infinity");
    expect(formatPreviewValue(-0)).toBe("-0");
    expect(formatPreviewValue([NaN, Infinity, -Infinity, -0, 0, [false, "NaN", 1.5]])).toBe(
      '[NaN, Infinity, -Infinity, -0, 0, [false, "NaN", 1.5]]',
    );
    const long = formatPreviewValue(Array.from({ length: 64 }, () => "x".repeat(100)));
    expect(long).toHaveLength(2000);
    expect(long.endsWith("…")).toBe(true);
  });

  it("rejects blank, infinite or overlong sensor channels without coercing blanks to zero", () => {
    expect(parsePreviewValues("10, -20, 0.5")).toEqual([10, -20, 0.5]);
    for (const text of ["", " ", "1,", "NaN", "Infinity", "1,2,3,4,5,6,7,8,9"])
      expect(parsePreviewValues(text)).toBeUndefined();
  });
});
