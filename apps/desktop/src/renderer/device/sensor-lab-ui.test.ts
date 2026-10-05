// @vitest-environment jsdom
import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SensorLabApi, SensorLabState, SensorRecording } from "../../shared/sensor-lab.js";
import type { Locale } from "../i18n/copy.js";
import type { MonitorController, MonitorState } from "./monitor-controller.js";
import { RecordingStatus } from "./recording-status.js";
import { SensorLabController } from "./sensor-lab-controller.js";
import { SensorLabPanel } from "./sensor-lab-panel.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function setup() {
  let state: SensorLabState = {
    recording: undefined,
    active: false,
    waiting: false,
    saved: true,
    error: undefined,
    issues: [],
  };
  const listeners = new Set<(state: SensorLabState) => void>();
  const emit = (patch: Partial<SensorLabState>) => {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener(state));
  };
  const api: SensorLabApi = {
    getState: vi.fn(async () => state),
    start: vi.fn(async (request) => {
      const recording: SensorRecording = {
        schemaVersion: 1,
        id: "trial",
        name: request.name,
        startedAt: 1000,
        durationMs: 500,
        frameCount: 2,
        device: { id: "ev3", name: "EV3", transport: "usb" },
        channels: request.channels,
        frames: [
          { sampledAt: 1000, elapsedMs: 0, values: [42, 50, 25, 70], status: "ok", segment: 0 },
          { sampledAt: 1500, elapsedMs: 500, values: [43, 49, 28, 75], status: "ok", segment: 0 },
        ],
      };
      emit({ active: true, recording });
      return state;
    }),
    stop: vi.fn(async () => {
      emit({ active: false, recording: { ...state.recording!, reason: "manual", endedAt: 1500 } });
      return state;
    }),
    retrySave: vi.fn(async () => state),
    list: vi.fn(async () => []),
    read: vi.fn(async () => state.recording!),
    delete: vi.fn(async () => {}),
    listCalibrations: vi.fn(async () => []),
    saveCalibration: vi.fn(async (profile) => ({ ...profile, id: "profile" })),
    deleteCalibration: vi.fn(async () => {}),
    exportCsv: vi.fn(async () => ({ cancelled: false })),
    onState: vi.fn((listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
  };
  const monitorState: MonitorState = {
    sessionId: "session",
    active: true,
    status: "live",
    modes: {},
    loadingPort: undefined,
    switchingPort: undefined,
    error: undefined,
    modeError: undefined,
    snapshot: {
      sampledAt: Date.now(),
      battery: { percent: 90, voltage: 7 },
      program: { status: "stopped", rawStatus: 0, result: 0 },
      outputs: [],
      inputs: [
        {
          port: 0,
          type: 33,
          mode: 1,
          name: "Infrared",
          modeName: "IR-SEEK",
          unit: "%",
          decimals: 0,
          connection: 122,
          state: "ready",
          values: [42, 50, 25, 70, 20],
          switchable: true,
        },
      ],
    },
  };
  const monitor = {
    getSnapshot: () => monitorState,
    subscribe: () => () => {},
  } as unknown as MonitorController;
  return { api, emit, monitor, controller: new SensorLabController(api) };
}

describe("sensor lab interface", () => {
  it("expires capture, zero and start while an EV3 read is stalled", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    const h = setup();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          createElement(SensorLabPanel, {
            controller: h.controller,
            monitor: h.monitor,
            locale: "en",
            sessionId: "session",
            onConnect: vi.fn(),
          }),
        ),
      );
      await act(async () =>
        container.querySelector<HTMLInputElement>(".sensor-lab-channel-list input")!.click(),
      );
      await act(async () =>
        container
          .querySelector<HTMLInputElement>('.sensor-lab-calibration input[type="checkbox"]')!
          .click(),
      );
      const capture = container.querySelector<HTMLButtonElement>(
        '[aria-label="Capture current A"]',
      )!;
      const start = container.querySelector<HTMLButtonElement>('[data-testid="sensor-lab-start"]')!;
      const zero = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Zero current reading",
      )!;
      expect(capture.disabled).toBe(false);
      expect(zero.disabled).toBe(false);
      expect(start.disabled).toBe(false);
      await act(async () => vi.advanceTimersByTimeAsync(2501));
      expect(capture.disabled).toBe(true);
      expect(zero.disabled).toBe(true);
      expect(start.disabled).toBe(true);
      expect(container.textContent).toContain("Waiting for readings");
    } finally {
      await act(async () => root.unmount());
      h.controller.dispose();
      container.remove();
    }
  });
  it.each(["en", "zh-TW"] as const)(
    "records four channels, locks calibration and keeps the footer independent in %s",
    async (locale: Locale) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const h = setup();
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      let shellRenders = 0;
      let showPanel = true;
      const open = vi.fn();
      function Shell() {
        shellRenders++;
        return createElement(
          Fragment,
          null,
          showPanel &&
            createElement(SensorLabPanel, {
              controller: h.controller,
              monitor: h.monitor,
              locale,
              sessionId: "session",
              onConnect: vi.fn(),
            }),
          createElement(RecordingStatus, { controller: h.controller, locale, onOpen: open }),
        );
      }
      const buttons = (text: string) =>
        [...document.querySelectorAll("button")].filter((button) => button.textContent === text);
      try {
        await act(async () => root.render(createElement(Shell)));
        const start = container.querySelector<HTMLButtonElement>(
          '[data-testid="sensor-lab-start"]',
        )!;
        expect(start.disabled).toBe(true);
        for (let index = 0; index < 4; index++)
          await act(async () =>
            container
              .querySelectorAll<HTMLInputElement>(".sensor-lab-channel-list input")
              [index]!.click(),
          );
        expect(
          container.querySelectorAll<HTMLInputElement>(".sensor-lab-channel-list input")[4]!
            .disabled,
        ).toBe(true);
        expect(container.querySelectorAll('[data-testid="sensor-lab-chart"]')).toHaveLength(4);
        await act(async () =>
          buttons(locale === "zh-TW" ? "將目前值歸零" : "Zero current reading")[0]!.click(),
        );
        await act(async () =>
          buttons(locale === "zh-TW" ? "套用校正" : "Apply calibration")[0]!.click(),
        );
        expect(h.controller.getSnapshot().selected[0]?.calibration.zeroOffset).toBe(42);
        await act(async () =>
          buttons(locale === "zh-TW" ? "將目前值歸零" : "Zero current reading")[0]!.click(),
        );
        await act(async () =>
          buttons(locale === "zh-TW" ? "套用校正" : "Apply calibration")[0]!.click(),
        );
        expect(h.controller.getSnapshot().selected[0]?.calibration.zeroOffset).toBe(42);
        await act(async () => start.click());
        expect(h.api.start).toHaveBeenCalledOnce();
        expect(h.controller.getSnapshot().lab.active).toBe(true);
        expect(
          container.querySelector(".sensor-lab-calibration fieldset")?.hasAttribute("disabled"),
        ).toBe(true);
        expect(
          container.querySelector('[data-testid="sensor-recording-status"]')?.textContent,
        ).toContain(locale === "zh-TW" ? "記錄中" : "Recording");
        expect(shellRenders).toBe(1);
        await act(async () =>
          buttons(locale === "zh-TW" ? "放大圖表" : "Expand charts")[0]!.click(),
        );
        expect(document.querySelector('.sensor-lab-expanded [type="range"]')).not.toBeNull();
        expect(document.querySelectorAll('.sensor-lab-expanded [role="img"]')).toHaveLength(4);
        await act(async () =>
          (document.querySelector(".sensor-lab-expanded button") as HTMLButtonElement).click(),
        );
        expect(h.controller.getSnapshot().lab.active).toBe(true);
        showPanel = false;
        await act(async () => root.render(createElement(Shell)));
        await act(async () => h.emit({ waiting: true }));
        expect(shellRenders).toBe(2);
        expect(container.textContent).toContain(locale === "zh-TW" ? "等待讀值" : "waiting");
        await act(async () =>
          (container.querySelector(".sensor-recording-status button") as HTMLButtonElement).click(),
        );
        expect(open).toHaveBeenCalledOnce();
        await act(async () =>
          (container.querySelector(".sensor-recording-stop") as HTMLButtonElement).click(),
        );
        expect(h.api.stop).toHaveBeenCalledWith("manual");
        expect(h.controller.getSnapshot().lab.active).toBe(false);
      } finally {
        await act(async () => root.unmount());
        h.controller.dispose();
        container.remove();
      }
    },
  );

  it("shows a recoverable copy error when the clipboard API is unavailable", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const h = setup();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          createElement(SensorLabPanel, {
            controller: h.controller,
            monitor: h.monitor,
            locale: "en",
            sessionId: "session",
            onConnect: vi.fn(),
          }),
        ),
      );
      await act(async () =>
        container.querySelector<HTMLInputElement>(".sensor-lab-channel-list input")!.click(),
      );
      await act(async () =>
        [...container.querySelectorAll("button")]
          .find((button) => button.textContent === "Copy program")!
          .click(),
      );
      expect(container.textContent).toContain("Could not copy");
      expect(container.querySelector(".sensor-lab-code")?.textContent).toContain(
        "Sensor.ReadSIValue",
      );
    } finally {
      await act(async () => root.unmount());
      h.controller.dispose();
      container.remove();
    }
  });
});
